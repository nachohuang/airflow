/**
 * Code.gs
 * Web App 進入點。
 */

function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('TWSE 法人動能選股')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** HTML template 用來 include 其他檔案（CSS / JS 片段）。 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * 前端載入時呼叫一次，回傳整個 App 開機所需的摘要資訊。
 * 若 Spreadsheet / 資料夾都還沒建立，會自動初始化。
 */
function bootstrap() {
  initializeProject();
  var ss = getSpreadsheet_();
  var bounds = getHistoryDateBounds();
  return {
    spreadsheetUrl: ss.getUrl(),
    historyFolderUrl: getArchiveFolder_().getUrl(),
    monthsAvailable: bounds.monthsAvailable,
    latestHistoryDate: bounds.max,
    schedule: getScheduleSettings(),
    aiProvider: getAiSettings().provider
  };
}

/** 除錯用：最單純的 google.script.run 往返測試，不碰任何試算表/BigQuery，純粹確認
 *  「伺服器端程式碼有沒有在跑、RPC 往返本身正不正常」。如果連這個都回傳空值/逾時，代表
 *  問題出在 google.script.run 或整個部署本身，不會是任何一個特定功能函式的邏輯問題；
 *  如果這個正常、但某個特定功能函式回傳空值，問題就縮小到那個函式本身。 */
function pingServer() {
  return { ok: true, serverTimeMs: Date.now() };
}
