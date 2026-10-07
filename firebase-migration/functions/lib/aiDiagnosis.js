/**
 * aiDiagnosis.js
 * AI 深度診斷的純邏輯，從 apps-script/src/AiDiagnosis.gs 搬過來（system prompt 文字逐字
 * 照搬，不是重寫；`buildTwseOfficialFinancialsTextForCode_`／`buildDiagnosisPrompt_`／
 * `extractVerdict_`／`extractCoreReason_`／`calcCost_` 是純函式邏輯照搬，欄位存取從 Sheets
 * 版的中文欄名改成 Firestore 版的英文欄名）。
 *
 * **2026-10-07 補上「持股續抱診斷」（'hold'，決策基準改成體質變化而不是進場）**——跟
 * 「深度診斷」('deep') 共用同一套 Goodinfo／TWSE 財報抓取、Claude/Gemini 呼叫、費用估算
 * 邏輯，差別只在 system prompt 跟 `buildDiagnosisPrompt_` 多塞一段持股背景資訊。
 *
 * **同一天再補上「每日自動 AI 診斷」用的候選名單橫向比較 + TOP3 橫向推薦**
 * （`buildShortlistPrompt_`／`buildTopPicksPrompt_`／`extractShortlistCodes_`，對應
 * apps-script 版 `runAiShortlist_`／`runAiTopPicks`／`extractShortlistCodes_`）——這兩個
 * 都**不查 Goodinfo／TWSE 財報**，只用戰報本身已經算好的量化欄位讓 AI 做橫向比較，跟
 * 深度診斷／續抱診斷（會另外抓財報資料逐檔查核）是不同量級的任務，維持低成本。候選列的
 * 欄位存取同樣從 Sheets 版的中文欄名改成 Firestore 版的英文欄名
 * （`reports/{date}/signals/{code}`，見 firestore/schema.md §3）。
 *
 * I/O（打 Goodinfo／TWSE OpenAPI／Claude／Gemini 這幾個外部 HTTP 端點，讀寫 Firestore）
 * 留給 index.js，這裡只管「資料到手之後怎麼組 prompt、怎麼從回應抽取結論」。
 */
var utils = require('./utils');

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
 * 「持股續抱診斷」專用 system prompt（AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT）：跟上面的
 * AI_DIAGNOSIS_SYSTEM_PROMPT（新進場買不買）是同一套查核流程（Goodinfo 查核／5年+TTM
 * 財報／多流派辯證／CoVE 自我驗證），差別在於決策基準——使用者明確表示可以長期持有、能
 * 承受短期價格波動，所以這裡刻意不是「損益管理」視角（持股成本／持有天數／目前損益%
 * 只當背景參考，不能當決策的主要依據，見 `buildDiagnosisPrompt_` 的 holding 參數），而是
 * 「體質評估」視角：判斷基準是這家公司的基本面（財報/護城河/籌碼趨勢）從進場到現在有沒有
 * 實質變化，不是帳面賺賠多少。
 */
var AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT = `# Role & Expertise
你是一名世界級的頂尖台灣股市投資戰略家與高階財務分析師。你同時精通三個流派：【價值護城河大師（專攻財報與競爭壁壘）】、【籌碼追蹤專家（專攻法人與主力大戶動向）】、【技術型態首席（專攻動能與波段拐點）】。你的任務是客觀、嚴厲且極度精準地協助我評估「我已經持有」的這檔股票——這不是短期損益管理，我對這檔股票抱持長期持有的心態，能夠承受短期價格波動。請把重點放在這家公司的「體質」從我進場到現在有沒有實質變化（財報、護城河、籌碼趨勢），而不是我目前帳面上賺了多少或賠了多少。我提供的持股成本／持有天數／目前損益只是背景參考（用來了解部位規模、風險曝險程度），不是決策的主要依據，不要讓判斷被短期損益綁架。

# Core Rules & Constraints
1. **資料查核與可信度分級：**
   - 我在使用者訊息裡會提供兩種輔助資料：①「證交所公開資訊觀測站官方資料」（來源：openapi.twse.com.tw，程式直接查詢官方公開 API 取得月營收/財報，可信度最高）、②「Goodinfo 個股頁面文字摘要」（來源：https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=xxxx，程式自動抓取網頁文字，可能不完整或抓取失敗）。兩者衝突時以①官方資料為準；①缺漏才依②判斷；兩者都缺漏就明確說明「此部分資料不足」，不要憑空捏造數字。
   - 如果你有能力自行查詢即時資訊（例如透過搜尋工具），查到的內容一律視為「輔助佐證」，可信度必須低於我提供的①官方資料——遇到搜尋結果跟①衝突，以①為準，並在報告中註明這個落差，不要因為搜尋結果看起來比較「新」就直接覆蓋官方數字。
   - 【絕對禁忌】：嚴禁使用 Wantgoo 玩股網、PTT、Dcard 或任何未經證實的論壇/社群傳言作為數據源，即使是你自己搜尋查到的也一樣不能用。
2. **5年 + TTM 財報地毯式審查：**
   - 深入分析該股過去 5 年以及最新 TTM (近四季滾動) 的：營收年增率 (MoM/YoY)、三率 (毛利率、利益率、淨利率) 走勢、EPS、ROE，以及自由現金流。
   - 判斷其近期動能是來自「實質獲利爆發」還是「短線題材炒作」，這關係到公司體質是不是真的在變好。
3. **多流派對抗辯證 (Multi-Perspective Debate)：**
   - 【價值流觀點】：評估該公司的產業地位、客戶結構與競爭護城河，目前的股價是否還合理。
   - 【籌碼與技術流觀點】：對比我提供的籌碼/技術數據，評估目前主力是正在「拉高出貨」還是「進貨鎖籌」。
4. **自我驗證鏈 (CoVE - Chain of Verification) 查核：**
   - 必須反向提問：
     * 「我剛剛宣稱的利多，有沒有可能是市場早已反應 (Priced in) 的已知事實？」
     * 「該產業未來 1-2 季是否存在庫存調整或報價下跌的隱憂？」
     * 「這家公司從我進場到現在，體質是變好、持平、還是變差？我原本看好這檔股票的理由，現在還成立嗎？」
5. **最終決策輸出（持股續抱專用，以「體質變化」為唯一依據，不是以損益為依據）：**
   - 判斷基準是這家公司從進場至今，基本面（財報/護城河/籌碼趨勢）出現了什麼變化，只能從以下四種擇一：
     【體質轉強，加碼】（財報/護城河/籌碼趨勢比進場時更好，值得加碼）／
     【體質穩健，續抱】（基本面沒有明顯變化，原本看好的理由依然成立，維持部位不動）／
     【體質轉弱，減碼】（出現具體的基本面隱憂，例如營收/毛利率轉差、護城河鬆動、法人籌碼轉為賣超，建議先減碼降低曝險）／
     【體質惡化，出場】（基本面已經實質惡化，原本進場的理由不再成立，不管目前賺賠多少都應該出場）。
   - 我可以長期持有、能承受短期股價波動，所以絕對不要因為「短線急漲想先落袋」或「短期虧損想停損」這種純粹價格驅動的理由給建議——除非價格波動本身就是基本面惡化的先行反映（例如爆量長黑伴隨具體壞消息），才能算進判斷。
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
* *問題 2：這家公司的體質，從我進場到現在是變好、持平、還是變差？原本看好的理由還成立嗎？* -> **[解答]**

### 五、 最終續抱決策 (Explicit Action)
> 💡 **最終建議：** 【體質轉強，加碼】/ 【體質穩健，續抱】/ 【體質轉弱，減碼】/ 【體質惡化，出場】
> **核心理由：**（用 2 句話總結公司體質出現了什麼變化、為什麼給出這個建議，不要用損益數字當理由）
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
 *
 * holding（選填，持股續抱診斷專用）：{cost, buyDate, daysHeld, profitPct}，有帶的話會
 * 額外插入一段「我目前的持股資訊」——平均成本、持有天數、目前損益%——讓 AI 的建議是
 * 「針對我這筆部位」量身判斷，不是泛用的新進場買入建議，搭配
 * AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT 的持股決策分類使用。沒帶這個參數（新進場深度診斷）
 * 時完全不影響輸出，跟原來一樣。
 */
function buildDiagnosisPrompt_(row, goodinfoText, twseOfficialText, timestampLabel, holding) {
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
  if (holding) {
    lines.push('');
    lines.push('【我目前實際持有這檔股票的部位資訊——僅供背景參考（部位規模／風險曝險程度），我可以長期持有、能承受短期股價波動，請不要把這組數字當成決策的主要依據，判斷基準是體質變化，不是損益】');
    lines.push('加權平均成本：' + holding.cost);
    lines.push('最早買進日期：' + holding.buyDate + '（已持有 ' + holding.daysHeld + ' 天）');
    if (holding.profitPct !== null && holding.profitPct !== undefined) {
      lines.push('目前未實現損益：' + (holding.profitPct >= 0 ? '+' : '') + holding.profitPct + '%');
    }
  }
  lines.push('');
  lines.push('【證交所公開資訊觀測站官方資料（openapi.twse.com.tw，官方 API 直接查詢，可信度最高，' +
    '缺漏或跟其他來源衝突時以這裡為準）】');
  lines.push(twseOfficialText);
  lines.push('');
  lines.push('【Goodinfo 個股頁面文字摘要（程式自動抓取，可能不完整，僅供輔助參考）】');
  lines.push(goodinfoText);
  lines.push('');
  lines.push(holding
    ? '請依照系統設定的規則與輸出格式，針對「我目前持有的這筆部位」進行完整的續抱評估。'
    : '請依照系統設定的規則與輸出格式，針對這檔股票進行完整的第二層深度診斷。');
  return lines.join('\n');
}

/** 新進場決策（深度診斷）跟持股續抱決策是兩套不同的決策分類，文字完全不重疊，直接合併
 *  成一份清單搜尋即可，不用另外傳「這是哪一種診斷」進來判斷——跟 apps-script 版
 *  AI_VERDICT_OPTIONS_ 同一份清單。 */
var AI_VERDICT_OPTIONS_ = [
  '強力買入', '分批布局', '觀望不追', '立刻退出',
  '體質轉強，加碼', '體質穩健，續抱', '體質轉弱，減碼', '體質惡化，出場'
];

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

// ---------------- 每日自動 AI 診斷：候選名單橫向比較 + TOP3 橫向推薦 ----------------

/**
 * 橫向比較用的候選名單 prompt：跟 AI_TOP_PICKS_SYSTEM_PROMPT（Top3 推薦）是類似的初篩
 * 邏輯，但這裡輸出的是一份「全部都要送進深度診斷」的候選名單，不是最終建議，所以不用
 * 獎牌排名的敘事格式，改成固定行數的編號清單，方便程式解析，名單大小由 __COUNT__
 * 控制（對應 `config/app.aiDailyTopN`）。跟 apps-script 版
 * AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE 逐字一致。
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

# Output Format（請嚴格使用以下結構，正好 __COUNT__ 行，不要多也不要少，不要加其他文字，
不要用 Markdown 粗體/斜體/程式碼區塊包住編號或代號，每行開頭一定是純數字加半形句點）
1. 代號 名稱 - 入選理由（一句話）
2. 代號 名稱 - 入選理由（一句話）
（依此類推，共 __COUNT__ 行）`;

