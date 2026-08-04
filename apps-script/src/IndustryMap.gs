/**
 * IndustryMap.gs
 * 股票代號 → 產業別對照表：獨立的靜態參考資料，跟每天更新的 History（價格/法人買賣超）
 * 是不同性質的東西——公司產業分類幾乎不會變動，不需要每天更新，靠後台「重新整理產業對照表」
 * 手動觸發，不接進每日排程。
 *
 * Phase 1（目前）：只負責把這份對照表抓下來、驗證資料品質、存進 IndustryMap 分頁，並在後台
 * 顯示涵蓋率／可疑資料，先確認資料源本身可靠——還沒有接進任何戰報因子計算，因子計算
 * （例如「產業資金流向」）留到資料源確認沒問題之後的下一階段再做。
 *
 * 資料來源沒有官方逐欄位文件可查（跟 AiDiagnosis.gs 的 fetchTwseOfficialFinancialsText_
 * 遇到同樣的限制），欄位名稱用「找包含關鍵字的欄位」動態偵測，不寫死確切欄名，降低猜錯
 * 欄名時默默產生錯誤資料的風險；真的偵測不到就直接拋出清楚的錯誤，不會用錯欄位硬解析。
 */

function getIndustryMapSheet_() {
  return ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.INDUSTRY_MAP, CONFIG.INDUSTRY_MAP_COLUMNS);
}

/** 掃過樣本列的所有 key，依序找第一個「包含指定關鍵字之一」的欄位名稱，找不到回傳 null。 */
function detectFieldKey_(sampleRow, substrings) {
  var keys = Object.keys(sampleRow);
  for (var i = 0; i < substrings.length; i++) {
    var match = keys.filter(function (k) { return k.indexOf(substrings[i]) !== -1; });
    if (match.length > 0) return match[0];
  }
  return null;
}

/**
 * TWSE t187ap03_L 的「產業別」欄位實際存的是數字代碼（例如 1101 台泥回傳的是 "1"），
 * 不是文字名稱——這是實測後才發現的（第一版誤以為欄位裡就是文字，抽查資料看到一堆
 * 「1」「2」才發現），TWSE 沒有在這支 JSON API 裡另外提供代碼對照表可查。
 *
 * 這份對照表是台灣證交所行之有年、外部工具（例如 isin.twse.com.tw 的產業分類頁面）
 * 普遍採用的標準分類代碼，抽查過的兩筆（代碼 1→水泥工業／台泥、代碼 2→食品工業／味全）
 * 都對得上，但沒有找到 TWSE 官方逐碼文件能 100% 逐一核對，所以：
 *   - 對得到的代碼才翻譯成文字，翻不到的代碼「保留原始代碼」，不會亂猜硬翻。
 *   - validateIndustryMapRows_ 會把「翻完還是純數字」的列另外抓出來當品質警訊，
 *     這樣如果這份對照表有缺漏或錯誤，後台的「涵蓋率／品質檢查」會直接看得到，
 *     不會被默默吃掉。
 */
var TWSE_INDUSTRY_CODE_MAP_ = {
  1: '水泥工業', 2: '食品工業', 3: '塑膠工業', 4: '紡織纖維', 5: '電機機械',
  6: '電器電纜', 8: '玻璃陶瓷', 9: '造紙工業', 10: '鋼鐵工業', 11: '橡膠工業',
  12: '汽車工業', 13: '電子工業', 14: '建材營造業', 15: '航運業', 16: '觀光事業',
  17: '金融保險業', 18: '貿易百貨業', 19: '綜合', 20: '其他業', 21: '化學工業',
  22: '生技醫療業', 23: '油電燃氣業', 24: '半導體業', 25: '電腦及週邊設備業',
  26: '光電業', 27: '通信網路業', 28: '電子零組件業', 29: '電子通路業',
  30: '資訊服務業', 31: '其他電子業', 32: '文化創意業', 33: '農業科技業',
  34: '電子商務', 35: '綠能環保', 36: '數位雲端', 37: '運動休閒', 38: '居家生活',
  80: '管理股票', 91: '存託憑證'
};

/** 純函式：把 t187ap03_L 回傳的數字代碼翻成文字產業別；查不到對應代碼就原樣保留
 *  （呼叫端會另外偵測「還是純數字」的情況，不在這裡偷偷用代碼本身充當文字）。 */
function translateIndustryCode_(raw) {
  var s = String(raw || '').trim();
  if (!s) return s;
  if (/^\d+$/.test(s) && TWSE_INDUSTRY_CODE_MAP_.hasOwnProperty(Number(s))) {
    return TWSE_INDUSTRY_CODE_MAP_[Number(s)];
  }
  return s;
}

