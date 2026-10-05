/**
 * analysis.js
 * 戰報核心計算邏輯，從 apps-script/src/Analysis.gs 複製過來（只複製純函式——
 * 讀 History／寫 Reports、背景 job 狀態機、Script Properties、xlsx 匯出到
 * Drive 這些 I/O 都不在這裡，Firebase 版改讀 BigQuery（History 不動）、寫
 * Firestore `reports/{date}/signals/{code}`（見 firestore/schema.md §3），
 * 由呼叫這個模組的 Cloud Function 自己處理，不屬於這份純運算核心的職責）。
 *
 * 複製時機：2026-10-05，對照 apps-script/src/Analysis.gs 當時的內容。
 * firebase-migration/functions/test/parity.test.js 在複製當下對照過兩邊算出
 * 來的結果完全一致；之後要調整戰報計算邏輯，直接改這份檔案，不用（也不該）
 * 回頭改 Apps Script 那份——兩邊從今天起是兩份獨立維護的程式碼，不會再自動
 * 同步。
 */
var utils = require('./utils');
var config = require('./config');
var zfill4 = utils.zfill4;
var toNumber = utils.toNumber;
var groupBy = utils.groupBy;
var sortRows = utils.sortRows;
var normalizeDateStr = utils.normalizeDateStr;
var rollingMean = utils.rollingMean;
var rollingSum = utils.rollingSum;
var pctChange = utils.pctChange;
var diffN = utils.diffN;
var expandingMax = utils.expandingMax;
var expandingMaxFromIndex = utils.expandingMaxFromIndex;
var percentRank = utils.percentRank;
var computeWeightedFactorScore_ = require('./factorModel').computeWeightedFactorScore_;

/**
 * 可切換的「新進場訊號」篩選邏輯版本（不影響既有持股的止盈/止損判斷，那段邏輯固定不變，
 * 只有「要不要把某檔股票列為新訊號」這件事可以換邏輯）：
 *   rule_v17：現行的規則式門檻——法人參與度排名、量能爆量排名、下跌接手率排名 + 趨勢分數，
 *     完全不看因子迴歸模型，不需要先套用任何模型。
 *   factor_model_rank：完全交給套用中的因子迴歸模型，用「預測抗跌力」在當天全部候選股票裡
 *     的橫斷面排名（見 computePredictedResistanceRanks_）取前段班，不看規則式門檻。
 *   hybrid：先過 rule_v17 的多頭排列 + 流動性門檻，再用模型排名做二次篩選，兩邊都要通過。
 */
var SCREENING_STRATEGIES = {
  rule_v17: {
    key: 'rule_v17', label: 'v17.0 規則式門檻（現行）', needsFactorModel: false,
    description: '法人參與度、成交量爆量、下跌接手率排名 + 趨勢分數的規則式門檻，完全不依賴因子迴歸模型。'
  },
  factor_model_rank: {
    key: 'factor_model_rank', label: '因子模型排名精選', needsFactorModel: true,
    description: '不看規則式門檻，完全依套用中的因子迴歸模型（抗跌力）在當天全部候選裡的排名，取前 10%。'
  },
  hybrid: {
    key: 'hybrid', label: '規則式門檻＋模型排名混合', needsFactorModel: true,
    description: '先過 v17.0 規則式門檻，再用因子模型排名做二次篩選（前 30%），兩邊都要通過才算訊號。'
  }
};
var SCREENING_STRATEGY_DEFAULT = 'rule_v17';
var FACTOR_MODEL_RANK_TOP_PCT = 0.9; // factor_model_rank：預測抗跌力排名前 10%
var HYBRID_RANK_MIN_PCT = 0.7; // hybrid：規則式門檻過關後，還要排名前 30%

/**
 * 幫 rows 補上「因子模型預測抗跌力」以及它在「同一天」全部候選股票裡的橫斷面排名
 * （PredictedResistance_Rank，0~1，給 factor_model_rank／hybrid 兩種篩選邏輯用）。
 * 沒有套用中的抗跌力模型時，兩個欄位全部是 null，呼叫端要自己檢查、不能假裝算得出來。
 */
