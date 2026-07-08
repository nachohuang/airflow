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
  var historySheet = ss.getSheetByName(CONFIG.SHEET_NAMES.HISTORY);
  var lastRow = historySheet.getLastRow();
  var latestDate = null;
  if (lastRow > 1) {
    var dates = historySheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < dates.length; i++) {
      var d = dates[i][0];
      if (d && (!latestDate || d > latestDate)) latestDate = d;
    }
  }
  return {
    spreadsheetUrl: ss.getUrl(),
    historyRowCount: Math.max(0, lastRow - 1),
    latestHistoryDate: latestDate ? Utilities.formatDate(new Date(latestDate), 'Asia/Taipei', 'yyyy-MM-dd') : null,
    schedule: getScheduleSettings()
  };
}