/** 上市公司產業別：TWSE OpenAPI t187ap03_L（上市公司基本資料）。這支資料集沒有像
 *  t187ap05_L/06_L_ci/07_L_ci 那樣先前已經驗證過，欄位名稱是用關鍵字動態偵測，
 *  偵測不到代號或產業別欄位就直接拋出錯誤，不會用錯欄位硬解析出垃圾資料。 */
function fetchTwseListedIndustryMap_() {
  var resp = UrlFetchApp.fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error('TWSE 上市公司基本資料查詢失敗（HTTP ' + resp.getResponseCode() + '）');
  }
  var rows;
  try {
    rows = JSON.parse(resp.getContentText('UTF-8'));
  } catch (e) {
    throw new Error('TWSE 上市公司基本資料回傳格式異常，無法解析。');
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('TWSE 上市公司基本資料回傳是空的，可能是端點或格式已經改變。');
  }
  var codeKey = detectFieldKey_(rows[0], ['公司代號', '證券代號', '股票代號']);
  var industryKey = detectFieldKey_(rows[0], ['產業別', '所屬產業']);
  var nameKey = detectFieldKey_(rows[0], ['公司簡稱', '公司名稱', '證券名稱']);
  if (!codeKey || !industryKey) {
    throw new Error('TWSE 上市公司基本資料裡找不到代號或產業別欄位（目前欄位：' +
      Object.keys(rows[0]).join('、') + '），可能是資料格式已經改變，需要人工確認。');
  }
  return rows.map(function (r) {
    return {
      code: zfill4(String(r[codeKey] || '').trim()),
      name: nameKey ? String(r[nameKey] || '').trim() : '',
      industry: translateIndustryCode_(r[industryKey]),
      market: '上市'
    };
  }).filter(function (r) { return r.code.length === 4 && r.industry; });
}

/** 上櫃（TPEX）產業別資料源目前還沒有確認正確的 API 路徑（TPEX OpenAPI 端點命名規則
 *  跟 TWSE 不一樣，沒有查到可靠的逐欄位文件），先讓這裡明確回傳「沒有資料＋警告」，
 *  不要用猜的路徑產生看起來像成功、實際上是錯的資料——寧可讓涵蓋率統計清楚顯示
 *  「上櫃股票目前 0% 涵蓋」，也不要塞入可能整批算錯的資料。等之後確認正確的端點
 *  路徑，把這個函式換成真的呼叫即可，不影響其他部分。 */
function fetchTpexListedIndustryMap_() {
  return { rows: [], warning: '上櫃（TPEX）產業別資料源尚未確認正確的 API 路徑，目前只有上市股票有產業別資料。' };
}

/** 純函式：資料品質檢查，回傳發現的問題清單（空陣列代表沒問題）。任何一項有問題就要讓
 *  呼叫端整批放棄這次更新，不要用可疑資料覆蓋掉既有資料——這是這次使用者明確要求的
 *  「先確保資料品質」，寧可保留舊資料，也不要讓品質有疑慮的新資料悄悄蓋過去。 */
function validateIndustryMapRows_(rows) {
  var issues = [];
  if (!rows || rows.length < 500) {
    issues.push('抓到的資料只有 ' + (rows ? rows.length : 0) + ' 筆，遠低於預期的上市櫃公司數量，可能是資料源出問題。');
  }
  if (rows && rows.length > 0) {
    var codeSet = {};
    var dupCount = 0;
    rows.forEach(function (r) {
      if (codeSet[r.code]) dupCount++;
      codeSet[r.code] = true;
    });
    if (dupCount > 0) issues.push('發現 ' + dupCount + ' 筆重複的股票代號。');

    var badCodeCount = rows.filter(function (r) { return !/^\d{4}$/.test(r.code); }).length;
    if (badCodeCount > 0) issues.push('有 ' + badCodeCount + ' 筆代號格式不是 4 位數字。');

    var blankIndustryCount = rows.filter(function (r) { return !r.industry; }).length;
    if (blankIndustryCount > 0) issues.push('有 ' + blankIndustryCount + ' 筆產業別是空白。');
  }
  return issues;
}

/** 純函式：找出「產業別欄位翻完還是純數字」的列——代表 TWSE_INDUSTRY_CODE_MAP_ 這份
 *  對照表沒收錄到的代碼（這份表沒有 100% 官方核對過，見表格上方註解）。故意不當成致命
 *  的品質問題（不會阻擋整批更新），因為就算只有少數代碼沒對到，其餘資料還是正確、
 *  可以先用；但一定要在後台清楚列出來，讓使用者看得到「這幾個代碼還沒翻譯」，而不是
 *  放著一堆數字看起來像正常資料卻沒人發現。 */
