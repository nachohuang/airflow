const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// IndustryMap.gs 裡「不呼叫 Apps Script 服務」的純函式（detectFieldKey_、validateIndustryMapRows_），
// 用跟其他 test 一樣的手法把 .gs 檔案載進共用的 vm context 直接測。doRefreshIndustryMap_ /
// computeIndustryMapCoverage_ 依賴 UrlFetchApp/PropertiesService/computeLatestDayRows_，
// 不在這裡測，只能在真正的 Apps Script 環境驗證。
const context = { console: console };
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

console.log('All IndustryMap.gs tests passed.');
