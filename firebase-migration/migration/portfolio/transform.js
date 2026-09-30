/**
 * transform.js
 * 純函式：把從 Sheets 匯出的一筆 Portfolio 原始資料，轉成 Firestore 文件的形狀。
 * 跟 watchlist/transform.js 同樣的分工原則——不需要任何雲端憑證就能單元測試。
 */
var normalize = require('../lib/normalize');
var zfill4 = normalize.zfill4;
var normalizeDateStr = normalize.normalizeDateStr;

/** Sheets 儲存格常見型別問題（空字串/數字字串/真正的數字都可能出現）一律轉成
 *  真正的 number，parse 不出來就回傳 null——不要用 0 當預設值，0 是一個合法的
 *  股數/價格，用 0 掩蓋「這欄本來就是空的或壞掉的」會讓後面的品質檢查看不出來。 */
function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  var n = Number(raw);
  return isNaN(n) ? null : n;
}

/** 狀態欄位原文字是中文「持有中」/「已賣出」，遷移時翻成英文列舉，避免中文字面值
 *  散落在 Firestore 版後端到處要用字串比對——跟現行 Portfolio.gs 的
 *  `r['狀態'] || '持有中'` 預設邏輯一致：空白/未知值一律當「持有中」。 */
function translateStatus(raw) {
  var s = String(raw || '').trim();
  return s === '已賣出' ? 'sold' : 'holding';
}

/**
 * sheetRow：從 export-sheets.gs 匯出的 JSON 裡一筆物件，鍵名是中文欄位名稱
 * （跟 apps-script/src/Config.gs 的 PORTFOLIO_COLUMNS 一致：交易ID/證券代號/
 * 證券名稱/買進日期/買進價格/股數/備註/狀態/賣出日期/賣出價格）。
 * migratedAtIso：這次遷移執行的時間戳記（ISO 字串），整批共用同一個值。
 *
 * 回傳 null 代表這筆資料交易ID是空的，不該匯入——交易ID是文件 ID 的來源，沒有
 * 就沒辦法用既有 UUID 當 upsert 鍵。
 */
function transformPortfolioRow(sheetRow, migratedAtIso) {
  var transactionId = String(sheetRow['交易ID'] || '').trim();
  if (!transactionId) return null;
  var sellDateStr = normalizeDateStr(sheetRow['賣出日期']);
  return {
    id: transactionId, // Firestore 文件 ID，import 腳本用這個當 doc(id)，不是文件內的欄位
    transactionId: transactionId,
    code: zfill4(sheetRow['證券代號']),
    name: String(sheetRow['證券名稱'] || ''),
    buyDate: normalizeDateStr(sheetRow['買進日期']),
    buyPrice: parseNumber(sheetRow['買進價格']),
    shares: parseNumber(sheetRow['股數']),
    note: String(sheetRow['備註'] || ''),
    status: translateStatus(sheetRow['狀態']),
    sellDate: sellDateStr || null,
    sellPrice: parseNumber(sheetRow['賣出價格']),
    migratedAt: migratedAtIso,
    migratedFrom: 'sheets:Portfolio'
  };
}

module.exports = {
  zfill4: zfill4,
  normalizeDateStr: normalizeDateStr,
  parseNumber: parseNumber,
  translateStatus: translateStatus,
  transformPortfolioRow: transformPortfolioRow
};
