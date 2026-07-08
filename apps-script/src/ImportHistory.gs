/**
 * ImportHistory.gs
 * 讓使用者把「既有的彙整表」（例如原本 Colab 產出的 ALL_COMBINED.csv）匯入成 History 分頁的起始資料，
 * 這樣往後每天的自動抓取都是在這份既有資料上疊加，不用整個從零開始重新抓。
 *
 * 跟 DataFetch.gs 的差別：這裡完全不呼叫 TWSE，只是把 Drive 上「使用者自己已經有的檔案」讀進來。
 */

/** 從一個 Google Drive 分享連結或純 ID 字串取出檔案 ID。 */
function extractDriveFileId_(input) {
  var s = String(input || '').trim();
  var m = s.match(/\/d\/([-\w]{10,})/) || s.match(/[?&]id=([-\w]{10,})/);
  if (m) return m[1];
  return s; // 假設使用者已經直接貼了純 ID
}

/**
 * 讓「匯入既有彙整表」也能直接從手機/電腦本機挑檔案上傳，不用先手動傳到 Drive 再貼連結。
 * 前端把選好的檔案讀成文字後，切成幾 MB 一段依序呼叫這個函式（避免單次呼叫塞太大的文字），
 * 第一段不帶 fileId 會建立新檔案（順便存進 Archive 資料夾，等於也留一份原始檔備份），
 * 之後每段把內容接到同一個檔案後面；全部段落送完後，前端再呼叫既有的
 * importHistoryFromDriveFile(fileId, 0) 走一樣的匯入流程。
 */
function uploadHistoryFileChunk(fileId, chunkText, fileName) {
  var folder = getArchiveFolder_();
  var file;
  if (!fileId) {
    var name = fileName || ('upload_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd_HHmmss') + '.csv');
    file = folder.createFile(name, chunkText, MimeType.CSV);
  } else {
    file = DriveApp.getFileById(fileId);
    file.setContent(file.getBlob().getDataAsString('UTF-8') + chunkText);
  }
  return { fileId: file.getId(), fileName: file.getName() };
}

var IMPORT_CHUNK_SIZE = 20000; // 每次呼叫最多處理的資料列數，避免單次執行時間/儲存格數超過上限

/**
 * 匯入既有彙整表，支援 CSV 檔案或 Google 試算表；不支援 .xlsx（Apps Script 沒有原生解析器）。
 * fileIdOrUrl：Drive 分享連結或檔案 ID。
 * startRow：從資料列（不含標題列）第幾列開始處理，預設 0；資料量大時分批呼叫，
 *           回傳 done:false 時用回傳的 nextStart 再呼叫一次繼續，直到 done:true。
 */
function importHistoryFromDriveFile(fileIdOrUrl, startRow) {
  startRow = startRow || 0;
  var startTime = Date.now();
  var fileId = extractDriveFileId_(fileIdOrUrl);
  var file = DriveApp.getFileById(fileId);
  var mime = file.getMimeType();

  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mime === MimeType.MICROSOFT_EXCEL) {
    throw new Error(
      '這是 .xlsx 檔案，Apps Script 沒有原生的 xlsx 解析器，無法直接匯入。' +
      '請在 Google Drive 用「開啟工具」→「Google 試算表」開啟並另存一份 Google 試算表格式，' +
      '或是另存成 CSV，再用轉換後的檔案匯入。'
    );
  }

  var headerRow, dataRows;
  if (mime === MimeType.GOOGLE_SHEETS) {
    var ss = SpreadsheetApp.openById(fileId);
    var values = ss.getSheets()[0].getDataRange().getValues();
    headerRow = values[0] || [];
    dataRows = values.slice(1);
  } else {
    var text = file.getBlob().getDataAsString('UTF-8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去掉 utf-8-sig 的 BOM
    var parsed = Utilities.parseCsv(text);
    headerRow = parsed[0] || [];
    dataRows = parsed.slice(1);
  }

  var idx = indexHeaders_(headerRow.map(function (h) { return String(h).trim(); }));
  if (idx['證券代號'] === undefined || idx['日期'] === undefined) {
    throw new Error('檔案裡找不到「日期」或「證券代號」欄位，請確認是原本匯出的彙整表格式。');
  }

  var totalDataRows = dataRows.length;
  var endRow = Math.min(startRow + IMPORT_CHUNK_SIZE, totalDataRows);
  var chunk = dataRows.slice(startRow, endRow);

  var rows = chunk.map(function (fields) {
    var row = {};
    CONFIG.HISTORY_COLUMNS.forEach(function (col) {
      var i = idx[col];
      var v = i === undefined ? '' : fields[i];
      if (CONFIG.HISTORY_NUMERIC_COLUMNS.indexOf(col) !== -1) {
        row[col] = toNumber(v);
      } else {
        row[col] = (v === undefined || v === null) ? '' : String(v).trim();
      }
    });
    return row;
  }).filter(function (r) { return r['證券代號']; });

  if (rows.length > 0) upsertHistoryRows_(rows);

  var done = endRow >= totalDataRows;
  var dur = Math.round((Date.now() - startTime) / 1000);
  logRun_('匯入歷史資料', done ? '成功' : '進行中',
    '已匯入第 ' + (startRow + 1) + '-' + endRow + ' 列（共 ' + totalDataRows + ' 列，來源檔案：' + file.getName() + '）', dur);

  return {
    done: done,
    imported: rows.length,
    processedThrough: endRow,
    totalRows: totalDataRows,
    nextStart: done ? null : endRow,
    fileName: file.getName()
  };
}
