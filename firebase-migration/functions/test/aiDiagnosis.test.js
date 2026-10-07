const assert = require('assert');
const {
  buildTwseOfficialFinancialsTextForCode_,
  buildDiagnosisPrompt_,
  extractVerdict_,
  extractCoreReason_,
  calcCost_
} = require('../lib/aiDiagnosis');

// --- 1. buildTwseOfficialFinancialsTextForCode_：篩選出符合代號的列，組成文字 ---
{
  const datasets = [
    { label: '月營收', rows: [
      { '公司代號': '2330', '公司名稱': '台積電', '當月營收': '1000' },
      { '公司代號': '2317', '公司名稱': '鴻海', '當月營收': '2000' }
    ] },
    { label: '綜合損益表', rows: [
      { '公司代號': '2330', '基本每股盈餘': '8.5' }
    ] }
  ];
  const text = buildTwseOfficialFinancialsTextForCode_('2330', datasets);
  assert.ok(text.indexOf('月營收') !== -1, '應該包含有符合代號資料的資料集標籤');
  assert.ok(text.indexOf('台積電') !== -1);
  assert.ok(text.indexOf('綜合損益表') !== -1);
  assert.ok(text.indexOf('8.5') !== -1);
  assert.ok(text.indexOf('鴻海') === -1, '不符合代號的列不應該出現');
  console.log('Test 1a (buildTwseOfficialFinancialsTextForCode_ filters by code) passed.');
}

{
  // 代號在任何資料集都找不到 -> 回傳說明文字，不是空字串
  const text = buildTwseOfficialFinancialsTextForCode_('9999', [
    { label: '月營收', rows: [{ '公司代號': '2330' }] }
  ]);
  assert.ok(text.indexOf('查無') !== -1, '找不到資料時應該回傳說明文字');
  console.log('Test 1b (buildTwseOfficialFinancialsTextForCode_ no-match fallback) passed.');
}

{
  // 超過 4000 字要被截斷
  const longValue = 'x'.repeat(10000);
  const text = buildTwseOfficialFinancialsTextForCode_('2330', [
    { label: '月營收', rows: [{ '公司代號': '2330', '備註': longValue }] }
  ]);
  assert.strictEqual(text.length, 4000, '超過上限要截斷成剛好 4000 字');
  console.log('Test 1c (buildTwseOfficialFinancialsTextForCode_ truncates at 4000 chars) passed.');
}

// --- 2. buildDiagnosisPrompt_：組出來的文字要包含所有欄位標籤跟值 ---
{
  const row = {
    code: '2330', name: '台積電', date: '2026-10-05', armorScore: 87,
    strategy: 'rule_v17', action: '買進', interpretation: '法人連續買超',
    trendScore: 2, instPartRank: 0.91, ibf20dRank: 0.77
  };
  const prompt = buildDiagnosisPrompt_(row, 'goodinfo 摘要內容', 'twse 官方資料內容', '2026-10-05 23:00');
  assert.ok(prompt.indexOf('2026-10-05 23:00') !== -1);
  assert.ok(prompt.indexOf('股票代號：2330') !== -1);
  assert.ok(prompt.indexOf('股票名稱：台積電') !== -1);
  assert.ok(prompt.indexOf('Armor_Score：87') !== -1);
  assert.ok(prompt.indexOf('goodinfo 摘要內容') !== -1);
  assert.ok(prompt.indexOf('twse 官方資料內容') !== -1);
  assert.ok(prompt.indexOf('持有期參考最高價') === -1, '沒給 referenceHigh 時不應該出現這一行');
  console.log('Test 2a (buildDiagnosisPrompt_ assembles all fields) passed.');
}

{
  // referenceHigh 有值才會出現那一行
  const row = {
    code: '2330', name: '台積電', date: '2026-10-05', armorScore: 87,
    strategy: 'rule_v17', action: '買進', interpretation: '法人連續買超',
    trendScore: 2, instPartRank: 0.91, ibf20dRank: 0.77, referenceHigh: 999.5
  };
  const prompt = buildDiagnosisPrompt_(row, '', '', '2026-10-05 23:00');
  assert.ok(prompt.indexOf('持有期參考最高價：999.5') !== -1);
  console.log('Test 2b (buildDiagnosisPrompt_ includes referenceHigh when present) passed.');
}

// --- 3. extractVerdict_：抓出 4 個明確結論之一，抓不到就回「未明確」 ---
{
  assert.strictEqual(extractVerdict_('報告內容...最終建議：【強力買入】...'), '強力買入');
  assert.strictEqual(extractVerdict_('...【分批布局】...'), '分批布局');
  assert.strictEqual(extractVerdict_('...【觀望不追】...'), '觀望不追');
  assert.strictEqual(extractVerdict_('...【立刻退出】...'), '立刻退出');
  assert.strictEqual(extractVerdict_('完全沒有提到結論的文字'), '未明確');
  assert.strictEqual(extractVerdict_(''), '未明確');
  assert.strictEqual(extractVerdict_(undefined), '未明確');
  console.log('Test 3 (extractVerdict_ matches one of the 4 verdicts or falls back) passed.');
}

// --- 4. extractCoreReason_：抓「核心理由：」後面的文字 ---
{
  const text = '> 💡 **最終建議：** 【強力買入】\n> **核心理由：**基本面強勁，法人持續加碼。';
  assert.strictEqual(extractCoreReason_(text), '基本面強勁，法人持續加碼。');
  assert.strictEqual(extractCoreReason_('沒有核心理由這幾個字的文字'), '');
  assert.strictEqual(extractCoreReason_(''), '');
  console.log('Test 4 (extractCoreReason_ extracts the reason line) passed.');
}

// --- 5. calcCost_：provider 選對費率、cache token 倍率正確、沒給 pricing 也不會炸 ---
{
  const pricing = {
    claudeInputPerM: 3, claudeOutputPerM: 15,
    geminiInputPerM: 0.3, geminiOutputPerM: 2.5
  };
  // claude：1,000,000 input + 1,000,000 output -> 3 + 15 = 18
  assert.strictEqual(calcCost_('claude', 1e6, 1e6, null, pricing), 18);
  // gemini：1,000,000 input + 1,000,000 output -> 0.3 + 2.5 = 2.8
  assert.ok(Math.abs(calcCost_('gemini', 1e6, 1e6, null, pricing) - 2.8) < 1e-9);
  // claude + cache：寫入快取 1,000,000 tokens 算 1.25 倍 input 單價，命中快取 1,000,000 tokens 算 0.1 倍
  const withCache = calcCost_('claude', 0, 0, {
    cacheCreationInputTokens: 1e6,
    cacheReadInputTokens: 1e6
  }, pricing);
  assert.ok(Math.abs(withCache - (3 * 1.25 + 3 * 0.1)) < 1e-9);
  // 沒給 pricing / cacheTokens 時應該安全回傳 0，不拋錯
  assert.strictEqual(calcCost_('claude', 0, 0, null, undefined), 0);
  assert.strictEqual(calcCost_('claude', 1000, 1000, undefined, {}), 0);
  console.log('Test 5 (calcCost_ picks the right rate and cache multipliers) passed.');
}

console.log('All aiDiagnosis.js tests passed.');
