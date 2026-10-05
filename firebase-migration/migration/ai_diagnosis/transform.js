/**
 * transform.js
 * 純函式：把從 Sheets 匯出的一筆 AiDiagnosis 原始資料，轉成 Firestore 文件的
 * 形狀。跟 watchlist/portfolio 的 transform.js 同樣的分工原則——不需要任何
 * 雲端憑證就能單元測試。
 */
var normalize = require('../lib/normalize');
var zfill4 = normalize.zfill4;
var normalizeDateStr = normalize.normalizeDateStr;
var parseNumber = normalize.parseNumber;

/** 診斷類型原文字是中文「深度診斷」/「持股續抱診斷」/「TOP3推薦」，遷移時翻成
 *  英文列舉，跟 Portfolio 的狀態欄位同樣理由——避免中文字面值散落在 Firestore
 *  版後端到處要用字串比對。跟現行 upsertAiDiagnosisRow_／aiDiagnosisRowKey_ 的
 *  `record['診斷類型'] || '深度診斷'` 預設邏輯一致：空白/未知值一律當深度診斷
 *  （改版前只有單一種診斷類型的舊資料就是沒有這欄）。 */
function translateDiagnosisType(raw) {
  var s = String(raw || '').trim();
  if (s === '持股續抱診斷') return 'hold';
  if (s === 'TOP3推薦') return 'top3';
  return 'deep';
}

/** 跟 aiDiagnosisRowKey_ 的比對鍵邏輯一致（代號+日期+診斷類型），用底線串接
 *  當 Firestore 文件 ID——這三個值碰巧都不含底線（code 是數字或固定值
 *  'TOP3'，date 是 YYYY-MM-DD，diagnosisType 是 deep/hold/top3），串接後
 *  不會有歧義。 */
function buildDocId_(code, date, diagnosisType) {
  return code + '_' + date + '_' + diagnosisType;
}

/**
 * sheetRow：從 export-sheets.gs 匯出的 JSON 裡一筆物件，鍵名是中文欄位名稱
 * （跟 apps-script/src/Config.gs 的 AI_DIAGNOSIS_COLUMNS 一致：日期/證券代號/
 * 證券名稱/Armor_Score/操作策略/最終建議/診斷類型/診斷內容/時間戳記）。
 * migratedAtIso：這次遷移執行的時間戳記（ISO 字串），整批共用同一個值。
 *
 * 回傳 null 代表這筆資料的代號或日期是空的，不該匯入——這兩個值是文件 ID 的
 * 組成部分，缺一個就沒辦法用既有的「代號+日期+診斷類型」當 upsert 鍵。
 *
 * 注意：Top3 推薦這種診斷類型的「證券代號」欄位固定存文字 'TOP3'（不是真正的
 * 股票代號），不是資料壞掉——`zfill4('TOP3')` 因為已經是 4 個字元會原樣回傳，
 * 不會被誤補零成奇怪的值。
 */
function transformAiDiagnosisRow(sheetRow, migratedAtIso) {
  var code = zfill4(sheetRow['證券代號']);
  var date = normalizeDateStr(sheetRow['日期']);
  if (!code || !date) return null;
  var diagnosisType = translateDiagnosisType(sheetRow['診斷類型']);
  return {
    id: buildDocId_(code, date, diagnosisType), // Firestore 文件 ID，不是文件內的欄位
    date: date,
    code: code,
    name: String(sheetRow['證券名稱'] || ''),
    armorScore: parseNumber(sheetRow['Armor_Score']),
    strategy: String(sheetRow['操作策略'] || ''),
    verdict: String(sheetRow['最終建議'] || ''),
    diagnosisType: diagnosisType,
    content: String(sheetRow['診斷內容'] || ''),
    timestamp: String(sheetRow['時間戳記'] || ''),
    migratedAt: migratedAtIso,
    migratedFrom: 'sheets:AiDiagnosis'
  };
}

module.exports = {
  zfill4: zfill4,
  normalizeDateStr: normalizeDateStr,
  parseNumber: parseNumber,
  translateDiagnosisType: translateDiagnosisType,
  transformAiDiagnosisRow: transformAiDiagnosisRow
};
