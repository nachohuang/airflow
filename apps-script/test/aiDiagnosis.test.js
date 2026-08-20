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

// fetchTwseOfficialFinancialsDatasets_ 用的 UrlFetchApp stub：可以每個測試各自覆寫 fetch
// 行為、順便計算呼叫次數，驗證「整批只抓一次」這個優化本身有沒有真的生效（不是只驗證輸出
// 內容對，呼叫次數才是這次優化實際要驗證的東西）。
var fetchImpl = null;
var fetchCallLog = [];
const UrlFetchApp = {
  fetch: function (url, opts) {
    fetchCallLog.push(url);
    return fetchImpl(url, opts);
  }
};

// createAiDiagnosisBatchUpserter_ 需要真的走一次 getAiDiagnosisSheet_ -> ensureSheetWithHeaders_
// -> getSpreadsheet_ -> SpreadsheetApp.openById 這條鏈，才能驗證「多數情況直接 append、只有
// 撞到既有紀錄才整份重寫」這個分支邏輯本身有沒有正確運作（這是這次優化最容易寫錯、也最需要
// 驗證「沒有造成新問題」的地方：一旦分支邏輯錯了，可能悄悄產生重複列或蓋掉別的紀錄）。用一個
// 最小的記憶體版假 Sheet，撐住 readSheetObjects_/writeSheetObjects_/appendSheetObjects_ 實際會
// 呼叫的 getRange/getValues/setValues/clearContents 這幾個方法，不用真的接 Google Sheets。
function makeFakeSheet_() {
  var grid = [];
  var clearContentsCallCount = 0;
  return {
    getLastRow: function () { return grid.length; },
    getLastColumn: function () { return grid.length ? grid[0].length : 0; },
    getRange: function (row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getValues: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) {
            var rowArr = grid[row - 1 + r] || [];
            var line = [];
            for (var c = 0; c < numCols; c++) line.push(rowArr[col - 1 + c] !== undefined ? rowArr[col - 1 + c] : '');
            out.push(line);
          }
          return out;
        },
        setValues: function (values) {
          for (var r = 0; r < values.length; r++) {
            var targetRow = row - 1 + r;
            while (grid.length <= targetRow) grid.push([]);
            for (var c = 0; c < values[r].length; c++) grid[targetRow][col - 1 + c] = values[r][c];
          }
        }
      };
    },
    clearContents: function () { grid = []; clearContentsCallCount++; },
    setFrozenRows: function () {},
    _clearContentsCallCount: function () { return clearContentsCallCount; }
  };
}

var fakeSheets = {};
const SpreadsheetApp = {
  openById: function () {
    return {
      getSheetByName: function (name) { return fakeSheets[name] || null; },
      insertSheet: function (name) { var s = makeFakeSheet_(); fakeSheets[name] = s; return s; }
    };
  }
};

// 載入 SheetUtils.gs 之後，裡面的真正 logRun_ 定義會蓋掉這裡先設的 stub（跟正式環境同一個
// vm context 共用全域一樣），真正版本會呼叫 Utilities.formatDate——補一個最小可用的實作，
// 不用精確到時區，只要不噴例外、格式看起來對就好，這幾個測試都不斷言記錄下來的文字內容。
const Utilities = {
  formatDate: function (date, tz, fmt) {
    function pad(n) { return String(n).padStart(2, '0'); }
    return fmt
      .replace('yyyy', date.getFullYear())
      .replace('MM', pad(date.getMonth() + 1))
      .replace('dd', pad(date.getDate()))
      .replace('HH', pad(date.getHours()))
      .replace('mm', pad(date.getMinutes()))
      .replace('ss', pad(date.getSeconds()));
  }
};

const context = {
  console: console, PropertiesService: PropertiesService, logRun_: function () {},
  UrlFetchApp: UrlFetchApp, SpreadsheetApp: SpreadsheetApp, Utilities: Utilities
};
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('SheetUtils.gs');
loadIntoContext('Analysis.gs'); // getReportsSheet_／getLatestReportCandidates_ 用
loadIntoContext('AiDiagnosis.gs');
fakeProps[context.CONFIG.PROP_KEYS.SPREADSHEET_ID] = 'fake-spreadsheet-id'; // 讓 getSpreadsheet_ 走 openById 這條路，不會嘗試真的 SpreadsheetApp.create

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

