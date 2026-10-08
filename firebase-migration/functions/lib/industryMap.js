/**
 * industryMap.js
 * 股票代號 → 產業別對照表的純函式邏輯，從 apps-script/src/IndustryMap.gs
 * 複製過來（只複製不需要 UrlFetchApp/BigQuery/Sheets 的部分——實際抓取
 * TWSE OpenAPI、同步 BigQuery、寫入 Firestore 這些 I/O 留給 index.js）。
 *
 * 複製時機：2026-10-08，對照 apps-script/src/IndustryMap.gs 當時的內容。
 */
var zfill4 = require('./utils').zfill4;

/** TWSE t187ap03_L 的「產業別」欄位實際存的是數字代碼，不是文字名稱——跟
 *  apps-script 版同一份對照表（台灣證交所行之有年的標準分類代碼，沒有找到
 *  TWSE 官方逐碼文件能 100% 核對，翻不到的代碼保留原始代碼，見
 *  findUntranslatedIndustryCodes_）。 */
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

function translateIndustryCode_(raw) {
  var s = String(raw || '').trim();
  if (!s) return s;
  if (/^\d+$/.test(s) && TWSE_INDUSTRY_CODE_MAP_.hasOwnProperty(Number(s))) {
    return TWSE_INDUSTRY_CODE_MAP_[Number(s)];
  }
  return s;
}

/** 掃過樣本列的所有 key，依序找第一個「包含指定關鍵字之一」的欄位名稱，
 *  找不到回傳 null——欄位名稱沒有官方文件可查，用關鍵字動態偵測，不寫死
 *  確切欄名，降低猜錯欄名時默默產生錯誤資料的風險。 */
function detectFieldKey_(sampleRow, substrings) {
  var keys = Object.keys(sampleRow);
  for (var i = 0; i < substrings.length; i++) {
    var match = keys.filter(function (k) { return k.indexOf(substrings[i]) !== -1; });
    if (match.length > 0) return match[0];
  }
  return null;
}

/**
 * 把 TWSE t187ap03_L（上市公司基本資料）回傳的原始列，轉成
 * `{code, name, industry, market}` 陣列。抓不到代號或產業別欄位就直接
 * 拋出清楚的錯誤，不會用錯欄位硬解析出垃圾資料（跟 apps-script 版
 * `fetchTwseListedIndustryMap_` 的錯誤處理一致）。
 */
function parseTwseIndustryMapRows_(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new Error('TWSE 上市公司基本資料回傳是空的，可能是端點或格式已經改變。');
  }
  var codeKey = detectFieldKey_(rawRows[0], ['公司代號', '證券代號', '股票代號']);
  var industryKey = detectFieldKey_(rawRows[0], ['產業別', '所屬產業']);
  var nameKey = detectFieldKey_(rawRows[0], ['公司簡稱', '公司名稱', '證券名稱']);
  if (!codeKey || !industryKey) {
    throw new Error('TWSE 上市公司基本資料裡找不到代號或產業別欄位（目前欄位：' +
      Object.keys(rawRows[0]).join('、') + '），可能是資料格式已經改變，需要人工確認。');
  }
  return rawRows.map(function (r) {
    return {
      code: zfill4(String(r[codeKey] || '').trim()),
      name: nameKey ? String(r[nameKey] || '').trim() : '',
      industry: translateIndustryCode_(r[industryKey]),
      market: '上市'
    };
  }).filter(function (r) { return r.code.length === 4 && r.industry; });
}

/** 資料品質檢查，回傳發現的問題清單（空陣列代表沒問題）。任何一項有問題
 *  呼叫端就要整批放棄這次更新，不用可疑資料覆蓋既有資料——跟 apps-script
 *  版 `validateIndustryMapRows_` 同一個「寧可保留舊資料」的原則。 */
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

/** 找出「產業別欄位翻完還是純數字」的列——代表 TWSE_INDUSTRY_CODE_MAP_
 *  沒收錄到的代碼。不當成致命的品質問題（不阻擋整批更新），但要讓使用者
 *  在後台看得到這幾個代碼還沒翻譯，不是放著一堆數字沒人發現。 */
function findUntranslatedIndustryCodes_(rows) {
  var matched = (rows || []).filter(function (r) { return /^\d+$/.test(String(r.industry || '')); });
  return {
    count: matched.length,
    sample: matched.slice(0, 10).map(function (r) { return r.code + '（代碼 ' + r.industry + '）'; })
  };
}

/**
 * 產業對照表涵蓋率：對照表涵蓋了「目前有在追蹤」的股票代號清單中多少檔。
 * trackedCodes 由呼叫端查「最新一天全市場資料」算出來（見 index.js
 * `fetchTrackedCodesForCoverage_`）——跟 apps-script 版
 * `computeIndustryMapCoverage_` 不同，這裡純函式不自己去抓 trackedCodes，
 * 只負責拿到清單之後的比對計算，可以在 Node 不接 BigQuery 的情況下測試。
 */
function computeIndustryMapCoverage_(mapRows, trackedCodes) {
  var mapCodeSet = {};
  (mapRows || []).forEach(function (r) { mapCodeSet[r.code] = true; });
  if (!trackedCodes || trackedCodes.length === 0) {
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

/** 從陣列裡隨機挑 n 筆（不改動原陣列），Fisher-Yates 洗牌取前 n 個——人眼
 *  抽查資料品質時，固定看「前 10 筆」容易因為排序方式（例如照代號排序）
 *  剛好都抽到同一種類型，隨機抽比較能代表整體資料。 */
function pickRandomSample_(items, n) {
  var arr = (items || []).slice();
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr.slice(0, n);
}

module.exports = {
  TWSE_INDUSTRY_CODE_MAP_: TWSE_INDUSTRY_CODE_MAP_,
  translateIndustryCode_: translateIndustryCode_,
  detectFieldKey_: detectFieldKey_,
  parseTwseIndustryMapRows_: parseTwseIndustryMapRows_,
  validateIndustryMapRows_: validateIndustryMapRows_,
  findUntranslatedIndustryCodes_: findUntranslatedIndustryCodes_,
  computeIndustryMapCoverage_: computeIndustryMapCoverage_,
  pickRandomSample_: pickRandomSample_
};
