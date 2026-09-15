const assert = require('assert');
const { validateWatchlistMigration } = require('../checks');

// --- 正常情況：來源跟 Firestore 完全對得起來 -> ok:true，沒有任何 issue ---
{
  const sourceRows = [
    { '證券代號': '330', '證券名稱': '某某股', '加入日期': '2026-08-21', '備註': '觀察中' },
    { '證券代號': '2603', '證券名稱': '長榮', '加入日期': '2026-08-20', '備註': '' }
  ];
  const firestoreDocs = [
    { id: '0330', code: '0330', name: '某某股', addedDate: '2026-08-21', note: '觀察中' },
    { id: '2603', code: '2603', name: '長榮', addedDate: '2026-08-20', note: '' }
  ];
  const report = validateWatchlistMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  assert.strictEqual(report.issues.length, 0);
  console.log('Test validateWatchlistMigration (clean migration -> no issues) passed.');
}

// --- 列數對不上：來源有 3 筆，Firestore 只有 2 筆（漏寫了一筆）---
{
  const sourceRows = [
    { '證券代號': '330', '證券名稱': 'A' },
    { '證券代號': '2603', '證券名稱': 'B' },
    { '證券代號': '9910', '證券名稱': 'C' }
  ];
  const firestoreDocs = [
    { id: '0330', code: '0330', name: 'A', addedDate: '', note: '' },
    { id: '2603', code: '2603', name: 'B', addedDate: '', note: '' }
  ];
  const report = validateWatchlistMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '列數核對'; }), '應該要抓到列數不一致');
  console.log('Test validateWatchlistMigration (missing document -> row count mismatch caught) passed.');
}

// --- 內容不一致：Firestore 上的名稱跟來源對不起來（例如轉換過程打錯字）---
{
  const sourceRows = [{ '證券代號': '2330', '證券名稱': '台積電', '備註': '' }];
  const firestoreDocs = [{ id: '2330', code: '2330', name: '台基電', addedDate: '', note: '' }];
  const report = validateWatchlistMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位內容比對' && i.detail.indexOf('名稱不一致') !== -1; }));
  console.log('Test validateWatchlistMigration (content mismatch -> caught) passed.');
}

// --- 代號格式錯誤：忘記補零，不是 4 碼數字 ---
{
  const sourceRows = [{ '證券代號': '330', '證券名稱': 'A' }];
  const firestoreDocs = [{ id: '330', code: '330', name: 'A', addedDate: '', note: '' }];
  const report = validateWatchlistMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '代號格式'; }));
  console.log('Test validateWatchlistMigration (code not zero-padded -> caught) passed.');
}

// --- 文件 ID 跟 code 欄位不一致（防禦性檢查，理論上 import 腳本不會產生這種資料，
//    但驗證腳本本身不該假設匯入邏輯一定沒問題）---
{
  const sourceRows = [{ '證券代號': '2330', '證券名稱': 'A' }];
  const firestoreDocs = [{ id: '2330', code: '9999', name: 'A', addedDate: '', note: '' }];
  const report = validateWatchlistMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '文件ID與code欄位一致性'; }));
  console.log('Test validateWatchlistMigration (doc id / code field mismatch -> caught) passed.');
}

// --- 型別異常：某個欄位不是字串（例如序列化過程沒轉型） ---
{
  const sourceRows = [{ '證券代號': '2330', '證券名稱': 'A' }];
  const firestoreDocs = [{ id: '2330', code: '2330', name: 'A', addedDate: '', note: null }];
  const report = validateWatchlistMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位型別' && i.detail.indexOf('note') !== -1; }));
  console.log('Test validateWatchlistMigration (non-string field -> caught) passed.');
}

// --- 日期格式異常只是警告，不算硬性錯誤（ok 仍然可以是 true，如果沒有其他 error 等級的問題）---
{
  const sourceRows = [{ '證券代號': '2330', '證券名稱': 'A', '加入日期': '2026/8/21' }];
  const firestoreDocs = [{ id: '2330', code: '2330', name: 'A', addedDate: '2026/8/21', note: '' }];
  const report = validateWatchlistMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, '日期格式異常只是警告，不該讓整體判定變成失敗');
  assert.ok(report.issues.some(function (i) { return i.check === '日期格式' && i.level === 'warning'; }));
  console.log('Test validateWatchlistMigration (bad date format -> warning only, does not fail ok) passed.');
}

console.log('All checks.js tests passed.');
