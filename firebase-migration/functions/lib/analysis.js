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
var shiftN = utils.shiftN;
var rollingMin = utils.rollingMin;
var daysBetween = utils.daysBetween;
var computeWeightedFactorScore_ = require('./factorModel').computeWeightedFactorScore_;
var financialsLib = require('./financials');

/**
 * 可切換的「新進場訊號」篩選邏輯版本（不影響既有持股的止盈/止損判斷，那段邏輯固定不變，
 * 只有「要不要把某檔股票列為新訊號」這件事可以換邏輯）：
 *   rule_v17：現行的規則式門檻——法人參與度排名、量能爆量排名、下跌接手率排名 + 趨勢分數，
 *     完全不看因子迴歸模型，不需要先套用任何模型。
 *   factor_model_rank：完全交給套用中的因子迴歸模型，用「預測抗跌力」在當天全部候選股票裡
 *     的橫斷面排名（見 computePredictedResistanceRanks_）取前段班，不看規則式門檻。
 *   hybrid：先過 rule_v17 的多頭排列 + 流動性門檻，再用模型排名做二次篩選，兩邊都要通過。
 *   early_accumulation：2026-10-13 新增，見下面 classifyEntrySignal_ 裡的完整說明。
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
  },
  early_accumulation: {
    key: 'early_accumulation', label: '🌱 潛伏期（法人逢低接手，趨勢未確立）', needsFactorModel: false,
    description: '法人逢低接手率（IBF_20D）排名前段班，不要求 Trend_Score===2（趨勢還沒確立）——' +
      '比 v17.0 更早進場，抓的是起漲前的吸籌階段，不是起漲後的確認階段；排除完全空頭排列' +
      '（Trend_Score===0）的股票避免接刀，但不需要先套用因子迴歸模型。假突破/續跌風險比' +
      'v17.0 高，屬於較積極的早期訊號，建議先用回測驗證過命中率/勝率再實際使用。'
  },
  composite_accumulation: {
    key: 'composite_accumulation', label: '🧭 綜合吸籌（多因子交叉驗證）', needsFactorModel: false,
    description: '2026-10-13 新增，見下面 classifyEntrySignal_ 的完整說明——跟 early_accumulation ' +
      '同樣不要求 Trend_Score===2，但不只看單一個 IBF_20D 門檻，額外交叉驗證「資金流向是否領先' +
      '價格」（Inst_Accum_Divergence_20D）跟「近期是否還在創新低」（Days_Since_New_Low_Rank），' +
      '三個訊號都過才算命中，訊號雜訊應該比 early_accumulation 少、但命中數也會更少。不需要' +
      '先套用因子迴歸模型。'
  }
};
var SCREENING_STRATEGY_DEFAULT = 'rule_v17';
var FACTOR_MODEL_RANK_TOP_PCT = 0.9; // factor_model_rank：預測抗跌力排名前 10%
var HYBRID_RANK_MIN_PCT = 0.7; // hybrid：規則式門檻過關後，還要排名前 30%
var EARLY_ACCUMULATION_IBF_MIN_PCT = 0.85; // early_accumulation：法人逢低接手率排名門檻，比「🔥 趨勢領航」用的 0.7 更嚴格（這裡是唯一條件，不像趨勢領航還有 Trend_Score===2 一起把關，單獨拿來當門檻要抓得更緊，減少雜訊）

// composite_accumulation 的三個門檻——因為有三個訊號一起交叉驗證（不是單一條件），
// 每個門檻都比 early_accumulation 單獨用 IBF_20D 時（0.85）寬鬆一些，靠「三個都要過」
// 本身來控制雜訊，不是靠單一門檻卡得死死的。
var COMPOSITE_ACCUMULATION_IBF_MIN_PCT = 0.75; // 法人逢低接手率排名門檻
var COMPOSITE_ACCUMULATION_DIVERGENCE_MIN = 0.3; // Inst_Accum_Divergence_20D 門檻：法人資金流向排名要比價格排名高出至少 30 個百分點，代表「資金流向領先價格」
var COMPOSITE_ACCUMULATION_STABILITY_MIN_PCT = 0.3; // Days_Since_New_Low_Rank 門檻：排除「最近才創新低」的最極端一批（不用設得太嚴，early_accumulation 已經有 Trend_Score!==0 把關完全空頭的狀況，這裡只是再加一道更細的穩定度篩選）

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

  if (key === 'early_accumulation') {
    // 2026-10-13 新增：使用者問「趨勢跟隨可以再早一點嗎」——rule_v17／
    // hybrid 都要求 Trend_Score===2（收盤價 > MA20 且 MA20 斜率為正，
    // 趨勢已經確立才進場），這支策略刻意不要求這個，只看法人逢低接手率
    // （IBF_20D_Rank，法人在股價下跌時逆勢買進的比例）是不是排在前段班
    // ——抓的是「法人正在吸籌、但價格還沒噴出來」的起漲前階段，不是
    // 「已經噴出來」的確認階段。唯一的保護是排除 Trend_Score===0（兩個
    // 多頭條件都沒過，等於完全空頭排列）的股票，避免在真正的下跌趨勢中
    // 接刀——Trend_Score===1（只過其中一個條件，例如價格剛站上 MA20 但
    // 均線還沒轉彎、或均線剛轉正但價格還沒站上）才是這支策略真正想抓的
    // 「早期」區間，Trend_Score===2 當然也符合（不特別排除，只是這種
    // 情況下 rule_v17／hybrid 應該已經先篩到了，不是這支策略的主要
    // 增量）。門檻刻意比「🔥 趨勢領航」用的 0.7 更嚴格（0.85，見
    // EARLY_ACCUMULATION_IBF_MIN_PCT 的說明）：那邊有 Trend_Score===2
    // 一起把關，這裡少了趨勢確認這道防線，單一條件要抓得更緊才不會太雜訊。
    var isAccumulating = row.IBF_20D_Rank !== null && row.IBF_20D_Rank >= EARLY_ACCUMULATION_IBF_MIN_PCT;
    var notInFreefall = row.Trend_Score !== 0;
    if (isAccumulating && notInFreefall) {
      return {
        strategy: '🌱 潛伏期', action: '建議：分批佈局（風險較高，趨勢未確立）',
        interpretation: '法人逢低接手率排名前 ' + Math.round((1 - EARLY_ACCUMULATION_IBF_MIN_PCT) * 100) + '%，趨勢尚未確立，較早期訊號'
      };
    }
    return neutral;
  }

  if (key === 'composite_accumulation') {
    // 2026-10-13 新增：使用者問「有沒有更綜合的評估方式」——early_accumulation
    // 只看 IBF_20D_Rank 一個條件，這支策略額外交叉驗證另外兩個訊號，三個都要過：
    //   1. IBF_20D_Rank：法人逢低接手率排名（跟 early_accumulation 同一個因子，
    //      門檻比較寬鬆，因為這裡不是唯一條件）。
    //   2. Inst_Accum_Divergence_20D = Inst_Rank_20D - Price_Rank_20D：過去 20 天
    //      「法人買超金額排名」減去「股價漲跌幅排名」。正值代表法人資金流向排名
    //      領先股價表現排名——法人在買，但價格還沒漲到對應的排名，是「資金流向
    //      領先價格」的訊號，跟 IBF_20D（看逢低接手的頻率）是不同角度：IBF_20D
    //      看的是「下跌日法人進場的比例」，Inst_Accum_Divergence_20D 看的是「20天
    //      累積買超排名 vs 20天累積漲幅排名」有沒有落差。
    //   3. Days_Since_New_Low_Rank：「距離上次創 20 日新低」天數的排名，越高代表
    //      相對市場而言越久沒創新低、價格越穩定。跟 Trend_Score!==0（排除完全空頭
    //      排列）是不同粒度的保護——Trend_Score 看的是 MA20 位置跟斜率這種趨勢
    //      指標，這裡直接看「最近有沒有實際創新低」，兩個一起用比單獨用任何一個
    //      更不容易在真正探底的過程中誤判成「已經開始吸籌」。
    // 三個欄位都可能是 null（算不出來時，Inst_Accum_Divergence_20D 的兩個輸入在
    // computeFactors_ 已經 COALESCE 成 0.5，不會是 null；但 Days_Since_New_Low_Rank
    // 跟 IBF_20D_Rank 仍可能是 null），一律當成沒過門檻，不拋錯。
    var compositeIbfOk = row.IBF_20D_Rank !== null && row.IBF_20D_Rank >= COMPOSITE_ACCUMULATION_IBF_MIN_PCT;
    var compositeDivergenceOk = row.Inst_Accum_Divergence_20D !== null && row.Inst_Accum_Divergence_20D !== undefined &&
      row.Inst_Accum_Divergence_20D >= COMPOSITE_ACCUMULATION_DIVERGENCE_MIN;
    var compositeStabilityOk = row.Days_Since_New_Low_Rank !== null && row.Days_Since_New_Low_Rank !== undefined &&
      row.Days_Since_New_Low_Rank >= COMPOSITE_ACCUMULATION_STABILITY_MIN_PCT;
    var compositeNotInFreefall = row.Trend_Score !== 0;

    if (compositeIbfOk && compositeDivergenceOk && compositeStabilityOk && compositeNotInFreefall) {
      return {
        strategy: '🧭 綜合吸籌', action: '建議：分批佈局（多因子交叉驗證，趨勢未確立）',
        interpretation: '法人逢低接手率排名 ' + Math.round(row.IBF_20D_Rank * 100) + '%；資金流向領先價格 ' +
          Math.round(row.Inst_Accum_Divergence_20D * 100) + ' 個百分點（法人買超排名 ' +
          Math.round(row.Inst_Rank_20D * 100) + '% − 漲幅排名 ' + Math.round(row.Price_Rank_20D * 100) +
          '%）；近期穩定度排名 ' + Math.round(row.Days_Since_New_Low_Rank * 100) + '%（距上次創新低天數）'
      };
    }
    return neutral;
  }

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
 *
 * financialsIndex（2026-10-08 新增，選填）：
 * `{quarterlyByCode, monthlyByCode}`，由呼叫端用
 * `financialsLib.buildAsOfIndex_` 分別對 `financials_quarterly`／
 * `financials_monthly` 建好的 as-of 索引（見該函式的說明）。帶了這個參數
 * 才會補上 `Fundamental_*` 這 10 個欄位（余博邏輯延伸的基本面因子，見
 * `config.BQ_FEATURE_TO_ANALYSIS_FIELD` 上方的說明）；不帶（既有呼叫端，
 * 例如 parity 測試用 apps-script 原版比對）就完全不補，行為跟這個參數
 * 加進來之前一模一樣，不影響既有的 38 個因子欄位。
 */
