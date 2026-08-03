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
loadIntoContext('Realtime.gs');

// --- 1. 委買力道強 + 現價貼近當日低點 -> 高分、偏向有利買進 ---
{
  const v = context.computeBuySellVerdict_(0.8, 100, 110, 95);
  // pressureScore = 80, rangeScore = (110-100)/(110-95)*100 = 66.67
  // score = 80*0.6 + 66.67*0.4 = 48 + 26.67 = 74.67
  assert.ok(v.score > 65, 'expected score > 65, got ' + v.score);
  assert.strictEqual(v.label, '🟢 偏向有利買進');
  console.log('Test 1 (strong bid pressure + near daily low -> favorable buy) passed:', v.score);
}

// --- 2. 委賣力道強 + 現價貼近當日高點 -> 低分、偏向有利賣出 ---
{
  const v = context.computeBuySellVerdict_(0.2, 108, 110, 95);
  // pressureScore = 20, rangeScore = (110-108)/(110-95)*100 = 13.33
  // score = 20*0.6 + 13.33*0.4 = 12 + 5.33 = 17.33
  assert.ok(v.score < 35, 'expected score < 35, got ' + v.score);
  assert.strictEqual(v.label, '🔴 偏向有利賣出');
  console.log('Test 2 (strong ask pressure + near daily high -> favorable sell) passed:', v.score);
}

// --- 3. 力道與價位都中性 -> 多空不明顯 ---
{
  const v = context.computeBuySellVerdict_(0.5, 102, 110, 95);
  assert.ok(v.score > 35 && v.score < 65, 'expected neutral score, got ' + v.score);
  assert.strictEqual(v.label, '⚪ 多空不明顯');
  console.log('Test 3 (neutral pressure and price position) passed:', v.score);
}

// --- 4. buyRatio 是 null（掛單量全部是 0）-> 資料不足 ---
{
  const v = context.computeBuySellVerdict_(null, 102, 110, 95);
  assert.strictEqual(v.score, null);
  assert.strictEqual(v.label, '⚪ 資料不足');
  console.log('Test 4 (buyRatio null -> insufficient data) passed');
}

// --- 5. highPrice === lowPrice（今天還沒有價格波動）-> 價位分數用中性值 50，不是 NaN ---
{
  const v = context.computeBuySellVerdict_(0.6, 100, 100, 100);
  // rangeScore = 50 (中性), pressureScore = 60, score = 60*0.6 + 50*0.4 = 36 + 20 = 56
  assert.ok(!Number.isNaN(v.score), 'score should not be NaN when high === low');
  assert.ok(Math.abs(v.score - 56) < 0.01, 'expected score ~56, got ' + v.score);
  console.log('Test 5 (high === low -> neutral range score, no NaN) passed:', v.score);
}

console.log('All Realtime.gs tests passed.');
