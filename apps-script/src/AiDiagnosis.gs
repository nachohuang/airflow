/**
 * AiDiagnosis.gs
 * 把使用者提供的「頂尖投資戰略家」深度診斷 prompt 接進 App：
 * 對指定股票（通常是當天 Armor_Score 前幾名的非 Neutral 訊號）自動蒐集 v17.0 戰報資料、
 * 抓 Goodinfo 頁面文字當佐證，呼叫 Claude API 產出結構化診斷，存進 AiDiagnosis 分頁。
 *
 * 需要使用者自己申請 Anthropic API key，在後台管理輸入一次
 * （存在 Script Properties，setAnthropicApiKey 存完不會把金鑰回傳給前端）。
 *
 * 跟原本 prompt 的差異：原始版本假設模型自己能上網查 Goodinfo，但 Claude API 預設沒有瀏覽能力，
 * 所以改成由 Apps Script 自己抓 Goodinfo 頁面文字，當成資料一起餵給模型（第 1 條規則的用詞相應調整）。
 */

var AI_DIAGNOSIS_SYSTEM_PROMPT = `# Role & Expertise
你是一名世界級的頂尖台灣股市投資戰略家與高階財務分析師。你同時精通三個流派：【價值護城河大師（專攻財報與競爭壁壘）】、【籌碼追蹤專家（專攻法人與主力大戶動向）】、【技術型態首席（專攻動能與波段拐點）】。你的任務是客觀、嚴厲且極度精準地協助我，針對我提供的「台股量化選股策略 (v17.0) 趨勢共鳴戰報」資料與指定的個股進行「第二層思考」診斷。

# Core Rules & Constraints
1. **Goodinfo 資料查核：**
   - 針對數據中的個股，請參考我在使用者訊息裡提供的「Goodinfo 個股頁面文字摘要」（來源：https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=xxxx）進行最新資訊與基本面查核。這份摘要是程式自動抓取的，可能不完整，若缺漏就明確說明「此部分資料不足」，不要憑空捏造數字。
   - 【絕對禁忌】：嚴禁使用 Wantgoo 玩股網或任何未經證實的論壇傳言作為數據源。
2. **5年 + TTM 財報地毯式審查：**
   - 深入分析該股過去 5 年以及最新 TTM (近四季滾動) 的：營收年增率 (MoM/YoY)、三率 (毛利率、利益率、淨利率) 走勢、EPS、ROE，以及自由現金流。
   - 判斷其近期動能是來自「實質獲利爆發」還是「短線題材炒作」。
3. **多流派對抗辯證 (Multi-Perspective Debate)：**
   - 【價值流觀點】：評估該公司的產業地位、客戶結構與競爭護城河。
   - 【籌碼與技術流觀點】：對比我提供的籌碼/技術數據，評估目前主力是正在「拉高出貨」還是「進貨鎖籌」。
4. **自我驗證鏈 (CoVE - Chain of Verification) 查核：**
   - 必須反向提問：
     * 「我剛剛宣稱的利多，有沒有可能是市場早已反應 (Priced in) 的已知事實？」
     * 「該產業未來 1-2 季是否存在庫存調整或報價下跌的隱憂？」
     * 「這檔股票是否屬於『高週轉率、波動過大、散戶跟風嚴重』等不適合此量化邏輯的警示標的？」
5. **最終決策輸出 (Explicit Action)：**
   - 避開模稜兩可的說法。必須給出最直白的行動指南：【強力買入】/【分批布局】/【觀望不追】/【立刻退出】。
6. **語氣口吻：** 使用繁體中文，語氣需如同寫給機構法人的投資報告，字字精煉，直擊痛點。

# Reference Timeline & Context
- 請以使用者訊息裡提供的時間戳記作為執行時間檢查與監控基準。
- 請幫我警示、並避開高本益比、無實質獲利的投機泡沫股（例如高檔爆量長黑、土洋對水的個股，需嚴防高位騙線陷阱）。

# Output Format (請嚴格使用以下結構進行排版，避免冗長文字牆)

---
## 🚨 策略個股總體診斷：[股票名稱/代號]
> **監控基準時間：** [填入提供的時間戳記]
> **綜合風險評級：** [低 / 中 / 高]（若不適合此策略，請在此處直接警告）

### 一、 5年 + TTM 財務健康診斷
| 財務指標 | 近 5 年趨勢概述 | 最新 TTM 現況 | 關鍵隱憂或亮點 |
| :--- | :--- | :--- | :--- |
| **營收與三率** | | | |
| **EPS & ROE** | | | |
| **現金流與債務** | | | |

### 二、 產業競爭力與護城河評估
* **核心壁壘：**（分析其產品競爭力、技術優勢 or 客戶黏著度）
* **產業循環位置：**（目前處於成長期、成熟期還是衰退期？）

### 三、 三大流派多軌辯證
* 📈 **技術與動能面（結合 Armor_Score）：** 評估策略觸發訊號的純度與位階。
* 💼 **價值面檢驗：** 股價是否已過度透支未來獲利？
* 🐋 **籌碼面查核：** 近期外資、投信與大戶的真實意圖。

### 四、 自我驗證 (CoVE) 警示牆
* *問題 1：此利多是否已被市場過度期待？* -> **[解答]**
* *問題 2：這檔股票是否存在不適合本量化策略的致命缺陷？* -> **[解答]**

### 五、 最終操作決策 (Explicit Action)
> 💡 **最終建議：** 【強力買入】/ 【分批布局】/ 【觀望不追】/ 【立刻退出】
> **核心理由：**（用 2 句話總結為什麼給出這個建議）
---`;

// ---------------- API 金鑰 / 設定 ----------------

function setAnthropicApiKey(key) {
  var trimmed = String(key || '').trim();
  if (!trimmed) throw new Error('API 金鑰不可為空');
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.ANTHROPIC_API_KEY, trimmed);
  logRun_('AI設定', '成功', '已更新 Anthropic API 金鑰', 0);
  return { ok: true };
}

function clearAnthropicApiKey() {
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.PROP_KEYS.ANTHROPIC_API_KEY);
  logRun_('AI設定', '成功', '已清除 Anthropic API 金鑰', 0);
  return { ok: true };
}

function setGeminiApiKey(key) {
  var trimmed = String(key || '').trim();
  if (!trimmed) throw new Error('API 金鑰不可為空');
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.GEMINI_API_KEY, trimmed);
  logRun_('AI設定', '成功', '已更新 Gemini API 金鑰', 0);
  return { ok: true };
}

