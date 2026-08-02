const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Portfolio.gs 裡「不呼叫 Apps Script 服務」的純函式（aggregateLots_），用跟其他 test 一樣的
// 手法把 .gs 檔案載進共用的 vm context 直接測。getPortfolio()/savePortfolioItem() 等會碰
// Sheets 的函式不在這裡測，屬於只能在真正的 Apps Script 環境驗證的部分。
const context = { console: console };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('Portfolio.gs');

function approxEqual(a, b, eps) { eps = eps || 1e-6; return Math.abs(a - b) < eps; }

// --- 1. 單筆 lot：加權平均成本必須等於它自己的成本（改版前舊資料遷移安全性的數學基礎） ---
{
  const agg = context.aggregateLots_([
    { '股數': 1000, '買進價格': 500, '買進日期': '2026-07-01' }
  ]);
  assert.strictEqual(agg.totalShares, 1000);
  assert.ok(approxEqual(agg.avgCost, 500));
  assert.strictEqual(agg.earliestBuyDate, '2026-07-01');
  console.log('Test 1 (aggregateLots_ single lot) passed.');
}

// --- 2. 分批買進：加權平均成本、總股數、最早買進日 ---
{
  // 7/1 買 1000 股 $500，7/15 加碼 1000 股 $520 -> 加權平均 (1000*500+1000*520)/2000 = 510
  const agg = context.aggregateLots_([
    { '股數': 1000, '買進價格': 500, '買進日期': '2026-07-01' },
    { '股數': 1000, '買進價格': 520, '買進日期': '2026-07-15' }
  ]);
  assert.strictEqual(agg.totalShares, 2000);
  assert.ok(approxEqual(agg.avgCost, 510), 'got ' + agg.avgCost);
  assert.strictEqual(agg.earliestBuyDate, '2026-07-01', '要是最早的那筆買進日，不是最新一筆');
  console.log('Test 2 (aggregateLots_ multiple lots, weighted avg) passed.');
}

// --- 3. 不等量分批：加權平均要照股數比例，不是單純平均兩個價格 ---
{
  // 500 股 $100 + 1500 股 $200 -> (500*100+1500*200)/2000 = 175，不是 (100+200)/2=150
  const agg = context.aggregateLots_([
    { '股數': 500, '買進價格': 100, '買進日期': '2026-01-01' },
    { '股數': 1500, '買進價格': 200, '買進日期': '2026-02-01' }
  ]);
  assert.ok(approxEqual(agg.avgCost, 175), 'got ' + agg.avgCost);
  console.log('Test 3 (aggregateLots_ unequal lot sizes) passed.');
}

// --- 4. 空陣列：不能除以 0，要回傳 0 成本、null 買進日 ---
{
  const agg = context.aggregateLots_([]);
  assert.strictEqual(agg.totalShares, 0);
  assert.strictEqual(agg.avgCost, 0);
  assert.strictEqual(agg.earliestBuyDate, null);
  console.log('Test 4 (aggregateLots_ empty array) passed.');
}

console.log('All Portfolio.gs tests passed.');
