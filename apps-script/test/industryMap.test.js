const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// IndustryMap.gs 裡「不呼叫 Apps Script 服務」的純函式（detectFieldKey_、validateIndustryMapRows_），
// 用跟其他 test 一樣的手法把 .gs 檔案載進共用的 vm context 直接測。doRefreshIndustryMap_ /
// computeIndustryMapCoverage_ 依賴 UrlFetchApp/PropertiesService/computeLatestDayRows_，
// 不在這裡測，只能在真正的 Apps Script 環境驗證。
// 最小 PropertiesService stub（跟 aiDiagnosis.test.js 同樣手法），給 ensureIndustryMapSyncedToBigQuery_
// 的測試用：用一個 plain object 模擬 Script Properties 的 get/set。
const fakeProps = {};
const PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function (key) { return Object.prototype.hasOwnProperty.call(fakeProps, key) ? fakeProps[key] : null; },
      setProperty: function (key, value) { fakeProps[key] = value; },
      deleteProperty: function (key) { delete fakeProps[key]; }
    };
  }
};
const context = { console: console, PropertiesService: PropertiesService, logRun_: function () {}, CONFIG: { PROP_KEYS: { INDUSTRY_MAP_LAST_REFRESH: 'INDUSTRY_MAP_LAST_REFRESH' } } };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('IndustryMap.gs');

// --- detectFieldKey_: 找到第一個符合關鍵字的欄位 ---
{
  const key = context.detectFieldKey_({ '出表日期': '20260101', '公司代號': '2330', '產業別': '半導體業' }, ['公司代號', '證券代號']);
  assert.strictEqual(key, '公司代號');
  console.log('Test detectFieldKey_ (finds matching column) passed.');
}

// --- detectFieldKey_: 完全找不到符合的欄位時回傳 null，不能猜一個錯的 ---
{
  const key = context.detectFieldKey_({ 'foo': 1, 'bar': 2 }, ['公司代號', '證券代號']);
  assert.strictEqual(key, null);
  console.log('Test detectFieldKey_ (no match -> null, not a guess) passed.');
}

// --- validateIndustryMapRows_: 正常資料沒有問題 ---
{
  const rows = [];
  for (let i = 1000; i < 1600; i++) rows.push({ code: String(i), name: '公司' + i, industry: '電子業' });
  const issues = context.validateIndustryMapRows_(rows);
  assert.strictEqual(issues.length, 0, 'expected no issues, got: ' + Array.prototype.join.call(issues, '; '));
  console.log('Test validateIndustryMapRows_ (healthy data -> no issues) passed.');
}

// --- validateIndustryMapRows_: 筆數太少要抓出來 ---
{
  const issues = context.validateIndustryMapRows_([{ code: '2330', name: '台積電', industry: '半導體業' }]);
  assert.ok(issues.some((s) => s.indexOf('遠低於預期') !== -1));
  console.log('Test validateIndustryMapRows_ (too few rows) passed.');
}

// --- validateIndustryMapRows_: 重複代號、格式錯誤、空白產業別都要各自抓出來 ---
{
  const rows = [];
  for (let i = 1000; i < 1600; i++) rows.push({ code: String(i), name: '公司' + i, industry: '電子業' });
  rows.push({ code: '1000', name: '重複代號的公司', industry: '電子業' }); // 重複
  rows.push({ code: 'ABCD', name: '格式錯誤', industry: '電子業' }); // 不是 4 位數字
  rows.push({ code: '9999', name: '產業別空白', industry: '' }); // 空白產業別
  const issues = context.validateIndustryMapRows_(rows);
  assert.ok(issues.some((s) => s.indexOf('重複的股票代號') !== -1));
  assert.ok(issues.some((s) => s.indexOf('不是 4 位數字') !== -1));
  assert.ok(issues.some((s) => s.indexOf('產業別是空白') !== -1));
  console.log('Test validateIndustryMapRows_ (dup/format/blank all flagged) passed:', issues);
}

// --- translateIndustryCode_: 對照表收錄的代碼要翻成文字（用使用者實測抽查到的兩筆核對過的
//     代碼：1→水泥工業/台泥、2→食品工業/味全） ---
{
  assert.strictEqual(context.translateIndustryCode_('1'), '水泥工業');
  assert.strictEqual(context.translateIndustryCode_('2'), '食品工業');
  assert.strictEqual(context.translateIndustryCode_(24), '半導體業');
  console.log('Test translateIndustryCode_ (known codes translated) passed.');
}

