/**
 * checks.js
 * 純函式：資料遷移品質檢查邏輯，跟其他表的 checks.js 同樣的分工原則——只吃
 * 兩個陣列（來源 rows、Firestore 讀回來的 docs），回傳一份檢查報告，不需要
 * 任何雲端憑證就能單元測試。對照〈選股引擎遷移藍圖〉§05：列數核對、欄位型別
 * 檢查、唯一鍵完整性、交叉參照檢查、欄位內容比對。
 */
var normalizeDateStr = require('./transform').normalizeDateStr;

/**
 * sourceRows：原始 Sheets 匯出的列（中文鍵名，跟 export-sheets.gs 的輸出一致）。
 * firestoreDocs：從 Firestore skip_dates collection 讀回來的文件，每筆要帶
 * `id`（文件 ID）跟展開後的欄位（date/reason）。
 */
function validateSkipDatesMigration(sourceRows, firestoreDocs) {
  var issues = [];

  // 1. 列數核對：來源日期是空的列不算數（跟 transformSkipDateRow 的跳過邏輯
  //    一致），用正規化後的日期去重——同一個停跑日理論上不該在 Sheets 裡出現
  //    兩次，但遷移腳本不該假設來源資料一定乾淨。
  var validSourceDates = sourceRows
    .map(function (r) { return normalizeDateStr(r['日期']); })
    .filter(function (d) { return d; });
  var uniqueSourceDates = {};
  validSourceDates.forEach(function (d) { uniqueSourceDates[d] = true; });
  var sourceCount = Object.keys(uniqueSourceDates).length;
  if (sourceCount !== firestoreDocs.length) {
    issues.push({
      level: 'error', check: '列數核對',
      detail: '來源不重複日期 ' + sourceCount + ' 筆，Firestore 文件 ' + firestoreDocs.length + ' 筆，不一致'
    });
  }

  // 2. 唯一鍵完整性：文件 ID 本身就是 date，防禦性檢查文件內容的 date 欄位
  //    是否跟文件 ID 一致。
  firestoreDocs.forEach(function (doc) {
    if (doc.id !== doc.date) {
      issues.push({
        level: 'error', check: '文件ID與date欄位一致性',
        detail: '文件 ID「' + doc.id + '」與 date 欄位「' + doc.date + '」不一致'
      });
    }
  });

  // 3. 型別檢查：兩個欄位都該是字串。
  firestoreDocs.forEach(function (doc) {
    ['date', 'reason'].forEach(function (field) {
      if (typeof doc[field] !== 'string') {
        issues.push({
          level: 'error', check: '欄位型別',
          detail: '文件 ' + doc.id + ' 的 ' + field + ' 欄位型別是 ' + typeof doc[field] + '，應該是 string'
        });
      }
    });
  });

  // 4. 日期格式：該符合 YYYY-MM-DD，降級成警告（不影響資料本身正不正確，但
  //    值得人工看一眼），跟其他表的日期格式檢查同樣理由。
  firestoreDocs.forEach(function (doc) {
    if (doc.date && !/^\d{4}-\d{2}-\d{2}$/.test(doc.date)) {
      issues.push({
        level: 'warning', check: '日期格式',
        detail: '文件 ' + doc.id + ' 的 date「' + doc.date + '」不是 YYYY-MM-DD 格式'
      });
    }
  });

  // 5. 交叉比對：來源每個日期都該在 Firestore 找得到、原因逐筆一致。
  var bySourceDate = {};
  sourceRows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (d) bySourceDate[d] = r;
  });
  firestoreDocs.forEach(function (doc) {
    var src = bySourceDate[doc.date];
    if (!src) {
      issues.push({ level: 'error', check: '來源比對', detail: 'Firestore 文件 ' + doc.id + ' 在來源資料裡找不到對應列' });
      return;
    }
    if (String(src['原因'] || '') !== doc.reason) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的原因不一致：來源「' + src['原因'] + '」vs Firestore「' + doc.reason + '」' });
    }
  });

  return {
    ok: issues.filter(function (i) { return i.level === 'error'; }).length === 0,
    sourceCount: sourceCount,
    firestoreCount: firestoreDocs.length,
    issues: issues
  };
}

module.exports = { validateSkipDatesMigration: validateSkipDatesMigration };
