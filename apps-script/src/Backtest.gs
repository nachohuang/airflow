/**
 * Backtest.gs
 * v17.0 策略歷史驗證：直接重用 Analysis.gs 的 computeFactors_()／diagnoseRow_()——
 * 跟「戰報與個股」算出來的因子與進場訊號用的是同一套邏輯，不是另一套近似的舊版規則，
 * 回測結果才真的能反映「如果我照著這套策略下單，過去這段期間表現如何」。
 *
 * 前身是對應 Colab Cell 5「v16.10 Alpha Backtest」的獨立規則（WIP/WIN 量化因子、單一進場日），
 * 跟目前戰報用的 v17.0 邏輯是兩套完全不同的篩選條件，回測結果沒辦法套用到戰報上，
 * 已改用下面這套跟 v17.0 對齊的版本取代。
 */

var BACKTEST_V17_TARGET_DEFAULT = 5; // 目標報酬（%），達到就視為 🎯 達標出場
var BACKTEST_V17_MAX_HOLD_DAYS = 40; // 進場後最多追蹤幾個「交易日」，避免長期不出場的訊號把回測拖到跑不完
var BACKTEST_V17_MAX_RANGE_DAYS = 60; // 進場區間（起訖日相差的日曆天數）上限，避免單次背景工作要處理的資料量爆炸

/**
 * 模擬「在 track[entryIdx] 那天收盤價進場」之後會發生什麼事：用跟正式戰報完全一樣的出場規則
 * （見 Analysis.gs diagnoseRow_ 對既有持股的「🛑 止盈/止損」判斷——從進場後的最高價回落
 * trailingStopPct 就出場）逐日往前追蹤，直到達到目標報酬、觸發停損，或追蹤天數/資料用完為止。
 * track 是同一檔股票依日期排序好的列陣列（每列至少有「日期」「收盤價」）。
 * 抽成獨立純函式方便測試，不用真的接 Sheets/BigQuery。
 */
function simulateTradeForward_(track, entryIdx, targetProfitPct, trailingStopPct, maxHoldDays) {
  var entryPrice = toNumber(track[entryIdx]['收盤價']);
  if (!entryPrice) return null;

  var peakPrice = entryPrice;
  var worstDrawdownPct = 0;
  var exitIdx = entryIdx;
  var exitLabel = '⏳ 未觸發出場';
  var maxIdx = Math.min(track.length - 1, entryIdx + maxHoldDays);

  for (var i = entryIdx + 1; i <= maxIdx; i++) {
    var close = toNumber(track[i]['收盤價']);
    if (!close) continue;
    exitIdx = i;
    peakPrice = Math.max(peakPrice, close);
    var cumReturnPct = (close - entryPrice) / entryPrice * 100;
    var drawdownPct = (peakPrice - close) / peakPrice * 100;
    worstDrawdownPct = Math.max(worstDrawdownPct, drawdownPct);

    if (cumReturnPct >= targetProfitPct) { exitLabel = '🎯 達標'; break; }
    if (drawdownPct >= trailingStopPct * 100) { exitLabel = '🛑 止損'; break; }
  }

  var exitPrice = toNumber(track[exitIdx]['收盤價']) || entryPrice;
  var finalReturnPct = (exitPrice - entryPrice) / entryPrice * 100;
  var peakReturnPct = (peakPrice - entryPrice) / entryPrice * 100;

  return {
    exitDate: normalizeDateStr(track[exitIdx]['日期']),
    exitLabel: exitLabel,
    daysHeld: exitIdx - entryIdx,
    finalReturnPct: round_(finalReturnPct, 2),
    peakReturnPct: round_(peakReturnPct, 2),
    worstDrawdownPct: round_(worstDrawdownPct, 2)
  };
}