function clearGeminiApiKey() {
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.PROP_KEYS.GEMINI_API_KEY);
  logRun_('AI設定', '成功', '已清除 Gemini API 金鑰', 0);
  return { ok: true };
}

/** 切換要用 Claude 還是 Gemini 來跑 AI 深度診斷。 */
function setAiProvider(provider) {
  var valid = (provider === 'gemini') ? 'gemini' : 'claude';
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.AI_PROVIDER, valid);
  logRun_('AI設定', '成功', 'AI 診斷供應商切換為：' + (valid === 'gemini' ? 'Gemini' : 'Claude'), 0);
  return getAiSettings();
}

/** 供前端顯示狀態用：只回傳「有沒有設定」，絕不回傳金鑰本身。 */
function getAiSettings() {
  var props = PropertiesService.getScriptProperties();
  return {
    hasClaudeKey: !!props.getProperty(CONFIG.PROP_KEYS.ANTHROPIC_API_KEY),
    hasGeminiKey: !!props.getProperty(CONFIG.PROP_KEYS.GEMINI_API_KEY),
    provider: props.getProperty(CONFIG.PROP_KEYS.AI_PROVIDER) === 'gemini' ? 'gemini' : 'claude',
    dailyEnabled: props.getProperty(CONFIG.PROP_KEYS.AI_DAILY_ENABLED) === 'true',
    topN: parseInt(props.getProperty(CONFIG.PROP_KEYS.AI_DAILY_TOP_N), 10) || CONFIG.AI_DAILY_TOP_N_DEFAULT
  };
}

/** topN 現在代表「AI 先橫向比較篩出的候選名單大小」，這份名單會全部送進深度診斷（含
 *  Goodinfo 基本面查核）——不是最終只診斷這幾檔裡的「前幾名」，是全部都要查。名單太窄
 *  （例如只有 1~2 檔）就失去「先擴大候選、再讓基本面篩選」的意義，所以下限訂在 3。 */
function setAiDailySettings(enabled, topN) {
  var n = Math.max(3, Math.min(10, parseInt(topN, 10) || CONFIG.AI_DAILY_TOP_N_DEFAULT));
  var props = PropertiesService.getScriptProperties();
  props.setProperty(CONFIG.PROP_KEYS.AI_DAILY_ENABLED, enabled ? 'true' : 'false');
  props.setProperty(CONFIG.PROP_KEYS.AI_DAILY_TOP_N, String(n));
  logRun_('AI設定', '成功', '每日自動 AI 診斷：' + (enabled ? ('開啟，前 ' + n + ' 檔') : '關閉'), 0);
  return getAiSettings();
}

// ---------------- Goodinfo 抓取 ----------------

/**
 * 抓 Goodinfo 個股頁面文字（去掉 HTML 標籤的粗略版本，非精確解析）。
 * Goodinfo 部分內容可能是前端 JS 動態產生，這個抓法拿不到那些；抓不到或失敗時
 * 回傳一段說明文字讓模型知道「這部分沒有即時資料」，不會讓整個診斷流程中斷。
 */
function fetchGoodinfoText_(code) {
  var url = 'https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=' + code;
  try {
    var resp = UrlFetchApp.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9'
      },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      return '（無法取得 Goodinfo 頁面，HTTP ' + resp.getResponseCode() + '，這部分請依你既有的知識判斷，並在報告中註明缺乏即時資料）';
    }
    var html = resp.getContentText('UTF-8');
    var text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    var MAX_CHARS = 6000; // 避免整段塞爆 prompt，只取前面精華（頁首通常是股價/基本資訊區塊）
    return text.slice(0, MAX_CHARS);
  } catch (e) {
    return '（抓取 Goodinfo 頁面時發生錯誤：' + String(e.message || e) + '，這部分請依你既有的知識判斷，並在報告中註明缺乏即時資料）';
  }
}

// ---------------- Prompt 組裝 + Claude API ----------------

/**
 * holding 有帶（持股續抱診斷專用，見 runPortfolioHoldDiagnosis）時，額外插入一段「我目前的
 * 持股資訊」——平均成本、持有天數、目前損益%——讓 AI 的建議是「針對我這筆部位」量身判斷，
 * 不是泛用的新進場買入建議。搭配 AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT 的持股決策分類使用。
 */
function buildDiagnosisPrompt_(row, goodinfoText, timestampLabel, holding) {
  var lines = [];
  lines.push('監控基準時間戳記：' + timestampLabel);
  lines.push('');
  lines.push('【本次要診斷的個股 - 來自 v17.0 量化戰報】');
  lines.push('股票代號：' + row['證券代號']);
  lines.push('股票名稱：' + row['證券名稱']);
  lines.push('資料日期：' + row['日期']);
  lines.push('Armor_Score：' + row['Armor_Score']);
  lines.push('操作策略：' + row['操作策略']);
  lines.push('建議動作：' + row['建議動作']);
  lines.push('實相解讀：' + row['實相解讀']);
  lines.push('Trend_Score（0-2，站上均線+均線向上各1分）：' + row['Trend_Score']);
  lines.push('法人參與密度排名 Inst_Part_Rank（0-1，越高代表法人越積極參與）：' + row['Inst_Part_Rank']);
  lines.push('下跌接手率排名 IBF_20D_Rank（0-1，越高代表法人越常在下跌時買進）：' + row['IBF_20D_Rank']);
  if (row['參考最高價'] !== undefined && row['參考最高價'] !== '') lines.push('持有期參考最高價：' + row['參考最高價']);
  if (holding) {
    lines.push('');
    lines.push('【我目前實際持有這檔股票的部位資訊，請務必結合這組數字做個體化判斷】');
    lines.push('加權平均成本：' + holding.cost);
    lines.push('最早買進日期：' + holding.buyDate + '（已持有 ' + holding.daysHeld + ' 天）');
    if (holding.profitPct !== null && holding.profitPct !== undefined) {
      lines.push('目前未實現損益：' + (holding.profitPct >= 0 ? '+' : '') + holding.profitPct + '%');
    }
  }
  lines.push('');
  lines.push('【Goodinfo 個股頁面文字摘要（程式自動抓取，可能不完整，僅供參考）】');
  lines.push(goodinfoText);
  lines.push('');
  lines.push(holding
    ? '請依照系統設定的規則與輸出格式，針對「我目前持有的這筆部位」進行完整的續抱評估。'
    : '請依照系統設定的規則與輸出格式，針對這檔股票進行完整的第二層深度診斷。');
  return lines.join('\n');
}

