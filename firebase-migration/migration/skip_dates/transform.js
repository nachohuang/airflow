/**
 * transform.js
 * 純函式：把從 Sheets 匯出的一筆 SkipDates 原始資料，轉成 Firestore 文件的
 * 形狀。跟其他表的 transform.js 同樣的分工原則——不需要任何雲端憑證就能
 * 單元測試。這是目前欄位最少、邏輯最單純的一張表。
 */
var normalize = require('../lib/normalize');
var normalizeDateStr = normalize.normalizeDateStr;

/**
 * sheetRow：從 export-sheets.gs 匯出的 JSON 裡一筆物件，鍵名是中文欄位名稱
 * （跟 apps-script/src/Config.gs 的 SKIP_DATES_COLUMNS 一致：日期/原因）。
 * migratedAtIso：這次遷移執行的時間戳記（ISO 字串），整批共用同一個值。
 *
 * 回傳 null 代表這筆資料的日期是空的，不該匯入——日期是文件 ID 的來源，沒有
 * 就沒辦法用既有的日期當 upsert 鍵，跟現行 listSkipDates() 把日期空白的列
 * 直接過濾掉的邏輯一致。
 */
function transformSkipDateRow(sheetRow, migratedAtIso) {
  var date = normalizeDateStr(sheetRow['日期']);
  if (!date) return null;
  return {
    id: date, // Firestore 文件 ID，import 腳本用這個當 doc(id)，不是文件內的欄位
    date: date,
    reason: String(sheetRow['原因'] || ''),
    migratedAt: migratedAtIso,
    migratedFrom: 'sheets:SkipDates'
  };
}

module.exports = { normalizeDateStr: normalizeDateStr, transformSkipDateRow: transformSkipDateRow };
