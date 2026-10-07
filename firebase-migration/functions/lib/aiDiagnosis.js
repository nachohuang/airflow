/**
 * aiDiagnosis.js
 * AI 深度診斷的純邏輯，從 apps-script/src/AiDiagnosis.gs 搬過來（system prompt 文字逐字
 * 照搬，不是重寫；`buildTwseOfficialFinancialsTextForCode_`／`buildDiagnosisPrompt_`／
 * `extractVerdict_`／`extractCoreReason_`／`calcCost_` 是純函式邏輯照搬，欄位存取從 Sheets
 * 版的中文欄名改成 Firestore 版的英文欄名）。
 *
 * **這一版只搬「深度診斷」（新進場決策，diagnosisType='deep'）**，apps-script 版同時還有
 * 「持股續抱診斷」（'hold'，決策基準改成體質變化而不是進場）跟「TOP3橫向推薦」（'top3'，
 * 全候選名單比較，不查財報）——這兩個刻意先不搬，見 README「AI 診斷」那節的說明，之後要
 * 加的話大部分邏輯（Goodinfo／TWSE 財報抓取、Claude/Gemini 呼叫、費用估算）都可以直接重用。
 *
 * I/O（打 Goodinfo／TWSE OpenAPI／Claude／Gemini 這幾個外部 HTTP 端點，讀寫 Firestore）
 * 留給 index.js，這裡只管「資料到手之後怎麼組 prompt、怎麼從回應抽取結論」。
 */