/** 回測進場區間的通用驗證（單一策略／全部策略比對共用），只驗證日期本身，跟策略無關。 */
function validateBacktestRange_(startStr, endStr) {
  var startDt = new Date(startStr + 'T00:00:00');
  var endDt = new Date(endStr + 'T00:00:00');
  var rangeDays = Math.round((endDt.getTime() - startDt.getTime()) / (24 * 3600 * 1000));
  if (rangeDays < 0) return { error: '結束日不能早於進場區間起始日。' };
  if (rangeDays > BACKTEST_V17_MAX_RANGE_DAYS) {
    return { error: '進場區間最多 ' + BACKTEST_V17_MAX_RANGE_DAYS + ' 天，請縮小範圍（資料量太大，單次背景工作可能跑不完）。' };
  }
  return { ok: true };
}

/** 出場最多追蹤到「結束日 + 最大持有交易日數」對應的日曆天數（抓寬一點蓋過六日/連假），
 *  但不能無限往後抓，避免抓到還沒發生的未來、也避免資料量失控。 */
function computeBacktestLoadEndStr_(endStr) {
  var trackEnd = new Date(endStr + 'T00:00:00');
  trackEnd.setDate(trackEnd.getDate() + Math.ceil(BACKTEST_V17_MAX_HOLD_DAYS * 1.6));
  return normalizeDateStr(trackEnd);
}

/**
 * 抓一次「這段回測範圍（含追蹤緩衝）」已經算好因子的列，跟篩選邏輯版本無關——用哪個資料
 * 來源模式由 shouldUseBigQueryForReads_() 決定，跟 runAnalysis()／今日戰報的讀取路徑一致。
 * 這是「一次跑全部版本比對」的效能關鍵：只抓一次資料，之後可以對同一批 rows 反覆呼叫
 * simulateBacktestForStrategy_() 跑不同策略，不用重新抓資料三次。
 */
function loadBacktestFactorRows_(startStr, loadEndStr) {
  if (shouldUseBigQueryForReads_()) {
    // materialized／external 模式：跟「今日戰報」同一個做法，rolling 因子計算整套丟給
    // BigQuery window function 做（buildRangeFactorsSql_），Apps Script 只接收「這段區間
    // 每天每檔股票已經算好因子」的結果——不能像 native 模式一樣把整段暖機期間的原始資料
    // 整包讀進 Apps Script 再用 JS 重算一次，那樣資料量動輒十幾二十萬列，會超過 Apps Script
    // 單次執行 6 分鐘的上限，背景 job 會卡在「執行中」永遠不會更新（見 queryFactorsRangeFromBigQuery_
    // 的說明）。
    return queryFactorsRangeFromBigQuery_(startStr, loadEndStr);
  }
  // native 模式（沒設定 BigQuery）：資料量本來就小很多（只有 Drive 月份檔案），維持原本
  // 讀 Drive 檔案 + Apps Script 端用 computeFactors_ 重算的做法，跟「今日戰報」native 模式
  // 的讀取路徑一致。暖機：rolling 因子（MA60/IBF_20D 等）要跟正式戰報用同一套回看天數，
  // 算出來的訊號才會跟「戰報與個股」看到的完全一致，不是另一套近似值。
  var warmupStart = new Date(startStr + 'T00:00:00');
  warmupStart.setDate(warmupStart.getDate() - CONFIG.ANALYSIS_LOOKBACK_DAYS);
  var loadStartStr = normalizeDateStr(warmupStart);
  var rawRows = readHistoryRange_(loadStartStr, loadEndStr);
  if (rawRows.length === 0) return [];
  // portfolioMap 給空物件：回測把每一個訊號都當成「當天新進場」，不是既有持股，
  // Adjusted_Peak（既有持股用的欄位）這裡用不到——出場結果由 simulateTradeForward_ 自己
  // 針對每一筆訊號各自模擬，因為同一檔股票在回測區間內可能有好幾個不同的進場日。
  return computeFactors_(rawRows, {});
}

/**
 * 對「已經算好因子」的 rows，用指定策略模擬回測、彙總結果。純運算，不碰 Sheets/BigQuery——
 * 抓資料的步驟由呼叫端先做完（loadBacktestFactorRows_），這裡可以對同一批 rows 反覆呼叫
 * 多次（不同 strategyKey）不用重新抓資料，見 runBacktestAllStrategies_。
 */
