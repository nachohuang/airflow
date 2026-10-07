const assert = require('assert');
const {
  AI_DIAGNOSIS_SYSTEM_PROMPT,
  AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT,
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

// --- 2c. buildDiagnosisPrompt_ 帶 holding 參數（持股續抱診斷專用）---
{
  const row = {
    code: '2330', name: '台積電', date: '2026-10-05', armorScore: 87,
    strategy: '🛡️ 持股守護', action: '繼續持有', interpretation: '法人連續買超',
    trendScore: 2, instPartRank: 0.91, ibf20dRank: 0.77
  };
  const holding = { cost: 580.5, buyDate: '2025-01-10', daysHeld: 270, profitPct: 12.34 };
  const prompt = buildDiagnosisPrompt_(row, '', '', '2026-10-05 23:00', holding);
  assert.ok(prompt.indexOf('加權平均成本：580.5') !== -1);
  assert.ok(prompt.indexOf('最早買進日期：2025-01-10（已持有 270 天）') !== -1);
  assert.ok(prompt.indexOf('目前未實現損益：+12.34%') !== -1, '正損益要帶正號');
  assert.ok(prompt.indexOf('續抱評估') !== -1, '帶 holding 時結尾文案要換成續抱評估');
  assert.ok(prompt.indexOf('深度診斷') === -1, '帶 holding 時不該出現深度診斷的結尾文案');
  console.log('Test 2c (buildDiagnosisPrompt_ with holding renders position background + swaps closing line) passed.');
}

// --- 2d. buildDiagnosisPrompt_ 帶 holding 但虧損中（負損益要帶負號，不是雙重負號）---
{
  const row = { code: '2330', name: '台積電', date: '2026-10-05', armorScore: 87, strategy: 's', action: 'a', interpretation: 'i', trendScore: 1, instPartRank: 0.5, ibf20dRank: 0.5 };
  const holding = { cost: 600, buyDate: '2025-01-10', daysHeld: 270, profitPct: -5.5 };
  const prompt = buildDiagnosisPrompt_(row, '', '', '2026-10-05 23:00', holding);
  assert.ok(prompt.indexOf('目前未實現損益：-5.5%') !== -1);
  console.log('Test 2d (buildDiagnosisPrompt_ with holding, negative profitPct) passed.');
}

// --- 3. extractVerdict_：抓出 8 個明確結論之一（深度診斷 4 個 + 持股續抱診斷 4 個），
//    抓不到就回「未明確」 ---
{
  assert.strictEqual(extractVerdict_('報告內容...最終建議：【強力買入】...'), '強力買入');
  assert.strictEqual(extractVerdict_('...【分批布局】...'), '分批布局');
  assert.strictEqual(extractVerdict_('...【觀望不追】...'), '觀望不追');
  assert.strictEqual(extractVerdict_('...【立刻退出】...'), '立刻退出');
  assert.strictEqual(extractVerdict_('...【體質轉強，加碼】...'), '體質轉強，加碼');
  assert.strictEqual(extractVerdict_('...【體質穩健，續抱】...'), '體質穩健，續抱');
  assert.strictEqual(extractVerdict_('...【體質轉弱，減碼】...'), '體質轉弱，減碼');
  assert.strictEqual(extractVerdict_('...【體質惡化，出場】...'), '體質惡化，出場');
  assert.strictEqual(extractVerdict_('完全沒有提到結論的文字'), '未明確');
  assert.strictEqual(extractVerdict_(''), '未明確');
  assert.strictEqual(extractVerdict_(undefined), '未明確');
  console.log('Test 3 (extractVerdict_ matches one of the 8 verdicts or falls back) passed.');
}

// --- 3b. 兩份 system prompt 都存在、非空、且各自帶對應的四選一決策文案 ---
{
  assert.ok(typeof AI_DIAGNOSIS_SYSTEM_PROMPT === 'string' && AI_DIAGNOSIS_SYSTEM_PROMPT.length > 100);
  assert.ok(AI_DIAGNOSIS_SYSTEM_PROMPT.indexOf('強力買入') !== -1);
  assert.ok(typeof AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT === 'string' && AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT.length > 100);
  assert.ok(AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT.indexOf('體質穩健，續抱') !== -1);
  assert.ok(AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT.indexOf('強力買入') === -1, '續抱診斷的 prompt 不該混進新進場的決策選項');
  console.log('Test 3b (both system prompts exist and carry their own verdict options) passed.');
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
