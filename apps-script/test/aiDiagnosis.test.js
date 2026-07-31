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
loadIntoContext('Utils.gs');
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

// --- 6. buildShortlistPrompt_：跟 buildTopPicksPrompt_ 一樣列出全部候選的量化欄位，
//    但要多帶入 count，明確要求 AI 篩出這麼多檔候選名單 ---
{
  const candidates = [
    { '證券代號': '2603', '證券名稱': '長榮', 'Armor_Score': 105.5, '操作策略': '🚀 趨勢啟動', 'Trend_Score': 2, 'Inst_Part_Rank': 0.98, 'IBF_20D_Rank': 0.92, '實相解讀': '法人密度極高' },
    { '證券代號': '2890', '證券名稱': '永豐金', 'Armor_Score': 103.2, '操作策略': '🚀 趨勢啟動', 'Trend_Score': 2, 'Inst_Part_Rank': 0.95, 'IBF_20D_Rank': 0.88, '實相解讀': '多頭慣性確立' }
  ];
  const prompt = context.buildShortlistPrompt_(candidates, '台股監控 2026-07-31 10:00', 5);
  assert.ok(prompt.indexOf('共 2 檔') !== -1);
  assert.ok(prompt.indexOf('2603 長榮') !== -1);
  assert.ok(prompt.indexOf('Armor_Score=105.5') !== -1);
  assert.ok(prompt.indexOf('挑出 5 檔') !== -1, '要把候選名單大小帶進 prompt 裡');
  console.log('Test 6 (buildShortlistPrompt_) passed.');
}

// --- 7. extractShortlistCodes_：從 AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE 規定的編號清單格式
//    （「N. 代號 名稱 - 理由」開頭）取出股票代號，供每日排程接著把「全部」名單餵給
//    runAiDiagnosis() 做深度診斷（不是只取其中前幾名） ---
{
  const text = [
    '1. 2603 長榮 - 法人參與密度極高、趨勢一致',
    '2. 2890 永豐金 - 金融股中相對抗跌，分散產業集中度',
    '3. 330 某某 - 動能因子純度高',
    '4. 3661 世芯 - 但與 2 為同族群，列入觀察對照',
    '5. 8112 至上 - 下跌接手率排名居前'
  ].join('\n');

  // vm context 產生的陣列跟外層 Node realm 的 Array 建構子不同（跟本檔案其他測試碰過的
  // cross-realm 問題一樣），deepStrictEqual 對建構子比對很嚴格，用 spread 複製成外層陣列再比對。
  const codes = [...context.extractShortlistCodes_(text)];
  assert.deepStrictEqual(codes, ['2603', '2890', '0330', '3661', '8112'], '要依序取出全部候選名單的代號，不足 4 碼要補零');

  const capped = [...context.extractShortlistCodes_(text, 3)];
  assert.deepStrictEqual(capped, ['2603', '2890', '0330'], 'maxCount 要能限制取出的檔數');

  assert.deepStrictEqual([...context.extractShortlistCodes_('')], [], '空字串要回傳空陣列，不能拋例外');
  assert.deepStrictEqual([...context.extractShortlistCodes_('沒有任何符合格式的內容')], [], '格式不符時要回傳空陣列');
  console.log('Test 7 (extractShortlistCodes_) passed.');
}

console.log('All AiDiagnosis.gs tests passed.');
