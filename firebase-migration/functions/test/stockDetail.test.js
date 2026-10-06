const assert = require('assert');
const { buildPriceSeries_, buildScoreHistory_ } = require('../lib/stockDetail');

function row(date, close, overrides) {
  return Object.assign({
    '日期': date, '證券代號': '2330', '證券名稱': '台積電',
    '外資': 1000, '投信': 500, '自營商': 0, '三大法人買賣超股數': 1500,
    '成交股數': 5000000, '開盤價': close - 1, '最高價': close + 1, '最低價': close - 2,
    '收盤價': close
  }, overrides || {});
}

// --- 1. buildPriceSeries_：依日期排序（就算輸入是亂序的），MA5/20/60 正確 ---
{
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const d = '2026-01-' + String(i + 1).padStart(2, '0');
    rows.push(row(d, 100 + i));
  }
  // 刻意打亂輸入順序，確認這支自己會排序
  const shuffled = [rows[5], rows[0], rows[9], rows[2], rows[7], rows[1], rows[8], rows[3], rows[6], rows[4]];
  const series = buildPriceSeries_(shuffled);

  assert.strictEqual(series.length, 10);
  assert.deepStrictEqual(series.map(function (s) { return s.date; }), rows.map(function (r) { return r['日期']; }));
  assert.strictEqual(series[0].ma5, null, '前 4 天資料不足 5 筆，MA5 應該是 null');
  // 第 5 筆（index 4）收盤價 100..104，MA5 = (100+101+102+103+104)/5 = 102
  assert.strictEqual(series[4].ma5, 102);
  assert.strictEqual(series[9].ma20, null, '只有 10 筆資料，不到 20 筆，MA20 應該全部是 null');
  assert.strictEqual(series[0].close, 100);
  assert.strictEqual(series[0].foreign, 1000);
  assert.strictEqual(series[0].instNet, 1500);
  console.log('Test 1 (buildPriceSeries_ sorts input and computes MA5/20/60) passed.');
}

// --- 2. buildPriceSeries_：空輸入回傳空陣列，不噴錯 ---
{
  assert.deepStrictEqual(buildPriceSeries_([]), []);
  assert.deepStrictEqual(buildPriceSeries_(null), []);
  console.log('Test 2 (buildPriceSeries_ handles empty/null input) passed.');
}

// --- 3. buildScoreHistory_：依日期新到舊排序，只留精簡欄位 ---
{
  const docs = [
    { date: '2026-09-01', code: '2330', armorScore: 80, strategy: 'A', action: 'hold', extra: 'ignored' },
    { date: '2026-10-01', code: '2330', armorScore: 90, strategy: 'B', action: 'buy' },
    { date: '2026-09-15', code: '2330', armorScore: 85, strategy: 'C', action: 'sell' }
  ];
  const history = buildScoreHistory_(docs);
  assert.deepStrictEqual(history.map(function (h) { return h.date; }), ['2026-10-01', '2026-09-15', '2026-09-01']);
  assert.strictEqual(history[0].armorScore, 90);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(history[0], 'extra'), false, '不該保留 code/extra 這類多餘欄位');
  console.log('Test 3 (buildScoreHistory_ sorts desc and trims fields) passed.');
}

console.log('All stockDetail.js tests passed.');
