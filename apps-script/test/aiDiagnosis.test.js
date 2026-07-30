const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// 最小 PropertiesService stub：只用一個 plain object 模擬 Script Properties 的 get/set，
// 讓 getPricingSettings()/setPricingSettings()/calcCost_ 可以在 Node 裡直接測試。
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

const context = { console: console, PropertiesService: PropertiesService, logRun_: function () {} };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('AiDiagnosis.gs');

function approxEqual(a, b, eps) { eps = eps || 1e-9; return Math.abs(a - b) < eps; }

// --- 1. 預設單價下的費用計算 ---
{
  const pricing = context.getPricingSettings();
  assert.strictEqual(pricing.claudeInputPerM, context.CONFIG.CLAUDE_PRICE_INPUT_PER_M_DEFAULT);
  assert.strictEqual(pricing.geminiOutputPerM, context.CONFIG.GEMINI_PRICE_OUTPUT_PER_M_DEFAULT);

  const cost = context.calcCost_('claude', 1000000, 1000000); // 100萬 input + 100萬 output tokens
  const expected = context.CONFIG.CLAUDE_PRICE_INPUT_PER_M_DEFAULT + context.CONFIG.CLAUDE_PRICE_OUTPUT_PER_M_DEFAULT;
  assert.ok(approxEqual(cost, expected), 'got ' + cost + ' expected ' + expected);
  console.log('Test 1 (default pricing calcCost_) passed:', cost);
}

// --- 2. 小額 token 數的費用計算（實際使用情境） ---
{
  const cost = context.calcCost_('gemini', 3000, 800);
  const pricing = context.getPricingSettings();
  const expected = (3000 / 1e6) * pricing.geminiInputPerM + (800 / 1e6) * pricing.geminiOutputPerM;
  assert.ok(approxEqual(cost, expected));
  console.log('Test 2 (small-call gemini cost) passed:', cost);
}

// --- 3. setPricingSettings 後 calcCost_ 要反映新單價 ---
{
  context.setPricingSettings(1, 5, 0.1, 0.4);
  const pricing = context.getPricingSettings();
  assert.strictEqual(pricing.claudeInputPerM, 1);
  assert.strictEqual(pricing.claudeOutputPerM, 5);
  const cost = context.calcCost_('claude', 1000000, 1000000);
  assert.ok(approxEqual(cost, 6));
  console.log('Test 3 (setPricingSettings reflected in calcCost_) passed:', cost);
}

// --- 4. extractVerdict_ 抓取最終建議關鍵字 ---
{
  const text = '一些分析文字...\n> 💡 **最終建議：** 【分批布局】\n> **核心理由：** blah';
  assert.strictEqual(context.extractVerdict_(text), '分批布局');
  assert.strictEqual(context.extractVerdict_('沒有關鍵字的文字'), '未明確');
  console.log('Test 4 (extractVerdict_) passed.');
}

// --- 5. buildTopPicksPrompt_：橫向比較清單要把每檔候選的量化欄位都列進去 ---
{
  const candidates = [
    { '證券代號': '2603', '證券名稱': '長榮', 'Armor_Score': 105.5, '操作策略': '🚀 趨勢啟動', 'Trend_Score': 2, 'Inst_Part_Rank': 0.98, 'IBF_20D_Rank': 0.92, '實相解讀': '法人密度極高' },
    { '證券代號': '2890', '證券名稱': '永豐金', 'Armor_Score': 103.2, '操作策略': '🚀 趨勢啟動', 'Trend_Score': 2, 'Inst_Part_Rank': 0.95, 'IBF_20D_Rank': 0.88, '實相解讀': '多頭慣性確立' }
  ];
  const prompt = context.buildTopPicksPrompt_(candidates, '台股監控 2026-07-31 10:00');
  assert.ok(prompt.indexOf('共 2 檔') !== -1);
  assert.ok(prompt.indexOf('2603 長榮') !== -1);
  assert.ok(prompt.indexOf('Armor_Score=105.5') !== -1);
  assert.ok(prompt.indexOf('2890 永豐金') !== -1);
  assert.ok(prompt.indexOf('台股監控 2026-07-31 10:00') !== -1);
  console.log('Test 5 (buildTopPicksPrompt_) passed.');
}

console.log('All AiDiagnosis.gs tests passed.');
