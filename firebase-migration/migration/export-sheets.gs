/**
 * export-sheets.gs
 * Phase 2 spike 專用：把 Watchlist 分頁匯出成 JSON，寫進 Drive 根資料夾一個新檔案，
 * 供下載後餵給 import-firestore.js。
 *
 * 用法：把這支函式暫時加進既有 Apps Script 專案（跟 Watchlist.gs 同一個專案，
 * 才能直接呼叫既有的 readWatchlistRows_()），在 Apps Script 編輯器手動執行一次
 * exportWatchlistToJson_()，執行完在「執行紀錄」（檢視 > 執行紀錄）看得到輸出
 * 檔案的 Drive 連結，下載那個 .json 檔案即可。
 *
 * 只是一次性的遷移工具，不是常駐功能——這次 Watchlist spike 驗證完，這支函式
 * 可以從正式的 Apps Script 專案移除，不用留著長期維護；apps-script/ 目錄本身
 * 完全沒有被這次遷移動到，現有的觀察個股功能繼續正常運作。
 */
function exportWatchlistToJson_() {
  var rows = readWatchlistRows_(); // Watchlist.gs 既有的純讀取函式，欄位是中文鍵名
  var payload = {
    exportedAt: new Date().toISOString(),
    source: 'Watchlist',
    rowCount: rows.length,
    rows: rows
  };
  var json = JSON.stringify(payload, null, 2);
  var fileName = 'watchlist-export-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '.json';
  var file = DriveApp.getRootFolder().createFile(fileName, json, MimeType.PLAIN_TEXT);
  Logger.log('已匯出 %s 筆，檔案：%s', rows.length, file.getUrl());
  return { rowCount: rows.length, fileUrl: file.getUrl(), fileName: fileName };
}