function findUntranslatedIndustryCodes_(rows) {
  var matched = (rows || []).filter(function (r) { return /^\d+$/.test(String(r.industry || '')); });
  return {
    count: matched.length,
    sample: matched.slice(0, 10).map(function (r) { return r.code + '（代碼 ' + r.industry + '）'; })
  };
}

/** 拿目前實際掃描到的最新一天全市場資料（跟今日戰報同一份計算結果，不用另外重算）當作
 *  「目前有在追蹤的股票代號」清單，比對產業對照表涵蓋了其中多少檔——這是最直接的資料品質
 *  訊號：涵蓋率太低，代表對照表本身有問題，或是市場別（上市/上櫃）沒有配對齊全。 */
function computeIndustryMapCoverage_(mapRows) {
  var mapCodeSet = {};
  mapRows.forEach(function (r) { mapCodeSet[r.code] = true; });
  var trackedCodes;
  try {
    trackedCodes = computeLatestDayRows_({}).map(function (r) { return zfill4(String(r['證券代號']).trim()); });
  } catch (e) {
    return { checked: false, error: String(e.message || e) };
  }
  if (trackedCodes.length === 0) {
    return { checked: false, error: '目前沒有可用的歷史資料，無法比對涵蓋率（先確認戰報/歷史資料本身正常）。' };
  }
  var unmatched = trackedCodes.filter(function (c) { return !mapCodeSet[c]; });
  var matchedCount = trackedCodes.length - unmatched.length;
  return {
    checked: true,
    trackedCount: trackedCodes.length,
    matchedCount: matchedCount,
    coveragePct: Math.round(matchedCount / trackedCodes.length * 1000) / 10,
    unmatchedSample: unmatched.slice(0, 20),
    unmatchedTotal: unmatched.length
  };
}

/** 實際做事的地方：抓資料 + 品質驗證 + 存檔 + 涵蓋率比對。任何品質檢查沒過就整批放棄、
 *  不覆蓋既有資料。由背景 job tick 呼叫（見下方），不是直接給前端 RPC 呼叫。 */
function doRefreshIndustryMap_() {
  var twseRows = fetchTwseListedIndustryMap_();
  var tpexResult = { rows: [], warning: null };
  try {
    tpexResult = fetchTpexListedIndustryMap_();
  } catch (e) {
    tpexResult = { rows: [], warning: String(e.message || e) };
  }

  var allRows = twseRows.concat(tpexResult.rows || []);
  var issues = validateIndustryMapRows_(allRows);
  if (issues.length > 0) {
    throw new Error('產業對照表資料品質檢查沒通過，已放棄這次更新（不影響既有資料）：' + issues.join('；'));
  }

  var sheet = getIndustryMapSheet_();
  writeSheetObjects_(sheet, CONFIG.INDUSTRY_MAP_COLUMNS, allRows.map(function (r) {
    return { '證券代號': r.code, '證券名稱': r.name, '產業別': r.industry, '市場別': r.market };
  }));

  var coverage = computeIndustryMapCoverage_(allRows);
  var untranslated = findUntranslatedIndustryCodes_(allRows);

  // Phase 3：順便同步一份到 BigQuery，給因子迴歸模型的 factor_features view 用 JOIN 取用
  // （見 FactorRegression.gs 的 industry_capital_flow 候選因子）。只有設定了 BigQuery 專案
  // 才會嘗試，失敗（例如根本沒設定 BigQuery、或暫時性錯誤）也不影響 Sheet 版本已經存好的
  // 結果——Phase 1/2 完全不依賴這裡是否成功，這裡只是額外的加分項。
  var bqSync = { attempted: false, ok: false, error: null };
  if (shouldWriteToBigQuery_()) {
    bqSync.attempted = true;
    try {
      var bqResult = syncIndustryMapToBigQuery_(allRows.map(function (r) { return { code: r.code, industry: r.industry }; }));
      bqSync.ok = true;
      bqSync.rowCount = bqResult.rowCount;
    } catch (e) {
      bqSync.error = String(e.message || e);
    }
  }

  var summary = {
    updatedAt: Date.now(),
    totalCount: allRows.length,
    twseCount: twseRows.length,
    tpexCount: (tpexResult.rows || []).length,
    tpexWarning: tpexResult.warning || null,
    coverage: coverage,
    untranslated: untranslated,
    bqSync: bqSync
  };
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.INDUSTRY_MAP_LAST_REFRESH, JSON.stringify(summary));
  logRun_('產業對照表', '成功',
    '共 ' + allRows.length + ' 筆（上市 ' + twseRows.length + '，上櫃 ' + (tpexResult.rows || []).length + '）' +
    (coverage.checked ? '，目前追蹤股票涵蓋率 ' + coverage.coveragePct + '%' : '') +
    (untranslated.count ? '，' + untranslated.count + ' 筆產業代碼沒對到文字名稱' : '') +
    (bqSync.attempted ? '，BigQuery 同步：' + (bqSync.ok ? '成功' : '失敗（' + bqSync.error + '）') : '') +
    (tpexResult.warning ? '；' + tpexResult.warning : ''), 0);
  return summary;
}

