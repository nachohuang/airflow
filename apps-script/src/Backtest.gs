/**
 * Backtest.gs
 * 對應 Colab Cell 5「v16.10 Alpha Backtest - 實相勝率與因子效能驗證模組」。
 * 在指定進場日對符合條件的標的做「假設進場」，追蹤到結束日看報酬率分佈與勝率。
 */

var BACKTEST_DEFAULTS = {
  LIQUIDITY_MIN: 20000000,
  TARGET_PROFIT: 5.0, // 百分比
  WARMUP_DAYS: 100     // 進場日之前額外多讀的天數，讓 WIP_STD_20D / IBF_20D / Depth_MA5 等 rolling 指標能暖機
};

/** 純運算：計算 v16.10 用到的所有指標欄位，回傳補齊欄位後的列陣列。 */
function computeBacktestFields_(rows) {
  var numCols = ['成交股數', '成交金額', '投信', '外資', '自營商', '收盤價', '最後揭示買量', '最後揭示賣量'];
  rows.forEach(function (r) {
    r['證券代號'] = zfill4(String(r['證券代號']).trim());
    numCols.forEach(function (c) { r[c] = toNumber(r[c]); });
  });
  rows = rows.filter(function (r) { return r['證券代號'].length === 4; });
  rows = sortRows(rows, [
    ['證券代號', 'asc'],
    [function (r) { return normalizeDateStr(r['日期']); }, 'asc']
  ]);

  var WEIGHTS = { IT: 0.5, FI: 0.3, SD: 0.2 };
  var byCode = groupBy(rows, function (r) { return r['證券代號']; });
  byCode.forEach(function (group) {
    var closeArr = group.map(function (r) { return r['收盤價']; });
    var volArr = group.map(function (r) { return r['成交股數']; });
    var instNetArr = group.map(function (r) { return r['投信'] + r['外資'] + r['自營商']; });
    var winArr = group.map(function (r) { return r['投信'] * WEIGHTS.IT + r['外資'] * WEIGHTS.FI + r['自營商'] * WEIGHTS.SD; });
    var wipArr = winArr.map(function (w, i) { return volArr[i] ? w / volArr[i] : null; });
    var wipStd20 = rollingStd(wipArr, 20);

    var dailyReturn = pctChange(closeArr);
    var isDrop = dailyReturn.map(function (v) { return (v !== null && v < 0) ? 1 : 0; });
    var isInstBuyOnDrop = isDrop.map(function (v, i) { return (v === 1 && instNetArr[i] > 0) ? 1 : 0; });
    var dropCount20 = rollingSum(isDrop, 20);
    var buyOnDrop20 = rollingSum(isInstBuyOnDrop, 20);
    var ibf20 = dropCount20.map(function (dc, i) { return dc ? buyOnDrop20[i] / dc : 0; });

    var depthRatio = group.map(function (r) { return r['最後揭示賣量'] ? r['最後揭示買量'] / r['最後揭示賣量'] : null; });
    var depthMA5 = rollingMean(depthRatio, 5);

    for (var i = 0; i < group.length; i++) {
      group[i].Total_Inst_Net = instNetArr[i];
      group[i].WIN = winArr[i];
      group[i].WIP = wipArr[i];
      group[i].WIP_STD_20D = wipStd20[i];
      group[i].Daily_Return = dailyReturn[i];
      group[i].IBF_20D = ibf20[i];
      group[i].Depth_Ratio = depthRatio[i];
      group[i].Depth_MA5 = depthMA5[i];
    }
  });

  // 橫斷面 IBF_20D_Rank + 市場層級的 Market_Median / Market_5D_Trend
  var byDate = groupBy(rows, function (r) { return normalizeDateStr(r['日期']); });
  var dateKeys = Array.from(byDate.keys()).sort();
  var marketMedianByDate = {};
  dateKeys.forEach(function (dateStr) {
    var dayRows = byDate.get(dateStr);
    var ibfRank = percentRank(dayRows, 'IBF_20D');
    for (var i = 0; i < dayRows.length; i++) dayRows[i].IBF_20D_Rank = ibfRank[i];

    var returns = dayRows.map(function (r) { return r.Daily_Return; }).filter(function (v) { return v !== null; });
    marketMedianByDate[dateStr] = returns.length ? median_(returns) : null;
  });

  var marketMedianArr = dateKeys.map(function (d) { return marketMedianByDate[d]; });
  var market5DTrendArr = rollingMean(marketMedianArr, 5);
  var market5DTrendByDate = {};
  dateKeys.forEach(function (d, i) { market5DTrendByDate[d] = market5DTrendArr[i]; });

  rows.forEach(function (r) {
    r.Market_Median = marketMedianByDate[normalizeDateStr(r['日期'])];
    r.Market_5D_Trend = market5DTrendByDate[normalizeDateStr(r['日期'])];
  });

  return rows;
}

