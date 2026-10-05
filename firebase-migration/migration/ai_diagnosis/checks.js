/**
 * checks.js
 * 純函式：資料遷移品質檢查邏輯，跟 watchlist/portfolio 的 checks.js 同樣的分工
 * 原則——只吃兩個陣列（來源 rows、Firestore 讀回來的 docs），回傳一份檢查
 * 報告，不需要任何雲端憑證就能單元測試。對照〈選股引擎遷移藍圖〉§05：列數
 * 核對、欄位型別檢查、唯一鍵完整性、交叉參照檢查、欄位內容比對。
 */
var transform = require('./transform');
var zfill4 = transform.zfill4;
var normalizeDateStr = transform.normalizeDateStr;
var parseNumber = transform.parseNumber;
var translateDiagnosisType = transform.translateDiagnosisType;

/** 跟 transformAiDiagnosisRow 的 buildDocId_ 邏輯一致，用在來源端重新算一次
 *  預期的文件 ID，才能把來源列跟 Firestore 文件配對起來比對內容。 */
function buildKey_(code, date, diagnosisType) {
  return code + '_' + date + '_' + diagnosisType;
}

/**
 * sourceRows：原始 Sheets 匯出的列（中文鍵名，跟 export-sheets.gs 的輸出一致）。
 * firestoreDocs：從 Firestore ai_diagnosis collection 讀回來的文件，每筆要帶
 * `id`（文件 ID）跟展開後的欄位（date/code/name/armorScore/strategy/verdict/
 * diagnosisType/content/timestamp）。
 */