/** 純函式：從陣列裡隨機挑 n 筆（不重複、不改動原陣列順序的複本），用 Fisher-Yates 洗牌
 *  取前 n 個。人眼抽查資料品質時，固定看「前 10 筆」容易因為 Sheet 排序方式（例如照代號
 *  排序）剛好都抽到同一種類型（例如水泥股集中在代號開頭），隨機抽比較能代表整體資料。 */
function pickRandomSample_(items, n) {
  var arr = (items || []).slice();
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr.slice(0, n);
}

/** 前端「產業對照表」卡片載入用：純讀取，不會觸發任何抓取，只讀上次重新整理存下來的摘要
 *  跟目前分頁裡隨機抽出的幾筆資料（給人眼抽查用，見 pickRandomSample_ 為什麼要隨機抽）。 */
function getIndustryMapStatus() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.INDUSTRY_MAP_LAST_REFRESH);
  var summary = raw ? JSON.parse(raw) : null;
  var sample = pickRandomSample_(readSheetObjects_(getIndustryMapSheet_()), 10);
  return { summary: summary, sample: sample };
}

// ============================================================
// 「重新整理產業對照表」背景 job（機制跟其他六個背景 job 相同）：抓資料＋驗證＋涵蓋率比對
// 這幾步合起來的時間沒辦法保證一定很快（涵蓋率比對要重算一次最新一天全市場因子），
// 用背景 job 才不會受瀏覽器連線中斷影響，跟「重新計算戰報」是同一類考量。
// ============================================================

function getIndustryMapJobState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.INDUSTRY_MAP_JOB_STATE);
  return raw ? JSON.parse(raw) : null;
}

function saveIndustryMapJobState_(state) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.INDUSTRY_MAP_JOB_STATE, JSON.stringify(state));
}

function deleteIndustryMapJobTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processIndustryMapJobTick_') ScriptApp.deleteTrigger(t);
  });
}

/** 前端「重新整理產業對照表」按鈕呼叫：排一個幾乎立刻觸發的一次性時間觸發器就馬上回傳，
 *  實際抓取/驗證在另一次獨立觸發的執行裡進行，不受這次瀏覽器連線影響。 */
function startIndustryMapRefreshJob() {
  deleteIndustryMapJobTriggers_();
  saveIndustryMapJobState_({ status: 'running', updatedAt: Date.now() });
  ScriptApp.newTrigger('processIndustryMapJobTick_').timeBased().after(3000).create();
  return { status: 'running' };
}

/** 前端輪詢用：狀態存在 Script Properties，任何時候打開頁面呼叫都看得到最新進度或結果。 */
function getIndustryMapRefreshJobStatus() {
  return autoHealStaleJobState_(CONFIG.PROP_KEYS.INDUSTRY_MAP_JOB_STATE, getIndustryMapJobState_() || { status: 'idle' });
}

/** 排程佇列的「刪除」按鈕呼叫：不管目前狀態是什麼，直接清掉狀態跟任何已排定的觸發器。 */
function clearIndustryMapRefreshJob_() {
  deleteIndustryMapJobTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.PROP_KEYS.INDUSTRY_MAP_JOB_STATE);
  return { status: 'idle' };
}

function processIndustryMapJobTick_() {
  deleteIndustryMapJobTriggers_();
  var state = getIndustryMapJobState_();
  if (!state || state.status !== 'running') return;
  var startTime = Date.now();
  try {
    var summary = doRefreshIndustryMap_();
    state.status = 'done';
    state.result = summary;
    state.updatedAt = Date.now();
    saveIndustryMapJobState_(state);
  } catch (e) {
    state.status = 'error';
    state.errorMessage = String(e.message || e);
    state.updatedAt = Date.now();
    saveIndustryMapJobState_(state);
    logRun_('產業對照表', '失敗', String(e.message || e), Math.round((Date.now() - startTime) / 1000));
  }
}