function callClaude_(systemPrompt, userPrompt) {
  var apiKey = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.ANTHROPIC_API_KEY);
  if (!apiKey) throw new Error('尚未設定 Anthropic API 金鑰，請先到後台管理輸入。');

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: CONFIG.CLAUDE_MODEL,
      max_tokens: CONFIG.CLAUDE_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText('UTF-8');
  if (code !== 200) {
    throw new Error('Claude API 呼叫失敗 HTTP ' + code + '：' + body.slice(0, 300));
  }
  var json = JSON.parse(body);
  var text = (json.content || []).map(function (block) { return block.text || ''; }).join('\n');
  var usage = json.usage || {};
  return {
    text: text,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    provider: 'claude',
    model: CONFIG.CLAUDE_MODEL
  };
}

/**
 * Gemini（Generative Language API / Google AI Studio 的 key）呼叫。
 * 有開啟 google_search grounding，讓模型自己也能查即時資訊，不是只靠我們餵的 Goodinfo 摘要。
 * 如果 CONFIG.GEMINI_MODEL 這個模型名稱被 Google 淘汰導致 404，去
 * https://ai.google.dev/gemini-api/docs/models 查目前可用的模型名稱，改 Config.gs 就好。
 */
function callGemini_(systemPrompt, userPrompt) {
  var apiKey = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.GEMINI_API_KEY);
  if (!apiKey) throw new Error('尚未設定 Gemini API 金鑰，請先到後台管理輸入。');

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL +
    ':generateContent?key=' + encodeURIComponent(apiKey);

  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: CONFIG.GEMINI_MAX_TOKENS }
    }),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText('UTF-8');
  if (code !== 200) {
    throw new Error('Gemini API 呼叫失敗 HTTP ' + code + '：' + body.slice(0, 300));
  }
  var json = JSON.parse(body);
  var candidate = (json.candidates || [])[0];
  if (!candidate || !candidate.content || !candidate.content.parts) {
    throw new Error('Gemini 回傳格式異常（可能被安全過濾擋下或模型無回應）：' + body.slice(0, 300));
  }
  var text = candidate.content.parts.map(function (p) { return p.text || ''; }).join('');
  var usage = json.usageMetadata || {};
  return {
    text: text,
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    provider: 'gemini',
    model: CONFIG.GEMINI_MODEL
  };
}

/**
 * 依目前設定的 provider 分派到 Claude 或 Gemini，其餘程式碼都呼叫這個，不用管實際用哪個供應商。
 * 回傳 {text, inputTokens, outputTokens, provider, model}，方便呼叫端順便記使用量/估算費用。
 */
function callLlm_(systemPrompt, userPrompt) {
  var provider = getAiSettings().provider;
  return provider === 'gemini' ? callGemini_(systemPrompt, userPrompt) : callClaude_(systemPrompt, userPrompt);
}

// ---------------- 使用量 / 費用估算 ----------------

/** 供前端顯示與編輯：參考單價（USD / 每百萬 tokens），存在 Script Properties，抓錯了可以自己改。 */
function getPricingSettings() {
  var props = PropertiesService.getScriptProperties();
  function num(key, def) {
    var v = parseFloat(props.getProperty(key));
    return isNaN(v) ? def : v;
  }
  return {
    claudeInputPerM: num(CONFIG.PROP_KEYS.CLAUDE_PRICE_INPUT, CONFIG.CLAUDE_PRICE_INPUT_PER_M_DEFAULT),
    claudeOutputPerM: num(CONFIG.PROP_KEYS.CLAUDE_PRICE_OUTPUT, CONFIG.CLAUDE_PRICE_OUTPUT_PER_M_DEFAULT),
    geminiInputPerM: num(CONFIG.PROP_KEYS.GEMINI_PRICE_INPUT, CONFIG.GEMINI_PRICE_INPUT_PER_M_DEFAULT),
    geminiOutputPerM: num(CONFIG.PROP_KEYS.GEMINI_PRICE_OUTPUT, CONFIG.GEMINI_PRICE_OUTPUT_PER_M_DEFAULT)
  };
}

function setPricingSettings(claudeIn, claudeOut, geminiIn, geminiOut) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(CONFIG.PROP_KEYS.CLAUDE_PRICE_INPUT, String(parseFloat(claudeIn) || 0));
  props.setProperty(CONFIG.PROP_KEYS.CLAUDE_PRICE_OUTPUT, String(parseFloat(claudeOut) || 0));
  props.setProperty(CONFIG.PROP_KEYS.GEMINI_PRICE_INPUT, String(parseFloat(geminiIn) || 0));
  props.setProperty(CONFIG.PROP_KEYS.GEMINI_PRICE_OUTPUT, String(parseFloat(geminiOut) || 0));
  logRun_('AI設定', '成功', '已更新 AI 費用參考單價', 0);
  return getPricingSettings();
}

function calcCost_(provider, inputTokens, outputTokens) {
  var pricing = getPricingSettings();
  var inRate = provider === 'gemini' ? pricing.geminiInputPerM : pricing.claudeInputPerM;
  var outRate = provider === 'gemini' ? pricing.geminiOutputPerM : pricing.claudeOutputPerM;
  return (inputTokens / 1e6) * inRate + (outputTokens / 1e6) * outRate;
}

function getAiUsageSheet_() {
  return ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.AI_USAGE, CONFIG.AI_USAGE_COLUMNS);
}

function logAiUsage_(record) {
  appendSheetObjects_(getAiUsageSheet_(), CONFIG.AI_USAGE_COLUMNS, [record]);
}

/** 供「後台管理」顯示：最近 N 天每天的呼叫次數/tokens/預估費用，加上總計。 */
function getAiUsageSummary(days) {
  days = days || 30;
  var rows = readSheetObjects_(getAiUsageSheet_());
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  var cutoffStr = normalizeDateStr(cutoff);
  var recent = rows.filter(function (r) { return normalizeDateStr(r['日期']) >= cutoffStr; });

  var byDate = {};
  recent.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (!byDate[d]) byDate[d] = { date: d, calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    byDate[d].calls += 1;
    byDate[d].inputTokens += toNumber(r['輸入Tokens']);
    byDate[d].outputTokens += toNumber(r['輸出Tokens']);
    byDate[d].cost += toNumber(r['預估費用(USD)']);
  });
  var daily = Object.keys(byDate).map(function (d) { return byDate[d]; })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; });

  var totalCost = 0;
  recent.forEach(function (r) { totalCost += toNumber(r['預估費用(USD)']); });

  var todayStr = normalizeDateStr(new Date());
  var todayCost = byDate[todayStr] ? byDate[todayStr].cost : 0;

  return {
    daily: daily,
    totalCost: round_(totalCost, 4),
    totalCalls: recent.length,
    todayCost: round_(todayCost, 4),
    days: days
  };
}

