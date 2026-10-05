/**
 * checks.js
 * 純函式：資料遷移品質檢查邏輯，跟其他表的 checks.js 同樣的分工原則——不需要
 * 任何雲端憑證就能單元測試。這張「表」比較特別，拆成兩份獨立的驗證：
 * config/app（單一文件）跟 jobs/{jobKey}（最多 9 份文件），所以匯出兩個
 * validate 函式，不是一個。
 */
var transform = require('./transform');
var JOB_KEY_TO_PROP_KEY_ = transform.JOB_KEY_TO_PROP_KEY_;
var parseJobStateJson_ = transform.parseJobStateJson_;
var buildConfigAppDoc = transform.buildConfigAppDoc;

/** 簡單的遞迴深度比較，只需要處理 JSON 能表達的型別（string/number/boolean/
 *  null/array/plain object）——job 狀態跟 config 欄位都只會是這些型別，不會
 *  出現 Date 物件或函式，不需要處理更複雜的情況。 */
function deepEqual_(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  var aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(function (k) { return Object.prototype.hasOwnProperty.call(b, k) && deepEqual_(a[k], b[k]); });
}

/**
 * configProps：export-script-properties.gs 匯出的 JSON 裡 `configProps` 物件
 * （原始字串值，鍵名是 Script Properties 的 key）。
 * firestoreConfigDoc：從 Firestore `config/app` 讀回來的文件內容（不含
 * migratedAt／migratedFrom 以外都要比對）。
 */
function validateConfigAppMigration(configProps, firestoreConfigDoc) {
  var issues = [];
  if (!firestoreConfigDoc) {
    issues.push({ level: 'error', check: '文件存在性', detail: 'Firestore 裡找不到 config/app 文件' });
    return { ok: false, issues: issues };
  }
  var expected = buildConfigAppDoc(configProps, firestoreConfigDoc.migratedAt);

  // 1. 型別檢查：對照 firestore/schema.md §8 列的型別。
  ['triggerHour', 'triggerMinute', 'aiDailyTopN'].forEach(function (field) {
    if (typeof firestoreConfigDoc[field] !== 'number') {
      issues.push({ level: 'error', check: '欄位型別', detail: field + ' 欄位型別是 ' + typeof firestoreConfigDoc[field] + '，應該是 number' });
    }
  });
  ['skipWeekends', 'aiDailyEnabled'].forEach(function (field) {
    if (typeof firestoreConfigDoc[field] !== 'boolean') {
      issues.push({ level: 'error', check: '欄位型別', detail: field + ' 欄位型別是 ' + typeof firestoreConfigDoc[field] + '，應該是 boolean' });
    }
  });
  ['aiProvider', 'screeningStrategy'].forEach(function (field) {
    if (typeof firestoreConfigDoc[field] !== 'string') {
      issues.push({ level: 'error', check: '欄位型別', detail: field + ' 欄位型別是 ' + typeof firestoreConfigDoc[field] + '，應該是 string' });
    }
  });

  // 2. aiProvider 列舉：只能是 claude 或 gemini。
  if (['claude', 'gemini'].indexOf(firestoreConfigDoc.aiProvider) === -1) {
    issues.push({ level: 'error', check: 'aiProvider列舉', detail: 'aiProvider「' + firestoreConfigDoc.aiProvider + '」不是 claude 或 gemini' });
  }

  // 3. pricing／bigQuery 兩個巢狀 map 的欄位型別。
  var pricing = firestoreConfigDoc.pricing || {};
  ['claudeInputPerM', 'claudeOutputPerM', 'geminiInputPerM', 'geminiOutputPerM'].forEach(function (field) {
    if (typeof pricing[field] !== 'number') {
      issues.push({ level: 'error', check: '欄位型別', detail: 'pricing.' + field + ' 欄位型別是 ' + typeof pricing[field] + '，應該是 number' });
    }
  });
  var bigQuery = firestoreConfigDoc.bigQuery || {};
  ['projectId', 'dataset', 'sourceMode'].forEach(function (field) {
    if (typeof bigQuery[field] !== 'string') {
      issues.push({ level: 'error', check: '欄位型別', detail: 'bigQuery.' + field + ' 欄位型別是 ' + typeof bigQuery[field] + '，應該是 string' });
    }
  });
  if (typeof bigQuery.pricePerTb !== 'number') {
    issues.push({ level: 'error', check: '欄位型別', detail: 'bigQuery.pricePerTb 欄位型別是 ' + typeof bigQuery.pricePerTb + '，應該是 number' });
  }

  // 4. 內容比對：用 transform.js 的同一套預設值邏輯重新算一次，應該跟 Firestore
  //    裡的值完全一致（migratedAt／migratedFrom 兩個遷移專用欄位不比對）。
  Object.keys(expected).forEach(function (field) {
    if (field === 'migratedAt' || field === 'migratedFrom') return;
    if (!deepEqual_(expected[field], firestoreConfigDoc[field])) {
      issues.push({
        level: 'error', check: '欄位內容比對',
        detail: field + ' 不一致：預期「' + JSON.stringify(expected[field]) + '」vs Firestore「' + JSON.stringify(firestoreConfigDoc[field]) + '」'
      });
    }
  });

  return {
    ok: issues.filter(function (i) { return i.level === 'error'; }).length === 0,
    issues: issues
  };
}

