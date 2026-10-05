const assert = require('assert');
const { zfill4, transformIndustryMapRow } = require('../transform');

// --- zfill4：跟其他表共用同一份 lib/normalize，這裡只是確認 re-export 沒有
//    漏掉或接錯 ---
{
  assert.strictEqual(zfill4('330'), '0330');
  console.log('Test zfill4 re-export passed.');
}

// --- transformIndustryMapRow：正常一筆的轉換結果 ---
{
  const row = { '證券代號': '330', '證券名稱': '某某股', '產業別': '半導體業', '市場別': '上市' };
  const doc = transformIndustryMapRow(row, '2026-10-05T00:00:00.000Z');
  assert.strictEqual(doc.id, '0330', '文件 ID 要跟 code 一樣，且要補零');
  assert.strictEqual(doc.code, '0330');
  assert.strictEqual(doc.name, '某某股');
  assert.strictEqual(doc.industry, '半導體業');
  assert.strictEqual(doc.market, '上市');
  assert.strictEqual(doc.migratedFrom, 'sheets:IndustryMap');
  assert.strictEqual(doc.migratedAt, '2026-10-05T00:00:00.000Z');
  console.log('Test transformIndustryMapRow (basic) passed.');
}

// --- transformIndustryMapRow：代號空白要回傳 null，不能匯入一筆代號是空字串的垃圾文件 ---
{
  assert.strictEqual(transformIndustryMapRow({ '證券代號': '', '證券名稱': '沒代號' }, 'x'), null);
  assert.strictEqual(transformIndustryMapRow({ '證券代號': '   ', '證券名稱': '也沒代號' }, 'x'), null);
  console.log('Test transformIndustryMapRow (blank code -> null, not imported) passed.');
}

// --- transformIndustryMapRow：名稱/產業別/市場別缺欄位時要用空字串，不能是 undefined ---
{
  const doc = transformIndustryMapRow({ '證券代號': '2330' }, 'x');
  assert.strictEqual(doc.name, '');
  assert.strictEqual(doc.industry, '');
  assert.strictEqual(doc.market, '');
  console.log('Test transformIndustryMapRow (missing optional fields default to empty string, not undefined) passed.');
}

console.log('All transform.js tests passed.');