/** 新進場決策（AI_DIAGNOSIS_SYSTEM_PROMPT，第一次要不要買）跟持股續抱決策
 *  （AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT，已經持有要不要繼續抱）是兩套不同的決策分類，
 *  文字完全不重疊，直接合併成一份清單搜尋即可，不用另外傳「這是哪一種診斷」進來判斷。 */
var AI_VERDICT_OPTIONS_ = ['強力買入', '分批布局', '觀望不追', '立刻退出', '強力續抱', '分批獲利入袋', '彈升減碼', '觸發止損平倉'];

function extractVerdict_(text) {
  for (var i = 0; i < AI_VERDICT_OPTIONS_.length; i++) {
    if (text.indexOf(AI_VERDICT_OPTIONS_[i]) !== -1) return AI_VERDICT_OPTIONS_[i];
  }
  return '未明確';
}

/** 從診斷內容裡抓「核心理由」那一行（AI_DIAGNOSIS_SYSTEM_PROMPT／AI_HOLDING_DIAGNOSIS_
 *  SYSTEM_PROMPT 的 Output Format 都用同一種「> **核心理由：**...」格式），給前端「決策結論
 *  置頂橫幅」用，不用整段文字都塞進橫幅。 */
function extractCoreReason_(text) {
  var m = String(text || '').match(/\*\*核心理由：\*\*\s*(.+)/);
  return m ? m[1].trim() : '';
}

// ---------------- 讀寫 AiDiagnosis 分頁 ----------------

function getAiDiagnosisSheet_() {
  return ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.AI_DIAGNOSIS, CONFIG.AI_DIAGNOSIS_COLUMNS);
}

/** 比對鍵是「證券代號＋日期＋診斷類型」三個一起比對（不是只有代號+日期）——同一天對同一
 *  檔股票可能跑了不只一種診斷（例如先跑「深度診斷」，後來又跑「持股續抱診斷」），不應該
 *  互相覆蓋掉彼此，各自的類型各留一筆最新的就好。record 沒帶診斷類型時預設為'深度診斷'，
 *  對應改版前只有單一種診斷類型的舊資料。 */
function upsertAiDiagnosisRow_(record) {
  var sheet = getAiDiagnosisSheet_();
  var recordType = record['診斷類型'] || '深度診斷';
  record['診斷類型'] = recordType;
  var rows = readSheetObjects_(sheet).filter(function (r) {
    var sameCode = zfill4(String(r['證券代號']).trim()) === record['證券代號'];
    var sameDate = normalizeDateStr(r['日期']) === record['日期'];
    var sameType = (r['診斷類型'] || '深度診斷') === recordType;
    return !(sameCode && sameDate && sameType);
  });
  rows.push(record);
  writeSheetObjects_(sheet, CONFIG.AI_DIAGNOSIS_COLUMNS, rows);
}

function getLatestReportRowForCode_(code) {
  var target = zfill4(String(code).trim());
  var rows = readSheetObjects_(getReportsSheet_()).filter(function (r) {
    return zfill4(String(r['證券代號']).trim()) === target;
  });
  if (rows.length === 0) return null;
  rows.sort(function (a, b) { return normalizeDateStr(a['日期']) < normalizeDateStr(b['日期']) ? 1 : -1; });
  return rows[0];
}

/** 供「個股分析」/「股票詳情」頁面顯示某檔股票過去的 AI 診斷紀錄（新到舊）——
 *  「戰報與個股」點進來的股票詳情 modal 靠這個函式做「預設顯示最近一次快取結果，
 *  不用每次都花錢重新呼叫 API」，見前端 initStockAiSection_。 */
function getAiDiagnosisHistoryForCode(code) {
  var target = zfill4(String(code || '').trim());
  return readSheetObjects_(getAiDiagnosisSheet_())
    .filter(function (r) { return zfill4(String(r['證券代號']).trim()) === target; })
    .map(function (r) {
      return {
        date: normalizeDateStr(r['日期']),
        verdict: r['最終建議'],
        diagnosisType: r['診斷類型'] || '深度診斷',
        text: r['診斷內容'],
        armorScore: toNumberOrNull(r['Armor_Score']),
        // '時間戳記' 存的是「台股監控 yyyy-MM-dd HH:mm」這種帶文字前綴的字串，Google Sheets
        // 通常不會把它自動轉成 Date（整格內容要「看起來像日期」才會被轉），但還是照established
        // 的防護寫法處理一次，不假設一定安全（見 sanitizeRowForRpc_ 的說明）。
        timestamp: (r['時間戳記'] instanceof Date) ? formatDateForRpc_(r['時間戳記']) : (r['時間戳記'] || '')
      };
    })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
}

// ---------------- 對外主要進入點 ----------------

/**
 * 對一批股票代號跑 AI 深度診斷（會消耗 Claude API 額度）。
 * codes 可以是單一代號字串，也可以是代號陣列。
 */
function runAiDiagnosis(codes) {
  if (!Array.isArray(codes)) codes = [codes];
  var timestampLabel = '台股監控 ' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  var results = [];

  codes.forEach(function (rawCode) {
    var code = zfill4(String(rawCode).trim());
    var startTime = Date.now();
    try {
      var row = getLatestReportRowForCode_(code);
      if (!row) throw new Error('在 Reports 裡找不到這檔股票的戰報資料，請先確認它出現在某一天的戰報中。');

      var goodinfoText = fetchGoodinfoText_(code);
      var userPrompt = buildDiagnosisPrompt_(row, goodinfoText, timestampLabel);
      var llmResult = callLlm_(AI_DIAGNOSIS_SYSTEM_PROMPT, userPrompt);
      var diagnosisText = llmResult.text;
      var verdict = extractVerdict_(diagnosisText);
      var cost = calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens);
      var todayStr = normalizeDateStr(new Date());

      upsertAiDiagnosisRow_({
        '日期': normalizeDateStr(row['日期']),
        '證券代號': code,
        '證券名稱': row['證券名稱'],
        'Armor_Score': row['Armor_Score'],
        '操作策略': row['操作策略'],
        '最終建議': verdict,
        '診斷類型': '深度診斷',
        '診斷內容': diagnosisText,
        '時間戳記': timestampLabel
      });

      logAiUsage_({
        '日期': todayStr,
        '時間戳記': timestampLabel,
        '供應商': llmResult.provider,
        '模型': llmResult.model,
        '證券代號': code,
        '輸入Tokens': llmResult.inputTokens,
        '輸出Tokens': llmResult.outputTokens,
        '預估費用(USD)': round_(cost, 6)
      });

      var dur = Math.round((Date.now() - startTime) / 1000);
      logRun_('AI診斷', '成功', code + ' ' + (row['證券名稱'] || '') + ' -> ' + verdict +
        '（約 $' + round_(cost, 4) + '）', dur);
      results.push({ ok: true, code: code, name: row['證券名稱'], verdict: verdict, text: diagnosisText, cost: round_(cost, 4) });
    } catch (e) {
      var dur2 = Math.round((Date.now() - startTime) / 1000);
      logRun_('AI診斷', '失敗', code + '：' + String(e.message || e), dur2);
      results.push({ ok: false, code: code, error: String(e.message || e) });
    }
  });

  return results;
}

