const assert = require('assert');
const { buildWatchlistItems_, assertNotHolding_, mergeWatchlistDoc_ } = require('../lib/watchlist');

// --- 1. buildWatchlistItems_：依加入日期新到舊排序，補上 latestClose/signal/名稱 ---
{
  const docs = [
    { code: '1101', name: '台塑', addedDate: '2026-09-01', note: '' },
    { code: '2330', name: '', addedDate: '2026-10-01', note: '觀察中' }
  ];
  const bqInfoByCode = {
    '1101': { close: 55.5, date: '2026-10-04', name: '台塑' },
    '2330': { close: 1080, date: '2026-10-04', name: '台積電' }
  };
  const signalByCode = { '2330': { date: '2026-10-04', strategy: '🚀 趨勢啟動', action: '建議：現價買入' } };
  const items = buildWatchlistItems_(docs, bqInfoByCode, signalByCode);

  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].code, '2330', '加入日期較新的要排在前面');
  assert.strictEqual(items[0].name, '台積電', '名稱空白時應該用 bqInfo 補救');
  assert.strictEqual(items[0].latestClose, 1080);
  assert.deepStrictEqual(items[0].signal, signalByCode['2330']);
  assert.strictEqual(items[1].code, '1101');
  assert.strictEqual(items[1].name, '台塑', '原本就有名稱時不該被 bqInfo 覆蓋');
  assert.strictEqual(items[1].signal, null, '查無戰報燈號時應該是 null，不是 undefined');
  console.log('Test 1 (buildWatchlistItems_ sorts by addedDate desc and enriches) passed.');
}

// --- 2. assertNotHolding_：已經持有中的股票要擋掉，沒有持有時放行 ---
{
  const portfolioMap = { '2330': { cost: 500, buyDate: '2026-01-01' } };
  assert.throws(function () { assertNotHolding_('2330', portfolioMap); }, /持有中/);
  assert.doesNotThrow(function () { assertNotHolding_('1101', portfolioMap); });
  console.log('Test 2 (assertNotHolding_ blocks codes already in portfolioMap) passed.');
}

// --- 3. mergeWatchlistDoc_：新增 vs 更新既有文件 ---
{
  const created = mergeWatchlistDoc_(null, '2330', '台積電', '留意法人動向', '2026-10-05');
  assert.deepStrictEqual(created, { code: '2330', name: '台積電', addedDate: '2026-10-05', note: '留意法人動向' });

  const updated = mergeWatchlistDoc_(
    { code: '2330', name: '台積電', addedDate: '2026-09-01', note: '舊備註' },
    '2330', '', '新備註', '2026-10-05'
  );
  assert.strictEqual(updated.addedDate, '2026-09-01', '更新既有文件時不該改動原本的加入日期');
  assert.strictEqual(updated.name, '台積電', '沒帶新名稱時應該保留原本的名稱');
  assert.strictEqual(updated.note, '新備註');
  console.log('Test 3 (mergeWatchlistDoc_ handles new vs existing upsert) passed.');
}

console.log('All watchlist.js tests passed.');
