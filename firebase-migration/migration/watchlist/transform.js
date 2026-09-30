/**
 * transform.js
 * 純函式：把從 Sheets 匯出的一筆 Watchlist 原始資料，轉成 Firestore 文件的形狀。
 * 跟 import-firestore.js（實際打 Firebase Admin SDK 的部分）分開，這支不需要任何
 * 雲端憑證就能單元測試，對照 apps-script/test 既有的測試風格與紀律。
 */
var normalize = require('../lib/normalize');
var zfill4 = normalize.zfill4;
var normalizeDateStr = normalize.normalizeDateStr;

/**
 * sheetRow：從 export-sheets.gs 匯出的 JSON 裡一筆物件，鍵名是中文欄位名稱
 * （跟 apps-script/src/Config.gs 的 WATCHLIST_COLUMNS 一致：證券代號/證券名稱/
 * 加入日期/備註）。
 * migratedAtIso：這次遷移執行的時間戳記（ISO 字串），整批共用同一個值，方便
 * 事後查是哪一次遷移寫入的。
 *
 * 回傳 null 代表這筆資料代號是空的，不該匯入——防禦性處理，理論上 Sheets 端
 * 不該有這種列，但遷移腳本不該假設來源資料一定乾淨（這支 App 過去已經處理過
 * 不只一次代號格式不一致的問題）。
 *
 * 缺欄位一律補空字串，不能是 undefined——Firestore 的 Admin SDK 遇到欄位值是
 * undefined 會直接拋例外拒絕寫入，跟「這欄本來就沒有值」需要用空字串明確表達
 * 是兩回事。
 */
function transformWatchlistRow(sheetRow, migratedAtIso) {
  var code = zfill4(sheetRow['證券代號']);
  if (!code) return null;
  return {
    id: code, // Firestore 文件 ID，import 腳本用這個當 doc(id)，不是文件內的欄位
    code: code,
    name: String(sheetRow['證券名稱'] || ''),
    addedDate: normalizeDateStr(sheetRow['加入日期']),
    note: String(sheetRow['備註'] || ''),
    migratedAt: migratedAtIso,
    migratedFrom: 'sheets:Watchlist'
  };
}

module.exports = { zfill4: zfill4, normalizeDateStr: normalizeDateStr, transformWatchlistRow: transformWatchlistRow };
