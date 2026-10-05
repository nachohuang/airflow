const assert = require('assert');
const { validateIndustryMapMigration } = require('../checks');

// --- 正常情況：來源跟 Firestore 完全對得起來 -> ok:true，沒有任何 issue ---
{
  const sourceRows = [
    { '證券代號': '330', '證券名稱': '某某股', '產業別': '半導體業', '市場別': '上市' },
    { '證券代號': '2603', '證券名稱': '長榮', '產業別': '航運業', '市場別': '上市' }
  ];
  const firestoreDocs = [
    { id: '0330', code: '0330', name: '某某股', industry: '半導體業', market: '上市' },
    { id: '2603', code: '2603', name: '長榮', industry: '航運業', market: '上市' }
  ];
  const report = validateIndustryMapMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  assert.strictEqual(report.issues.length, 0);
  console.log('Test validateIndustryMapMigration (clean migration -> no issues) passed.');
}

// --- 列數對不上：來源有 3 筆，Firestore 只有 2 筆（漏寫了一筆）---
{
  const sourceRows = [
    { '證券代號': '330', '證券名稱': 'A' },
    { '證券代號': '2603', '證券名稱': 'B' },
    { '證券代號': '9910', '證券名稱': 'C' }
  ];
  const firestoreDocs = [
    { id: '0330', code: '0330', name: 'A', industry: '', market: '' },
    { id: '2603', code: '2603', name: 'B', industry: '', market: '' }
  ];
  const report = validateIndustryMapMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '列數核對'; }));
  console.log('Test validateIndustryMapMigration (missing document -> row count mismatch caught) passed.');
}

// --- 文件 ID 跟 code 欄位不一致（防禦性檢查）---
{
  const sourceRows = [{ '證券代號': '2330', '證券名稱': 'A' }];
  const firestoreDocs = [{ id: '2330', code: '9999', name: 'A', industry: '', market: '' }];
  const report = validateIndustryMapMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '文件ID與code欄位一致性'; }));
  console.log('Test validateIndustryMapMigration (doc id / code field mismatch -> caught) passed.');
}

// --- 型別異常：某個欄位不是字串 ---
{
  const sourceRows = [{ '證券代號': '2330', '證券名稱': 'A' }];
  const firestoreDocs = [{ id: '2330', code: '2330', name: 'A', industry: null, market: '' }];
  const report = validateIndustryMapMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位型別' && i.detail.indexOf('industry') !== -1; }));
  console.log('Test validateIndustryMapMigration (non-string field -> caught) passed.');
}

// --- 代號格式錯誤：忘記補零 ---
{
  const sourceRows = [{ '證券代號': '330', '證券名稱': 'A' }];
  const firestoreDocs = [{ id: '330', code: '330', name: 'A', industry: '', market: '' }];
  const report = validateIndustryMapMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '代號格式'; }));
  console.log('Test validateIndustryMapMigration (code not zero-padded -> caught) passed.');
}

// --- 內容不一致：Firestore 上的產業別跟來源對不起來 ---
{
  const sourceRows = [{ '證券代號': '2330', '證券名稱': 'A', '產業別': '半導體業' }];
  const firestoreDocs = [{ id: '2330', code: '2330', name: 'A', industry: '電子業', market: '' }];
  const report = validateIndustryMapMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位內容比對' && i.detail.indexOf('產業別不一致') !== -1; }));
  console.log('Test validateIndustryMapMigration (industry mismatch -> caught) passed.');
}

console.log('All checks.js tests passed.');
