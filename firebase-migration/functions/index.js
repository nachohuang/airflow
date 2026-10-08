/**
 * index.js
 * Cloud Functions 進入點：把 lib/ 底下已經驗證過的純運算（lib/analysis.js／
 * lib/reportPipeline.js 等）接上真正的 I/O——讀 BigQuery 的 History（不動，
 * Phase 2 的結論是這張表留在 BigQuery，見 README「每天累積的股價及市場資料
 * 在哪裡遷移」）、讀 Firestore 的 `portfolio_lots`／`config/app`（Phase 2
 * 已經遷移完成的資料）跟 `factor_model_history`（Phase 3 跟後端邏輯一起
 * 遷移，`hybrid`/`factor_model_rank` 策略需要），算完寫進 Firestore
 * `reports/{date}/signals/{code}`（對照 firestore/schema.md §3）。
 *
 * 設計選擇：History 改成抓「最近 ANALYSIS_LOOKBACK_DAYS 天、全市場」的原始
 * 列，在這裡用已經跟 Apps Script 版 parity 驗證過的 lib/analysis.js
 * computeFactors_ 算因子，不是把 apps-script/src/BigQuerySync.gs 的
 * buildLatestDayFactorsSql_（整套 rolling 因子邏輯另外重刻一次成 BigQuery
 * window function SQL）也搬過來。理由：那支 SQL 存在的原因是 Apps Script
 * 的 V8 執行環境記憶體上限扛不住「150 天 x 全市場」的原始資料量，但 Cloud
 * Functions 預設就有更高的記憶體/執行時間上限，不需要为了同一個限制再維護
 * 第二套獨立實作（SQL 版）的因子計算邏輯——兩套算法各自都要驗證正確性，
 * 徒增風險，不如只信任已經被 parity.test.js 驗證過的那一套。
 *
 * ⚠️ 這支檔案牽涉真正的 BigQuery／Firestore 連線，這個開發環境沒有對應的雲端
 * 憑證，沒辦法在這裡實際執行驗證——跟 Phase 2 遷移工具的驗證模式一樣，需要
 * 部署到真正的 Firebase 專案、用 Cloud Shell 或本機憑證跑一次才能確認可以
 * 正常運作。lib/ 底下的計算邏輯本身已經靠 test/ 的單元測試跟 parity 測試
 * 驗證過，這支檔案要驗證的只是「接線有沒有接對」，不是「算得對不對」。
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { BigQuery } = require('@google-cloud/bigquery');
const iconv = require('iconv-lite');

const config = require('./lib/config');
const bigquery = require('./lib/bigquery');
const reportPipeline = require('./lib/reportPipeline');
const portfolio = require('./lib/portfolio');
const watchlistLib = require('./lib/watchlist');
const portfolioOpsLib = require('./lib/portfolioOps');
const utilsLib = require('./lib/utils');
const stockDetailLib = require('./lib/stockDetail');
const scheduleLib = require('./lib/schedule');
const aiDiagnosisLib = require('./lib/aiDiagnosis');
const aiUsageLib = require('./lib/aiUsage');
const twseFetchLib = require('./lib/twseFetch');
const backtestLib = require('./lib/backtest');
const analysisLib = require('./lib/analysis');
const industryMapLib = require('./lib/industryMap');
const factorScanLib = require('./lib/factorScan');
const factorRegressionLib = require('./lib/factorRegression');
const financialsLib = require('./lib/financials');
const mopsRevenueLib = require('./lib/mopsRevenueHtml');
const factorInspectorLib = require('./lib/factorInspector');

admin.initializeApp();

/** Firestore `config/app` 文件——screeningStrategy 跟 bigQuery 連線設定都從這裡讀，
 *  不在這支檔案裡另外猜測/硬寫任何一個值。文件不存在代表 Phase 2 的 config/app
 *  遷移還沒做，直接丟明確的錯誤，不要用猜的預設值悄悄跑下去。 */
async function fetchAppConfig_() {
  const snap = await admin.firestore().collection('config').doc('app').get();
  if (!snap.exists) {
    throw new Error('Firestore 裡找不到 config/app 文件，請先完成 Phase 2 的 config/app 遷移（見 firebase-migration/README.md）。');
  }
  return snap.data();
}

/** Firestore `portfolio_lots` collection 全部文件——buildPortfolioMap_ 自己會篩
 *  status === 'holding'，這裡不先篩選，交給純函式那一層處理（跟 lib/portfolio.js
 *  的職責劃分一致）。 */
async function fetchPortfolioLots_() {
  const snap = await admin.firestore().collection('portfolio_lots').get();
  return snap.docs.map(function (d) { return d.data(); });
}

/** 查 BigQuery 最近 ANALYSIS_LOOKBACK_DAYS 天、全市場的原始 History 列，轉成
 *  computeFactors_ 期待的中文欄名列。bigQueryConfig 是 config/app 文件的
 *  bigQuery 欄位（{projectId, dataset, sourceMode, pricePerTb}）。 */
async function fetchHistoryRows_(bigQueryConfig) {
  if (!bigQueryConfig || !bigQueryConfig.projectId) {
    throw new Error('config/app 的 bigQuery.projectId 是空的——請先在舊系統「因子回歸模型」設定頁填過 BigQuery 專案 ID，確認 Phase 2 的 config/app 遷移抓到了正確的值。');
  }
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const sourceRef = bigquery.sourceRefForRead_(bigQueryConfig);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.ANALYSIS_LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  // stocksOnly: true — 跟 apps-script 版 buildLatestDayFactorsSql_／computeFactors_
  // 的既有規則一致，這份戰報只算一般股票（LENGTH(stock_id) = 4），不含權證/ETF
  // （見 lib/bigquery.js buildHistoryRangeSql_ 的說明）。
  const sql = bigquery.buildHistoryRangeSql_(sourceRef, cutoffStr, null, { stocksOnly: true });
  const [rows] = await client.query({ query: sql });
  // mapBqRowToHistoryRow_ 回傳 null 代表 stock_id 清洗後不是合法代號，整列捨棄
  // （見 lib/bigquery.js 的說明——這是真實遇過的 OOM 事故的直接修正，不是預防性
  // 寫法）。
  return rows.map(bigquery.mapBqRowToHistoryRow_).filter(function (r) { return r !== null; });
}

/** Firestore `factor_model_history` collection 裡 `applied === true` 的文件
 *  （Phase 3 跟後端邏輯一起遷移，見 firebase-migration/migration/
 *  factor_model_history/），組成 reportPipeline.buildReport_ 需要的
 *  appliedFactorModels 形狀：{return1m: {timestamp, r2, weights},
 *  downsideResistance: {...}}，跟 apps-script/src/FactorRegression.gs 的
 *  getAppliedFactorModels() 回傳形狀一致。沒有任何套用中的模型時回傳 {}——
 *  rule_v17（預設策略）不需要這個，factor_model_rank／hybrid 需要。 */
async function fetchAppliedFactorModels_() {
  const snap = await admin.firestore().collection('factor_model_history').where('applied', '==', true).get();
  const applied = {};
  snap.docs.forEach(function (d) {
    const data = d.data();
    applied[data.labelKey] = { timestamp: data.timestamp, r2: data.r2, weights: data.weights };
  });
  return applied;
}

/**
 * 2026-10-08 新增：把余博邏輯延伸的基本面因子接進「今日戰報/回測」即時
 * 預測分數——讀 `financials_quarterly`／`financials_monthly`（累積寫入
 * 那兩個 collection，不是從 BigQuery 讀，見 `doRefreshFinancials_` 的
 * 說明），交給 `financialsLib.buildAsOfIndex_` 建好 as-of 索引，傳給
 * `analysis.computeFactors_`（見該函式 `financialsIndex` 參數的說明）。
 * 資料量级是「公司數 × 期數」，跟 `getFinancialsCoverage` 同一個「不需要
 * 另外做分頁/快取」的理由，整份讀回來就好。
 */
async function fetchFinancialsAsOfIndex_() {
  const [quarterlyDocs, monthlyDocs] = await Promise.all([
    fetchAllDocs_('financials_quarterly'),
    fetchAllDocs_('financials_monthly')
  ]);
  return {
    quarterlyByCode: financialsLib.buildAsOfIndex_(quarterlyDocs, function (r) { return r.period; }),
    monthlyByCode: financialsLib.buildAsOfIndex_(monthlyDocs, function (r) { return r.reportDate; })
  };
}

/**
 * 2026-10-08 新增：策略研究（回測）第一支——查 BigQuery 指定區間（不是像
 * `fetchHistoryRows_` 那樣固定「最近 ANALYSIS_LOOKBACK_DAYS 天」，回測要讀
 * 任意一段過去的區間）的原始 History 列，轉成 computeFactors_ 期待的中文
 * 欄名列。跟 `fetchHistoryRows_` 共用同一個 `stocksOnly: true` 規則（排除
 * 權證/ETF），差別只在日期區間是呼叫端給的，不是「到今天為止」。 */
async function fetchHistoryRangeRows_(bigQueryConfig, fromDateStr, toDateStr) {
  if (!bigQueryConfig || !bigQueryConfig.projectId) {
    throw new Error('config/app 的 bigQuery.projectId 是空的，請先完成 BigQuery 設定。');
  }
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const sourceRef = bigquery.sourceRefForRead_(bigQueryConfig);
  const sql = bigquery.buildHistoryRangeSql_(sourceRef, fromDateStr, toDateStr, { stocksOnly: true });
  const [rows] = await client.query({ query: sql });
  return rows.map(bigquery.mapBqRowToHistoryRow_).filter(function (r) { return r !== null; });
}

/**
 * 回測用：抓一次「這段回測範圍（含追蹤緩衝）」的 History，算好因子——跟
 * apps-script 版 `loadBacktestFactorRows_` 同一個用途，Firebase 版沒有
 * native/materialized 兩條路徑的分別（一律走 BigQuery，見 README「每天
 * 累積的股價及市場資料在哪裡遷移」的 Phase 2 結論），只有一條路徑。
 * `loadStartStr` 往前多抓 `ANALYSIS_LOOKBACK_DAYS` 天當暖機期間——rolling
 * 因子（MA60/IBF_20D 等）要跟正式戰報用同一套回看天數，算出來的訊號才會
 * 跟「戰報與個股」看到的完全一致，不是另一套近似值。portfolioMap 給空
 * 物件：回測把每一個訊號都當成「當天新進場」，不是既有持股。
 *
 * 2026-10-08 補充：連帶抓一次 `fetchFinancialsAsOfIndex_()`，讓回測用的
 * 基本面因子跟正式戰報同一套（否則回測結果會因為少算 10 個因子而跟
 * 戰報對不上）。 */
async function loadBacktestFactorRows_(bigQueryConfig, startStr, loadEndStr) {
  const warmupStart = new Date(startStr + 'T00:00:00');
  warmupStart.setDate(warmupStart.getDate() - config.ANALYSIS_LOOKBACK_DAYS);
  const loadStartStr = utilsLib.normalizeDateStr(warmupStart);
  const [rawRows, financialsIndex] = await Promise.all([
    fetchHistoryRangeRows_(bigQueryConfig, loadStartStr, loadEndStr),
    fetchFinancialsAsOfIndex_()
  ]);
  if (rawRows.length === 0) return [];
  return analysisLib.computeFactors_(rawRows, {}, financialsIndex);
}

/** 單一策略回測的核心邏輯（不含 onCall 的 auth／job 狀態追蹤，見
 *  `exports.runBacktest`）——對應 apps-script 版 `runBacktestV17_`。 */
async function runBacktestCore_(bigQueryConfig, appliedFactorModels, startStr, endStr, targetProfit, strategyKey) {
  targetProfit = targetProfit || backtestLib.BACKTEST_TARGET_DEFAULT;
  strategyKey = analysisLib.SCREENING_STRATEGIES[strategyKey] ? strategyKey : analysisLib.SCREENING_STRATEGY_DEFAULT;
  const strategyDef = analysisLib.SCREENING_STRATEGIES[strategyKey];

  const rangeCheck = backtestLib.validateBacktestRange_(startStr, endStr);
  if (rangeCheck.error) return rangeCheck;

  if (strategyDef.needsFactorModel && !appliedFactorModels.downsideResistance) {
    return { error: '篩選邏輯「' + strategyDef.label + '」需要先套用一版抗跌力因子迴歸模型，尚未遷移因子迴歸模型功能，請先切換回 rule_v17。' };
  }

  const loadEndStr = backtestLib.computeBacktestLoadEndStr_(endStr);
  const rows = await loadBacktestFactorRows_(bigQueryConfig, startStr, loadEndStr);
  if (rows.length === 0) {
    return { error: '這段日期區間（含暖機資料）沒有 History 資料，請先確認資料已抓取。' };
  }
  if (strategyDef.needsFactorModel) analysisLib.computePredictedResistanceRanks_(rows, appliedFactorModels);

  return backtestLib.simulateBacktestForStrategy_(rows, startStr, endStr, targetProfit, strategyKey);
}

/**
 * 「一次跑全部策略比對」的核心邏輯——對應 apps-script 版
 * `runBacktestAllStrategies_`：只抓一次資料，對同一批 rows 反覆呼叫
 * `simulateBacktestForStrategy_` 跑不同策略，BigQuery 查詢費用只花一次，
 * 不是乘以策略數。需要因子模型的版本（factor_model_rank／hybrid）在因子
 * 迴歸模型功能遷移完成之前，一律回傳「需要先套用模型」的錯誤，不影響
 * rule_v17 照常跑出結果。 */
async function runBacktestAllStrategiesCore_(bigQueryConfig, appliedFactorModels, startStr, endStr, targetProfit) {
  targetProfit = targetProfit || backtestLib.BACKTEST_TARGET_DEFAULT;

  const rangeCheck = backtestLib.validateBacktestRange_(startStr, endStr);
  if (rangeCheck.error) return rangeCheck;

  const loadEndStr = backtestLib.computeBacktestLoadEndStr_(endStr);
  const rows = await loadBacktestFactorRows_(bigQueryConfig, startStr, loadEndStr);
  if (rows.length === 0) {
    return { error: '這段日期區間（含暖機資料）沒有 History 資料，請先確認資料已抓取。' };
  }

  const hasResistanceModel = !!appliedFactorModels.downsideResistance;
  if (hasResistanceModel) analysisLib.computePredictedResistanceRanks_(rows, appliedFactorModels);

  const results = {};
  Object.keys(analysisLib.SCREENING_STRATEGIES).forEach(function (key) {
    const def = analysisLib.SCREENING_STRATEGIES[key];
    if (def.needsFactorModel && !hasResistanceModel) {
      results[key] = {
        strategyKey: key, strategyLabel: def.label,
        error: '需要先套用一版抗跌力因子迴歸模型，尚未遷移因子迴歸模型功能，請先切換回 rule_v17。'
      };
      return;
    }
    results[key] = backtestLib.simulateBacktestForStrategy_(rows, startStr, endStr, targetProfit, key);
  });

  return { startDay: startStr, endDay: endStr, targetProfit: targetProfit, results: results };
}

/**
 * Watchlist／Portfolio 卡片要顯示的「最新收盤價」跟名稱補救，統一用同一次
 * BigQuery 查詢取得——跟 apps-script/src/Portfolio.gs 的 getStockNameByCode／
 * getLatestCloseByCode_ 兩支各自查一次不同，這裡只查一次「這幾檔代號最近
 * 10 天的原始列」，同時拿到最新收盤價跟最新一筆的證券名稱，比兩次各自查詢
 * 省一次 BigQuery 費用（見這份檔案開頭／README 的設計決策說明）。
 * codes 是空陣列，或 config/app 還沒填 BigQuery 專案 ID 時，直接回傳 {}——
 * 跟 fetchHistoryRows_ 不同，這裡是卡片的「加分」資訊，查不到就顯示空白，
 * 不該讓整個 Watchlist/Portfolio 讀取因為 BigQuery 設定不完整而整個失敗。
 */
async function fetchBqInfoForCodes_(bigQueryConfig, codes) {
  if (!codes || codes.length === 0) return {};
  if (!bigQueryConfig || !bigQueryConfig.projectId) return {};
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const sourceRef = bigquery.sourceRefForRead_(bigQueryConfig);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 10);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const sql = bigquery.buildHistoryRowsForCodesSql_(sourceRef, codes, cutoffStr);
  const [rows] = await client.query({ query: sql });
  const mapped = rows.map(bigquery.mapBqRowToHistoryRow_).filter(function (r) { return r !== null; });
  const infoByCode = {};
  mapped.forEach(function (r) {
    const code = r['證券代號'];
    const d = r['日期'];
    if (!infoByCode[code] || d > infoByCode[code].date) {
      infoByCode[code] = { date: d, close: r['收盤價'], name: r['證券名稱'] };
    }
  });
  return infoByCode;
}

/**
 * `reports/{date}/signals` 底下，指定這幾檔代號各自最新一筆戰報燈號——跟
 * apps-script 版掃整個 Reports 分頁找每檔代號最大日期的那一筆不同，Firestore
 * 版戰報是依日期分 subcollection 存的（見 firestore/schema.md §3），這裡改用
 * collectionGroup 查詢只查呼叫端需要的這幾檔，不用把所有歷史戰報全部掃一輪。
 * 需要 `signals` 這個 collection group 上 (code ASC, date DESC) 的複合索引
 * （見 firestore/firestore.indexes.json），沒有這個索引查詢會直接失敗並在
 * 錯誤訊息裡附上建立索引的連結。
 */
