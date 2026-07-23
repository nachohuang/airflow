/**
 * SheetUtils.gs
 * 把 Google Sheet 分頁當成「表格資料庫」讀寫的共用層。
 * 命名尾端加 `_` 純粹是慣例，代表「內部使用、不是設計給前端呼叫的介面」。
 */

function ensureSheetWithHeaders_(ss, name, columns) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** 把整張表讀成「陣列的物件」，key 為標題列文字。 */
function readSheetObjects_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values.map(function (row) {
    var obj = {};
    for (var i = 0; i < headers.length; i++) obj[headers[i]] = row[i];
    return obj;
  });
}

/** 整張表覆寫（含標題列），欄位順序依 columns 陣列。 */
function writeSheetObjects_(sheet, columns, objects) {
  sheet.clearContents();
  sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
  if (!objects || objects.length === 0) return;
  var data = objects.map(function (o) {
    return columns.map(function (c) {
      var v = o[c];
      return (v === undefined || v === null) ? '' : v;
    });
  });
  sheet.getRange(2, 1, data.length, columns.length).setValues(data);
}

/** 在既有資料尾端附加新列。 */
function appendSheetObjects_(sheet, columns, objects) {
  if (!objects || objects.length === 0) return;
  var startRow = sheet.getLastRow() + 1;
  var data = objects.map(function (o) {
    return columns.map(function (c) {
      var v = o[c];
      return (v === undefined || v === null) ? '' : v;
    });
  });
  sheet.getRange(startRow, 1, data.length, columns.length).setValues(data);
}

/**
 * 通用「依日期整批取代」upsert：任何「新資料涵蓋到的日期」，既有資料會先整批移除再放入新資料，
 * 對應原本 Colab 「dates_to_remove」那段邏輯（避免同一天重複資料)。Reports 分頁靠這個函式寫入
 * （History 已經改成 Drive 上的月份 CSV 檔，見 upsertHistoryRows_ 跟 HistoryFiles.gs）。
 */
function upsertRowsByDate_(sheet, columns, newRows) {
  if (!newRows || newRows.length === 0) return { added: 0, replacedDates: [], totalRows: 0 };
  var existing = readSheetObjects_(sheet);

  var newDateSet = {};
  newRows.forEach(function (r) { newDateSet[normalizeDateStr(r['日期'])] = true; });

  var kept = existing.filter(function (r) { return !newDateSet[normalizeDateStr(r['日期'])]; });
  var merged = kept.concat(newRows);
  merged = sortRows(merged, [
    ['證券代號', 'asc'],
    [function (r) { return normalizeDateStr(r['日期']); }, 'desc']
  ]);

  writeSheetObjects_(sheet, columns, merged);
  return { added: newRows.length, replacedDates: Object.keys(newDateSet), totalRows: merged.length };
}

/**
 * History 現在存在 Drive 上按月分開的 CSV 檔（HistoryFiles.gs），不是 Google Sheets 分頁。
 * 這三個函式維持原本的名稱與介面，只是內部改成呼叫檔案版實作 —— Analysis.gs / Backtest.gs /
 * FactorScan.gs / DataFetch.gs / ImportHistory.gs / Portfolio.gs / StockAnalysis.gs
 * 完全不需要跟著改，一樣呼叫 upsertHistoryRows_ / readRecentHistory_ / readHistoryRange_ 就好。
 */
function upsertHistoryRows_(newRows) {
  return upsertHistoryRowsToMonthlyFiles_(newRows);
}

/** 只讀最近 N 天（含）的歷史資料，給每日分析用，避免不必要地讀太多月份的檔案。 */
function readRecentHistory_(days) {
  return readRecentHistoryFromFiles_(days);
}

/** 讀取指定日期區間（含頭尾）的歷史資料，給回測/因子掃描用。 */
function readHistoryRange_(startStr, endStr) {
  return readHistoryRangeFromFiles_(startStr, endStr);
}

/** 寫入一筆執行紀錄（成功/失敗），供後台管理頁面顯示，並自動裁剪舊紀錄。 */
function logRun_(type, status, message, durationSec) {
  var sheet = ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.RUN_LOG, CONFIG.RUN_LOG_COLUMNS);
  var ts = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  appendSheetObjects_(sheet, CONFIG.RUN_LOG_COLUMNS, [{
    '時間戳記': ts, '類型': type, '狀態': status, '訊息': String(message || ''), '耗時(秒)': durationSec || ''
  }]);
  var lastRow = sheet.getLastRow();
  var maxRows = 500;
  if (lastRow - 1 > maxRows) {
    sheet.deleteRows(2, (lastRow - 1) - maxRows);
  }
}

/** 供前端「後台管理」頁面呼叫：取得最近的執行紀錄。 */
function getRecentRunLogs(limit) {
  var rows = readSheetObjects_(ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.RUN_LOG, CONFIG.RUN_LOG_COLUMNS));
  rows.reverse();
  return rows.slice(0, limit || 50);
}
