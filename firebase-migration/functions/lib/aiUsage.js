/**
 * aiUsage.js
 * AI 呼叫的用量／費用歷史記錄，純聚合邏輯從 apps-script/src/AiDiagnosis.gs 的
 * `getAiUsageSummary` 搬過來——寫入（`logAiUsage_`）跟查詢篩選（`date >= cutoff`）
 * 都是 I/O，留給 index.js；這裡只管「已經查回來的一批記錄要怎麼分組/加總」。
 *
 * apps-script 版把每次呼叫寫進 Sheets 的 `AiUsage` 分頁，這版改寫進 Firestore
 * 的 `ai_usage` collection（見 firestore/schema.md 待補）——欄位名稱從中文改成
 * 英文：`date`／`timestamp`／`provider`／`model`／`code`／`inputTokens`／
 * `outputTokens`／`costUsd`，`code` 對單檔診斷是股票代號，對候選名單橫向比較／
 * Top3 推薦是常數 `'SHORTLIST_SCAN'`／`'TOP3_SCAN'`（跟 apps-script 版一致）。
 */
var utils = require('./utils');

/**
 * records：已經從 Firestore 查回來、日期在統計範圍內的 `ai_usage` 文件（呼叫端
 * 用 `date >= cutoffStr` 篩過，這支純函式不重複篩，只負責分組聚合）。
 * days：統計範圍（只是原樣放進回傳值，不影響計算，給前端顯示「最近 N 天」用）。
 * nowDateStr：「今天」的日期字串（呼叫端算好傳進來，這支純函式不自己讀
 * `new Date()`，方便測試）。
 * 回傳形狀跟 apps-script 版 getAiUsageSummary 一致：
 * {daily: [{date, calls, inputTokens, outputTokens, cost}, ...]（新到舊排序）,
 *  totalCost, totalCalls, todayCost, days}
 */
function buildAiUsageSummary_(records, days, nowDateStr) {
  var byDate = {};
  (records || []).forEach(function (r) {
    var d = r.date;
    if (!byDate[d]) byDate[d] = { date: d, calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    byDate[d].calls += 1;
    byDate[d].inputTokens += r.inputTokens || 0;
    byDate[d].outputTokens += r.outputTokens || 0;
    byDate[d].cost += r.costUsd || 0;
  });
  var daily = Object.keys(byDate).map(function (d) { return byDate[d]; })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; });

  var totalCost = 0;
  (records || []).forEach(function (r) { totalCost += r.costUsd || 0; });

  var todayCost = byDate[nowDateStr] ? byDate[nowDateStr].cost : 0;

  return {
    daily: daily,
    totalCost: utils.round_(totalCost, 4),
    totalCalls: (records || []).length,
    todayCost: utils.round_(todayCost, 4),
    days: days
  };
}

module.exports = { buildAiUsageSummary_: buildAiUsageSummary_ };
