const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const context = { console: console };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('FactorScan.gs');
loadIntoContext('Backtest.gs');

function approxEqual(a, b, eps) { eps = eps || 1e-6; return Math.abs(a - b) < eps; }

// --- computeStreak_ ---
{
  const tags = [1, 1, 0, 1, 1, 1, 0, 0, 1];
  const streak = Array.from(context.computeStreak_(tags));
  assert.deepStrictEqual(streak, [1, 2, 0, 1, 2, 3, 0, 0, 1]);
  console.log('Test computeStreak_ passed.');
}

// --- median_ ---
{
  assert.strictEqual(context.median_([1, 3, 2]), 2);
  assert.strictEqual(context.median_([1, 2, 3, 4]), 2.5);
  console.log('Test median_ passed.');
}

// --- computeFactorScanFields_: Safety_Rank formula on a hand-computed case ---
{
  function mkRows(days, codeCloses) {
    const rows = [];
    const start = new Date(2026, 0, 1);
    for (let i = 0; i < days; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      rows.push({
        '日期': dateStr, '證券代號': '1101', '證券名稱': '台泥',
        '外資': 1000, '投信': 0, '自營商': 0, '成交股數': 1000000, '成交金額': 50000000,
        '最後揭示買量': 100, '最後揭示賣量': 100,
        '收盤價': codeCloses[i]
      });
    }
    return rows;
  }
  // flat price series so MA60 == close, BIAS_60 == 0, Min_20D == close (flat) => Floor_Dist == 0
  const closes = new Array(65).fill(50);
  const rows = mkRows(65, closes);
  const computed = context.computeFactorScanFields_(rows);
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];
  // Safety_Rank = ((0.15-0)/0.25*60) + ((0.15-0)/0.15*40) = 36 + 40 = 76
  assert.ok(approxEqual(last.Safety_Rank, 76), 'Safety_Rank got ' + last.Safety_Rank);
  console.log('Test computeFactorScanFields_ Safety_Rank passed:', last.Safety_Rank);
}

// --- computeBacktestFields_: WIP + Market_5D_Trend sanity ---
{
  function mkRow(dateStr, code, close, trust, foreign, dealer, vol) {
    return {
      '日期': dateStr, '證券代號': code, '證券名稱': 'X',
      '投信': trust, '外資': foreign, '自營商': dealer,
      '成交股數': vol, '成交金額': vol * close,
      '最後揭示買量': 100, '最後揭示賣量': 50,
      '收盤價': close
    };
  }
  const rows = [];
  const dates = [];
  const start = new Date(2026, 0, 1);
  for (let i = 0; i < 10; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    dates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }
  // two stocks, simple deterministic flows
  dates.forEach(function (dateStr, i) {
    rows.push(mkRow(dateStr, '2330', 100 + i, 1000, 500, 0, 10000));
    rows.push(mkRow(dateStr, '2317', 50 + i * 0.5, -200, 300, 0, 5000));
  });
  const computed = context.computeBacktestFields_(rows);
  const tsmc = context.sortRows(computed.filter(function (r) { return r['證券代號'] === '2330'; }), [[function (r) { return r['日期']; }, 'asc']]);
  // WIN = 1000*0.5 + 500*0.3 + 0*0.2 = 650; WIP = 650/10000 = 0.065
  assert.ok(approxEqual(tsmc[0].WIP, 0.065), 'WIP got ' + tsmc[0].WIP);

  // Market_Median should be defined for every date (both stocks have Daily_Return from day 2 onward)
  const day2 = tsmc[1];
  assert.ok(day2.Market_Median !== null, 'Market_Median should not be null once returns exist');
  console.log('Test computeBacktestFields_ WIP/Market_Median passed.');
}

console.log('All FactorScan/Backtest tests passed.');
