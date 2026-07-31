const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// 策略研究頁面（因子相關性掃描 + v17.0 策略回測）用的純函式，跟其他 test 一樣的手法把
// .gs 檔案載進共用的 vm context 直接測。round_/mean_/normalizeDateStr/toNumber 等共用工具
// 現在都放在 Utils.gs，Backtest.gs 直接重用 Analysis.gs 的 computeFactors_/diagnoseRow_，
// 兩者都要先載入。
const context = { console: console };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('FactorScan.gs');
loadIntoContext('Analysis.gs');
loadIntoContext('Backtest.gs');

function approxEqual(a, b, eps) { eps = eps || 1e-6; return Math.abs(a - b) < eps; }

// --- computeStreak_ ---
{
  const tags = [1, 1, 0, 1, 1, 1, 0, 0, 1];
  const streak = Array.from(context.computeStreak_(tags));
  assert.deepStrictEqual(streak, [1, 2, 0, 1, 2, 3, 0, 0, 1]);
  console.log('Test computeStreak_ passed.');
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

// --- simulateTradeForward_：v17.0 回測的核心逐日模擬，出場規則要跟 diagnoseRow_ 對既有持股
//     用的「從高點回落 TRAILING_STOP_PERCENT 就出場」完全一致 ---
function mkTrack(startDateStr, closes) {
  const start = new Date(startDateStr + 'T00:00:00');
  return closes.map(function (close, i) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return { '日期': dateStr, '收盤價': close };
  });
}

// 1. 一路上漲到達標
{
  const track = mkTrack('2026-07-01', [100, 101, 103, 106]); // entry@100, day3 close=106 -> +6% >= 5% target
  const sim = context.simulateTradeForward_(track, 0, 5, 0.025, 40);
  assert.strictEqual(sim.exitLabel, '🎯 達標');
  assert.strictEqual(sim.exitDate, '2026-07-04');
  assert.strictEqual(sim.daysHeld, 3);
  assert.ok(approxEqual(sim.finalReturnPct, 6), 'got ' + sim.finalReturnPct);
  console.log('Test simulateTradeForward_ (target hit) passed.');
}

// 2. 先衝高再跌破停損線（從高點回落 2.5%）
{
  // entry@100 -> peak 110 (day1) -> day2 close=107.2，回落 (110-107.2)/110=2.545% >= 2.5% 觸發停損
  // 目標報酬故意設 50%（遠高於這段區間的漲幅），確保停損邏輯在到達目標之前先被觸發，不會被
  // day1 那根 +10% 提早判定成「🎯 達標」蓋過去。
  const track = mkTrack('2026-07-01', [100, 110, 107.2]);
  const sim = context.simulateTradeForward_(track, 0, 50, 0.025, 40);
  assert.strictEqual(sim.exitLabel, '🛑 止損');
  assert.strictEqual(sim.exitDate, '2026-07-03');
  assert.ok(approxEqual(sim.peakReturnPct, 10), 'peakReturnPct got ' + sim.peakReturnPct);
  assert.ok(sim.finalReturnPct > 0, '雖然觸發停損，因為還在成本之上，最終報酬應該還是正的');
  console.log('Test simulateTradeForward_ (trailing stop) passed.');
}

// 3. 一直盤整，追蹤天數用完仍未觸發任何條件
{
  const track = mkTrack('2026-07-01', [100, 100.5, 100.2, 100.8]);
  const sim = context.simulateTradeForward_(track, 0, 5, 0.025, 2); // maxHoldDays=2，資料還有更多天但被追蹤上限截斷
  assert.strictEqual(sim.exitLabel, '⏳ 未觸發出場');
  assert.strictEqual(sim.daysHeld, 2);
  console.log('Test simulateTradeForward_ (no trigger, capped by maxHoldDays) passed.');
}

// 4. 進場價是 0/缺值時要回傳 null，不能除以 0
{
  const track = mkTrack('2026-07-01', [0, 100]);
  assert.strictEqual(context.simulateTradeForward_(track, 0, 5, 0.025, 40), null);
  console.log('Test simulateTradeForward_ (zero entry price -> null) passed.');
}

console.log('All FactorScan/Backtest tests passed.');