/**
 * 「持股續抱診斷」專用 system prompt：跟 AI_DIAGNOSIS_SYSTEM_PROMPT（新進場買不買）是同一套
 * 查核流程（Goodinfo 查核／5年+TTM 財報／多流派辯證／CoVE 自我驗證），差別只在第 5 條規則的
 * 決策分類——這裡問的是「已經持有，接下來怎麼處理」，不是「要不要進場」，用買入/退出的分類
 * 會文不對題（例如虧損中的持股，「立刻退出」聽起來像新股票的建議，「觸發止損平倉」才是
 * 持股語境該用的講法）。
 */
var AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT = `# Role & Expertise
你是一名世界級的頂尖台灣股市投資戰略家與高階財務分析師。你同時精通三個流派：【價值護城河大師（專攻財報與競爭壁壘）】、【籌碼追蹤專家（專攻法人與主力大戶動向）】、【技術型態首席（專攻動能與波段拐點）】。你的任務是客觀、嚴厲且極度精準地協助我評估「我已經持有」的這檔股票，針對我提供的持股成本／持有天數／目前損益，判斷接下來該怎麼處理這筆部位——這不是選股，是部位管理。

# Core Rules & Constraints
1. **Goodinfo 資料查核：**
   - 針對數據中的個股，請參考我在使用者訊息裡提供的「Goodinfo 個股頁面文字摘要」（來源：https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=xxxx）進行最新資訊與基本面查核。這份摘要是程式自動抓取的，可能不完整，若缺漏就明確說明「此部分資料不足」，不要憑空捏造數字。
   - 【絕對禁忌】：嚴禁使用 Wantgoo 玩股網或任何未經證實的論壇傳言作為數據源。
2. **5年 + TTM 財報地毯式審查：**
   - 深入分析該股過去 5 年以及最新 TTM (近四季滾動) 的：營收年增率 (MoM/YoY)、三率 (毛利率、利益率、淨利率) 走勢、EPS、ROE，以及自由現金流。
   - 判斷其近期動能是來自「實質獲利爆發」還是「短線題材炒作」，這關係到現在的獲利/虧損還撐不撐得住。
3. **多流派對抗辯證 (Multi-Perspective Debate)：**
   - 【價值流觀點】：評估該公司的產業地位、客戶結構與競爭護城河，目前的股價是否還合理。
   - 【籌碼與技術流觀點】：對比我提供的籌碼/技術數據，評估目前主力是正在「拉高出貨」還是「進貨鎖籌」。
4. **自我驗證鏈 (CoVE - Chain of Verification) 查核：**
   - 必須反向提問：
     * 「我剛剛宣稱的利多，有沒有可能是市場早已反應 (Priced in) 的已知事實？」
     * 「該產業未來 1-2 季是否存在庫存調整或報價下跌的隱憂？」
     * 「以我目前的成本與損益狀況，繼續持有的風險報酬比是否還合理？」
5. **最終決策輸出（持股續抱專用）：**
   - 必須結合我提供的「持股成本／持有天數／目前損益%」明確判斷，只能從以下四種擇一：
     【強力續抱】（後市仍看好、風險可控，維持部位不動）／
     【分批獲利入袋】（已有可觀獲利，建議先了結一部分保護獲利）／
     【彈升減碼】（短線急漲、擔心拉回，但長線基本面仍看好，建議減碼降低部位）／
     【觸發止損平倉】（虧損或風險已急遽升高，建議認賠了結）。
   - 避開模稜兩可的說法，四選一，不能同時給兩個。
6. **語氣口吻：** 使用繁體中文，語氣需如同寫給機構法人的投資報告，字字精煉，直擊痛點。

# Reference Timeline & Context
- 請以使用者訊息裡提供的時間戳記作為執行時間檢查與監控基準。
- 請幫我警示、並避開高本益比、無實質獲利的投機泡沫股（例如高檔爆量長黑、土洋對水的個股，需嚴防高位騙線陷阱）。

# Output Format (請嚴格使用以下結構進行排版，避免冗長文字牆)

---
## 🚨 持股續抱評估：[股票名稱/代號]
> **監控基準時間：** [填入提供的時間戳記]
> **綜合風險評級：** [低 / 中 / 高]

### 一、 5年 + TTM 財務健康診斷
| 財務指標 | 近 5 年趨勢概述 | 最新 TTM 現況 | 關鍵隱憂或亮點 |
| :--- | :--- | :--- | :--- |
| **營收與三率** | | | |
| **EPS & ROE** | | | |
| **現金流與債務** | | | |

### 二、 產業競爭力與護城河評估
* **核心壁壘：**（分析其產品競爭力、技術優勢 or 客戶黏著度）
* **產業循環位置：**（目前處於成長期、成熟期還是衰退期？）

### 三、 三大流派多軌辯證
* 📈 **技術與動能面（結合 Armor_Score）：** 評估策略觸發訊號的純度與位階。
* 💼 **價值面檢驗：** 股價是否已過度透支未來獲利？
* 🐋 **籌碼面查核：** 近期外資、投信與大戶的真實意圖。

### 四、 自我驗證 (CoVE) 警示牆
* *問題 1：此利多是否已被市場過度期待？* -> **[解答]**
* *問題 2：以我目前的成本與損益狀況，繼續持有的風險報酬比是否還合理？* -> **[解答]**

### 五、 最終續抱決策 (Explicit Action)
> 💡 **最終建議：** 【強力續抱】/ 【分批獲利入袋】/ 【彈升減碼】/ 【觸發止損平倉】
> **核心理由：**（用 2 句話總結為什麼給出這個建議，務必扣住我目前的成本/損益狀況）
---`;

/**
 * 「💼 持股庫存」卡片上的「🧠 持股續抱診斷」按鈕：跟 runAiDiagnosis 是同一套 Goodinfo+財報
 * 深度查核流程，但強制注入使用者實際持有這檔股票的成本/持有天數/損益%，改用持股專用的
 * 決策分類（續抱/分批獲利入袋/彈升減碼/止損平倉），回答的是「這筆部位怎麼辦」，不是
 * 「要不要進場」。code 必須是目前「持有中」的股票，否則沒有成本/損益資訊可以注入。
 */
