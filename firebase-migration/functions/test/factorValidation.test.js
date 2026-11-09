const assert = require('assert');
const fv = require('../lib/factorValidation');

function approxEqual(a, b, eps) {
  eps = eps || 1e-6;
  return Math.abs(a - b) < eps;
}

// --- computeForwardReturns_ ---
{
  const closeArr = [100, 110, 121, 90, 99];
  const fwd2 = fv.computeForwardReturns_(closeArr, 2);
  // index0: (121-100)/100=0.21；index1: (90-110)/110；index2: (99-121)/121；
  // index3/4：往後 2 天已經超出陣列範圍，算不出來，要是 null 不是 0。
  assert.ok(approxEqual(fwd2[0], 0.21), fwd2[0]);
  assert.ok(approxEqual(fwd2[1], (90 - 110) / 110), fwd2[1]);
  assert.ok(approxEqual(fwd2[2], (99 - 121) / 121), fwd2[2]);
  assert.strictEqual(fwd2[3], null, '往後 2 天超出陣列範圍，要是 null 不是 0');
  assert.strictEqual(fwd2[4], null);

  // 收盤價是 0 時算不出報酬率，要是 null 不是 Infinity/NaN。
  const withZero = fv.computeForwardReturns_([0, 10, 20], 1);
  assert.strictEqual(withZero[0], null, '收盤價 0 時要是 null，不是除以 0 的 Infinity');
  console.log('Test computeForwardReturns_ (forward n-day return, null at array tail, null on zero close) passed.');
}

// --- rankValues_ ---
{
  // 10, 30, 20, 30 -> 名次：10 最小 1/4=0.25；20 第二 2/4=0.5；兩個 30 同分，
  // 平均名次 (3+4)/2=3.5，3.5/4=0.875。
  const ranks = fv.rankValues_([10, 30, 20, 30]);
  assert.ok(approxEqual(ranks[0], 0.25), ranks[0]);
  assert.ok(approxEqual(ranks[1], 0.875), ranks[1]);
  assert.ok(approxEqual(ranks[2], 0.5), ranks[2]);
  assert.ok(approxEqual(ranks[3], 0.875), ranks[3]);

  // null/undefined 值要被排除在排名之外（結果是 null），不是被當成 0 參與排序。
  const withNull = fv.rankValues_([10, null, 20, undefined]);
  assert.strictEqual(withNull[1], null);
  assert.strictEqual(withNull[3], null);
  assert.ok(approxEqual(withNull[0], 0.5), withNull[0]); // 剩兩個有效值，10 最小 -> 1/2=0.5
  assert.ok(approxEqual(withNull[2], 1), withNull[2]); // 20 最大 -> 2/2=1

  console.log('Test rankValues_ (average-rank tie handling, null excluded from ranking) passed.');
}

