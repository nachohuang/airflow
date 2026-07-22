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

function setAiDailySettings(enabled, topN) {
  var n = Math.max(1, Math.min(10, parseInt(topN, 10) || CONFIG.AI_DAILY_TOP_N_DEFAULT));
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

function buildDiagnosisPrompt_(row, goodinfoText, timestampLabel) {
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
  lines.push('');
  lines.push('【Goodinfo 個股頁面文字摘要（程式自動抓取，可能不完整，僅供參考）】');
  lines.push(goodinfoText);
  lines.push('');
  lines.push('請依照系統設定的規則與輸出格式，針對這檔股票進行完整的第二層深度診斷。');
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
  return (json.content || []).map(function (block) { return block.text || ''; }).join('\n');
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
  return candidate.content.parts.map(function (p) { return p.text || ''; }).join('');
}

/** 依目前設定的 provider 分派到 Claude 或 Gemini，其餘程式碼都呼叫這個，不用管實際用哪個供應商。 */
function callLlm_(systemPrompt, userPrompt) {
  var provider = getAiSettings().provider;
  return provider === 'gemini' ? callGemini_(systemPrompt, userPrompt) : callClaude_(systemPrompt, userPrompt);
}

function extractVerdict_(text) {
  var options = ['強力買入', '分批布局', '觀望不追', '立刻退出'];
  for (var i = 0; i < options.length; i++) {
    if (text.indexOf(options[i]) !== -1) return options[i];
  }
  return '未明確';
}

// ---------------- 讀寫 AiDiagnosis 分頁 ----------------

function getAiDiagnosisSheet_() {
  return ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.AI_DIAGNOSIS, CONFIG.AI_DIAGNOSIS_COLUMNS);
}

function upsertAiDiagnosisRow_(record) {
  var sheet = getAiDiagnosisSheet_();
  var rows = readSheetObjects_(sheet).filter(function (r) {
    return !(zfill4(String(r['證券代號']).trim()) === record['證券代號'] && normalizeDateStr(r['日期']) === record['日期']);
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

/** 供「個股分析」頁面顯示某檔股票過去的 AI 診斷紀錄。 */
function getAiDiagnosisHistoryForCode(code) {
  var target = zfill4(String(code || '').trim());
  return readSheetObjects_(getAiDiagnosisSheet_())
    .filter(function (r) { return zfill4(String(r['證券代號']).trim()) === target; })
    .map(function (r) {
      return {
        date: normalizeDateStr(r['日期']),
        verdict: r['最終建議'],
        text: r['診斷內容'],
        armorScore: toNumberOrNull(r['Armor_Score'])
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
      var diagnosisText = callLlm_(AI_DIAGNOSIS_SYSTEM_PROMPT, userPrompt);
      var verdict = extractVerdict_(diagnosisText);

      upsertAiDiagnosisRow_({
        '日期': normalizeDateStr(row['日期']),
        '證券代號': code,
        '證券名稱': row['證券名稱'],
        'Armor_Score': row['Armor_Score'],
        '操作策略': row['操作策略'],
        '最終建議': verdict,
        '診斷內容': diagnosisText,
        '時間戳記': timestampLabel
      });

      var dur = Math.round((Date.now() - startTime) / 1000);
      logRun_('AI診斷', '成功', code + ' ' + (row['證券名稱'] || '') + ' -> ' + verdict, dur);
      results.push({ ok: true, code: code, name: row['證券名稱'], verdict: verdict, text: diagnosisText });
    } catch (e) {
      var dur2 = Math.round((Date.now() - startTime) / 1000);
      logRun_('AI診斷', '失敗', code + '：' + String(e.message || e), dur2);
      results.push({ ok: false, code: code, error: String(e.message || e) });
    }
  });

  return results;
}

/** 每日排程呼叫：如果有開啟「每日自動 AI 診斷」，對當天 Armor_Score 前 N 名非 Neutral 訊號自動跑一次。 */
function runDailyAiDiagnosisForTopPicks() {
  var settings = getAiSettings();
  if (!settings.dailyEnabled) return { skipped: true, reason: '每日自動 AI 診斷未開啟' };
  var hasKey = settings.provider === 'gemini' ? settings.hasGeminiKey : settings.hasClaudeKey;
  if (!hasKey) return { skipped: true, reason: '尚未設定 ' + (settings.provider === 'gemini' ? 'Gemini' : 'Claude') + ' API 金鑰' };

  var reportRows = readSheetObjects_(getReportsSheet_());
  var latestDate = null;
  reportRows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (!latestDate || d > latestDate) latestDate = d;
  });
  if (!latestDate) return { skipped: true, reason: '目前沒有戰報資料' };

  var todayRows = reportRows.filter(function (r) { return normalizeDateStr(r['日期']) === latestDate; });
  todayRows.sort(function (a, b) { return toNumber(b['Armor_Score']) - toNumber(a['Armor_Score']); });
  var topCodes = todayRows.slice(0, settings.topN).map(function (r) { return r['證券代號']; });

  if (topCodes.length === 0) return { skipped: true, reason: '今天沒有非 Neutral 的訊號' };
  return { skipped: false, results: runAiDiagnosis(topCodes) };
}
