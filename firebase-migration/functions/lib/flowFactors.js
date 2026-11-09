/**
 * flowFactors.js
 * 「深度命題」第二層：法人資金流向持續性因子，依身份別（外資／投信／
 * 自營商）拆開計算——回應使用者原始的兩個問題：「投入後，錢會再流入」
 * （Flow_Streak，連續買超天數，身份別拆開才看得出是哪個身份真的有
 * 持續性，不是被自營商這種常見避險/造市雜訊稀釋掉）跟「即使下跌，錢
 * 也會再流入」（IBF_20D，沿用既有定義，一樣拆身份別）。
 *
 * 跟 lib/analysis.js computeFactors_（服務「今天應該下什麼判斷」）、
 * lib/factorScan.js computeFactorScanFields_（服務既有的、方法論上有
 * 瑕疵的相關性掃描工具——見下方 IBF_20D／Flow_Streak 說明裡的對照）是
 * 三套獨立維護的因子計算，只是服務不同用途，同名因子不保證定義一致。
 * 這裡算出來的因子只餵給 lib/factorValidation.js 的 IC 驗證管線，不是
 * production 的即時計算路徑（跟 computeFactors_ 不是同一回事，驗證通過
 * 之前不會動到任何正式戰報/回測邏輯）。
 *
 * 新增時機：2026-11-09。
 */
var utils = require('./utils');
var zfill4 = utils.zfill4;
var toNumber = utils.toNumber;
var groupBy = utils.groupBy;
var sortRows = utils.sortRows;
var normalizeDateStr = utils.normalizeDateStr;
var pctChange = utils.pctChange;
var rollingSum = utils.rollingSum;
var computeStreak_ = require('./factorScan').computeStreak_;

/**
 * 要拆解的身份別清單。`combined`（投信+外資+自營商加總）當對照組——
 * 如果合計版的 IC 比任何單一身份別都強，代表拆開身份別沒有額外價值；
 * 如果某個單一身份別明顯比合計版強，代表合計版把那個身份別的訊號跟
 * 其他身份別的雜訊混在一起，拆開才看得出來。`rawField` 是 History 列
 * 裡的中文欄名，`combined` 沒有單一對應欄位，特別處理。
 */
var INSTITUTIONAL_TYPES = [
  { key: 'foreign', label: '外資', rawField: '外資' },
  { key: 'trust', label: '投信', rawField: '投信' },
  { key: 'dealer', label: '自營商', rawField: '自營商' },
  { key: 'combined', label: '合計', rawField: null }
];

/**
 * 純運算：輸入任意一批 History 列（中文欄名，跟 computeFactors_／
 * computeFactorScanFields_ 吃的格式一致），依股票代號分組、依日期排序，
 * 就地補上每個身份別的 `IBF_20D_{key}`（逢低接手率，沿用
 * analysis.js computeFactors_ 的定義：過去 20 天、下跌日裡這個身份淨買超
 * 的比例，分母是 0 或 null 時整個是 0，不是 null——下跌日數不足的
 * 早期資料不該被當成「缺值」排除在橫斷面比較之外）跟 `Flow_Streak_{key}`
 * （連續買超天數，重用 lib/factorScan.js 既有的 `computeStreak_`），
 * 回傳同一批列（已重新排序過）。
 */
function computeFlowPersistenceFactors_(rows) {
  var numCols = ['收盤價', '成交股數', '投信', '外資', '自營商'];
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
    var dailyReturn = pctChange(closeArr);
    // 「下跌日」定義跟 analysis.js computeFactors_／factorScan.js 完全一致
    // （用股票自己的收盤價日報酬 < 0 判斷），身份別只影響「誰在下跌日
    // 淨買超」，不影響「哪幾天算下跌日」這個共同基準——這樣不同身份別
    // 的 IBF_20D 才是在同一組「下跌日」上比較，不是各自用不同的分母。
    var isDrop = dailyReturn.map(function (v) { return (v !== null && v < 0) ? 1 : 0; });
    var dropCount20 = rollingSum(isDrop, 20);

    INSTITUTIONAL_TYPES.forEach(function (type) {
      var netArr = type.rawField
        ? group.map(function (r) { return r[type.rawField]; })
        : group.map(function (r) { return r['投信'] + r['外資'] + r['自營商']; });

      var isBuyOnDrop = isDrop.map(function (v, i) { return (v === 1 && netArr[i] > 0) ? 1 : 0; });
      var buyOnDrop20 = rollingSum(isBuyOnDrop, 20);
      var ibf20 = dropCount20.map(function (dc, i) { return dc ? buyOnDrop20[i] / dc : 0; });

      var buyTag = netArr.map(function (v) { return v > 0 ? 1 : 0; });
      var streak = computeStreak_(buyTag);

      for (var i = 0; i < group.length; i++) {
        group[i]['IBF_20D_' + type.key] = ibf20[i];
        group[i]['Flow_Streak_' + type.key] = streak[i];
      }
    });
  });

  return rows;
}

module.exports = {
  INSTITUTIONAL_TYPES: INSTITUTIONAL_TYPES,
  computeFlowPersistenceFactors_: computeFlowPersistenceFactors_
};