async function fetchLatestSignalsByCode_(codes) {
  if (!codes || codes.length === 0) return {};
  const db = admin.firestore();
  const pairs = await Promise.all(codes.map(async function (code) {
    const snap = await db.collectionGroup('signals')
      .where('code', '==', code)
      .orderBy('date', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return null;
    const d = snap.docs[0].data();
    return [code, { date: d.date, strategy: d.strategy, action: d.action }];
  }));
  const map = {};
  pairs.forEach(function (pair) { if (pair) map[pair[0]] = pair[1]; });
  return map;
}

/** getWatchlist／getPortfolio 共用：給一批代號，併發查 BigQuery 最新收盤價/名稱
 *  跟各自最新一筆戰報燈號。 */
async function enrichByCode_(appConfig, codes) {
  const [bqInfoByCode, signalByCode] = await Promise.all([
    fetchBqInfoForCodes_(appConfig.bigQuery, codes),
    fetchLatestSignalsByCode_(codes)
  ]);
  return { bqInfoByCode: bqInfoByCode, signalByCode: signalByCode };
}

/** Firestore `watchlist` collection 全部文件（對照 firestore/schema.md §1）。 */
async function fetchWatchlistDocs_() {
  const snap = await admin.firestore().collection('watchlist').get();
  return snap.docs.map(function (d) { return d.data(); });
}

/** getWatchlist／addToWatchlist／removeFromWatchlist 都回傳同一份「加完料的
 *  觀察清單」，跟 apps-script 版三支函式都在最後呼叫 getWatchlist() 回傳同一個
 *  形狀一致（前端不用區分呼叫哪支，拿到的都是完整的最新清單）。 */
async function buildWatchlistResult_() {
  const [appConfig, watchlistDocs] = await Promise.all([fetchAppConfig_(), fetchWatchlistDocs_()]);
  const codes = watchlistDocs.map(function (d) { return d.code; });
  const enriched = await enrichByCode_(appConfig, codes);
  return watchlistLib.buildWatchlistItems_(watchlistDocs, enriched.bqInfoByCode, enriched.signalByCode);
}

/** getPortfolio／savePortfolioItem／deletePortfolioLot／closePortfolioPosition
 *  都回傳同一份「加完料的持股卡片」，跟 apps-script 版同一套設計。 */
async function buildPortfolioResult_() {
  const [appConfig, lotDocs] = await Promise.all([fetchAppConfig_(), fetchPortfolioLots_()]);
  const holdingCodes = Array.from(new Set(
    lotDocs.filter(function (l) { return l.status === 'holding'; }).map(function (l) { return l.code; })
  ));
  const enriched = await enrichByCode_(appConfig, holdingCodes);
  return portfolioOpsLib.buildPortfolioCards_(lotDocs, enriched.bqInfoByCode, enriched.signalByCode);
}

/**
 * 把 reportPipeline.buildReport_ 算出來的 reportDocs 寫進 Firestore
 * `reports/{date}/signals/{code}`。latestDate 是 null（完全查無 History 資料）
 * 時什麼都不寫——跟 apps-script 版 runAnalysisAndSave() 的「沒有可用資料就不寫」
 * 邏輯一致，不會用空值覆蓋掉昨天本來好好的戰報。
 *
 * 寫入前先讀一次同一天既有的文件，把「這次沒有出現在新報告裡」的舊文件刪掉——
 * 不能只對新的 reportDocs 做 set()：實際遇過的真實案例，同一天先用 rule_v17
 * 跑出 79 筆，切換成 hybrid 重跑只產生 8 筆，如果不清掉舊文件，Firestore 裡
 * 會留著 71 筆上一次策略算出來的舊資料跟這次的 8 筆混在一起，看起來像「今天的
 * 戰報」，但其實是兩個不同策略、不同時間點算出來的結果疊在一起，不是真正的
 * 當天戰報。同一天的訊號數量上限是全市場股票數（1000 出頭），刪除+寫入合計
 * 操作數可能超過 Firestore 單批 500 筆上限，所以分批跟 AiDiagnosis／
 * IndustryMap 的 import-firestore.js 一樣处理。
 */
async function writeReportDocs_(result) {
  if (!result.latestDate) return;
  const db = admin.firestore();
  const signalsRef = db.collection('reports').doc(result.latestDate).collection('signals');

  const existingSnap = await signalsRef.get();
  const newCodes = new Set(result.reportDocs.map(function (doc) { return doc.code; }));
  const staleRefs = existingSnap.docs
    .filter(function (d) { return !newCodes.has(d.id); })
    .map(function (d) { return d.ref; });

  const setOps = result.reportDocs.map(function (doc) {
    var fields = Object.assign({}, doc);
    delete fields.id;
    return { ref: signalsRef.doc(doc.code), fields: fields };
  });

  var ops = staleRefs.map(function (ref) { return { type: 'delete', ref: ref }; })
    .concat(setOps.map(function (op) { return { type: 'set', ref: op.ref, fields: op.fields }; }));

  const BATCH_SIZE = 400;
  for (var i = 0; i < ops.length; i += BATCH_SIZE) {
    var batch = db.batch();
    ops.slice(i, i + BATCH_SIZE).forEach(function (op) {
      if (op.type === 'delete') batch.delete(op.ref); else batch.set(op.ref, op.fields);
    });
    await batch.commit();
  }
}

/** 真正做事的地方：排程跟手動觸發的 HTTPS endpoint 都呼叫這支，確保兩邊行為
 *  完全一致（跟 apps-script 版 runAnalysisAndSave() 被排程跟手動按鈕共用是
 *  同一個設計）。 */
async function runDailyAnalysis_() {
  const appConfig = await fetchAppConfig_();
  const [historyRows, lotDocs, appliedFactorModels, financialsIndex] = await Promise.all([
    fetchHistoryRows_(appConfig.bigQuery),
    fetchPortfolioLots_(),
    fetchAppliedFactorModels_(),
    fetchFinancialsAsOfIndex_()
  ]);
  const result = reportPipeline.buildReport_(historyRows, lotDocs, appConfig.screeningStrategy, appliedFactorModels, financialsIndex);
  await writeReportDocs_(result);
  return result;
}

/**
 * 以下是每日股價資料抓取，從 apps-script/src/DataFetch.gs 的
 * `scheduledDailyFetch()` 整套管線搬過來——這是這個 App 的「資料從哪裡來」，
 * 跟上面的 `runDailyAnalysis_`（從 History 已經有的資料算戰報）是完全不同的
 * 兩件事，以前只有舊版 Apps Script 在做，Firebase 版一直沒有接手，這是這次
 * 要補的部分。
 *
 * 跟 apps-script 版的架構差異：
 * - **不重建 Drive 月份 CSV 這一層**——apps-script 版「沒設定 BigQuery 的
 *   使用者才會寫 Drive」這個 fallback 路徑，Firebase 版用不到（這個 App
 *   一定有設定 BigQuery，不然 Firebase 版完全沒有別的資料來源），新抓到的
 *   資料一律直接寫 `history_raw`（跟 apps-script 版「有設定 BigQuery 就
 *   不再寫 Drive」的行為一致，見 apps-script/src/SheetUtils.gs
 *   `upsertHistoryRows_` 的說明）。
 * - **不重建補抓 job 的「跨次執行續跑」機制**（`startBackfillJob`／
 *   `processBackfillJobTick_` 那一整套存游標、排下一次觸發器繼續跑的
 *   Script Properties 機制）——那是 Apps Script 6 分鐘硬性執行上限逼出來的
 *   設計，Cloud Functions 的逾時是這支函式自己宣告的（見下面
 *   `generateDailyReportScheduled` 的 `timeoutSeconds`），直接給夠時間一次
 *   跑完就好，不需要那套複雜度，跟 AI 診斷那邊拿掉 `budgetDeadline` 機制是
 *   同一個理由。
 * - **可以跟舊版 Apps Script 的 `scheduledDailyFetch()` 安全並存**——兩邊
 *   寫入同一張 `history_raw` 都是「先刪除這些日期既有資料、再寫入」的
 *   idempotent 寫法，誰先跑完某一天的資料就是誰的結果，不會重複或衝突。
 *   這次遷移沒有要停用舊系統的觸發器，純粹是新增一條獨立的資料來源路徑。
 */

/** TWSE 的 CSV 端點用 `Big5` 編碼回應（不是 UTF-8），Node 原生 `fetch`／
 *  `Response.text()` 只會用 UTF-8 解碼，中文字（股票名稱）會變成亂碼——用
 *  `iconv-lite` 手動解碼，對應 apps-script 版 `fetchCsvText_` 的
 *  `resp.getContentText('Big5')`。 */
/**
 * **2026-10-07 修正**：使用者實際補抓時，全部 9 天都失敗，錯誤是
 * `HTTP 307 - https://...`——`resp.status` 直接停在 307（重新導向本身的
 * 狀態碼），不是重新導向之後最終目的地的狀態碼，代表 Node 原生 `fetch`
 * 預設的自動跟隨重新導向（`redirect: 'follow'`）在這個情況下沒有真的
 * 跟過去（最常見的原因：TWSE 這個 307 回應沒有附 `Location` header，或
 * `Location` 是相對路徑/格式讓底層實作判斷不出來要跳去哪，就直接把這個
 * 307 回應原樣交回來，不是真的壞掉）。改成自己控制重新導向：
 * `redirect: 'manual'`，收到 3xx 就自己讀 `Location` header、解析成絕對
 * URL 再發一次請求（最多 5 次，避免無窮迴圈），不依賴底層實作「猜」要不要
 * 跟。如果最後還是失敗，錯誤訊息裡會帶上「有沒有 Location header」跟
 * 最終停在哪個 URL/狀態碼——這個開發環境連不到 twse.com.tw（見其他地方
 * 反覆提到的網路政策限制），没辦法直接重現/驗證 TWSE 到底為什麼回
 * 307，這裡能做的是讓下一次失敗時的錯誤訊息帶有足夠診斷資訊，不是盲猜
 * 一次就能保證修好；同時補上比單純 `User-Agent: Mozilla/5.0` 更完整的瀏覽器
 * header 組合（`Accept`／`Accept-Language`／`Referer`），降低被當成明顯
 * 的自動化流量擋下來的機率。
 */
async function fetchTwseCsvText_(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/csv,text/plain,*/*',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.twse.com.tw/'
  };
  let currentUrl = url;
  for (let hop = 0; hop < 5; hop++) {
    const resp = await fetch(currentUrl, { headers: headers, redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) {
        throw new Error('HTTP ' + resp.status + '（重新導向但沒有 Location header）- ' + currentUrl);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' - ' + currentUrl);
    const buf = Buffer.from(await resp.arrayBuffer());
    return iconv.decode(buf, 'big5');
  }
  throw new Error('重新導向次數過多（超過 5 次）- 原始網址：' + url + '，最後停在：' + currentUrl);
}

/** 抓單一交易日的三個 TWSE 端點、合併成 `history_raw` 要的列格式（中文欄名）。
 *  dateStr 是 'yyyy-MM-dd'。BWIBBU 查無資料（例如太早查詢）不擋住整天的
 *  資料——跟 apps-script 版的合併邏輯一致，BWIBBU 是 left join，缺值用
 *  `twseFetchLib.mergeDayRows_` 內建的預設值補。 */
async function fetchAndMergeOneDay_(dateStr) {
  const ymd = twseFetchLib.toTwseDateParam_(dateStr);
  const [t86Text, miText, bwText] = await Promise.all([
    fetchTwseCsvText_('https://www.twse.com.tw/rwd/zh/fund/T86?date=' + ymd + '&selectType=ALL&response=csv'),
    fetchTwseCsvText_('https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=' + ymd + '&type=ALL&response=csv'),
    fetchTwseCsvText_('https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=' + ymd + '&selectType=ALL&response=csv')
  ]);
  const t86Rows = twseFetchLib.parseT86Rows_(t86Text);
  const miRows = twseFetchLib.parseMiIndexRows_(miText);
  let bwRows = [];
  try {
    bwRows = twseFetchLib.parseBwibbuRows_(bwText);
  } catch (e) { /* BWIBBU 缺值不擋住整天的資料，見上面的說明 */ }
  return twseFetchLib.mergeDayRows_(t86Rows, miRows, bwRows, dateStr);
}

/** 把合併好的一天（或多天）資料寫進 BigQuery `history_raw`：刪除這些日期的
 *  既有資料、插入新資料。**2026-10-07 兩次修正**：
 *  (1) 原本 DELETE／INSERT 是兩次獨立的 `client.query()` 呼叫，INSERT 失敗時
 *  DELETE 已經成功的部分不會自動復原，等於把那天原本就有的資料弄丟（實際
 *  發生過）；改成第一批資料的 DELETE+INSERT 包進單一 transaction，失敗會
 *  ROLLBACK，原本的資料不受影響（見 `buildDeleteAndInsertTransactionSql_`）。
 *  (2) 原本假設一天的資料「组成一條 INSERT 完全不會超過 1MB」是錯的，實測
 *  一天份的資料可以到 3MB 以上，整個 INSERT 直接被 BigQuery 拒絕、补抓
 *  100% 失敗；改成依大小切成多個 chunk（見 `chunkRowsBySize_`），第一個
 *  chunk 連同 DELETE 包進交易，其餘 chunk 各自用一般 INSERT 補上——已知
 *  取捨（第一個 chunk 之後若有 chunk 失敗，這天會停在不完整狀態，不是
 *  整天的資料消失）寫在 `chunkRowsBySize_` 的說明裡。 */
async function writeHistoryRowsToBigQuery_(bigQueryConfig, rows) {
  if (!rows || rows.length === 0) return;
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const tableRef = bigquery.rawTableRef_(bigQueryConfig);
  const dates = Array.from(new Set(rows.map(function (r) { return r['日期']; })));
  const chunks = bigquery.chunkRowsBySize_(rows);
  const [firstChunk, ...restChunks] = chunks;
  await client.query({ query: bigquery.buildDeleteAndInsertTransactionSql_(tableRef, dates, firstChunk) });
  for (const chunk of restChunks) {
    await client.query({ query: bigquery.buildInsertRowsSql_(tableRef, chunk) });
  }
}

/** `history_raw` 目前最新的 date_str，查無資料回傳 null（全新安裝，或這張表
 *  還是空的）。 */
async function fetchHistoryMaxDate_(bigQueryConfig) {
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const tableRef = bigquery.rawTableRef_(bigQueryConfig);
  const [rows] = await client.query({ query: bigquery.buildMaxDateSql_(tableRef) });
  return (rows[0] && rows[0].max_date) || null;
}

/** 抓單一天、寫進 BigQuery，回傳跟 apps-script 版 `backfillOneDay_` 同樣形狀
 *  的結果（`kind: 'succeeded'|'failed'`，呼叫端逐天累計統計用）——單天失敗
 *  不拋例外，讓呼叫端的迴圈可以繼續處理下一天，跟 apps-script 版「一天抓完
 *  就立刻寫入、單日失敗不影響已成功的其他日期」同一個設計。 */
async function fetchOneDayAndWrite_(bigQueryConfig, dateStr) {
  try {
    const rows = await fetchAndMergeOneDay_(dateStr);
    await writeHistoryRowsToBigQuery_(bigQueryConfig, rows);
    return { kind: 'succeeded', date: dateStr, rowCount: rows.length };
  } catch (e) {
    return { kind: 'failed', date: dateStr, error: String(e.message || e) };
  }
}

/**
 * 每日排程呼叫（`generateDailyReportScheduled` 算戰報之前）：找出 `history_raw`
 * 目前最新到哪一天，逐天補抓到「今天」為止（跳過週末／`skip_dates`，見
 * `scheduleLib.buildCatchupDateList_`），最多補 `config.HISTORY_FETCH_MAX_CATCHUP_DAYS`
 * 天——正常情況下只差一天，缺口較大時交給 `exports.runHistoryBackfill`
 * （Admin 頁面手動觸發，範圍不受這裡的上限限制）。
 *
 * 不拋例外：抓取整個失敗（例如 TWSE 暫時連不上、BigQuery 查詢失敗）不該讓
 * 後面的「重新計算戰報」步驟也跟著不跑——沒抓到新資料，戰報就照舊用
 * BigQuery 裡目前最新的既有資料算一次，不會是空白結果，跟 apps-script 版
 * `runScheduleStep2_` 的「這步失敗不代表後面步驟沒有意義」設計一致（那邊是
 * `partial` 不算整步失敗；這裡更保守，連「整個 catchup 都失敗」也不拋）。
 */
async function runDailyCatchupFetch_(appConfig, skipDates) {
  if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) {
    return { skipped: true, reason: 'config/app 沒有設定 BigQuery 專案 ID' };
  }
  try {
    const maxDate = await fetchHistoryMaxDate_(appConfig.bigQuery);
    const todayStr = utilsLib.todayStrTaipei_();
    const fromDateStr = maxDate
      ? new Date(new Date(maxDate + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10)
      : todayStr;
    const dates = scheduleLib.buildCatchupDateList_(fromDateStr, todayStr, {
      skipWeekends: appConfig.skipWeekends,
      skipDates: skipDates,
      maxDays: config.HISTORY_FETCH_MAX_CATCHUP_DAYS
    });

    const succeeded = [];
    const failed = [];
    for (const dateStr of dates) {
      const result = await fetchOneDayAndWrite_(appConfig.bigQuery, dateStr);
      if (result.kind === 'succeeded') succeeded.push(result.date); else failed.push(result);
    }
    return { skipped: false, maxDateBefore: maxDate, attempted: dates, succeeded: succeeded, failed: failed };
  } catch (e) {
    return { skipped: true, reason: String(e.message || e) };
  }
}

/** 全市場 1000+ 檔股票 x ANALYSIS_LOOKBACK_DAYS(150)天的原始 History，實測需要
 *  的記憶體比 Cloud Functions 2nd gen 預設的 256 MiB 略高（部署後實測跑到
 *  256 MiB 就被 OOM 砍掉，見 firebase-migration/README.md 的部署驗證紀錄）——
 *  跟 apps-script 版当年因為 Apps Script V8 記憶體上限才把因子計算改寫成
 *  BigQuery SQL 是同一個量級的資料，但這裡純粹是部署設定沒給夠，不是架構問題，
 *  調大記憶體配置就解決，不需要像 apps-script 版那樣另外維護一套 SQL 實作。
 *  1GiB 大約是實測用量（267~291 MiB）的 3~4 倍，留足餘裕應付資料量隨股票數
 *  微幅成長。 */
var RUNTIME_OPTS_ = { memory: '1GiB', timeoutSeconds: 180 };

/**
 * 2026-10-07：Cloud Functions (2nd gen) 預設給每支函式 `cpu: 1`（1 顆完整
 * vCPU，只要 `memory <= 2GiB` 都一樣，不會因為 memory 設低一點就自動跟著
 * 降低）。這個 App 大多數函式都共用 `RUNTIME_OPTS_`，包括單純讀寫一兩筆
 * Firestore 文件的 CRUD 函式（例如 `getWatchlist`／`addToWatchlist`）——
 * 這些函式跟真的需要算力的函式（算戰報、查 BigQuery、跑 AI 診斷）吃一樣
 * 的 1 vCPU，完全是殺雞用牛刀，而且部署時每支函式的 CPU 配額會疊加：
 * 這個專案的 Cloud Run CPU 配額（us-central1，`Total CPU allocation, per
 * project per region`）卡在 20,000 milli vCPU（20 顆）的硬上限，使用者
 * 實測在 GCP Console 想申請提高也顯示「依據服務使用情形，目前無法申請
 * 提高配額」——這個專案目前有 20 幾支函式，大半是這種單純 CRUD，全部吃
 * 滿 1 vCPU 疊加起來很容易在部署時（新舊 revision 短暫並存，CPU 用量
 * 會瞬間加倍）超過這個硬上限，這正是這次部署反覆遇到
 * 「Quota exceeded for total allowable CPU per project per region」的
 * 根本原因，不只是巧合的瞬間尖峰。
 *
 * 給這些單純的 Firestore CRUD 函式明確調低 `cpu`（連帶把 `concurrency`
 * 設成 1——SDK 規定 `cpu < 1` 時 concurrency 只能是 1，見
 * `firebase-functions` 的 `GlobalOptions.concurrency` 說明）：這個 App
 * 全程只有擁有者一人使用，這些函式本來就不會有真正的並發請求，
 * concurrency=1 不會造成任何實際影響，純粹是把一直閒置的 CPU 配額讓出來
 * 給部署時其他函式用，降低撞到這個硬上限的機率。只套用在真的單純讀寫
 * Firestore、不碰 BigQuery／外部 API／LLM 的函式上——算戰報、抓
 * TWSE／BigQuery、AI 診斷這些真的需要算力/逾時餘裕的函式維持用預設的
 * `RUNTIME_OPTS_`，不動它們的資源設定。
 *
 * **部署驗證抓到的錯誤**：第一次只蓋掉 `cpu`、沒動 `memory`（繼續沿用
 * `RUNTIME_OPTS_` 的 `1GiB`），部署直接被 Firebase CLI 拒絕：
 * 「The functions ... have too little CPU for their memory allocation.
 * A minimum of 0.5 CPU is needed to set a memory limit greater than
 * 512MiB」——Cloud Run 的 memory/CPU 組合有硬性規則，memory 超過
 * 512MiB 就不能把 cpu 設在 0.5 以下。這些函式本身單純讀寫一兩筆
 * Firestore 文件，但跟其他函式共用同一個 `index.js`，module 層級的
 * `require()`（BigQuery client／cheerio 之類的重依賴）每個函式冷啟動都
 * 要付一次代價，不是只有真的用到那個依賴的函式才付——保守起見選
 * `512MiB`（Cloud Run 這個級距仍然允許 `cpu` 低於 0.5），沒有進一步砍到
 * `256MiB` 那麼極端：這個開發環境沒辦法實際部署驗證冷啟動會不會 OOM
 * （見 README 其他地方反覆提到的網路政策限制），没把握的情況下不賭
 * 激進的數字。
 */
var LIGHT_RUNTIME_OPTS_ = Object.assign({}, RUNTIME_OPTS_, { memory: '512MiB', cpu: 0.25, concurrency: 1 });

/** `skip_dates` collection 的文件 ID（就是日期字串 `yyyy-MM-dd`，見
 *  firestore/schema.md §5），組成 Set 給 `scheduleLib.shouldRunDailyReport_`
 *  用——collection 很小（偶爾才加一筆臨時停跑日），直接整個撈回來，不用查詢。 */
async function fetchSkipDates_() {
  const snap = await admin.firestore().collection('skip_dates').get();
  return new Set(snap.docs.map(function (d) { return d.id; }));
}

/**
 * 寫一筆執行紀錄（成功／失敗／部分成功／略過），給 Admin 頁面「執行紀錄」卡片
 * 顯示用——跟 apps-script 版 `logRun_`（寫進 Sheets 的 `RunLog` 分頁，上限
 * 500 筆自動裁剪舊紀錄）同一個用途，這版寫進 Firestore 的 `run_log`
 * collection（不做自動裁剪——Firestore 沒有「刪最舊 N 筆」這種單一操作，
 * 要裁剪得另外查詢+批次刪除，對一個單人工具每天幾筆的寫入量，暫時不值得
 * 做，之後資料真的多到需要時再補）。
 *
 * category 沿用 apps-script 版「大類-子動作」的命名慣例（例如
 * `'每日排程-補抓資料'`），Admin 頁面依「-」前的文字分組篩選。刻意吞掉寫入
 * 失敗的錯誤——執行紀錄是「順便記一筆」的旁支資訊，寫失敗不該讓已經成功的
 * 主要流程整個報錯給使用者看，跟 `logAiUsage_` 同一個理由。
 */
async function logRun_(category, status, message, durationMs) {
  try {
    await admin.firestore().collection('run_log').add({
      timestampMs: Date.now(),
      timestamp: utilsLib.timestampLabelTaipei_(),
      category: category,
      status: status,
      message: String(message || ''),
      durationMs: durationMs || 0
    });
  } catch (e) { /* 見上方說明 */ }
}

/**
 * 寫入 `jobs/{jobKey}` 的目前狀態（`status: 'running'|'succeeded'|'partial'|
 * 'failed'`），搭配前端對同一份文件的 `onSnapshot` 監聽，取代「前端等這次
 * onCall 呼叫本身回傳結果」的做法——2026-10-07 使用者實際回報：手動按「開始
 * 補抓」之後把 App 切到背景（或在 SPA 內切到別的分頁再切回來），畫面看不到
 * 補抓進度，跟舊版 apps-script「排程佇列」可以隨時回來看目前狀態的體驗不
 * 一樣。根因是 Firebase callable SDK 的這次呼叫（連同它的 client 端連線）
 * 本來就跟瀏覽器分頁/連線的生命週期綁在一起——手機瀏覽器切到背景很容易
 * 直接把連線中斷掉，但後端 Cloud Function 本身不受影響，还是會繼續跑完
 * （純粹是「這次呼叫的 HTTP 回應送不回原本那個已經斷線的瀏覽器」，不是
 * 「後端被中止」）；而 Vue 元件一旦被切走重新掛載，原本存在元件內的
 * `ref`（例如 `backfillRunning`）也會被整個砍掉重建，不管連線有沒有斷都一樣
 * 會「忘記」有工作正在執行。改成在開始執行、執行完成這兩個時間點都把狀態
 * 寫進 Firestore 的 `jobs/{jobKey}`（`firestore.rules` 已經開放 owner 讀取），
 * 前端用 `onSnapshot` 監聽這份文件來畫面，不管是不是同一次連線、同一個
 * 元件實例收到結果，重新打開頁面／重新掛載元件都能拿到當下最新狀態。
 * 刻意吞掉寫入失敗（跟 `logRun_` 同一個理由：這只是狀態顯示用的旁支資訊，
 * 寫失敗不該讓背景工作本身失敗）。
 */
async function writeJobStatus_(jobKey, patch) {
  try {
    await admin.firestore().collection('jobs').doc(jobKey).set(
      Object.assign({ updatedAt: Date.now() }, patch),
      { merge: true }
    );
  } catch (e) { /* 見上方說明 */ }
}

/**
 * 每 5 分鐘被 Cloud Scheduler 叫醒一次（不是「每個交易日固定時間」一次），叫醒
 * 之後用 `scheduleLib.shouldRunDailyReport_` 判斷現在的台北時間是不是落在
 * `config/app` 的 `triggerHour`/`triggerMinute` 設定的目標區間、有沒有跳過
 * 週末／`skip_dates` 裡的臨時停跑日，不是才直接 return，不做任何事。
 *
 * 跟 apps-script 版的設計差異（見 lib/schedule.js 開頭的完整說明）：Apps
 * Script 可以在執行階段動態新增/刪除真正的時間觸發器，使用者在畫面上改排程
 * 設定，下次觸發時間馬上跟著變；Cloud Scheduler 的 cron 是部署時寫死的設定，
 * 沒辦法用同樣的方式動態改，除非額外串 Cloud Scheduler Admin API（多一組
 * IAM 權限、多一個 GCP 依賴）。改成固定頻率 tick 換取「使用者在 Admin 頁面
 * 改設定，最多等 5 分鐘就生效，不用重新部署」，代價是觸發精準度降到 5 分鐘
 * 解析度——對「每天收盤後算一次戰報」這種用途完全足夠，不需要精準到那一分鐘。
 * 絕大多數的 tick 只做兩次 Firestore 讀取就直接 return，成本可以忽略（一天
 * 288 次 tick，遠低於 Cloud Functions 免費額度）。
 *
 * `timeoutSeconds: 600`（蓋掉 `RUNTIME_OPTS_` 的 180，見下面 `Object.assign`
 * 的參數順序——後面的物件屬性覆蓋前面的，所以客製化選項要放在 `RUNTIME_OPTS_`
 * 後面，不是像其他呼叫端那樣放前面）：真正算戰報那一次 tick，現在開頭會先跑
 * `runDailyCatchupFetch_`（補抓最新股價資料，見該函式的說明，最多
 * `HISTORY_FETCH_MAX_CATCHUP_DAYS`＝10 天，實測一天數秒等級），寫完戰報之後
 * 如果 `config/app.aiDailyEnabled` 開著，還要接著跑 Top3 橫向比較＋候選名單
 * 橫向比較＋逐檔深度診斷（見 `runDailyAiDiagnosisForTopPicks_`，候選數上限
 * 10 檔）。180 秒遠遠不夠用；600 秒（10 分鐘）在這些上限下留了充足餘裕，
 * 不需要像 apps-script 版那樣另外維護一套 `budgetDeadline` 提早收手的機制
 * ——那是 Apps Script 6 分鐘硬性執行上限逼出來的設計，Cloud Functions 的逾時
 * 是這支函式自己宣告的，直接給夠就不會撞到。需要 `secrets: ['GEMINI_API_KEY']`
 * ——這支函式現在也會直接呼叫 Gemini，不是只靠 `runDailyAiDiagnosisForTopPicks_`
 * 內部呼叫的其他函式各自宣告就會生效（每支 Cloud Function 的 `secrets` 要
 * 各自獨立宣告，見 `runAiDiagnosis`/`getAiKeyStatus` 的說明）。
 */
/**
 * 補抓資料→重新計算戰報→（如果開著）每日自動 AI 診斷，這三步的共用核心——
 * `generateDailyReportScheduled`（排程自動觸發）跟 `exports.runFullScheduleNow`
 * （2026-10-07 新增，Admin 頁面手動觸發，對應 apps-script 版「測試完整排程
 * 流程（5 步驟）」）共用同一份實作，不要兩條路徑各自維護一次「這三步要
 * 怎麼串、每步的 logRun_ 訊息怎麼組」。`categoryPrefix` 讓兩條路徑各自的
 * 執行紀錄分得清楚是排程自動跑的還是使用者手動按的（`'每日排程-'` vs
 * `'手動完整排程-'`）。 */
async function runFullSchedulePipeline_(appConfig, skipDates, categoryPrefix) {
  const fetchStart = Date.now();
  const fetchResult = await runDailyCatchupFetch_(appConfig, skipDates);
  await logRun_(
    categoryPrefix + '補抓資料',
    fetchResult.skipped ? '略過' : (fetchResult.failed.length ? '部分成功' : '成功'),
    fetchResult.skipped
      ? fetchResult.reason
      : ('成功 ' + fetchResult.succeeded.length + ' 天' + (fetchResult.succeeded.length ? '（' + fetchResult.succeeded.join('、') + '）' : '') +
        (fetchResult.failed.length ? '，失敗 ' + fetchResult.failed.length + ' 天' : '')),
    Date.now() - fetchStart
  );

  const analysisStart = Date.now();
  const analysisResult = await runDailyAnalysis_();
  await logRun_(
    categoryPrefix + '重新計算戰報',
    analysisResult.strategyError ? '失敗' : '成功',
    analysisResult.strategyError || (analysisResult.latestDate
      ? ('戰報日期 ' + analysisResult.latestDate + '，' + analysisResult.reportDocs.length + ' 檔訊號')
      : '沒有可用的歷史資料，查無戰報'),
    Date.now() - analysisStart
  );

  if (appConfig.aiDailyEnabled) {
    // runDailyAiDiagnosisForTopPicks_ 內部已經把 Top3／候選名單這兩段各自包了
    // try/catch，這裡再包一層純粹是防禦性的最後一道防線——AI 診斷失敗不該讓
    // 整次執行被記成失敗、也不該讓已經成功寫入的戰報被当成沒跑完。
    const aiStart = Date.now();
    try {
      const aiResult = await runDailyAiDiagnosisForTopPicks_(appConfig);
      await logRun_(
        categoryPrefix + '每日自動AI診斷',
        (aiResult.topPicks.ok && aiResult.shortlist.ok) ? '成功' : '部分成功',
        'Top3：' + (aiResult.topPicks.ok ? '成功' : '失敗（' + aiResult.topPicks.error + '）') +
          '　候選名單：' + (aiResult.shortlist.ok ? '成功' : '失敗（' + aiResult.shortlist.error + '）'),
        Date.now() - aiStart
      );
    } catch (e) {
      await logRun_(categoryPrefix + '每日自動AI診斷', '失敗', String(e.message || e), Date.now() - aiStart);
    }
  }

  return { fetchResult: fetchResult, analysisResult: analysisResult };
}

exports.generateDailyReportScheduled = onSchedule(
  Object.assign({}, RUNTIME_OPTS_, { schedule: '*/5 * * * *', timeoutSeconds: 600, secrets: ['GEMINI_API_KEY'] }),
  async function () {
    const appConfig = await fetchAppConfig_();
    const skipDates = await fetchSkipDates_();
    const should = scheduleLib.shouldRunDailyReport_(new Date(), {
      triggerHour: appConfig.triggerHour,
      triggerMinute: appConfig.triggerMinute,
      skipWeekends: appConfig.skipWeekends,
      skipDates: skipDates
    });
    if (!should) return;
    await runFullSchedulePipeline_(appConfig, skipDates, '每日排程-');
  }
);

/**
 * 2026-10-07 新增：使用者發現 Admin 頁面完全沒有地方可以手動觸發完整的
 * 排程流程（補抓資料→重新計算戰報→AI 診斷），對應 apps-script 版「系統與
 * 資料後台」頁面的「測試完整排程流程（5 步驟）」按鈕——那邊可以跳過
 * `shouldRunDailyReport_` 的時間窗判斷，不管現在是不是該排程執行的時間，
 * 想重跑就重跑。這裡同樣繞過時間窗（使用者明確按了按鈕，不需要再檢查
 * 現在是不是「該執行的時間」），直接呼叫跟排程共用的
 * `runFullSchedulePipeline_`。
 *
 * `timeoutSeconds: 1800`（30 分鐘，callable function 允許的上限是 3600
 * 秒）——這條路徑同時包含補抓資料（可能好幾天）跟 AI 診斷（Top3 橫向比較
 * ＋候選名單逐檔深度診斷，每檔都要查 Goodinfo＋呼叫 LLM），比單純的
 * `runHistoryBackfill` 更重，540 秒可能不夠，給更充裕的餘裕。
 *
 * 用 `jobs/fullSchedule` 追蹤執行狀態，跟 `runHistoryBackfill` 的
 * `jobs/historyBackfill` 同一個模式（見 `writeJobStatus_` 的說明）——
 * 前端用即時監聽顯示進度，不綁定這次 callable 呼叫本身有沒有收到回應。
 */
exports.runFullScheduleNow = onCall(
  Object.assign({}, RUNTIME_OPTS_, { timeoutSeconds: 1800, secrets: ['GEMINI_API_KEY'] }),
  async function (request) {
    assertOwnerAuth_(request);
    const startTime = Date.now();
    await writeJobStatus_('fullSchedule', { status: 'running', startedAt: startTime, error: null });
    try {
      const appConfig = await fetchAppConfig_();
      const skipDates = await fetchSkipDates_();
      const result = await runFullSchedulePipeline_(appConfig, skipDates, '手動完整排程-');
      await writeJobStatus_('fullSchedule', {
        status: 'succeeded',
        finishedAt: Date.now(),
        result: {
          latestDate: result.analysisResult.latestDate || null,
          reportCount: result.analysisResult.reportDocs ? result.analysisResult.reportDocs.length : 0,
          strategyError: result.analysisResult.strategyError || null
        },
        error: null
      });
      return { ok: true };
    } catch (e) {
      await writeJobStatus_('fullSchedule', { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
      throw e;
    }
  }
);

/**
 * 2026-10-08 新增：策略研究（回測）的 onCall 入口——`exports.runBacktest`
 * （單一策略）跟 `exports.runBacktestAllStrategies`（一次跑全部策略比對）
 * 共用 `jobs/backtest` 這個 key 追蹤狀態（`mode` 欄位區分是哪一種），跟
 * `runHistoryBackfill`／`runFullScheduleNow` 同一套模式（見
 * `writeJobStatus_` 的完整說明）：前端監聽這份文件顯示進度，按鈕不會被
 * 鎖住，連線中斷／App 切到背景都不影響真正的執行狀態。
 *
 * `memory: '2GiB'`（蓋掉 `RUNTIME_OPTS_` 的 `1GiB`）——回測要讀的資料量比
 * 戰報本身大不少：戰報只抓 `ANALYSIS_LOOKBACK_DAYS`（150）天，回測區間
 * 另外再加上最多 `BACKTEST_MAX_RANGE_DAYS`（60）天的進場區間跟
 * `BACKTEST_MAX_HOLD_DAYS`（40，換算日曆天數約 64 天）的出場追蹤緩衝，
 * 總共可能讀到 270 天以上的全市場資料，戰報那邊 `1GiB` 的額度是針對
 * 150 天實測出來的（約 270~290 MiB 用量，見 `RUNTIME_OPTS_` 的說明），
 * 這裡資料量接近兩倍，保守抓到 `2GiB`——這個開發環境沒辦法實際跑一次
 * 回測量測真實記憶體用量，先用保守值，真的在正式環境遇到 OOM 再調整。
 *
 * `errorToHttpsError_`：`runBacktestCore_`／`runBacktestAllStrategiesCore_`
 * 沿用 apps-script 版「驗證失敗回傳 `{error}` 物件」的設計（不是拋例外），
 * 這裡在 onCall 的邊界把「完全沒有跑起來」的 `{error}` 轉成
 * `HttpsError('failed-precondition', ...)`，跟這個 Firebase 版其他 onCall
 * 一致的慣例（前端的 catch 區塊認的是拋出來的例外，不是回傳值裡的
 * `error` 欄位）——但 `runBacktestAllStrategiesCore_` 回傳的
 * `results[key].error`（某一個策略因為沒有套用因子模型而跑不了，其他
 * 策略正常）**不**轉換，維持原樣當正常資料的一部分回傳，這是刻意的
 * 部分失敗設計，不是「整批失敗」。
 */
function errorToHttpsError_(result) {
  if (result && result.error) throw new HttpsError('failed-precondition', result.error);
  return result;
}

var BACKTEST_RUNTIME_OPTS_ = Object.assign({}, RUNTIME_OPTS_, { memory: '2GiB', timeoutSeconds: 540 });

// 2026-10-08：跟 getFinancialsCoverage 上方同一個「Firebase CLI 把
// rerun_failed_jobs 的重跑誤判成內容沒變而跳過」問題，這支（接了
// loadBacktestFactorRows_ 新增的基本面因子）卡住了，改一次原始碼重試。
exports.runBacktest = onCall(BACKTEST_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  if (!data.startDate || !data.endDate) {
    throw new HttpsError('invalid-argument', '請提供 startDate／endDate（yyyy-MM-dd）。');
  }
  const startTime = Date.now();
  await writeJobStatus_('backtest', {
    status: 'running', startedAt: startTime, mode: 'single',
    params: { startDate: data.startDate, endDate: data.endDate, targetProfit: data.targetProfit || null, strategyKey: data.strategyKey || null },
    error: null
  });
  try {
    const appConfig = await fetchAppConfig_();
    if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) {
      throw new HttpsError('failed-precondition', 'config/app 沒有設定 BigQuery 專案 ID。');
    }
    const appliedFactorModels = await fetchAppliedFactorModels_();
    const result = errorToHttpsError_(
      await runBacktestCore_(appConfig.bigQuery, appliedFactorModels, data.startDate, data.endDate, data.targetProfit, data.strategyKey)
    );
    const durationMs = Date.now() - startTime;
    const summaryMsg = data.startDate + '~' + data.endDate + '　' +
      (result.summary ? result.summary.signalCount + ' 筆訊號、勝率 ' + result.summary.winRate + '%' : result.warning);
    await logRun_('v17.0回測', '成功', summaryMsg, durationMs);
    await writeJobStatus_('backtest', { status: 'succeeded', finishedAt: Date.now(), mode: 'single', result: result, error: null });
    return result;
  } catch (e) {
    await logRun_('v17.0回測', '失敗', String(e.message || e), Date.now() - startTime);
    await writeJobStatus_('backtest', { status: 'failed', finishedAt: Date.now(), mode: 'single', error: String(e.message || e) });
    throw e;
  }
});

exports.runBacktestAllStrategies = onCall(BACKTEST_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  if (!data.startDate || !data.endDate) {
    throw new HttpsError('invalid-argument', '請提供 startDate／endDate（yyyy-MM-dd）。');
  }
  const startTime = Date.now();
  await writeJobStatus_('backtest', {
    status: 'running', startedAt: startTime, mode: 'all',
    params: { startDate: data.startDate, endDate: data.endDate, targetProfit: data.targetProfit || null },
    error: null
  });
  try {
    const appConfig = await fetchAppConfig_();
    if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) {
      throw new HttpsError('failed-precondition', 'config/app 沒有設定 BigQuery 專案 ID。');
    }
    const appliedFactorModels = await fetchAppliedFactorModels_();
    const result = errorToHttpsError_(
      await runBacktestAllStrategiesCore_(appConfig.bigQuery, appliedFactorModels, data.startDate, data.endDate, data.targetProfit)
    );
    const durationMs = Date.now() - startTime;
    const summaryMsg = Object.keys(result.results || {}).map(function (k) {
      const r = result.results[k];
      return r.strategyLabel + '：' + (r.summary ? '勝率 ' + r.summary.winRate + '%' : (r.error || r.warning));
    }).join('　');
    await logRun_('v17.0回測', '成功', summaryMsg, durationMs);
    await writeJobStatus_('backtest', { status: 'succeeded', finishedAt: Date.now(), mode: 'all', result: result, error: null });
    return result;
  } catch (e) {
    await logRun_('v17.0回測', '失敗', String(e.message || e), Date.now() - startTime);
    await writeJobStatus_('backtest', { status: 'failed', finishedAt: Date.now(), mode: 'all', error: String(e.message || e) });
    throw e;
  }
});

