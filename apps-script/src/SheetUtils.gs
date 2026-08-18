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
 * 每日排程/補抓/匯入抓到的新資料要寫去哪裡：
 *   有設定 BigQuery 專案 -> 直接 WRITE_APPEND 進 history_raw（BigQuerySync.gs
 *     upsertHistoryRowsToBigQuery_），不再另外寫 Drive 月份 CSV 檔案——避免歷史檔案
 *     越滾越大，某一天 Apps Script 讀不動整個檔案。
 *   沒有設定 BigQuery -> 維持原本寫 Drive 月份 CSV 檔案的行為（HistoryFiles.gs），
 *     這樣沒有接 BigQuery 的使用者一樣能正常使用 App。
 */
function upsertHistoryRows_(newRows) {
  if (shouldWriteToBigQuery_()) {
    return upsertHistoryRowsToBigQuery_(newRows);
  }
  return upsertHistoryRowsToMonthlyFiles_(newRows);
}

/**
 * 讀取歷史資料的入口，Analysis.gs / Backtest.gs / FactorScan.gs / StockAnalysis.gs 都呼叫這兩個函式，
 * 完全不用管資料到底存在哪裡。依「因子回歸模型」設定的資料來源模式決定實際去哪裡讀：
 *   - BigQuery 設定為 external 或 materialized 模式：改讀 BigQuery
 *    （見 BigQuerySync.gs 的 queryHistoryRowsFromBigQuery_），Apps Script 完全不會直接讀取
 *     Drive 上的歷史 CSV 檔案內容，不管檔案多大都不會卡住。
 *   - 其他情況（沒設定 BigQuery，或設定為 native 模式）：維持原本讀 Drive 月份檔案的做法
 *     （HistoryFiles.gs），這樣就算沒有 GCP 專案，App 的核心功能還是能正常運作。
 */
function shouldUseBigQueryForReads_() {
  var settings = getBigQuerySettings();
  return !!settings.projectId && (settings.sourceMode === 'external' || settings.sourceMode === 'materialized');
}

/** 只讀最近 N 天（含）的歷史資料，給每日分析用，避免不必要地讀太多月份的檔案。 */
function readRecentHistory_(days) {
  if (shouldUseBigQueryForReads_()) {
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return queryHistoryRowsFromBigQuery_(normalizeDateStr(cutoff), null);
  }
  return readRecentHistoryFromFiles_(days);
}

/** 讀取指定日期區間（含頭尾）的歷史資料，給回測/因子掃描用。 */
function readHistoryRange_(startStr, endStr) {
  if (shouldUseBigQueryForReads_()) {
    return queryHistoryRowsFromBigQuery_(startStr || null, endStr || null);
  }
  return readHistoryRangeFromFiles_(startStr, endStr);
}

/**
 * 只讀「單一股票代號」最近 N 天的歷史資料，給「個股分析」（getStockTimeSeries）用。
 * 跟 readRecentHistory_ 的差別：BigQuery 模式下直接在查詢裡用 WHERE stock_id 過濾
 * （見 queryHistoryRowsForCodesFromBigQuery_），不會把全市場資料都搬進 Apps Script
 * 再篩選——後者資料量大時會撞到 6 分鐘執行上限，導致個股走勢卡在載入畫面不動。
 * 檔案模式（沒接 BigQuery）本來就只讀 days 天份的月份檔案，資料量小，可以接受先讀再篩。
 */
function readHistoryForCode_(code, days) {
  return readHistoryForCodes_([code], days);
}

/**
 * 只讀「指定這幾檔股票代號」最近 N 天的歷史資料，給「持股庫存」（getLatestCloseByCode_，
 * 讀持股目前市價用）跟持股續抱診斷用——同一批股票數量通常很小（使用者自己持有的幾檔），
 * 跟 readHistoryForCode_ 一樣不要在 BigQuery 模式下把全市場資料都搬進 Apps Script
 * 再篩選（原本 getLatestCloseByCode_() 呼叫 readRecentHistory_(10) 就是這個問題：即使
 * 只是抓 10 天，BigQuery 模式下還是「全市場 x 10 天」的資料量，慢的時候會讓「持股庫存」
 * 卡住甚至跳出 NetworkError HTTP 0）。
 */
function readHistoryForCodes_(codes, days) {
  codes = (codes || []).filter(function (c) { return c; });
  if (codes.length === 0) return [];
  if (shouldUseBigQueryForReads_()) {
    return queryHistoryRowsForCodesFromBigQuery_(codes, days);
  }
  var target = {};
  codes.forEach(function (c) { target[zfill4(String(c).trim())] = true; });
  return readRecentHistoryFromFiles_(days).filter(function (r) {
    return target[zfill4(String(r['證券代號']).trim())];
  });
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

/** 「類型」欄位分組用：取第一個「-」前的文字（例如「每日排程-補抓資料」歸進「每日排程」
 *  這組），讓不同步驟/子動作各自寫的細分類型字串（logRun_ 呼叫端到處都有，沒有集中管理
 *  的固定列舉）在「執行紀錄」的篩選下拉選單裡可以合併成同一個看得懂的大類。 */
function runLogCategoryOf_(type) {
  return String(type || '').split('-')[0];
}

/** 供前端「後台管理」頁面呼叫：取得最近的執行紀錄，可選擇只看某個類別（見
 *  runLogCategoryOf_ 的分組邏輯）——篩選要在 reverse+slice「取最近 N 筆」之前做，不然
 *  「最近 50 筆全部類型」裡剛好沒幾筆是你要的類別，篩完看起來會像是「幾乎沒有紀錄」，
 *  其實只是被還沒篩選就先限制筆數的舊寫法擠掉了。「時間戳記」欄位是 'yyyy-MM-dd HH:mm:ss'
 *  格式的字串寫進去的，但 Google Sheets 常把這種看起來像日期時間的字串自動存成 Date 物件，
 *  讀回來直接回傳給前端有可能讓整包回傳值序列化失敗（見 sanitizeRowForRpc_ 的說明）。 */
function getRecentRunLogs(limit, category) {
  var rows = readSheetObjects_(ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.RUN_LOG, CONFIG.RUN_LOG_COLUMNS));
  if (category) {
    rows = rows.filter(function (r) { return runLogCategoryOf_(r['類型']) === category; });
  }
  rows.reverse();
  return rows.slice(0, limit || 50).map(sanitizeRowForRpc_);
}

/** 執行紀錄篩選下拉選單用：掃過整份表（不受 limit 影響，才不會漏掉比較久以前才出現過、
 *  但最近沒再發生的類別）取得目前實際出現過的所有分組，由新到舊沒有特別意義，這裡直接
 *  排序成好找的字母序。 */
function getRunLogCategories() {
  var rows = readSheetObjects_(ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.RUN_LOG, CONFIG.RUN_LOG_COLUMNS));
  var seen = {};
  rows.forEach(function (r) {
    var group = runLogCategoryOf_(r['類型']);
    if (group) seen[group] = true;
  });
  return Object.keys(seen).sort();
}