function computePredictedResistanceRanks_(rows, appliedFactorModels) {
  if (!appliedFactorModels || !appliedFactorModels.downsideResistance) {
    rows.forEach(function (r) { r.PredictedDownsideResistance = null; r.PredictedResistance_Rank = null; });
    return rows;
  }
  var weights = appliedFactorModels.downsideResistance.weights;
  rows.forEach(function (r) { r.PredictedDownsideResistance = computeWeightedFactorScore_(r, weights); });
  var byDate = groupBy(rows, function (r) { return normalizeDateStr(r['日期']); });
  byDate.forEach(function (dayRows) {
    var ranks = percentRank(dayRows, 'PredictedDownsideResistance');
    for (var i = 0; i < dayRows.length; i++) dayRows[i].PredictedResistance_Rank = ranks[i];
  });
  return rows;
}

/**
 * 「新進場訊號」判斷邏輯本身，依 strategyKey 選擇要套用哪一版（見 SCREENING_STRATEGIES
 * 的說明）。strategyKey 沒帶或不合法時退回 rule_v17。
 */
function classifyEntrySignal_(row, strategyKey) {
  var neutral = { strategy: 'Neutral', action: '觀望', interpretation: '盤整中' };
  if (row['成交金額'] < config.STRATEGY.LIQUIDITY_MIN) return neutral;

  var isUpward = row.Trend_Score === 2;
  var isParticipationHigh = row.Inst_Part_Rank !== null && row.Inst_Part_Rank >= 0.8;
  var isVolSpark = row.Vol_Ratio_Rank !== null && row.Vol_Ratio_Rank >= 0.85;

  var ruleHit = null;
  if (isUpward && isParticipationHigh && isVolSpark) {
    ruleHit = { strategy: '🚀 趨勢啟動', action: '建議：現價買入', interpretation: '法人密度極高且多頭慣性確立' };
  } else if (isUpward && row.IBF_20D_Rank !== null && row.IBF_20D_Rank >= 0.7) {
    ruleHit = { strategy: '🔥 趨勢領航', action: '建議：分批進場', interpretation: '多頭排列且法人支撐強勁' };
  }

  var key = SCREENING_STRATEGIES[strategyKey] ? strategyKey : SCREENING_STRATEGY_DEFAULT;
  if (key === 'rule_v17') return ruleHit || neutral;

  var rank = row.PredictedResistance_Rank;
  var hasRank = rank !== null && rank !== undefined;

  if (key === 'factor_model_rank') {
    if (hasRank && rank >= FACTOR_MODEL_RANK_TOP_PCT) {
      return {
        strategy: '🚀 趨勢啟動', action: '建議：現價買入',
        interpretation: '因子模型預測抗跌力排名前 ' + Math.round((1 - FACTOR_MODEL_RANK_TOP_PCT) * 100) + '%（模型精選，非規則式門檻）'
      };
    }
    return neutral;
  }

  // hybrid：規則式門檻跟模型排名兩邊都要通過
  if (ruleHit && hasRank && rank >= HYBRID_RANK_MIN_PCT) {
    return {
      strategy: ruleHit.strategy, action: ruleHit.action,
      interpretation: ruleHit.interpretation + '，且因子模型排名前 ' + Math.round((1 - HYBRID_RANK_MIN_PCT) * 100) + '%'
    };
  }
  return neutral;
}

/** strategyKey 沒帶時退回 SCREENING_STRATEGY_DEFAULT（rule_v17）——只有既有持股
 *  （🛡️/🛑）的判斷固定不變，新進場訊號才走可切換的邏輯。 */
