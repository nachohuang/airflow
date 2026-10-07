const assert = require('assert');
const { buildAiUsageSummary_ } = require('../lib/aiUsage');

// --- 1. 依 date 分組加總 calls/inputTokens/outputTokens/cost ---
{
  const records = [
    { date: '2026-10-05', inputTokens: 1000, outputTokens: 500, costUsd: 0.01 },
    { date: '2026-10-05', inputTokens: 2000, outputTokens: 800, costUsd: 0.02 },
    { date: '2026-10-06', inputTokens: 500, outputTokens: 200, costUsd: 0.005 }
  ];
  const summary = buildAiUsageSummary_(records, 30, '2026-10-06');
  assert.strictEqual(summary.daily.length, 2);
  // 新到舊排序：10-06 排第一
  assert.strictEqual(summary.daily[0].date, '2026-10-06');
  assert.strictEqual(summary.daily[1].date, '2026-10-05');
  assert.strictEqual(summary.daily[1].calls, 2);
  assert.strictEqual(summary.daily[1].inputTokens, 3000);
  assert.strictEqual(summary.daily[1].outputTokens, 1300);
  assert.ok(Math.abs(summary.daily[1].cost - 0.03) < 1e-9);
  console.log('Test 1 (buildAiUsageSummary_ groups by date and sums fields) passed.');
}

// --- 2. totalCost/totalCalls 是全部記錄的加總，不分日期 ---
{
  const records = [
    { date: '2026-10-05', inputTokens: 1000, outputTokens: 500, costUsd: 0.01 },
    { date: '2026-10-06', inputTokens: 500, outputTokens: 200, costUsd: 0.005 },
    { date: '2026-10-07', inputTokens: 100, outputTokens: 50, costUsd: 0.001 }
  ];
  const summary = buildAiUsageSummary_(records, 30, '2026-10-07');
  assert.strictEqual(summary.totalCalls, 3);
  assert.ok(Math.abs(summary.totalCost - 0.016) < 1e-9);
  console.log('Test 2 (buildAiUsageSummary_ totalCost/totalCalls sum every record) passed.');
}

// --- 3. todayCost 只抓 nowDateStr 那一天，今天沒有任何記錄時回 0（不是 null/undefined）---
{
  const records = [{ date: '2026-10-05', inputTokens: 1000, outputTokens: 500, costUsd: 0.01 }];
  const withToday = buildAiUsageSummary_(records, 30, '2026-10-05');
  assert.ok(Math.abs(withToday.todayCost - 0.01) < 1e-9);

  const withoutToday = buildAiUsageSummary_(records, 30, '2026-10-07');
  assert.strictEqual(withoutToday.todayCost, 0);
  console.log('Test 3 (buildAiUsageSummary_ todayCost matches nowDateStr, 0 when absent) passed.');
}

// --- 4. 空記錄／沒帶 records 時安全回傳全 0，不拋錯 ---
{
  const empty = buildAiUsageSummary_([], 30, '2026-10-07');
  assert.deepStrictEqual(empty.daily, []);
  assert.strictEqual(empty.totalCost, 0);
  assert.strictEqual(empty.totalCalls, 0);
  assert.strictEqual(empty.todayCost, 0);
  assert.strictEqual(empty.days, 30);

  const undef = buildAiUsageSummary_(undefined, 7, '2026-10-07');
  assert.strictEqual(undef.totalCalls, 0);
  console.log('Test 4 (buildAiUsageSummary_ handles empty/undefined records safely) passed.');
}

// --- 5. 欠缺 inputTokens/outputTokens/costUsd 欄位時當 0 處理，不是 NaN ---
{
  const records = [{ date: '2026-10-07' }];
  const summary = buildAiUsageSummary_(records, 30, '2026-10-07');
  assert.strictEqual(summary.daily[0].inputTokens, 0);
  assert.strictEqual(summary.daily[0].outputTokens, 0);
  assert.strictEqual(summary.daily[0].cost, 0);
  assert.strictEqual(summary.totalCost, 0);
  console.log('Test 5 (buildAiUsageSummary_ treats missing numeric fields as 0, not NaN) passed.');
}

console.log('All aiUsage.js tests passed.');
