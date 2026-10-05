const assert = require('assert');
const { buildPortfolioCards_, buildClosedHistory_ } = require('../lib/portfolioOps');

// --- 1. buildPortfolioCards_：同一檔股票分批買進 -> 一張卡片、加權平均成本、lots 依買進日排序 ---
{
  const lotDocs = [
    { transactionId: 'a', code: '2330', name: '台積電', buyDate: '2026-02-01', buyPrice: 500, shares: 1000, note: '', status: 'holding' },
    { transactionId: 'b', code: '2330', name: '台積電', buyDate: '2026-01-01', buyPrice: 400, shares: 1000, note: '', status: 'holding' },
    { transactionId: 'c', code: '1101', name: '台塑', buyDate: '2026-03-01', buyPrice: 55, shares: 2000, note: '單筆備註', status: 'holding' },
    { transactionId: 'd', code: '9999', name: '已賣出股', buyDate: '2026-01-01', buyPrice: 10, shares: 1000, note: '', status: 'sold', sellDate: '2026-02-01', sellPrice: 12 }
  ];
  const bqInfoByCode = { '2330': { close: 520, date: '2026-10-04', name: '台積電' } };
  const signalByCode = { '1101': { date: '2026-10-04', strategy: '續抱', action: '持有' } };
  const cards = buildPortfolioCards_(lotDocs, bqInfoByCode, signalByCode);

  assert.strictEqual(cards.length, 2, '已賣出的紀錄不該出現在持股卡片裡');
  const codes = cards.map(function (c) { return c.code; });
  assert.deepStrictEqual(codes, ['1101', '2330'], '卡片要依代號排序');

  const tsmc = cards.find(function (c) { return c.code === '2330'; });
  assert.strictEqual(tsmc.totalShares, 2000);
  assert.strictEqual(tsmc.cost, 450, '加權平均成本 (500*1000+400*1000)/2000 = 450');
  assert.strictEqual(tsmc.buyDate, '2026-01-01', '最早買進日期');
  assert.deepStrictEqual(tsmc.lots.map(function (l) { return l.id; }), ['b', 'a'], 'lots 要依買進日期由舊到新排序');
  assert.strictEqual(tsmc.note, '', '多筆 lot 時卡片層級的 note 不該顯示任何單筆備註');
  assert.strictEqual(tsmc.latestClose, 520);
  assert.strictEqual(tsmc.signal, null);

  const fpc = cards.find(function (c) { return c.code === '1101'; });
  assert.strictEqual(fpc.note, '單筆備註', '只有一筆 lot 時應該直接顯示那筆的備註');
  assert.strictEqual(fpc.latestClose, null, '沒有 bqInfo 時應該是 null');
  assert.deepStrictEqual(fpc.signal, signalByCode['1101']);
  console.log('Test 1 (buildPortfolioCards_ groups lots into weighted-average cards) passed.');
}

// --- 2. buildClosedHistory_：依 code+sellDate+sellPrice 分組，算出已實現損益 ---
{
  const lotDocs = [
    { code: '9999', name: '已賣出股', buyDate: '2026-01-01', buyPrice: 10, shares: 1000, status: 'sold', sellDate: '2026-02-01', sellPrice: 12 },
    { code: '9999', name: '已賣出股', buyDate: '2026-01-05', buyPrice: 10, shares: 1000, status: 'sold', sellDate: '2026-02-01', sellPrice: 12 },
    { code: '1234', name: '另一檔', buyDate: '2026-01-01', buyPrice: 100, shares: 500, status: 'sold', sellDate: '2026-03-01', sellPrice: 90 },
    { code: '2330', name: '持有中', buyDate: '2026-01-01', buyPrice: 500, shares: 1000, status: 'holding' }
  ];
  const groups = buildClosedHistory_(lotDocs);

  assert.strictEqual(groups.length, 2, '持有中的紀錄不該出現在歷史結案紀錄裡');
  assert.strictEqual(groups[0].code, '1234', '要依賣出日期新到舊排序');
  assert.strictEqual(groups[0].realizedPct, -10, '(90-100)/100*100 = -10');
  assert.strictEqual(groups[0].realizedAmount, -5000, '(90-100)*500 = -5000');

  const tsmcGroup = groups[1];
  assert.strictEqual(tsmcGroup.code, '9999');
  assert.strictEqual(tsmcGroup.totalShares, 2000, '同一次結案動作的兩筆 lot 要合併');
  assert.strictEqual(tsmcGroup.avgCost, 10);
  assert.strictEqual(tsmcGroup.realizedPct, 20, '(12-10)/10*100 = 20');
  assert.strictEqual(tsmcGroup.realizedAmount, 4000, '(12-10)*2000 = 4000');
  console.log('Test 2 (buildClosedHistory_ groups sold lots and computes realized P&L) passed.');
}

console.log('All portfolioOps.js tests passed.');
