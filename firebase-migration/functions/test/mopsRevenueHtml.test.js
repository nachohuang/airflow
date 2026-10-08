const assert = require('assert');
const mops = require('../lib/mopsRevenueHtml');

// --- 1. extractHtmlTables_ / stripHtmlToText_ ---
// 照使用者 2026-10-08 實際用手機打開 t21sc03_115_7_0.html 截圖看到的結構
// 模擬：每個產業別一個 <table>，欄位依序是代號/名稱/當月營收/上月營收/
// 去年當月營收/上月比較增減(%)/去年同月增減(%)/當月累計營收/去年累計
// 營收/前期比較增減(%)/備註，表格最後一列是「合計」小計列。
{
  var html = '<html><body>' +
    '<div>出表日期：115/10/08</div>' +
    '<table><tr><td colspan="11">產業別：水泥工業</td></tr>' +
    '<tr><td>公司代號</td><td>公司名稱</td><td>當月營收</td><td>上月營收</td><td>去年當月營收</td>' +
    '<td>上月比較增減(%)</td><td>去年同月增減(%)</td><td>當月累計營收</td><td>去年累計營收</td>' +
    '<td>前期比較增減(%)</td><td>備註</td></tr>' +
    '<tr><td>1101</td><td>台&nbsp;泥</td><td>13,744,103</td><td>13,382,706</td><td>13,535,929</td>' +
    '<td>2.70</td><td>1.53</td><td>85,211,435</td><td>83,916,845</td><td>1.54</td><td>-</td></tr>' +
    '<tr><td>1102</td><td>亞泥</td><td>5,398,231</td><td>5,885,972</td><td>5,836,590</td>' +
    '<td>-8.28</td><td>-7.51</td><td>38,104,679</td><td>41,097,034</td><td>-7.28</td><td>-</td></tr>' +
    '<tr><td>合計</td><td></td><td>20,910,731</td><td>20,799,291</td><td>21,115,445</td>' +
    '<td>0.53</td><td>-0.96</td><td>135,028,647</td><td>138,259,668</td><td>-2.33</td><td></td></tr>' +
    '</table>' +
    '<table><tr><td colspan="11">產業別：食品工業</td></tr>' +
    '<tr><td>公司代號</td><td>公司名稱</td><td>當月營收</td><td>上月營收</td><td>去年當月營收</td>' +
    '<td>上月比較增減(%)</td><td>去年同月增減(%)</td><td>當月累計營收</td><td>去年累計營收</td>' +
    '<td>前期比較增減(%)</td><td>備註</td></tr>' +
    '<tr><td>1216</td><td>統一</td><td>62,168,637</td><td>58,301,112</td><td>57,114,520</td>' +
    '<td>6.63</td><td>8.84</td><td>412,146,627</td><td>395,952,807</td><td>4.08</td><td>-</td></tr>' +
    '</table>' +
    '</body></html>';

  var tables = mops.extractHtmlTables_(html);
  assert.strictEqual(tables.length, 2, '兩個產業別各自一個 table');
  assert.strictEqual(tables[0].length, 5, '水泥工業：產業別標題列 + 欄名列 + 2 家公司 + 合計列');
  assert.strictEqual(tables[0][2][0], '1101');
  assert.strictEqual(tables[0][2][1], '台 泥', '&nbsp; 要還原成空白');
  console.log('Test extractHtmlTables_ (splits multiple <table> blocks into rows of cell text) passed.');
}

// --- 2. isMopsRevenueDataRow_ ---
{
  assert.strictEqual(mops.isMopsRevenueDataRow_(['1101', '台泥', '1', '2', '3']), true);
  assert.strictEqual(mops.isMopsRevenueDataRow_(['合計', '', '1', '2', '3']), false, '合計小計列要濾掉');
  assert.strictEqual(mops.isMopsRevenueDataRow_(['公司代號', '公司名稱', '1', '2', '3']), false, '欄名列要濾掉');
  assert.strictEqual(mops.isMopsRevenueDataRow_(['XX', '代號不合法', '1', '2', '3']), false, '開頭不是數字要濾掉');
  assert.strictEqual(mops.isMopsRevenueDataRow_(['1101', '欄位不足']), false, '少於 5 欄要濾掉');
  console.log('Test isMopsRevenueDataRow_ (filters subtotal/header/malformed rows) passed.');
}

