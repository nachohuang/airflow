const assert = require('assert');
const {
  parseCsvLine_,
  cleanStockCode_,
  toTwseDateParam_,
  parseT86Rows_,
  parseMiIndexRows_,
  parseBwibbuRows_,
  mergeDayRows_
} = require('../lib/twseFetch');

// --- 1. parseCsvLine_：支援雙引號包住含逗號的欄位、"" 轉義 ---
{
  assert.deepStrictEqual(parseCsvLine_('a,b,c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(parseCsvLine_('"a,b",c'), ['a,b', 'c']);
  assert.deepStrictEqual(parseCsvLine_('"he said ""hi""",c'), ['he said "hi"', 'c']);
  assert.deepStrictEqual(parseCsvLine_(''), []);
  assert.deepStrictEqual(parseCsvLine_('   '), []);
  console.log('Test 1 (parseCsvLine_ handles quoted fields and escaped quotes) passed.');
}

// --- 2. cleanStockCode_：去掉 ="..." 包裝，正規化代號 ---
{
  assert.strictEqual(cleanStockCode_('="2330"'), '2330');
  assert.strictEqual(cleanStockCode_('  2330  '), '2330');
  assert.strictEqual(cleanStockCode_(''), '');
  assert.strictEqual(cleanStockCode_(null), '');
  console.log('Test 2 (cleanStockCode_ strips the ="..." wrapper and normalizes) passed.');
}

// --- 3. toTwseDateParam_ ---
{
  assert.strictEqual(toTwseDateParam_('2026-10-07'), '20261007');
  console.log('Test 3 (toTwseDateParam_ strips dashes) passed.');
}

// --- 4. parseT86Rows_：跳過標題上方說明列，自營商自行買賣+避險要加總 ---
{
  const banner = '113年10月07日 三大法人買賣超日報';
  const header = '證券代號,證券名稱,外陸資買賣超股數(不含外資自營商),投信買賣超股數,自營商買賣超股數(自行買賣),自營商買賣超股數(避險),三大法人買賣超股數';
  const rows = [
    '1101,台泥,1000,200,50,10,1260',
    '1102,亞泥,2000,300,60,20,2380',
    '2330,台積電,50000,10000,2000,500,62500',
    '2317,鴻海,30000,5000,1000,200,36200',
    '2454,聯發科,15000,3000,500,100,18600',
    '3008,大立光,8000,1000,200,50,9250'
  ];
  const text = [banner, header].concat(rows).join('\n');
  const parsed = parseT86Rows_(text);
  assert.strictEqual(parsed.length, 6);
  const t1101 = parsed.find(function (r) { return r.證券代號 === '1101'; });
  assert.strictEqual(t1101.證券名稱, '台泥');
  assert.strictEqual(t1101.外資, 1000);
  assert.strictEqual(t1101.投信, 200);
  assert.strictEqual(t1101.自營商, 60, '自行買賣(50) + 避險(10) 要加總');
  assert.strictEqual(t1101.三大法人買賣超股數, 1260);
  console.log('Test 4 (parseT86Rows_ parses rows and sums dealer self+hedge) passed.');
}

{
  // 資料列不足 5 筆要拋錯
  const header = '證券代號,證券名稱,外陸資買賣超股數(不含外資自營商),投信買賣超股數,自營商買賣超股數(自行買賣),自營商買賣超股數(避險),三大法人買賣超股數';
  assert.throws(function () { parseT86Rows_('banner\n' + header + '\n1101,台泥,1,1,1,1,1'); });
  console.log('Test 4b (parseT86Rows_ throws when too few rows) passed.');
}

// --- 5. parseMiIndexRows_：要先找到「每日收盤行情(全部)」區塊再找標題列 ---
{
  const header = '證券代號,證券名稱,成交股數,成交筆數,成交金額,開盤價,最高價,最低價,收盤價,漲跌(+/-),漲跌價差,最後揭示買價,最後揭示買量,最後揭示賣價,最後揭示賣量,本益比';
  const rows = [
    '1101,台泥,5000000,1200,180000000,36.00,36.50,35.80,36.20,+,0.20,36.15,10,36.25,8,15.21',
    '1102,亞泥,3000000,800,90000000,30.00,30.40,29.90,30.10,+,0.10,30.05,5,30.15,6,13.51',
    '2330,台積電,30000000,15000,25000000000,830.00,835.00,825.00,833.00,+,3.00,832.00,20,834.00,15,22.11',
    '2317,鴻海,20000000,9000,2400000000,120.00,121.50,119.50,121.00,+,1.00,120.90,30,121.10,25,11.31',
    '2454,聯發科,8000000,6000,8800000000,1100.00,1110.00,1090.00,1105.00,-,5.00,1104.00,5,1106.00,4,18.90'
  ];
  const text = [
    '113年10月07日 大盤統計資訊',
    '',
    '每日收盤行情(全部)',
    header
  ].concat(rows).join('\n');
  const parsed = parseMiIndexRows_(text);
  assert.strictEqual(parsed.length, 5);
  const m1101 = parsed.find(function (r) { return r.證券代號 === '1101'; });
  assert.strictEqual(m1101.收盤價, 36.2);
  assert.strictEqual(m1101['漲跌(+/-)'], '+');
  assert.strictEqual(m1101.本益比, 15.21);
  console.log('Test 5 (parseMiIndexRows_ locates the block and parses price fields) passed.');
}

{
  assert.throws(function () { parseMiIndexRows_('完全沒有關鍵字的內容\n另一行'); });
  console.log('Test 5b (parseMiIndexRows_ throws when the block marker is missing) passed.');
}

// --- 6. parseBwibbuRows_：殖利率/本益比/股價淨值比 ---
{
  const header = '證券代號,證券名稱,殖利率(%),股利年度,本益比,股價淨值比,財報年/季';
  const rows = [
    '1101,台泥,4.50,112,15.20,1.10,112/Q2',
    '1102,亞泥,3.80,112,13.50,1.05,112/Q2',
    '2330,台積電,1.80,112,22.10,6.50,112/Q2',
    '2317,鴻海,3.20,112,11.30,1.80,112/Q2'
  ];
  const text = [header].concat(rows).join('\n');
  const parsed = parseBwibbuRows_(text);
  assert.strictEqual(parsed.length, 4);
  const b1101 = parsed.find(function (r) { return r.證券代號 === '1101'; });
  assert.strictEqual(b1101['殖利率(%)'], 4.5);
  assert.strictEqual(b1101.本益比, 15.2);
  assert.strictEqual(b1101.股價淨值比, 1.1);
  assert.strictEqual(b1101['財報年/季'], '112/Q2');
  console.log('Test 6 (parseBwibbuRows_ parses yield/PE/PB fields) passed.');
}

// --- 7. mergeDayRows_：T86 inner join MI，BWIBBU left join（缺值補 0/空字串，
//    本益比缺值退回 MI 的本益比），3008 只在 T86 沒在 MI，整檔被排除 ---
{
  const t86 = [
    { 證券代號: '1101', 證券名稱: '台泥', 外資: 1000, 投信: 200, 自營商: 60, 三大法人買賣超股數: 1260 },
    { 證券代號: '1102', 證券名稱: '亞泥', 外資: 2000, 投信: 300, 自營商: 80, 三大法人買賣超股數: 2380 },
    { 證券代號: '2330', 證券名稱: '台積電', 外資: 50000, 投信: 10000, 自營商: 2500, 三大法人買賣超股數: 62500 },
    { 證券代號: '2317', 證券名稱: '鴻海', 外資: 30000, 投信: 5000, 自營商: 1200, 三大法人買賣超股數: 36200 },
    { 證券代號: '2454', 證券名稱: '聯發科', 外資: 15000, 投信: 3000, 自營商: 600, 三大法人買賣超股數: 18600 },
    { 證券代號: '3008', 證券名稱: '大立光', 外資: 8000, 投信: 1000, 自營商: 250, 三大法人買賣超股數: 9250 }
  ];
  const mi = [
    { 證券代號: '1101', 證券名稱: '台泥', 收盤價: 36.2, 本益比: 15.21, 成交股數: 5000000, 成交筆數: 1200, 成交金額: 180000000, 開盤價: 36, 最高價: 36.5, 最低價: 35.8, '漲跌(+/-)': '+', 漲跌價差: 0.2, 最後揭示買價: 36.15, 最後揭示買量: 10, 最後揭示賣價: 36.25, 最後揭示賣量: 8 },
    { 證券代號: '1102', 證券名稱: '亞泥', 收盤價: 30.1, 本益比: 13.51, 成交股數: 3000000, 成交筆數: 800, 成交金額: 90000000, 開盤價: 30, 最高價: 30.4, 最低價: 29.9, '漲跌(+/-)': '+', 漲跌價差: 0.1, 最後揭示買價: 30.05, 最後揭示買量: 5, 最後揭示賣價: 30.15, 最後揭示賣量: 6 },
    { 證券代號: '2330', 證券名稱: '台積電', 收盤價: 833, 本益比: 22.11, 成交股數: 30000000, 成交筆數: 15000, 成交金額: 25000000000, 開盤價: 830, 最高價: 835, 最低價: 825, '漲跌(+/-)': '+', 漲跌價差: 3, 最後揭示買價: 832, 最後揭示買量: 20, 最後揭示賣價: 834, 最後揭示賣量: 15 },
    { 證券代號: '2317', 證券名稱: '鴻海', 收盤價: 121, 本益比: 11.31, 成交股數: 20000000, 成交筆數: 9000, 成交金額: 2400000000, 開盤價: 120, 最高價: 121.5, 最低價: 119.5, '漲跌(+/-)': '+', 漲跌價差: 1, 最後揭示買價: 120.9, 最後揭示買量: 30, 最後揭示賣價: 121.1, 最後揭示賣量: 25 },
    { 證券代號: '2454', 證券名稱: '聯發科', 收盤價: 1105, 本益比: 18.9, 成交股數: 8000000, 成交筆數: 6000, 成交金額: 8800000000, 開盤價: 1100, 最高價: 1110, 最低價: 1090, '漲跌(+/-)': '-', 漲跌價差: 5, 最後揭示買價: 1104, 最後揭示買量: 5, 最後揭示賣價: 1106, 最後揭示賣量: 4 }
    // 3008 刻意不在 MI_INDEX 裡 -> T86 的 3008 inner join 後應該被排除
  ];
  const bw = [
    { 證券代號: '1101', '殖利率(%)': 4.5, 本益比: 15.2, 股價淨值比: 1.1, '財報年/季': '112/Q2' },
    { 證券代號: '1102', '殖利率(%)': 3.8, 本益比: 13.5, 股價淨值比: 1.05, '財報年/季': '112/Q2' },
    { 證券代號: '2330', '殖利率(%)': 1.8, 本益比: 22.1, 股價淨值比: 6.5, '財報年/季': '112/Q2' },
    { 證券代號: '2317', '殖利率(%)': 3.2, 本益比: 11.3, 股價淨值比: 1.8, '財報年/季': '112/Q2' }
    // 2454 刻意不在 BWIBBU 裡 -> 應該用預設值 0/'' 補，本益比退回 MI 的 18.9
  ];

  const merged = mergeDayRows_(t86, mi, bw, '2026-10-07');
  assert.strictEqual(merged.length, 5, '3008 沒出現在 MI_INDEX，inner join 後應該被排除');
  assert.ok(!merged.some(function (r) { return r.證券代號 === '3008'; }));

  merged.forEach(function (r) { assert.strictEqual(r.日期, '2026-10-07'); });

  const m1101 = merged.find(function (r) { return r.證券代號 === '1101'; });
  assert.strictEqual(m1101.外資, 1000, '法人欄位來自 T86');
  assert.strictEqual(m1101.收盤價, 36.2, '價量欄位來自 MI_INDEX');
  assert.strictEqual(m1101.本益比, 15.2, 'BWIBBU 有資料時優先用 BWIBBU 的本益比，不是 MI 的 15.21');
  assert.strictEqual(m1101['殖利率(%)'], 4.5);

  const m2454 = merged.find(function (r) { return r.證券代號 === '2454'; });
  assert.strictEqual(m2454['殖利率(%)'], 0, 'BWIBBU 缺值時殖利率補 0');
  assert.strictEqual(m2454.股價淨值比, 0, 'BWIBBU 缺值時股價淨值比補 0');
  assert.strictEqual(m2454['財報年/季'], '', 'BWIBBU 缺值時財報年/季補空字串');
  assert.strictEqual(m2454.本益比, 18.9, 'BWIBBU 缺值時本益比退回 MI_INDEX 的本益比');

  console.log('Test 7 (mergeDayRows_ inner-joins T86+MI, left-joins BWIBBU with correct fallbacks) passed.');
}

{
  // T86/MI 完全沒有交集時要拋錯（不是回傳空陣列悄悄過關）
  const t86 = [{ 證券代號: '9999', 證券名稱: 'X', 外資: 0, 投信: 0, 自營商: 0, 三大法人買賣超股數: 0 }];
  const mi = [{ 證券代號: '8888', 證券名稱: 'Y', 收盤價: 1 }];
  assert.throws(function () { mergeDayRows_(t86, mi, [], '2026-10-07'); });
  console.log('Test 7b (mergeDayRows_ throws when T86/MI have no overlap) passed.');
}

console.log('All twseFetch.js tests passed.');
