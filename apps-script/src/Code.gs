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
    schedule: getScheduleSettings()
  };
}
