/**
 * reportPipeline.js
 * 戰報計算的 orchestration 核心，但本身仍是純函式——不碰 Firestore/BigQuery，
 * 只負責「已經讀進記憶體的 History 列 + 持股 lot 文件，組出今天的戰報」這件事。
 * 跟 apps-script/src/Analysis.gs 的 runAnalysis() 職責相同，形狀稍微不同：
 * runAnalysis() 自己呼叫 computeLatestDayRows_()／getPortfolioMap_() 去讀資料
 * （I/O 跟計算混在一起），這裡刻意把「讀資料」留給呼叫端（Cloud Function 的
 * index.js，那裡才需要真的連 BigQuery／Firestore），這支只管「資料到手之後
 * 怎麼算出戰報」——這樣這支核心邏輯才能在沒有雲端憑證的情況下單元測試。
 *
 * 輸出的戰報文件形狀對照 firestore/schema.md §3 `reports/{date}/signals/{code}`
 * （英文欄名），不是 apps-script 版 Sheets Reports 分頁的中文欄名——這是新系統，
 * 直接產出 Firestore schema 設計好的形狀，不需要再經過一次「中文欄名轉英文欄名」
 * 的額外步驟。
 */
var analysis = require('./analysis');
var factorModel = require('./factorModel');
var portfolio = require('./portfolio');
var utils = require('./utils');

/**
 * historyRows：BigQuery 查回來、經過 mapBqRowToHistoryRow_ 轉換的中文欄名 History 列
 *   （最近 ANALYSIS_LOOKBACK_DAYS 天、全市場）。
 * lotDocs：Firestore `portfolio_lots` collection 的全部文件（buildPortfolioMap_ 自己
 *   會篩 status === 'holding'）。
 * screeningStrategyKey：'rule_v17'／'factor_model_rank'／'hybrid'，來自 Firestore
 *   `config/app` 的 screeningStrategy 欄位。
 * appliedFactorModels：{return1m, downsideResistance} 或 {}——rule_v17（預設策略）
 *   不需要這個，傳 {} 即可，factor_model_rank／hybrid 需要先套用一版抗跌力模型。
 * financialsIndex（2026-10-08 新增，選填）：{quarterlyByCode, monthlyByCode}，直接
 *   轉傳給 `analysis.computeFactors_`（見該函式的說明）——不帶就不補基本面因子欄位，
 *   套用中的模型如果用到那批權重，對應貢獻會是 0（被 computeWeightedFactorScore_
 *   的既有防呆邏輯跳過），不是整個分數變 null，這是呼叫端沒傳索引時的既有行為。
 *
 * 回傳 { latestDate, reportDocs, diagnostics }：
 *   latestDate：這份戰報的交易日（historyRows 裡最新的日期），沒有資料時是 null。
 *   reportDocs：排除 Neutral 之後、依 armorScore 由高到低排序的戰報文件陣列，每筆
 *     已經帶 `id`（= code，給呼叫端當 Firestore 文件 ID 用）。
 *   diagnostics：篩選漏斗統計（computeScreeningStats_ 的回傳值），不管有沒有訊號都附上。
 */
function buildReport_(historyRows, lotDocs, screeningStrategyKey, appliedFactorModels, financialsIndex) {
  var portfolioMap = portfolio.buildPortfolioMap_(lotDocs);
  var strategyKey = analysis.SCREENING_STRATEGIES[screeningStrategyKey] ? screeningStrategyKey : analysis.SCREENING_STRATEGY_DEFAULT;
  var strategyDef = analysis.SCREENING_STRATEGIES[strategyKey];
  var applied = appliedFactorModels || {};

  if (historyRows.length === 0) {
    var emptyDiagnostics = analysis.computeScreeningStats_([], portfolioMap, null);
    return { latestDate: null, reportDocs: [], diagnostics: emptyDiagnostics, screeningStrategy: strategyKey };
  }

  var computed = analysis.computeFactors_(historyRows, portfolioMap, financialsIndex);
  var latestDateStr = null;
  computed.forEach(function (r) {
    var d = utils.normalizeDateStr(r['日期']);
    if (!latestDateStr || d > latestDateStr) latestDateStr = d;
  });
  var scanRows = computed.filter(function (r) { return utils.normalizeDateStr(r['日期']) === latestDateStr; });

  if (strategyDef.needsFactorModel && !applied.downsideResistance) {
    var blockedDiagnostics = analysis.computeScreeningStats_(scanRows, portfolioMap, latestDateStr);
    return {
      latestDate: latestDateStr, reportDocs: [], diagnostics: blockedDiagnostics, screeningStrategy: strategyKey,
      strategyError: '目前選用的篩選邏輯「' + strategyDef.label + '」需要先套用一版抗跌力因子迴歸模型，' +
        '尚未遷移因子模型資料，請先切換回 rule_v17 或等因子模型資料遷移完成。'
    };
  }
  if (strategyDef.needsFactorModel) analysis.computePredictedResistanceRanks_(scanRows, applied);

  var reportDocs = [];
  scanRows.forEach(function (r) {
    var diag = analysis.diagnoseRow_(r, portfolioMap, strategyKey);
    if (diag.strategy === 'Neutral') return;
    var predicted = factorModel.computePredictedFactorScores_(r, applied);
    reportDocs.push({
      id: r['證券代號'],
      date: latestDateStr,
      code: r['證券代號'],
      name: r['證券名稱'],
      armorScore: r.Armor_Score,
      strategy: diag.strategy,
      action: diag.action,
      interpretation: diag.interpretation,
      trendScore: r.Trend_Score,
      instPartRank: r.Inst_Part_Rank,
      ibf20dRank: r.IBF_20D_Rank,
      monitorUrl: diag.url,
      referenceHigh: diag.peak,
      predictedReturn1m: predicted.predictedReturn1M,
      predictedDownsideResistance: predicted.predictedDownsideResistance
    });
  });
  reportDocs.sort(function (a, b) { return (b.armorScore || 0) - (a.armorScore || 0); });

  var diagnostics = analysis.computeScreeningStats_(scanRows, portfolioMap, latestDateStr);
  diagnostics.reportCount = reportDocs.length;

  return {
    latestDate: latestDateStr,
    lookbackStart: analysis.computeLookbackStartStr_(latestDateStr),
    reportDocs: reportDocs,
    diagnostics: diagnostics,
    screeningStrategy: strategyKey
  };
}

module.exports = { buildReport_: buildReport_ };