function diagnoseRow_(row, portfolioMap, strategyKey) {
  var url = 'https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=' + row['證券代號'];
  var holding = portfolioMap[row['證券代號']];

  if (holding) {
    var peak = row.Adjusted_Peak;
    var drawdown = peak ? (peak - row['收盤價']) / peak : 0;
    var strategy, action, interpretation;
    if (drawdown >= config.STRATEGY.TRAILING_STOP_PERCENT) {
      strategy = '🛑 止盈/止損';
      action = '建議：賣出';
      interpretation = '高點回落 ' + (drawdown * 100).toFixed(1) + '% (警戒)';
    } else {
      strategy = '🛡️ 持股守護';
      action = '建議：續抱';
      var profit = holding.cost ? (row['收盤價'] - holding.cost) / holding.cost : 0;
      interpretation = '趨勢持穩 | 損益: ' + (profit * 100).toFixed(1) + '%';
    }
    return { strategy: strategy, action: action, interpretation: interpretation, url: url, peak: row.Adjusted_Peak };
  }

  var entry = classifyEntrySignal_(row, strategyKey);
  return { strategy: entry.strategy, action: entry.action, interpretation: entry.interpretation, url: url, peak: row.Adjusted_Peak };
}

/**
 * 核心計算：對輸入的 History 列（未必是全部歷史，可以是任意子集）
 * 依 證券代號 分組計算所有 rolling 因子與 Armor_Score，並回傳補齊欄位後的列陣列（依原順序不保證）。
 * portfolioMap: {code: {cost, buyDate}}。
 */
function computeFactors_(rows, portfolioMap) {
  rows.forEach(function (r) {
    r['證券代號'] = zfill4(String(r['證券代號']).trim());
    config.HISTORY_NUMERIC_COLUMNS.forEach(function (c) { r[c] = toNumber(r[c]); });
  });
  rows = rows.filter(function (r) { return r['證券代號'].length === 4; });
  rows = sortRows(rows, [
    ['證券代號', 'asc'],
    [function (r) { return normalizeDateStr(r['日期']); }, 'asc']
  ]);

  var byCode = groupBy(rows, function (r) { return r['證券代號']; });
  byCode.forEach(function (group, code) {
    var closeArr = group.map(function (r) { return r['收盤價']; });
    var volArr = group.map(function (r) { return r['成交股數']; });
    var instNetArr = group.map(function (r) { return r['投信'] + r['外資'] + r['自營商']; });
    var instParticipation = group.map(function (r) {
      var vol = r['成交股數'];
      if (!vol) return null;
      return (Math.abs(r['投信']) + Math.abs(r['外資']) + Math.abs(r['自營商'])) / vol;
    });
    var instPartMA5 = rollingMean(instParticipation, 5);

    var dailyReturn = pctChange(closeArr);
    var isDrop = dailyReturn.map(function (v) { return (v !== null && v < 0) ? 1 : 0; });
    var isInstBuyOnDrop = isDrop.map(function (v, i) { return (v === 1 && instNetArr[i] > 0) ? 1 : 0; });
    var dropCount20 = rollingSum(isDrop, 20);
    var buyOnDrop20 = rollingSum(isInstBuyOnDrop, 20);
    var ibf20 = dropCount20.map(function (dc, i) {
      if (!dc) return 0; // dropCount 為 null 或 0 都 fillna(0)
      return buyOnDrop20[i] / dc;
    });

    var ma20 = rollingMean(closeArr, 20);
    var ma20Slope = diffN(ma20, 3);
    var trendScore = closeArr.map(function (c, i) {
      var s = 0;
      if (ma20[i] !== null && c > ma20[i]) s += 1;
      if (ma20Slope[i] !== null && ma20Slope[i] > 0) s += 1;
      return s;
    });

    var volMA20 = rollingMean(volArr, 20);
    var volRatio = volArr.map(function (v, i) { return volMA20[i] ? v / volMA20[i] : null; });

    var ma60 = rollingMean(closeArr, 60);
    var bias60 = closeArr.map(function (c, i) { return ma60[i] ? (c - ma60[i]) / ma60[i] : null; });

    var holding = portfolioMap[code];
    var adjustedPeak;
    if (holding && holding.buyDate) {
      var dates = group.map(function (r) { return normalizeDateStr(r['日期']); });
      var startIdx = dates.findIndex(function (d) { return d >= holding.buyDate; });
      if (startIdx === -1) startIdx = dates.length;
      adjustedPeak = expandingMaxFromIndex(closeArr, startIdx, holding.cost);
    } else {
      adjustedPeak = expandingMax(closeArr);
    }

    for (var i = 0; i < group.length; i++) {
      group[i].Inst_Net = instNetArr[i];
      group[i].Inst_Participation = instParticipation[i];
      group[i].Inst_Part_MA5 = instPartMA5[i];
      group[i].IBF_20D = ibf20[i];
      group[i].Trend_Score = trendScore[i];
      group[i].Vol_MA20 = volMA20[i];
      group[i].Vol_Ratio = volRatio[i];
      group[i].MA20 = ma20[i];
      group[i].MA20_Slope = ma20Slope[i];
      group[i].MA60 = ma60[i];
      group[i].BIAS_60 = bias60[i];
      group[i].Adjusted_Peak = adjustedPeak[i];
      group[i].Daily_Return = dailyReturn[i];
      group[i].Is_Drop = isDrop[i];
      group[i].Is_Inst_Buy_On_Drop = isInstBuyOnDrop[i];
    }
  });

  // 橫斷面（同一天所有股票互相比較）百分位排名 + Armor_Score
  var byDate = groupBy(rows, function (r) { return normalizeDateStr(r['日期']); });
  byDate.forEach(function (dayRows) {
    var instPartRank = percentRank(dayRows, 'Inst_Part_MA5');
    var ibfRank = percentRank(dayRows, 'IBF_20D');
    var volRatioRank = percentRank(dayRows, 'Vol_Ratio');
    for (var i = 0; i < dayRows.length; i++) {
      dayRows[i].Inst_Part_Rank = instPartRank[i];
      dayRows[i].IBF_20D_Rank = ibfRank[i];
      dayRows[i].Vol_Ratio_Rank = volRatioRank[i];
      var t = dayRows[i].Trend_Score;
      var parts = [instPartRank[i], ibfRank[i], volRatioRank[i], t];
      var hasNull = parts.some(function (p) { return p === null || p === undefined; });
      dayRows[i].Armor_Score = hasNull ? null :
        Math.round((instPartRank[i] * 45 + ibfRank[i] * 30 + volRatioRank[i] * 15 + t * 10) * 10) / 10;
    }
  });

  return rows;
}

