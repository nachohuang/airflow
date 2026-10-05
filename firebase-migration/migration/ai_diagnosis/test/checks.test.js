const assert = require('assert');
const { validateAiDiagnosisMigration } = require('../checks');

function baseSourceRow(overrides) {
  return Object.assign({
    '日期': '2026-08-21', '證券代號': '330', '證券名稱': '某某股',
    'Armor_Score': '85.5', '操作策略': '強力買入訊號', '最終建議': '強力買入',
    '診斷類型': '深度診斷', '診斷內容': '完整診斷內文……', '時間戳記': '台股監控 2026-08-21 09:30'
  }, overrides);
}

function baseFirestoreDoc(overrides) {
  return Object.assign({
    id: '0330_2026-08-21_deep', date: '2026-08-21', code: '0330', name: '某某股',
    armorScore: 85.5, strategy: '強力買入訊號', verdict: '強力買入',
    diagnosisType: 'deep', content: '完整診斷內文……', timestamp: '台股監控 2026-08-21 09:30'
  }, overrides);
}

// --- 正常情況：來源跟 Firestore 完全對得起來 -> ok:true，沒有任何 issue ---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc()];
  const report = validateAiDiagnosisMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  assert.strictEqual(report.issues.length, 0);
  console.log('Test validateAiDiagnosisMigration (clean migration -> no issues) passed.');
}

// --- 同一天同一檔股票兩種診斷類型，各自算一筆，不應該被誤判成重複 ---
{
  const sourceRows = [
    baseSourceRow({ '診斷類型': '深度診斷' }),
    baseSourceRow({ '診斷類型': '持股續抱診斷', '最終建議': '體質穩健，續抱' })
  ];
  const firestoreDocs = [
    baseFirestoreDoc({ id: '0330_2026-08-21_deep', diagnosisType: 'deep' }),
    baseFirestoreDoc({ id: '0330_2026-08-21_hold', diagnosisType: 'hold', verdict: '體質穩健，續抱' })
  ];
  const report = validateAiDiagnosisMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  assert.strictEqual(report.sourceCount, 2);
  console.log('Test validateAiDiagnosisMigration (same code+date, different diagnosisType -> not a duplicate) passed.');
}

// --- 列數對不上：來源有 2 筆，Firestore 只有 1 筆（漏寫了一筆）---
{
  const sourceRows = [baseSourceRow(), baseSourceRow({ '日期': '2026-08-22' })];
  const firestoreDocs = [baseFirestoreDoc()];
  const report = validateAiDiagnosisMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '列數核對'; }));
  console.log('Test validateAiDiagnosisMigration (missing document -> row count mismatch caught) passed.');
}

// --- 文件 ID 跟欄位組合不一致（防禦性檢查）---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc({ id: 'wrong-id' })];
  const report = validateAiDiagnosisMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '文件ID與欄位組合一致性'; }));
  console.log('Test validateAiDiagnosisMigration (doc id / field combo mismatch -> caught) passed.');
}

// --- 型別異常：armorScore 不是數字也不是 null ---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc({ armorScore: '85.5' })];
  const report = validateAiDiagnosisMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位型別' && i.detail.indexOf('armorScore') !== -1; }));
  console.log('Test validateAiDiagnosisMigration (armorScore not a number/null -> caught) passed.');
}

// --- armorScore 允許是 null（Top3 推薦這種診斷類型本來就沒有），不該被型別檢查誤判 ---
{
  const sourceRows = [baseSourceRow({ '證券代號': 'TOP3', '證券名稱': '（全市場橫向比較）', 'Armor_Score': '', '操作策略': '', '最終建議': '', '診斷類型': 'TOP3推薦' })];
  const firestoreDocs = [baseFirestoreDoc({ id: 'TOP3_2026-08-21_top3', code: 'TOP3', name: '（全市場橫向比較）', armorScore: null, strategy: '', verdict: '', diagnosisType: 'top3' })];
  const report = validateAiDiagnosisMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, true, 'got issues: ' + JSON.stringify(report.issues));
  console.log('Test validateAiDiagnosisMigration (null armorScore on top3 doc -> not an error) passed.');
}

// --- 代號格式錯誤：忘記補零，且不是 TOP3 這個例外值 ---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc({ code: '330' })];
  const report = validateAiDiagnosisMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '代號格式'; }));
  console.log('Test validateAiDiagnosisMigration (code not zero-padded and not TOP3 -> caught) passed.');
}

// --- 診斷類型列舉異常：不是 deep/hold/top3（例如翻譯邏輯漏網）---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc({ diagnosisType: '深度診斷' })];
  const report = validateAiDiagnosisMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '診斷類型列舉'; }));
  console.log('Test validateAiDiagnosisMigration (diagnosisType not deep/hold/top3 -> caught) passed.');
}

// --- 內容不一致：Firestore 上的診斷內容跟來源對不起來 ---
{
  const sourceRows = [baseSourceRow()];
  const firestoreDocs = [baseFirestoreDoc({ content: '內容被改掉了' })];
  const report = validateAiDiagnosisMigration(sourceRows, firestoreDocs);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some(function (i) { return i.check === '欄位內容比對' && i.detail.indexOf('診斷內容不一致') !== -1; }));
  console.log('Test validateAiDiagnosisMigration (content mismatch -> caught) passed.');
}

// --- 日期格式異常：降級成警告，但這裡 date 同時也是文件 ID 的組成部分，所以
//    要連 id／來源比對用的 key 一起用同一個未正規化的值，才不會連帶觸發
//    「文件ID與欄位組合一致性」或「來源比對」這兩個其實是誤判的額外錯誤——
//    這個測試只想單獨驗證「日期格式」這一項規則本身的降級行為 ---
{
  const sourceRows = [baseSourceRow({ '日期': '2026/8/21' })];
  const firestoreDocs = [baseFirestoreDoc({ id: '0330_2026/8/21_deep', date: '2026/8/21' })];
  const report = validateAiDiagnosisMigration(sourceRows, firestoreDocs);
  assert.ok(report.issues.some(function (i) { return i.check === '日期格式' && i.level === 'warning'; }));
  assert.ok(!report.issues.some(function (i) { return i.level === 'error' && i.check === '日期格式'; }));
  console.log('Test validateAiDiagnosisMigration (bad date format -> warning, independent of key-matching checks) passed.');
}

console.log('All checks.js tests passed.');
