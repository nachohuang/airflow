/**
 * twseFetch.js
 * 每日向證交所（TWSE）抓 T86（三大法人買賣超）／MI_INDEX（收盤行情）／
 * BWIBBU_d（殖利率/本益比/股價淨值比）、清理、合併的純邏輯，從
 * apps-script/src/DataFetch.gs 的 `fetchT86_`／`fetchMiIndex_`／`fetchBwibbu_`／
 * `fetchAndMergeOneDay_` 搬過來——文字解析規則逐條照搬（TWSE CSV 的格式怪癖，
 * 像是「跳過頁尾註記列」「= "..." 包裝的代號」「用逗號數量判斷哪幾行是真的資料
 * 列」這些，都是實測對過格式才確認下來的，不是憑空猜的，照抄不重新設計）。
 *
 * I/O（打 TWSE 的 3 個 HTTP 端點、Big5 解碼、寫 BigQuery）留給 index.js，這裡
 * 只管「已經拿到解碼後的 CSV 文字之後，怎麼解析成列、怎麼合併成一天的資料」。
 *
 * 跟 apps-script 版的差異：這裡省略了「日期」欄位要同時維護 yyyy/MM/dd（給
 * Drive CSV 用）跟 yyyy-MM-dd（給 BigQuery 用）兩種格式的邏輯
 * （`formatSlashDate_`／`normalizeRowsDateField_`）——Firebase 版沒有 Drive CSV
 * 這條路徑（見 README「每日股價資料抓取」那節的架構決定：不重建 Drive 月份
 * 檔案這一層，新抓到的資料直接寫進 BigQuery 的 `history_raw`），合併出來的列
 * 「日期」欄位直接就是 yyyy-MM-dd，呼叫端傳什麼格式進來就是什麼格式，不用
 * 額外轉換。
 */
var utils = require('./utils');

/**
 * 極簡 CSV 單行解析（取代 apps-script 版的 `Utilities.parseCsv`）：支援雙引號
 * 包住的欄位（含欄位內的逗號）、`""` 轉義成一個雙引號。TWSE 的 CSV 欄位不會有
 * 換行符號包在引號裡（每一行就是一筆資料），不需要處理跨行的引號欄位。
 */
function parseCsvLine_(line) {
  if (!line || line.trim() === '') return [];
  var fields = [];
  var cur = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function splitLines_(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n');
}

function indexHeaders_(headers) {
  var m = {};
  headers.forEach(function (h, i) { m[String(h).trim()] = i; });
  return m;
}

/** 對應 apps-script 版 `cleanCode_`：去掉 `="..."` 包裝與多餘引號/空白，再過一次
 *  `sanitizeStockId_` 做格式驗證/正規化。格式明顯不對的股票代號會變成空字串，
 *  呼叫端用 `if (!code) continue/return` 跳過，不讓髒資料流進合併結果。 */
function cleanStockCode_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v).split('="').join('');
  s = s.replace(/^"+|"+$/g, '');
  s = s.trim();
  return utils.sanitizeStockId_(s);
}

/** 'yyyy-MM-dd' -> TWSE API 要的 URL 參數格式 'yyyyMMdd'。 */
function toTwseDateParam_(dateStr) {
  return String(dateStr).replace(/-/g, '');
}

/**
 * T86（三大法人買賣超）：pandas 版用 `header=1`（跳過第一行標題上方的說明列），
 * 資料從第 3 行（index 2）開始；`fields.length < headers.length - 2` 用來跳過
 * 頁尾的註記列（欄位數明顯對不齊）。自營商買賣超要把「自行買賣」跟「避險」
 * 兩個子欄位加總成單一數字。
 */
function parseT86Rows_(csvText) {
  var lines = splitLines_(csvText);
  if (lines.length < 4) throw new Error('T86 資料過少');

  var headers = parseCsvLine_(lines[1]);
  var idx = indexHeaders_(headers);
  if (idx['證券代號'] === undefined) throw new Error('T86 找不到證券代號欄位');

  var rows = [];
  for (var i = 2; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.indexOf(',') === -1) continue;
    var fields = parseCsvLine_(line);
    if (fields.length < headers.length - 2) continue;
    var code = cleanStockCode_(fields[idx['證券代號']]);
    if (!code) continue;

    var dealerSelf = utils.toNumber(fields[idx['自營商買賣超股數(自行買賣)']]);
    var dealerHedge = utils.toNumber(fields[idx['自營商買賣超股數(避險)']]);

    rows.push({
      證券代號: code,
      證券名稱: (fields[idx['證券名稱']] || '').trim(),
      外資: utils.toNumber(fields[idx['外陸資買賣超股數(不含外資自營商)']]),
      投信: utils.toNumber(fields[idx['投信買賣超股數']]),
      自營商: dealerSelf + dealerHedge,
      三大法人買賣超股數: utils.toNumber(fields[idx['三大法人買賣超股數']])
    });
  }
  if (rows.length < 5) throw new Error('T86 資料過少或格式異常');
  return rows;
}

