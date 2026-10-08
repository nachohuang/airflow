const assert = require('assert');
const fin = require('../lib/financials');

// --- 1. parseTwseDate_ ---
{
  assert.strictEqual(fin.parseTwseDate_('2026-03-31'), '2026-03-31', '西元年格式');
  assert.strictEqual(fin.parseTwseDate_('115/03/31'), '2026-03-31', '民國年格式（115 -> 2026）');
  assert.strictEqual(fin.parseTwseDate_('2026/03/31'), '2026-03-31', '斜線分隔的西元年格式');
  // 2026-10-08：WebSearch 查到 data.gov.tw 鏡像站「上市公司每月營業收入
  // 彙總表」資料集範例，「出表日期」欄位值是無分隔符的民國年 7 碼字串
  // （例如 "1150111" 代表民國 115 年 01 月 11 日），補上這個格式的處理。
  assert.strictEqual(fin.parseTwseDate_('1150111'), '2026-01-11', '無分隔符的民國年 7 碼格式（yyyMMDD）');
  assert.strictEqual(fin.parseTwseDate_('not a date'), null, '解析不出來要回傳 null，不是硬湊一個日期');
  assert.strictEqual(fin.parseTwseDate_(''), null);
  console.log('Test parseTwseDate_ (Western / ROC calendar with separators / ROC 7-digit no separator / unparseable) passed.');
}

// --- 2. normalizeYearMonth_ ---
{
  assert.strictEqual(fin.normalizeYearMonth_('11503'), '2026-03', '民國年月 6 碼字串');
  assert.strictEqual(fin.normalizeYearMonth_('2026-03'), '2026-03');
  assert.strictEqual(fin.normalizeYearMonth_('garbage'), null);
  console.log('Test normalizeYearMonth_ (ROC 5-digit / ISO yyyy-MM / unparseable) passed.');
}

// --- 3. parseMonthlyRevenueRows_ ---
// 同一份 TWSE 回應裡每一列的欄位結構一致（JSON 陣列本來就是這樣），分成
// 兩個獨立的資料集測試「有官方 YoY 欄位」跟「沒有、要自己算」兩種情況，
// 不要在同一批列裡混用不同欄位結構（detectFieldKey_ 只看第一列的 key，
// 混用不同結構的列不是真實資料會出現的樣子）。
{
  var rawWithYoy = [
    { '公司代號': '1101', '公司名稱': '台泥', '出表日期': '1150411', '資料年月': '11503', '當月營收': '1,000,000', '去年同月增減(%)': '12.5' },
    { '公司代號': 'XX', '公司名稱': '代號不合法', '出表日期': '1150411', '資料年月': '11503', '當月營收': '1', '去年同月增減(%)': '0' } // 代號不是 4 碼，要被濾掉
  ];
  var parsed = fin.parseMonthlyRevenueRows_(rawWithYoy);
  assert.strictEqual(parsed.length, 1);
  assert.deepStrictEqual(parsed[0], {
    code: '1101', name: '台泥', period: '2026-03', reportDate: '2026-04-11', reportDateIsEstimated: false,
    revenue: 1000000, revenueYoyPct: 12.5, source: 'openapi'
  });

  var rawWithoutYoy = [
    { '公司代號': '1102', '公司名稱': '亞泥', '資料年月': '11503', '當月營收': '500,000', '去年當月營收': '400,000' } // 沒有「出表日期」欄位
  ];
  var parsed2 = fin.parseMonthlyRevenueRows_(rawWithoutYoy);
  assert.ok(Math.abs(parsed2[0].revenueYoyPct - 25) < 1e-9, '沒有官方 YoY 欄位時要自己用當月/去年當月營收算出 25%');
  assert.strictEqual(parsed2[0].reportDateIsEstimated, true, '沒有「出表日期」欄位時要標記這是估計值');
  assert.strictEqual(parsed2[0].reportDate, fin.estimateMonthlyRevenueReportDate_('2026-03'), '退回「月底+10天」估算');
  assert.strictEqual(parsed2[0].source, 'openapi', '跟 lib/mopsRevenueHtml.js 回補來源的 source 欄位對應，這支一律是 openapi');
  console.log('Test parseMonthlyRevenueRows_ (uses official YoY column, falls back to computing it, filters invalid codes) passed.');
}

