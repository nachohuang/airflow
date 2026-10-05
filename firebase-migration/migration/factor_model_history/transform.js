/**
 * transform.js
 * 純函式：把從 Sheets 匯出的一筆 FactorModelHistory 原始資料，轉成 Firestore
 * 文件的形狀。跟其他表的 transform.js 同樣的分工原則——不需要任何雲端憑證就能
 * 單元測試。這張表是 Phase 3 的一部分（跟 Analysis.gs 的戰報計算邏輯一起搬），
 * 不是 Phase 2 就遷移完的表——`hybrid`/`factor_model_rank` 這兩種戰報篩選策略
 * 要靠這張表的資料才能在 Firebase 版正常運作。
 */
var normalize = require('../lib/normalize');
var normalizeDateTimeStr = normalize.normalizeDateTimeStr;
var parseNumber = normalize.parseNumber;

/** 跟 apps-script/src/FactorRegression.gs 的 applyFactorModel_ 比對邏輯一致：
 *  「目前套用版本」欄位含有「套用中」字樣才算是目前生效的模型，翻成布林值，
 *  避免中文字面值散落在 Firestore 版後端到處要用字串比對。 */
function isApplied_(raw) {
  return String(raw || '').indexOf('套用中') !== -1;
}

/** 跟 aiDiagnosisRowKey_／buildKey_（ai_diagnosis 表）同樣的複合鍵手法：
 *  執行時間+標的Label 一起當 Firestore 文件 ID，用底線串接——同一次執行會對
 *  兩個 label（return1m／downsideResistance）各留一筆，不能只用執行時間當鍵
 *  （那樣兩筆會互相覆蓋）。時間字串裡的空白/冒號換成底線/連字號，避免文件 ID
 *  裡出現容易跟路徑分隔符搞混的字元。 */
function buildDocId_(timestamp, labelKey) {
  return timestamp.replace(/ /g, '_').replace(/:/g, '-') + '_' + labelKey;
}

/**
 * sheetRow：從 export-sheets.gs 匯出的 JSON 裡一筆物件，鍵名是中文欄位名稱
 * （跟 apps-script/src/Config.gs 的 FACTOR_MODEL_COLUMNS 一致：執行時間/
 * 標的Label/L1正規化強度/使用特徵/訓練列數/R2/權重(JSON)/狀態/目前套用版本）。
 * migratedAtIso：這次遷移執行的時間戳記（ISO 字串），整批共用同一個值。
 *
 * 回傳 null 代表這筆資料的執行時間或標的Label是空的，不該匯入——這兩個值是
 * 文件 ID 的組成部分。
 */
function transformFactorModelRow(sheetRow, migratedAtIso) {
  var timestamp = normalizeDateTimeStr(sheetRow['執行時間']);
  var labelKey = String(sheetRow['標的Label'] || '').trim();
  if (!timestamp || !labelKey) return null;

  var featureColumnsRaw = String(sheetRow['使用特徵'] || '');
  var featureColumns = featureColumnsRaw
    ? featureColumnsRaw.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; })
    : [];

  var weights = {};
  try {
    weights = JSON.parse(sheetRow['權重(JSON)'] || '{}');
  } catch (e) {
    weights = {}; // 理論上不該發生（寫入時一定是 JSON.stringify 過的），但遷移腳本
    // 不該假設來源資料一定乾淨，解析失敗就當空權重，不讓整批遷移因為一筆壞資料中斷。
  }

  return {
    id: buildDocId_(timestamp, labelKey),
    timestamp: timestamp,
    labelKey: labelKey,
    l1Reg: parseNumber(sheetRow['L1正規化強度']),
    featureColumns: featureColumns,
    trainRows: parseNumber(sheetRow['訓練列數']),
    r2: parseNumber(sheetRow['R2']),
    weights: weights,
    status: String(sheetRow['狀態'] || ''),
    applied: isApplied_(sheetRow['目前套用版本']),
    migratedAt: migratedAtIso,
    migratedFrom: 'sheets:FactorModelHistory'
  };
}

module.exports = {
  normalizeDateTimeStr: normalizeDateTimeStr,
  parseNumber: parseNumber,
  isApplied_: isApplied_,
  buildDocId_: buildDocId_,
  transformFactorModelRow: transformFactorModelRow
};