function simulateBacktestForStrategy_(rows, startStr, endStr, targetProfit, strategyKey) {
  var strategyDef = SCREENING_STRATEGIES[strategyKey];

  var closesByCode = groupBy(rows, function (r) { return r['證券代號']; });
  closesByCode.forEach(function (group, code) {
    closesByCode.set(code, sortRows(group, [[function (r) { return normalizeDateStr(r['日期']); }, 'asc']]));
  });

  var signalRows = rows.filter(function (r) {
    var d = normalizeDateStr(r['日期']);
    return d >= startStr && d <= endStr;
  });

  var trades = [];
  signalRows.forEach(function (r) {
    var diag = diagnoseRow_(r, {}, strategyKey);
    if (diag.strategy === 'Neutral') return;
    var track = closesByCode.get(r['證券代號']);
    var entryDateStr = normalizeDateStr(r['日期']);
    var entryIdx = track.findIndex(function (t) { return normalizeDateStr(t['日期']) === entryDateStr; });
    if (entryIdx === -1) return;
    var sim = simulateTradeForward_(track, entryIdx, targetProfit, CONFIG.STRATEGY.TRAILING_STOP_PERCENT, BACKTEST_V17_MAX_HOLD_DAYS);
    if (!sim) return;
    trades.push({
      '證券代號': r['證券代號'],
      '證券名稱': r['證券名稱'],
      '進場日': entryDateStr,
      '進場策略': diag.strategy,
      '出場日': sim.exitDate,
      '出場結果': sim.exitLabel,
      '持有天數': sim.daysHeld,
      '最終報酬%': sim.finalReturnPct,
      '最高報酬%': sim.peakReturnPct,
      '最大回落%': sim.worstDrawdownPct
    });
  });

  if (trades.length === 0) {
    return {
      startDay: startStr, endDay: endStr, targetProfit: targetProfit,
      strategyKey: strategyKey, strategyLabel: strategyDef.label,
      trades: [], summary: null, warning: '這段區間內沒有符合「' + strategyDef.label + '」進場條件的訊號。'
    };
  }

  var winCount = trades.filter(function (t) { return t['最終報酬%'] > 0; }).length;
  var targetHits = trades.filter(function (t) { return t['出場結果'] === '🎯 達標'; });
  var avgReturn = mean_(trades.map(function (t) { return t['最終報酬%']; }));
  var avgDaysHeld = mean_(trades.map(function (t) { return t['持有天數']; }));
  var maxDrawdown = Math.max.apply(null, trades.map(function (t) { return t['最大回落%']; }));

  trades.sort(function (a, b) { return b['最終報酬%'] - a['最終報酬%']; });

  return {
    startDay: startStr,
    endDay: endStr,
    targetProfit: targetProfit,
    strategyKey: strategyKey,
    strategyLabel: strategyDef.label,
    trades: trades,
    summary: {
      signalCount: trades.length,
      winRate: round_(winCount / trades.length * 100, 2),
      targetHitRate: round_(targetHits.length / trades.length * 100, 2),
      avgReturn: round_(avgReturn, 2),
      avgDaysHeld: round_(avgDaysHeld, 1),
      maxDrawdown: round_(maxDrawdown, 2)
    }
  };
}

/**
 * 前端「🚀 開始回測歷史戰報」呼叫（透過背景 job，見下方）：對 [startStr, endStr] 這段進場區間
 * 內每一天，用指定的篩選邏輯版本（見 Analysis.gs SCREENING_STRATEGIES，沒帶 strategyKey 就用
 * 目前戰報生效中的版本）找出所有訊號，各自模擬往後持有的結果，彙總成勝率／平均報酬／最大回落。
 */