{
  assert.throws(function () { fin.parseMonthlyRevenueRows_([]); }, /回傳是空的/);
  assert.throws(function () {
    fin.parseMonthlyRevenueRows_([{ '完全無關欄位': 'x' }]);
  }, /找不到代號／資料年月／當月營收欄位/);
  console.log('Test parseMonthlyRevenueRows_ (empty response / missing fields throw clear errors) passed.');
}

// --- 4. parseIncomeStatementRows_ ---
{
  var raw = [
    {
      '公司代號': '1101', '公司名稱': '台泥', '出表日期': '115/05/14',
      '營業收入': '10,000,000', '營業毛利（毛損）': '3,000,000',
      '營業利益（損失）': '1,500,000', '本期淨利（淨損）': '1,000,000'
    },
    { '公司代號': '1102', '公司名稱': '亞泥', '出表日期': '2026-05-14', '營業收入': '0' } // 營收是 0，毛利率等算不出來
  ];
  var parsed = fin.parseIncomeStatementRows_(raw);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].period, '2026-05-14', '出表日期要正確解析民國年格式');
  assert.strictEqual(parsed[0].fiscalPeriodIsEstimated, true, '沒有年度/季別欄位時要標記這是估計值');
  assert.ok(/^\d{4}-Q[1-4]$/.test(parsed[0].fiscalPeriod), '沒有官方欄位時要退而求其次用公告日反推估計所屬季度');
  assert.strictEqual(parsed[0].grossMarginPct, 30, '3,000,000 / 10,000,000 * 100 = 30');
  assert.strictEqual(parsed[0].operatingMarginPct, 15);
  assert.strictEqual(parsed[0].netMarginPct, 10);
  assert.strictEqual(parsed[1].grossMarginPct, null, '營收是 0 時毛利率算不出來，要是 null 不是除以零的 Infinity/NaN');
  console.log('Test parseIncomeStatementRows_ (computes margins, uses 出表日期 not period-end, handles zero revenue) passed.');
}

// --- 4b. parseIncomeStatementRows_：有官方「年度」／「季別」欄位時優先用官方值，不用估計 ---
{
  var rawWithFiscalFields = [
    {
      '公司代號': '1101', '公司名稱': '台泥', '出表日期': '115/05/14', '年度': '115', '季別': '1',
      '營業收入': '10,000,000', '營業毛利（毛損）': '3,000,000', '營業利益（損失）': '1,500,000', '本期淨利（淨損）': '1,000,000'
    }
  ];
  var parsed = fin.parseIncomeStatementRows_(rawWithFiscalFields);
  assert.strictEqual(parsed[0].fiscalPeriodIsEstimated, false);
  assert.strictEqual(parsed[0].fiscalPeriod, '2026-Q1', '民國 115 年第 1 季 -> 西元 2026-Q1，不是用公告日反推的估計值');
  console.log('Test parseIncomeStatementRows_ (uses official 年度/季別 fields when present, not the report-date estimate) passed.');
}

// --- 4c. estimateFiscalQuarterFromReportDate_ ---
{
  // 公告日往前推 60 天落在哪一季，就當作那一季的財報——5/14 往前推 60 天約是 3/15，屬於 Q1。
  assert.strictEqual(fin.estimateFiscalQuarterFromReportDate_('2026-05-14'), '2026-Q1');
  assert.strictEqual(fin.estimateFiscalQuarterFromReportDate_(null), null);
  console.log('Test estimateFiscalQuarterFromReportDate_ (infers fiscal quarter from report date minus typical lag) passed.');
}

// --- 4d. estimateMonthlyRevenueReportDate_ ---
{
  assert.strictEqual(fin.estimateMonthlyRevenueReportDate_('2026-03'), '2026-04-10', '3 月最後一天 3/31 + 10 天 = 4/10');
  assert.strictEqual(fin.estimateMonthlyRevenueReportDate_('2026-02'), '2026-03-10', '跨月份邊界（2 月只有 28 天）也要算對');
  console.log('Test estimateMonthlyRevenueReportDate_ (month-end + 10-day legal disclosure deadline estimate) passed.');
}