/**
 * 2026-10-08 新增：股票代號→產業別對照表的刷新＋同步，從
 * apps-script/src/IndustryMap.gs 搬過來（純函式邏輯見 lib/industryMap.js）。
 * 這不是「策略研究」本身的功能，是 FactorRegression.gs（還沒遷移）36 個
 * 「產業資金流向」／「產業相對大盤」候選因子的前置依賴——那些因子要 JOIN
 * BigQuery 的 `industry_map` 表才有意義，沒有這張表（或表是空的）它們全部
 * 會拿到中性值 0.5，訓練預算大半被浪費（見 README「策略研究」相關章節的
 * 分析）。公司產業分類幾乎不會變動，不接進每日排程，靠 Admin 頁面「重新
 * 整理產業對照表」按鈕手動觸發。
 *
 * 跟 apps-script 版的架構差異：
 * - **沒有搬背景 job 狀態機**（`startIndustryMapRefreshJob`／
 *   `processIndustryMapJobTick_`／`clearIndustryMapRefreshJob_`）——跟
 *   Backtest.gs／之前其他功能同一個理由，Cloud Functions 一次同步呼叫
 *   搞定，不需要 Apps Script 6 分鐘限制逼出來的分批機制，改用
 *   `jobs/industryMapRefresh` 搭配前端 `onSnapshot`（跟補抓區間/回測同一套
 *   模式）。
 * - **靜態參考表存 Firestore `industry_map/{code}`，不是 Sheet**——
 *   Phase 2 已經把舊資料一次性遷移過去（見
 *   `firebase-migration/migration/industry_map/`），這裡接手之後每次
 *   刷新整份覆蓋（刪掉這次沒出現的舊文件，跟 `writeReportDocs_`
 *   同一個模式），不是逐日累積的歷史資料。
 * - **BigQuery 同步改成手刻 SQL，不是 CSV load job**——apps-script 版用
 *   `BigQuery.Jobs.insert` 的 CSV load job（Apps Script 進階服務的既有
 *   模式），這裡改成跟其他表一致的 `CREATE OR REPLACE TABLE ... AS
 *   SELECT`（見 `lib/bigquery.js buildSyncIndustryMapSql_`），全市場
 *   上千筆的資料量遠低於 1MB 查詢上限，不需要 chunk。
 *
 * 上櫃（TPEX）產業別資料源目前還沒確認正確的 API 路徑，跟 apps-script 版
 * 一致：`fetchTpexListedIndustryMap_` 明確回傳「沒有資料＋警告」，不用猜的
 * 路徑產生看起來像成功、實際上錯誤的資料。
 */

/** 產業對照表涵蓋率檢查用：抓「目前追蹤的最新一天」全市場股票代號清單。
 *  跟 `fetchHistoryMaxDate_`（決定補抓資料要從哪一天接續，固定查寫入目標
 *  `rawTableRef_`）目的不同，這裡要跟戰報頁面實際看到的資料來源一致，查
 *  `sourceRefForRead_`（跟 `getHistoryOverview` 同一個理由，見該處說明）。
 *  查無任何資料（全新安裝）回傳空陣列，呼叫端自行處理「無法比對涵蓋率」。 */
async function fetchTrackedCodesForCoverage_(bigQueryConfig) {
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const sourceRef = bigquery.sourceRefForRead_(bigQueryConfig);
  const [maxRows] = await client.query({ query: bigquery.buildMaxDateSql_(sourceRef) });
  const maxDate = maxRows[0] && maxRows[0].max_date;
  if (!maxDate) return [];
  const rows = await fetchHistoryRangeRows_(bigQueryConfig, maxDate, maxDate);
  return rows.map(function (r) { return r['證券代號']; });
}

/** 抓 TWSE OpenAPI 上市公司基本資料（t187ap03_L），轉成
 *  `industryMapLib.parseTwseIndustryMapRows_` 期待的原始列、順便做掉欄位
 *  偵測與翻譯。這支端點在 `openapi.twse.com.tw` 子網域、回應是 JSON，跟
 *  `fetchTwseCsvText_` 處理的 `www.twse.com.tw` CSV 端點是不同主機也是
 *  不同格式——目前沒有遇到那邊的 307 重新導向問題，用一般 `fetch` 就好，
 *  不套用那套手動跟隨重新導向的邏輯（如果之後真的遇到類似問題，再比照
 *  套用，不先预防性地套用增加複雜度）。 */
async function fetchTwseListedIndustryMap_() {
  const resp = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', {
    headers: { 'Accept': 'application/json' }
  });
  if (!resp.ok) throw new Error('TWSE 上市公司基本資料查詢失敗（HTTP ' + resp.status + '）');
  const rawRows = await resp.json();
  return industryMapLib.parseTwseIndustryMapRows_(rawRows);
}

/** 上櫃（TPEX）產業別資料源目前還沒確認正確的 API 路徑，見上方章節說明。 */
function fetchTpexListedIndustryMap_() {
  return { rows: [], warning: '上櫃（TPEX）產業別資料源尚未確認正確的 API 路徑，目前只有上市股票有產業別資料。' };
}

/** 把產業對照表整份寫進 Firestore `industry_map/{code}`——跟
 *  `writeReportDocs_` 同一個「整份覆蓋，刪掉這次沒出現的舊文件」模式，因為
 *  這是「目前狀態」的靜態參考表，不是逐日累積的歷史資料，沒有「保留舊
 *  版本」的需求。 */
async function writeIndustryMapToFirestore_(rows) {
  const db = admin.firestore();
  const ref = db.collection('industry_map');
  const existingSnap = await ref.get();
  const newCodes = new Set(rows.map(function (r) { return r.code; }));
  const staleRefs = existingSnap.docs
    .filter(function (d) { return !newCodes.has(d.id); })
    .map(function (d) { return d.ref; });

  const updatedAt = Date.now();
  const ops = staleRefs.map(function (docRef) { return { type: 'delete', ref: docRef }; })
    .concat(rows.map(function (r) {
      return {
        type: 'set', ref: ref.doc(r.code),
        fields: { code: r.code, name: r.name, industry: r.industry, market: r.market, updatedAt: updatedAt }
      };
    }));

  const BATCH_SIZE = 400;
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = db.batch();
    ops.slice(i, i + BATCH_SIZE).forEach(function (op) {
      if (op.type === 'delete') batch.delete(op.ref); else batch.set(op.ref, op.fields);
    });
    await batch.commit();
  }
}

/** 把產業對照表同步進 BigQuery `industry_map` 表，給還沒遷移的
 *  FactorRegression.gs 因子特徵 view JOIN 用（見 `lib/bigquery.js
 *  buildSyncIndustryMapSql_` 的說明）。失敗不影響已經寫進 Firestore 的
 *  結果——呼叫端 `doRefreshIndustryMap_` 把這一步的失敗單獨記在
 *  `bqSync.error`，不會讓整次刷新被判定失敗。 */
async function syncIndustryMapToBigQuery_(bigQueryConfig, rows) {
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const tableRef = bigquery.industryMapTableRef_(bigQueryConfig);
  await client.query({ query: bigquery.buildSyncIndustryMapSql_(tableRef, rows) });
  return { rowCount: rows.length };
}

/** 實際做事的地方：抓資料＋品質驗證＋寫入 Firestore＋BigQuery 同步＋涵蓋率
 *  比對。任何品質檢查沒過就整批放棄、不覆蓋既有資料——跟 apps-script 版
 *  `doRefreshIndustryMap_` 同一個「寧可保留舊資料」的原則。由
 *  `exports.runIndustryMapRefresh` 呼叫。 */
async function doRefreshIndustryMap_(bigQueryConfig) {
  const twseRows = await fetchTwseListedIndustryMap_();
  let tpexResult = { rows: [], warning: null };
  try {
    tpexResult = fetchTpexListedIndustryMap_();
  } catch (e) {
    tpexResult = { rows: [], warning: String(e.message || e) };
  }

  const allRows = twseRows.concat(tpexResult.rows || []);
  const issues = industryMapLib.validateIndustryMapRows_(allRows);
  if (issues.length > 0) {
    throw new Error('產業對照表資料品質檢查沒通過，已放棄這次更新（不影響既有資料）：' + issues.join('；'));
  }

  await writeIndustryMapToFirestore_(allRows);

  let coverage = { checked: false, error: '沒有設定 BigQuery，無法比對涵蓋率。' };
  const bqSync = { attempted: false, ok: false, error: null };
  if (bigQueryConfig && bigQueryConfig.projectId) {
    try {
      const trackedCodes = await fetchTrackedCodesForCoverage_(bigQueryConfig);
      coverage = industryMapLib.computeIndustryMapCoverage_(allRows, trackedCodes);
    } catch (e) {
      coverage = { checked: false, error: String(e.message || e) };
    }

    bqSync.attempted = true;
    try {
      const bqResult = await syncIndustryMapToBigQuery_(
        bigQueryConfig, allRows.map(function (r) { return { code: r.code, industry: r.industry }; })
      );
      bqSync.ok = true;
      bqSync.rowCount = bqResult.rowCount;
    } catch (e) {
      bqSync.error = String(e.message || e);
    }
  }

  const untranslated = industryMapLib.findUntranslatedIndustryCodes_(allRows);

  return {
    totalCount: allRows.length,
    twseCount: twseRows.length,
    tpexCount: (tpexResult.rows || []).length,
    tpexWarning: tpexResult.warning || null,
    coverage: coverage,
    untranslated: untranslated,
    bqSync: bqSync
  };
}

exports.runIndustryMapRefresh = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const startTime = Date.now();
  await writeJobStatus_('industryMapRefresh', { status: 'running', startedAt: startTime, error: null });
  try {
    const appConfig = await fetchAppConfig_();
    const summary = await doRefreshIndustryMap_(appConfig.bigQuery || {});
    const durationMs = Date.now() - startTime;
    const msg = '共 ' + summary.totalCount + ' 筆（上市 ' + summary.twseCount + '，上櫃 ' + summary.tpexCount + '）' +
      (summary.coverage.checked ? '，目前追蹤股票涵蓋率 ' + summary.coverage.coveragePct + '%' : '') +
      (summary.untranslated.count ? '，' + summary.untranslated.count + ' 筆產業代碼沒對到文字名稱' : '') +
      (summary.bqSync.attempted ? '，BigQuery 同步：' + (summary.bqSync.ok ? '成功' : '失敗（' + summary.bqSync.error + '）') : '') +
      (summary.tpexWarning ? '；' + summary.tpexWarning : '');
    await logRun_('產業對照表', '成功', msg, durationMs);
    await writeJobStatus_('industryMapRefresh', { status: 'succeeded', finishedAt: Date.now(), result: summary, error: null });
    return summary;
  } catch (e) {
    await logRun_('產業對照表', '失敗', String(e.message || e), Date.now() - startTime);
    await writeJobStatus_('industryMapRefresh', { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
    throw new HttpsError('internal', String(e.message || e));
  }
});