function runPortfolioHoldDiagnosis(code) {
  code = zfill4(String(code || '').trim());
  var startTime = Date.now();
  var timestampLabel = '台股監控 ' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  try {
    var portfolioMap = getPortfolioMap_(); // 只有「持有中」的加權平均成本/最早買進日
    var holdingInfo = portfolioMap[code];
    if (!holdingInfo) throw new Error('目前沒有持有 ' + code + '，請確認「持股庫存」裡有這一筆持有中的紀錄');

    var row = getLatestReportRowForCode_(code);
    if (!row) throw new Error('在 Reports 裡找不到這檔股票的戰報資料，請先確認它出現在某一天的戰報中。');

    var latestByCode = getLatestCloseByCode_();
    var latestClose = latestByCode[code] ? latestByCode[code].close : null;
    var daysHeld = holdingInfo.buyDate
      ? Math.round((new Date(normalizeDateStr(new Date()) + 'T00:00:00') - new Date(holdingInfo.buyDate + 'T00:00:00')) / 86400000)
      : null;
    var profitPct = (holdingInfo.cost && latestClose !== null)
      ? round_((latestClose - holdingInfo.cost) / holdingInfo.cost * 100, 2)
      : null;

    var goodinfoText = fetchGoodinfoText_(code);
    var userPrompt = buildDiagnosisPrompt_(row, goodinfoText, timestampLabel, {
      cost: holdingInfo.cost, buyDate: holdingInfo.buyDate, daysHeld: daysHeld, profitPct: profitPct
    });
    var llmResult = callLlm_(AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT, userPrompt);
    var diagnosisText = llmResult.text;
    var verdict = extractVerdict_(diagnosisText);
    var cost = calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens);
    var todayStr = normalizeDateStr(new Date());

    upsertAiDiagnosisRow_({
      '日期': normalizeDateStr(row['日期']),
      '證券代號': code,
      '證券名稱': row['證券名稱'],
      'Armor_Score': row['Armor_Score'],
      '操作策略': row['操作策略'],
      '最終建議': verdict,
      '診斷類型': '持股續抱診斷',
      '診斷內容': diagnosisText,
      '時間戳記': timestampLabel
    });

    logAiUsage_({
      '日期': todayStr,
      '時間戳記': timestampLabel,
      '供應商': llmResult.provider,
      '模型': llmResult.model,
      '證券代號': code,
      '輸入Tokens': llmResult.inputTokens,
      '輸出Tokens': llmResult.outputTokens,
      '預估費用(USD)': round_(cost, 6)
    });

    var dur = Math.round((Date.now() - startTime) / 1000);
    logRun_('持股續抱診斷', '成功', code + ' ' + (row['證券名稱'] || '') + ' -> ' + verdict +
      '（約 $' + round_(cost, 4) + '）', dur);
    return { ok: true, code: code, name: row['證券名稱'], verdict: verdict, text: diagnosisText, cost: round_(cost, 4) };
  } catch (e) {
    var dur2 = Math.round((Date.now() - startTime) / 1000);
    logRun_('持股續抱診斷', '失敗', code + '：' + String(e.message || e), dur2);
    return { ok: false, code: code, error: String(e.message || e) };
  }
}

/**
 * 每日排程呼叫：如果有開啟「每日自動 AI 診斷」，選股分兩層——先用 AI 橫向比較（見
 * AI_SHORTLIST_SYSTEM_PROMPT）從當天全部候選裡篩出一份較寬的候選名單（不查財報，
 * 純量化因子比較，維持低成本），名單大小就是 settings.topN；接著把這份名單「全部」
 * 送進「AI 深度診斷」（runAiDiagnosis，會另外抓 Goodinfo 財報/籌碼資料做完整查核）。
 * 刻意不做「橫向比較選 3 檔、深度診斷再驗證同一批 3 檔」這種兩階段都各自拍板的設計——
 * 橫向比較分數再高的候選，基本面查核仍有可能不合格，所以「值不值得投入」完全交給
 * 深度診斷的最終建議（強力買入/分批布局/觀望不追/立刻退出）決定，不會出現「初篩推薦
 * 的標的」跟「深度診斷結論」互相矛盾、還要使用者自己來回對照兩份報告的情況。
 */
function runDailyAiDiagnosisForTopPicks() {
  var settings = getAiSettings();
  if (!settings.dailyEnabled) return { skipped: true, reason: '每日自動 AI 診斷未開啟' };
  var hasKey = settings.provider === 'gemini' ? settings.hasGeminiKey : settings.hasClaudeKey;
  if (!hasKey) return { skipped: true, reason: '尚未設定 ' + (settings.provider === 'gemini' ? 'Gemini' : 'Claude') + ' API 金鑰' };

  var shortlist;
  try {
    shortlist = runAiShortlist_(settings.topN);
  } catch (e) {
    return { skipped: true, reason: String(e.message || e) };
  }

  var codes = extractShortlistCodes_(shortlist.text, settings.topN);
  if (codes.length === 0) return { skipped: true, reason: '無法從 AI 候選名單中取出股票代號' };

  return {
    skipped: false,
    shortlistText: shortlist.text,
    shortlistCost: shortlist.cost,
    results: runAiDiagnosis(codes)
  };
}

/**
 * 橫向比較用的候選名單 prompt：跟 AI_TOP_PICKS_SYSTEM_PROMPT（手動「推薦前三檔」按鈕用）
 * 是類似的初篩邏輯，但這裡輸出的是一份「全部都要送進深度診斷」的候選名單，不是最終建議，
 * 所以不用獎牌排名的敘事格式，改成固定行數的編號清單，方便程式解析、名單大小也可以由
 * count 參數控制（每日自動診斷的 settings.topN），不像 AI_TOP_PICKS_SYSTEM_PROMPT 綁死 3 檔。
 */
var AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE = `# Role & Expertise
你是一名世界級的頂尖台灣股市投資戰略家與高階財務分析師，同時精通【價值護城河大師】、
【籌碼追蹤專家】、【技術型態首席】三個流派。

# 本次任務
我會給你「台股量化選股策略 (v17.0) 趨勢共鳴戰報」這次篩選出來的**全部候選股票清單**
（每檔都附上 Armor_Score 與各項量化因子排名，沒有個別的財報/Goodinfo 原始資料）。
請你橫向比較這整份清單，挑出你認為最值得優先送進「AI 深度診斷」（會另外查核個別財報與
即時籌碼）的 __COUNT__ 檔候選名單。這份名單只是複查對象、不是最終投資建議，真正
「值不值得投入」要等深度診斷查完基本面才拍板。

# 決策原則
1. 不是單純照 Armor_Score 高低取前幾名——分數只是量化因子的加權結果，你要在候選之間
   做橫向比較，找出「因子純度最高、訊號最一致」的組合。
2. 如果分數最高的幾檔彼此高度相關（同產業/同族群齊漲），要主動用產業分散的角度調整
   名單，避免整份名單都集中在同一個籃子裡、放大集中度風險。
3. 這是初篩層級的橫向比較，沒有個股財報與即時籌碼細節佐證，絕對不要假裝有查證過財報，
   只能根據提供的量化欄位做判斷。
4. 語氣口吻：使用繁體中文，字字精煉。

# Output Format（請嚴格使用以下結構，正好 __COUNT__ 行，不要多也不要少，不要加其他文字）
1. 代號 名稱 - 入選理由（一句話）
2. 代號 名稱 - 入選理由（一句話）
（依此類推，共 __COUNT__ 行）`;

function buildShortlistPrompt_(candidates, timestampLabel, count) {
  var lines = [];
  lines.push('比較基準時間戳記：' + timestampLabel);
  lines.push('');
  lines.push('【本次戰報全部候選清單，共 ' + candidates.length + ' 檔，依 Armor_Score 高到低排序】');
  candidates.forEach(function (r, i) {
    lines.push(
      (i + 1) + '. ' + r['證券代號'] + ' ' + r['證券名稱'] +
      '｜Armor_Score=' + r['Armor_Score'] +
      '｜操作策略=' + r['操作策略'] +
      '｜Trend_Score=' + r['Trend_Score'] +
      '｜法人參與密度排名=' + r['Inst_Part_Rank'] +
      '｜下跌接手率排名=' + r['IBF_20D_Rank'] +
      '｜實相解讀=' + r['實相解讀']
    );
  });
  lines.push('');
  lines.push('請依照系統設定的規則與輸出格式，從這份清單挑出 ' + count + ' 檔送進深度診斷的候選名單。');
  return lines.join('\n');
}

/** 每日排程用：橫向比較選出一份大小為 count 的候選名單（給 runDailyAiDiagnosisForTopPicks 用）。 */
function runAiShortlist_(count) {
  var settings = getAiSettings();
  var hasKey = settings.provider === 'gemini' ? settings.hasGeminiKey : settings.hasClaudeKey;
  if (!hasKey) throw new Error('尚未設定 ' + (settings.provider === 'gemini' ? 'Gemini' : 'Claude') + ' API 金鑰，請先到後台管理輸入。');

  var reportRows = readSheetObjects_(getReportsSheet_());
  if (reportRows.length === 0) throw new Error('目前沒有任何戰報資料，請先產生一次戰報。');
  var latestDate = null;
  reportRows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (!latestDate || d > latestDate) latestDate = d;
  });
  var candidates = reportRows.filter(function (r) { return normalizeDateStr(r['日期']) === latestDate; });
  if (candidates.length === 0) throw new Error('最新一次戰報沒有任何候選股票可以比較。');
  candidates.sort(function (a, b) { return toNumber(b['Armor_Score']) - toNumber(a['Armor_Score']); });

  var timestampLabel = '台股監控 ' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  var startTime = Date.now();
  try {
    var systemPrompt = AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE.replace(/__COUNT__/g, String(count));
    var userPrompt = buildShortlistPrompt_(candidates, timestampLabel, count);
    var llmResult = callLlm_(systemPrompt, userPrompt);
    var cost = calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens);

    logAiUsage_({
      '日期': normalizeDateStr(new Date()),
      '時間戳記': timestampLabel,
      '供應商': llmResult.provider,
      '模型': llmResult.model,
      '證券代號': 'SHORTLIST_SCAN',
      '輸入Tokens': llmResult.inputTokens,
      '輸出Tokens': llmResult.outputTokens,
      '預估費用(USD)': round_(cost, 6)
    });

    var dur = Math.round((Date.now() - startTime) / 1000);
    logRun_('AI每日候選名單', '成功', '掃描 ' + candidates.length + ' 檔候選（' + latestDate + '），篩出 ' + count + ' 檔，約 $' + round_(cost, 4), dur);
    return { ok: true, date: latestDate, candidateCount: candidates.length, text: llmResult.text, cost: round_(cost, 4) };
  } catch (e) {
    var dur2 = Math.round((Date.now() - startTime) / 1000);
    logRun_('AI每日候選名單', '失敗', String(e.message || e), dur2);
    throw e;
  }
}

/**
 * 從 runAiShortlist_() 回傳的編號清單文字裡取出股票代號，供每日排程接著餵給 runAiDiagnosis()
 * 做深度診斷。AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE 規定的輸出格式固定是「N. 代號 名稱 - 理由」，
 * 代號一定緊接在編號句點後面、以空白分隔，用逐行比對行首格式取出即可。
 */
function extractShortlistCodes_(text, maxCount) {
  if (!text) return [];
  var re = /^\d+\.\s*(\d{3,6})/;
  var codes = [];
  String(text).split('\n').forEach(function (line) {
    var m = re.exec(line.trim());
    if (m) codes.push(zfill4(m[1]));
  });
  return maxCount ? codes.slice(0, maxCount) : codes;
}

// ---------------- AI 掃描全部候選、推薦前三檔 ----------------

/**
 * 跟 AI_DIAGNOSIS_SYSTEM_PROMPT（單檔深度診斷）是不同量級的任務：這裡不對每一檔候選都
 * 額外抓 Goodinfo/查 5 年財報（候選一多，逐檔深度診斷的成本跟時間會直接爆掉），只用戰報本身
 * 已經算好的量化欄位，讓模型在整份候選名單裡做「橫向比較」，選出最值得優先投入的前三檔並
 * 說明取捨——這是初篩層級的比較，選出來之後還是要對這幾檔分別執行「AI 深度診斷」做完整的
 * 財報/籌碼查核，系統會在輸出裡明確提醒這件事。
 */
