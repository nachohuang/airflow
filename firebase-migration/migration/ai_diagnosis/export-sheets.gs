/**
 * export-sheets.gs
 * AiDiagnosis 版遷移匯出腳本：把 AiDiagnosis 分頁匯出成 JSON，寫進 Drive 根
 * 資料夾一個新檔案，供下載後餵給 import-firestore.js。跟 watchlist/portfolio
 * 的 export-sheets.gs 同一套流程，用法見 firebase-migration/README.md。
 *
 * 用法：把這支函式暫時加進既有 Apps Script 專案（才能直接呼叫既有的
 * getAiDiagnosisSheet_()／readSheetObjects_()），在 Apps Script 編輯器手動
 * 執行一次 exportAiDiagnosisToJson()，執行完在「執行紀錄」看得到輸出檔案的
 * Drive 連結，下載那個 .json 檔案即可。
 *
 * ⚠️ 函式名稱不能用底線結尾（不是 exportAiDiagnosisToJson_）——Apps Script
 * 編輯器的「執行」下拉選單會把結尾底線的函式當內部函式直接隱藏，找不到不代表
 * 存檔失敗，是這個命名慣例本身被 UI 特殊處理（Watchlist spike 踩過這個坑，見
 * firebase-migration/README.md 的「已知的坑」段落）。
 *
 * 只是一次性的遷移工具，不是常駐功能——用完記得把暫時貼進去的這段函式刪掉、
 * 存檔，恢復原狀；apps-script/ 目錄本身完全沒有被這次遷移動到，現有的 AI 診斷
 * 功能繼續正常運作。
 */
function exportAiDiagnosisToJson() {
  var rows = readSheetObjects_(getAiDiagnosisSheet_()); // AiDiagnosis.gs 既有的讀取函式，欄位是中文鍵名
  var payload = {
    exportedAt: new Date().toISOString(),
    source: 'AiDiagnosis',
    rowCount: rows.length,
    rows: rows
  };
  var json = JSON.stringify(payload, null, 2);
  var fileName = 'ai_diagnosis-export-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '.json';
  var file = DriveApp.getRootFolder().createFile(fileName, json, MimeType.PLAIN_TEXT);
  Logger.log('已匯出 %s 筆，檔案：%s', rows.length, file.getUrl());
  return { rowCount: rows.length, fileUrl: file.getUrl(), fileName: fileName };
}
