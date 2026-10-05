const assert = require('assert');
const { aggregateLots_, buildPortfolioMap_ } = require('../lib/portfolio');

// --- aggregateLots_：加權平均成本、最早買進日 ---
{
  const lots = [
    { buyPrice: 100, shares: 1000, buyDate: '2026-08-21' },
    { buyPrice: 120, shares: 500, buyDate: '2026-08-01' }
  ];
  const agg = aggregateLots_(lots);
  assert.strictEqual(agg.totalShares, 1500);
  assert.strictEqual(agg.avgCost, Math.round(((100 * 1000 + 120 * 500) / 1500) * 10000) / 10000);
  assert.strictEqual(agg.earliestBuyDate, '2026-08-01', '最早買進日要是兩筆裡較早的那一筆');
  console.log('Test aggregateLots_ (weighted avg cost, earliest buy date) passed.');
}

// --- aggregateLots_：空陣列 -> totalShares 0、avgCost 0（不是 null，跟
//     apps-script 的 aggregateLots_ 同樣的「totalShares>0 才算 avgCost」規則）---
{
  const agg = aggregateLots_([]);
  assert.strictEqual(agg.totalShares, 0);
  assert.strictEqual(agg.avgCost, 0);
  assert.strictEqual(agg.earliestBuyDate, null);
  console.log('Test aggregateLots_ (empty lots) passed.');
}

// --- buildPortfolioMap_：只看 status === 'holding'，已賣出的不算 ---
{
  const lotDocs = [
    { code: '2330', status: 'holding', buyPrice: 600, shares: 10, buyDate: '2026-01-10' },
    { code: '2330', status: 'holding', buyPrice: 620, shares: 10, buyDate: '2026-02-01' },
    { code: '2330', status: 'sold', buyPrice: 500, shares: 100, buyDate: '2025-01-01' },
    { code: '6491', status: 'holding', buyPrice: 500, shares: 1000, buyDate: '2026-08-01' }
  ];
  const map = buildPortfolioMap_(lotDocs);
  assert.strictEqual(Object.keys(map).length, 2);
  assert.strictEqual(map['2330'].cost, 610, '只有兩筆 holding 的 2330 要算進加權平均成本，已賣出那筆不算');
  assert.strictEqual(map['2330'].buyDate, '2026-01-10');
  assert.strictEqual(map['6491'].cost, 500);
  console.log('Test buildPortfolioMap_ (holding only, grouped by code) passed.');
}

// --- buildPortfolioMap_：空/null 輸入不該丟例外 ---
{
  assert.deepStrictEqual(buildPortfolioMap_([]), {});
  assert.deepStrictEqual(buildPortfolioMap_(null), {});
  console.log('Test buildPortfolioMap_ (empty/null input) passed.');
}

console.log('All portfolio.js tests passed.');