/**
 * jobProps：export-script-properties.gs 匯出的 JSON 裡 `jobProps` 物件
 * （jobKey → 原始 JSON 字串或 null）。
 * firestoreJobDocs：從 Firestore `jobs` collection 讀回來的文件，每筆要帶
 * `id`（文件 ID，就是 jobKey）跟展開後的欄位。
 */
function validateJobsMigration(jobProps, firestoreJobDocs) {
  var issues = [];
  var expectedJobKeys = Object.keys(JOB_KEY_TO_PROP_KEY_);
  var byId = {};
  firestoreJobDocs.forEach(function (doc) { byId[doc.id] = doc; });

  // 1. 文件數核對：該有的 9 個 jobKey 一個不能少、也不該多出不認識的 jobKey。
  expectedJobKeys.forEach(function (jobKey) {
    if (!byId[jobKey]) {
      issues.push({ level: 'error', check: '文件存在性', detail: 'Firestore jobs collection 裡找不到 ' + jobKey });
    }
  });
  firestoreJobDocs.forEach(function (doc) {
    if (expectedJobKeys.indexOf(doc.id) === -1) {
      issues.push({ level: 'error', check: '不明的jobKey', detail: 'Firestore jobs collection 裡有一個不在預期清單內的文件：' + doc.id });
    }
  });

  // 2. 型別檢查：status 是所有 job 狀態共通的欄位，其餘欄位每種 job 形狀不同，
  //    不逐欄位檢查型別，靠下面的內容比對（整份深度比較）抓問題。
  firestoreJobDocs.forEach(function (doc) {
    if (typeof doc.status !== 'string') {
      issues.push({ level: 'error', check: '欄位型別', detail: '文件 ' + doc.id + ' 的 status 欄位型別是 ' + typeof doc.status + '，應該是 string' });
    }
  });

  // 3. 內容比對：用 transform.js 的同一套 parseJobStateJson_ 重新解析一次來源
  //    字串，應該跟 Firestore 裡的值完全一致（migratedAt／migratedFrom／id
  //    三個遷移專用／文件 ID 欄位不比對）。
  expectedJobKeys.forEach(function (jobKey) {
    var doc = byId[jobKey];
    if (!doc) return; // 已經在檢查 1 報過「找不到」，這裡不用重複報
    var expectedState = parseJobStateJson_(jobProps ? jobProps[jobKey] : null);
    var actualState = {};
    Object.keys(doc).forEach(function (k) {
      if (k === 'id' || k === 'migratedAt' || k === 'migratedFrom') return;
      actualState[k] = doc[k];
    });
    if (!deepEqual_(expectedState, actualState)) {
      issues.push({
        level: 'error', check: '欄位內容比對',
        detail: jobKey + ' 的狀態不一致：預期「' + JSON.stringify(expectedState) + '」vs Firestore「' + JSON.stringify(actualState) + '」'
      });
    }
  });

  return {
    ok: issues.filter(function (i) { return i.level === 'error'; }).length === 0,
    issues: issues
  };
}

module.exports = { validateConfigAppMigration: validateConfigAppMigration, validateJobsMigration: validateJobsMigration };
