const assert = require('assert');
const flowFactors = require('../lib/flowFactors');

function approxEqual(a, b, eps) {
  eps = eps || 1e-6;
  return Math.abs(a - b) < eps;
}

function dateStrAt(baseIdx) {
  const start = new Date(2026, 0, 1);
  const d = new Date(start);
  d.setDate(d.getDate() + baseIdx);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// --- computeFlowPersistenceFactors_：21 天精心設計的資料，逐欄位手算驗證 ---
{
  // isDrop[i] = (i>=2 && i%2===0) ? 1 : 0——偶數天（從第 2 天起）收盤價跌，
  // 奇數天（含第 0 天，第一天沒有前一天可比較）漲，形成固定的漲跌交錯
  // pattern，21 天（index 0~20）裡剛好有 10 個下跌日（index 2,4,...,20）。
  //
  // 外資：每天都買超（固定 +100）-> 全部 21 天都是「買超日」，10 個下跌日
  //   裡也全部有買 -> IBF_20D_foreign 在第 20 天應該是 10/10=1.0；
  //   Flow_Streak_foreign 應該是連續 21 天（0~20 全部買超）。
  // 投信：每天都賣超（固定 -100）-> IBF_20D_trust=0；Flow_Streak_trust=0
  //   （從來沒有買超過，streak 一直是 0）。
  // 自營商：只在「下跌日」裡挑一半（i%4===2 的那 5 個：2,6,10,14,18）買超
  //   （+50），其餘天數（含其他下跌日）都賣超（-50）-> 10 個下跌日裡有
  //   5 個買超 -> IBF_20D_dealer 第 20 天應該是 5/10=0.5；買超日彼此不
  //   連續（中間都夾著賣超日），所以 Flow_Streak_dealer 在任何一天都不會
  //   超過 1，第 20 天本身是賣超日（20%4===0），應該是 0。
  // 合計：外資(+100)+投信(-100) 互相抵銷，合計淨額剛好等於自營商當天的
  //   淨額——這剛好可以驗證「combined 是不是真的把三個身份加總」，合計版
  //   的 IBF_20D／Flow_Streak 應該跟自營商完全一樣。
  const rows = [];
  for (let i = 0; i <= 20; i++) {
    const isDropDay = (i >= 2 && i % 2 === 0);
    const close = isDropDay ? 95 : 100; // 跟前一天比：偶數天(>=2)比奇數天低，形成交錯漲跌
    const dealerBuyDay = isDropDay && (i % 4 === 2);
    rows.push({
      '日期': dateStrAt(i), '證券代號': '2330',
      '收盤價': close, '成交股數': 5000000,
      '外資': 100, '投信': -100, '自營商': dealerBuyDay ? 50 : -50
    });
  }

  const computed = flowFactors.computeFlowPersistenceFactors_(rows);
  const last = computed.find(function (r) { return r['日期'] === dateStrAt(20); });

  assert.ok(approxEqual(last.IBF_20D_foreign, 1.0), 'foreign: ' + last.IBF_20D_foreign);
  assert.strictEqual(last.Flow_Streak_foreign, 21, '外資每天都買超，第 20 天（第 21 筆）應該連續 21 天');

  assert.ok(approxEqual(last.IBF_20D_trust, 0), 'trust: ' + last.IBF_20D_trust);
  assert.strictEqual(last.Flow_Streak_trust, 0, '投信從來沒買超過，streak 應該一直是 0');

  assert.ok(approxEqual(last.IBF_20D_dealer, 0.5), 'dealer: ' + last.IBF_20D_dealer);
  assert.strictEqual(last.Flow_Streak_dealer, 0, '第 20 天自營商是賣超日，streak 應該是 0');

  assert.ok(approxEqual(last.IBF_20D_combined, last.IBF_20D_dealer), '外資+投信互相抵銷，合計版 IBF 應該等於自營商那一份');
  assert.strictEqual(last.Flow_Streak_combined, last.Flow_Streak_dealer, '合計版 streak 同理應該等於自營商那一份');

  console.log('Test computeFlowPersistenceFactors_ (IBF_20D/Flow_Streak per institutional type, combined = sum of three types) passed.');
}

// --- 視窗不滿 20 天（dropCount20 是 null）跟「視窗滿了但剛好 0 個下跌日」要同樣是 0，不是 null/NaN ---
{
  // 只有 10 天資料，20 天滾動視窗從頭到尾都不滿，dropCount20 整段都是
  // null——IBF_20D 不該因此變成 null，應該退回 0（跟 analysis.js
  // computeFactors_ 既有的 `!dc` 處理一致）。
  const shortRows = [];
  for (let i = 0; i < 10; i++) {
    shortRows.push({
      '日期': dateStrAt(i), '證券代號': '2330',
      '收盤價': 100 + i, '成交股數': 5000000, '外資': 100, '投信': 100, '自營商': 100
    });
  }
  const shortComputed = flowFactors.computeFlowPersistenceFactors_(shortRows);
  shortComputed.forEach(function (r) {
    assert.strictEqual(r.IBF_20D_foreign, 0, '視窗不滿 20 天時 IBF_20D 應該是 0，不是 null');
    assert.strictEqual(r.IBF_20D_combined, 0);
  });

  // 持續上漲、20 天視窗滿了但剛好 0 個下跌日（dropCount20===0，合法的
  // 「有算出來、結果是 0」，不是「算不出來」）——一樣應該是 0，不是除以 0
  // 的 NaN/Infinity。
  const risingRows = [];
  for (let i = 0; i < 25; i++) {
    risingRows.push({
      '日期': dateStrAt(i), '證券代號': '2330',
      '收盤價': 100 + i, '成交股數': 5000000, '外資': 100, '投信': 100, '自營商': 100
    });
  }
  const risingComputed = flowFactors.computeFlowPersistenceFactors_(risingRows);
  const risingLast = risingComputed.find(function (r) { return r['日期'] === dateStrAt(24); });
  assert.strictEqual(risingLast.IBF_20D_foreign, 0, '20 天視窗內完全沒有下跌日時 IBF_20D 應該是 0，不是 NaN');
  assert.ok(!isNaN(risingLast.Flow_Streak_foreign));

  console.log('Test computeFlowPersistenceFactors_ (incomplete window and zero-drop-day window both null-safely resolve to 0) passed.');
}

// --- 多股票：依代號分組各自獨立計算，4 碼以外的代號被濾掉 ---
{
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push({ '日期': dateStrAt(i), '證券代號': '2330', '收盤價': 100 - i * 0.1, '成交股數': 1000, '外資': 10, '投信': 10, '自營商': 10 });
    rows.push({ '日期': dateStrAt(i), '證券代號': '2454', '收盤價': 100 + i * 0.1, '成交股數': 1000, '外資': -10, '投信': -10, '自營商': -10 });
  }
  rows.push({ '日期': dateStrAt(0), '證券代號': 'ABCDE', '收盤價': 10, '成交股數': 100, '外資': 0, '投信': 0, '自營商': 0 });

  const computed = flowFactors.computeFlowPersistenceFactors_(rows);
  const codes = new Set(computed.map(function (r) { return r['證券代號']; }));
  assert.ok(codes.has('2330') && codes.has('2454'), '兩檔股票都要各自算出結果');
  assert.ok(!codes.has('ABCDE'), '非 4 碼代號要被濾掉');
  assert.strictEqual(computed.length, 50, '2 檔股票 * 25 天 = 50 筆，ABCDE 那筆不該算在內');

  console.log('Test computeFlowPersistenceFactors_ (groups independently by code, filters non-4-digit codes) passed.');
}

console.log('All flowFactors.js tests passed.');
