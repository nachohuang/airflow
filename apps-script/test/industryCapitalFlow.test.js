const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// IndustryCapitalFlow.gs 裡「不呼叫 Apps Script 服務」的純函式（aggregateIndustryCapitalFlow_），
// 用跟其他 test 一樣的手法把 .gs 檔案載進共用的 vm context 直接測。getIndustryCapitalFlowSnapshot
// 依賴 computeLatestDayRows_/Sheets，不在這裡測，只能在真正的 Apps Script 環境驗證。
const context = { console: console, zfill4: function (code) { return String(code).padStart(4, '0'); } };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('IndustryCapitalFlow.gs');

// --- 基本分組加總：同產業的股票要合併，依合計淨買超由大到小排序 ---
{
  const scanRows = [
    { '證券代號': '1101', Inst_Net: 1000 },
    { '證券代號': '1102', Inst_Net: 500 },
    { '證券代號': '2330', Inst_Net: 3000 },
    { '證券代號': '2454', Inst_Net: -1000 }
  ];
  const codeToIndustry = { '1101': '水泥工業', '1102': '水泥工業', '2330': '半導體業', '2454': '半導體業' };
  const result = context.aggregateIndustryCapitalFlow_(scanRows, codeToIndustry);

  assert.strictEqual(result.unclassifiedCount, 0);
  assert.strictEqual(result.industries.length, 2);
  // 半導體業合計 3000 + (-1000) = 2000，水泥工業合計 1000 + 500 = 1500，半導體業應該排第一
  assert.strictEqual(result.industries[0].industry, '半導體業');
  assert.strictEqual(result.industries[0].sumInstNet, 2000);
  assert.strictEqual(result.industries[0].stockCount, 2);
  assert.strictEqual(result.industries[0].avgInstNet, 1000);
  assert.strictEqual(result.industries[1].industry, '水泥工業');
  assert.strictEqual(result.industries[1].sumInstNet, 1500);
  console.log('Test aggregateIndustryCapitalFlow_ (groups by industry, sorted by net desc) passed.');
}

// --- 查不到產業別的股票要計入 unclassifiedCount，不能硬塞進某個產業 ---
{
  const scanRows = [
    { '證券代號': '1101', Inst_Net: 1000 },
    { '證券代號': '0050', Inst_Net: 5000 } // ETF，查不到產業別
  ];
  const codeToIndustry = { '1101': '水泥工業' };
  const result = context.aggregateIndustryCapitalFlow_(scanRows, codeToIndustry);

  assert.strictEqual(result.unclassifiedCount, 1);
  assert.strictEqual(result.industries.length, 1);
  assert.strictEqual(result.industries[0].sumInstNet, 1000, 'ETF 的 5000 不應該被算進任何產業的合計裡');
  console.log('Test aggregateIndustryCapitalFlow_ (unmapped codes excluded, not force-assigned) passed.');
}

// --- Inst_Net 缺值（null/undefined）當 0 處理，不會讓整組變成 NaN ---
{
  const scanRows = [
    { '證券代號': '1101', Inst_Net: 1000 },
    { '證券代號': '1102', Inst_Net: null },
    { '證券代號': '1103' } // 完全沒有 Inst_Net 欄位
  ];
  const codeToIndustry = { '1101': '水泥工業', '1102': '水泥工業', '1103': '水泥工業' };
  const result = context.aggregateIndustryCapitalFlow_(scanRows, codeToIndustry);

  assert.strictEqual(result.industries[0].sumInstNet, 1000);
  assert.ok(!Number.isNaN(result.industries[0].sumInstNet));
  console.log('Test aggregateIndustryCapitalFlow_ (missing Inst_Net treated as 0, no NaN) passed.');
}

// --- 空陣列輸入不報錯，回傳空結果 ---
{
  const result = context.aggregateIndustryCapitalFlow_([], {});
  assert.strictEqual(result.industries.length, 0);
  assert.strictEqual(result.unclassifiedCount, 0);
  console.log('Test aggregateIndustryCapitalFlow_ (empty input -> empty result) passed.');
}

console.log('All IndustryCapitalFlow.gs tests passed.');