/** 回報「這份戰報實際用了哪個區間的歷史資料」：以戰報日期為基準往前推
 *  ANALYSIS_LOOKBACK_DAYS 天（MA60/rolling 因子的回看視窗）。 */
function computeLookbackStartStr_(latestDateStr) {
  var d = new Date(latestDateStr + 'T00:00:00');
  d.setDate(d.getDate() - config.ANALYSIS_LOOKBACK_DAYS);
  return normalizeDateStr(d);
}

/** 組出跟原本 Colab v17.0 to_excel() 一致的完整欄位列（見 config.FULL_REPORT_COLUMNS）。 */
function buildFullReportRow_(r, diag) {
  var diagFields = {
    '操作策略': diag.strategy,
    '建議動作': diag.action,
    '實相解讀': diag.interpretation,
    '監控連結': diag.url,
    '參考最高價': diag.peak
  };
  var row = {};
  config.FULL_REPORT_COLUMNS.forEach(function (col) {
    row[col] = diagFields.hasOwnProperty(col) ? diagFields[col] : r[col];
  });
  return row;
}

/**
 * 純函式：對「已經算完因子、篩到最新一天」的 scanRows 統計篩選漏斗每一關卡掉多少檔股票。
 */
function computeScreeningStats_(scanRows, portfolioMap, latestDateStr) {
  var stats = {
    latestDate: latestDateStr,
    totalStocks: scanRows.length,
    holdingCount: 0,
    liquidityPass: 0,
    upwardTrend: 0,
    highInstParticipation: 0,
    volumeSpark: 0,
    breakoutMatches: 0,
    ibfHighWithUpward: 0,
    nullInstPartRank: 0,
    nullVolRatioRank: 0,
    nullIbfRank: 0
  };

  scanRows.forEach(function (r) {
    if (portfolioMap[r['證券代號']]) { stats.holdingCount++; return; } // 持股一律有訊號（續抱/止損），不算在篩選漏斗裡
    if (r['成交金額'] >= config.STRATEGY.LIQUIDITY_MIN) stats.liquidityPass++;
    var isUpward = r.Trend_Score === 2;
    if (isUpward) stats.upwardTrend++;

    if (r.Inst_Part_Rank === null || r.Inst_Part_Rank === undefined) stats.nullInstPartRank++;
    else if (r.Inst_Part_Rank >= 0.8) stats.highInstParticipation++;

    if (r.Vol_Ratio_Rank === null || r.Vol_Ratio_Rank === undefined) stats.nullVolRatioRank++;
    else if (r.Vol_Ratio_Rank >= 0.85) stats.volumeSpark++;

    if (r.IBF_20D_Rank === null || r.IBF_20D_Rank === undefined) stats.nullIbfRank++;
    else if (isUpward && r.IBF_20D_Rank >= 0.7) stats.ibfHighWithUpward++;

    var isParticipationHigh = r.Inst_Part_Rank !== null && r.Inst_Part_Rank !== undefined && r.Inst_Part_Rank >= 0.8;
    var isVolSpark = r.Vol_Ratio_Rank !== null && r.Vol_Ratio_Rank !== undefined && r.Vol_Ratio_Rank >= 0.85;
    if (r['成交金額'] >= config.STRATEGY.LIQUIDITY_MIN && isUpward && isParticipationHigh && isVolSpark) stats.breakoutMatches++;
  });

  return stats;
}