/**
 * MI_INDEX（每日收盤行情）：要先找到「每日收盤行情(全部)」這個區塊標題，
 * 再從那附近找「證券代號」標題列——同一份回應裡還有其他區塊（例如大盤指數），
 * 不是從檔案開頭就是要的表格。`commaCount >= 10` 用來篩出真正的資料列（排除
 * 說明文字/空行）。
 */
function parseMiIndexRows_(csvText) {
  var lines = splitLines_(csvText);

  var startIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('每日收盤行情(全部)') !== -1) { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error('MI_INDEX 找不到「每日收盤行情(全部)」區塊');

  var headerIdx = -1;
  for (var j = startIdx; j < Math.min(startIdx + 10, lines.length); j++) {
    if (lines[j].indexOf('證券代號') !== -1) { headerIdx = j; break; }
  }
  if (headerIdx === -1) throw new Error('MI_INDEX 找不到證券代號標題列');

  var cleaned = [];
  for (var k = headerIdx; k < lines.length; k++) {
    var line = lines[k];
    var commaCount = (line.match(/,/g) || []).length;
    if (commaCount >= 10) cleaned.push(line.split('="').join('"'));
  }
  if (cleaned.length < 2) throw new Error('MI_INDEX 資料為空或格式異常');

  var headers = parseCsvLine_(cleaned[0]).map(function (h) { return String(h).trim(); });
  var idx = indexHeaders_(headers);
  if (idx['證券代號'] === undefined) throw new Error('MI_INDEX 找不到證券代號欄位');

  var rows = [];
  for (var r = 1; r < cleaned.length; r++) {
    var fields = parseCsvLine_(cleaned[r]);
    if (fields.length < headers.length - 2) continue;
    var rawCode = (fields[idx['證券代號']] || '').trim();
    if (!rawCode || rawCode === '證券代號') continue;
    var code = utils.sanitizeStockId_(rawCode);
    if (!code) continue;

    rows.push({
      證券代號: code,
      證券名稱: idx['證券名稱'] !== undefined ? (fields[idx['證券名稱']] || '').trim() : '',
      成交股數: utils.toNumber(fields[idx['成交股數']]),
      成交筆數: utils.toNumber(fields[idx['成交筆數']]),
      成交金額: utils.toNumber(fields[idx['成交金額']]),
      開盤價: utils.toNumber(fields[idx['開盤價']]),
      最高價: utils.toNumber(fields[idx['最高價']]),
      最低價: utils.toNumber(fields[idx['最低價']]),
      收盤價: utils.toNumber(fields[idx['收盤價']]),
      '漲跌(+/-)': idx['漲跌(+/-)'] !== undefined ? (fields[idx['漲跌(+/-)']] || '').trim() : '',
      漲跌價差: utils.toNumber(fields[idx['漲跌價差']]),
      最後揭示買價: utils.toNumber(fields[idx['最後揭示買價']]),
      最後揭示買量: utils.toNumber(fields[idx['最後揭示買量']]),
      最後揭示賣價: utils.toNumber(fields[idx['最後揭示賣價']]),
      最後揭示賣量: utils.toNumber(fields[idx['最後揭示賣量']]),
      本益比: utils.toNumber(fields[idx['本益比']])
    });
  }
  if (rows.length < 5) throw new Error('MI_INDEX 資料過少');
  return rows;
}

/** BWIBBU_d（殖利率/本益比/股價淨值比）：跟 MI_INDEX 一樣要先找標題列，
 *  `commaCount >= 5` 篩資料列（這份回應欄位比 MI_INDEX 少，門檻跟著降低）。
 *  這個端點查無資料（例如太早查詢）時回傳空陣列而不是拋例外——跟 apps-script
 *  版一致，`fetchAndMergeOneDay_` 的合併邏輯本來就允許 BWIBBU 缺值（left
 *  join），不是三個端點裡的強制依賴。 */
