const assert = require('assert');
const { validateConfigAppMigration, validateJobsMigration } = require('../checks');
const { JOB_KEY_TO_PROP_KEY_ } = require('../transform');

function baseConfigProps(overrides) {
  return Object.assign({
    TRIGGER_HOUR: '9', TRIGGER_MINUTE: '5', SKIP_WEEKENDS: 'false',
    AI_PROVIDER: 'claude', AI_DAILY_ENABLED: 'true', AI_DAILY_TOP_N: '7',
    CLAUDE_PRICE_INPUT: '4', CLAUDE_PRICE_OUTPUT: '20', GEMINI_PRICE_INPUT: '0.5', GEMINI_PRICE_OUTPUT: '3',
    BIGQUERY_PROJECT_ID: 'my-project', BIGQUERY_DATASET: 'my_dataset', BIGQUERY_SOURCE_MODE: 'native', BIGQUERY_PRICE_PER_TB: '7',
    SCREENING_STRATEGY: 'rule_v17'
  }, overrides);
}

function baseFirestoreConfigDoc() {
  return {
    triggerHour: 9, triggerMinute: 5, skipWeekends: false,
    aiProvider: 'claude', aiDailyEnabled: true, aiDailyTopN: 7,
    pricing: { claudeInputPerM: 4, claudeOutputPerM: 20, geminiInputPerM: 0.5, geminiOutputPerM: 3 },
    bigQuery: { projectId: 'my-project', dataset: 'my_dataset', sourceMode: 'native', pricePerTb: 7 },
    screeningStrategy: 'rule_v17',
    migratedAt: 'x', migratedFrom: 'scriptProperties:config'
  };
}

// --- config/app：正常情況，來源跟 Firestore 完全對得起來 -> ok:true ---
{
  const report = validateConfigAppMigration(baseConfigProps(), baseFirestoreConfigDoc());
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  assert.strictEqual(report.issues.length, 0);
  console.log('Test validateConfigAppMigration (clean migration -> no issues) passed.');
}

// --- config/app：文件根本不存在 ---
{
  const report = validateConfigAppMigration(baseConfigProps(), null);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '文件存在性'; }));
  console.log('Test validateConfigAppMigration (missing document -> caught) passed.');
}

// --- config/app：型別異常，triggerHour 殘留字串沒轉型 ---
{
  const doc = baseFirestoreConfigDoc();
  doc.triggerHour = '9';
  const report = validateConfigAppMigration(baseConfigProps(), doc);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位型別' && i.detail.indexOf('triggerHour') !== -1; }));
  console.log('Test validateConfigAppMigration (triggerHour not a number -> caught) passed.');
}

// --- config/app：aiProvider 不是 claude/gemini ---
{
  const doc = baseFirestoreConfigDoc();
  doc.aiProvider = 'chatgpt';
  const report = validateConfigAppMigration(baseConfigProps({ AI_PROVIDER: 'chatgpt' }), doc);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === 'aiProvider列舉'; }));
  console.log('Test validateConfigAppMigration (aiProvider not claude/gemini -> caught) passed.');
}

// --- config/app：內容不一致，pricing.claudeInputPerM 跟重新算出來的預期值對不起來 ---
{
  const doc = baseFirestoreConfigDoc();
  doc.pricing = Object.assign({}, doc.pricing, { claudeInputPerM: 999 });
  const report = validateConfigAppMigration(baseConfigProps(), doc);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位內容比對' && i.detail.indexOf('pricing') !== -1; }));
  console.log('Test validateConfigAppMigration (pricing content mismatch -> caught) passed.');
}

// --- jobs/*：正常情況，9 份文件都對得起來 -> ok:true ---
{
  const jobProps = { backfill: JSON.stringify({ status: 'running', cursor: '2026-08-03' }) };
  const firestoreJobDocs = Object.keys(JOB_KEY_TO_PROP_KEY_).map(function (jobKey) {
    if (jobKey === 'backfill') return { id: 'backfill', status: 'running', cursor: '2026-08-03' };
    return { id: jobKey, status: 'idle' };
  });
  const report = validateJobsMigration(jobProps, firestoreJobDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  console.log('Test validateJobsMigration (clean migration, 9 docs -> no issues) passed.');
}

// --- jobs/*：少了一份文件（例如寫入途中失敗）---
{
  const firestoreJobDocs = Object.keys(JOB_KEY_TO_PROP_KEY_)
    .filter(function (k) { return k !== 'backtest'; })
    .map(function (jobKey) { return { id: jobKey, status: 'idle' }; });
  const report = validateJobsMigration({}, firestoreJobDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '文件存在性' && i.detail.indexOf('backtest') !== -1; }));
  console.log('Test validateJobsMigration (missing job document -> caught) passed.');
}

// --- jobs/*：出現一個不在預期清單內的 jobKey（例如拼字打錯或手動塞錯資料）---
{
  const firestoreJobDocs = Object.keys(JOB_KEY_TO_PROP_KEY_).map(function (jobKey) { return { id: jobKey, status: 'idle' }; });
  firestoreJobDocs.push({ id: 'typoKey', status: 'idle' });
  const report = validateJobsMigration({}, firestoreJobDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '不明的jobKey'; }));
  console.log('Test validateJobsMigration (unexpected jobKey -> caught) passed.');
}

// --- jobs/*：內容不一致，某個 job 的狀態欄位跟來源重新解析出來的不一樣 ---
{
  const jobProps = { analysis: JSON.stringify({ status: 'error', errorMessage: '原因 A' }) };
  const firestoreJobDocs = Object.keys(JOB_KEY_TO_PROP_KEY_).map(function (jobKey) {
    if (jobKey === 'analysis') return { id: 'analysis', status: 'error', errorMessage: '原因 B（被改掉了）' };
    return { id: jobKey, status: 'idle' };
  });
  const report = validateJobsMigration(jobProps, firestoreJobDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位內容比對' && i.detail.indexOf('analysis') !== -1; }));
  console.log('Test validateJobsMigration (job state content mismatch -> caught) passed.');
}

console.log('All checks.js tests passed.');
