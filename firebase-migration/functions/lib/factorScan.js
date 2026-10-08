/**
 * factorScan.js
 * 因子相關性掃描：計算幾個候選因子與「未來 5 日報酬率」的 Pearson 相關係數，
 * 用來研究哪個因子比較有效（屬於「策略研究」頁面的研究工具，不寫回 Reports，
 * 不影響正式戰報）。從 apps-script/src/FactorScan.gs 複製純函式邏輯過來
 * （讀 History 這段 I/O 留給 index.js，見 runFactorScanCore_ 的說明）。
 *
 * 跟 analysis.js computeFactors_ 是兩套獨立的因子計算——這支專門服務「掃描
 * 相關性」這個研究用途，用的是 Next_5D_Return（未來 5 日報酬率，拿來跟其他
 * 因子比對），computeFactors_ 服務的是「今天應該下什麼判斷」，兩邊的因子
 * 定義即使同名（例如 Trend_Score）也不保證完全一致，不要混用。
 *
 * 複製時機：2026-10-08，對照 apps-script/src/FactorScan.gs 當時的內容。
 */
var utils = require('./utils');
var toNumber = utils.toNumber;
var zfill4 = utils.zfill4;
var groupBy = utils.groupBy;
var sortRows = utils.sortRows;
var normalizeDateStr = utils.normalizeDateStr;
var pctChange = utils.pctChange;
var rollingSum = utils.rollingSum;
var rollingMean = utils.rollingMean;
var rollingMin = utils.rollingMin;
var diffN = utils.diffN;
var shiftN = utils.shiftN;
var pearsonCorrelation = utils.pearsonCorrelation;

/** 掃描比較的候選因子清單——Next_5D_Return 本身是相關係數的目標（比較基準），
 *  不能同時當候選因子跟自己比，那一項永遠會算出 r=1.00，混進排行榜只會
 *  誤導使用者以為有一個「完美因子」，所以不在這份清單裡。 */
var FACTOR_SCAN_CANDIDATE_FACTORS = ['Inst_Streak', 'Inst_Participation', 'Trend_Score', 'IBF_20D', 'Safety_Rank'];

/** 連續天數計數：tags[i] 是 1 就累加，是 0 就歸零——給「法人連續買超幾天」
 *  （Inst_Streak）用。 */
function computeStreak_(tags) {
  var out = new Array(tags.length).fill(0);
  var run = 0;
  for (var i = 0; i < tags.length; i++) {
    if (tags[i] === 1) { run += 1; out[i] = run; } else { run = 0; out[i] = 0; }
  }
  return out;
}

/**
 * 純運算：輸入任意一批 History 列（中文欄名，跟 computeFactors_ 吃的格式
 * 一致），依股票代號分組、依日期排序，就地補上這支研究工具專用的欄位
 * （IBF_20D／Safety_Rank／Inst_Streak／Inst_Participation／Trend_Score／
 * Next_5D_Return），回傳同一批列（已經重新排序過）。
 */
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
    var ma20Slope = diffN(ma20, 1); // 注意：因子掃描用 diff(1)，v17.0 主評分（Analysis.gs）用 diff(3)，兩邊刻意不同，不是筆誤
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
 * 對已經跑過 `computeFactorScanFields_` 的列，算出每個候選因子跟
 * `Next_5D_Return` 的 Pearson 相關係數，依相關係數由大到小排序。
 */
function computeFactorCorrelations_(computedRows) {
  var validScan = computedRows.filter(function (r) {
    return r.Next_5D_Return !== null && r.Safety_Rank !== null;
  });

  if (validScan.length === 0) {
    return { sampleSize: 0, correlations: [], warning: '數據量不足（可能是 MA60 暖機未完成），請放寬日期區間。' };
  }

  var target = validScan.map(function (r) { return r.Next_5D_Return; });
  var correlations = FACTOR_SCAN_CANDIDATE_FACTORS.map(function (f) {
    var series = validScan.map(function (r) { return r[f]; });
    return { factor: f, correlation: pearsonCorrelation(series, target) };
  });
  correlations.sort(function (a, b) { return (b.correlation || -Infinity) - (a.correlation || -Infinity); });

  return { sampleSize: validScan.length, correlations: correlations };
}

module.exports = {
  FACTOR_SCAN_CANDIDATE_FACTORS: FACTOR_SCAN_CANDIDATE_FACTORS,
  computeStreak_: computeStreak_,
  computeFactorScanFields_: computeFactorScanFields_,
  computeFactorCorrelations_: computeFactorCorrelations_
};
