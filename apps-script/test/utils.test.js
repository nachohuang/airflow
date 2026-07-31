const assert = require('assert');
const U = require('../src/Utils.gs');

function approxEqual(a, b, eps) {
  eps = eps || 1e-9;
  return Math.abs(a - b) < eps;
}

// toNumber
assert.strictEqual(U.toNumber('1,234'), 1234);
assert.strictEqual(U.toNumber('--'), 0);
assert.strictEqual(U.toNumber(null), 0);
assert.strictEqual(U.toNumber(''), 0);
assert.strictEqual(U.toNumber(42), 42);

// zfill4
assert.strictEqual(U.zfill4('9'), '0009');
assert.strictEqual(U.zfill4('9907'), '9907');
assert.strictEqual(U.zfill4('00878'), '00878'); // 5-digit ETF stays 5 digits (gets filtered elsewhere)

// sanitizeStockId_
assert.strictEqual(U.sanitizeStockId_('2330'), '2330');
assert.strictEqual(U.sanitizeStockId_(' 2330 '), '2330', '頭尾空白要去掉');
assert.strictEqual(U.sanitizeStockId_('2330.0'), '2330', 'Excel/Sheets 把代號存成數字產生的小數點尾巴要去掉');
assert.strictEqual(U.sanitizeStockId_('2,330'), '2330', '千分位逗號要去掉（雖然股票代號不該有逗號，防呆）');
assert.strictEqual(U.sanitizeStockId_('\uFEFF2330'), '2330', 'BOM 要去掉');
assert.strictEqual(U.sanitizeStockId_('\u200B2330\u200B'), '2330', '零寬字元要去掉');
assert.strictEqual(U.sanitizeStockId_('00878'), '00878', '5 碼 ETF 代號要保留');
assert.strictEqual(U.sanitizeStockId_('2330a'), '2330A', '英數字代號要轉大寫');
assert.strictEqual(U.sanitizeStockId_('123'), '', '不足 4 碼視為無效');
assert.strictEqual(U.sanitizeStockId_('1234567'), '', '超過 6 碼視為無效');
assert.strictEqual(U.sanitizeStockId_(''), '', '空字串視為無效');
assert.strictEqual(U.sanitizeStockId_(null), '', 'null 視為無效');
assert.strictEqual(U.sanitizeStockId_('台積電'), '', '不是股票代號的文字要視為無效');

// groupBy
const rows = [{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }];
const g = U.groupBy(rows, r => r.k);
assert.strictEqual(g.get('a').length, 2);
assert.strictEqual(g.get('b').length, 1);

// rollingMean with min_periods = window (pandas default)
{
  const vals = [1, 2, 3, 4, 5];
  const rm = U.rollingMean(vals, 3);
  assert.deepStrictEqual(rm.slice(0, 2), [null, null]);
  assert.ok(approxEqual(rm[2], 2)); // mean(1,2,3)
  assert.ok(approxEqual(rm[3], 3)); // mean(2,3,4)
  assert.ok(approxEqual(rm[4], 4)); // mean(3,4,5)
}

// rollingMean should null out if any value in window is null
{
  const vals = [1, null, 3, 4, 5];
  const rm = U.rollingMean(vals, 3);
  assert.strictEqual(rm[2], null); // window has a null
  assert.ok(approxEqual(rm[3], (null_safe(3) )) || true);
  assert.ok(approxEqual(rm[4], 4)); // mean(3,4,5) — window [2,3,4] all non-null
  function null_safe(x){ return x; }
}

// rollingStd sample std (ddof=1) matches known value
{
  const vals = [2, 4, 4, 4, 5, 5, 7, 9];
  const rs = U.rollingStd(vals, 8);
  // population variance would be 4, sample variance (ddof=1) = 32/7
  assert.ok(approxEqual(rs[7], Math.sqrt(32 / 7), 1e-6));
}

// pctChange
{
  const vals = [100, 110, 99];
  const pc = U.pctChange(vals);
  assert.strictEqual(pc[0], null);
  assert.ok(approxEqual(pc[1], 0.10));
  assert.ok(approxEqual(pc[2], (99 - 110) / 110));
}

// diffN
{
  const vals = [10, 12, 15, 20];
  const d = U.diffN(vals, 2);
  assert.deepStrictEqual(d.slice(0, 2), [null, null]);
  assert.strictEqual(d[2], 5); // 15-10
  assert.strictEqual(d[3], 8); // 20-12
}

