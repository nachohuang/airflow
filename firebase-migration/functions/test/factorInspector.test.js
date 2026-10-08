const assert = require('assert');
const lib = require('../lib/factorInspector');

// --- validateFactorInspectorRange_ ---
{
  assert.deepStrictEqual(lib.validateFactorInspectorRange_('2026-01-01', '2026-01-31'), { ok: true });
  assert.deepStrictEqual(lib.validateFactorInspectorRange_('2026-01-01', '2026-01-01'), { ok: true }, '起訖同一天應該合法（查單日）');
  assert.ok(lib.validateFactorInspectorRange_('2026-01-31', '2026-01-01').error, '結束日早於起始日要回報錯誤');
  assert.ok(lib.validateFactorInspectorRange_('bad-date', '2026-01-01').error, '格式不正確要回報錯誤，不是讓 NaN 悄悄通過');

  var start = '2026-01-01';
  var endDt = new Date(start + 'T00:00:00');
  endDt.setDate(endDt.getDate() + lib.FACTOR_INSPECTOR_MAX_RANGE_DAYS);
  var end = endDt.toISOString().slice(0, 10);
  assert.ok(lib.validateFactorInspectorRange_(start, end).ok, '剛好等於上限天數應該合法');
  endDt.setDate(endDt.getDate() + 1);
  var tooFar = endDt.toISOString().slice(0, 10);
  assert.ok(lib.validateFactorInspectorRange_(start, tooFar).error, '超過上限天數要回報錯誤');
  console.log('Test validateFactorInspectorRange_ (date format / ordering / max range) passed.');
}

// --- sortFinancialDocsByDate_ ---
{
  var docs = [
    { code: '1101', period: '2026-07-15', v: 'c' },
    { code: '1101', period: '2026-01-10', v: 'a' },
    { code: '1101', period: '2026-04-12', v: 'b' }
  ];
  var sorted = lib.sortFinancialDocsByDate_(docs, 'period');
  assert.deepStrictEqual(sorted.map(function (d) { return d.v; }), ['a', 'b', 'c']);
  assert.deepStrictEqual(docs.map(function (d) { return d.v; }), ['c', 'a', 'b'], '不應該修改原始陣列');

  assert.deepStrictEqual(lib.sortFinancialDocsByDate_([], 'period'), []);
  assert.deepStrictEqual(lib.sortFinancialDocsByDate_(null, 'period'), [], 'null 輸入要安全回傳空陣列');

  var withMissing = [{ period: '2026-02-01', v: 'x' }, { v: 'missing' }, { period: '2026-01-01', v: 'y' }];
  var sortedMissing = lib.sortFinancialDocsByDate_(withMissing, 'period');
  assert.deepStrictEqual(sortedMissing.map(function (d) { return d.v; }), ['missing', 'y', 'x'], '缺日期欄位的列當成空字串排最前面，不該整個拋錯');
  console.log('Test sortFinancialDocsByDate_ (sorts ascending by date field, immutable, handles empty/missing) passed.');
}

console.log('All factorInspector.js tests passed.');
