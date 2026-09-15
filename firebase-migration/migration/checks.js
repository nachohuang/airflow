/**
 * checks.js
 * 純函式：資料遷移品質檢查邏輯，跟「怎麼把兩份資料抓進記憶體」分開——這支只吃
 * 兩個陣列（來源 rows、Firestore 讀回來的 docs），回傳一份檢查報告，不需要任何
 * 雲端憑證就能單元測試。對照〈選股引擎遷移藍圖〉§05 列出的驗證步驟清單逐項實作：
 * 列數核對、欄位型別檢查、唯一鍵完整性、交叉參照檢查、欄位內容比對。
 */
var zfill4 = require('./transform').zfill4;

/**
 * sourceRows：原始 Sheets 匯出的列（中文鍵名，跟 export-sheets.gs 的輸出一致）。
 * firestoreDocs：從 Firestore watchlist collection 讀回來的文件，每筆要帶
 * `id`（文件 ID）跟展開後的欄位（code/name/addedDate/note）。
 */
function validateWatchlistMigration(sourceRows, firestoreDocs) {
  var issues = [];

  // 1. 列數核對：來源代號是空的列不算數（跟 transformWatchlistRow 的跳過邏輯一致）。
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

  // 2. 唯一鍵完整性：文件 ID 本身就是 code，理論上不可能重複，但防禦性檢查文件
  //    內容的 code 欄位是否跟文件 ID 一致（避免 import 腳本哪裡寫錯，用了不對的
  //    doc id 或不對的欄位值）。
  firestoreDocs.forEach(function (doc) {
    if (doc.id !== doc.code) {
      issues.push({
        level: 'error', check: '文件ID與code欄位一致性',
        detail: '文件 ID「' + doc.id + '」與 code 欄位「' + doc.code + '」不一致'
      });
    }
  });

  // 3. 型別檢查：這幾個欄位都該是字串，不該殘留 Sheets 常見的型別問題（數字/布林/
  //    undefined 混進本來該是字串的欄位）。
  firestoreDocs.forEach(function (doc) {
    ['code', 'name', 'addedDate', 'note'].forEach(function (field) {
      if (typeof doc[field] !== 'string') {
        issues.push({
          level: 'error', check: '欄位型別',
          detail: '文件 ' + doc.id + ' 的 ' + field + ' 欄位型別是 ' + typeof doc[field] + '，應該是 string'
        });
      }
    });
  });

  // 4. 代號格式：一律 4 碼補零，跟 App 其餘部分（zfill4）保持一致，避免同一檔股票
  //    因為代號格式不同被當成兩檔不同的股票。
  firestoreDocs.forEach(function (doc) {
    if (!/^\d{4}$/.test(doc.code)) {
      issues.push({
        level: 'error', check: '代號格式',
        detail: '文件 ' + doc.id + ' 的 code「' + doc.code + '」不是 4 碼數字'
      });
    }
  });

  // 5. 日期格式：addedDate 該符合 YYYY-MM-DD（空字串允許，代表來源本來就沒填），
  //    這裡只降級成警告，不算硬性錯誤——日期格式異常不影響資料本身的正確性，
  //    但值得人工看一眼確認來源資料是不是本來就有問題。
  firestoreDocs.forEach(function (doc) {
    if (doc.addedDate && !/^\d{4}-\d{2}-\d{2}$/.test(doc.addedDate)) {
      issues.push({
        level: 'warning', check: '日期格式',
        detail: '文件 ' + doc.id + ' 的 addedDate「' + doc.addedDate + '」不是 YYYY-MM-DD 格式'
      });
    }
  });

  // 6. 交叉比對：來源每個代號都該在 Firestore 找得到、內容（名稱/備註）逐筆一致。
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
    if (String(src['備註'] || '') !== doc.note) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的備註不一致：來源「' + src['備註'] + '」vs Firestore「' + doc.note + '」' });
    }
  });

  return {
    ok: issues.filter(function (i) { return i.level === 'error'; }).length === 0,
    sourceCount: sourceCount,
    firestoreCount: firestoreDocs.length,
    issues: issues
  };
}

module.exports = { validateWatchlistMigration: validateWatchlistMigration };