/** Admin 頁面「產業對照表」卡片用：隨機抽 10 筆目前存的對照表資料，給人眼
 *  抽查用（見 `industryMapLib.pickRandomSample_` 的說明）。純讀取，不會
 *  觸發任何抓取，跟 `exports.runIndustryMapRefresh` 是分開的兩個按鈕。 */
exports.getIndustryMapSample = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const snap = await admin.firestore().collection('industry_map').get();
  const rows = snap.docs.map(function (d) { return d.data(); });
  return { totalCount: rows.length, sample: industryMapLib.pickRandomSample_(rows, 10) };
});

/**
 * 2026-10-08 新增：因子相關性掃描，從 apps-script/src/FactorScan.gs 搬過來
 * （純函式邏輯見 lib/factorScan.js）——跟 `FactorRegression.gs`（BigQuery ML
 * LASSO 迴歸，還沒遷移）是兩個獨立的研究工具：這支純粹是 JS 算幾個候選因子
 * 跟「未來 5 日報酬率」的 Pearson 相關係數，不碰 BigQuery ML，拿現有的
 * `fetchHistoryRangeRows_`（backtest 那邊已經建好）就能重用，不需要新的
 * BigQuery 查詢邏輯。`schema.md` 原本把這個功能跟 `FactorRegression.gs`
 * 綁在同一個「Phase 3」階段，這裡先把這支獨立搬完——規模小（116 行，全
 * 純函式）、風險低（重用的是已經驗證過的 computeFactors_ 系列工具函式），
 * `FactorRegression.gs` 本身（726 行、BQML 訓練）留給下一階段。
 *
 * `startStr`／`endStr` 都可以留空，代表讀「全部」History 資料——跟
 * apps-script 版一致，但 Firebase 版沒有 Apps Script 6 分鐘執行上限，可以
 * 一次同步跑完；`BACKTEST_RUNTIME_OPTS_`（2GiB／540s）沿用給這支用，因為
 * 「全部歷史資料」理論上可能比回測固定的區間還大，這個開發環境沒辦法
 * 實際量測，先保守沿用已經在用的較高規格。
 */
async function runFactorScanCore_(bigQueryConfig, startStr, endStr) {
  const rawRows = await fetchHistoryRangeRows_(bigQueryConfig, startStr || null, endStr || null);
  if (rawRows.length === 0) return { sampleSize: 0, correlations: [], warning: '這段期間沒有 History 資料，請先確認資料已抓取。' };
  const computed = factorScanLib.computeFactorScanFields_(rawRows);
  return factorScanLib.computeFactorCorrelations_(computed);
}

exports.runFactorCorrelationScan = onCall(BACKTEST_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const startTime = Date.now();
  await writeJobStatus_('factorScan', {
    status: 'running', startedAt: startTime,
    params: { startDate: data.startDate || null, endDate: data.endDate || null },
    error: null
  });
  try {
    const appConfig = await fetchAppConfig_();
    if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) {
      throw new HttpsError('failed-precondition', 'config/app 沒有設定 BigQuery 專案 ID。');
    }
    const result = await runFactorScanCore_(appConfig.bigQuery, data.startDate, data.endDate);
    const durationMs = Date.now() - startTime;
    const summaryMsg = '樣本數 ' + result.sampleSize +
      (result.correlations.length ? '，' + result.correlations.map(function (c) {
        return c.factor + '=' + (c.correlation === null ? 'N/A' : c.correlation.toFixed(3));
      }).join('、') : '') + (result.warning ? '（' + result.warning + '）' : '');
    await logRun_('因子掃描', '成功', summaryMsg, durationMs);
    await writeJobStatus_('factorScan', { status: 'succeeded', finishedAt: Date.now(), result: result, error: null });
    return result;
  } catch (e) {
    await logRun_('因子掃描', '失敗', String(e.message || e), Date.now() - startTime);
    await writeJobStatus_('factorScan', { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
    throw e;
  }
});

/**
 * 2026-10-08 新增：因子迴歸模型訓練，從 apps-script/src/FactorRegression.gs
 * 搬過來（純函式 SQL 組字串見 lib/factorRegression.js，跟原始 apps-script
 * 檔案逐函式 byte-for-byte 比對過，見 test/parity.test.js Parity 6）。對應
 * apps-script 版 `runFactorRegression()`——對兩個 label（return1m／
 * downsideResistance）各訓練一次 BigQuery ML LASSO 模型，結果各寫一筆到
 * Firestore `factor_model_history`（跟 Phase 2 一次性遷移過去的舊資料
 * 共用同一個 collection／doc ID 規則，見
 * `lib/factorRegression.js buildFactorModelDocId_` 的說明）。
 *
 * 搬完這支，`factor_model_rank`／`hybrid` 這兩個戰報篩選策略（跟回測）
 * 才真正有辦法訓練出一版模型可以套用——在這之前只能一直回報「需要先
 * 套用模型」。
 *
 * 跟 apps-script 版的架構差異：
 * - **沒有搬背景 job 狀態機**——同一套理由，Cloud Functions 一次同步
 *   呼叫就能跑完，不需要 6 分鐘上限逼出來的分批機制，改用
 *   `jobs/factorRegression` 搭配前端 `onSnapshot`。
 * - **`ensureIndustryMapSyncedToBigQuery_` 檢查的是 Firestore
 *   `jobs/industryMapRefresh` 的最近一次結果，不是 Script Properties**
 *   ——因子特徵 view 裡 36 個「產業資金流向」候選因子都要 JOIN BigQuery
 *   的 `industry_map` 表才有意義（見「策略研究（二）」那節），這裡沿用
 *   apps-script 版 `ensureIndustryMapSyncedToBigQuery_` 同一個「自動
 *   檢核」邏輯：如果從來沒有成功同步過，先自動跑一次「重新整理產業
 *   對照表」，不用使用者自己記得要先手動點一次；已經成功同步過就直接
 *   跳過（公司產業分類幾乎不會變動，沒必要每次訓練都重抓）。這裡失敗
 *   不阻擋後續訓練繼續進行（吞掉錯誤），只是 industry_* 這組因子當下
 *   沒有真實資料可用（COALESCE 成 0.5，訓練還是能正常跑，只是這些
 *   因子暫時沒有訊號）——跟 apps-script 版的取捨完全一致。
 * - **`timestampSecondsTaipei_`**（`lib/utils.js` 新增）：因子迴歸結果
 *   的 Firestore 文件 ID 跟 Phase 2 遷移過去的舊資料共用同一套
 *   `buildFactorModelDocId_` 規則，必須用跟 apps-script 版
 *   `Utilities.formatDate(..., 'yyyy-MM-dd HH:mm:ss')` 完全一致的格式
 *   （含秒），不能沿用既有的 `timestampLabelTaipei_`（那支是給 run_log／
 *   AI 診斷用的「台股監控 ...」標籤格式，不含秒、有中文前綴）。
 */

/** 跟 apps-script 版 `ensureIndustryMapSyncedToBigQuery_` 同一個理由，
 *  見上方區塊的完整說明。 */
async function ensureIndustryMapSyncedToBigQuery_(bigQueryConfig) {
  const snap = await admin.firestore().collection('jobs').doc('industryMapRefresh').get();
  const lastResult = snap.exists ? snap.data() : null;
  if (lastResult && lastResult.result && lastResult.result.bqSync && lastResult.result.bqSync.ok) return;
  try {
    await doRefreshIndustryMap_(bigQueryConfig);
  } catch (e) { /* 見上方區塊說明：這裡失敗不阻擋後續訓練繼續進行 */ }
}

/** 確保 BigQuery 的因子特徵 view（`factor_features`）存在且是最新定義——
 *  訓練前一定要先跑一次 `CREATE OR REPLACE VIEW`（每次都重建，不是只在
 *  第一次建立），因為 view 的定義本身可能隨著這支程式的部署而改變。 */
async function ensureFeatureView_(bigQueryConfig) {
  await ensureIndustryMapSyncedToBigQuery_(bigQueryConfig);
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const rawTableRef = bigquery.rawTableRef_(bigQueryConfig);
  const industryMapTableRef = bigquery.industryMapTableRef_(bigQueryConfig);
  const viewRef = bigquery.featureViewRef_(bigQueryConfig);
  await client.query({ query: factorRegressionLib.buildFeatureViewSql_(rawTableRef, industryMapTableRef, viewRef) });
}

/**
 * 2026-10-08 新增：余適安（余博）法人選股邏輯延伸的基本面因子（四率四升
 * ＋月營收連續成長）——全新邏輯，apps-script 版沒有對應程式碼（純函式
 * 邏輯見 `lib/financials.js`，SQL 組字串見 `lib/bigquery.js
 * buildSyncFinancialRatiosSql_`／`buildSyncFinancialRevenueSql_`／
 * `buildFundamentalFeatureViewSql_`）。
 *
 * **跟 `industry_map` 不同的資料累積方式**：TWSE 這三個 OpenAPI 端點
 * （月營收／綜合損益表／資產負債表）回傳的是「目前最新一期」的全市場
 * 快照，不是歷史歸檔（這個開發環境沒辦法連線確認，但官方「opendata」
 * 這類端點普遍是這個行為模式，比照保守假設處理）——每次「重新整理財報
 * 因子」抓到的都只有最新一期，要算「連續 N 期上升」就一定要跨多次執行
 * 累積歷史，不能像 `industry_map` 那樣每次整份覆蓋。所以 Firestore 這層
 * 用 `financials_quarterly/{code}_{period}`／`financials_monthly/{code}_{period}`
 * 累積寫入（`merge: true`，同一期重複抓到會更新但不會新增重複筆數），
 * 每次重新整理都讀回完整累積歷史重新計算連續上升期數（新進的這一期
 * 可能延續或打斷既有的連續紀錄，必須看完整歷史，不能只看這次新抓到的
 * 那一筆）。BigQuery 那一層才是整份覆蓋（`financial_ratios`／
 * `financial_revenue` 表，見 `buildSyncFinancialRatiosSql_` 的說明）——
 * Firestore 存「會一直累積變大的歷史」，BigQuery 存「目前累積到的完整
 * 結果快照」，兩層職責不同。
 */

/** 把一批財報列（`code`／`period` 都有）依代號分組、組內依 period 由舊
 *  到新排序——`computeFundamentalStreaks_`／`computeRevenueGrowthStreaks_`
 *  期待的輸入形狀（陣列的陣列）。 */
function groupAndSortFinancialRowsByCode_(rows) {
  const byCode = {};
  rows.forEach(function (r) {
    if (!byCode[r.code]) byCode[r.code] = [];
    byCode[r.code].push(r);
  });
  return Object.keys(byCode).map(function (code) {
    return byCode[code].sort(function (a, b) { return (a.period || '') < (b.period || '') ? -1 : 1; });
  });
}

/** 把一批財報列累積寫進 Firestore（`merge: true`，同一期重複抓到是
 *  更新不是新增，見上方區塊「跟 industry_map 不同的資料累積方式」的
 *  說明），文件 ID 是 `code_period`。跟 `writeIndustryMapToFirestore_`
 *  同一個批次寫入模式（400 筆一批），但不刪除任何既有文件——這裡是
 *  累積歷史，不是整份覆蓋。 */
async function upsertFinancialRowsToFirestore_(collectionName, rows) {
  const db = admin.firestore();
  const ref = db.collection(collectionName);
  const updatedAt = Date.now();
  const BATCH_SIZE = 400;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = db.batch();
    rows.slice(i, i + BATCH_SIZE).forEach(function (r) {
      const docId = r.code + '_' + r.period;
      batch.set(ref.doc(docId), Object.assign({}, r, { updatedAt: updatedAt }), { merge: true });
    });
    await batch.commit();
  }
}

async function fetchAllDocs_(collectionName) {
  const snap = await admin.firestore().collection(collectionName).get();
  return snap.docs.map(function (d) { return d.data(); });
}

/** 把算好連續上升期數的季報財務比率／月營收列同步進 BigQuery（整份
 *  覆蓋，見 `buildSyncFinancialRatiosSql_` 的說明）。不在這裡建
 *  `buildFundamentalFeatureViewSql_` 那層 view——刻意跟「寫資料」分開，
 *  見 `ensureFundamentalFeatureView_` 的說明。 */
async function syncFinancialsToBigQuery_(bigQueryConfig, quarterlyRows, monthlyRows) {
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const ratiosTableRef = bigquery.financialRatiosTableRef_(bigQueryConfig);
  const revenueTableRef = bigquery.financialRevenueTableRef_(bigQueryConfig);

  const ratioStatements = bigquery.buildSyncFinancialRatiosSql_(ratiosTableRef, quarterlyRows.map(function (r) {
    return {
      code: r.code, reportDate: r.period, grossMarginPct: r.grossMarginPct, operatingMarginPct: r.operatingMarginPct,
      netMarginPct: r.netMarginPct, roePct: r.roePct, grossMarginStreak: r.grossMarginStreak,
      operatingMarginStreak: r.operatingMarginStreak, netMarginStreak: r.netMarginStreak, roeStreak: r.roeStreak
    };
  }));
  for (const sql of ratioStatements) await client.query({ query: sql });

  const revenueStatements = bigquery.buildSyncFinancialRevenueSql_(revenueTableRef, monthlyRows.map(function (r) {
    return { code: r.code, reportDate: r.reportDate, revenueYoyPct: r.revenueYoyPct, revenueGrowthStreak: r.revenueGrowthStreak };
  }));
  for (const sql of revenueStatements) await client.query({ query: sql });
}

/** 實際做事的地方：抓 TWSE 三份官方資料＋解析＋驗證＋累積寫入
 *  Firestore＋讀回完整歷史重算連續上升期數＋同步進 BigQuery。任何品質
 *  檢查沒過就整批放棄這次更新（不影響既有累積資料）——跟
 *  `doRefreshIndustryMap_` 同一個「寧可保留舊資料」原則。由
 *  `exports.runFinancialsRefresh` 呼叫。 */
async function doRefreshFinancials_(bigQueryConfig) {
  const datasets = await fetchTwseOfficialFinancialsDatasets_();
  const revenueRaw = datasets[0].rows;
  const incomeRaw = datasets[1].rows;
  const balanceRaw = datasets[2].rows;

  // 2026-10-08 修正：parseMonthlyRevenueRows_ 現在自己會優先偵測官方
  // 「出表日期」欄位、抓不到才退回估算（見該函式的說明），這裡不用再
  // 另外 map 一次覆蓋——原本這裡不管有沒有偵測到官方欄位都強制用估算值
  // 覆蓋掉，是遷移過程中發現 data.gov.tw 鏡像站資料集範例確認這份報表
  // 其實有「出表日期」欄位之前的暫時寫法。
  const revenueRows = financialsLib.parseMonthlyRevenueRows_(revenueRaw);
  const incomeRows = financialsLib.parseIncomeStatementRows_(incomeRaw);
  const balanceRows = financialsLib.parseBalanceSheetRows_(balanceRaw);
  const quarterlyRows = financialsLib.joinIncomeAndEquity_(incomeRows, balanceRows);

  const issues = financialsLib.validateFinancialRows_(revenueRows, '月營收', 500)
    .concat(financialsLib.validateFinancialRows_(quarterlyRows, '季報財務比率', 500));
  if (issues.length > 0) {
    throw new Error('財報資料品質檢查沒通過，已放棄這次更新（不影響既有累積資料）：' + issues.join('；'));
  }

  await upsertFinancialRowsToFirestore_('financials_monthly', revenueRows);
  await upsertFinancialRowsToFirestore_('financials_quarterly', quarterlyRows);

  const allMonthly = await fetchAllDocs_('financials_monthly');
  const allQuarterly = await fetchAllDocs_('financials_quarterly');
  const streakedMonthly = financialsLib.computeRevenueGrowthStreaks_(groupAndSortFinancialRowsByCode_(allMonthly));
  const streakedQuarterly = financialsLib.computeFundamentalStreaks_(groupAndSortFinancialRowsByCode_(allQuarterly));

  const bqSync = { attempted: false, ok: false, error: null };
  if (bigQueryConfig && bigQueryConfig.projectId) {
    bqSync.attempted = true;
    try {
      await syncFinancialsToBigQuery_(bigQueryConfig, streakedQuarterly, streakedMonthly);
      bqSync.ok = true;
    } catch (e) {
      bqSync.error = String(e.message || e);
    }
  }

  return {
    monthlyCount: revenueRows.length,
    quarterlyCount: quarterlyRows.length,
    monthlyTotalAccumulated: allMonthly.length,
    quarterlyTotalAccumulated: allQuarterly.length,
    bqSync: bqSync
  };
}

/** 跟 `ensureIndustryMapSyncedToBigQuery_` 同一個「自動檢核」模式：訓練
 *  前如果 `financial_ratios`／`financial_revenue` 從來沒有成功同步過，
 *  先自動跑一次「重新整理財報因子」，不用使用者自己記得要先手動點一次；
 *  已經成功同步過就跳過（財報不是每天都更新，沒必要每次訓練都重抓）。
 *  失敗不阻擋後續訓練（吞掉錯誤）——基本面因子當下沒有真實資料可用，
 *  `buildFundamentalFeatureViewSql_` LEFT JOIN 不到資料時那幾個新欄位
 *  本來就會是 NULL，不影響其他既有候選因子正常訓練。 */
async function ensureFinancialsSyncedToBigQuery_(bigQueryConfig) {
  const snap = await admin.firestore().collection('jobs').doc('financialsRefresh').get();
  const lastResult = snap.exists ? snap.data() : null;
  if (lastResult && lastResult.result && lastResult.result.bqSync && lastResult.result.bqSync.ok) return;
  try {
    await doRefreshFinancials_(bigQueryConfig);
  } catch (e) { /* 見上方說明：這裡失敗不阻擋後續訓練繼續進行 */ }
}

/** 在 `factor_features`（apps-script parity 驗證過、原封不動不碰）之上
 *  疊一層財報基本面因子，建立/更新 `factor_features_fundamental` view
 *  ——訓練（`runFactorRegressionCore_`）改成對這個疊加後的 view 做
 *  snapshot，不是原本的 `factor_features`，見
 *  `lib/bigquery.js buildFundamentalFeatureViewSql_` 完整的設計說明
 *  （為什麼不直接改 `buildFeatureViewSql_` 本身）。 */
async function ensureFundamentalFeatureView_(bigQueryConfig) {
  await ensureFinancialsSyncedToBigQuery_(bigQueryConfig);
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const baseViewRef = bigquery.featureViewRef_(bigQueryConfig);
  const ratiosTableRef = bigquery.financialRatiosTableRef_(bigQueryConfig);
  const revenueTableRef = bigquery.financialRevenueTableRef_(bigQueryConfig);
  const outputViewRef = bigquery.fundamentalFeatureViewRef_(bigQueryConfig);
  await client.query({ query: bigquery.buildFundamentalFeatureViewSql_(baseViewRef, ratiosTableRef, revenueTableRef, outputViewRef) });
}

exports.runFinancialsRefresh = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const startTime = Date.now();
  await writeJobStatus_('financialsRefresh', { status: 'running', startedAt: startTime, error: null });
  try {
    const appConfig = await fetchAppConfig_();
    const summary = await doRefreshFinancials_(appConfig.bigQuery || {});
    const durationMs = Date.now() - startTime;
    const msg = '本次新抓 ' + summary.monthlyCount + ' 筆月營收、' + summary.quarterlyCount + ' 筆季報財務比率' +
      '（累積總筆數：月營收 ' + summary.monthlyTotalAccumulated + '、季報 ' + summary.quarterlyTotalAccumulated + '）' +
      (summary.bqSync.attempted ? '，BigQuery 同步：' + (summary.bqSync.ok ? '成功' : '失敗（' + summary.bqSync.error + '）') : '');
    await logRun_('財報因子', '成功', msg, durationMs);
    await writeJobStatus_('financialsRefresh', { status: 'succeeded', finishedAt: Date.now(), result: summary, error: null });
    return summary;
  } catch (e) {
    await logRun_('財報因子', '失敗', String(e.message || e), Date.now() - startTime);
    await writeJobStatus_('financialsRefresh', { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
    throw new HttpsError('internal', String(e.message || e));
  }
});

/**
 * Admin 頁面「財報因子資料完整性月曆」用：這個月月營收／季報財務比率
 * 各自涵蓋了多少檔股票——跟 `getHistoryDailyCounts`（股價資料月曆）
 * 同一個用途，但這裡直接查 Firestore（資料量级是「公司數 × 期數」，
 * 遠小於股價資料的「天數 × 股票數」，不需要 BigQuery）。月營收用
 * `period`（'yyyy-MM'）分組，季報財務比率用 `fiscalPeriod`（'yyyy-Qn'，
 * 財報所屬季度，不是公告日——見 `lib/financials.js
 * parseIncomeStatementRows_` 的說明，公告日拿來分組會因為同一季不同
 * 公司公告日期分散而看不出「這一季涵蓋了多少公司」）。
 *
 * 2026-10-08 補充：commit d6d94e8 第一次部署這支的 `bySource` 邏輯時，
 * 剛好撞上 Cloud Run CPU 配額瞬間尖峰，這支本身健康檢查失敗；用
 * `rerun_failed_jobs` 重跑整個 deploy job 後，Firebase CLI 卻把「這次
 * 要部署的原始碼打包雜湊」跟「第一次嘗試時已經上傳的雜湊」拿來比對，
 * 覺得「內容沒變」就直接跳過這支沒有真的重新部署（log 會看到
 * `functions[getFinancialsCoverage] Skipped (No changes detected)`，
 * 不是 `Successful update operation`）——結果線上這支一直停留在沒有
 * `bySource` 的舊版，使用者實測看不到來源標示。這段註解本身就是刻意
 * 用來改變這支函式的原始碼雜湊，逼 Firebase CLI 這次不能再跳過部署；
 * 日後如果又遇到「rerun 之後 conclusion: success，但功能看起來沒生效」
 * 的狀況，先去 log 裡找這支函式名稱後面是不是印 `Skipped (No changes
 * detected)`，不是只看整個 workflow run 的 conclusion。
 *
 * 2026-10-08 再次補充：又撞到同樣的狀況（這次是跟基本面因子接進即時
 * 預測分數那個 commit 一起卡住），再改一次原始碼重試。
 */
