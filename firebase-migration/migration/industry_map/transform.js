/**
 * transform.js
 * 純函式：把從 Sheets 匯出的一筆 IndustryMap 原始資料，轉成 Firestore 文件的
 * 形狀。跟 watchlist/transform.js 同樣的分工原則——不需要任何雲端憑證就能
 * 單元測試。這張表是股票代號→產業別的靜態參考資料，結構跟 Watchlist 幾乎
 * 一樣單純（見 firestore/schema.md §6）。
 */
var normalize = require('../lib/normalize');
var zfill4 = normalize.zfill4;

/**
 * sheetRow：從 export-sheets.gs 匯出的 JSON 裡一筆物件，鍵名是中文欄位名稱
 * （跟 apps-script/src/Config.gs 的 INDUSTRY_MAP_COLUMNS 一致：證券代號/
 * 證券名稱/產業別/市場別）。
 * migratedAtIso：這次遷移執行的時間戳記（ISO 字串），整批共用同一個值。
 *
 * 回傳 null 代表這筆資料代號是空的，不該匯入——代號是文件 ID 的來源。
 */
function transformIndustryMapRow(sheetRow, migratedAtIso) {
  var code = zfill4(sheetRow['證券代號']);
  if (!code) return null;
  return {
    id: code, // Firestore 文件 ID，import 腳本用這個當 doc(id)，不是文件內的欄位
    code: code,
    name: String(sheetRow['證券名稱'] || ''),
    industry: String(sheetRow['產業別'] || ''),
    market: String(sheetRow['市場別'] || ''),
    migratedAt: migratedAtIso,
    migratedFrom: 'sheets:IndustryMap'
  };
}

module.exports = { zfill4: zfill4, transformIndustryMapRow: transformIndustryMapRow };
