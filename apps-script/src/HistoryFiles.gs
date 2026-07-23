/**
 * HistoryFiles.gs
 * 歷史資料的實際儲存層：每月一份 CSV（YYYY-MM_ALL_COMBINED.csv），存在使用者指定的
 * Drive 資料夾（Config.getArchiveFolder_()）。取代原本用 Google Sheets 存整份歷史的做法：
 * 每天只需要讀寫「當月」那一份檔案，檔案大小永遠有界（最多一個月的資料量），
 * 不會有 Google Sheets 一千萬格上限的問題，也不會有「一次讀進整份巨大歷史檔案」讀不動的問題。
 *
 * 對外維持跟舊版一樣的函式名稱與行為（upsertHistoryRows_ / readRecentHistory_ / readHistoryRange_ /
 * getHistoryDateBounds，都在 SheetUtils.gs 裡改成呼叫這個檔案的實作），
 * 所以 Analysis.gs / Backtest.gs / FactorScan.gs / DataFetch.gs / ImportHistory.gs /
 * Portfolio.gs / StockAnalysis.gs 完全不用改，一樣呼叫原本那幾個函式就好。
 */

/** 'yyyy-mm-dd' 或 Date -> 'yyyy-mm'。 */
function monthKeyFor_(dateStrOrDate) {
  return normalizeDateStr(dateStrOrDate).slice(0, 7);
}

function monthlyFileName_(monthKey) {
  return monthKey + CONFIG.HISTORY_FILE_SUFFIX;
}

/** 依檔名找該月份的檔案，找不到回傳 null（不會自動建立——建立交給寫入端決定）。 */
function findMonthlyFile_(monthKey) {
  var folder = getArchiveFolder_();
  var it = folder.getFilesByName(monthlyFileName_(monthKey));
  return it.hasNext() ? it.next() : null;
}

/** 把一個 CSV Blob/File 的內容解析成 History 欄位格式的列陣列。 */
function parseHistoryCsvText_(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去掉 utf-8-sig BOM
  var parsed = Utilities.parseCsv(text);
  if (parsed.length === 0) return [];
  var headers = parsed[0].map(function (h) { return String(h).trim(); });
  var idx = indexHeaders_(headers);
  return parsed.slice(1).map(function (fields) {
    var row = {};
    CONFIG.HISTORY_COLUMNS.forEach(function (col) {
      var i = idx[col];
      var v = i === undefined ? '' : fields[i];
      row[col] = CONFIG.HISTORY_NUMERIC_COLUMNS.indexOf(col) !== -1 ? toNumber(v) : (v === undefined || v === null ? '' : String(v).trim());
    });
    return row;
  });
}

/** 讀某個月份的所有資料列；該月份還沒有檔案就回傳空陣列（代表尚無資料，不是錯誤）。 */
function readMonthlyFileRows_(monthKey) {
  var file = findMonthlyFile_(monthKey);
  if (!file) return [];
  return parseHistoryCsvText_(file.getBlob().getDataAsString('UTF-8'));
}

/** 把整批資料列覆寫成該月份的檔案內容（沒有該月檔案就新建）。 */
function writeMonthlyFileRows_(monthKey, rows) {
  var csv = '\uFEFF' + rowsToCsv_(CONFIG.HISTORY_COLUMNS, rows);
  var existing = findMonthlyFile_(monthKey);
  if (existing) {
    existing.setContent(csv);
  } else {
    getArchiveFolder_().createFile(monthlyFileName_(monthKey), csv, MimeType.CSV);
  }
}

/**
 * 核心：把新抓到的資料併入對應月份的檔案（同日期資料整批取代，避免重複），
 * 該月份還沒有檔案就自動建立。正常一次呼叫只會牽涉到一個月份，但寫成通用版本，
 * 也能一次處理跨月份的資料（例如「資料範圍重新彙整」橫跨月底的情況）。
 */