function runBacktestV17_(startStr, endStr, targetProfit, strategyKey) {
  targetProfit = targetProfit || BACKTEST_V17_TARGET_DEFAULT;
  strategyKey = SCREENING_STRATEGIES[strategyKey] ? strategyKey : getScreeningStrategy();
  var strategyDef = SCREENING_STRATEGIES[strategyKey];

  var rangeCheck = validateBacktestRange_(startStr, endStr);
  if (rangeCheck.error) return rangeCheck;

  var appliedFactorModels = null;
  if (strategyDef.needsFactorModel) {
    appliedFactorModels = getAppliedFactorModels();
    if (!appliedFactorModels.downsideResistance) {
      return { error: '篩選邏輯「' + strategyDef.label + '」需要先套用一版抗跌力因子迴歸模型，請先到「因子健康度＋迴歸模型」套用後再回測。' };
    }
  }

  var loadEndStr = computeBacktestLoadEndStr_(endStr);
  var rows = loadBacktestFactorRows_(startStr, loadEndStr);
  if (rows.length === 0) {
    return { error: '這段日期區間（含暖機資料）沒有 History 資料，請先確認資料已抓取。' };
  }
  if (strategyDef.needsFactorModel) computePredictedResistanceRanks_(rows, appliedFactorModels);

  return simulateBacktestForStrategy_(rows, startStr, endStr, targetProfit, strategyKey);
}

/**
 * 「一次跑全部版本比對」：對 SCREENING_STRATEGIES 的每一種篩選邏輯都跑一次回測，但只抓
 * 一次資料（loadBacktestFactorRows_），資料來源查詢/BigQuery 費用只花一次，不是三倍。
 * 需要因子模型的版本（factor_model_rank／hybrid）如果沒有套用中的抗跌力模型，那個版本的
 * 結果會是 { error: ... }，其他版本不受影響照常跑出結果——不會因為一個版本無法運作就整批
 * 失敗，讓使用者一次看到「哪些版本現在能比、哪些還缺東西」。
 */
function runBacktestAllStrategies_(startStr, endStr, targetProfit) {
  targetProfit = targetProfit || BACKTEST_V17_TARGET_DEFAULT;

  var rangeCheck = validateBacktestRange_(startStr, endStr);
  if (rangeCheck.error) return rangeCheck;

  var loadEndStr = computeBacktestLoadEndStr_(endStr);
  var rows = loadBacktestFactorRows_(startStr, loadEndStr);
  if (rows.length === 0) {
    return { error: '這段日期區間（含暖機資料）沒有 History 資料，請先確認資料已抓取。' };
  }

  var appliedFactorModels = getAppliedFactorModels();
  var hasResistanceModel = !!appliedFactorModels.downsideResistance;
  if (hasResistanceModel) computePredictedResistanceRanks_(rows, appliedFactorModels);

  var results = {};
  Object.keys(SCREENING_STRATEGIES).forEach(function (key) {
    var def = SCREENING_STRATEGIES[key];
    if (def.needsFactorModel && !hasResistanceModel) {
      results[key] = {
        strategyKey: key, strategyLabel: def.label,
        error: '需要先套用一版抗跌力因子迴歸模型，請先到「因子健康度＋迴歸模型」套用後再回測。'
      };
      return;
    }
    results[key] = simulateBacktestForStrategy_(rows, startStr, endStr, targetProfit, key);
  });

  return { startDay: startStr, endDay: endStr, targetProfit: targetProfit, results: results };
}

// ============================================================
// 「開始回測歷史戰報」背景 job（機制跟其他背景工作相同：時間觸發器 + Script Properties
// 存狀態）。要讀一段區間的歷史資料 + 對每一天做完整的因子計算，資料量比平常戰報大不少，
// 手機瀏覽器容易連線中斷，改成背景執行，前端輪詢 getBacktestV17JobStatus() 顯示進度。
// ============================================================

function getBacktestV17JobState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.BACKTEST_JOB_STATE);
  return raw ? JSON.parse(raw) : null;
}

function saveBacktestV17JobState_(state) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.BACKTEST_JOB_STATE, JSON.stringify(state));
}

function deleteBacktestV17JobTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processBacktestV17JobTick_') ScriptApp.deleteTrigger(t);
  });
}

/** 前端「🚀 開始回測歷史戰報」送出表單時呼叫：存好 job 狀態、排一個幾乎立刻觸發的一次性
 *  時間觸發器就馬上回傳，實際運算在另一次獨立觸發的執行裡進行，不受這次瀏覽器連線影響。 */
