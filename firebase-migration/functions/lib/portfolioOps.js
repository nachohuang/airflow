/**
 * portfolioOps.js
 * 持股庫存卡片／歷史結案紀錄的純邏輯，從 apps-script/src/Portfolio.gs 的
 * getPortfolio()／getClosedPortfolioHistory() 拆出來——跟 lib/portfolio.js
 * 不同：lib/portfolio.js 的 buildPortfolioMap_ 是給戰報計算（computeFactors_／
 * diagnoseRow_）用的精簡版 {code: {cost, buyDate}}，這支給「持股庫存」頁面用，
 * 要保留每一筆個別買進紀錄（lots）跟卡片顯示用的 latestClose／signal，形狀
 * 完全不同，所以是獨立的檔案，但共用同一支 aggregateLots_ 做加權平均成本的
 * 數學（同一套規則不該有兩份不同的實作）。
 *
 * 複製時機：2026-10-05，對照 apps-script/src/Portfolio.gs 當時的內容。
 */
var portfolio = require('./portfolio');

function round_(v, digits) {
  if (v === null || v === undefined || isNaN(v)) return null;
  var f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/**
 * lotDocs：Firestore `portfolio_lots` collection 的全部文件（對照
 * firestore/schema.md §2 的英文欄名：code／name／buyDate／buyPrice／shares／
 * note／status／sellDate／sellPrice），這支自己篩 status === 'holding'（跟
 * lib/portfolio.js buildPortfolioMap_ 同樣的職責劃分，呼叫端不用先篩）。
 * bqInfoByCode／signalByCode：跟 lib/watchlist.js buildWatchlistItems_ 用的是
 *   同一份、由 index.js 統一查一次 BigQuery／Firestore 組出來的資料。
 *
 * 回傳依代號排序的卡片陣列，每張卡片的 lots 依買進日期由舊到新排序——跟
 * getPortfolio() 的排序規則一致。
 */
function buildPortfolioCards_(lotDocs, bqInfoByCode, signalByCode) {
  bqInfoByCode = bqInfoByCode || {};
  signalByCode = signalByCode || {};
  var holding = (lotDocs || []).filter(function (lot) { return lot.status === 'holding'; });

  var byCode = {};
  holding.forEach(function (lot) {
    if (!lot.code) return;
    if (!byCode[lot.code]) byCode[lot.code] = { code: lot.code, name: lot.name || '', lots: [] };
    if (lot.name) byCode[lot.code].name = lot.name;
    byCode[lot.code].lots.push({
      id: lot.transactionId,
      buyDate: lot.buyDate,
      cost: lot.buyPrice,
      shares: lot.shares,
      note: lot.note || ''
    });
  });

  var items = Object.keys(byCode).map(function (code) {
    var entry = byCode[code];
    var agg = portfolio.aggregateLots_(entry.lots.map(function (l) {
      return { buyPrice: l.cost, shares: l.shares, buyDate: l.buyDate };
    }));
    entry.lots.sort(function (a, b) { return (a.buyDate || '') < (b.buyDate || '') ? -1 : 1; });
    var bqInfo = bqInfoByCode[code];
    return {
      code: code,
      name: entry.name || (bqInfo && bqInfo.name) || '',
      cost: agg.avgCost,
      totalShares: agg.totalShares,
      buyDate: agg.earliestBuyDate,
      lots: entry.lots,
      note: entry.lots.length === 1 ? entry.lots[0].note : '',
      latestClose: bqInfo ? bqInfo.close : null,
      signal: signalByCode[code] || null
    };
  });
  items.sort(function (a, b) { return a.code < b.code ? -1 : 1; });
  return items;
}

/**
 * lotDocs 裡 status === 'sold' 的紀錄，依 code+sellDate+sellPrice 分組（同一次
 * 結案動作共用同一組賣出日期/價格），算出已實現損益——跟
 * getClosedPortfolioHistory() 同一套分組跟損益公式。回傳依賣出日期新到舊排序。
 */
function buildClosedHistory_(lotDocs) {
  var sold = (lotDocs || []).filter(function (lot) { return lot.status === 'sold'; });
  var byGroup = {};
  var order = [];
  sold.forEach(function (lot) {
    var key = lot.code + '|' + lot.sellDate + '|' + lot.sellPrice;
    if (!byGroup[key]) {
      byGroup[key] = { code: lot.code, name: lot.name || '', sellDate: lot.sellDate, sellPrice: lot.sellPrice, lots: [] };
      order.push(key);
    }
    byGroup[key].lots.push({ buyDate: lot.buyDate, cost: lot.buyPrice, shares: lot.shares });
  });

  var groups = order.map(function (key) {
    var g = byGroup[key];
    var agg = portfolio.aggregateLots_(g.lots.map(function (l) {
      return { buyPrice: l.cost, shares: l.shares, buyDate: l.buyDate };
    }));
    return {
      code: g.code,
      name: g.name,
      sellDate: g.sellDate,
      sellPrice: g.sellPrice,
      avgCost: agg.avgCost,
      totalShares: agg.totalShares,
      buyDate: agg.earliestBuyDate,
      realizedPct: agg.avgCost ? round_((g.sellPrice - agg.avgCost) / agg.avgCost * 100, 2) : null,
      realizedAmount: round_((g.sellPrice - agg.avgCost) * agg.totalShares, 0)
    };
  });
  groups.sort(function (a, b) { return (a.sellDate || '') < (b.sellDate || '') ? 1 : -1; });
  return groups;
}

module.exports = {
  buildPortfolioCards_: buildPortfolioCards_,
  buildClosedHistory_: buildClosedHistory_
};
