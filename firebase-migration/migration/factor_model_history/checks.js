/**
 * checks.js
 * 純函式：資料遷移品質檢查邏輯，跟其他表的 checks.js 同樣的分工原則——只吃兩個
 * 陣列（來源 rows、Firestore 讀回來的 docs），回傳一份檢查報告，不需要任何
 * 雲端憑證就能單元測試。
 */
var transform = require('./transform');
var normalizeDateTimeStr = transform.normalizeDateTimeStr;
var parseNumber = transform.parseNumber;
var isApplied_ = transform.isApplied_;
var buildDocId_ = transform.buildDocId_;

/**
 * sourceRows：原始 Sheets 匯出的列（中文鍵名，跟 export-sheets.gs 的輸出一致）。
 * firestoreDocs：從 Firestore factor_model_history collection 讀回來的文件，
 * 每筆要帶 `id`（文件 ID）跟展開後的欄位。
 */
function validateFactorModelHistoryMigration(sourceRows, firestoreDocs) {
  var issues = [];

  // 1. 列數核對：來源執行時間或標的Label是空的列不算數，用（執行時間+標的Label）
  //    去重——同一次執行對兩個 label 各留一筆，不是重複資料。
  var validSourceKeys = sourceRows
    .map(function (r) {
      var ts = normalizeDateTimeStr(r['執行時間']);
      var label = String(r['標的Label'] || '').trim();
      if (!ts || !label) return null;
      return buildDocId_(ts, label);
    })
    .filter(function (k) { return k; });
  var uniqueSourceKeys = {};
  validSourceKeys.forEach(function (k) { uniqueSourceKeys[k] = true; });
  var sourceCount = Object.keys(uniqueSourceKeys).length;
  if (sourceCount !== firestoreDocs.length) {
    issues.push({
      level: 'error', check: '列數核對',
      detail: '來源不重複（執行時間+標的Label）' + sourceCount + ' 筆，Firestore 文件 ' + firestoreDocs.length + ' 筆，不一致'
    });
  }

  // 2. 唯一鍵完整性：文件 ID 該等於 buildDocId_(timestamp, labelKey)。
  firestoreDocs.forEach(function (doc) {
    var expectedId = buildDocId_(doc.timestamp, doc.labelKey);
    if (doc.id !== expectedId) {
      issues.push({
        level: 'error', check: '文件ID與欄位組合一致性',
        detail: '文件 ID「' + doc.id + '」與欄位組合出的「' + expectedId + '」不一致'
      });
    }
  });

  // 3. 型別檢查。
  firestoreDocs.forEach(function (doc) {
    ['timestamp', 'labelKey', 'status'].forEach(function (field) {
      if (typeof doc[field] !== 'string') {
        issues.push({
          level: 'error', check: '欄位型別',
          detail: '文件 ' + doc.id + ' 的 ' + field + ' 欄位型別是 ' + typeof doc[field] + '，應該是 string'
        });
      }
    });
    ['l1Reg', 'trainRows', 'r2'].forEach(function (field) {
      if (doc[field] !== null && typeof doc[field] !== 'number') {
        issues.push({
          level: 'error', check: '欄位型別',
          detail: '文件 ' + doc.id + ' 的 ' + field + ' 欄位型別是 ' + typeof doc[field] + '，應該是 number 或 null'
        });
      }
    });
    if (!Array.isArray(doc.featureColumns)) {
      issues.push({ level: 'error', check: '欄位型別', detail: '文件 ' + doc.id + ' 的 featureColumns 應該是陣列' });
    }
    if (typeof doc.weights !== 'object' || doc.weights === null || Array.isArray(doc.weights)) {
      issues.push({ level: 'error', check: '欄位型別', detail: '文件 ' + doc.id + ' 的 weights 應該是物件' });
    }
    if (typeof doc.applied !== 'boolean') {
      issues.push({ level: 'error', check: '欄位型別', detail: '文件 ' + doc.id + ' 的 applied 欄位型別是 ' + typeof doc.applied + '，應該是 boolean' });
    }
  });

  // 4. labelKey 列舉：只會是 return1m 或 downsideResistance（apps-script 的
  //    CONFIG.FACTOR_LABELS 固定只有這兩個，沒有第三種）。
  firestoreDocs.forEach(function (doc) {
    if (['return1m', 'downsideResistance'].indexOf(doc.labelKey) === -1) {
      issues.push({
        level: 'error', check: 'labelKey列舉',
        detail: '文件 ' + doc.id + ' 的 labelKey「' + doc.labelKey + '」不是 return1m 或 downsideResistance'
      });
    }
  });

  // 5. 交叉比對：來源每個（執行時間+標的Label）組合都該在 Firestore 找得到、
  //    內容逐筆一致。
  var bySourceKey = {};
  sourceRows.forEach(function (r) {
    var ts = normalizeDateTimeStr(r['執行時間']);
    var label = String(r['標的Label'] || '').trim();
    if (ts && label) bySourceKey[buildDocId_(ts, label)] = r;
  });
  firestoreDocs.forEach(function (doc) {
    var src = bySourceKey[doc.id];
    if (!src) {
      issues.push({ level: 'error', check: '來源比對', detail: 'Firestore 文件 ' + doc.id + ' 在來源資料裡找不到對應列' });
      return;
    }
    if (parseNumber(src['L1正規化強度']) !== doc.l1Reg) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的 L1正規化強度不一致' });
    }
    if (parseNumber(src['R2']) !== doc.r2) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的 R2 不一致' });
    }
    if (parseNumber(src['訓練列數']) !== doc.trainRows) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的訓練列數不一致' });
    }
    if (String(src['狀態'] || '') !== doc.status) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的狀態不一致' });
    }
    if (isApplied_(src['目前套用版本']) !== doc.applied) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的 applied 不一致' });
    }
    var srcFeatureColumns = String(src['使用特徵'] || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    if (JSON.stringify(srcFeatureColumns) !== JSON.stringify(doc.featureColumns)) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的 featureColumns 不一致' });
    }
    var srcWeights;
    try { srcWeights = JSON.parse(src['權重(JSON)'] || '{}'); } catch (e) { srcWeights = {}; }
    if (JSON.stringify(srcWeights) !== JSON.stringify(doc.weights)) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的 weights 不一致' });
    }
  });

  return {
    ok: issues.filter(function (i) { return i.level === 'error'; }).length === 0,
    sourceCount: sourceCount,
    firestoreCount: firestoreDocs.length,
    issues: issues
  };
}

module.exports = { validateFactorModelHistoryMigration: validateFactorModelHistoryMigration };
