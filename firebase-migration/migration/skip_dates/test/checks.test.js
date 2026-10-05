const assert = require('assert');
const { validateSkipDatesMigration } = require('../checks');

// --- 正常情況：來源跟 Firestore 完全對得起來 -> ok:true，沒有任何 issue ---
{
  const sourceRows = [
    { '日期': '2026-08-21', '原因': '颱風假' },
    { '日期': '2026-09-01', '原因': '' }
  ];
  const firestoreDocs = [
    { id: '2026-08-21', date: '2026-08-21', reason: '颱風假' },
    { id: '2026-09-01', date: '2026-09-01', reason: '' }
  ];
  const report = validateSkipDatesMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  assert.strictEqual(report.issues.length, 0);
  console.log('Test validateSkipDatesMigration (clean migration -> no issues) passed.');
}

// --- 列數對不上：來源有 2 筆，Firestore 只有 1 筆（漏寫了一筆）---
{
  const sourceRows = [
    { '日期': '2026-08-21', '原因': 'A' },
    { '日期': '2026-09-01', '原因': 'B' }
  ];
  const firestoreDocs = [{ id: '2026-08-21', date: '2026-08-21', reason: 'A' }];
  const report = validateSkipDatesMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '列數核對'; }));
  console.log('Test validateSkipDatesMigration (missing document -> row count mismatch caught) passed.');
}

// --- 文件 ID 跟 date 欄位不一致（防禦性檢查）---
{
  const sourceRows = [{ '日期': '2026-08-21', '原因': 'A' }];
  const firestoreDocs = [{ id: '2026-08-21', date: '2026-09-01', reason: 'A' }];
  const report = validateSkipDatesMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '文件ID與date欄位一致性'; }));
  console.log('Test validateSkipDatesMigration (doc id / date field mismatch -> caught) passed.');
}

// --- 型別異常：reason 不是字串 ---
{
  const sourceRows = [{ '日期': '2026-08-21', '原因': 'A' }];
  const firestoreDocs = [{ id: '2026-08-21', date: '2026-08-21', reason: null }];
  const report = validateSkipDatesMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位型別' && i.detail.indexOf('reason') !== -1; }));
  console.log('Test validateSkipDatesMigration (non-string reason -> caught) passed.');
}

// --- 內容不一致：Firestore 上的原因跟來源對不起來 ---
{
  const sourceRows = [{ '日期': '2026-08-21', '原因': '颱風假' }];
  const firestoreDocs = [{ id: '2026-08-21', date: '2026-08-21', reason: '不明原因' }];
  const report = validateSkipDatesMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位內容比對' && i.detail.indexOf('原因不一致') !== -1; }));
  console.log('Test validateSkipDatesMigration (reason mismatch -> caught) passed.');
}

// --- 日期格式異常：降級成警告。這裡 date 同時也是文件 ID 本身，來源比對用
//    的是正規化後的日期當 key，所以來源日期故意也用同一個未正規化的字串，
//    兩邊才會配對得起來，單獨驗證「日期格式」這一項規則本身的降級行為 ---
{
  const sourceRows = [{ '日期': '2026/8/21', '原因': 'A' }];
  const firestoreDocs = [{ id: '2026-08-21', date: '2026/8/21', reason: 'A' }];
  const report = validateSkipDatesMigration(sourceRows, firestoreDocs);
  assert.ok(report.issues.some(function (i) { return i.check === '日期格式' && i.level === 'warning'; }));
  assert.ok(!report.issues.some(function (i) { return i.level === 'error' && i.check === '日期格式'; }));
  console.log('Test validateSkipDatesMigration (bad date format -> warning, independent of key-matching checks) passed.');
}

console.log('All checks.js tests passed.');