// --- 3. parseMopsNumber_ ---
{
  assert.strictEqual(mops.parseMopsNumber_('13,744,103'), 13744103);
  assert.strictEqual(mops.parseMopsNumber_('-8.28'), -8.28);
  assert.strictEqual(mops.parseMopsNumber_('-'), null, '沒有數字用 "-" 表示，要是 null 不是 NaN');
  assert.strictEqual(mops.parseMopsNumber_(''), null);
  console.log('Test parseMopsNumber_ (thousands separator, negative, placeholder dash) passed.');
}

// --- 4. mopsPeriodToRocYearMonth_ / buildMopsRevenueUrl_ ---
{
  assert.deepStrictEqual(mops.mopsPeriodToRocYearMonth_('2026-07'), { rocYear: 115, month: 7 });
  assert.strictEqual(mops.mopsPeriodToRocYearMonth_('garbage'), null);
  assert.strictEqual(
    mops.buildMopsRevenueUrl_('sii', '2026-07', 0),
    'https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_7_0.html'
  );
  assert.strictEqual(
    mops.buildMopsRevenueUrl_('otc', '2026-07'),
    'https://mopsov.twse.com.tw/nas/t21/otc/t21sc03_115_7_0.html',
    'company_type 預設 0'
  );
  assert.strictEqual(mops.buildMopsRevenueUrl_('sii', 'garbage', 0), null);
  console.log('Test mopsPeriodToRocYearMonth_ / buildMopsRevenueUrl_ (yyyy-MM -> ROC year/month -> URL) passed.');
}

// --- 5. parseMopsRevenueTables_ ---
{
  var tables = [
    [
      ['產業別：水泥工業'],
      ['公司代號', '公司名稱', '當月營收', '上月營收', '去年當月營收', '上月比較增減(%)', '去年同月增減(%)', '當月累計營收', '去年累計營收', '前期比較增減(%)', '備註'],
      ['1101', '台泥', '13,744,103', '13,382,706', '13,535,929', '2.70', '1.53', '85,211,435', '83,916,845', '1.54', '-'],
      ['合計', '', '20,910,731', '20,799,291', '21,115,445', '0.53', '-0.96', '135,028,647', '138,259,668', '-2.33', '']
    ]
  ];
  var parsed = mops.parseMopsRevenueTables_(tables, '2026-07', '2026-08-10');
  assert.strictEqual(parsed.length, 1, '合計/欄名列要被濾掉，只剩 1 家公司');
  assert.deepStrictEqual(parsed[0], {
    code: '1101', name: '台泥', period: '2026-07', reportDate: '2026-08-10', reportDateIsEstimated: true,
    revenue: 13744103, revenueYoyPct: 1.53, source: 'mopsBackfill'
  });
  console.log('Test parseMopsRevenueTables_ (maps columns by position, tags source/estimated reportDate) passed.');
}

// --- 6. enumeratePeriodsInclusive_ ---
{
  assert.deepStrictEqual(mops.enumeratePeriodsInclusive_('2026-01', '2026-03'), ['2026-01', '2026-02', '2026-03']);
  assert.deepStrictEqual(mops.enumeratePeriodsInclusive_('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02'], '跨年份邊界');
  assert.deepStrictEqual(mops.enumeratePeriodsInclusive_('2026-05', '2026-05'), ['2026-05'], '同一個月');
  assert.deepStrictEqual(mops.enumeratePeriodsInclusive_('2026-05', '2026-01'), [], '起始晚於結束要回傳空陣列，不是負數迴圈');
  console.log('Test enumeratePeriodsInclusive_ (inclusive month range, year boundary, empty when reversed) passed.');
}
