/**
 * factorInspector.js
 * 「因子檢視器」用的純函式——使用者實測因子迴歸訓練一路踩到好幾個跟資料
 * 覆蓋率有關的 bug（Input data doesn't contain any rows／mean imputation
 * 失敗），每次都要靠猜測＋翻 deploy log 才能定位原因。這個功能讓使用者
 * 自己選一檔股票、一段區間，直接看 BigQuery `factor_features_fundamental`
 * view 算出來的逐日因子值，以及背後的原始財報/股價資料，不用每次都靠
 * 這種方式回頭排查。全新功能，apps-script 版沒有對應邏輯可比對。
 *
 * 新增時機：2026-10-08。
 */

/** 因子檢視器單次查詢允許的最大區間天數——這是唯讀診斷查詢，不像回測要
 *  模擬交易，但還是要有上限，避免單次查詢掃過多天的 BigQuery 資料。 */
var FACTOR_INSPECTOR_MAX_RANGE_DAYS = 365;

/** 驗證因子檢視器的查詢區間——跟 lib/backtest.js validateBacktestRange_
 *  同一個模式（純日期檢查，跟查詢內容本身無關），這裡獨立一份常數，不
 *  跟回測共用，因為兩者對「區間太長」的風險考量不同（回測要逐筆模擬
 *  交易，這裡只是單純查表）。 */
function validateFactorInspectorRange_(startStr, endStr) {
  var startDt = new Date(startStr + 'T00:00:00');
  var endDt = new Date(endStr + 'T00:00:00');
  if (isNaN(startDt.getTime()) || isNaN(endDt.getTime())) {
    return { error: '日期格式不正確，請用 yyyy-MM-dd。' };
  }
  var rangeDays = Math.round((endDt.getTime() - startDt.getTime()) / (24 * 3600 * 1000));
  if (rangeDays < 0) return { error: '結束日不能早於起始日。' };
  if (rangeDays > FACTOR_INSPECTOR_MAX_RANGE_DAYS) {
    return { error: '查詢區間最多 ' + FACTOR_INSPECTOR_MAX_RANGE_DAYS + ' 天，請縮小範圍。' };
  }
  return { ok: true };
}

/** 把某一檔股票的原始財報列（Firestore `financials_quarterly`／
 *  `financials_monthly` 裡 code 相等的文件）依指定日期欄位由舊到新排序
 *  ——quarterly 用 `period`（出表日期），monthly 用 `reportDate`（估算的
 *  公開可得日期），給使用者在因子檢視器裡對照「這天因子值」跟「當時
 *  最新一期財報公告日」用，照時間軸排序比較好對照。 */
function sortFinancialDocsByDate_(docs, dateField) {
  return (docs || []).slice().sort(function (a, b) {
    var av = (a && a[dateField]) || '';
    var bv = (b && b[dateField]) || '';
    return av < bv ? -1 : (av > bv ? 1 : 0);
  });
}

module.exports = {
  FACTOR_INSPECTOR_MAX_RANGE_DAYS: FACTOR_INSPECTOR_MAX_RANGE_DAYS,
  validateFactorInspectorRange_: validateFactorInspectorRange_,
  sortFinancialDocsByDate_: sortFinancialDocsByDate_
};