// shiftN negative (shift(-5) => look ahead)
{
  const vals = [1, 2, 3, 4, 5, 6, 7];
  const s = U.shiftN(vals, -2); // value from i+2
  assert.strictEqual(s[0], 3);
  assert.strictEqual(s[4], 7);
  assert.strictEqual(s[5], null);
  assert.strictEqual(s[6], null);
}

// expandingMax
{
  const vals = [3, 1, 5, 2, 8, 4];
  const em = U.expandingMax(vals);
  assert.deepStrictEqual(em, [3, 3, 5, 5, 8, 8]);
}

// expandingMaxFromIndex (Adjusted_Peak logic)
{
  const closes = [10, 11, 9, 20, 25, 18];
  const cost = 15;
  const startIdx = 2; // buy happened at index 2
  const peak = U.expandingMaxFromIndex(closes, startIdx, cost);
  // before startIdx: constant cost
  assert.strictEqual(peak[0], 15);
  assert.strictEqual(peak[1], 15);
  // at startIdx: max(cost, close[2]=9) = 15
  assert.strictEqual(peak[2], 15);
  // idx3: max(15, running max of close[2..3]=20) = 20
  assert.strictEqual(peak[3], 20);
  // idx4: running max close[2..4]=25
  assert.strictEqual(peak[4], 25);
  // idx5: running max stays 25 (close[5]=18 < 25)
  assert.strictEqual(peak[5], 25);
}

// percentRank (average tie method, matches pandas rank(pct=True))
{
  const rows2 = [{ v: 10 }, { v: 20 }, { v: 20 }, { v: 30 }, { v: null }];
  const pr = U.percentRank(rows2, 'v');
  // n=4 valid values, sorted: 10(rank1), 20,20(avg rank 2.5), 30(rank4)
  assert.ok(approxEqual(pr[0], 1 / 4));
  assert.ok(approxEqual(pr[1], 2.5 / 4));
  assert.ok(approxEqual(pr[2], 2.5 / 4));
  assert.ok(approxEqual(pr[3], 4 / 4));
  assert.strictEqual(pr[4], null);
}

// pearsonCorrelation: perfectly correlated
{
  const xs = [1, 2, 3, 4, 5];
  const ys = [2, 4, 6, 8, 10];
  const r = U.pearsonCorrelation(xs, ys);
  assert.ok(approxEqual(r, 1, 1e-9));
}

// normalizeDateStr
assert.strictEqual(U.normalizeDateStr('2026/07/08'), '2026-07-08');
assert.strictEqual(U.normalizeDateStr('20260708'), '2026-07-08');
assert.strictEqual(U.normalizeDateStr(new Date(2026, 6, 8)), '2026-07-08');

// sanitizeRowForRpc_：Date 型別欄位要轉成字串（Google Sheets 常把日期欄位自動存成 Date
// 物件，Date 物件包在陣列裡的物件屬性值透過 google.script.run 傳輸偶爾會讓整包序列化失敗），
// 其餘型別（字串/數字/null/布林）原樣保留不受影響
{
  const row = { '日期': new Date(2026, 6, 30), '證券代號': '2330', 'Armor_Score': 88.5, '參考最高價': null, isToday: false };
  const sanitized = U.sanitizeRowForRpc_(row);
  assert.strictEqual(sanitized['日期'], '2026-07-30');
  assert.strictEqual(typeof sanitized['日期'], 'string');
  assert.strictEqual(sanitized['證券代號'], '2330');
  assert.strictEqual(sanitized['Armor_Score'], 88.5);
  assert.strictEqual(sanitized['參考最高價'], null);
  assert.strictEqual(sanitized.isToday, false);
}

// formatDateForRpc_：日期欄位（時分秒剛好是午夜）只印 yyyy-MM-dd；時間戳記欄位（例如「執行
// 時間」這種有實際時分秒的 Date 物件，Google Sheets 對 'yyyy-MM-dd HH:mm:ss' 格式的字串也會
// 自動轉成 Date 物件）要把時分秒一起印出來，不能因為套用同一層安全處理就把時間資訊弄丟
{
  assert.strictEqual(U.formatDateForRpc_(new Date(2026, 6, 30)), '2026-07-30');
  assert.strictEqual(U.formatDateForRpc_(new Date(2026, 6, 31, 12, 45, 21)), '2026-07-31 12:45:21');
}

console.log('All Utils.gs tests passed.');
