/**
 * export-sheets.gs
 * Portfolio 版遷移匯出腳本：把 Portfolio 分頁匯出成 JSON，寫進 Drive 根資料夾
 * 一個新檔案，供下載後餵給 import-firestore.js。跟 watchlist/export-sheets.gs
 * 同一套流程，用法見 firebase-migration/README.md。
 *
 * 用法：把這支函式暫時加進既有 Apps Script 專案（才能直接呼叫既有的
 * readPortfolioLots_()），在 Apps Script 編輯器手動執行一次
 * exportPortfolioToJson()，執行完在「執行紀錄」看得到輸出檔案的 Drive 連結，
 * 下載那個 .json 檔案即可。
 *
 * ⚠️ 函式名稱不能用底線結尾（不是 exportPortfolioToJson_）——Apps Script 編輯器
 * 的「執行」下拉選單會把結尾底線的函式當內部函式直接隱藏，找不到不代表存檔失敗，
 * 是這個命名慣例本身被 UI 特殊處理（Watchlist spike 踩過這個坑，見
 * firebase-migration/README.md 的「踩過的坑」段落）。
 *
 * 只是一次性的遷移工具，不是常駐功能——用完記得把暫時貼進去的這段函式刪掉、
 * 存檔，恢復原狀；apps-script/ 目錄本身完全沒有被這次遷移動到，現有的持股庫存
 * 功能繼續正常運作。
 */
function exportPortfolioToJson() {
  var rows = readPortfolioLots_(); // Portfolio.gs 既有的純讀取函式，欄位是中文鍵名
  var payload = {
    exportedAt: new Date().toISOString(),
    source: 'Portfolio',
    rowCount: rows.length,
    rows: rows
  };
  var json = JSON.stringify(payload, null, 2);
  var fileName = 'portfolio-export-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '.json';
  var file = DriveApp.getRootFolder().createFile(fileName, json, MimeType.PLAIN_TEXT);
  Logger.log('已匯出 %s 筆，檔案：%s', rows.length, file.getUrl());
  return { rowCount: rows.length, fileUrl: file.getUrl(), fileName: fileName };
}