exports.getFinancialsCoverage = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const [monthlyDocs, quarterlyDocs] = await Promise.all([
    fetchAllDocs_('financials_monthly'),
    fetchAllDocs_('financials_quarterly')
  ]);

  // 2026-10-08 新增：使用者實測回補之後看著月曆問「這個月的資料來源是
  // 哪裡」——除了總檔數，每個月額外拆出 `source` 分組的檔數
  // （openapi／mopsBackfill 各幾檔），前端月曆用這個組出「OpenAPI:X／
  // MOPS回補:Y」的細項顯示，不用再靠下面「隨機抽樣」反推猜測來源。
  const monthlyByPeriod = {};
  monthlyDocs.forEach(function (d) {
    if (!monthlyByPeriod[d.period]) monthlyByPeriod[d.period] = { codes: new Set(), bySource: {} };
    monthlyByPeriod[d.period].codes.add(d.code);
    const src = d.source || '未知';
    monthlyByPeriod[d.period].bySource[src] = (monthlyByPeriod[d.period].bySource[src] || 0) + 1;
  });
  const quarterlyByPeriod = {};
  let fiscalPeriodIsEstimated = false;
  quarterlyDocs.forEach(function (d) {
    const key = d.fiscalPeriod || '未知';
    if (d.fiscalPeriodIsEstimated) fiscalPeriodIsEstimated = true;
    if (!quarterlyByPeriod[key]) quarterlyByPeriod[key] = new Set();
    quarterlyByPeriod[key].add(d.code);
  });

  return {
    monthly: Object.keys(monthlyByPeriod).sort().map(function (p) {
      return { period: p, stockCount: monthlyByPeriod[p].codes.size, bySource: monthlyByPeriod[p].bySource };
    }),
    quarterly: Object.keys(quarterlyByPeriod).sort().map(function (p) { return { period: p, stockCount: quarterlyByPeriod[p].size }; }),
    fiscalPeriodIsEstimated: fiscalPeriodIsEstimated
  };
});

/** 財報因子的「隨機抽樣」人眼抽查——跟 `getIndustryMapSample` 同一個
 *  用途跟模式，分別對月營收／季報財務比率各抽 10 筆。 */
exports.getFinancialsSample = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const [monthlyDocs, quarterlyDocs] = await Promise.all([
    fetchAllDocs_('financials_monthly'),
    fetchAllDocs_('financials_quarterly')
  ]);
  return {
    monthlyTotalCount: monthlyDocs.length,
    quarterlyTotalCount: quarterlyDocs.length,
    monthlySample: industryMapLib.pickRandomSample_(monthlyDocs, 10),
    quarterlySample: industryMapLib.pickRandomSample_(quarterlyDocs, 10)
  };
});

/** 對單一 label 跑一次訓練＋評估＋取權重，對應 apps-script 版
 *  `trainFactorModel_`。sourceRef 是這次訓練實際要讀的來源（同一次執行
 *  對兩個 label 共用同一份快照表，見 `buildFeatureSnapshotSql_` 的
 *  說明，避免 view 的特徵工程 SQL 被重跑兩次）。 */
async function trainFactorModel_(bigQueryConfig, labelDef, l1Reg, sourceRef) {
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const modelRef = bigQueryConfig.projectId + '.' + bigQueryConfig.dataset + '.' + factorRegressionLib.factorModelName_(labelDef.key);

  await client.query({ query: factorRegressionLib.buildTrainModelSql_(modelRef, sourceRef, labelDef.column, config.FACTOR_CANDIDATE_COLUMNS, l1Reg) });
  const [evalRows] = await client.query({ query: factorRegressionLib.buildEvaluateSql_(modelRef) });
  const [weightRows] = await client.query({ query: factorRegressionLib.buildWeightsSql_(modelRef) });
  const weights = factorRegressionLib.summarizeWeights_(weightRows);
  const r2 = evalRows.length > 0 ? parseFloat(evalRows[0].r2_score) : null;

  return {
    labelKey: labelDef.key,
    labelName: labelDef.name,
    r2: r2,
    weights: weights,
    featureColumns: config.FACTOR_CANDIDATE_COLUMNS,
    l1Reg: l1Reg
  };
}

/** 把一次訓練結果（成功或失敗）寫進 Firestore `factor_model_history`，
 *  跟 Phase 2 遷移過去的舊資料共用同一套 doc ID 規則（見
 *  `lib/factorRegression.js buildFactorModelDocId_`）。失敗的那筆沒有
 *  weights/r2，`status` 記錯誤訊息，成功的記「完成」——跟 apps-script 版
 *  `runFactorRegression` 的 try/catch 行為一致：某一個 label 失敗不影響
 *  另一個 label 正常寫入。`applied` 固定是 false（新訓練出來的版本預設
 *  不自動套用，要使用者自己到前端按「套用」，見
 *  `exports.applyFactorModel`）。 */
async function writeFactorModelHistory_(timestamp, result) {
  const docId = factorRegressionLib.buildFactorModelDocId_(timestamp, result.labelKey);
  await admin.firestore().collection('factor_model_history').doc(docId).set({
    timestamp: timestamp,
    labelKey: result.labelKey,
    l1Reg: result.l1Reg != null ? result.l1Reg : null,
    featureColumns: result.featureColumns || [],
    trainRows: null, // apps-script 版本身也沒有真的填這欄，見 trainFactorModel_ 的回傳值，照原樣保留
    r2: result.error ? null : result.r2,
    weights: result.error ? {} : result.weights,
    status: result.error ? ('失敗：' + result.error) : '完成',
    applied: false
  });
}

/** 主流程：對兩個 label 各跑一次訓練，結果各寫一筆到
 *  `factor_model_history`——對應 apps-script 版 `runFactorRegression()`。 */
async function runFactorRegressionCore_(bigQueryConfig, l1Reg) {
  await ensureFeatureView_(bigQueryConfig);
  await ensureFundamentalFeatureView_(bigQueryConfig);

  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  // 2026-10-08 改成對疊加了財報基本面因子的 view 做 snapshot／訓練，不是
  // 原本的 factor_features——見 ensureFundamentalFeatureView_ 的說明，
  // factor_features_fundamental 包含 factor_features 原本的全部 48 個
  // 欄位＋10 個新的 fundamental_* 欄位，buildFeatureSnapshotSql_ 本身
  // 不用改，只是換了要凍結快照的來源 view。
  const viewRef = bigquery.fundamentalFeatureViewRef_(bigQueryConfig);
  const snapshotRef = bigquery.featureSnapshotTableRef_(bigQueryConfig);
  await client.query({ query: factorRegressionLib.buildFeatureSnapshotSql_(viewRef, snapshotRef) });

  const reg = l1Reg || config.FACTOR_MODEL_L1_REG_DEFAULT;
  const timestamp = utilsLib.timestampSecondsTaipei_();
  const results = [];

  for (const key of Object.keys(config.FACTOR_LABELS)) {
    const labelDef = config.FACTOR_LABELS[key];
    try {
      const result = await trainFactorModel_(bigQueryConfig, labelDef, reg, snapshotRef);
      await writeFactorModelHistory_(timestamp, result);
      results.push(result);
    } catch (e) {
      const errResult = { labelKey: labelDef.key, labelName: labelDef.name, error: String(e.message || e) };
      await writeFactorModelHistory_(timestamp, errResult);
      results.push(errResult);
    }
  }

  return { timestamp: timestamp, results: results };
}

/**
 * `timeoutSeconds: 1800`／`memory: '2GiB'`：BQML 訓練（`CREATE MODEL` +
 * `ML.EVALUATE` + `ML.WEIGHTS`，對兩個 label 各跑一輪，`max_iterations`
 * 設到 BQML 允許的上限 49，見 `lib/factorRegression.js
 * buildTrainModelSql_` 的說明）是這整個 App 最重的 BigQuery 操作，比
 * 回測／每日戰報都重——這個開發環境沒辦法連上真正的 BigQuery 實際量測
 * 一次訓練要多久，`runHistoryBackfill` 的 1800s 是目前這個 App 用過最高
 * 的上限，保守沿用同一個值；真的在正式環境遇到逾時/OOM 再依實測調整。
 */
var FACTOR_REGRESSION_RUNTIME_OPTS_ = Object.assign({}, RUNTIME_OPTS_, { memory: '2GiB', timeoutSeconds: 1800 });

exports.runFactorRegression = onCall(FACTOR_REGRESSION_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const l1Reg = data.l1Reg != null ? utilsLib.toNumber(data.l1Reg) : null;
  const startTime = Date.now();
  await writeJobStatus_('factorRegression', { status: 'running', startedAt: startTime, params: { l1Reg: l1Reg }, error: null });
  try {
    const appConfig = await fetchAppConfig_();
    if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) {
      throw new HttpsError('failed-precondition', 'config/app 沒有設定 BigQuery 專案 ID。');
    }
    const result = await runFactorRegressionCore_(appConfig.bigQuery, l1Reg);
    const durationMs = Date.now() - startTime;
    const summaryMsg = result.results.map(function (r) {
      return r.labelName + (r.error ? '：失敗（' + r.error + '）' : '：R²=' + (r.r2 == null ? 'N/A' : r.r2.toFixed(4)));
    }).join('、');
    const okCount = result.results.filter(function (r) { return !r.error; }).length;
    await logRun_('因子迴歸', okCount === result.results.length ? '成功' : '部分失敗', summaryMsg, durationMs);
    await writeJobStatus_('factorRegression', { status: 'succeeded', finishedAt: Date.now(), result: result, error: null });
    return result;
  } catch (e) {
    await logRun_('因子迴歸', '失敗', String(e.message || e), Date.now() - startTime);
    await writeJobStatus_('factorRegression', { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
    throw e;
  }
});

/**
 * data: {timestamp}。把某一次「執行因子迴歸」（timestamp）產生的所有
 * label 一起標記為「目前套用版本」，同時清掉其他所有版本（不管哪個
 * label）的套用標記——對應 apps-script 版 `applyFactorModel`。套用刻意
 * 做成「整個版本」等級的動作，不是兩個 label 各自獨立套用：原本可以
 * 分開套用會導致「目前生效的到底是哪一版」沒有單一答案（例如 1個月報酬
 * 用 A 版、抗跌力卻套用 B 版），使用者在畫面上完全看不出這種不一致。
 */
exports.applyFactorModel = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const timestamp = request.data && request.data.timestamp;
  if (!timestamp) throw new HttpsError('invalid-argument', '缺少 timestamp');

  const db = admin.firestore();
  const snap = await db.collection('factor_model_history').get();
  if (snap.empty) throw new HttpsError('not-found', '目前沒有任何因子迴歸訓練紀錄');

  const batch = db.batch();
  let matchedAny = false;
  snap.docs.forEach(function (doc) {
    const applied = doc.data().timestamp === timestamp;
    if (applied) matchedAny = true;
    batch.update(doc.ref, { applied: applied });
  });
  if (!matchedAny) throw new HttpsError('not-found', '找不到執行時間是 ' + timestamp + ' 的訓練紀錄');
  await batch.commit();
  return { ok: true };
});

/**
 * `generateDailyReport`（onRequest，方便部署後用 curl 直接驗證）／
 * `exports.runManualReportRecompute`（onCall，2026-10-07 新增，給 Admin
 * 頁面「手動重新計算戰報」按鈕用——使用者發現原本完全沒有這顆按鈕，只有
 * `generateDailyReport` 這個只能用 curl 打的 HTTP endpoint，前端沒有任何
 * 地方可以觸發）共用的核心：只做「重新計算戰報」這一步，不碰補抓資料／
 * AI 診斷——對應 apps-script 版「重新計算戰報」這顆獨立按鈕（只跑其中一
 * 步，不是跑完整排程），跟上面 `runFullSchedulePipeline_`／
 * `runFullScheduleNow`（三步都跑）是兩個不同粒度的手動觸發，使用者可以
 * 選只要哪一種。
 *
 * 用 `jobs/reportRecompute` 追蹤狀態，跟 `jobs/historyBackfill`／
 * `jobs/fullSchedule` 同一個模式——2026-10-07 使用者直接點名：這顆按鈕
 * 原本只有本地 `ref` 狀態，沒有跟「補抓區間」「執行完整排程」一樣接上
 * `jobs/{jobKey}`，畫面切走一樣會「忘記」還在計算中，要求所有手動操作
 * 都要有一致的體驗，不是只有部分操作做了這個保護。這支雖然通常幾秒內
 * 就會完成（不碰 TWSE／AI），風險比補抓區間低很多，但為了一致性還是
 * 套用同一套模式，不留這個特例。 */
async function runManualReportRecomputeCore_() {
  const startTime = Date.now();
  await writeJobStatus_('reportRecompute', { status: 'running', startedAt: startTime, error: null });
  try {
    const result = await runDailyAnalysis_();
    await logRun_(
      '手動重新計算戰報',
      result.strategyError ? '失敗' : '成功',
      result.strategyError || (result.latestDate ? ('戰報日期 ' + result.latestDate + '，' + result.reportDocs.length + ' 檔訊號') : '沒有可用的歷史資料'),
      Date.now() - startTime
    );
    await writeJobStatus_('reportRecompute', {
      status: result.strategyError ? 'failed' : 'succeeded',
      finishedAt: Date.now(),
      result: {
        latestDate: result.latestDate || null,
        reportCount: result.reportDocs ? result.reportDocs.length : 0
      },
      error: result.strategyError || null
    });
    return result;
  } catch (e) {
    await logRun_('手動重新計算戰報', '失敗', String(e.message || e), Date.now() - startTime);
    await writeJobStatus_('reportRecompute', { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
    throw e;
  }
}

exports.generateDailyReport = onRequest(RUNTIME_OPTS_, async function (req, res) {
  try {
    const result = await runManualReportRecomputeCore_();
    res.json({
      ok: true,
      latestDate: result.latestDate,
      reportCount: result.reportDocs.length,
      screeningStrategy: result.screeningStrategy,
      strategyError: result.strategyError || null,
      diagnostics: result.diagnostics
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

exports.runManualReportRecompute = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const result = await runManualReportRecomputeCore_();
  return {
    latestDate: result.latestDate,
    reportCount: result.reportDocs.length,
    screeningStrategy: result.screeningStrategy,
    strategyError: result.strategyError || null
  };
});

/** data: {date?}。手動抓取單一天的股價資料並寫進 BigQuery，不帶 date 時抓
 *  今天（台北時間）——對應 apps-script 版「立即更新今日資料」按鈕
 *  （`runManualFetchToday`）。回傳這一天的抓取結果，方便 Admin 頁面顯示／
 *  部署後用 curl 直接驗證有沒有接線成功。 */
exports.runManualHistoryFetch = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const dateStr = data.date || utilsLib.todayStrTaipei_();
  const appConfig = await fetchAppConfig_();
  if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) {
    throw new HttpsError('failed-precondition', 'config/app 沒有設定 BigQuery 專案 ID。');
  }
  const startTime = Date.now();
  const result = await fetchOneDayAndWrite_(appConfig.bigQuery, dateStr);
  await logRun_(
    '手動抓取',
    result.kind === 'succeeded' ? '成功' : '失敗',
    dateStr + '：' + (result.kind === 'succeeded' ? '成功寫入 ' + result.rowCount + ' 檔股票' : result.error),
    Date.now() - startTime
  );
  if (result.kind === 'failed') throw new HttpsError('internal', result.error);
  return result;
});

/**
 * data: {startDate, endDate}（皆為 'yyyy-MM-dd'，含頭尾）。手動補抓一段區間
 * 的股價資料——對應 apps-script 版「資料總覽」頁面的「重新抓取/合併此區間」
 * 背景 job（`startBackfillJob`），差別是這裡同步跑完才回傳，不是排一個背景
 * job 輪詢進度：Cloud Functions 沒有 Apps Script 6 分鐘的硬性執行上限，不需要
 * 那套跨次執行續跑的機制（見本檔案「每日股價資料抓取」那段開頭的完整說明）。
 *
 * 區間長度上限 `BACKFILL_MAX_RANGE_DAYS`——不是 `HISTORY_FETCH_MAX_CATCHUP_DAYS`
 * 那個給「每日自動補抓」用的保守上限，這支是使用者明確要補一段區間時用的，
 * 給更寬裕的額度，但還是要有上限：避免使用者不小心填了超大區間（例如忘記
 * 填年份變成補好幾年），單次呼叫跑太久而撞上這支函式自己宣告的逾時，真的
 * 要補更大的區間，分批呼叫幾次即可（每次呼叫都是獨立的，不會互相干擾，
 * 跟 apps-script 版「重複呼叫同一天會先刪除再寫入」的 idempotent 設計一致）。
 *
 * **2026-10-07 修正**：原本 `timeoutSeconds: 540`，使用者實際補一個 13
 * 個日曆天（跳過週六日後約 9~10 個交易日）的區間就整個逾時被平台強制
 * 中止——TWSE 三個端點依序抓、每天抓完再寫 BigQuery（現在還會依大小切成
 * 多個 chunk，見 `chunkRowsBySize_`），9~10 天疊起來遠遠超過 540 秒。
 * 更嚴重的是：平台強制中止（逾時被砍掉）**不會**走到這支函式自己的
 * try/catch，`writeJobStatus_` 的 `'failed'` 分支永遠不會被執行到，
 * `jobs/historyBackfill` 就這樣卡在 `'running'` 回不去，使用者也沒辦法
 * 開始下一次補抓（見 `AdminView.vue` 的對應修正：不再用 job 狀態硬擋這顆
 * 按鈕）。改成 `timeoutSeconds: 1800`（30 分鐘，callable function 的
 * 逾時上限是 3600 秒）給更充裕的餘裕，降低再次撞到這個情況的機率，但不
 * 是保證不會發生——真的撞到時，使用者現在至少還能按按鈕重新開始，不會
 * 被卡死。 */
var BACKFILL_MAX_RANGE_DAYS = 60;

exports.runHistoryBackfill = onCall(
  Object.assign({}, RUNTIME_OPTS_, { timeoutSeconds: 1800 }),
  async function (request) {
    assertOwnerAuth_(request);
    const data = request.data || {};
    if (!data.startDate || !data.endDate) {
      throw new HttpsError('invalid-argument', '請提供 startDate／endDate（yyyy-MM-dd）。');
    }
    const appConfig = await fetchAppConfig_();
    if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) {
      throw new HttpsError('failed-precondition', 'config/app 沒有設定 BigQuery 專案 ID。');
    }

    const dates = scheduleLib.buildCatchupDateList_(data.startDate, data.endDate, {
      skipWeekends: !!data.skipWeekends,
      maxDays: BACKFILL_MAX_RANGE_DAYS
    });
    if (dates.length === 0) {
      throw new HttpsError('invalid-argument', '這個區間沒有任何要補抓的日期（確認 startDate 不晚於 endDate）。');
    }

    const startTime = Date.now();
    await writeJobStatus_('historyBackfill', {
      status: 'running',
      startedAt: startTime,
      params: { startDate: data.startDate, endDate: data.endDate, skipWeekends: !!data.skipWeekends },
      result: null,
      error: null
    });

    try {
      const succeeded = [];
      const failed = [];
      for (const dateStr of dates) {
        const result = await fetchOneDayAndWrite_(appConfig.bigQuery, dateStr);
        if (result.kind === 'succeeded') succeeded.push(result.date); else failed.push(result);
      }
      const resultPayload = {
        attempted: dates,
        succeeded: succeeded,
        failed: failed,
        truncated: dates.length >= BACKFILL_MAX_RANGE_DAYS
      };
      await logRun_(
        '補抓區間',
        failed.length ? '部分成功' : '成功',
        data.startDate + ' ~ ' + data.endDate + '：成功 ' + succeeded.length + ' 天' + (failed.length ? '，失敗 ' + failed.length + ' 天' : ''),
        Date.now() - startTime
      );
      await writeJobStatus_('historyBackfill', {
        status: failed.length ? 'partial' : 'succeeded',
        finishedAt: Date.now(),
        result: resultPayload,
        error: null
      });
      return resultPayload;
    } catch (e) {
      await logRun_('補抓區間', '失敗', String(e.message || e), Date.now() - startTime);
      await writeJobStatus_('historyBackfill', { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
      throw e;
    }
  }
);

/** 給 Admin 頁面「資料總覽」顯示：目前這個 App 實際在用的來源（依
 *  `config/app.bigQuery.sourceMode` 決定，見 `bigquery.sourceRefForRead_`）
 *  的日期範圍／交易日數／股票數／總列數——跟 apps-script 版 `getHistoryOverview`
 *  同一個用途，查的是「App 實際讀到的來源」而不是固定查 `history_raw`，
 *  這樣畫面上的數字才會跟戰報實際算出來的結果對得上。 */
exports.getHistoryOverview = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const appConfig = await fetchAppConfig_();
  if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) {
    throw new HttpsError('failed-precondition', 'config/app 沒有設定 BigQuery 專案 ID。');
  }
  const client = new BigQuery({ projectId: appConfig.bigQuery.projectId });
  const sourceRef = bigquery.sourceRefForRead_(appConfig.bigQuery);
  const [rows] = await client.query({ query: bigquery.buildDateBoundsSql_(sourceRef) });
  const row = rows[0] || {};
  return {
    sourceMode: appConfig.bigQuery.sourceMode,
    minDate: row.min_date || null,
    maxDate: row.max_date || null,
    tradingDays: Number(row.trading_days) || 0,
    stockCount: Number(row.stock_count) || 0,
    rowCount: Number(row.row_count) || 0
  };
});

/**
 * data: {month}（'yyyy-MM'）。給 Admin 頁面「資料完整性月曆」用：這個月
 * 每一天各自的四碼股票筆數／總列數，一次查整個月（見 `lib/bigquery.js`
 * `buildDailyCountsSql_`），不用為了確認資料完整一天一天手動核對
 * `getHistoryOverview`——2026-10-08 使用者明確要求的新功能，apps-script
 * 版沒有對應功能可以照抄，這是全新設計的檢查工具。跟 `getHistoryOverview`
 * 一樣查 `sourceRefForRead_`（這個 App 實際在用的來源），不是固定查
 * `history_raw`，月曆上看到的缺口才會跟戰報實際讀到的資料一致。 */
exports.getHistoryDailyCounts = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const month = String(data.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new HttpsError('invalid-argument', 'month 格式要是 yyyy-MM。');
  }
  const appConfig = await fetchAppConfig_();
  if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) {
    throw new HttpsError('failed-precondition', 'config/app 沒有設定 BigQuery 專案 ID。');
  }
  const parts = month.split('-');
  const year = Number(parts[0]);
  const monthNum = Number(parts[1]); // 1-based
  const fromDateStr = month + '-01';
  // Date.UTC 的月份參數是 0-based，所以傳 monthNum（下個月，0-based 剛好對上
  // 這個月）配合 day=0，算出來就是「這個月的最後一天」。
  const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const toDateStr = month + '-' + String(lastDay).padStart(2, '0');

  const client = new BigQuery({ projectId: appConfig.bigQuery.projectId });
  const sourceRef = bigquery.sourceRefForRead_(appConfig.bigQuery);
  const [rows] = await client.query({ query: bigquery.buildDailyCountsSql_(sourceRef, fromDateStr, toDateStr) });
  return rows.map(function (r) {
    return {
      date: r.date_str,
      stockCount: Number(r.stock_count) || 0,
      rowCount: Number(r.row_count) || 0
    };
  });
});

