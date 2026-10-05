const assert = require('assert');
const { validateFactorModelHistoryMigration } = require('../checks');

function baseSourceRow(overrides) {
  return Object.assign({
    '執行時間': '2026-10-05 14:30:00', '標的Label': 'downsideResistance',
    'L1正規化強度': '0.05', '使用特徵': 'inst_participation, ibf_20d',
    '訓練列數': '12000', 'R2': '0.312', '權重(JSON)': '{"inst_participation":0.4,"ibf_20d":0.2}',
    '狀態': '完成', '目前套用版本': '✓ 套用中'
  }, overrides);
}

function baseFirestoreDoc(overrides) {
  return Object.assign({
    id: '2026-10-05_14-30-00_downsideResistance', timestamp: '2026-10-05 14:30:00', labelKey: 'downsideResistance',
    l1Reg: 0.05, featureColumns: ['inst_participation', 'ibf_20d'], trainRows: 12000, r2: 0.312,
    weights: { inst_participation: 0.4, ibf_20d: 0.2 }, status: '完成', applied: true,
    migratedAt: 'x', migratedFrom: 'sheets:FactorModelHistory'
  }, overrides);
}

// --- 正常情況：來源跟 Firestore 完全對得起來 -> ok:true ---
{
  const report = validateFactorModelHistoryMigration([baseSourceRow()], [baseFirestoreDoc()]);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  assert.strictEqual(report.issues.length, 0);
  console.log('Test validateFactorModelHistoryMigration (clean migration -> no issues) passed.');
}

// --- 同一次執行對兩個 label 各留一筆，不該被誤判成重複 ---
{
  const sourceRows = [
    baseSourceRow({ '標的Label': 'downsideResistance' }),
    baseSourceRow({ '標的Label': 'return1m', '目前套用版本': '' })
  ];
  const firestoreDocs = [
    baseFirestoreDoc({ id: '2026-10-05_14-30-00_downsideResistance', labelKey: 'downsideResistance' }),
    baseFirestoreDoc({ id: '2026-10-05_14-30-00_return1m', labelKey: 'return1m', applied: false })
  ];
  const report = validateFactorModelHistoryMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  assert.strictEqual(report.sourceCount, 2);
  console.log('Test validateFactorModelHistoryMigration (same run, two labels -> not a duplicate) passed.');
}

// --- 列數對不上 ---
{
  const report = validateFactorModelHistoryMigration([baseSourceRow(), baseSourceRow({ '執行時間': '2026-09-28 09:00:00' })], [baseFirestoreDoc()]);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '列數核對'; }));
  console.log('Test validateFactorModelHistoryMigration (missing document -> row count mismatch caught) passed.');
}

// --- 文件 ID 跟欄位組合不一致 ---
{
  const report = validateFactorModelHistoryMigration([baseSourceRow()], [baseFirestoreDoc({ id: 'wrong-id' })]);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '文件ID與欄位組合一致性'; }));
  console.log('Test validateFactorModelHistoryMigration (doc id / field combo mismatch -> caught) passed.');
}

// --- 型別異常：weights 不是物件 ---
{
  const report = validateFactorModelHistoryMigration([baseSourceRow()], [baseFirestoreDoc({ weights: '{}' })]);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位型別' && i.detail.indexOf('weights') !== -1; }));
  console.log('Test validateFactorModelHistoryMigration (weights not an object -> caught) passed.');
}

// --- labelKey 列舉異常 ---
{
  const report = validateFactorModelHistoryMigration([baseSourceRow()], [baseFirestoreDoc({ labelKey: '標的A' })]);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === 'labelKey列舉'; }));
  console.log('Test validateFactorModelHistoryMigration (labelKey not return1m/downsideResistance -> caught) passed.');
}

// --- 內容不一致：weights 跟來源重新解析出來的不一樣 ---
{
  const report = validateFactorModelHistoryMigration([baseSourceRow()], [baseFirestoreDoc({ weights: { inst_participation: 0.9 } })]);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位內容比對' && i.detail.indexOf('weights') !== -1; }));
  console.log('Test validateFactorModelHistoryMigration (weights content mismatch -> caught) passed.');
}

// --- 內容不一致：applied 跟來源不一致 ---
{
  const report = validateFactorModelHistoryMigration([baseSourceRow()], [baseFirestoreDoc({ applied: false })]);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位內容比對' && i.detail.indexOf('applied') !== -1; }));
  console.log('Test validateFactorModelHistoryMigration (applied content mismatch -> caught) passed.');
}

console.log('All checks.js tests passed.');
