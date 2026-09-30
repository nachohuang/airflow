const assert = require('assert');
const { zfill4, normalizeDateStr, transformWatchlistRow } = require('../transform');

// --- zfill4：跟 apps-script/src/Utils.gs 的 zfill4 同樣的補零規則 ---
{
  assert.strictEqual(zfill4('330'), '0330');
  assert.strictEqual(zfill4(2330), '2330');
  assert.strictEqual(zfill4(''), '');
  assert.strictEqual(zfill4(null), '');
  assert.strictEqual(zfill4('  9910  '), '9910');
  console.log('Test zfill4 passed.');
}

// --- normalizeDateStr：export-sheets.gs 匯出經過 JSON.stringify 之後，Sheets 裡
//    原本是 Date 型別的儲存格會變成 ISO 字串，要能正確截出日期部分 ---
{
  assert.strictEqual(normalizeDateStr('2026-08-21'), '2026-08-21');
  assert.strictEqual(normalizeDateStr('2026/8/21'), '2026-08-21');
  assert.strictEqual(normalizeDateStr('2026-08-21T00:00:00.000Z'), '2026-08-21');
  assert.strictEqual(normalizeDateStr(''), '');
  assert.strictEqual(normalizeDateStr(null), '');
  console.log('Test normalizeDateStr passed.');
}

// --- transformWatchlistRow：正常一筆的轉換結果 ---
{
  const row = { '證券代號': '330', '證券名稱': '某某股', '加入日期': '2026-08-21', '備註': '觀察中' };
  const doc = transformWatchlistRow(row, '2026-09-15T00:00:00.000Z');
  assert.strictEqual(doc.id, '0330', '文件 ID 要跟 code 一樣，且要補零');
  assert.strictEqual(doc.code, '0330');
  assert.strictEqual(doc.name, '某某股');
  assert.strictEqual(doc.addedDate, '2026-08-21');
  assert.strictEqual(doc.note, '觀察中');
  assert.strictEqual(doc.migratedFrom, 'sheets:Watchlist');
  assert.strictEqual(doc.migratedAt, '2026-09-15T00:00:00.000Z');
  console.log('Test transformWatchlistRow (basic) passed.');
}

// --- transformWatchlistRow：代號空白要回傳 null，不能匯入一筆代號是空字串的垃圾文件 ---
{
  assert.strictEqual(transformWatchlistRow({ '證券代號': '', '證券名稱': '沒代號' }, 'x'), null);
  assert.strictEqual(transformWatchlistRow({ '證券代號': '   ', '證券名稱': '也沒代號' }, 'x'), null);
  console.log('Test transformWatchlistRow (blank code -> null, not imported) passed.');
}

// --- transformWatchlistRow：名稱/備註缺欄位時要用空字串，不能是 undefined——
//    Firestore Admin SDK 遇到欄位值是 undefined 會直接拋例外拒絕寫入 ---
{
  const doc = transformWatchlistRow({ '證券代號': '2330' }, 'x');
  assert.strictEqual(doc.name, '', 'name 缺欄位要是空字串，不能是 undefined');
  assert.strictEqual(doc.note, '', 'note 缺欄位要是空字串，不能是 undefined');
  console.log('Test transformWatchlistRow (missing optional fields default to empty string, not undefined) passed.');
}

console.log('All transform.js tests passed.');