/** 把 computeScreeningStats_ 算出來的具名欄位轉成一份「有順序的關卡清單」，純粹給顯示用。 */
function screeningFunnelStages_(stats) {
  return [
    { label: '掃描到的股票數（含持股）', count: stats.totalStocks, note: stats.holdingCount ? stats.holdingCount + ' 檔是持股，不計入下面漏斗' : '' },
    { label: '成交金額達門檻', count: stats.liquidityPass, note: '' },
    { label: '多頭排列（Trend_Score=2）', count: stats.upwardTrend, note: '' },
    { label: '法人參與度前20%', count: stats.highInstParticipation, note: stats.nullInstPartRank ? stats.nullInstPartRank + ' 檔無法計算' : '' },
    { label: '量能前15%', count: stats.volumeSpark, note: stats.nullVolRatioRank ? stats.nullVolRatioRank + ' 檔無法計算' : '' },
    { label: '同時符合「趨勢啟動」三條件', count: stats.breakoutMatches, note: '' },
    { label: '多頭+法人逢低承接前30%（「趨勢領航」）', count: stats.ibfHighWithUpward, note: stats.nullIbfRank ? stats.nullIbfRank + ' 檔無法計算' : '' }
  ];
}

module.exports = {
  SCREENING_STRATEGIES: SCREENING_STRATEGIES,
  SCREENING_STRATEGY_DEFAULT: SCREENING_STRATEGY_DEFAULT,
  FACTOR_MODEL_RANK_TOP_PCT: FACTOR_MODEL_RANK_TOP_PCT,
  HYBRID_RANK_MIN_PCT: HYBRID_RANK_MIN_PCT,
  computePredictedResistanceRanks_: computePredictedResistanceRanks_,
  classifyEntrySignal_: classifyEntrySignal_,
  diagnoseRow_: diagnoseRow_,
  computeFactors_: computeFactors_,
  computeLookbackStartStr_: computeLookbackStartStr_,
  buildFullReportRow_: buildFullReportRow_,
  computeScreeningStats_: computeScreeningStats_,
  screeningFunnelStages_: screeningFunnelStages_
};
