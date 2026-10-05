/**
 * checks.js
 * 純函式：資料遷移品質檢查邏輯，跟 watchlist/checks.js 幾乎一樣——只吃兩個
 * 陣列（來源 rows、Firestore 讀回來的 docs），回傳一份檢查報告，不需要任何
 * 雲端憑證就能單元測試。對照〈選股引擎遷移藍圖〉§05：列數核對、欄位型別檢查、
 * 唯一鍵完整性、交叉參照檢查、欄位內容比對。
 */
var zfill4 = require('./transform').zfill4;

/**
 * sourceRows：原始 Sheets 匯出的列（中文鍵名，跟 export-sheets.gs 的輸出一致）。
 * firestoreDocs：從 Firestore industry_map collection 讀回來的文件，每筆要帶
 * `id`（文件 ID）跟展開後的欄位（code/name/industry/market）。
 */
function validateIndustryMapMigration(sourceRows, firestoreDocs) {
  var issues = [];

  // 1. 列數核對：來源代號是空的列不算數（跟 transformIndustryMapRow 的跳過
  //    邏輯一致）。
  var validSourceCodes = sourceRows.map(function (r) { return zfill4(r['證券代號']); }).filter(function (c) { return c; });
  var uniqueSourceCodes = {};
  validSourceCodes.forEach(function (c) { uniqueSourceCodes[c] = true; });
  var sourceCount = Object.keys(uniqueSourceCodes).length;
  if (sourceCount !== firestoreDocs.length) {
    issues.push({
      level: 'error', check: '列數核對',
      detail: '來源不重複代號 ' + sourceCount + ' 筆，Firestore 文件 ' + firestoreDocs.length + ' 筆，不一致'
    });
  }

  // 2. 唯一鍵完整性：文件 ID 本身就是 code，防禦性檢查文件內容的 code 欄位
  //    是否跟文件 ID 一致。
  firestoreDocs.forEach(function (doc) {
    if (doc.id !== doc.code) {
      issues.push({
        level: 'error', check: '文件ID與code欄位一致性',
        detail: '文件 ID「' + doc.id + '」與 code 欄位「' + doc.code + '」不一致'
      });
    }
  });

  // 3. 型別檢查：四個欄位都該是字串。
  firestoreDocs.forEach(function (doc) {
    ['code', 'name', 'industry', 'market'].forEach(function (field) {
      if (typeof doc[field] !== 'string') {
        issues.push({
          level: 'error', check: '欄位型別',
          detail: '文件 ' + doc.id + ' 的 ' + field + ' 欄位型別是 ' + typeof doc[field] + '，應該是 string'
        });
      }
    });
  });

  // 4. 代號格式：一律 4 碼補零，跟 App 其餘部分保持一致。
  firestoreDocs.forEach(function (doc) {
    if (!/^\d{4}$/.test(doc.code)) {
      issues.push({
        level: 'error', check: '代號格式',
        detail: '文件 ' + doc.id + ' 的 code「' + doc.code + '」不是 4 碼數字'
      });
    }
  });

  // 5. 交叉比對：來源每個代號都該在 Firestore 找得到、產業別/市場別逐筆一致。
  var bySourceCode = {};
  sourceRows.forEach(function (r) {
    var c = zfill4(r['證券代號']);
    if (c) bySourceCode[c] = r;
  });
  firestoreDocs.forEach(function (doc) {
    var src = bySourceCode[doc.code];
    if (!src) {
      issues.push({ level: 'error', check: '來源比對', detail: 'Firestore 文件 ' + doc.id + ' 在來源資料裡找不到對應列' });
      return;
    }
    if (String(src['證券名稱'] || '') !== doc.name) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的名稱不一致：來源「' + src['證券名稱'] + '」vs Firestore「' + doc.name + '」' });
    }
    if (String(src['產業別'] || '') !== doc.industry) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的產業別不一致：來源「' + src['產業別'] + '」vs Firestore「' + doc.industry + '」' });
    }
    if (String(src['市場別'] || '') !== doc.market) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的市場別不一致：來源「' + src['市場別'] + '」vs Firestore「' + doc.market + '」' });
    }
  });

  return {
    ok: issues.filter(function (i) { return i.level === 'error'; }).length === 0,
    sourceCount: sourceCount,
    firestoreCount: firestoreDocs.length,
    issues: issues
  };
}

module.exports = { validateIndustryMapMigration: validateIndustryMapMigration };
