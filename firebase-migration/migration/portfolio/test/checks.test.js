const assert = require('assert');
const { validatePortfolioMigration } = require('../checks');

function baseSourceRow(overrides) {
  return Object.assign({
    '交易ID': 'tx-001', '證券代號': '330', '證券名稱': '某某股',
    '買進日期': '2026-08-21', '買進價格': '100', '股數': '1000',
    '備註': '', '狀態': '持有中', '賣出日期': '', '賣出價格': ''
  }, overrides);
}

function baseFirestoreDoc(overrides) {
  return Object.assign({
    id: 'tx-001', transactionId: 'tx-001', code: '0330', name: '某某股',
    buyDate: '2026-08-21', buyPrice: 100, shares: 1000,
    note: '', status: 'holding', sellDate: null, sellPrice: null
  }, overrides);
}

// --- 正常情況：來源跟 Firestore 完全對得起來 -> ok:true，沒有任何 issue ---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc()];
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  assert.strictEqual(report.issues.length, 0);
  console.log('Test validatePortfolioMigration (clean migration -> no issues) passed.');
}

// --- 列數對不上：來源有 2 筆，Firestore 只有 1 筆（漏寫了一筆）---
{
  const sourceRows = [baseSourceRow(), baseSourceRow({ '交易ID': 'tx-002' })];
  const firestoreDocs = [baseFirestoreDoc()];
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '列數核對'; }));
  console.log('Test validatePortfolioMigration (missing document -> row count mismatch caught) passed.');
}

// --- 文件 ID 跟 transactionId 欄位不一致（防禦性檢查）---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc({ transactionId: 'tx-999' })];
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '文件ID與transactionId欄位一致性'; }));
  console.log('Test validatePortfolioMigration (doc id / transactionId field mismatch -> caught) passed.');
}

// --- 型別異常：buyPrice 不是數字（例如轉換過程沒轉型，殘留字串或 null）---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc({ buyPrice: '100' })];
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位型別' && i.detail.indexOf('buyPrice') !== -1; }));
  console.log('Test validatePortfolioMigration (buyPrice not a number -> caught) passed.');
}

// --- sellDate/sellPrice 允許是 null（持有中的部位本來就還沒賣），不該被型別檢查誤判 ---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc()]; // sellDate/sellPrice 都是 null
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  console.log('Test validatePortfolioMigration (null sellDate/sellPrice on holding lot -> not an error) passed.');
}

// --- 代號格式錯誤：忘記補零 ---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc({ code: '330' })];
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '代號格式'; }));
  console.log('Test validatePortfolioMigration (code not zero-padded -> caught) passed.');
}

// --- 狀態列舉異常：status 不是 holding 或 sold（例如翻譯邏輯漏網）---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc({ status: '持有中' })];
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '狀態列舉'; }));
  console.log('Test validatePortfolioMigration (status not holding/sold -> caught) passed.');
}

// --- 已賣出部位缺賣出資訊：降級成警告，不影響 ok ---
{
  const sourceRows = [baseSourceRow({ '狀態': '已賣出' })];
  const firestoreDocs = [baseFirestoreDoc({ status: 'sold' })]; // sellDate/sellPrice 仍是 null
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, '缺賣出資訊只是警告，不該讓整體判定變成失敗');
  assert.ok(report.issues.some(function (i) { return i.check === '已賣出部位缺賣出資訊' && i.level === 'warning'; }));
  console.log('Test validatePortfolioMigration (sold lot missing sell info -> warning only) passed.');
}

// --- 內容不一致：Firestore 上的股數跟來源對不起來（例如轉換過程數字跑掉）---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc({ shares: 999 })];
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位內容比對' && i.detail.indexOf('股數不一致') !== -1; }));
  console.log('Test validatePortfolioMigration (shares mismatch -> caught) passed.');
}

// --- 金額校驗：兩筆同代號持有中的 lot，加權平均成本要跟 aggregateLots_ 算出來的
//    一致；這裡故意讓 Firestore 端某一筆股數跑掉，總股數/平均成本都會跟著錯 ---
{
  const sourceRows = [
    baseSourceRow({ '交易ID': 'tx-001', '買進價格': '100', '股數': '1000' }),
    baseSourceRow({ '交易ID': 'tx-002', '買進價格': '120', '股數': '500' })
  ];
  const firestoreDocs = [
    baseFirestoreDoc({ id: 'tx-001', transactionId: 'tx-001', buyPrice: 100, shares: 1000 }),
    baseFirestoreDoc({ id: 'tx-002', transactionId: 'tx-002', buyPrice: 120, shares: 400 }) // 股數跑掉：500 -> 400
  ];
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  // 股數本身逐列比對就會先抓到，這裡另外確認金額校驗（彙總層級）也抓到了
  assert.ok(report.issues.some(function (i) { return i.check === '金額校驗（總股數）'; }));
  assert.ok(report.issues.some(function (i) { return i.check === '金額校驗（加權平均成本）'; }));
  console.log('Test validatePortfolioMigration (weighted avg cost mismatch -> caught) passed.');
}

// --- 金額校驗：正常情況下，兩筆同代號持有中的 lot 加權平均成本算得出來且一致 ---
{
  const sourceRows = [
    baseSourceRow({ '交易ID': 'tx-001', '買進價格': '100', '股數': '1000' }),
    baseSourceRow({ '交易ID': 'tx-002', '買進價格': '120', '股數': '500' })
  ];
  const firestoreDocs = [
    baseFirestoreDoc({ id: 'tx-001', transactionId: 'tx-001', buyPrice: 100, shares: 1000 }),
    baseFirestoreDoc({ id: 'tx-002', transactionId: 'tx-002', buyPrice: 120, shares: 500 })
  ];
  const report = validatePortfolioMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  console.log('Test validatePortfolioMigration (weighted avg cost matches -> no issue) passed.');
}

console.log('All checks.js tests passed.');