// --- 4. extractVerdict_ 抓取最終建議關鍵字：新進場（買不買）跟持股續抱（怎麼處理現有部位）
//    兩套決策分類都要認得 ---
{
  const text = '一些分析文字...\n> 💡 **最終建議：** 【分批布局】\n> **核心理由：** blah';
  assert.strictEqual(context.extractVerdict_(text), '分批布局');
  assert.strictEqual(context.extractVerdict_('沒有關鍵字的文字'), '未明確');

  const holdingText = '> 💡 **最終建議：** 【觸發止損平倉】\n> **核心理由：** 虧損擴大且籌碼轉弱';
  assert.strictEqual(context.extractVerdict_(holdingText), '觸發止損平倉', '持股續抱的決策分類也要認得');
  assert.strictEqual(context.extractVerdict_('> 💡 **最終建議：** 【強力續抱】'), '強力續抱');
  console.log('Test 4 (extractVerdict_) passed.');
}

// --- 4b. extractCoreReason_：決策結論置頂橫幅用，抓「核心理由」那一行的內容 ---
{
  const text = '> 💡 **最終建議：** 【分批布局】\n> **核心理由：** 法人連續買超且技術面站穩月線，適合分批進場。';
  assert.strictEqual(context.extractCoreReason_(text), '法人連續買超且技術面站穩月線，適合分批進場。');
  assert.strictEqual(context.extractCoreReason_('沒有核心理由這行文字'), '', '抓不到就回傳空字串，不能拋例外');
  assert.strictEqual(context.extractCoreReason_(''), '');
  console.log('Test 4b (extractCoreReason_) passed.');
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

// --- 8. getAiDiagnosisHistoryForCodes_：批次版本的核心純函式（不含讀表本身）——「戰報與
//    個股」／「持股庫存」原本一次要顯示 N 檔股票就各自呼叫一次單筆版本、各自把整份表格
//    掃描一次，是這兩個頁面讀取超慢的主因，改成只讀一次表、依代號分組回傳。這裡驗證分組
//    邏輯本身：多檔股票各自的紀錄要分開、依日期新到舊排序、代號要補零成 4 碼比對、查無
//    資料的代號要回傳空陣列（不是 undefined）、不在查詢清單內的代號要被忽略。 ---
{
  const rows = [
    { '證券代號': '2330', '日期': '2026-08-01', '最終建議': '分批布局', '診斷類型': '深度診斷', '診斷內容': 'a', 'Armor_Score': '80', '時間戳記': '' },
    { '證券代號': '2330', '日期': '2026-08-05', '最終建議': '觀望不追', '診斷類型': '深度診斷', '診斷內容': 'b', 'Armor_Score': '70', '時間戳記': '' },
    { '證券代號': '2603', '日期': '2026-08-03', '最終建議': '立刻退出', '診斷類型': '深度診斷', '診斷內容': 'c', 'Armor_Score': '60', '時間戳記': '' },
    // 這筆代號不在查詢清單內（只查 2330/2603/0330），要被忽略，不能混進任何一檔的結果裡
    { '證券代號': '9999', '日期': '2026-08-04', '最終建議': '分批布局', '診斷類型': '深度診斷', '診斷內容': 'd', 'Armor_Score': '50', '時間戳記': '' }
  ];
  const result = context.getAiDiagnosisHistoryForCodes_(rows, ['2330', '2603', '330']);

  assert.strictEqual(result['2330'].length, 2, '2330 應該有兩筆，且不該混進其他代號的紀錄');
  // vm context 產生的陣列跟外層 Node realm 的 Array 建構子不同（跟本檔案 extractShortlistCodes_
  // 測試碰過的 cross-realm 問題一樣），deepStrictEqual 對建構子比對很嚴格，用 spread 複製成
  // 外層陣列再比對。
  assert.deepStrictEqual([...result['2330'].map(function (h) { return h.date; })], ['2026-08-05', '2026-08-01'], '同一檔股票要依日期新到舊排序');
  assert.strictEqual(result['2330'][0].verdict, '觀望不追');

  assert.strictEqual(result['2603'].length, 1);
  assert.strictEqual(result['2603'][0].verdict, '立刻退出');

  assert.deepStrictEqual([...result['0330']], [], '查無資料的代號要回傳空陣列，不是 undefined，前端才不用額外判斷');
  assert.strictEqual(Object.keys(result).length, 3, '不在查詢清單內的代號（9999）不該出現在回傳結果的 key 裡');
  console.log('Test 8 (getAiDiagnosisHistoryForCodes_) passed.');
}

// --- 9. buildTwseOfficialFinancialsTextForCode_：純函式，從「已經抓好的」3 份全市場資料集
//    篩出單一代號要用的文字——這是把 fetchTwseOfficialFinancialsText_ 拆成「抓資料」跟
//    「篩選/組字」兩段之後，可以獨立測試的核心邏輯，不用真的打網路 ---
{
  const datasets = [
    { label: '上市公司每月營業收入彙總表', rows: [
      { '公司代號': '2330', '公司名稱': '台積電', '營業收入': '1000000' },
      { '公司代號': '2603', '公司名稱': '長榮', '營業收入': '500000' }
    ] },
    { label: '上市公司綜合損益表（一般業）', rows: [
      { '公司代號': '2330', '本期淨利': '400000' }
    ] },
    { label: '上市公司資產負債表（一般業）', rows: [] } // 這個資料集剛好篩不到任何列（例如暫時性失敗)
  ];
  const text2330 = context.buildTwseOfficialFinancialsTextForCode_('2330', datasets);
  assert.ok(text2330.indexOf('上市公司每月營業收入彙總表') !== -1);
  assert.ok(text2330.indexOf('公司代號：2330') !== -1);
  assert.ok(text2330.indexOf('本期淨利：400000') !== -1);
  assert.ok(text2330.indexOf('長榮') === -1, '不該混進其他代號的資料');

  const textMissing = context.buildTwseOfficialFinancialsTextForCode_('9999', datasets);
  assert.ok(textMissing.indexOf('查無此股票代號') !== -1, '三份資料集都篩不到時要回傳明確的缺漏說明，不能拋例外或回傳空字串');
  console.log('Test 9 (buildTwseOfficialFinancialsTextForCode_) passed.');
}

// --- 10. fetchTwseOfficialFinancialsDatasets_：3 個資料集各自獨立抓取，單一資料集失敗
//    （非 200 / 例外 / 回傳不是陣列）不該影響其他資料集，也不該讓整支函式拋例外 ---
{
  fetchCallLog.length = 0;
  var urls = context.TWSE_OFFICIAL_FINANCIALS_DATASETS_.map(function (d) { return d.url; });
  fetchImpl = function (url) {
    if (url === urls[0]) {
      return { getResponseCode: function () { return 200; }, getContentText: function () { return JSON.stringify([{ '公司代號': '2330', '營業收入': '1000000' }]); } };
    }
    if (url === urls[1]) {
      return { getResponseCode: function () { return 500; }, getContentText: function () { return 'error'; } }; // 非 200，該資料集要回空陣列
    }
    throw new Error('模擬逾時'); // 第三個資料集直接拋例外，也要被吃掉
  };
  const datasets = context.fetchTwseOfficialFinancialsDatasets_();
  assert.strictEqual(fetchCallLog.length, 3, '3 個資料集都要各打一次');
  assert.strictEqual(datasets.length, 3);
  assert.strictEqual(datasets[0].rows.length, 1, '成功的資料集要正常回傳解析後的列');
  assert.deepStrictEqual([...datasets[1].rows], [], '非 200 的資料集要回空陣列，不拋例外');
  assert.deepStrictEqual([...datasets[2].rows], [], '拋例外的資料集也要被吃掉、回空陣列，不能讓整支函式跟著掛掉');
  console.log('Test 10 (fetchTwseOfficialFinancialsDatasets_ per-dataset failure isolation) passed.');
}

// --- 11. 這次優化要驗證的核心行為：對一批股票代號跑診斷時，3 份全市場資料集只應該抓
//    「一次」，不是「每檔股票各抓一次」——runAiDiagnosis 原本的寫法是迴圈裡每檔股票各自呼叫
//    fetchTwseOfficialFinancialsText_(code)，等於 N 檔股票就打 3N 次網路；改成迴圈外先呼叫
//    fetchTwseOfficialFinancialsDatasets_() 一次，迴圈內只呼叫不打網路的
//    buildTwseOfficialFinancialsTextForCode_ ---
{
  fetchCallLog.length = 0;
  var urls2 = context.TWSE_OFFICIAL_FINANCIALS_DATASETS_.map(function (d) { return d.url; });
  fetchImpl = function (url) {
    var idx = urls2.indexOf(url);
    var rowsByIdx = [
      [{ '公司代號': '2330', 'X': '1' }, { '公司代號': '2603', 'X': '2' }],
      [{ '公司代號': '2330', 'Y': '3' }],
      [{ '公司代號': '2603', 'Z': '4' }]
    ];
    return { getResponseCode: function () { return 200; }, getContentText: function () { return JSON.stringify(rowsByIdx[idx]); } };
  };
  const datasets = context.fetchTwseOfficialFinancialsDatasets_();
  assert.strictEqual(fetchCallLog.length, 3, '抓 datasets 這一次應該剛好打 3 次網路');

  // 模擬 runAiDiagnosis 對 5 檔股票的迴圈，每檔都用同一份 datasets 篩選
  var codes = ['2330', '2603', '0330', '9910', '1101'];
  var texts = codes.map(function (c) { return context.buildTwseOfficialFinancialsTextForCode_(c, datasets); });
  assert.strictEqual(fetchCallLog.length, 3, '批次篩選 5 檔股票之後，網路呼叫次數應該還是 3 次，不會隨股票數增加');
  assert.ok(texts[0].indexOf('公司代號：2330') !== -1 && texts[0].indexOf('X：1') !== -1 && texts[0].indexOf('Y：3') !== -1, '2330 要拿到自己在營收表跟損益表的資料');
  assert.ok(texts[1].indexOf('公司代號：2603') !== -1 && texts[1].indexOf('Z：4') !== -1, '2603 要拿到自己在資產負債表的資料');
  assert.ok(texts[0].indexOf('公司代號：2603') === -1, '2330 的結果不該混進 2603 的列');
  console.log('Test 11 (batched datasets fetched once, reused across N codes with zero extra network calls) passed.');
}

// --- 12. fetchTwseOfficialFinancialsText_（單一代號版本，給 runPortfolioHoldDiagnosis 這種
//    一次只診斷一檔的呼叫端用，沒有批次可以攤提）內部還是會抓 3 次網路，但輸出結果要跟
//    「批次版本篩同一個代號」完全一致，確認拆分後兩條路徑邏輯沒有跑掉 ---
{
  fetchCallLog.length = 0;
  var urls3 = context.TWSE_OFFICIAL_FINANCIALS_DATASETS_.map(function (d) { return d.url; });
  fetchImpl = function (url) {
    var idx = urls3.indexOf(url);
    var rowsByIdx = [[{ '公司代號': '2330', 'X': '1' }], [{ '公司代號': '2330', 'Y': '2' }], []];
    return { getResponseCode: function () { return 200; }, getContentText: function () { return JSON.stringify(rowsByIdx[idx]); } };
  };
  const singleText = context.fetchTwseOfficialFinancialsText_('2330');
  assert.strictEqual(fetchCallLog.length, 3, '單一代號版本沒有批次可以攤提，還是要打 3 次');

  fetchCallLog.length = 0;
  const datasets = context.fetchTwseOfficialFinancialsDatasets_();
  const batchedText = context.buildTwseOfficialFinancialsTextForCode_('2330', datasets);
  assert.strictEqual(singleText, batchedText, '單一代號版本跟批次版本篩同一個代號，結果要完全一致');
  console.log('Test 12 (single-code wrapper output matches batched path) passed.');
}

// --- 13. pickLatestReportRowsByCode_：純函式，從「已經讀出來的」整份 Reports 表依代號分組，
//    each 找出「這個代號最新一天」的那一列——runAiDiagnosis 對一批候選股票跑診斷時用這支
//    一次找出全部代號的最新列，不要 N 檔股票各自呼叫 getLatestReportRowForCode_（那樣是
//    N 次「整份表格掃描」） ---
{
  const rows = [
    { '證券代號': '2330', '日期': '2026-08-01', 'Armor_Score': 80 },
    { '證券代號': '2330', '日期': '2026-08-05', 'Armor_Score': 90 }, // 2330 最新一天
    { '證券代號': '2603', '日期': '2026-08-03', 'Armor_Score': 70 },
    // 這筆代號不在查詢清單內（只查 2330/2603/0330），要被忽略
    { '證券代號': '9999', '日期': '2026-08-04', 'Armor_Score': 60 }
  ];
  const result = context.pickLatestReportRowsByCode_(rows, ['2330', '2603', '330']);
  assert.strictEqual(result['2330']['日期'], '2026-08-05', '同一代號要挑「最新一天」那一列，不是隨便一列');
  assert.strictEqual(result['2330']['Armor_Score'], 90);
  assert.strictEqual(result['2603']['日期'], '2026-08-03');
  assert.strictEqual(result['0330'], null, '查無資料的代號要回傳 null，不是 undefined，呼叫端才不用額外判斷');
  assert.strictEqual(Object.keys(result).length, 3, '不在查詢清單內的代號（9999）不該出現在回傳結果的 key 裡');
  console.log('Test 13 (pickLatestReportRowsByCode_) passed.');
}

// --- 14. aiDiagnosisRowKey_：跟 upsertAiDiagnosisRow_ 原本「代號+日期+診斷類型」的比對邏輯
//    要一致，且對已經正規化過的既有列跟新記錄套用同一個 key 函式要得到相同的 key（idempotent）---
{
  const existingRow = { '證券代號': '2330', '日期': '2026-08-05', '診斷類型': '深度診斷' };
  const newRecord = { '證券代號': '2330', '日期': '2026-08-05', '診斷類型': '深度診斷' };
  assert.strictEqual(context.aiDiagnosisRowKey_(existingRow), context.aiDiagnosisRowKey_(newRecord), '同一筆邏輯上的紀錄，兩邊算出來的 key 要一樣');
  assert.notStrictEqual(
    context.aiDiagnosisRowKey_({ '證券代號': '2330', '日期': '2026-08-05', '診斷類型': '深度診斷' }),
    context.aiDiagnosisRowKey_({ '證券代號': '2330', '日期': '2026-08-05', '診斷類型': '持股續抱診斷' }),
    '同一天同一檔股票但診斷類型不同，要是不同的 key（不能互相覆蓋）'
  );
  assert.strictEqual(
    context.aiDiagnosisRowKey_({ '證券代號': '2330', '日期': '2026-08-05' }),
    context.aiDiagnosisRowKey_({ '證券代號': '2330', '日期': '2026-08-05', '診斷類型': '深度診斷' }),
    '沒帶診斷類型要預設視為深度診斷，對應改版前的舊資料'
  );
  console.log('Test 14 (aiDiagnosisRowKey_) passed.');
}

// --- 15. createAiDiagnosisBatchUpserter_：這次優化裡最需要驗證「沒有造成新問題」的部分——
//    多數情況（新的 代號+日期+診斷類型 組合）要直接 append，不整份重寫；只有真的撞到既有
//    紀錄才整份重寫；同一個批次裡如果撞到自己剛剛才新增的那筆（例如候選名單代號重複），
//    也要正確處理、不能產生重複列 ---
{
  fakeSheets = {}; // 每個測試案例用全新的假 Sheet，不共用前一個測試案例殘留的資料
  var sheet = context.getAiDiagnosisSheet_();
  // 預先塞一筆既有紀錄：2330 在 2026-08-05 已經跑過深度診斷
  context.writeSheetObjects_(sheet, context.CONFIG.AI_DIAGNOSIS_COLUMNS, [{
    '日期': '2026-08-05', '證券代號': '2330', '證券名稱': '台積電', 'Armor_Score': 80,
    '操作策略': '', '最終建議': '分批布局', '診斷類型': '深度診斷', '診斷內容': '舊的診斷內容', '時間戳記': ''
  }]);
  var clearCountBeforeUpserter = sheet._clearContentsCallCount();

  var upsert = context.createAiDiagnosisBatchUpserter_();

  // (a) 全新的 代號+日期+診斷類型 組合 -> 應該直接 append，不觸發整份重寫（clearContents 不會被呼叫）
  upsert({
    '日期': '2026-08-05', '證券代號': '2603', '證券名稱': '長榮', 'Armor_Score': 70,
    '操作策略': '', '最終建議': '分批布局', '診斷類型': '深度診斷', '診斷內容': '2603 的新診斷', '時間戳記': ''
  });
  var rowsAfterA = context.readSheetObjects_(sheet);
  assert.strictEqual(rowsAfterA.length, 2, '新增一筆新的代號，總列數應該是 1(既有) + 1(新增) = 2');
  assert.strictEqual(sheet._clearContentsCallCount(), clearCountBeforeUpserter, '全新組合應該走 append 路徑，不該觸發整份重寫（clearContents 不該被呼叫）');

  // (b) 撞到既有紀錄（2330 同一天同一種診斷類型）-> 應該退回整份重寫路徑，內容被正確取代、
  //     不會產生重複列
  upsert({
    '日期': '2026-08-05', '證券代號': '2330', '證券名稱': '台積電', 'Armor_Score': 85,
    '操作策略': '', '最終建議': '強力買入', '診斷類型': '深度診斷', '診斷內容': '2330 的新診斷（取代舊的）', '時間戳記': ''
  });
  var rowsAfterB = context.readSheetObjects_(sheet);
  assert.strictEqual(rowsAfterB.length, 2, '撞到既有紀錄是「取代」不是「新增」，總列數應該還是 2，不是 3');
  var row2330 = rowsAfterB.filter(function (r) { return r['證券代號'] === '2330'; });
  assert.strictEqual(row2330.length, 1, '2330 不該有重複列');
  assert.strictEqual(row2330[0]['診斷內容'], '2330 的新診斷（取代舊的）', '舊內容要被新的取代');
  assert.strictEqual(row2330[0]['最終建議'], '強力買入');

  // (c) 同一批次裡再對「剛剛才新增的」2603 用同一個 key 呼叫一次（模擬候選名單代號重複的
  //     邊界情況）-> 也要被偵測到是撞到既有紀錄（這次是撞到同一批次裡自己剛新增的那筆），
  //     退回整份重寫，不能產生重複列
  upsert({
    '日期': '2026-08-05', '證券代號': '2603', '證券名稱': '長榮', 'Armor_Score': 72,
    '操作策略': '', '最終建議': '強力買入', '診斷類型': '深度診斷', '診斷內容': '2603 同批次重複呼叫', '時間戳記': ''
  });
  var rowsAfterC = context.readSheetObjects_(sheet);
  assert.strictEqual(rowsAfterC.length, 2, '同一批次重複撞到自己剛新增的那筆，也要是取代、不是新增，總列數維持 2');
  var row2603 = rowsAfterC.filter(function (r) { return r['證券代號'] === '2603'; });
  assert.strictEqual(row2603.length, 1, '2603 不該有重複列');
  assert.strictEqual(row2603[0]['診斷內容'], '2603 同批次重複呼叫');

  console.log('Test 15 (createAiDiagnosisBatchUpserter_ — append for new keys, safe fallback for collisions, no duplicate rows) passed.');
}

// --- 16. calcCost_ 加上 prompt caching 的計費倍率之後：(a) 沒帶第 4 個參數／帶了但都是 0，
//    算出來的費用要跟開快取以前完全一樣（向後相容，其他呼叫端沒改也不受影響）；(b) 帶了
//    cache_creation/cache_read tokens 時，要分別用 1.25 倍／0.1 倍 base 輸入單價計算，不能
//    直接漏掉（漏掉就會低估實際費用，Anthropic 這兩類 tokens 一樣要計費）---
{
  const withoutCache = context.calcCost_('claude', 1000000, 0);
  const withZeroCache = context.calcCost_('claude', 1000000, 0, { cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
  const withUndefinedFields = context.calcCost_('claude', 1000000, 0, {});
  const withNoFourthArg = context.calcCost_('claude', 1000000, 0);
  assert.ok(approxEqual(withoutCache, withZeroCache), '沒帶 cacheTokens 跟帶了全 0 的 cacheTokens，費用要一樣');
  assert.ok(approxEqual(withoutCache, withUndefinedFields), '帶空物件（欄位都是 undefined）也要當作 0，不能是 NaN');
  assert.ok(approxEqual(withoutCache, withNoFourthArg), '這是既有呼叫端（B3 這次沒改的其餘呼叫端）的向後相容基準');

  const pricing = context.getPricingSettings();
  const withCache = context.calcCost_('claude', 0, 0, { cacheCreationInputTokens: 1000000, cacheReadInputTokens: 1000000 });
  const expectedCacheCost = (1000000 / 1e6) * pricing.claudeInputPerM * 1.25 + (1000000 / 1e6) * pricing.claudeInputPerM * 0.1;
  assert.ok(approxEqual(withCache, expectedCacheCost), 'got ' + withCache + ' expected ' + expectedCacheCost + '：cache_creation 要算 1.25 倍、cache_read 要算 0.1 倍 base 輸入單價');

  const geminiWithCache = context.calcCost_('gemini', 1000000, 0, { cacheCreationInputTokens: 1000000, cacheReadInputTokens: 1000000 });
  const geminiWithoutCache = context.calcCost_('gemini', 1000000, 0);
  assert.ok(approxEqual(geminiWithCache, geminiWithoutCache + (1000000 / 1e6) * pricing.geminiInputPerM * 1.35), 'Gemini 呼叫端目前不會帶 cache tokens，但萬一帶了也要照 Gemini 自己的單價算，不能誤用 Claude 單價');
  console.log('Test 16 (calcCost_ prompt-caching-aware pricing, backward compatible) passed.');
}

// --- 17. callClaude_：system prompt 要用 cache_control 包住的陣列格式送出（不是純字串），
//    且要正確把回應裡的 cache_creation_input_tokens／cache_read_input_tokens 解析進回傳值——
//    這兩個數字接下來會餵給 calcCost_ 算費用，解析錯了費用估算就會跟著錯 ---
{
  fakeProps[context.CONFIG.PROP_KEYS.ANTHROPIC_API_KEY] = 'fake-key';
  var capturedPayload = null;
  fetchImpl = function (url, opts) {
    capturedPayload = JSON.parse(opts.payload);
    return {
      getResponseCode: function () { return 200; },
      getContentText: function () {
        return JSON.stringify({
          content: [{ text: '診斷內容' }],
          usage: { input_tokens: 50, output_tokens: 200, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 }
        });
      }
    };
  };
  const result = context.callClaude_('系統提示詞', '使用者提示詞');
  assert.ok(Array.isArray(capturedPayload.system), 'system 欄位要是陣列格式，不能是純字串，才能帶 cache_control');
  assert.strictEqual(capturedPayload.system[0].text, '系統提示詞');
  assert.strictEqual(capturedPayload.system[0].cache_control.type, 'ephemeral');
  assert.strictEqual(result.inputTokens, 50);
  assert.strictEqual(result.outputTokens, 200);
  assert.strictEqual(result.cacheCreationInputTokens, 900, '要正確解析 cache_creation_input_tokens，不能漏掉');
  assert.strictEqual(result.cacheReadInputTokens, 0);
  console.log('Test 17 (callClaude_ sends cache_control, parses cache usage fields) passed.');
}

// --- 17b. 回應完全沒有 cache 相關欄位時（例如剛好這次沒命中任何快取邏輯、或 Anthropic 之後
//    改回應格式），cacheCreationInputTokens／cacheReadInputTokens 要預設 0，不能是 undefined
//    或 NaN 一路傳到 calcCost_ 裡 ---
{
  fetchImpl = function () {
    return {
      getResponseCode: function () { return 200; },
      getContentText: function () { return JSON.stringify({ content: [{ text: 'x' }], usage: { input_tokens: 10, output_tokens: 5 } }); }
    };
  };
  const result = context.callClaude_('系統提示詞', '使用者提示詞');
  assert.strictEqual(result.cacheCreationInputTokens, 0);
  assert.strictEqual(result.cacheReadInputTokens, 0);
  const cost = context.calcCost_(result.provider, result.inputTokens, result.outputTokens,
    { cacheCreationInputTokens: result.cacheCreationInputTokens, cacheReadInputTokens: result.cacheReadInputTokens });
  assert.ok(!Number.isNaN(cost), '沒有 cache 欄位時，算出來的費用不能是 NaN');
  console.log('Test 17b (callClaude_ defaults missing cache fields to 0) passed.');
}

// --- 18. getLatestReportCandidates_：從 runAiShortlist_／runAiTopPicks 兩邊原本各自重複
//    一份的「讀 Reports 表→找最新一天→篩選→依 Armor_Score 排序」邏輯抽出來的共用函式，
//    驗證抽出來之後邏輯還是完全一樣 ---
{
  fakeSheets = {};
  var sheet = context.getReportsSheet_();
  context.writeSheetObjects_(sheet, context.CONFIG.REPORT_COLUMNS, [
    { '日期': '2026-08-01', '證券代號': '2330', '證券名稱': '台積電', 'Armor_Score': 80 },
    { '日期': '2026-08-05', '證券代號': '2603', '證券名稱': '長榮', 'Armor_Score': 95 }, // 最新一天，分數最高
    { '日期': '2026-08-05', '證券代號': '2330', '證券名稱': '台積電', 'Armor_Score': 90 }, // 最新一天，分數次高
    { '日期': '2026-08-03', '證券代號': '1101', '證券名稱': '台泥', 'Armor_Score': 99 } // 分數最高但不是最新一天，不該入選
  ]);
  var result = context.getLatestReportCandidates_();
  assert.strictEqual(result.latestDate, '2026-08-05', '要挑出全表裡最新的日期');
  assert.strictEqual(result.candidates.length, 2, '只有最新一天的列才算候選，1101 那筆（較早日期）不該混進來');
  assert.strictEqual(result.candidates[0]['證券代號'], '2603', '要依 Armor_Score 高到低排序');
  assert.strictEqual(result.candidates[1]['證券代號'], '2330');

  fakeSheets = {};
  context.getReportsSheet_(); // 建立一張空表（只有標題列）
  assert.throws(function () { context.getLatestReportCandidates_(); }, /目前沒有任何戰報資料/, '完全沒有戰報資料要拋出明確的錯誤，不能靜默回傳空結果');
  console.log('Test 18 (getLatestReportCandidates_) passed.');
}

// --- 19. runAiDiagnosis：budgetDeadline 已經過期時，逐檔迴圈要在開始「第一檔」之前就
//    收手，全部代號標記成 skipped 正常回傳（不拋例外），且不該對任何一檔實際呼叫 Goodinfo／
//    LLM API——這是 2026-08-20 線上事故的修復：每日自動 AI 診斷對好幾檔股票各自呼叫外部
//    AI API，單一步驟內部撞上 Apps Script 6 分鐘硬上限，job 卡片卡在「執行中」不會顯示
//    完成，資料本身雖然沒有遺失（每檔完成就立刻寫進表），但排程的「完成」狀態永遠沒機會
//    被儲存。這裡驗證：deadline 已過期時，連第一檔都不該真的發送外部請求。 ---
{
  fakeSheets = {};
  fetchCallLog.length = 0;
  var urls4 = context.TWSE_OFFICIAL_FINANCIALS_DATASETS_.map(function (d) { return d.url; });
  fetchImpl = function (url) {
    // 批次資料集的前置抓取是迴圈「外」一次性的準備工作（見 runAiDiagnosis 內的說明），不是
    // 逐檔迴圈本身，budgetDeadline 不影響它，這裡讓它正常回應空陣列即可；如果 Goodinfo 或
    // LLM API 這幾支被呼叫到，代表 skip 邏輯沒生效，直接丟例外讓測試失敗。
    if (urls4.indexOf(url) !== -1) {
      return { getResponseCode: function () { return 200; }, getContentText: function () { return JSON.stringify([]); } };
    }
    throw new Error('不該呼叫到這裡（Goodinfo 或 LLM API）——budgetDeadline 已過期，本次不該對任何一檔股票發送外部請求');
  };

  var pastDeadline = Date.now() - 1000;
  var results = context.runAiDiagnosis(['2330', '2603', '0330'], pastDeadline);

  assert.strictEqual(results.length, 3, '每個代號都要有對應結果，不能整批漏掉');
  results.forEach(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.skipped, true, 'budgetDeadline 已過期時，每一檔都要標記成 skipped');
  });
  console.log('Test 19 (runAiDiagnosis stops before an already-past budgetDeadline, skips remaining codes without hitting external APIs) passed.');
}

// --- 20. runAiDiagnosis：不帶 budgetDeadline（例如手動從「AI 診斷」按鈕觸發的
//    processAiDiagnosisJobTick_，維持原本行為）時，不該受任何預算檢查影響——這裡只驗證
//    skip 檢查本身不會誤觸發（沒帶 deadline 時 Date.now() >= undefined 永遠是 false），
//    不用真的走到 LLM 呼叫，用「找不到戰報資料」這個既有的錯誤路徑確認每一檔都有被
//    實際嘗試處理過（不是被 skip 掉），而不是因為預算檢查誤判而整批被跳過 ---
{
  fakeSheets = {};
  fetchCallLog.length = 0;
  var urls5 = context.TWSE_OFFICIAL_FINANCIALS_DATASETS_.map(function (d) { return d.url; });
  fetchImpl = function (url) {
    if (urls5.indexOf(url) !== -1) {
      return { getResponseCode: function () { return 200; }, getContentText: function () { return JSON.stringify([]); } };
    }
    throw new Error('這個測試案例不該打到 Goodinfo／LLM API（Reports 表是空的，會在拿到戰報資料列之前就先失敗）');
  };

  var results = context.runAiDiagnosis(['2330', '2603'], undefined);
  assert.strictEqual(results.length, 2);
  results.forEach(function (r) {
    assert.strictEqual(r.ok, false);
    assert.ok(!r.skipped, '沒帶 budgetDeadline 時，不該有任何一檔被標記成 skipped（要是真的被嘗試過、只是因為查無戰報資料才失敗）');
    assert.ok(r.error.indexOf('找不到這檔股票的戰報資料') !== -1, 'got: ' + r.error);
  });
  console.log('Test 20 (runAiDiagnosis without budgetDeadline is unaffected by the skip check) passed.');
}

console.log('All AiDiagnosis.gs tests passed.');
