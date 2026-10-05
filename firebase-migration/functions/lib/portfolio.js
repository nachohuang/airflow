/**
 * portfolio.js
 * 從 Firestore `portfolio_lots` collection（Phase 2 已經遷移完成的資料，見
 * firestore/schema.md §2）組出 `computeFactors_`/`diagnoseRow_` 需要的
 * portfolioMap（{code: {cost, buyDate}}）。跟 apps-script/src/Portfolio.gs
 * 的 `aggregateLots_`/`getPortfolioMap_` 是同一套聚合邏輯（加權平均成本、
 * 最早買進日期），但操作的是 Firestore 文件的英文欄名（`buyPrice`/`shares`/
 * `buyDate`/`status`，Phase 2 的 transform 已經保證型別是乾淨的 number／
 * string／null，不是 Sheets 那種什麼型別都可能出現的儲存格），不是 Sheets
 * 原始列的中文欄名——所以不是直接複製 `aggregateLots_`，是針對 Firestore
 * 文件形狀重新寫一次同一套數學。
 */

/** lots：同一檔股票「持有中」的 lot 陣列，每筆要有 buyPrice（number）、shares
 *  （number）、buyDate（'YYYY-MM-DD' 字串）。回傳加權平均成本（四捨五入到
 *  4 位小數，跟 aggregateLots_ 的 round_(v, 4) 一致）跟最早買進日期。 */
function aggregateLots_(lots) {
  var totalShares = 0;
  var totalCost = 0;
  var earliestBuyDate = null;
  lots.forEach(function (lot) {
    var shares = lot.shares || 0;
    var price = lot.buyPrice || 0;
    totalShares += shares;
    totalCost += shares * price;
    var d = lot.buyDate;
    if (d && (!earliestBuyDate || d < earliestBuyDate)) earliestBuyDate = d;
  });
  var avgCost = totalShares > 0 ? Math.round((totalCost / totalShares) * 10000) / 10000 : 0;
  return { totalShares: totalShares, avgCost: avgCost, earliestBuyDate: earliestBuyDate };
}

/**
 * lotDocs：從 Firestore `portfolio_lots` collection 讀回來的全部文件（不需要先篩
 * status，這支自己只挑 status === 'holding' 的——跟 getPortfolioMap_ 的
 * `(r['狀態'] || '持有中') === '持有中'` 預設邏輯一致，Phase 2 的 transform 已經
 * 保證 status 一定有值、不會是空字串，所以這裡不用再處理「沒有 status 欄位」的
 * 防禦分支）。
 * 回傳 {code: {cost, buyDate}}，給 computeFactors_／diagnoseRow_ 當 portfolioMap 用。
 */
function buildPortfolioMap_(lotDocs) {
  var byCode = {};
  (lotDocs || []).forEach(function (lot) {
    if (lot.status !== 'holding') return;
    if (!lot.code) return;
    if (!byCode[lot.code]) byCode[lot.code] = [];
    byCode[lot.code].push(lot);
  });
  var map = {};
  Object.keys(byCode).forEach(function (code) {
    var agg = aggregateLots_(byCode[code]);
    map[code] = { cost: agg.avgCost, buyDate: agg.earliestBuyDate };
  });
  return map;
}

module.exports = {
  aggregateLots_: aggregateLots_,
  buildPortfolioMap_: buildPortfolioMap_
};