function startBacktestV17Job(startStr, endStr, targetProfit, strategyKey) {
  deleteBacktestV17JobTriggers_();
  saveBacktestV17JobState_({
    status: 'running', mode: 'single', startStr: startStr, endStr: endStr,
    targetProfit: targetProfit || BACKTEST_V17_TARGET_DEFAULT,
    strategyKey: SCREENING_STRATEGIES[strategyKey] ? strategyKey : getScreeningStrategy(),
    updatedAt: Date.now()
  });
  ScriptApp.newTrigger('processBacktestV17JobTick_').timeBased().after(3000).create();
  return { status: 'running' };
}

/** 前端「🆚 一次跑全部版本比對」送出表單時呼叫：跟 startBacktestV17Job 是同一套背景 job
 *  機制，用 mode='all' 標記這次要跑 runBacktestAllStrategies_() 而不是單一策略。 */
function startBacktestAllStrategiesJob(startStr, endStr, targetProfit) {
  deleteBacktestV17JobTriggers_();
  saveBacktestV17JobState_({
    status: 'running', mode: 'all', startStr: startStr, endStr: endStr,
    targetProfit: targetProfit || BACKTEST_V17_TARGET_DEFAULT,
    updatedAt: Date.now()
  });
  ScriptApp.newTrigger('processBacktestV17JobTick_').timeBased().after(3000).create();
  return { status: 'running' };
}

/** 前端輪詢用：狀態存在 Script Properties，任何時候打開頁面呼叫都看得到最新進度或結果。 */
function getBacktestV17JobStatus() {
  return autoHealStaleJobState_(CONFIG.PROP_KEYS.BACKTEST_JOB_STATE, getBacktestV17JobState_() || { status: 'idle' });
}

/** 排程佇列的「刪除」按鈕呼叫：不管目前狀態是什麼，直接清掉狀態跟任何已排定的觸發器。 */
function clearBacktestV17Job_() {
  deleteBacktestV17JobTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.PROP_KEYS.BACKTEST_JOB_STATE);
  return { status: 'idle' };
}

/** 真正做事的地方，由時間觸發器呼叫，完全不受瀏覽器分頁影響。單一批次，沒有續跑機制
 *  （回測區間已經用 BACKTEST_V17_MAX_RANGE_DAYS 限制在單次執行跑得完的量級）。 */
function processBacktestV17JobTick_() {
  deleteBacktestV17JobTriggers_();
  var state = getBacktestV17JobState_();
  if (!state || state.status !== 'running') return;

  var startTime = Date.now();
  try {
    var res = state.mode === 'all'
      ? runBacktestAllStrategies_(state.startStr, state.endStr, state.targetProfit)
      : runBacktestV17_(state.startStr, state.endStr, state.targetProfit, state.strategyKey);
    var dur = Math.round((Date.now() - startTime) / 1000);
    if (res.error) {
      state.status = 'error';
      state.errorMessage = res.error;
      logRun_('v17.0回測', '失敗', res.error, dur);
    } else {
      state.status = 'done';
      state.result = res;
      var summaryMsg = state.mode === 'all'
        ? Object.keys(res.results || {}).map(function (k) {
            var r = res.results[k];
            return r.strategyLabel + '：' + (r.summary ? '勝率 ' + r.summary.winRate + '%' : (r.error || r.warning));
          }).join('　')
        : state.startStr + '~' + state.endStr + '　' +
          (res.summary ? res.summary.signalCount + ' 筆訊號、勝率 ' + res.summary.winRate + '%' : res.warning);
      logRun_('v17.0回測', '成功', summaryMsg, dur);
    }
    state.updatedAt = Date.now();
    saveBacktestV17JobState_(state);
  } catch (e) {
    state.status = 'error';
    state.errorMessage = String(e.message || e);
    state.updatedAt = Date.now();
    saveBacktestV17JobState_(state);
    logRun_('v17.0回測', '失敗', String(e.message || e), Math.round((Date.now() - startTime) / 1000));
  }
}