// --- 5. parseBalanceSheetRows_ ---
{
  var raw = [{ '公司代號': '1101', '出表日期': '115/05/14', '權益總計': '20,000,000' }];
  var parsed = fin.parseBalanceSheetRows_(raw);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].equity, 20000000);
  assert.strictEqual(parsed[0].period, '2026-05-14');
  console.log('Test parseBalanceSheetRows_ passed.');
}

// --- 6. joinIncomeAndEquity_ ---
{
  var incomeRows = [
    { code: '1101', period: '2026-05-14', netIncome: 1000000, grossMarginPct: 30, operatingMarginPct: 15, netMarginPct: 10 },
    { code: '1102', period: '2026-05-14', netIncome: 500000, grossMarginPct: 20, operatingMarginPct: 10, netMarginPct: 5 } // 沒有對應的資產負債表資料
  ];
  var balanceRows = [{ code: '1101', period: '2026-05-14', equity: 20000000 }];
  var joined = fin.joinIncomeAndEquity_(incomeRows, balanceRows);
  assert.strictEqual(joined.length, 2);
  assert.strictEqual(joined[0].roePct, 5, '1,000,000 / 20,000,000 * 100 = 5');
  assert.strictEqual(joined[1].roePct, null, '對不到資產負債表資料的那筆，roePct 要是 null，不是拋錯整批放棄');
  console.log('Test joinIncomeAndEquity_ (computes ROE, null when balance sheet row missing) passed.');
}

// --- 7. validateFinancialRows_ ---
{
  var rows = [];
  for (var i = 0; i < 600; i++) rows.push({ code: String(1000 + i) });
  assert.deepStrictEqual(fin.validateFinancialRows_(rows, '月營收', 500), []);
  assert.ok(fin.validateFinancialRows_(rows.slice(0, 10), '月營收', 500).length > 0);
  console.log('Test validateFinancialRows_ (too few rows flagged) passed.');
}

// --- 8. computeIncreaseStreak_ ---
{
  assert.deepStrictEqual(fin.computeIncreaseStreak_([10, 12, 15, 14, 16]), [0, 1, 2, 0, 1]);
  assert.deepStrictEqual(fin.computeIncreaseStreak_([10, null, 15]), [0, null, 0], '中間缺一期資料要歸零，不能被當成沒中斷繼續延續');
  assert.deepStrictEqual(fin.computeIncreaseStreak_([]), []);
  console.log('Test computeIncreaseStreak_ (accumulates on strict increase, resets on flat/decrease/missing data) passed.');
}

// --- 9. computeFundamentalStreaks_ ---
{
  var byCode = [
    [
      { code: '1101', period: '2026-02-14', grossMarginPct: 20, operatingMarginPct: 10, netMarginPct: 5, roePct: 2 },
      { code: '1101', period: '2026-05-14', grossMarginPct: 25, operatingMarginPct: 12, netMarginPct: 6, roePct: 3 },
      { code: '1101', period: '2026-08-14', grossMarginPct: 30, operatingMarginPct: 14, netMarginPct: 7, roePct: 4 }
    ]
  ];
  var result = fin.computeFundamentalStreaks_(byCode);
  assert.strictEqual(result.length, 3);
  assert.deepStrictEqual(result.map(function (r) { return r.grossMarginStreak; }), [0, 1, 2]);
  assert.deepStrictEqual(result.map(function (r) { return r.roeStreak; }), [0, 1, 2]);
  console.log('Test computeFundamentalStreaks_ (四率四升: all four streaks computed per company time series) passed.');
}

// --- 10. computeRevenueGrowthStreaks_ ---
{
  var byCode = [
    [
      { code: '1101', period: '2026-01', revenueYoyPct: 5 },
      { code: '1101', period: '2026-02', revenueYoyPct: -2 },
      { code: '1101', period: '2026-03', revenueYoyPct: 3 },
      { code: '1101', period: '2026-04', revenueYoyPct: 8 }
    ]
  ];
  var result = fin.computeRevenueGrowthStreaks_(byCode);
  assert.deepStrictEqual(result.map(function (r) { return r.revenueGrowthStreak; }), [1, 0, 1, 2]);
  console.log('Test computeRevenueGrowthStreaks_ (consecutive months of positive YoY revenue growth) passed.');
}