var AI_DIAGNOSIS_SYSTEM_PROMPT = `# Role & Expertise
你是一名世界級的頂尖台灣股市投資戰略家與高階財務分析師。你同時精通三個流派：【價值護城河大師（專攻財報與競爭壁壘）】、【籌碼追蹤專家（專攻法人與主力大戶動向）】、【技術型態首席（專攻動能與波段拐點）】。你的任務是客觀、嚴厲且極度精準地協助我，針對我提供的「台股量化選股策略 (v17.0) 趨勢共鳴戰報」資料與指定的個股進行「第二層思考」診斷。

# Core Rules & Constraints
1. **資料查核與可信度分級：**
   - 我在使用者訊息裡會提供兩種輔助資料：①「證交所公開資訊觀測站官方資料」（來源：openapi.twse.com.tw，程式直接查詢官方公開 API 取得月營收/財報，可信度最高）、②「Goodinfo 個股頁面文字摘要」（來源：https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=xxxx，程式自動抓取網頁文字，可能不完整或抓取失敗）。兩者衝突時以①官方資料為準；①缺漏才依②判斷；兩者都缺漏就明確說明「此部分資料不足」，不要憑空捏造數字。
   - 如果你有能力自行查詢即時資訊（例如透過搜尋工具），查到的內容一律視為「輔助佐證」，可信度必須低於我提供的①官方資料——遇到搜尋結果跟①衝突，以①為準，並在報告中註明這個落差，不要因為搜尋結果看起來比較「新」就直接覆蓋官方數字。
   - 【絕對禁忌】：嚴禁使用 Wantgoo 玩股網、PTT、Dcard 或任何未經證實的論壇/社群傳言作為數據源，即使是你自己搜尋查到的也一樣不能用。
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

/**
 * datasets：`fetchTwseOfficialFinancialsDatasets_()`（I/O，在 index.js）查回來的 3 份
 * TWSE OpenAPI 全市場原始列（還沒篩選成單一股票）。這支純函式只負責篩選/組字，跟
 * apps-script 版完全同一套邏輯，只是改成給 Node 用。
 */
function buildTwseOfficialFinancialsTextForCode_(code, datasets) {
  var MAX_CHARS = 4000;
  var parts = [];
  (datasets || []).forEach(function (ds) {
    var matched = (ds.rows || []).filter(function (r) { return String(r['公司代號'] || '').trim() === code; });
    if (matched.length === 0) return;
    var text = matched.map(function (r) {
      return Object.keys(r).map(function (k) { return k + '：' + r[k]; }).join('，');
    }).join('\n');
    parts.push('【' + ds.label + '】\n' + text);
  });
  if (parts.length === 0) {
    return '（查無此股票代號在證交所公開資訊觀測站的月營收／財報公開資料——可能是非「一般業」分類' +
      '的公司（金融/證券/保險/金控等產業另有獨立端點，這裡沒有涵蓋），這部分請依 Goodinfo 摘要與你' +
      '既有的知識判斷，並在報告中註明缺乏官方結構化財報資料）';
  }
  return parts.join('\n\n').slice(0, MAX_CHARS);
}

/**
 * row：`reports/{date}/signals` 的文件形狀（英文欄名，見 firestore/schema.md §3）——跟
 * apps-script 版操作 Sheets 中文欄名的 row 不是同一個物件形狀，但組出來的 prompt 文字
 * （中文標籤）完全一樣。
 */
function buildDiagnosisPrompt_(row, goodinfoText, twseOfficialText, timestampLabel) {
  var lines = [];
  lines.push('監控基準時間戳記：' + timestampLabel);
  lines.push('');
  lines.push('【本次要診斷的個股 - 來自 v17.0 量化戰報】');
  lines.push('股票代號：' + row.code);
  lines.push('股票名稱：' + row.name);
  lines.push('資料日期：' + row.date);
  lines.push('Armor_Score：' + row.armorScore);
  lines.push('操作策略：' + row.strategy);
  lines.push('建議動作：' + row.action);
  lines.push('實相解讀：' + row.interpretation);
  lines.push('Trend_Score（0-2，站上均線+均線向上各1分）：' + row.trendScore);
  lines.push('法人參與密度排名 Inst_Part_Rank（0-1，越高代表法人越積極參與）：' + row.instPartRank);
  lines.push('下跌接手率排名 IBF_20D_Rank（0-1，越高代表法人越常在下跌時買進）：' + row.ibf20dRank);
  if (row.referenceHigh !== undefined && row.referenceHigh !== null) lines.push('持有期參考最高價：' + row.referenceHigh);
  lines.push('');
  lines.push('【證交所公開資訊觀測站官方資料（openapi.twse.com.tw，官方 API 直接查詢，可信度最高，' +
    '缺漏或跟其他來源衝突時以這裡為準）】');
  lines.push(twseOfficialText);
  lines.push('');
  lines.push('【Goodinfo 個股頁面文字摘要（程式自動抓取，可能不完整，僅供輔助參考）】');
  lines.push(goodinfoText);
  lines.push('');
  lines.push('請依照系統設定的規則與輸出格式，針對這檔股票進行完整的第二層深度診斷。');
  return lines.join('\n');
}

/** 跟 apps-script 版同一份清單（新進場決策這幾個）——'hold' 診斷的清單這版還沒搬，見檔案
 *  開頭的範圍說明。 */
var AI_VERDICT_OPTIONS_ = ['強力買入', '分批布局', '觀望不追', '立刻退出'];

function extractVerdict_(text) {
  var t = String(text || '');
  for (var i = 0; i < AI_VERDICT_OPTIONS_.length; i++) {
    if (t.indexOf(AI_VERDICT_OPTIONS_[i]) !== -1) return AI_VERDICT_OPTIONS_[i];
  }
  return '未明確';
}

function extractCoreReason_(text) {
  var m = String(text || '').match(/\*\*核心理由：\*\*\s*(.+)/);
  return m ? m[1].trim() : '';
}

/**
 * pricing：{claudeInputPerM, claudeOutputPerM, geminiInputPerM, geminiOutputPerM}，對應
 * Firestore `config/app` 的 `pricing` 欄位（見 firestore/schema.md §8，Phase 2 已遷移）
 * ——apps-script 版是從 PropertiesService 讀，這裡呼叫端自己從 Firestore 讀出來傳進來，
 * 這支純函式不碰任何 I/O。
 *
 * cacheTokens（選填）：{cacheCreationInputTokens, cacheReadInputTokens}，只有 Claude 開了
 * prompt caching 才會有非 0 值。Anthropic 快取計費倍率是官方固定的：寫入快取這次算 1.25
 * 倍 base 輸入單價，命中快取讀到的 tokens 算 0.1 倍。
 */
function calcCost_(provider, inputTokens, outputTokens, cacheTokens, pricing) {
  pricing = pricing || {};
  var inRate = provider === 'gemini' ? (pricing.geminiInputPerM || 0) : (pricing.claudeInputPerM || 0);
  var outRate = provider === 'gemini' ? (pricing.geminiOutputPerM || 0) : (pricing.claudeOutputPerM || 0);
  var cacheCreationTokens = (cacheTokens && cacheTokens.cacheCreationInputTokens) || 0;
  var cacheReadTokens = (cacheTokens && cacheTokens.cacheReadInputTokens) || 0;
  return (inputTokens / 1e6) * inRate + (outputTokens / 1e6) * outRate +
    (cacheCreationTokens / 1e6) * inRate * 1.25 + (cacheReadTokens / 1e6) * inRate * 0.1;
}

module.exports = {
  AI_DIAGNOSIS_SYSTEM_PROMPT: AI_DIAGNOSIS_SYSTEM_PROMPT,
  buildTwseOfficialFinancialsTextForCode_: buildTwseOfficialFinancialsTextForCode_,
  buildDiagnosisPrompt_: buildDiagnosisPrompt_,
  extractVerdict_: extractVerdict_,
  extractCoreReason_: extractCoreReason_,
  calcCost_: calcCost_
};