function parseBwibbuRows_(csvText) {
  var lines = splitLines_(csvText);

  var headerIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('證券代號') !== -1) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error('BWIBBU 找不到證券代號標題列');

  var dataLines = [];
  for (var k = headerIdx; k < lines.length; k++) {
    var line = lines[k];
    var commaCount = (line.match(/,/g) || []).length;
    if (commaCount >= 5) dataLines.push(line);
  }
  if (dataLines.length < 2) throw new Error('BWIBBU 資料為空或格式異常');

  var headers = parseCsvLine_(dataLines[0]).map(function (h) { return String(h).trim(); });
  var idx = indexHeaders_(headers);
  if (idx['證券代號'] === undefined) throw new Error('BWIBBU 找不到證券代號欄位');

  var rows = [];
  for (var r = 1; r < dataLines.length; r++) {
    var fields = parseCsvLine_(dataLines[r]);
    if (fields.length < headers.length - 2) continue;
    var code = cleanStockCode_(fields[idx['證券代號']]);
    if (!code) continue;
    rows.push({
      證券代號: code,
      '殖利率(%)': idx['殖利率(%)'] !== undefined ? utils.toNumber(fields[idx['殖利率(%)']]) : 0,
      本益比: idx['本益比'] !== undefined ? utils.toNumber(fields[idx['本益比']]) : 0,
      股價淨值比: idx['股價淨值比'] !== undefined ? utils.toNumber(fields[idx['股價淨值比']]) : 0,
      '財報年/季': idx['財報年/季'] !== undefined ? (fields[idx['財報年/季']] || '').trim() : ''
    });
  }
  return rows;
}

/**
 * 合併單一日期的三份資料：T86 (inner) + MI_INDEX + BWIBBU (left)，回傳
 * `BQ_COLUMN_MAP`（見 lib/bigquery.js）中文欄名格式的列陣列，可以直接拿去
 * 寫 BigQuery `history_raw`。跟 apps-script 版 `fetchAndMergeOneDay_` 的合併
 * 規則逐條一致：MI_INDEX 查無資料的股票整檔跳過（inner join），BWIBBU 缺值
 * 的欄位補 0／空字串。dateStr 是 'yyyy-MM-dd'，直接寫進「日期」欄位——跟
 * apps-script 版不同，這裡不需要另外維護斜線格式（見檔案開頭的架構差異說明）。
 */
function mergeDayRows_(t86Rows, miRows, bwRows, dateStr) {
  var miByCode = {};
  (miRows || []).forEach(function (r) { miByCode[r.證券代號] = r; });
  var bwByCode = {};
  (bwRows || []).forEach(function (r) { bwByCode[r.證券代號] = r; });

  var merged = [];
  (t86Rows || []).forEach(function (t) {
    var mi = miByCode[t.證券代號];
    if (!mi) return;
    var bw = bwByCode[t.證券代號] || {};
    merged.push({
      日期: dateStr,
      證券代號: t.證券代號,
      證券名稱: t.證券名稱 || mi.證券名稱 || '',
      外資: t.外資,
      投信: t.投信,
      自營商: t.自營商,
      三大法人買賣超股數: t.三大法人買賣超股數,
      成交股數: mi.成交股數,
      成交筆數: mi.成交筆數,
      成交金額: mi.成交金額,
      開盤價: mi.開盤價,
      最高價: mi.最高價,
      最低價: mi.最低價,
      收盤價: mi.收盤價,
      '漲跌(+/-)': mi['漲跌(+/-)'],
      漲跌價差: mi.漲跌價差,
      最後揭示買價: mi.最後揭示買價,
      最後揭示買量: mi.最後揭示買量,
      最後揭示賣價: mi.最後揭示賣價,
      最後揭示賣量: mi.最後揭示賣量,
      '殖利率(%)': bw['殖利率(%)'] !== undefined ? bw['殖利率(%)'] : 0,
      本益比: bw.本益比 !== undefined ? bw.本益比 : mi.本益比,
      股價淨值比: bw.股價淨值比 !== undefined ? bw.股價淨值比 : 0,
      '財報年/季': bw['財報年/季'] || ''
    });
  });
  if (merged.length === 0) throw new Error('T86 與 MI_INDEX 合併後沒有資料 (' + dateStr + ')');
  return merged;
}

module.exports = {
  parseCsvLine_: parseCsvLine_,
  cleanStockCode_: cleanStockCode_,
  toTwseDateParam_: toTwseDateParam_,
  parseT86Rows_: parseT86Rows_,
  parseMiIndexRows_: parseMiIndexRows_,
  parseBwibbuRows_: parseBwibbuRows_,
  mergeDayRows_: mergeDayRows_
};