var AI_TOP_PICKS_SYSTEM_PROMPT = `# Role & Expertise
你是一名世界級的頂尖台灣股市投資戰略家與高階財務分析師，同時精通【價值護城河大師】、
【籌碼追蹤專家】、【技術型態首席】三個流派。

# 本次任務
我會給你「台股量化選股策略 (v17.0) 趨勢共鳴戰報」這次篩選出來的**全部候選股票清單**
（每檔都附上 Armor_Score 與各項量化因子排名，沒有個別的財報/Goodinfo 原始資料）。
請你橫向比較這整份清單，挑出你認為現在最值得優先投入的前三檔，並清楚說明取捨理由。

# 決策原則
1. 不是單純照 Armor_Score 高低取前三——分數只是量化因子的加權結果，你要在候選之間做
   橫向比較，找出「因子純度最高、訊號最一致、風險最小」的組合。
2. 如果分數最高的幾檔彼此高度相關（同產業/同族群齊漲），要提醒集中度風險，
   並考慮是否該用產業分散的角度調整入選名單。
3. 明確指出「為什麼不選」：至少對 1-2 檔看起來分數很高、但你認為不該優先選入的候選，
   說明原因。
4. 這是初篩層級的橫向比較，沒有個股財報與即時籌碼細節佐證，絕對不要假裝有查證過財報，
   只能根據提供的量化欄位做判斷。
5. 語氣口吻：使用繁體中文，語氣需如同寫給機構法人的投資報告，字字精煉，直擊重點。

# Output Format (請嚴格使用以下結構，避免冗長文字牆)

---
## 🏆 戰報候選橫向比較：Top 3 推薦
> **候選檔數：** [N] 檔　**比較基準時間：** [填入提供的時間戳記]

### 🥇 [代號 名稱]（Armor_Score: xx）
- **入選理由：**
- **相對其他候選的優勢：**

### 🥈 [代號 名稱]（Armor_Score: xx）
- **入選理由：**
- **相對其他候選的優勢：**

### 🥉 [代號 名稱]（Armor_Score: xx）
- **入選理由：**
- **相對其他候選的優勢：**

### 👀 分數亮眼但暫不推薦
（挑 1-2 檔分數不低、但你認為暫時不該優先選入的候選，簡短說明為什麼）

### ⚠️ 重要提醒
這份排名只根據戰報裡已經算好的量化因子做橫向比較，**沒有查核這幾檔的個別財報與即時籌碼細節**。
請對這三檔分別執行「AI 深度診斷」完成完整查核後，再決定是否進場。
---`;

function buildTopPicksPrompt_(candidates, timestampLabel) {
  var lines = [];
  lines.push('比較基準時間戳記：' + timestampLabel);
  lines.push('');
  lines.push('【本次戰報全部候選清單，共 ' + candidates.length + ' 檔，依 Armor_Score 高到低排序】');
  candidates.forEach(function (r, i) {
    lines.push(
      (i + 1) + '. ' + r['證券代號'] + ' ' + r['證券名稱'] +
      '｜Armor_Score=' + r['Armor_Score'] +
      '｜操作策略=' + r['操作策略'] +
      '｜Trend_Score=' + r['Trend_Score'] +
      '｜法人參與密度排名=' + r['Inst_Part_Rank'] +
      '｜下跌接手率排名=' + r['IBF_20D_Rank'] +
      '｜實相解讀=' + r['實相解讀']
    );
  });
  lines.push('');
  lines.push('請依照系統設定的規則與輸出格式，從這份清單挑出最值得優先投入的前三檔。');
  return lines.join('\n');
}

/** 前端「AI 掃描全部，推薦前三檔」按鈕：對最新一次戰報的全部候選做一次橫向比較。 */
function runAiTopPicks() {
  var settings = getAiSettings();
  var hasKey = settings.provider === 'gemini' ? settings.hasGeminiKey : settings.hasClaudeKey;
  if (!hasKey) throw new Error('尚未設定 ' + (settings.provider === 'gemini' ? 'Gemini' : 'Claude') + ' API 金鑰，請先到後台管理輸入。');

  var reportRows = readSheetObjects_(getReportsSheet_());
  if (reportRows.length === 0) throw new Error('目前沒有任何戰報資料，請先產生一次戰報。');
  var latestDate = null;
  reportRows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (!latestDate || d > latestDate) latestDate = d;
  });
  var candidates = reportRows.filter(function (r) { return normalizeDateStr(r['日期']) === latestDate; });
  if (candidates.length === 0) throw new Error('最新一次戰報沒有任何候選股票可以比較。');
  candidates.sort(function (a, b) { return toNumber(b['Armor_Score']) - toNumber(a['Armor_Score']); });

  var timestampLabel = '台股監控 ' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  var startTime = Date.now();
  try {
    var userPrompt = buildTopPicksPrompt_(candidates, timestampLabel);
    var llmResult = callLlm_(AI_TOP_PICKS_SYSTEM_PROMPT, userPrompt);
    var cost = calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens);

    logAiUsage_({
      '日期': normalizeDateStr(new Date()),
      '時間戳記': timestampLabel,
      '供應商': llmResult.provider,
      '模型': llmResult.model,
      '證券代號': 'TOP3_SCAN',
      '輸入Tokens': llmResult.inputTokens,
      '輸出Tokens': llmResult.outputTokens,
      '預估費用(USD)': round_(cost, 6)
    });

    // 跟單檔深度診斷共用同一份 AiDiagnosis 分頁持久化（證券代號固定存 'TOP3'），這樣切換頁面
    // 再回來、或明天再點「檢視 Top3」都能直接看到上次的推薦結果，不用每次都重新花錢呼叫 API。
    upsertAiDiagnosisRow_({
      '日期': latestDate,
      '證券代號': 'TOP3',
      '證券名稱': '（全市場橫向比較）',
      'Armor_Score': '',
      '操作策略': '',
      '最終建議': '',
      '診斷類型': 'TOP3推薦',
      '診斷內容': llmResult.text,
      '時間戳記': timestampLabel
    });

    var dur = Math.round((Date.now() - startTime) / 1000);
    logRun_('AI Top3 推薦', '成功', '掃描 ' + candidates.length + ' 檔候選（' + latestDate + '），約 $' + round_(cost, 4), dur);
    return { ok: true, date: latestDate, candidateCount: candidates.length, text: llmResult.text, cost: round_(cost, 4) };
  } catch (e) {
    var dur2 = Math.round((Date.now() - startTime) / 1000);
    logRun_('AI Top3 推薦', '失敗', String(e.message || e), dur2);
    throw e;
  }
}

/** 前端「🧠 AI 掃描全部候選，推薦前三檔」cache-first 顯示用：拿上次跑過的結果（如果有），
 *  不用一打開就先花錢重新呼叫 API。 */
function getLatestTopPicksResult() {
  var history = getAiDiagnosisHistoryForCode('TOP3');
  if (history.length === 0) return null;
  var latest = history[0];
  return { date: latest.date, text: latest.text, timestamp: latest.timestamp };
}
