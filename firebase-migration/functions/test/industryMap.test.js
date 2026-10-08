const assert = require('assert');
const im = require('../lib/industryMap');

// --- 1. translateIndustryCode_ ---
{
  assert.strictEqual(im.translateIndustryCode_('1'), '水泥工業');
  assert.strictEqual(im.translateIndustryCode_('24'), '半導體業');
  assert.strictEqual(im.translateIndustryCode_('999'), '999', '表裡沒有的代碼要原樣保留，不能亂猜');
  assert.strictEqual(im.translateIndustryCode_(''), '');
  console.log('Test translateIndustryCode_ (known code / unknown code kept as-is / blank) passed.');
}

// --- 2. detectFieldKey_ ---
{
  var row = { '公司代號': '1101', '公司簡稱': '台泥', '產業別': '1' };
  assert.strictEqual(im.detectFieldKey_(row, ['公司代號', '證券代號']), '公司代號');
  assert.strictEqual(im.detectFieldKey_(row, ['所屬產業', '產業別']), '產業別', '第一個關鍵字找不到要繼續試下一個');
  assert.strictEqual(im.detectFieldKey_(row, ['完全不存在']), null);
  console.log('Test detectFieldKey_ (matches by keyword, falls through, null when none match) passed.');
}

// --- 3. parseTwseIndustryMapRows_ ---
{
  var raw = [
    { '公司代號': '1101', '公司簡稱': '台泥', '產業別': '1' },
    { '公司代號': '2330', '公司簡稱': '台積電', '產業別': '24' },
    { '公司代號': '00001T', '公司簡稱': '5碼以上代號', '產業別': '1' }, // zfill4 只補不截斷，補完還是超過 4 碼，要被濾掉
    { '公司代號': '9999', '公司簡稱': '產業別空白', '產業別': '' } // 產業別空白，要被濾掉
  ];
  var parsed = im.parseTwseIndustryMapRows_(raw);
  assert.strictEqual(parsed.length, 2);
  assert.deepStrictEqual(parsed[0], { code: '1101', name: '台泥', industry: '水泥工業', market: '上市' });
  assert.strictEqual(parsed[1].industry, '半導體業');
  console.log('Test parseTwseIndustryMapRows_ (detects fields, translates codes, filters codes over 4 chars / blank industry) passed.');
}

{
  assert.throws(function () { im.parseTwseIndustryMapRows_([]); }, /回傳是空的/);
  assert.throws(function () {
    im.parseTwseIndustryMapRows_([{ '完全無關欄位': 'x' }]);
  }, /找不到代號或產業別欄位/);
  console.log('Test parseTwseIndustryMapRows_ (empty response / missing fields both throw clear errors) passed.');
}

// --- 4. validateIndustryMapRows_ ---
{
  function makeRows(n) {
    var rows = [];
    for (var i = 0; i < n; i++) rows.push({ code: String(1000 + i), industry: '水泥工業' });
    return rows;
  }
  assert.deepStrictEqual(im.validateIndustryMapRows_(makeRows(600)), []);
  assert.ok(im.validateIndustryMapRows_(makeRows(10)).length > 0, '筆數太少要回報問題');
  assert.ok(im.validateIndustryMapRows_(null).length > 0, 'null 要回報問題，不是直接炸掉');

  var dupRows = makeRows(600);
  dupRows[1].code = dupRows[0].code;
  var dupIssues = im.validateIndustryMapRows_(dupRows);
  assert.ok(dupIssues.some(function (s) { return s.indexOf('重複') !== -1; }));

  var badCodeRows = makeRows(600);
  badCodeRows[0].code = 'AB';
  var badCodeIssues = im.validateIndustryMapRows_(badCodeRows);
  assert.ok(badCodeIssues.some(function (s) { return s.indexOf('4 位數字') !== -1; }));

  var blankIndustryRows = makeRows(600);
  blankIndustryRows[0].industry = '';
  var blankIssues = im.validateIndustryMapRows_(blankIndustryRows);
  assert.ok(blankIssues.some(function (s) { return s.indexOf('空白') !== -1; }));

  console.log('Test validateIndustryMapRows_ (too few / duplicate codes / bad code format / blank industry) passed.');
}

// --- 5. findUntranslatedIndustryCodes_ ---
{
  var rows = [
    { code: '1101', industry: '水泥工業' },
    { code: '9999', industry: '123' }, // 翻完還是純數字，表裡沒有的代碼
    { code: '8888', industry: '45' }
  ];
  var result = im.findUntranslatedIndustryCodes_(rows);
  assert.strictEqual(result.count, 2);
  assert.ok(result.sample[0].indexOf('9999') !== -1);
  console.log('Test findUntranslatedIndustryCodes_ (flags rows whose industry is still a raw numeric code) passed.');
}

// --- 6. computeIndustryMapCoverage_ ---
{
  var mapRows = [{ code: '1101' }, { code: '2330' }];
  var noTracked = im.computeIndustryMapCoverage_(mapRows, []);
  assert.strictEqual(noTracked.checked, false);

  var result = im.computeIndustryMapCoverage_(mapRows, ['1101', '2330', '3000']);
  assert.strictEqual(result.checked, true);
  assert.strictEqual(result.matchedCount, 2);
  assert.strictEqual(result.trackedCount, 3);
  assert.strictEqual(result.coveragePct, 66.7);
  assert.deepStrictEqual(result.unmatchedSample, ['3000']);
  console.log('Test computeIndustryMapCoverage_ (no tracked codes -> unchecked; matches / coverage % / unmatched sample) passed.');
}

// --- 7. pickRandomSample_ ---
{
  var items = [1, 2, 3, 4, 5];
  var sample = im.pickRandomSample_(items, 3);
  assert.strictEqual(sample.length, 3);
  assert.deepStrictEqual(items, [1, 2, 3, 4, 5], '不能改動原陣列');
  sample.forEach(function (v) { assert.ok(items.indexOf(v) !== -1); });
  assert.strictEqual(im.pickRandomSample_([1, 2], 10).length, 2, '要求數量超過陣列長度時，最多回傳陣列長度');
  console.log('Test pickRandomSample_ (correct size, original array untouched, caps at array length) passed.');
}
