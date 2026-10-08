/**
 * backtest.js
 * v17.0 策略歷史驗證：直接重用 analysis.js 的 computeFactors_()／diagnoseRow_()——
 * 跟「戰報與個股」算出來的因子與進場訊號用的是同一套邏輯，不是另一套近似的舊版規則，
 * 回測結果才真的能反映「如果我照著這套策略下單，過去這段期間表現如何」。
 *
 * 從 apps-script/src/Backtest.gs 複製純函式邏輯過來（讀 BigQuery、背景 job 狀態機
 * 這些 I/O 留給 index.js，見那邊 runBacktestCore_／runBacktestAllStrategiesCore_
 * 的說明）。
 *
 * 複製時機：2026-10-08，對照 apps-script/src/Backtest.gs 當時的內容。
 */
var utils = require('./utils');
var analysis = require('./analysis');
var config = require('./config');
var toNumber = utils.toNumber;
var round_ = utils.round_;
var mean_ = utils.mean_;
var groupBy = utils.groupBy;
var sortRows = utils.sortRows;
var normalizeDateStr = utils.normalizeDateStr;

var BACKTEST_TARGET_DEFAULT = 5; // 目標報酬（%），達到就視為 🎯 達標出場
var BACKTEST_MAX_HOLD_DAYS = 40; // 進場後最多追蹤幾個「交易日」，避免長期不出場的訊號把回測拖到跑不完
var BACKTEST_MAX_RANGE_DAYS = 60; // 進場區間（起訖日相差的日曆天數）上限，避免單次執行要處理的資料量爆炸

/**
 * 模擬「在 track[entryIdx] 那天收盤價進場」之後會發生什麼事：用跟正式戰報完全一樣的出場規則
 * （從進場後的最高價回落 trailingStopPct 就出場）逐日往前追蹤，直到達到目標報酬、觸發停損，
 * 或追蹤天數/資料用完為止。track 是同一檔股票依日期排序好的列陣列（每列至少有「日期」
 * 「收盤價」）。抽成獨立純函式方便測試，不用真的接 BigQuery。
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
  if (rangeDays > BACKTEST_MAX_RANGE_DAYS) {
    return { error: '進場區間最多 ' + BACKTEST_MAX_RANGE_DAYS + ' 天，請縮小範圍（資料量太大，單次執行可能跑不完）。' };
  }
  return { ok: true };
}

/** 出場最多追蹤到「結束日 + 最大持有交易日數」對應的日曆天數（抓寬一點蓋過六日/連假），
 *  但不能無限往後抓，避免抓到還沒發生的未來、也避免資料量失控。 */
function computeBacktestLoadEndStr_(endStr) {
  var trackEnd = new Date(endStr + 'T00:00:00');
  trackEnd.setDate(trackEnd.getDate() + Math.ceil(BACKTEST_MAX_HOLD_DAYS * 1.6));
  return normalizeDateStr(trackEnd);
}

/**
 * 對「已經算好因子」的 rows，用指定策略模擬回測、彙總結果。純運算，不碰 BigQuery——
 * 抓資料的步驟由呼叫端先做完（index.js 的 loadBacktestFactorRows_），這裡可以對同一批
 * rows 反覆呼叫多次（不同 strategyKey）不用重新抓資料，見 index.js runBacktestAllStrategiesCore_。
 *
 * trades 陣列的欄位名稱刻意改成英文（`code`／`entryDate`／`finalReturnPct`...），不是
 * apps-script 版 Sheets 的中文欄名（`證券代號`／`進場日`／`最終報酬%`）——這份結果是直接
 * 回傳給前端／存進 `jobs/backtest` 的資料，跟 `reportPipeline.js` 的 `reportDocs` 同一個
 * 「新系統直接用英文欄名，不需要中文→英文的額外轉換步驟」慣例，不是遺漏。
 */
function simulateBacktestForStrategy_(rows, startStr, endStr, targetProfit, strategyKey) {
  var strategyDef = analysis.SCREENING_STRATEGIES[strategyKey];

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
    var diag = analysis.diagnoseRow_(r, {}, strategyKey);
    if (diag.strategy === 'Neutral') return;
    var track = closesByCode.get(r['證券代號']);
    var entryDateStr = normalizeDateStr(r['日期']);
    var entryIdx = track.findIndex(function (t) { return normalizeDateStr(t['日期']) === entryDateStr; });
    if (entryIdx === -1) return;
    var sim = simulateTradeForward_(track, entryIdx, targetProfit, config.STRATEGY.TRAILING_STOP_PERCENT, BACKTEST_MAX_HOLD_DAYS);
    if (!sim) return;
    trades.push({
      code: r['證券代號'],
      name: r['證券名稱'],
      entryDate: entryDateStr,
      entryStrategy: diag.strategy,
      exitDate: sim.exitDate,
      exitLabel: sim.exitLabel,
      daysHeld: sim.daysHeld,
      finalReturnPct: sim.finalReturnPct,
      peakReturnPct: sim.peakReturnPct,
      worstDrawdownPct: sim.worstDrawdownPct
    });
  });

  if (trades.length === 0) {
    return {
      startDay: startStr, endDay: endStr, targetProfit: targetProfit,
      strategyKey: strategyKey, strategyLabel: strategyDef.label,
      trades: [], summary: null, warning: '這段區間內沒有符合「' + strategyDef.label + '」進場條件的訊號。'
    };
  }

  var winCount = trades.filter(function (t) { return t.finalReturnPct > 0; }).length;
  var targetHits = trades.filter(function (t) { return t.exitLabel === '🎯 達標'; });
  var avgReturn = mean_(trades.map(function (t) { return t.finalReturnPct; }));
  var avgDaysHeld = mean_(trades.map(function (t) { return t.daysHeld; }));
  var maxDrawdown = Math.max.apply(null, trades.map(function (t) { return t.worstDrawdownPct; }));

  trades.sort(function (a, b) { return b.finalReturnPct - a.finalReturnPct; });

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

module.exports = {
  BACKTEST_TARGET_DEFAULT: BACKTEST_TARGET_DEFAULT,
  BACKTEST_MAX_HOLD_DAYS: BACKTEST_MAX_HOLD_DAYS,
  BACKTEST_MAX_RANGE_DAYS: BACKTEST_MAX_RANGE_DAYS,
  simulateTradeForward_: simulateTradeForward_,
  validateBacktestRange_: validateBacktestRange_,
  computeBacktestLoadEndStr_: computeBacktestLoadEndStr_,
  simulateBacktestForStrategy_: simulateBacktestForStrategy_
};