/**
 * 候選列：`reports/{date}/signals` 的文件形狀（英文欄名），跟 `buildDiagnosisPrompt_` 的
 * row 同一套欄位來源，但這裡是一整份清單（候選名單橫向比較跟 Top3 推薦都要看到「所有
 * 候選排在一起互相比較」，不是單一個股）。
 */
function buildShortlistPrompt_(candidates, timestampLabel, count) {
  var lines = [];
  lines.push('比較基準時間戳記：' + timestampLabel);
  lines.push('');
  lines.push('【本次戰報全部候選清單，共 ' + candidates.length + ' 檔，依 Armor_Score 高到低排序】');
  candidates.forEach(function (r, i) {
    lines.push(
      (i + 1) + '. ' + r.code + ' ' + r.name +
      '｜Armor_Score=' + r.armorScore +
      '｜操作策略=' + r.strategy +
      '｜Trend_Score=' + r.trendScore +
      '｜法人參與密度排名=' + r.instPartRank +
      '｜下跌接手率排名=' + r.ibf20dRank +
      '｜實相解讀=' + r.interpretation
    );
  });
  lines.push('');
  lines.push('請依照系統設定的規則與輸出格式，從這份清單挑出 ' + count + ' 檔送進深度診斷的候選名單。');
  return lines.join('\n');
}