// --- spearmanRankCorrelation_ ---
{
  // 完全正相關：名次完全一致 -> ic=1
  const pos = fv.spearmanRankCorrelation_([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
  assert.ok(approxEqual(pos.ic, 1), pos.ic);
  assert.strictEqual(pos.n, 5);

  // 完全負相關 -> ic=-1
  const neg = fv.spearmanRankCorrelation_([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]);
  assert.ok(approxEqual(neg.ic, -1), neg.ic);
  assert.strictEqual(neg.n, 5);

  // 任一邊 null 的配對要被排除，不計入 n，也不該拖累剩下配對算出來的相關係數。
  const withNull = fv.spearmanRankCorrelation_([1, 2, null, 4, 5], [10, 20, 30, 40, 50]);
  assert.strictEqual(withNull.n, 4, '有一邊是 null 的配對要被排除，n 應該是 4 不是 5');
  assert.ok(approxEqual(withNull.ic, 1), withNull.ic); // 剩下的 4 組名次還是完全遞增，ic 應該還是 1

  console.log('Test spearmanRankCorrelation_ (perfect positive/negative correlation, null-pair exclusion) passed.');
}

// --- computeIcSeries_ ---
{
  function row(date, code, factor, fwdReturn) {
    return { '日期': date, '證券代號': code, factorVal: factor, fwdRet: fwdReturn };
  }
  const rows = [
    row('2026-01-01', '1101', 1, 0.1), row('2026-01-01', '1102', 2, 0.2), row('2026-01-01', '1103', 3, 0.3),
    row('2026-01-02', '1101', 1, 0.3), row('2026-01-02', '1102', 2, 0.2), row('2026-01-02', '1103', 3, 0.1)
  ];

  // 明確傳入 minSampleSize=3（每天剛好 3 筆），驗證兩天分別算出完全正/負相關。
  const series = fv.computeIcSeries_(rows, 'factorVal', 'fwdRet', 3);
  assert.strictEqual(series.length, 2);
  assert.strictEqual(series[0].date, '2026-01-01');
  assert.ok(approxEqual(series[0].ic, 1), series[0].ic);
  assert.strictEqual(series[1].date, '2026-01-02');
  assert.ok(approxEqual(series[1].ic, -1), series[1].ic);

  // 不傳 minSampleSize：用預設門檻（10），每天只有 3 筆樣本，低於門檻，ic 要是
  // null（不可信的樣本數不該算出一個看起來很確定的數字），但 n 仍然要反映
  // 真實的有效配對數，讓呼叫端看得出「不是沒資料，是資料不夠多」。
  const defaultGated = fv.computeIcSeries_(rows, 'factorVal', 'fwdRet');
  assert.strictEqual(defaultGated[0].ic, null, '樣本數低於預設門檻時 ic 要是 null');
  assert.strictEqual(defaultGated[0].n, 3, '即使 ic 被設成 null，n 還是要反映真實的有效配對數');

  console.log('Test computeIcSeries_ (groups by date, per-day Spearman IC, default min-sample-size gate) passed.');
}

// --- summarizeIcSeries_ ---
{
  const series = [{ ic: 0.1 }, { ic: 0.2 }, { ic: 0.3 }];
  const summary = fv.summarizeIcSeries_(series);
  assert.strictEqual(summary.n, 3);
  assert.ok(approxEqual(summary.meanIc, 0.2), summary.meanIc);
  assert.ok(approxEqual(summary.stdIc, 0.1), summary.stdIc);
  assert.ok(approxEqual(summary.tStat, 0.2 / (0.1 / Math.sqrt(3))), summary.tStat);
  assert.strictEqual(summary.significant, true, '|t|~3.46 >= 2，應該判定為顯著');

  // null 的 ic 要被濾掉，不計入統計。
  const withNulls = fv.summarizeIcSeries_([{ ic: 0.1 }, { ic: null }, { ic: 0.3 }]);
  assert.strictEqual(withNulls.n, 2);
  assert.ok(approxEqual(withNulls.meanIc, 0.2), withNulls.meanIc);

  // 完全沒有有效資料：n=0，其他欄位都是 null，不是 NaN 或拋錯。
  const empty = fv.summarizeIcSeries_([{ ic: null }, { ic: null }]);
  assert.deepStrictEqual(empty, { n: 0, meanIc: null, stdIc: null, tStat: null, significant: null });

  // 只有 1 筆有效資料：平均值算得出來，但標準差/t-stat/顯著性在 n=1 時沒有
  // 統計意義，要是 null，不能硬算。
  const single = fv.summarizeIcSeries_([{ ic: 0.5 }, { ic: null }]);
  assert.strictEqual(single.n, 1);
  assert.strictEqual(single.meanIc, 0.5);
  assert.strictEqual(single.stdIc, null);
  assert.strictEqual(single.tStat, null);
  assert.strictEqual(single.significant, null);

  console.log('Test summarizeIcSeries_ (mean/std/t-stat/significance, null filtering, n<2 edge cases) passed.');
}

// --- splitWalkForwardFolds_ ---
{
  const series = [
    { date: '2026-01-01', ic: 0.1 }, { date: '2026-01-02', ic: 0.2 }, { date: '2026-01-03', ic: 0.3 },
    { date: '2026-01-04', ic: 0.4 }, { date: '2026-01-05', ic: 0.5 }
  ];
  const folds = fv.splitWalkForwardFolds_(series, 2);
  assert.strictEqual(folds.length, 3, '5 筆、每段 2 筆 -> 3 段（最後一段不滿也要保留）');
  assert.strictEqual(folds[0].length, 2);
  assert.strictEqual(folds[1].length, 2);
  assert.strictEqual(folds[2].length, 1, '最後一段只剩 1 筆也要保留，不是被丟棄');
  assert.strictEqual(folds[0][0].date, '2026-01-01');
  assert.strictEqual(folds[2][0].date, '2026-01-05');

  console.log('Test splitWalkForwardFolds_ (chunks into consecutive folds, keeps a short trailing fold) passed.');
}

// --- walkForwardIcReport_ ---
{
  // 4 段，每段平均 IC 都是正的 -> signConsistency 應該是 1（完全一致）。
  function buildSeries(dates, ics) {
    return dates.map(function (d, i) { return { date: d, ic: ics[i] }; });
  }
  const consistentSeries = buildSeries(
    ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'],
    [0.1, 0.2, 0.3, 0.2, 0.1, 0.2, 0.4, 0.3]
  );
  const consistentReport = fv.walkForwardIcReport_(consistentSeries, 2);
  assert.strictEqual(consistentReport.foldCount, 4);
  assert.strictEqual(consistentReport.signConsistency, 1, '每段平均 IC 都是正的，跨區段方向一致性應該是 1');
  assert.ok(approxEqual(consistentReport.overall.meanIc, 0.225), consistentReport.overall.meanIc);

  // 4 段，3 段正、1 段負 -> signConsistency = 3/4 = 0.75。
  const mixedSeries = buildSeries(
    ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'],
    [0.1, 0.2, 0.3, 0.2, -0.1, -0.2, 0.4, 0.3]
  );
  const mixedReport = fv.walkForwardIcReport_(mixedSeries, 2);
  assert.strictEqual(mixedReport.signConsistency, 0.75);

  console.log('Test walkForwardIcReport_ (per-fold summaries, overall summary, cross-fold sign consistency) passed.');
}

console.log('All factorValidation.js tests passed.');