function computeFactors_(rows, portfolioMap, financialsIndex) {
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

    // 2026-10-13 新增，composite_accumulation 策略用——仿照
    // lib/factorRegression.js buildFeatureViewSql_ 訓練用的 SQL 定義（見該檔案
    // 開頭註解的 price_change_20d/low20d/is_new_low/days_since_new_low_raw），
    // 但這裡刻意不要求 BigQuery SQL 的「視窗不滿也照算」語意，沿用這個檔案裡
    // 其他 rolling 因子（MA20/MA60/Vol_MA20）一致的 min_periods=window 慣例
    // （rollingSum/rollingMin 視窗不滿就是 null）——這支是給即時戰報/回測用的
    // 即時計算，不是餵進 BQML 訓練，不需要跟 SQL 逐行對齊，維持跟這個檔案其他
    // 因子一致的慣例比較重要。
    var instNetSum20D = rollingSum(instNetArr, 20);
    var close20DaysAgo = shiftN(closeArr, 20);
    var priceChange20D = closeArr.map(function (c, i) {
      var prev = close20DaysAgo[i];
      if (prev === null || prev === undefined || prev === 0) return null;
      return c / prev - 1;
    });
    var low20D = rollingMin(closeArr, 20);
    var isNewLow = closeArr.map(function (c, i) { return (low20D[i] !== null && c === low20D[i]) ? 1 : 0; });
    var daysSinceNewLowRaw = (function () {
      var out = new Array(group.length).fill(null);
      var lastNewLowDateStr = null;
      for (var gi = 0; gi < group.length; gi++) {
        var dateStr = normalizeDateStr(group[gi]['日期']);
        if (isNewLow[gi]) lastNewLowDateStr = dateStr;
        if (lastNewLowDateStr !== null) out[gi] = daysBetween(dateStr, lastNewLowDateStr);
      }
      return out;
    })();

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
      group[i].Inst_Net_Sum_20D = instNetSum20D[i];
      group[i].Price_Change_20D = priceChange20D[i];
      group[i].Days_Since_New_Low_Raw = daysSinceNewLowRaw[i];

      if (financialsIndex) {
        var dateStr = normalizeDateStr(group[i]['日期']);
        var q = financialsIndex.quarterlyByCode ? financialsLib.lookupAsOf_(financialsIndex.quarterlyByCode, code, dateStr) : null;
        var m = financialsIndex.monthlyByCode ? financialsLib.lookupAsOf_(financialsIndex.monthlyByCode, code, dateStr) : null;
        group[i].Fundamental_Gross_Margin_Pct = q ? q.grossMarginPct : null;
        group[i].Fundamental_Operating_Margin_Pct = q ? q.operatingMarginPct : null;
        group[i].Fundamental_Net_Margin_Pct = q ? q.netMarginPct : null;
        group[i].Fundamental_Roe_Pct = q ? q.roePct : null;
        group[i].Fundamental_Gross_Margin_Streak = q ? q.grossMarginStreak : null;
        group[i].Fundamental_Operating_Margin_Streak = q ? q.operatingMarginStreak : null;
        group[i].Fundamental_Net_Margin_Streak = q ? q.netMarginStreak : null;
        group[i].Fundamental_Roe_Streak = q ? q.roeStreak : null;
        group[i].Fundamental_Revenue_Yoy_Pct = m ? m.revenueYoyPct : null;
        group[i].Fundamental_Revenue_Growth_Streak = m ? m.revenueGrowthStreak : null;
      }
    }
  });

  // 橫斷面（同一天所有股票互相比較）百分位排名 + Armor_Score
  var byDate = groupBy(rows, function (r) { return normalizeDateStr(r['日期']); });
  byDate.forEach(function (dayRows) {
    var instPartRank = percentRank(dayRows, 'Inst_Part_MA5');
    var ibfRank = percentRank(dayRows, 'IBF_20D');
    var volRatioRank = percentRank(dayRows, 'Vol_Ratio');
    // composite_accumulation 策略用的三個橫斷面排名。percentRank 對算不出來的
    // （null）回 null，這裡仿照 lib/factorRegression.js buildFeatureViewSql_ 的
    // SQL 版本「原始值是 NULL 就直接把排名 COALESCE 成 0.5（中性值）」，不讓
    // 單一股票因為資料不足（例如剛上市不到 20 天）就在排名時被當成缺值排除
    // 掉——用「視為中性」取代「不列入排名」，跟 SQL 那邊特意采用的設計一致。
    var instSum20DRank = percentRank(dayRows, 'Inst_Net_Sum_20D');
    var priceChange20DRank = percentRank(dayRows, 'Price_Change_20D');
    var daysSinceNewLowRank = percentRank(dayRows, 'Days_Since_New_Low_Raw');
    for (var i = 0; i < dayRows.length; i++) {
      dayRows[i].Inst_Part_Rank = instPartRank[i];
      dayRows[i].IBF_20D_Rank = ibfRank[i];
      dayRows[i].Vol_Ratio_Rank = volRatioRank[i];
      dayRows[i].Inst_Rank_20D = instSum20DRank[i] === null ? 0.5 : instSum20DRank[i];
      dayRows[i].Price_Rank_20D = priceChange20DRank[i] === null ? 0.5 : priceChange20DRank[i];
      dayRows[i].Days_Since_New_Low_Rank = daysSinceNewLowRank[i] === null ? 0.5 : daysSinceNewLowRank[i];
      dayRows[i].Inst_Accum_Divergence_20D = dayRows[i].Inst_Rank_20D - dayRows[i].Price_Rank_20D;
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