/**
 * 以下是 Watchlist／Portfolio 的讀寫邏輯（Phase 3，跟戰報計算一起遷移），從
 * apps-script/src/Watchlist.gs／apps-script/src/Portfolio.gs 搬過來。用
 * onCall（不是 onRequest／onSchedule）——這幾支是給之後的前端（Phase 5）直接
 * 呼叫用的使用者操作，不是排程或純測試用的 HTTP endpoint，onCall 自帶
 * Firebase Auth 驗證跟結構化錯誤回傳，不用自己重新發明一套。
 *
 * deletePortfolioItem_（依代號刪光全部持有中紀錄）刻意不搬——apps-script 版
 * 自己也說明那是「舊版前端相容用」，新版前端一律用 deletePortfolioLot(lotId)
 * 刪除單一一筆，不需要這支。
 */

/** 跟 firestore/firestore.rules 的 isOwner() 同一個擁有者 email，刻意重複寫一次：
 *  Cloud Functions 用 Admin SDK 讀寫 Firestore，完全不受 Security Rules 限制，
 *  isOwner() 只保護前端「直接」讀寫 watchlist／portfolio_lots 這兩個 collection，
 *  擋不住繞過前端直接打這幾支 onCall function 的呼叫——所以每一支都要在進入點
 *  自己檢查一次 request.auth，不能只靠 Security Rules 那一層。 */
var OWNER_EMAIL_ = 'nachohuang@gmail.com';

function assertOwnerAuth_(request) {
  if (!request.auth || request.auth.token.email !== OWNER_EMAIL_) {
    throw new HttpsError('permission-denied', '只有擁有者本人登入後才能呼叫這個功能。');
  }
}

exports.getWatchlist = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  return await buildWatchlistResult_();
});

/** data: {code, name?, note?}。code 必填；已經是持有中的股票會被擋掉（見
 *  lib/watchlist.js assertNotHolding_ 的說明）；同一檔股票重複加入視為更新。 */
exports.addToWatchlist = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const code = utilsLib.zfill4(String(data.code).trim());

  const [lotDocs, docRef] = [await fetchPortfolioLots_(), admin.firestore().collection('watchlist').doc(code)];
  const portfolioMap = portfolio.buildPortfolioMap_(lotDocs);
  try {
    watchlistLib.assertNotHolding_(code, portfolioMap);
  } catch (e) {
    throw new HttpsError('failed-precondition', e.message);
  }

  const existingSnap = await docRef.get();
  const todayStr = utilsLib.todayStrTaipei_();
  const fields = watchlistLib.mergeWatchlistDoc_(existingSnap.exists ? existingSnap.data() : null, code, data.name, data.note, todayStr);
  await docRef.set(fields);
  return await buildWatchlistResult_();
});

/** data: {code}。 */
exports.removeFromWatchlist = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const code = utilsLib.zfill4(String(data.code).trim());
  await admin.firestore().collection('watchlist').doc(code).delete();
  return await buildWatchlistResult_();
});

exports.getPortfolio = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  return await buildPortfolioResult_();
});

/**
 * data: {lotId?, code, name?, cost, buyDate?, shares?, note?}。沒帶 lotId 代表
 * 新增一筆全新買進紀錄（isNewHolding），這檔股票既然已經真的買進，就自動把它
 * 從觀察清單移除（對應 apps-script 版 removeFromWatchlistSilently_，同步失敗
 * 不該擋住真正的買進紀錄，見 catch 區塊的說明）；帶 lotId 代表編輯既有的一筆。
 */
exports.savePortfolioItem = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const item = request.data || {};
  if (!item.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const code = utilsLib.zfill4(String(item.code).trim());
  const db = admin.firestore();
  const isNewHolding = !item.lotId;

  if (item.lotId) {
    const ref = db.collection('portfolio_lots').doc(item.lotId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', '找不到這筆買進紀錄，可能已被刪除，請重新整理後再試一次');
    const existing = snap.data();
    await ref.set({
      transactionId: item.lotId,
      code: code,
      name: item.name || existing.name || '',
      buyDate: item.buyDate || existing.buyDate || '',
      buyPrice: utilsLib.toNumber(item.cost),
      shares: utilsLib.toNumber(item.shares) || existing.shares || config.PORTFOLIO_DEFAULT_LOT_SHARES,
      note: item.note || '',
      status: existing.status || 'holding',
      sellDate: existing.sellDate || null,
      sellPrice: existing.sellPrice || null
    });
  } else {
    const ref = db.collection('portfolio_lots').doc();
    await ref.set({
      transactionId: ref.id,
      code: code,
      name: item.name || '',
      buyDate: item.buyDate || '',
      buyPrice: utilsLib.toNumber(item.cost),
      shares: utilsLib.toNumber(item.shares) || config.PORTFOLIO_DEFAULT_LOT_SHARES,
      note: item.note || '',
      status: 'holding',
      sellDate: null,
      sellPrice: null
    });
    try {
      await db.collection('watchlist').doc(code).delete();
    } catch (e) { /* 觀察清單同步失敗不該擋住真正的買進紀錄，見 apps-script 版說明 */ }
  }
  return await buildPortfolioResult_();
});

/** data: {lotId}。依交易ID刪除單一一筆買進紀錄（不是依股票代號——同一檔可能有好幾筆）。 */
exports.deletePortfolioLot = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const lotId = request.data && request.data.lotId;
  if (!lotId) throw new HttpsError('invalid-argument', '缺少交易ID');
  await admin.firestore().collection('portfolio_lots').doc(lotId).delete();
  return await buildPortfolioResult_();
});

/**
 * data: {code, sellDate, sellPrice, sellShares?}。把某檔股票目前持有中的
 * 紀錄標記為已賣出（用同一個賣出日期/價格）。`sellShares` 不帶、是空字串，
 * 或等於目前總股數，維持原本「整檔一次全部結案」的行為；帶一個小於總
 * 股數的數字，就依 FIFO（先進先出，見 `portfolioOpsLib.planPartialClose_`
 * 的說明）只結案那麼多股——2026-10-08 使用者在「標示已賣出」表單明確
 * 要求要能輸入賣出股數，不是只能整檔全賣。
 *
 * FIFO 切到某一筆 lot 中間時，那一筆會被拆成兩筆文件：原本那筆改成
 * `shares` 剩下的部分、繼續 `status: 'holding'`；另外新增一筆
 * `status: 'sold'`、`shares` 是賣掉的那部分——跟 `savePortfolioItem`
 * 新增買進紀錄同一個「用 Firestore 自動產生的文件 ID 當 transactionId」
 * 寫法。`buildClosedHistory_` 依 `code+sellDate+sellPrice` 分組算已實現
 * 損益，這筆新拆出來的「已賣出」文件自然會跟同一次結案動作的其他筆分在
 * 同一組，不需要額外處理。
 */
exports.closePortfolioPosition = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const code = utilsLib.zfill4(String(data.code || '').trim());
  if (!code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const sellPrice = utilsLib.toNumber(data.sellPrice);
  if (!sellPrice) throw new HttpsError('invalid-argument', '請輸入賣出價格');
  if (!data.sellDate) throw new HttpsError('invalid-argument', '請輸入賣出日期');

  const db = admin.firestore();
  const snap = await db.collection('portfolio_lots').where('code', '==', code).where('status', '==', 'holding').get();
  if (snap.empty) throw new HttpsError('not-found', '找不到 ' + code + ' 目前持有中的買進紀錄');

  const lots = snap.docs
    .map(function (doc) { return { id: doc.id, ref: doc.ref, data: doc.data() }; })
    .sort(function (a, b) { return (a.data.buyDate || '') < (b.data.buyDate || '') ? -1 : 1; }); // FIFO：買進日期由舊到新

  const plan = portfolioOpsLib.planPartialClose_(
    lots.map(function (l) { return { id: l.id, shares: l.data.shares }; }),
    data.sellShares
  );
  if (plan.error) throw new HttpsError('invalid-argument', plan.error);

  const byId = {};
  lots.forEach(function (l) { byId[l.id] = l; });
  const batch = db.batch();
  plan.fullyClosedIds.forEach(function (id) {
    batch.update(byId[id].ref, { status: 'sold', sellDate: data.sellDate, sellPrice: sellPrice });
  });
  if (plan.partialLot) {
    const target = byId[plan.partialLot.id];
    batch.update(target.ref, { shares: plan.partialLot.remainingShares });
    const newRef = db.collection('portfolio_lots').doc();
    batch.set(newRef, Object.assign({}, target.data, {
      transactionId: newRef.id,
      shares: plan.partialLot.soldShares,
      status: 'sold',
      sellDate: data.sellDate,
      sellPrice: sellPrice
    }));
  }
  await batch.commit();
  return await buildPortfolioResult_();
});

exports.getClosedPortfolioHistory = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const lotDocs = await fetchPortfolioLots_();
  return portfolioOpsLib.buildClosedHistory_(lotDocs);
});

/**
 * 以下是股票詳情頁（戰報卡片點進去看的頁面）的讀取邏輯，從
 * apps-script/src/StockAnalysis.gs 搬過來。**刻意沒搬**的部分：
 * `getRealtimeQuote`（打 `mis.twse.com.tw` 這個非官方、沒文件、只在盤中
 * 開放、有流量限制的即時報價端點，跟這次遷移「BigQuery/Firestore 資料層」
 * 的範圍無關，而且那支端點本身就脆弱，之後要做可以直接對應複製邏輯，不影響
 * 這裡的其他部分）、`startAiDiagnosisJob`／`getAiDiagnosisJobStatus`（跑一次
 * 新的 AI 診斷需要 Secret Manager 存 API 金鑰，獨立列為下一步，見 README
 * 「還沒做的事」）——這裡只讀**已經存在的**快取診斷（`getAiDiagnosisHistoryForCode`
 * 同款，Phase 2 已經遷移進 Firestore `ai_diagnosis`），不會主動呼叫 AI。
 */

/** 查 BigQuery 某一檔股票最近 STOCK_DETAIL_LOOKBACK_DAYS 天的原始 History 列，
 *  轉成中文欄名列（跟 fetchHistoryRows_／fetchBqInfoForCodes_ 同一套轉換）。 */
async function fetchStockHistoryRows_(bigQueryConfig, code) {
  if (!bigQueryConfig || !bigQueryConfig.projectId) return [];
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const sourceRef = bigquery.sourceRefForRead_(bigQueryConfig);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.STOCK_DETAIL_LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const sql = bigquery.buildHistoryRowsForCodesSql_(sourceRef, [code], cutoffStr);
  const [rows] = await client.query({ query: sql });
  return rows.map(bigquery.mapBqRowToHistoryRow_).filter(function (r) { return r !== null; });
}

/** `reports/{date}/signals` 裡某一檔代號的全部文件（collectionGroup 查詢）。
 *  一定要帶 `.orderBy('date', 'desc')`——實際部署驗證過，只有
 *  `.where('code','==',code)` 不夠：Firestore 對 collection group 的要求比
 *  「composite index 可以當作其他查詢的前綴使用」想像中更嚴格，單純等號查詢
 *  被要求要另外一個 `COLLECTION_GROUP_ASC` 的 `code` 單欄索引。加這個
 *  `orderBy` 剛好完全對上既有的 `(code ASC, date DESC)` 複合索引（前面「需要
 *  的 Firestore 複合索引」那組，跟 fetchLatestSignalsByCode_ 共用），不用再
 *  多部署一個索引——而且「戰報燈號歷史新到舊排序」本來就是要的順序。 */
async function fetchSignalHistoryForCode_(code) {
  const db = admin.firestore();
  const snap = await db.collectionGroup('signals').where('code', '==', code).orderBy('date', 'desc').get();
  return snap.docs.map(function (d) { return d.data(); });
}

/** `ai_diagnosis` collection 裡某一檔代號的全部快取診斷（Phase 2 已遷移完成，
 *  見 firestore/schema.md §4）。只查 `code` 相等，不加 `orderBy`——單欄等號
 *  查詢不需要額外的複合索引，排序交給呼叫端在記憶體裡做（同一檔股票的診斷
 *  紀錄筆數不多，不值得為了省這幾筆排序多部署一個索引）。 */
async function fetchAiDiagnosisForCode_(code) {
  const db = admin.firestore();
  const snap = await db.collection('ai_diagnosis').where('code', '==', code).get();
  const docs = snap.docs.map(function (d) { return d.data(); });
  docs.sort(function (a, b) { return (a.timestamp || '') < (b.timestamp || '') ? 1 : -1; });
  return docs;
}

/** 從 portfolioMap 取出某代號的持股背景資訊（加權平均成本／最早買進日／持有天數／
 *  目前損益%）——getStockDetail（顯示用）跟 runPortfolioHoldDiagnosis（組 AI prompt
 *  用）共用同一份計算，不要兩個地方各自重複寫一次同一套日期/損益算法。沒有持有這一檔
 *  時回傳 null。daysHeld 的日期相減刻意都用 'T00:00:00Z'（UTC）解析，避免 Node 把
 *  'YYYY-MM-DD' 字串當成本機時區午夜解析，兩個時區不一致時算出差一天的天數。 */
function buildHoldingInfo_(portfolioMap, code, latestClose) {
  const info = portfolioMap[code];
  if (!info) return null;
  const todayStr = utilsLib.todayStrTaipei_();
  const daysHeld = info.buyDate
    ? Math.round((new Date(todayStr + 'T00:00:00Z') - new Date(info.buyDate + 'T00:00:00Z')) / 86400000)
    : null;
  const profitPct = (info.cost && latestClose !== null && latestClose !== undefined)
    ? utilsLib.round_((latestClose - info.cost) / info.cost * 100, 2)
    : null;
  return { cost: info.cost, buyDate: info.buyDate, daysHeld: daysHeld, profitPct: profitPct };
}

/** data: {code}。回傳股票詳情頁要的四組資料：價格走勢（含 MA5/20/60）、
 *  戰報燈號歷史、AI 診斷快取歷史、持股背景資訊（沒有持有這一檔時是 null，
 *  前端用這個欄位決定要不要顯示「跑新的持股續抱診斷」按鈕）。BigQuery／
 *  Firestore／collectionGroup 三種 I/O 混在一起，所以用一支 onCall 一次
 *  打包回傳，不拆成多支個別呼叫——前端要顯示的是同一個頁面，沒有理由讓
 *  使用者等好幾次 round trip。 */
exports.getStockDetail = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const code = utilsLib.zfill4(String(data.code).trim());

  const appConfig = await fetchAppConfig_();
  const [historyRows, signalDocs, aiDiagnoses, lotDocs] = await Promise.all([
    fetchStockHistoryRows_(appConfig.bigQuery, code),
    fetchSignalHistoryForCode_(code),
    fetchAiDiagnosisForCode_(code),
    fetchPortfolioLots_()
  ]);

  if (historyRows.length === 0) {
    throw new HttpsError('not-found', '查無 ' + code + ' 的歷史資料，確認代號是否正確。');
  }

  const series = stockDetailLib.buildPriceSeries_(historyRows);
  const scoreHistory = stockDetailLib.buildScoreHistory_(signalDocs);
  const latest = series[series.length - 1];
  const latestClose = latest ? latest.close : null;
  const portfolioMap = portfolio.buildPortfolioMap_(lotDocs);

  return {
    code: code,
    name: historyRows[historyRows.length - 1]['證券名稱'] || '',
    latestClose: latestClose,
    series: series,
    scoreHistory: scoreHistory,
    aiDiagnoses: aiDiagnoses,
    holding: buildHoldingInfo_(portfolioMap, code, latestClose)
  };
});

/**
 * 「因子檢視器」：data: {code, startDate, endDate}。這次財報因子訓練一路
 * 踩到好幾個跟資料覆蓋率有關的 bug（Input data doesn't contain any
 * rows／mean imputation 對全 NULL 欄位報錯），每次都只能靠猜測＋翻
 * deploy log 定位原因。這支函式讓使用者自己選一檔股票、一段區間，一次
 * 看三組資料：
 *   1. factorRows：`factor_features_fundamental` view 裡這檔股票在區間
 *      內逐日算出來的全部因子值（48 個既有候選因子＋10 個財報基本面
 *      因子）——直接回答「這天這個因子到底是不是 NULL、算出來是多少」。
 *   2. rawFinancials：Firestore `financials_quarterly`／
 *      `financials_monthly` 裡這檔股票全部累積的原始財報列（不限查詢
 *      區間，筆數本身就不多，直接給全部——使用者才能自己對照「最近一期
 *      財報的公告日」是不是真的落在查詢區間附近，不然光看區間內的
 *      factorRows 看不出「到底有沒有資料，還是查詢區間剛好沒蓋到」）。
 *   3. rawHistory：區間內原始 History 列（股價／法人買賣超等），對照
 *      「算出來的因子」跟「背後真正的原始資料」。
 * 跟 `runFactorRegressionCore_` 訓練前一樣，先確保 `factor_features`／
 * `factor_features_fundamental` 這兩個 view 是最新定義，不會查到部署
 * 改掉之前的舊版本。
 */
exports.getStockFactorDetail = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const code = utilsLib.sanitizeStockId_(data.code);
  if (!code) throw new HttpsError('invalid-argument', '股票代號格式不正確。');
  const startStr = String(data.startDate || '').trim();
  const endStr = String(data.endDate || '').trim();
  const rangeCheck = factorInspectorLib.validateFactorInspectorRange_(startStr, endStr);
  if (rangeCheck.error) throw new HttpsError('invalid-argument', rangeCheck.error);

  const appConfig = await fetchAppConfig_();
  if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) {
    throw new HttpsError('failed-precondition', 'config/app 沒有設定 BigQuery 專案 ID。');
  }

  await ensureFeatureView_(appConfig.bigQuery);
  await ensureFundamentalFeatureView_(appConfig.bigQuery);

  const client = new BigQuery({ projectId: appConfig.bigQuery.projectId });
  const viewRef = bigquery.fundamentalFeatureViewRef_(appConfig.bigQuery);
  const sourceRef = bigquery.sourceRefForRead_(appConfig.bigQuery);
  const db = admin.firestore();

  const [factorResult, historyResult, quarterlySnap, monthlySnap] = await Promise.all([
    client.query({ query: bigquery.buildFactorDetailSql_(viewRef, code, startStr, endStr) }),
    client.query({ query: bigquery.buildHistoryRowsForCodesSql_(sourceRef, [code], startStr, endStr) }),
    db.collection('financials_quarterly').where('code', '==', code).get(),
    db.collection('financials_monthly').where('code', '==', code).get()
  ]);

  // factor_features_fundamental 的 `date` 欄位是真正的 BigQuery DATE 型態
  // （跟這支 App 其他地方查詢的 date_str 都是 STRING 不一樣），
  // @google-cloud/bigquery client 讀回來是 BigQueryDate 物件
  // （`{ value: 'yyyy-MM-dd' }`），直接回傳給前端不保證會被正確序列化成
  // 字串——這裡明確取出 `.value`（已經是字串就原樣保留，`.value` 在字串
  // 上是 undefined，三元運算會退回原值），回傳乾淨的 yyyy-MM-dd 字串。
  const factorRows = (factorResult[0] || []).map(function (r) {
    return Object.assign({}, r, { date: (r.date && r.date.value) ? r.date.value : r.date });
  });
  const rawHistory = historyResult[0].map(bigquery.mapBqRowToHistoryRow_).filter(function (r) { return r !== null; });
  const quarterlyDocs = factorInspectorLib.sortFinancialDocsByDate_(
    quarterlySnap.docs.map(function (d) { return d.data(); }), 'period'
  );
  const monthlyDocs = factorInspectorLib.sortFinancialDocsByDate_(
    monthlySnap.docs.map(function (d) { return d.data(); }), 'reportDate'
  );
  // Firestore financials_quarterly／financials_monthly 存的是原始公告列，
  // 不含 grossMarginStreak／roeStreak／revenueGrowthStreak 這幾個「連續
  // 上升期數」——那是 doRefreshFinancials_ 讀回全部累積歷史才能算出來的
  // 衍生欄位，算完只同步進 BigQuery financial_ratios／financial_revenue，
  // 沒有寫回 Firestore（見 doRefreshFinancials_ 的說明）。這裡用同一套
  // 純函式對這一檔股票重算一次（兩支函式回傳的是攤平陣列，不是分組的
  // 陣列的陣列，傳入單一分組就直接是這檔股票的結果，不用再取 [0]），
  // 顯示的才是跟訓練/因子計算實際用到的同一份數字，不是只有原始公告值。
  const quarterlyWithStreaks = quarterlyDocs.length ? financialsLib.computeFundamentalStreaks_([quarterlyDocs]) : [];
  const monthlyWithStreaks = monthlyDocs.length ? financialsLib.computeRevenueGrowthStreaks_([monthlyDocs]) : [];

  return {
    code: code,
    factorRows: factorRows,
    rawHistory: rawHistory,
    rawFinancials: { quarterly: quarterlyWithStreaks, monthly: monthlyWithStreaks }
  };
});

/** data: {query}。股票代號/名稱模糊搜尋，給前端的搜尋框用——跟戰報清單的
 *  「只篩今天的訊號」不同，這支查的是全市場、不限於今天有沒有訊號，用來找
 *  任何一檔股票打開詳情頁。回傳最多 20 筆 {code, name}，依最新資料的代號
 *  去重（BigQuery 查回來的是原始列，同一檔代號會有很多天，這裡只取最新
 *  那筆的名稱）。 */
exports.searchStockCodes = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const q = String(data.query || '').trim();
  if (!q) return [];

  const appConfig = await fetchAppConfig_();
  if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) return [];

  const client = new BigQuery({ projectId: appConfig.bigQuery.projectId });
  const sourceRef = bigquery.sourceRefForRead_(appConfig.bigQuery);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 10);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const sql = bigquery.buildStockSearchSql_(sourceRef, q, cutoffStr);
  const [rows] = await client.query({ query: sql });

  const seen = new Set();
  const results = [];
  for (const row of rows) {
    const code = utilsLib.sanitizeStockId_(row.stock_id);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    results.push({ code: code, name: row.stock_name || '' });
    if (results.length >= 20) break;
  }
  return results;
});

/**
 * 以下是 AI 深度診斷（新進場決策，diagnosisType='deep'）的 I/O，從
 * apps-script/src/AiDiagnosis.gs 搬過來（純邏輯部分見 lib/aiDiagnosis.js 開頭的
 * 範圍說明——這一版刻意只搬「深度診斷」，'hold'／'top3' 兩種診斷類型跟 AiUsage
 * 歷史費用記錄先不搬，見 README「AI 診斷」那節）。
 *
 * Goodinfo／TWSE OpenAPI／Claude／Gemini 都是打外部 HTTP 端點，跟這支檔案其餘
 * 的 BigQuery／Firestore I/O 同一個檔案管理，不獨立成 lib/ 底下的模組——這些
 * 函式本身就是「純 I/O」，沒有值得抽出來單元測試的運算邏輯（組 prompt／抽結論
 * 的運算邏輯已經在 lib/aiDiagnosis.js 測過）。Node 20 執行環境內建全域
 * `fetch`，不需要額外加 node-fetch 依賴。
 */

/** 跟 apps-script 版 fetchGoodinfoText_ 同一套抓取/去標籤邏輯——Goodinfo 沒有
 *  公開 API，只能抓網頁 HTML 用正規表示式去標籤，抓不到 JS 動態載入的內容，
 *  抓取失敗時回傳說明文字而不是拋例外，讓整個診斷流程可以繼續跑下去（AI 看到
 *  說明文字會依系統 prompt 規則 1 明確標註「此部分資料不足」）。 */
