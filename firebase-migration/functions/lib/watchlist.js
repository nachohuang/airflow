/**
 * watchlist.js
 * 觀察個股清單的純邏輯，從 apps-script/src/Watchlist.gs 的 getWatchlist()／
 * addToWatchlist() 拆出來——跟持股庫存一樣，I/O（讀寫 Firestore `watchlist`
 * collection、查 BigQuery 最新收盤價、查最新戰報燈號）留給 functions/index.js，
 * 這裡只管「資料到手之後怎麼組」，方便不用雲端憑證就能單元測試。
 *
 * 複製時機：2026-10-05，對照 apps-script/src/Watchlist.gs 當時的內容。
 */

/**
 * watchlistDocs：Firestore `watchlist` collection 的全部文件（對照
 * firestore/schema.md §1 的英文欄名：code／name／addedDate／note）。
 * bqInfoByCode：{code: {close, date, name}}——index.js 統一查一次 BigQuery
 *   拿到的最新收盤價＋補救用的最新證券名稱（見 index.js fetchBqInfoForCodes_
 *   的說明，取代 apps-script 版 getStockNameByCode／getLatestCloseByCode_
 *   兩支各自查一次的設計）。
 * signalByCode：{code: {date, strategy, action}}——每檔代號最近一次戰報燈號。
 *
 * 回傳依加入日期新到舊排序的陣列，跟 getWatchlist() 的排序規則一致。
 */
function buildWatchlistItems_(watchlistDocs, bqInfoByCode, signalByCode) {
  bqInfoByCode = bqInfoByCode || {};
  signalByCode = signalByCode || {};
  var items = (watchlistDocs || []).map(function (doc) {
    var bqInfo = bqInfoByCode[doc.code];
    return {
      code: doc.code,
      name: doc.name || (bqInfo && bqInfo.name) || '',
      addedDate: doc.addedDate || null,
      note: doc.note || '',
      latestClose: bqInfo ? bqInfo.close : null,
      signal: signalByCode[doc.code] || null
    };
  });
  items.sort(function (a, b) { return (a.addedDate || '') < (b.addedDate || '') ? 1 : -1; });
  return items;
}

/**
 * addToWatchlist 的「跟持股互斥」檢查：已經是持有中的股票不能加進觀察清單
 * （見 apps-script/src/Watchlist.gs addToWatchlist 的同名檢查），portfolioMap
 * 是 lib/portfolio.js buildPortfolioMap_() 的回傳值（{code: {cost, buyDate}}）。
 */
function assertNotHolding_(code, portfolioMap) {
  if (portfolioMap && portfolioMap[code]) {
    throw new Error(code + ' 目前是持有中的股票，已經在「持股庫存」裡了，不需要重複加進觀察清單');
  }
}

/**
 * addToWatchlist 的 upsert 合併邏輯：existingData 是 Firestore 既有文件的資料
 * （沒有就傳 null），回傳要整份 set() 進 Firestore 的欄位——同一檔股票重複加入
 * 只更新名稱/備註，不會改動原本的加入日期（跟 apps-script 版「就地更新既有列」
 * 邏輯一致）。todayStr 是新增時要寫入的「加入日期」，由呼叫端算好傳進來
 * （純函式不自己讀系統時間，方便測試）。
 */
function mergeWatchlistDoc_(existingData, code, name, note, todayStr) {
  if (existingData) {
    return {
      code: code,
      name: name || existingData.name || '',
      addedDate: existingData.addedDate || todayStr,
      note: note || existingData.note || ''
    };
  }
  return { code: code, name: name || '', addedDate: todayStr, note: note || '' };
}

module.exports = {
  buildWatchlistItems_: buildWatchlistItems_,
  assertNotHolding_: assertNotHolding_,
  mergeWatchlistDoc_: mergeWatchlistDoc_
};