// --- translateIndustryCode_: 對照表沒收錄的代碼要原樣保留，不能亂猜硬翻 ---
{
  assert.strictEqual(context.translateIndustryCode_('999'), '999');
  console.log('Test translateIndustryCode_ (unknown code kept as-is, not guessed) passed.');
}

// --- translateIndustryCode_: 已經是文字的（不是純數字）不去動它 ---
{
  assert.strictEqual(context.translateIndustryCode_('半導體業'), '半導體業');
  console.log('Test translateIndustryCode_ (already text -> unchanged) passed.');
}

// --- findUntranslatedIndustryCodes_: 抓出翻完還是純數字的列 ---
{
  const rows = [
    { code: '1101', industry: '水泥工業' },
    { code: '9999', industry: '999' },
    { code: '9998', industry: '888' }
  ];
  const result = context.findUntranslatedIndustryCodes_(rows);
  assert.strictEqual(result.count, 2);
  assert.ok(result.sample.some((s) => s.indexOf('9999') !== -1 && s.indexOf('999') !== -1));
  console.log('Test findUntranslatedIndustryCodes_ (flags rows still numeric after translation) passed.');
}

// --- pickRandomSample_: 抽出指定筆數，且不超過原始陣列長度 ---
{
  const items = [];
  for (let i = 0; i < 100; i++) items.push(i);
  const sample = context.pickRandomSample_(items, 10);
  assert.strictEqual(sample.length, 10);
  const distinct = new Set(sample);
  assert.strictEqual(distinct.size, 10, '抽出來的 10 筆不應該有重複');
  sample.forEach((v) => assert.ok(v >= 0 && v < 100));
  console.log('Test pickRandomSample_ (10 distinct items from pool of 100) passed.');
}

// --- pickRandomSample_: 陣列筆數比要求的樣本數少時，回傳全部、不報錯 ---
{
  const sample = context.pickRandomSample_([1, 2, 3], 10);
  assert.strictEqual(sample.length, 3);
  console.log('Test pickRandomSample_ (pool smaller than n -> returns all) passed.');
}

// --- ensureIndustryMapSyncedToBigQuery_: 從來沒有存過摘要（第一次用）-> 要觸發重新整理 ---
{
  delete fakeProps['INDUSTRY_MAP_LAST_REFRESH'];
  let called = false;
  context.doRefreshIndustryMap_ = function () { called = true; };
  context.ensureIndustryMapSyncedToBigQuery_();
  assert.strictEqual(called, true, '從來沒同步過應該要自動觸發重新整理');
  console.log('Test ensureIndustryMapSyncedToBigQuery_ (no prior summary -> triggers refresh) passed.');
}

// --- ensureIndustryMapSyncedToBigQuery_: 已經成功同步過 -> 不用重跑（避免每次訓練都重抓） ---
{
  fakeProps['INDUSTRY_MAP_LAST_REFRESH'] = JSON.stringify({ bqSync: { attempted: true, ok: true, rowCount: 1087 } });
  let called = false;
  context.doRefreshIndustryMap_ = function () { called = true; };
  context.ensureIndustryMapSyncedToBigQuery_();
  assert.strictEqual(called, false, '已經成功同步過，不應該再自動重跑一次');
  console.log('Test ensureIndustryMapSyncedToBigQuery_ (already synced ok -> skips) passed.');
}

// --- ensureIndustryMapSyncedToBigQuery_: 上次同步失敗（或從沒設定過 BigQuery）-> 要再試一次 ---
{
  fakeProps['INDUSTRY_MAP_LAST_REFRESH'] = JSON.stringify({ bqSync: { attempted: true, ok: false, error: '尚未設定 BigQuery 專案 ID' } });
  let called = false;
  context.doRefreshIndustryMap_ = function () { called = true; };
  context.ensureIndustryMapSyncedToBigQuery_();
  assert.strictEqual(called, true, '上次同步失敗應該要再自動觸發一次');
  console.log('Test ensureIndustryMapSyncedToBigQuery_ (last sync failed -> retries) passed.');
}

// --- ensureIndustryMapSyncedToBigQuery_: 自動觸發失敗不能整個拋出例外，不能擋住後續訓練 ---
{
  delete fakeProps['INDUSTRY_MAP_LAST_REFRESH'];
  context.doRefreshIndustryMap_ = function () { throw new Error('TWSE 端點暫時性錯誤'); };
  assert.doesNotThrow(function () { context.ensureIndustryMapSyncedToBigQuery_(); },
    '自動檢核失敗不應該讓呼叫端（因子迴歸訓練）也跟著失敗');
  console.log('Test ensureIndustryMapSyncedToBigQuery_ (refresh failure does not propagate) passed.');
}

console.log('All IndustryMap.gs tests passed.');
