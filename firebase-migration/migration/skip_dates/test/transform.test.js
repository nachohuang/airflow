const assert = require('assert');
const { normalizeDateStr, transformSkipDateRow } = require('../transform');

// --- normalizeDateStr：跟其他表共用同一份 lib/normalize，這裡只是確認
//    re-export 沒有漏掉或接錯 ---
{
  assert.strictEqual(normalizeDateStr('2026/8/21'), '2026-08-21');
  console.log('Test normalizeDateStr re-export passed.');
}

// --- transformSkipDateRow：正常一筆的轉換結果 ---
{
  const row = { '日期': '2026-08-21', '原因': '颱風假' };
  const doc = transformSkipDateRow(row, '2026-10-05T00:00:00.000Z');
  assert.strictEqual(doc.id, '2026-08-21', '文件 ID 要跟 date 一樣');
  assert.strictEqual(doc.date, '2026-08-21');
  assert.strictEqual(doc.reason, '颱風假');
  assert.strictEqual(doc.migratedFrom, 'sheets:SkipDates');
  assert.strictEqual(doc.migratedAt, '2026-10-05T00:00:00.000Z');
  console.log('Test transformSkipDateRow (basic) passed.');
}

// --- transformSkipDateRow：日期空白要回傳 null，不能匯入一筆日期是空字串的垃圾文件 ---
{
  assert.strictEqual(transformSkipDateRow({ '日期': '', '原因': '沒日期' }, 'x'), null);
  assert.strictEqual(transformSkipDateRow({ '日期': '   ', '原因': '也沒日期' }, 'x'), null);
  console.log('Test transformSkipDateRow (blank date -> null, not imported) passed.');
}

// --- transformSkipDateRow：原因缺欄位時要用空字串，不能是 undefined ---
{
  const doc = transformSkipDateRow({ '日期': '2026-08-21' }, 'x');
  assert.strictEqual(doc.reason, '', 'reason 缺欄位要是空字串，不能是 undefined');
  console.log('Test transformSkipDateRow (missing reason defaults to empty string, not undefined) passed.');
}

console.log('All transform.js tests passed.');
