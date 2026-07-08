/**
 * FactorScan.gs
 * 對應 Colab Cell 4「factor_correlation_scan_v17」：計算各因子與未來 5 日報酬率的相關係數，
 * 用來研究哪個因子比較有效，屬於研究工具（回測研究頁面的一部分），不會寫入 Reports。
 */

function computeStreak_(tags) {
  var out = new Array(tags.length).fill(0);
  var run = 0;
  for (var i = 0; i < tags.length; i++) {
    if (tags[i] === 1) { run += 1; out[i] = run; } else { run = 0; out[i] = 0; }
  }
  return out;
}

/** 純運算：輸入任意一批 History 列，回傳補齊研究因子欄位後的列陣列。 */
function computeFactorScanFields_(rows) {
  var numCols = ['收盤價', '成交股數', '成交金額', '投信', '外資', '自營商', '最後揭示買量', '最後揭示賣量'];
  rows.forEach(function (r) {
    r['證券代號'] = zfill4(String(r['證券代號']).trim());
    numCols.forEach(function (c) { r[c] = toNumber(r[c]); });
  });
  rows = rows.filter(function (r) { return r['證券代號'].length === 4; });
  rows = sortRows(rows, [
    ['證券代號', 'asc'],
    [function (r) { return normalizeDateStr(r['日期']); }, 'asc']
  ]);

  var byCode = groupBy(rows, function (r) { return r['證券代號']; });
  byCode.forEach(function (group) {
    var closeArr = group.map(function (r) { return r['收盤價']; });
    var volArr = group.map(function (r) { return r['成交股數']; });
    var instNetArr = group.map(function (r) { return r['投信'] + r['外資'] + r['自營商']; });

    var dailyReturn = pctChange(closeArr);
    var isDrop = dailyReturn.map(function (v) { return (v !== null && v < 0) ? 1 : 0; });
    var isInstBuyOnDrop = isDrop.map(function (v, i) { return (v === 1 && instNetArr[i] > 0) ? 1 : 0; });
    var dropCount20 = rollingSum(isDrop, 20);
    var buyOnDrop20 = rollingSum(isInstBuyOnDrop, 20);
    var ibf20 = dropCount20.map(function (dc, i) { return dc ? buyOnDrop20[i] / dc : 0; });

    var ma60 = rollingMean(closeArr, 60);
    var bias60 = closeArr.map(function (c, i) { return ma60[i] ? (c - ma60[i]) / ma60[i] : null; });
    var min20 = rollingMin(closeArr, 20);
    var floorDist = closeArr.map(function (c, i) { return min20[i] ? (c - min20[i]) / min20[i] : null; });
    var safetyRank = closeArr.map(function (c, i) {
      if (ma60[i] === null || bias60[i] === null || floorDist[i] === null) return null;
      return ((0.15 - bias60[i]) / 0.25 * 60) + ((0.15 - floorDist[i]) / 0.15 * 40);
    });

    var instBuyTag = instNetArr.map(function (v) { return v > 0 ? 1 : 0; });
    var instStreak = computeStreak_(instBuyTag);

    var instParticipation = group.map(function (r) {
      var vol = r['成交股數'];
      if (!vol) return null;
      return (Math.abs(r['投信']) + Math.abs(r['外資']) + Math.abs(r['自營商'])) / vol;
    });

    var ma20 = rollingMean(closeArr, 20);
    var ma20Slope = diffN(ma20, 1); // 注意：因子掃描用 diff(1)，v17.0 主評分用 diff(3)
    var trendScore = closeArr.map(function (c, i) {
      var s = 0;
      if (ma20[i] !== null && c > ma20[i]) s += 1;
      if (ma20Slope[i] !== null && ma20Slope[i] > 0) s += 1;
      return s;
    });

    var next5DReturn = shiftN(closeArr, -5).map(function (future, i) {
      var cur = closeArr[i];
      if (future === null || !cur) return null;
      return future / cur - 1;
    });

    for (var i = 0; i < group.length; i++) {
      group[i].IBF_20D = ibf20[i];
      group[i].Safety_Rank = safetyRank[i];
      group[i].Inst_Streak = instStreak[i];
      group[i].Inst_Participation = instParticipation[i];
      group[i].Trend_Score = trendScore[i];
      group[i].Next_5D_Return = next5DReturn[i];
    }
  });

  return rows;
}

/**
 * 前端「回測研究」頁面呼叫：因子相關性掃描。
 * startStr/endStr 可留空代表使用全部 History 資料。
 */
function runFactorCorrelationScan(startStr, endStr) {
  var rows = readHistoryRange_(startStr || null, endStr || null);
  if (rows.length === 0) return { sampleSize: 0, correlations: [] };

  var computed = computeFactorScanFields_(rows);
  var validScan = computed.filter(function (r) {
    return r.Next_5D_Return !== null && r.Safety_Rank !== null;
  });

  if (validScan.length === 0) {
    return { sampleSize: 0, correlations: [], warning: '數據量不足（可能是 MA60 暖機未完成），請放寬日期區間。' };
  }

  var factors = ['Next_5D_Return', 'Inst_Streak', 'Inst_Participation', 'Trend_Score', 'IBF_20D', 'Safety_Rank'];
  var target = validScan.map(function (r) { return r.Next_5D_Return; });
  var correlations = factors.map(function (f) {
    var series = validScan.map(function (r) { return r[f]; });
    return { factor: f, correlation: pearsonCorrelation(series, target) };
  });
  correlations.sort(function (a, b) { return (b.correlation || -Infinity) - (a.correlation || -Infinity); });

  return { sampleSize: validScan.length, correlations: correlations };
}
