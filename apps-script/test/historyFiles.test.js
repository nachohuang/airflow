const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// monthKeyFor_ / monthlyFileName_ / monthRangeBetween_ 都是純函式（不碰 DriveApp），
// 用同一套 vm 共用全域 scope 的手法就能直接測，不用真的部署。
const context = { console: console };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('HistoryFiles.gs');

// --- monthKeyFor_ ---
assert.strictEqual(context.monthKeyFor_('2026-07-08'), '2026-07');
assert.strictEqual(context.monthKeyFor_('2026-01-31'), '2026-01');
console.log('Test monthKeyFor_ passed.');

// --- monthlyFileName_ ---
assert.strictEqual(context.monthlyFileName_('2026-07'), '2026-07_ALL_COMBINED.csv');
console.log('Test monthlyFileName_ passed.');

// --- monthRangeBetween_: 同一個月 ---
{
  const months = Array.from(context.monthRangeBetween_(new Date(2026, 6, 1), new Date(2026, 6, 31)));
  assert.deepStrictEqual(months, ['2026-07']);
  console.log('Test monthRangeBetween_ (same month) passed.');
}

// --- monthRangeBetween_: 橫跨月份邊界 ---
{
  const months = Array.from(context.monthRangeBetween_(new Date(2026, 5, 25), new Date(2026, 6, 3)));
  assert.deepStrictEqual(months, ['2026-06', '2026-07']);
  console.log('Test monthRangeBetween_ (crossing month boundary) passed.');
}

// --- monthRangeBetween_: 橫跨年份邊界 ---
{
  const months = Array.from(context.monthRangeBetween_(new Date(2025, 11, 20), new Date(2026, 0, 5)));
  assert.deepStrictEqual(months, ['2025-12', '2026-01']);
  console.log('Test monthRangeBetween_ (crossing year boundary) passed.');
}

// --- monthRangeBetween_: 橫跨多個月份 ---
{
  const months = Array.from(context.monthRangeBetween_(new Date(2026, 0, 15), new Date(2026, 3, 2)));
  assert.deepStrictEqual(months, ['2026-01', '2026-02', '2026-03', '2026-04']);
  console.log('Test monthRangeBetween_ (multi-month span) passed.');
}

console.log('All HistoryFiles.gs tests passed.');