/**
 * 從 `AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE` 規定的編號清單格式（「N. 代號 名稱 - 理由」）
 * 取出股票代號。prompt 已經明確要求「純數字加半形句點」開頭、不要用 Markdown 格式，但
 * LLM 偶爾還是會不聽話（例如把編號包成 **1.**、改用全形句點「、」或括號「1)」）——這裡
 * 先把每行常見的 Markdown 強調符號（*_`）拿掉，並放寬編號後面的分隔符號（. 、 )）都算
 * 合法，降低因為這種小格式落差就整批解析失敗、害這次候選名單完全沒東西可以送進深度診斷
 * 的機率。真的完全解析不出任何一行時，回傳空陣列，呼叫端決定要怎麼處理（通常是把原始
 * 文字片段一起記進錯誤訊息）。跟 apps-script 版 extractShortlistCodes_ 逐字一致。
 */
function extractShortlistCodes_(text, maxCount) {
  if (!text) return [];
  var re = /^\d+[.、)]\s*(\d{3,6})/;
  var codes = [];
  String(text).split('\n').forEach(function (line) {
    var cleaned = line.trim().replace(/[*_`]/g, '');
    var m = re.exec(cleaned);
    if (m) codes.push(utils.zfill4(m[1]));
  });
  return maxCount ? codes.slice(0, maxCount) : codes;
}

/**
 * 跟 AI_DIAGNOSIS_SYSTEM_PROMPT（單檔深度診斷）是不同量級的任務：這裡不對每一檔候選都
 * 額外抓 Goodinfo/查 5 年財報，只用戰報本身已經算好的量化欄位，讓模型在整份候選名單裡
 * 做「橫向比較」，選出最值得優先投入的前三檔並說明取捨——這是初篩層級的比較，選出來
 * 之後還是要對這幾檔分別執行「AI 深度診斷」做完整的財報/籌碼查核。跟 apps-script 版
 * AI_TOP_PICKS_SYSTEM_PROMPT 逐字一致。
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
      (i + 1) + '. ' + r.code + ' ' + r.name +
      '｜Armor_Score=' + r.armorScore +
      '｜操作策略=' + r.strategy +
      '｜Trend_Score=' + r.trendScore +
      '｜法人參與密度排名=' + r.instPartRank +
      '｜下跌接手率排名=' + r.ibf20dRank +
      '｜實相解讀=' + r.interpretation
    );
  });
  lines.push('');
  lines.push('請依照系統設定的規則與輸出格式，從這份清單挑出最值得優先投入的前三檔。');
  return lines.join('\n');
}

module.exports = {
  AI_DIAGNOSIS_SYSTEM_PROMPT: AI_DIAGNOSIS_SYSTEM_PROMPT,
  AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT: AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT,
  AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE: AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE,
  AI_TOP_PICKS_SYSTEM_PROMPT: AI_TOP_PICKS_SYSTEM_PROMPT,
  buildTwseOfficialFinancialsTextForCode_: buildTwseOfficialFinancialsTextForCode_,
  buildDiagnosisPrompt_: buildDiagnosisPrompt_,
  buildShortlistPrompt_: buildShortlistPrompt_,
  buildTopPicksPrompt_: buildTopPicksPrompt_,
  extractShortlistCodes_: extractShortlistCodes_,
  extractVerdict_: extractVerdict_,
  extractCoreReason_: extractCoreReason_,
  calcCost_: calcCost_
};
