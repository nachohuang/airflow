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

/**
 * 前端「🚀 開始回測歷史戰報」呼叫（透過背景 job，見下方）：對 [startStr, endStr] 這段進場區間
 * 內每一天，用 v17.0 的進場條件（diagnoseRow_ 在沒有持股時的判斷：🚀 趨勢啟動／🔥 趨勢領航）
 * 找出所有訊號，各自模擬往後持有的結果，彙總成勝率／平均報酬／最大回落。
 */
function runBacktestV17_(startStr, endStr, targetProfit) {
  targetProfit = targetProfit || BACKTEST_V17_TARGET_DEFAULT;

  var startDt = new Date(startStr + 'T00:00:00');
  var endDt = new Date(endStr + 'T00:00:00');
  var rangeDays = Math.round((endDt.getTime() - startDt.getTime()) / (24 * 3600 * 1000));
  if (rangeDays < 0) return { error: '結束日不能早於進場區間起始日。' };
  if (rangeDays > BACKTEST_V17_MAX_RANGE_DAYS) {
    return { error: '進場區間最多 ' + BACKTEST_V17_MAX_RANGE_DAYS + ' 天，請縮小範圍（資料量太大，單次背景工作可能跑不完）。' };
  }

  // 暖機：rolling 因子（MA60/IBF_20D 等）要跟正式戰報用同一套回看天數，算出來的訊號才會
  // 跟「戰報與個股」看到的完全一致，不是另一套近似值。
  var warmupStart = new Date(startStr + 'T00:00:00');
  warmupStart.setDate(warmupStart.getDate() - CONFIG.ANALYSIS_LOOKBACK_DAYS);
  var loadStartStr = normalizeDateStr(warmupStart);

  // 出場最多追蹤到「結束日 + 最大持有交易日數」對應的日曆天數（抓寬一點蓋過六日/連假），
  // 但不能無限往後抓，避免抓到還沒發生的未來、也避免資料量失控。
  var trackEnd = new Date(endStr + 'T00:00:00');
  trackEnd.setDate(trackEnd.getDate() + Math.ceil(BACKTEST_V17_MAX_HOLD_DAYS * 1.6));
  var loadEndStr = normalizeDateStr(trackEnd);

  var rawRows = readHistoryRange_(loadStartStr, loadEndStr);
  if (rawRows.length === 0) {
    return { error: '這段日期區間（含暖機資料）沒有 History 資料，請先確認資料已抓取。' };
  }

  // portfolioMap 給空物件：回測把每一個訊號都當成「當天新進場」，不是既有持股，
  // Adjusted_Peak（既有持股用的欄位）這裡用不到——出場結果由 simulateTradeForward_ 自己
  // 針對每一筆訊號各自模擬，因為同一檔股票在回測區間內可能有好幾個不同的進場日。
  var rows = computeFactors_(rawRows, {});

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
    var diag = diagnoseRow_(r, {});
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
      trades: [], summary: null, warning: '這段區間內沒有符合 v17.0 進場條件的訊號。'
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
function startBacktestV17Job(startStr, endStr, targetProfit) {
  deleteBacktestV17JobTriggers_();
  saveBacktestV17JobState_({
    status: 'running', startStr: startStr, endStr: endStr,
    targetProfit: targetProfit || BACKTEST_V17_TARGET_DEFAULT, updatedAt: Date.now()
  });
  ScriptApp.newTrigger('processBacktestV17JobTick_').timeBased().after(1000).create();
  return { status: 'running' };
}

/** 前端輪詢用：狀態存在 Script Properties，任何時候打開頁面呼叫都看得到最新進度或結果。 */
function getBacktestV17JobStatus() {
  return getBacktestV17JobState_() || { status: 'idle' };
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
    var res = runBacktestV17_(state.startStr, state.endStr, state.targetProfit);
    var dur = Math.round((Date.now() - startTime) / 1000);
    if (res.error) {
      state.status = 'error';
      state.errorMessage = res.error;
      logRun_('v17.0回測', '失敗', res.error, dur);
    } else {
      state.status = 'done';
      state.result = res;
      logRun_('v17.0回測', '成功',
        state.startStr + '~' + state.endStr + '　' +
        (res.summary ? res.summary.signalCount + ' 筆訊號、勝率 ' + res.summary.winRate + '%' : res.warning),
        dur);
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