async function fetchGoodinfoText_(code) {
  const url = 'https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=' + code;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9'
      }
    });
    if (!resp.ok) {
      return '（無法取得 Goodinfo 頁面，HTTP ' + resp.status + '，這部分請依你既有的知識判斷，並在報告中註明缺乏即時資料）';
    }
    const html = await resp.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    const MAX_CHARS = 6000; // 避免整段塞爆 prompt，只取前面精華（頁首通常是股價/基本資訊區塊）
    return text.slice(0, MAX_CHARS);
  } catch (e) {
    return '（抓取 Goodinfo 頁面時發生錯誤：' + String(e.message || e) + '，這部分請依你既有的知識判斷，並在報告中註明缺乏即時資料）';
  }
}

/** 跟 apps-script 版 TWSE_OFFICIAL_FINANCIALS_DATASETS_ 同一份端點清單——只接了
 *  「一般業」的財報端點，金融/證券/保險/金控等特殊產業別查無資料是預期行為。 */
var TWSE_OFFICIAL_FINANCIALS_DATASETS_ = [
  { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L', label: '上市公司每月營業收入彙總表' },
  { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci', label: '上市公司綜合損益表（一般業）' },
  { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci', label: '上市公司資產負債表（一般業）' }
];

/** 抓 3 個 TWSE OpenAPI 全市場資料集（一次），單一資料集抓取失敗就讓那個資料集
 *  的 rows 是空陣列，不拋例外、不中斷整體流程——跟 apps-script 版同一個設計。 */
async function fetchTwseOfficialFinancialsDatasets_() {
  return Promise.all(TWSE_OFFICIAL_FINANCIALS_DATASETS_.map(async function (ds) {
    try {
      const resp = await fetch(ds.url);
      if (!resp.ok) return { label: ds.label, rows: [] };
      const rows = await resp.json();
      return { label: ds.label, rows: Array.isArray(rows) ? rows : [] };
    } catch (e) {
      return { label: ds.label, rows: [] };
    }
  }));
}

/**
 * MOPS 月營收歷史靜態頁面抓取——跟 `fetchTwseCsvText_` 同一套 Big5
 * 解碼／手動處理重新導向／完整瀏覽器 header 組合的理由（見該函式的
 * 說明），差別是回應是 HTML 不是 CSV，而且某個（月份、市場）組合如果
 * MOPS 還沒有這份歸檔會回 404——404 當成「這個月沒有資料」回傳 null，
 * 不當例外拋出（呼叫端迴圈要能繼續處理下一個月／市場，不能整批中斷）。
 * 這個網址格式是從開源套件 twmops 原始碼逆推出來的，這個開發環境連不到
 * `*.twse.com.tw` 任何網域，沒辦法直接連線核對（見
 * `lib/mopsRevenueHtml.js` 開頭的完整說明），部署後第一次執行如果格式
 * 不符，錯誤訊息會帶 HTTP 狀態碼跟網址方便診斷。
 */
async function fetchMopsRevenueHtml_(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    'Referer': 'https://mopsov.twse.com.tw/'
  };
  let currentUrl = url;
  for (let hop = 0; hop < 5; hop++) {
    const resp = await fetch(currentUrl, { headers: headers, redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) throw new Error('HTTP ' + resp.status + '（重新導向但沒有 Location header）- ' + currentUrl);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' - ' + currentUrl);
    const buf = Buffer.from(await resp.arrayBuffer());
    return iconv.decode(buf, 'big5');
  }
  throw new Error('重新導向次數過多（超過 5 次）- 原始網址：' + url + '，最後停在：' + currentUrl);
}

function sleep_(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * 2026-10-08 修正：原本是 `['sii', 'otc']`（上市＋上櫃），使用者實測回補
 * 2026-08 之後，涵蓋率月曆的股票數從 OpenAPI 來源原本的 1085 檔跳到
 * 1949 檔——跟這個 App 其他地方的既定範圍不一致：`industry_map`
 * collection 明確只收上市股票（`fetchTpexListedIndustryMap_` 固定回傳
 * 空陣列＋警告「上櫃產業別資料源尚未確認」），股價歷史（T86／MI_INDEX／
 * BWIBBU_d）也都是 TWSE（上市）端點，整個 App 沒有任何地方真的在處理
 * 上櫃股票。多抓的上櫃公司不會讓訓練用的資料出錯（`buildFundamentalFeatureViewSql_`
 * 是從上市股價歷史那張 view 往外 LEFT JOIN，上櫃代號本來就不會被
 * join 到任何一列，純粹是寫了一堆不會被用到的 Firestore 文件），但會讓
 * 「涵蓋率月曆」的數字不是同一個口徑、對不起來，造成使用者誤判資料
 * 品質。改成只抓 `sii`（上市），跟 OpenAPI 來源的範圍完全一致。已經
 * 回補進去的上櫃資料靠 `cleanupMopsBackfillOtcRows_`／
 * `exports.cleanupFinancialsNonListedCodes` 事後清掉，不是留著不管。
 */
var MOPS_BACKFILL_MARKETS_ = ['sii']; // 上市——跟整個 App 其他地方的範圍一致，見上方說明
var MOPS_BACKFILL_RATE_LIMIT_MS_ = 1100; // 比照 twmops 預設的「每秒 1 個請求」限制，留一點餘裕
var MOPS_BACKFILL_MAX_PERIODS_ = 12; // 一次最多回補 12 個月，避免單次執行時間失控

/**
 * 歷史月營收回補主邏輯——對每個（期間、市場）組合依序抓 MOPS 靜態頁面
 * （見 `fetchMopsRevenueHtml_`），刻意不用 `Promise.all` 平行發送：MOPS
 * 有速率限制（見 `lib/mopsRevenueHtml.js` 開頭的說明），用迴圈＋sleep
 * 節流，避免被當成異常流量擋掉。單一（期間、市場）失敗不中斷整批回補，
 * 錯誤收集起來最後一起回報，讓使用者看得到是哪幾個月/市場失敗。
 *
 * 跟官方 OpenAPI 來源（`doRefreshFinancials_`）寫進同一個
 * `financials_monthly` collection，doc ID 一樣是 `code_period`——但這裡
 * 回補出來的 `reportDate` 一律是估算值（見
 * `lib/mopsRevenueHtml.js parseMopsRevenueTables_` 的說明：這個靜態頁面
 * 沒有逐公司的官方公告日期），刻意「不覆蓋」已經有精確官方出表日期的
 * 既有文件（`reportDateIsEstimated === false`，來自 OpenAPI 來源），
 * 避免回補不小心把精確值退化成這裡的粗略估計值。
 */
async function runFinancialsBackfillMopsCore_(bigQueryConfig, startPeriod, endPeriod, onProgress) {
  const periods = mopsRevenueLib.enumeratePeriodsInclusive_(startPeriod, endPeriod);
  if (periods.length === 0) throw new Error('回補區間無效：' + startPeriod + ' ~ ' + endPeriod + '（請確認格式是 yyyy-MM，且起始不晚於結束）。');
  if (periods.length > MOPS_BACKFILL_MAX_PERIODS_) {
    throw new Error('一次最多回補 ' + MOPS_BACKFILL_MAX_PERIODS_ + ' 個月，請分批執行（這次要求 ' + periods.length + ' 個月）。');
  }

  let fetchedRows = [];
  const httpErrors = [];
  let first = true;

  for (const period of periods) {
    const reportDate = financialsLib.estimateMonthlyRevenueReportDate_(period);
    for (const market of MOPS_BACKFILL_MARKETS_) {
      if (!first) await sleep_(MOPS_BACKFILL_RATE_LIMIT_MS_);
      first = false;
      const url = mopsRevenueLib.buildMopsRevenueUrl_(market, period, 0);
      try {
        const html = await fetchMopsRevenueHtml_(url);
        if (html === null) continue; // 這個月/市場 MOPS 還沒有歸檔（404），略過不當錯誤
        const tables = mopsRevenueLib.extractHtmlTables_(html);
        const rows = mopsRevenueLib.parseMopsRevenueTables_(tables, period, reportDate);
        fetchedRows = fetchedRows.concat(rows);
        if (onProgress) await onProgress({ period: period, market: market, rowCount: rows.length });
      } catch (e) {
        httpErrors.push(period + '/' + market + '：' + String(e.message || e));
      }
    }
  }

  if (fetchedRows.length === 0) {
    throw new Error('這個區間完全沒有抓到任何資料（' + startPeriod + ' ~ ' + endPeriod + '），可能是 MOPS 網址格式跟預期不符，或這幾個月份還沒有歸檔。' +
      (httpErrors.length ? ' 錯誤明細：' + httpErrors.join('；') : ''));
  }

  // 避免覆蓋已經有精確官方出表日期的既有文件（見上方函式說明）。
  const existingMonthlyDocs = await fetchAllDocs_('financials_monthly');
  const preciseKeys = new Set(
    existingMonthlyDocs.filter(function (d) { return d.reportDateIsEstimated === false; })
      .map(function (d) { return d.code + '_' + d.period; })
  );
  const rowsToWrite = fetchedRows.filter(function (r) { return !preciseKeys.has(r.code + '_' + r.period); });
  const skippedPreciseCount = fetchedRows.length - rowsToWrite.length;

  await upsertFinancialRowsToFirestore_('financials_monthly', rowsToWrite);

  const allMonthly = await fetchAllDocs_('financials_monthly');
  const streakedMonthly = financialsLib.computeRevenueGrowthStreaks_(groupAndSortFinancialRowsByCode_(allMonthly));

  const bqSync = { attempted: false, ok: false, error: null };
  if (bigQueryConfig && bigQueryConfig.projectId) {
    bqSync.attempted = true;
    try {
      const allQuarterly = await fetchAllDocs_('financials_quarterly');
      const streakedQuarterly = financialsLib.computeFundamentalStreaks_(groupAndSortFinancialRowsByCode_(allQuarterly));
      await syncFinancialsToBigQuery_(bigQueryConfig, streakedQuarterly, streakedMonthly);
      bqSync.ok = true;
    } catch (e) {
      bqSync.error = String(e.message || e);
    }
  }

  return {
    periodsRequested: periods.length,
    rowsFetched: fetchedRows.length,
    rowsWritten: rowsToWrite.length,
    rowsSkippedPrecise: skippedPreciseCount,
    monthlyTotalAccumulated: allMonthly.length,
    httpErrors: httpErrors,
    bqSync: bqSync
  };
}

var FINANCIALS_BACKFILL_RUNTIME_OPTS_ = Object.assign({}, RUNTIME_OPTS_, { timeoutSeconds: 600 });

/**
 * Admin 頁面「歷史回補（MOPS）」按鈕用——跟 `runFinancialsRefresh`
 * （OpenAPI 來源，只抓最新一期、適合排程常跑）是兩條獨立路徑，刻意不
 * 合併成一支函式：這支是使用者手動指定區間、一次觸發的重活（逐月逐市場
 * 序列請求＋節流），跟「每次排程/手動按一下就抓最新快照」的使用情境不
 * 一樣。兩者寫進同一個 `financials_monthly` collection，涵蓋率月曆／
 * 隨機抽樣這些既有的資料檢查 UI 不用另外做一份，兩種來源的資料都會
 * 自動顯示在同一份月曆/抽樣表格裡（抽樣表格可以用 `source` 欄位分辨
 * 這筆是哪個來源抓到的）。
 *
 * 2026-10-08 補充：commit d6d94e8 把 `MOPS_BACKFILL_MARKETS_` 改成只抓
 * 上市之後，這支連續好幾次部署都撞上 Cloud Run 配額健康檢查失敗，
 * `rerun_failed_jobs` 重跑時又被 Firebase CLI 誤判成「內容沒變」而跳過
 * （見 `getFinancialsCoverage` 上方那段更完整的說明）——這段註解一樣是
 * 刻意改變原始碼雜湊，逼這支真的重新部署一次，不是單純的裝飾文字。這次
 * 配額衝突特別嚴重（單次部署撞到快 30 支既有函式），已經確認
 * `rerun_failed_jobs` 對這個特定問題完全沒用（會一直被跳過），每次都要
 * 真的改一次原始碼才會重新嘗試部署。
 */
exports.runFinancialsBackfillMops = onCall(FINANCIALS_BACKFILL_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const startPeriod = request.data && request.data.startPeriod;
  const endPeriod = request.data && request.data.endPeriod;
  if (!startPeriod || !endPeriod) throw new HttpsError('invalid-argument', '請指定要回補的起始／結束年月（yyyy-MM）。');
  const startTime = Date.now();
  await writeJobStatus_('financialsBackfillMops', { status: 'running', startedAt: startTime, error: null, progress: null });
  try {
    const appConfig = await fetchAppConfig_();
    const summary = await runFinancialsBackfillMopsCore_(appConfig.bigQuery || {}, startPeriod, endPeriod, async function (p) {
      await writeJobStatus_('financialsBackfillMops', { progress: p });
    });
    const durationMs = Date.now() - startTime;
    const msg = '回補 ' + startPeriod + ' ~ ' + endPeriod + '：抓到 ' + summary.rowsFetched + ' 筆，實際寫入 ' + summary.rowsWritten + ' 筆' +
      (summary.rowsSkippedPrecise ? '（' + summary.rowsSkippedPrecise + ' 筆因為已有精確官方日期而略過）' : '') +
      (summary.httpErrors.length ? '，' + summary.httpErrors.length + ' 個月/市場組合失敗' : '') +
      (summary.bqSync.attempted ? '，BigQuery 同步：' + (summary.bqSync.ok ? '成功' : '失敗（' + summary.bqSync.error + '）') : '');
    await logRun_('財報因子', '成功', msg, durationMs);
    await writeJobStatus_('financialsBackfillMops', { status: 'succeeded', finishedAt: Date.now(), result: summary, error: null });
    return summary;
  } catch (e) {
    await logRun_('財報因子', '失敗', String(e.message || e), Date.now() - startTime);
    await writeJobStatus_('financialsBackfillMops', { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
    throw new HttpsError('internal', String(e.message || e));
  }
});

/**
 * 善後：`runFinancialsBackfillMopsCore_` 2026-10-08 修正前曾經短暫用
 * `['sii', 'otc']` 兩個市場回補過（見 `MOPS_BACKFILL_MARKETS_` 上方的
 * 完整說明），使用者實測已經寫進一批上櫃公司的 `financials_monthly`
 * 文件，跟這個 App 其他地方「只處理上市股票」的範圍不一致。這支把
 * `source === 'mopsBackfill'` 且代號不在 `industry_map`（這個 App 既有
 * 的「上市股票清單」權威來源，見 `exports.runIndustryMapRefresh`）裡的
 * 文件整批刪掉，一次性善後用，不是常態會跑的流程。
 */
async function cleanupMopsBackfillOtcRows_(bigQueryConfig) {
  const db = admin.firestore();
  const [industryMapSnap, monthlySnap] = await Promise.all([
    db.collection('industry_map').get(),
    db.collection('financials_monthly').get()
  ]);
  const listedCodes = new Set(industryMapSnap.docs.map(function (d) { return d.id; }));
  if (listedCodes.size === 0) {
    throw new Error('industry_map 是空的，沒辦法判斷哪些代號是上市股票——請先執行過一次「重新整理產業對照表」再跑這個清理。');
  }
  const toDelete = monthlySnap.docs.filter(function (d) {
    const data = d.data();
    return data.source === 'mopsBackfill' && !listedCodes.has(data.code);
  });
  const BATCH_SIZE = 400;
  for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
    const batch = db.batch();
    toDelete.slice(i, i + BATCH_SIZE).forEach(function (d) { batch.delete(d.ref); });
    await batch.commit();
  }

  // Firestore 刪掉之後，BigQuery 那份（整份覆蓋同步，見
  // `syncFinancialsToBigQuery_` 的說明）要重跑一次才會跟著乾淨，不然
  // 殘留的上櫃資料會一直留在 `financial_revenue` 表裡，要等到下一次不
  // 相關的「重新整理」才會被覆蓋掉。
  const bqSync = { attempted: false, ok: false, error: null };
  if (toDelete.length > 0 && bigQueryConfig && bigQueryConfig.projectId) {
    bqSync.attempted = true;
    try {
      const [allMonthly, allQuarterly] = await Promise.all([
        fetchAllDocs_('financials_monthly'),
        fetchAllDocs_('financials_quarterly')
      ]);
      const streakedMonthly = financialsLib.computeRevenueGrowthStreaks_(groupAndSortFinancialRowsByCode_(allMonthly));
      const streakedQuarterly = financialsLib.computeFundamentalStreaks_(groupAndSortFinancialRowsByCode_(allQuarterly));
      await syncFinancialsToBigQuery_(bigQueryConfig, streakedQuarterly, streakedMonthly);
      bqSync.ok = true;
    } catch (e) {
      bqSync.error = String(e.message || e);
    }
  }

  return { deletedCount: toDelete.length, remainingCount: monthlySnap.size - toDelete.length, bqSync: bqSync };
}

// 2026-10-08 補充：同一個「rerun_failed_jobs 被 Firebase CLI 誤判成無
// 變更而跳過」問題，見 exports.runFinancialsBackfillMops 上方的說明——
// 這支連續好幾次因為配額衝突沒部署成功（這次是真的健康檢查失敗，不是
// 被跳過，getFinancialsCoverage／runFinancialsBackfillMops 這兩支這次
// 已經確認部署成功了），再改一次原始碼重試。
exports.cleanupFinancialsNonListedCodes = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  try {
    const appConfig = await fetchAppConfig_();
    const result = await cleanupMopsBackfillOtcRows_(appConfig.bigQuery || {});
    await logRun_('財報因子', '成功', '清掉 ' + result.deletedCount + ' 筆非上市股票的回補資料（剩餘 ' + result.remainingCount + ' 筆）' +
      (result.bqSync.attempted ? '，BigQuery 同步：' + (result.bqSync.ok ? '成功' : '失敗（' + result.bqSync.error + '）') : ''), 0);
    return result;
  } catch (e) {
    throw new HttpsError('internal', String(e.message || e));
  }
});

/** 跟 apps-script 版 callClaude_ 同一套呼叫方式（system prompt 帶
 *  `cache_control: {type: 'ephemeral'}` 做 prompt caching，省同一段系統規則文字
 *  重複呼叫的費用）。 */
async function callClaude_(systemPrompt, userPrompt, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: config.CLAUDE_MODEL,
      max_tokens: config.CLAUDE_MAX_TOKENS,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error('Claude API 呼叫失敗 HTTP ' + resp.status + '：' + body.slice(0, 300));
  }
  const json = JSON.parse(body);
  const text = (json.content || []).map(function (block) { return block.text || ''; }).join('\n');
  const usage = json.usage || {};
  return {
    text: text,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
    cacheReadInputTokens: usage.cache_read_input_tokens || 0,
    provider: 'claude',
    model: config.CLAUDE_MODEL
  };
}

/** 跟 apps-script 版 callGeminiOnce_ 同一套呼叫方式。 */
async function callGeminiOnce_(apiKey, systemPrompt, userPrompt, useGrounding) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + config.GEMINI_MODEL +
    ':generateContent?key=' + encodeURIComponent(apiKey);
  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: config.GEMINI_MAX_TOKENS }
  };
  if (useGrounding) payload.tools = [{ google_search: {} }];

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error('Gemini API 呼叫失敗 HTTP ' + resp.status + '：' + body.slice(0, 300));
  }
  const json = JSON.parse(body);
  const candidate = (json.candidates || [])[0];
  if (!candidate || !candidate.content || !candidate.content.parts) {
    const finishReason = candidate && candidate.finishReason;
    throw new Error('Gemini 回傳格式異常（finishReason：' + (finishReason || '未知') +
      '，grounding：' + (useGrounding ? '開啟' : '關閉') + '）：' + body.slice(0, 300));
  }
  const text = candidate.content.parts.map(function (p) { return p.text || ''; }).join('');
  const usage = json.usageMetadata || {};
  return {
    text: text,
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    provider: 'gemini',
    model: config.GEMINI_MODEL
  };
}

/** 跟 apps-script 版 callGemini_ 同一套重試/降級機制：gemini-2.5-flash 開
 *  google_search grounding 時，Google API 端偶爾回傳「空內容」（見
 *  lib/aiDiagnosis.js 之外、這支函式本身的這段說明在 apps-script 版原文有完整
 *  描述）——最多重試 3 次，連續兩次空內容失敗就在第 3 次關掉 grounding 再試。 */
async function callGemini_(systemPrompt, userPrompt, apiKey) {
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const useGrounding = attempt < maxAttempts;
    try {
      const result = await callGeminiOnce_(apiKey, systemPrompt, userPrompt, useGrounding);
      result.groundingDisabled = !useGrounding;
      return result;
    } catch (e) {
      lastError = e;
      if (!/回傳格式異常/.test(String(e.message || e))) throw e;
      if (attempt < maxAttempts) await new Promise(function (r) { setTimeout(r, 1500); });
    }
  }
  throw lastError;
}

/** 依 provider 分派到 Claude 或 Gemini，apiKeys 是 {claude, gemini}（從
 *  process.env 讀出來的 Secret Manager 密鑰，見 exports.runAiDiagnosis）。 */
async function callLlm_(systemPrompt, userPrompt, provider, apiKeys) {
  if (provider === 'gemini') {
    if (!apiKeys.gemini) throw new HttpsError('failed-precondition', '尚未設定 Gemini API 金鑰（Secret Manager 的 GEMINI_API_KEY）。');
    return callGemini_(systemPrompt, userPrompt, apiKeys.gemini);
  }
  if (!apiKeys.claude) throw new HttpsError('failed-precondition', '尚未設定 Anthropic API 金鑰（Secret Manager 的 ANTHROPIC_API_KEY）。');
  return callClaude_(systemPrompt, userPrompt, apiKeys.claude);
}

/**
 * 寫一筆 AI 呼叫的用量／費用記錄——跟 apps-script 版 logAiUsage_（寫進 Sheets
 * 的 AiUsage 分頁）同一個用途，這版寫進 Firestore `ai_usage` collection（見
 * README「AI 用量統計」那節）。`code` 對單檔診斷是股票代號，對候選名單橫向
 * 比較／Top3 推薦是常數 `'SHORTLIST_SCAN'`／`'TOP3_SCAN'`，跟 apps-script 版
 * 一致。刻意吞掉寫入失敗的錯誤——用量記錄是「順便記一筆」的旁支資訊，寫失敗
 * 不該讓已經成功的診斷流程整個報錯給使用者看。 */
async function logAiUsage_(code, llmResult, costUsd, timestampLabel) {
  try {
    await admin.firestore().collection('ai_usage').add({
      date: utilsLib.todayStrTaipei_(),
      timestamp: timestampLabel,
      provider: llmResult.provider,
      model: llmResult.model,
      code: code,
      inputTokens: llmResult.inputTokens || 0,
      outputTokens: llmResult.outputTokens || 0,
      costUsd: utilsLib.round_(costUsd, 6)
    });
  } catch (e) { /* 見上方說明：用量記錄寫失敗不影響呼叫端 */ }
}