function upsertHistoryRowsToMonthlyFiles_(newRows) {
  if (!newRows || newRows.length === 0) return { months: [] };

  var byMonth = groupBy(newRows, function (r) { return monthKeyFor_(r['日期']); });
  var touchedMonths = [];

  byMonth.forEach(function (rowsForMonth, monthKey) {
    var existingRows = readMonthlyFileRows_(monthKey);
    var newDateSet = {};
    rowsForMonth.forEach(function (r) { newDateSet[normalizeDateStr(r['日期'])] = true; });
    var kept = existingRows.filter(function (r) { return !newDateSet[normalizeDateStr(r['日期'])]; });

    var merged = kept.concat(rowsForMonth);
    merged = sortRows(merged, [
      ['證券代號', 'asc'],
      [function (r) { return normalizeDateStr(r['日期']); }, 'desc']
    ]);

    writeMonthlyFileRows_(monthKey, merged);
    touchedMonths.push(monthKey);
  });

  return { months: touchedMonths, totalRows: newRows.length };
}

/** 列出資料夾裡所有「YYYY-MM_ALL_COMBINED.csv」格式的月份檔名，由舊到新排序。 */
function listAvailableMonths_() {
  var folder = getArchiveFolder_();
  var it = folder.getFiles();
  var months = [];
  var pattern = /^(\d{4}-\d{2})_ALL_COMBINED\.csv$/;
  while (it.hasNext()) {
    var m = it.next().getName().match(pattern);
    if (m) months.push(m[1]);
  }
  months.sort();
  return months;
}

/** 讀最近 N 天的資料：算出涵蓋到哪幾個月份，只讀那幾個月的檔案（不是資料夾裡的全部檔案）。 */
function readRecentHistoryFromFiles_(days) {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  var cutoffStr = normalizeDateStr(cutoff);

  var months = monthRangeBetween_(cutoff, new Date());
  var rows = [];
  months.forEach(function (m) { rows = rows.concat(readMonthlyFileRows_(m)); });
  return rows.filter(function (r) { return normalizeDateStr(r['日期']) >= cutoffStr; });
}

/** 讀指定日期區間的資料：算出涵蓋到哪幾個月份，只讀那幾個月的檔案。 */
function readHistoryRangeFromFiles_(startStr, endStr) {
  var startDt = startStr ? new Date(startStr + 'T00:00:00') : null;
  var endDt = endStr ? new Date(endStr + 'T00:00:00') : new Date();
  var months = startDt ? monthRangeBetween_(startDt, endDt) : listAvailableMonths_();

  var rows = [];
  months.forEach(function (m) { rows = rows.concat(readMonthlyFileRows_(m)); });
  return rows.filter(function (r) {
    var d = normalizeDateStr(r['日期']);
    return (!startStr || d >= startStr) && (!endStr || d <= endStr);
  });
}

/** 兩個日期之間橫跨的所有 'yyyy-mm' 月份 key（含頭尾）。 */
function monthRangeBetween_(startDate, endDate) {
  var months = {};
  var cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  var end = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  while (cur.getTime() <= end.getTime()) {
    months[normalizeDateStr(cur).slice(0, 7)] = true;
    cur.setMonth(cur.getMonth() + 1);
  }
  return Object.keys(months);
}

/** 讀資料夾裡「所有」月份檔案，給需要全量歷史的情境用（例如手動全量重跑分析/研究）。 */
function readAllHistoryFromFiles_() {
  var months = listAvailableMonths_();
  var rows = [];
  months.forEach(function (m) { rows = rows.concat(readMonthlyFileRows_(m)); });
  return rows;
}

/** 目前歷史資料的涵蓋範圍摘要：最早/最新日期、有幾個月份的檔案。 */
function getHistoryDateBounds() {
  var months = listAvailableMonths_();
  if (months.length === 0) return { min: null, max: null, monthsAvailable: 0 };

  var earliestRows = readMonthlyFileRows_(months[0]);
  var latestRows = readMonthlyFileRows_(months[months.length - 1]);

  var minDate = null, maxDate = null;
  earliestRows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (!minDate || d < minDate) minDate = d;
  });
  latestRows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (!maxDate || d > maxDate) maxDate = d;
  });

  return { min: minDate, max: maxDate, monthsAvailable: months.length };
}
