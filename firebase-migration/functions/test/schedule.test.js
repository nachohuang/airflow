const assert = require('assert');
const { shouldRunDailyReport_, isScheduledTick_, isWeekend_ } = require('../lib/schedule');

// 2026-10-05 是週一，2026-10-04 是週日，2026-10-03 是週六（跟本次對話的日期一致）。
function utc(y, m, d, h, min) {
  return new Date(Date.UTC(y, m - 1, d, h, min));
}

// --- 1. isScheduledTick_：目標時間所在的 5 分鐘區間內都算吻合，區間外不算 ---
{
  // 23:07 台北時間，目標 23:00，tick=5 -> bucket 1 vs bucket 0，不吻合
  assert.strictEqual(isScheduledTick_(utc(2026, 10, 5, 23, 7), 23, 0, 5), false);
  // 23:03 台北時間，目標 23:00，tick=5 -> 都是 bucket 0，吻合
  assert.strictEqual(isScheduledTick_(utc(2026, 10, 5, 23, 3), 23, 0, 5), true);
  // 目標 23:07，實際 23:09，tick=5 -> 都是 bucket 1（floor(7/5)=1, floor(9/5)=1），吻合
  assert.strictEqual(isScheduledTick_(utc(2026, 10, 5, 23, 9), 23, 7, 5), true);
  // 小時對不上，不管分鐘多接近都不吻合
  assert.strictEqual(isScheduledTick_(utc(2026, 10, 5, 22, 59), 23, 0, 5), false);
  // 沒帶 triggerHour/triggerMinute 時預設 23:00
  assert.strictEqual(isScheduledTick_(utc(2026, 10, 5, 23, 2), null, null, 5), true);
  console.log('Test 1 (isScheduledTick_ matches within the tick bucket) passed.');
}

// --- 2. isWeekend_：週六週日算週末，週一到週五不算 ---
{
  assert.strictEqual(isWeekend_(utc(2026, 10, 3, 12, 0)), true, '10/3 是週六');
  assert.strictEqual(isWeekend_(utc(2026, 10, 4, 12, 0)), true, '10/4 是週日');
  assert.strictEqual(isWeekend_(utc(2026, 10, 5, 12, 0)), false, '10/5 是週一');
  console.log('Test 2 (isWeekend_ identifies Sat/Sun) passed.');
}

// --- 3. shouldRunDailyReport_：綜合判斷——tick 吻合 + 平日 + 不是跳過日才回傳 true ---
// 注意：shouldRunDailyReport_ 內部會把傳進來的 now 當「真正的 UTC 時刻」自己
// 位移 +8 小時換算成台北時間，跟上面兩個測試直接把 utc(...) 當「已經是台北時間」
// 傳進去不一樣——這裡要傳「台北時間 - 8 小時」的 UTC 時刻，函式內部位移後才會
// 變成想要的台北時間。
{
  // 週一 23:00 台北時間 = 週一 15:00 UTC，預設設定 -> 應該要跑
  assert.strictEqual(shouldRunDailyReport_(utc(2026, 10, 5, 15, 0), {}), true);

  // 週六 23:00 台北時間 = 週六 15:00 UTC，即使時間吻合，skipWeekends 預設 true -> 不該跑
  assert.strictEqual(shouldRunDailyReport_(utc(2026, 10, 3, 15, 0), {}), false, '週末預設跳過');

  // 同上但 skipWeekends: false -> 該跑
  assert.strictEqual(shouldRunDailyReport_(utc(2026, 10, 3, 15, 0), { skipWeekends: false }), true);

  // 吻合時間、平日，但今天（台北日期）在 skipDates 裡 -> 不該跑
  assert.strictEqual(
    shouldRunDailyReport_(utc(2026, 10, 5, 15, 0), { skipDates: new Set(['2026-10-05']) }),
    false,
    '今天在 skip_dates 裡應該跳過'
  );

  // 自訂 triggerHour/triggerMinute=23:00，實際是台北時間 9:00（= UTC 1:00），沒吻合 -> 不該跑
  assert.strictEqual(
    shouldRunDailyReport_(utc(2026, 10, 5, 1, 0), { triggerHour: 23, triggerMinute: 0 }),
    false
  );
  // 自訂 triggerHour/triggerMinute=9:00，實際是台北時間 9:01（= UTC 1:01），吻合 -> 該跑
  assert.strictEqual(
    shouldRunDailyReport_(utc(2026, 10, 5, 1, 1), { triggerHour: 9, triggerMinute: 0 }),
    true
  );
  console.log('Test 3 (shouldRunDailyReport_ combines tick/weekend/skipDates checks) passed.');
}

console.log('All schedule.js tests passed.');