/**
 * 單一股票代號跑一次 AI 深度診斷的核心邏輯，不含 onCall 的 auth／參數驗證——
 * `exports.runAiDiagnosis`（股票詳情頁單檔觸發）跟
 * `runShortlistAndDeepDiagnosis_`（每日自動診斷，對候選名單裡每一檔各呼叫一次）
 * 共用同一份實作，不要兩個呼叫路徑各自重複寫一次「查戰報列→抓財報→組
 * prompt→呼叫 LLM→算費用→寫入 Firestore」。appConfig 由呼叫端傳入（兩條路徑
 * 都已經在外層讀過一次，不用每檔股票各自重讀一次 `config/app`）。
 */
async function runDeepDiagnosisForCode_(appConfig, code) {
  const startTime = Date.now();
  await writeJobStatus_('aiDiagnosis_' + code, { status: 'running', startedAt: startTime, kind: 'deep', error: null });
  try {
    const signalDocs = await fetchSignalHistoryForCode_(code);
    const row = signalDocs[0];
    if (!row) {
      throw new HttpsError('not-found', '在戰報裡找不到 ' + code + ' 的資料，請先確認它出現在某一天的戰報中。');
    }

    const timestampLabel = utilsLib.timestampLabelTaipei_();
    const [goodinfoText, twseDatasets] = await Promise.all([
      fetchGoodinfoText_(code),
      fetchTwseOfficialFinancialsDatasets_()
    ]);
    const twseOfficialText = aiDiagnosisLib.buildTwseOfficialFinancialsTextForCode_(code, twseDatasets);
    const userPrompt = aiDiagnosisLib.buildDiagnosisPrompt_(row, goodinfoText, twseOfficialText, timestampLabel);

    const provider = appConfig.aiProvider === 'gemini' ? 'gemini' : 'claude';
    const llmResult = await callLlm_(aiDiagnosisLib.AI_DIAGNOSIS_SYSTEM_PROMPT, userPrompt, provider, {
      claude: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY
    });

    const diagnosisText = llmResult.text;
    const verdict = aiDiagnosisLib.extractVerdict_(diagnosisText);
    const cost = aiDiagnosisLib.calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens, {
      cacheCreationInputTokens: llmResult.cacheCreationInputTokens,
      cacheReadInputTokens: llmResult.cacheReadInputTokens
    }, appConfig.pricing);

    const record = {
      date: row.date,
      code: code,
      name: row.name || '',
      armorScore: row.armorScore,
      strategy: row.strategy,
      verdict: verdict,
      diagnosisType: 'deep',
      content: diagnosisText,
      timestamp: timestampLabel
    };
    await admin.firestore().collection('ai_diagnosis').doc(code + '_' + row.date + '_deep').set(record);
    await logAiUsage_(code, llmResult, cost, timestampLabel);
    await logRun_('AI診斷', '成功', code + ' ' + (row.name || '') + ' -> ' + verdict, Date.now() - startTime);
    await writeJobStatus_('aiDiagnosis_' + code, { status: 'succeeded', finishedAt: Date.now(), error: null });

    return Object.assign({}, record, { cost: utilsLib.round_(cost, 4), groundingDisabled: !!llmResult.groundingDisabled });
  } catch (e) {
    await logRun_('AI診斷', '失敗', code + '：' + String(e.message || e), Date.now() - startTime);
    await writeJobStatus_('aiDiagnosis_' + code, { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
    throw e;
  }
}

/**
 * data: {code}。對單一股票代號跑一次 AI 深度診斷（會真正呼叫 Claude／Gemini
 * API，消耗額度）——跟 apps-script 版 runAiDiagnosis 一次對一批代號跑的設計不同，
 * 這裡是前端「股票詳情頁」單檔觸發用的互動式按鈕，一次只診斷使用者正在看的這
 * 一檔，不需要批次省 TWSE 資料集重複抓取的成本。
 *
 * 需要 `secrets: ['GEMINI_API_KEY']`——Firebase CLI 部署時會自動把這個 Secret
 * Manager 的密鑰值注入成這支函式執行環境的 `process.env.GEMINI_API_KEY`，並
 * 自動只授權這支函式的執行身分讀取這個密鑰（不用手動設定 IAM）。密鑰本身要靠
 * 使用者自己跑 `firebase functions:secrets:set GEMINI_API_KEY` 建立，這裡沒
 * 辦法（也不應該）用程式自動建立。
 *
 * **刻意不宣告 `ANTHROPIC_API_KEY`**——`firebase deploy` 會驗證 `secrets`
 * 陣列裡列出的每一個密鑰在 Secret Manager 裡真的存在、至少有一個版本，缺一個
 * 就整個部署失敗（不是只有用到 Claude 才失敗，是部署當下就失敗，Hosting／
 * Firestore 都會被一起卡住，因為這支 workflow 沒加 `--only`）。使用者目前只用
 * Gemini，沒有 Anthropic 金鑰，為了不逼使用者去生一個根本不會用到的 Claude
 * 金鑰只為了湊齊這個陣列，這裡只宣告真正會用到的這一個。`callLlm_` 的 Claude
 * 分支程式碼還留著（`config/app.aiProvider` 還是可以設回 `'claude'`），只是
 * 這種狀態下 `process.env.ANTHROPIC_API_KEY` 會是 `undefined`，`callLlm_`
 * 會拋出跟原來一樣清楚的 `failed-precondition`「尚未設定 Anthropic API 金鑰」
 * ——之後真的要用 Claude，把 `'ANTHROPIC_API_KEY'` 加回這個陣列、建好密鑰、
 * 重新部署即可，不用改其他程式碼。
 */
exports.runAiDiagnosis = onCall(
  Object.assign({ secrets: ['GEMINI_API_KEY'] }, RUNTIME_OPTS_),
  async function (request) {
    assertOwnerAuth_(request);
    const data = request.data || {};
    if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
    const code = utilsLib.zfill4(String(data.code).trim());
    const appConfig = await fetchAppConfig_();
    return runDeepDiagnosisForCode_(appConfig, code);
  }
);

/**
 * 以下是「每日自動 AI 診斷」（Top3 橫向推薦 + 候選名單橫向比較後逐檔深度診斷）
 * 的 I/O，從 apps-script/src/AiDiagnosis.gs 的
 * `getLatestReportCandidates_`／`runAiTopPicks`／`runAiShortlist_`／
 * `runDailyAiDiagnosisForTopPicks` 搬過來。跟上面單檔深度診斷／續抱診斷不同，
 * 這兩個都不查 Goodinfo／TWSE 財報，只用戰報本身已經算好的量化欄位做橫向比較
 * （見 lib/aiDiagnosis.js 的 `buildShortlistPrompt_`／`buildTopPicksPrompt_`
 * 開頭說明），維持低成本。
 */

/** `runAiTopPicks`／每日候選名單橫向比較都需要「最新一次戰報全部候選，依
 *  Armor_Score 高到低排序」這份清單——跟 apps-script 版 getLatestReportCandidates_
 *  同一個邏輯，先用 collectionGroup 查詢找出「最新是哪一天」（跟
 *  fetchLatestSignalsByCode_／Dashboard 共用同一組 collectionGroup 索引），
 *  再用一般的 collection 查詢（不是 collectionGroup）把那一天的全部訊號依
 *  armorScore 排序讀出來——COLLECTION（不是 COLLECTION_GROUP）scope 的單欄
 *  orderBy 是 Firestore 自動索引涵蓋的範圍，不需要額外部署索引。 */
async function fetchLatestReportCandidates_() {
  const db = admin.firestore();
  const latestSnap = await db.collectionGroup('signals').orderBy('date', 'desc').limit(1).get();
  if (latestSnap.empty) {
    throw new HttpsError('failed-precondition', '目前沒有任何戰報資料，請先產生一次戰報。');
  }
  const latestDate = latestSnap.docs[0].data().date;
  const snap = await db.collection('reports').doc(latestDate).collection('signals').orderBy('armorScore', 'desc').get();
  const candidates = snap.docs.map(function (d) { return d.data(); });
  if (candidates.length === 0) {
    throw new HttpsError('failed-precondition', '最新一次戰報沒有任何候選股票可以比較。');
  }
  return { latestDate: latestDate, candidates: candidates };
}

/** Top3 橫向推薦的核心邏輯（不含 onCall 的 auth 驗證）——`exports.runAiTopPicks`
 *  （手動「重新掃描 Top3」按鈕）跟 `runDailyAiDiagnosisForTopPicks_`（每日排程）
 *  共用。跟單檔深度診斷不同，`diagnosisType: 'top3'` 這筆文件的
 *  `armorScore`/`strategy`/`verdict` 都是空值——這是「全市場橫向比較」的單一
 *  結論，不是某一檔股票的診斷，`code` 固定存常數 `'TOP3'`，文件 ID 用日期
 *  區分（同一天重跑會覆蓋同一筆，不同天各自留一筆歷史）。 */
async function runTopPicksCore_(appConfig, candidatesResult) {
  const timestampLabel = utilsLib.timestampLabelTaipei_();
  const userPrompt = aiDiagnosisLib.buildTopPicksPrompt_(candidatesResult.candidates, timestampLabel);
  const provider = appConfig.aiProvider === 'gemini' ? 'gemini' : 'claude';
  const llmResult = await callLlm_(aiDiagnosisLib.AI_TOP_PICKS_SYSTEM_PROMPT, userPrompt, provider, {
    claude: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY
  });
  const cost = aiDiagnosisLib.calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens, {
    cacheCreationInputTokens: llmResult.cacheCreationInputTokens,
    cacheReadInputTokens: llmResult.cacheReadInputTokens
  }, appConfig.pricing);

  const record = {
    date: candidatesResult.latestDate,
    code: 'TOP3',
    name: '（全市場橫向比較）',
    armorScore: null,
    strategy: '',
    verdict: '',
    diagnosisType: 'top3',
    content: llmResult.text,
    timestamp: timestampLabel
  };
  await admin.firestore().collection('ai_diagnosis').doc('TOP3_' + candidatesResult.latestDate + '_top3').set(record);
  await logAiUsage_('TOP3_SCAN', llmResult, cost, timestampLabel);
  await logRun_('AI Top3 推薦', '成功', '掃描 ' + candidatesResult.candidates.length + ' 檔候選（' + candidatesResult.latestDate + '）', 0);

  return Object.assign({}, record, {
    cost: utilsLib.round_(cost, 4),
    candidateCount: candidatesResult.candidates.length,
    groundingDisabled: !!llmResult.groundingDisabled
  });
}

/** 前端「重新掃描 Top3」按鈕：對最新一次戰報的全部候選做一次橫向比較，回傳
 *  結果（前端也可以直接用 Firestore client SDK 讀 `ai_diagnosis` 的快取結果，
 *  不用每次打開頁面就呼叫這支——見 Dashboard 的 Top3PicksCard.vue）。 */
exports.runAiTopPicks = onCall(
  Object.assign({ secrets: ['GEMINI_API_KEY'] }, RUNTIME_OPTS_),
  async function (request) {
    assertOwnerAuth_(request);
    const startTime = Date.now();
    await writeJobStatus_('aiTopPicks', { status: 'running', startedAt: startTime, error: null });
    try {
      const appConfig = await fetchAppConfig_();
      const candidatesResult = await fetchLatestReportCandidates_();
      const result = await runTopPicksCore_(appConfig, candidatesResult);
      await writeJobStatus_('aiTopPicks', { status: 'succeeded', finishedAt: Date.now(), error: null });
      return result;
    } catch (e) {
      await logRun_('AI Top3 推薦', '失敗', String(e.message || e), 0);
      await writeJobStatus_('aiTopPicks', { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
      throw e;
    }
  }
);

/** 每日排程用：先用 AI 橫向比較（不查財報）從候選清單篩出一份大小為 topN 的
 *  名單，取出代號後，把這份名單「全部」送進 `runDeepDiagnosisForCode_` 做完整
 *  深度診斷——跟 apps-script 版 runAiShortlist_ + extractShortlistCodes_ +
 *  runAiDiagnosis(codes) 同一套三段邏輯。單一股票深度診斷失敗（例如 Goodinfo
 *  抓取逾時）不影響名單裡其他股票，逐檔包 try/catch，跟 apps-script 版
 *  runAiDiagnosis 內部迴圈的錯誤隔離粒度一致。 */
async function runShortlistAndDeepDiagnosis_(appConfig, candidatesResult, topN) {
  const timestampLabel = utilsLib.timestampLabelTaipei_();
  const systemPrompt = aiDiagnosisLib.AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE.replace(/__COUNT__/g, String(topN));
  const userPrompt = aiDiagnosisLib.buildShortlistPrompt_(candidatesResult.candidates, timestampLabel, topN);
  const provider = appConfig.aiProvider === 'gemini' ? 'gemini' : 'claude';
  const llmResult = await callLlm_(systemPrompt, userPrompt, provider, {
    claude: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY
  });

  const codes = aiDiagnosisLib.extractShortlistCodes_(llmResult.text, topN);
  if (codes.length === 0) {
    throw new Error('無法從 AI 候選名單中取出股票代號，原始回應開頭：「' +
      String(llmResult.text || '').slice(0, 150).replace(/\n/g, ' ') + '」');
  }

  const shortlistCost = aiDiagnosisLib.calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens, {
    cacheCreationInputTokens: llmResult.cacheCreationInputTokens,
    cacheReadInputTokens: llmResult.cacheReadInputTokens
  }, appConfig.pricing);
  await logAiUsage_('SHORTLIST_SCAN', llmResult, shortlistCost, timestampLabel);
  await logRun_('AI每日候選名單', '成功', '掃描 ' + candidatesResult.candidates.length + ' 檔候選，篩出 ' + codes.length + ' 檔：' + codes.join('、'), 0);

  const results = [];
  for (const code of codes) {
    try {
      results.push(await runDeepDiagnosisForCode_(appConfig, code));
    } catch (e) {
      results.push({ ok: false, code: code, error: String(e.message || e) });
    }
  }
  return { shortlistText: llmResult.text, codes: codes, results: results };
}

/**
 * 每日排程呼叫（`generateDailyReportScheduled` 寫完戰報之後，如果
 * `config/app.aiDailyEnabled` 開著）：Top3 橫向推薦跟候選名單橫向比較+逐檔深度
 * 診斷是兩件各自獨立、互不影響的事，各自包 try/catch，一邊失敗不影響另一邊——
 * 跟 apps-script 版 runDailyAiDiagnosisForTopPicks 同一個設計。Top3 只有一次
 * LLM 呼叫、耗時固定且短，優先跑完；候選名單橫向比較+逐檔深度診斷耗時隨
 * `aiDailyTopN` 增加，放在後面。兩邊共用同一次 `fetchLatestReportCandidates_`
 * 讀取結果，不用各自重讀重排一次 Reports。
 *
 * 跟 apps-script 版的差異：不帶 `budgetDeadline` 到處檢查提早跳過剩餘代號——
 * 那是 Apps Script 6 分鐘硬性執行上限逼出來的設計，這裡的逾時上限是
 * `generateDailyReportScheduled` 自己宣告的 540 秒，topN 夾在 3~10 的情況下
 * 不會真的撞到，不需要那套複雜度。
 */
async function runDailyAiDiagnosisForTopPicks_(appConfig) {
  let candidatesResult = null;
  try {
    candidatesResult = await fetchLatestReportCandidates_();
  } catch (e) { /* 留給下面兩段各自重讀一次、各自記錄自己的錯誤訊息 */ }

  const topPicks = { ok: false, error: null };
  try {
    const cr = candidatesResult || await fetchLatestReportCandidates_();
    topPicks.ok = true;
    topPicks.result = await runTopPicksCore_(appConfig, cr);
  } catch (e) {
    topPicks.error = String(e.message || e);
  }

  const shortlist = { ok: false, error: null };
  try {
    const cr = candidatesResult || await fetchLatestReportCandidates_();
    const topN = Math.max(3, Math.min(10, appConfig.aiDailyTopN || 5));
    shortlist.ok = true;
    shortlist.result = await runShortlistAndDeepDiagnosis_(appConfig, cr, topN);
  } catch (e) {
    shortlist.error = String(e.message || e);
  }

  return { topPicks: topPicks, shortlist: shortlist };
}

/**
 * data: {code}。對「目前持有中」的一檔股票跑一次持股續抱診斷（diagnosisType='hold'）
 * ——跟 runAiDiagnosis 共用同一套 Goodinfo／TWSE 財報抓取、Claude/Gemini 呼叫、費用
 * 估算邏輯，差別只在：(1) system prompt 換成 AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT
 * （決策基準是體質變化，不是損益），(2) `buildDiagnosisPrompt_` 多帶一個 `holding`
 * 參數（加權平均成本／持有天數／目前損益%，僅供背景參考），(3) 寫入 Firestore 的文件
 * ID 後綴是 `_hold` 不是 `_deep`（同一天同一檔可以同時有深度診斷跟續抱診斷兩筆紀錄，
 * 互不覆蓋，見 firestore/schema.md §4）。
 *
 * code 必須是目前「持有中」的股票——沒有持股就沒有成本/損益可以注入，拋
 * `failed-precondition`，不是模糊的 `INTERNAL`。
 */
exports.runPortfolioHoldDiagnosis = onCall(
  Object.assign({ secrets: ['GEMINI_API_KEY'] }, RUNTIME_OPTS_),
  async function (request) {
    assertOwnerAuth_(request);
    const data = request.data || {};
    if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
    const code = utilsLib.zfill4(String(data.code).trim());
    const startTime = Date.now();
    await writeJobStatus_('aiDiagnosis_' + code, { status: 'running', startedAt: startTime, kind: 'hold', error: null });

    try {
      const [appConfig, lotDocs] = await Promise.all([fetchAppConfig_(), fetchPortfolioLots_()]);
      const portfolioMap = portfolio.buildPortfolioMap_(lotDocs);
      if (!portfolioMap[code]) {
        throw new HttpsError('failed-precondition', '目前沒有持有 ' + code + '，請確認「持股庫存」裡有這一筆持有中的紀錄。');
      }

      const [signalDocs, bqInfo] = await Promise.all([
        fetchSignalHistoryForCode_(code),
        fetchBqInfoForCodes_(appConfig.bigQuery, [code])
      ]);
      const row = signalDocs[0];
      if (!row) {
        throw new HttpsError('not-found', '在戰報裡找不到 ' + code + ' 的資料，請先確認它出現在某一天的戰報中。');
      }
      const latestClose = bqInfo[code] ? bqInfo[code].close : null;
      const holding = buildHoldingInfo_(portfolioMap, code, latestClose);

      const timestampLabel = utilsLib.timestampLabelTaipei_();
      const [goodinfoText, twseDatasets] = await Promise.all([
        fetchGoodinfoText_(code),
        fetchTwseOfficialFinancialsDatasets_()
      ]);
      const twseOfficialText = aiDiagnosisLib.buildTwseOfficialFinancialsTextForCode_(code, twseDatasets);
      const userPrompt = aiDiagnosisLib.buildDiagnosisPrompt_(row, goodinfoText, twseOfficialText, timestampLabel, holding);

      const provider = appConfig.aiProvider === 'gemini' ? 'gemini' : 'claude';
      const llmResult = await callLlm_(aiDiagnosisLib.AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT, userPrompt, provider, {
        claude: process.env.ANTHROPIC_API_KEY,
        gemini: process.env.GEMINI_API_KEY
      });

      const diagnosisText = llmResult.text;
      const verdict = aiDiagnosisLib.extractVerdict_(diagnosisText);
      const cost = aiDiagnosisLib.calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens, {
        cacheCreationInputTokens: llmResult.cacheCreationInputTokens,
        cacheReadInputTokens: llmResult.cacheReadInputTokens
      }, appConfig.pricing);

      const record = {
        date: row.date,
        code: code,
        name: row.name || '',
        armorScore: row.armorScore,
        strategy: row.strategy,
        verdict: verdict,
        diagnosisType: 'hold',
        content: diagnosisText,
        timestamp: timestampLabel
      };
      await admin.firestore().collection('ai_diagnosis').doc(code + '_' + row.date + '_hold').set(record);
      await logAiUsage_(code, llmResult, cost, timestampLabel);
      await logRun_('持股續抱診斷', '成功', code + ' ' + (row.name || '') + ' -> ' + verdict, Date.now() - startTime);
      await writeJobStatus_('aiDiagnosis_' + code, { status: 'succeeded', finishedAt: Date.now(), error: null });

      return Object.assign({}, record, { cost: utilsLib.round_(cost, 4), groundingDisabled: !!llmResult.groundingDisabled });
    } catch (e) {
      await logRun_('持股續抱診斷', '失敗', code + '：' + String(e.message || e), Date.now() - startTime);
      await writeJobStatus_('aiDiagnosis_' + code, { status: 'failed', finishedAt: Date.now(), error: String(e.message || e) });
      throw e;
    }
  }
);

/**
 * 給 Admin 頁面「AI 設定」卡片顯示用：只回傳「有沒有設定」，絕不回傳金鑰本身
 * ——跟 apps-script 版 getAiSettings() 的 hasClaudeKey/hasGeminiKey 同一個
 * 設計。要檢查 `process.env.GEMINI_API_KEY` 有沒有值，一樣要宣告 `secrets`
 * 選項，不然 Secret Manager 的值不會被注入這支函式的執行環境（跟
 * runAiDiagnosis 是分開的兩支函式，各自獨立宣告）。
 *
 * 刻意不宣告 `ANTHROPIC_API_KEY`（理由跟 runAiDiagnosis 同一段說明一致——
 * 目前只用 Gemini，沒必要逼自己建一個不會用到的密鑰只為了讓部署通過），
 * `hasClaudeKey` 固定回傳 `false`，不是因為查過沒設定，是這支函式沒有權限
 * 讀取那個密鑰的值（即使之後真的設定了也一樣會回傳 false，直到把
 * `'ANTHROPIC_API_KEY'` 加回兩支函式的 `secrets` 陣列重新部署）。
 */
exports.getAiKeyStatus = onCall(
  Object.assign({ secrets: ['GEMINI_API_KEY'] }, LIGHT_RUNTIME_OPTS_),
  async function (request) {
    assertOwnerAuth_(request);
    return {
      hasClaudeKey: false,
      hasGeminiKey: !!process.env.GEMINI_API_KEY
    };
  }
);

/**
 * data: {days?}（預設 30）。給 Admin 頁面顯示最近 N 天的 AI 呼叫次數/tokens/
 * 預估費用——跟 apps-script 版 getAiUsageSummary 同一個用途，資料來源換成
 * Firestore 的 `ai_usage` collection（見 `logAiUsage_` 的說明）。只用
 * `.where('date', '>=', cutoffStr)` 單一不等式查詢（不加 orderBy，排序交給
 * `aiUsageLib.buildAiUsageSummary_` 在記憶體裡做）——COLLECTION scope 的
 * 單欄不等式查詢是 Firestore 自動索引涵蓋的範圍，不需要額外部署索引。
 */
exports.getAiUsageSummary = onCall(LIGHT_RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const days = data.days || 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const snap = await admin.firestore().collection('ai_usage').where('date', '>=', cutoffStr).get();
  const records = snap.docs.map(function (d) { return d.data(); });
  const nowDateStr = utilsLib.todayStrTaipei_();
  return aiUsageLib.buildAiUsageSummary_(records, days, nowDateStr);
});