function median_(arr) {
  var sorted = arr.slice().sort(function (a, b) { return a - b; });
  var n = sorted.length;
  var mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round_(v, digits) {
  if (v === null || v === undefined || isNaN(v)) return null;
  var f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/**
 * 前端「回測研究」頁面呼叫：跑一次 v16.10 Alpha 回測。
 * startStr/endStr: 'yyyy-MM-dd'。liquidityMin/targetProfit 可留空使用預設值。
 */
function runBacktest(startStr, endStr, liquidityMin, targetProfit) {
  liquidityMin = liquidityMin || BACKTEST_DEFAULTS.LIQUIDITY_MIN;
  targetProfit = targetProfit || BACKTEST_DEFAULTS.TARGET_PROFIT;

  var warmupStart = new Date(startStr + 'T00:00:00');
  warmupStart.setDate(warmupStart.getDate() - BACKTEST_DEFAULTS.WARMUP_DAYS);
  var loadStartStr = normalizeDateStr(warmupStart);

  var rawRows = readHistoryRange_(loadStartStr, endStr);
  if (rawRows.length === 0) {
    return { error: '這段日期區間沒有 History 資料，請先確認資料已抓取。' };
  }

  var rows = computeBacktestFields_(rawRows);

  var entrySnapshot = rows.filter(function (r) { return normalizeDateStr(r['日期']) === startStr; });
  if (entrySnapshot.length === 0) {
    return { error: '進場日 (' + startStr + ') 沒有資料，請確認是交易日且已抓過該日資料。' };
  }

  var candidates = entrySnapshot.filter(function (r) {
    return r.WIP !== null && r.WIP > 0 && r['成交金額'] >= liquidityMin;
  });

  var byCodeTrack = groupBy(
    rows.filter(function (r) {
      var d = normalizeDateStr(r['日期']);
      return d > startStr && d <= endStr;
    }),
    function (r) { return r['證券代號']; }
  );

  var startDt = new Date(startStr + 'T00:00:00');
  var results = [];
  candidates.forEach(function (item) {
    var track = byCodeTrack.get(item['證券代號']);
    if (!track || track.length === 0) return;
    track = sortRows(track, [[function (r) { return normalizeDateStr(r['日期']); }, 'asc']]);

    var entryPrice = item['收盤價'];
    if (!entryPrice) return;
    var cumReturns = track.map(function (r) { return (r['收盤價'] - entryPrice) / entryPrice * 100; });

    var peakReturn = Math.max.apply(null, cumReturns);
    var finalReturn = cumReturns[cumReturns.length - 1];
    var peakIdx = cumReturns.indexOf(peakReturn);
    var peakDate = new Date(normalizeDateStr(track[peakIdx]['日期']) + 'T00:00:00');
    var daysToPeak = Math.round((peakDate.getTime() - startDt.getTime()) / (24 * 3600 * 1000));

    results.push({
      '證券代號': item['證券代號'],
      '證券名稱': item['證券名稱'],
      '進場IBF_Rank': round_(item.IBF_20D_Rank, 2),
      'WIP_穩定度(STD)': round_(item.WIP_STD_20D, 6),
      'Depth_MA5': round_(item.Depth_MA5, 2),
      'Market_Trend_Entry': round_(item.Market_5D_Trend, 4),
      'Peak_Return%': round_(peakReturn, 2),
      'Final_Return%': round_(finalReturn, 2),
      'Days_to_Peak': daysToPeak,
      'Win_Label': peakReturn >= targetProfit ? 1 : 0
    });
  });

  if (results.length === 0) {
    return {
      startDay: startStr, endDay: endStr, liquidityMin: liquidityMin, targetProfit: targetProfit,
      results: [], summary: null, warning: '沒有符合進場條件的標的，或追蹤區間內沒有後續資料。'
    };
  }

  var winCount = results.filter(function (r) { return r['Final_Return%'] > 0; }).length;
  var targetHits = results.filter(function (r) { return r['Peak_Return%'] >= targetProfit; });
  var avgDays = targetHits.length ? mean_(targetHits.map(function (r) { return r.Days_to_Peak; })) : null;

  var topIbf = results.slice().sort(function (a, b) { return (b['進場IBF_Rank'] || 0) - (a['進場IBF_Rank'] || 0); }).slice(0, 10);
  var topIbfAvgReturn = topIbf.length ? mean_(topIbf.map(function (r) { return r['Peak_Return%']; })) : null;

  return {
    startDay: startStr,
    endDay: endStr,
    liquidityMin: liquidityMin,
    targetProfit: targetProfit,
    results: results.sort(function (a, b) { return b['Peak_Return%'] - a['Peak_Return%']; }),
    summary: {
      sampleSize: results.length,
      winRate: round_(winCount / results.length * 100, 2),
      targetHitRate: round_(targetHits.length / results.length * 100, 2),
      avgDaysToTarget: avgDays === null ? null : round_(avgDays, 1),
      topIbfAvgReturn: topIbfAvgReturn === null ? null : round_(topIbfAvgReturn, 2)
    }
  };
}