function validateAiDiagnosisMigration(sourceRows, firestoreDocs) {
  var issues = [];

  // 1. 列數核對：來源代號或日期是空的列不算數（跟 transformAiDiagnosisRow 的
  //    跳過邏輯一致），用「代號+日期+診斷類型」當去重鍵——同一天同一檔股票
  //    可能跑了不只一種診斷類型，各自算一筆，不能只看代號+日期。
  var validSourceKeys = sourceRows
    .map(function (r) {
      var code = zfill4(r['證券代號']);
      var date = normalizeDateStr(r['日期']);
      if (!code || !date) return null;
      return buildKey_(code, date, translateDiagnosisType(r['診斷類型']));
    })
    .filter(function (k) { return k; });
  var uniqueSourceKeys = {};
  validSourceKeys.forEach(function (k) { uniqueSourceKeys[k] = true; });
  var sourceCount = Object.keys(uniqueSourceKeys).length;
  if (sourceCount !== firestoreDocs.length) {
    issues.push({
      level: 'error', check: '列數核對',
      detail: '來源不重複（代號+日期+診斷類型）' + sourceCount + ' 筆，Firestore 文件 ' + firestoreDocs.length + ' 筆，不一致'
    });
  }

  // 2. 唯一鍵完整性：文件 ID 該等於 code_date_diagnosisType，防禦性檢查 import
  //    腳本有沒有用錯文件 ID 或寫錯欄位值。
  firestoreDocs.forEach(function (doc) {
    var expectedId = buildKey_(doc.code, doc.date, doc.diagnosisType);
    if (doc.id !== expectedId) {
      issues.push({
        level: 'error', check: '文件ID與欄位組合一致性',
        detail: '文件 ID「' + doc.id + '」與欄位組合出的「' + expectedId + '」不一致'
      });
    }
  });

  // 3. 型別檢查：字串欄位跟數字欄位分開檢查。armorScore 允許 null——Top3 推薦
  //    這種診斷類型本來就沒有 Armor_Score（來源欄位是空字串）。
  firestoreDocs.forEach(function (doc) {
    ['date', 'code', 'name', 'strategy', 'verdict', 'diagnosisType', 'content', 'timestamp'].forEach(function (field) {
      if (typeof doc[field] !== 'string') {
        issues.push({
          level: 'error', check: '欄位型別',
          detail: '文件 ' + doc.id + ' 的 ' + field + ' 欄位型別是 ' + typeof doc[field] + '，應該是 string'
        });
      }
    });
    if (doc.armorScore !== null && typeof doc.armorScore !== 'number') {
      issues.push({
        level: 'error', check: '欄位型別',
        detail: '文件 ' + doc.id + ' 的 armorScore 欄位型別是 ' + typeof doc.armorScore + '，應該是 number 或 null'
      });
    }
  });

  // 4. 代號格式：一律 4 碼補零（跟 App 其餘部分一致），唯一例外是 Top3 推薦
  //    固定用的 'TOP3' 這個非數字代號。
  firestoreDocs.forEach(function (doc) {
    if (!/^\d{4}$/.test(doc.code) && doc.code !== 'TOP3') {
      issues.push({
        level: 'error', check: '代號格式',
        detail: '文件 ' + doc.id + ' 的 code「' + doc.code + '」不是 4 碼數字，也不是 Top3 推薦的固定值 TOP3'
      });
    }
  });

  // 5. 診斷類型列舉：只能是 deep/hold/top3，翻譯邏輯本身若有漏網會在這裡被抓到。
  firestoreDocs.forEach(function (doc) {
    if (['deep', 'hold', 'top3'].indexOf(doc.diagnosisType) === -1) {
      issues.push({
        level: 'error', check: '診斷類型列舉',
        detail: '文件 ' + doc.id + ' 的 diagnosisType「' + doc.diagnosisType + '」不是 deep/hold/top3'
      });
    }
  });

  // 6. 日期格式：降級成警告，跟 watchlist/checks.js 的日期格式檢查同樣理由——
  //    日期格式異常不影響資料本身的正確性，但值得人工看一眼。
  firestoreDocs.forEach(function (doc) {
    if (doc.date && !/^\d{4}-\d{2}-\d{2}$/.test(doc.date)) {
      issues.push({
        level: 'warning', check: '日期格式',
        detail: '文件 ' + doc.id + ' 的 date「' + doc.date + '」不是 YYYY-MM-DD 格式'
      });
    }
  });

  // 7. 交叉比對：來源每個（代號+日期+診斷類型）組合都該在 Firestore 找得到、
  //    內容逐筆一致。
  var bySourceKey = {};
  sourceRows.forEach(function (r) {
    var code = zfill4(r['證券代號']);
    var date = normalizeDateStr(r['日期']);
    if (!code || !date) return;
    bySourceKey[buildKey_(code, date, translateDiagnosisType(r['診斷類型']))] = r;
  });
  firestoreDocs.forEach(function (doc) {
    var src = bySourceKey[doc.id];
    if (!src) {
      issues.push({ level: 'error', check: '來源比對', detail: 'Firestore 文件 ' + doc.id + ' 在來源資料裡找不到對應列' });
      return;
    }
    if (String(src['證券名稱'] || '') !== doc.name) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的名稱不一致：來源「' + src['證券名稱'] + '」vs Firestore「' + doc.name + '」' });
    }
    if (String(src['最終建議'] || '') !== doc.verdict) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的最終建議不一致：來源「' + src['最終建議'] + '」vs Firestore「' + doc.verdict + '」' });
    }
    if (String(src['診斷內容'] || '') !== doc.content) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的診斷內容不一致（長度：來源 ' + String(src['診斷內容'] || '').length + ' vs Firestore ' + doc.content.length + '）' });
    }
    var srcArmorScore = parseNumber(src['Armor_Score']);
    if (srcArmorScore !== doc.armorScore) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的 Armor_Score 不一致：來源「' + srcArmorScore + '」vs Firestore「' + doc.armorScore + '」' });
    }
  });

  return {
    ok: issues.filter(function (i) { return i.level === 'error'; }).length === 0,
    sourceCount: sourceCount,
    firestoreCount: firestoreDocs.length,
    issues: issues
  };
}

module.exports = { validateAiDiagnosisMigration: validateAiDiagnosisMigration };
