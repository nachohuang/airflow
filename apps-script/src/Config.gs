/**
 * Config.gs
 * 全域設定：試算表 / 資料夾 / 分頁欄位結構。
 * 所有「路徑」都集中在這裡，後台管理頁面即是圍繞這些路徑做檔案總覽/刪除。
 */

var CONFIG = {
  // Script Properties 的 key 名稱
  PROP_KEYS: {
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    ROOT_FOLDER_ID: 'ROOT_FOLDER_ID',
    ARCHIVE_FOLDER_ID: 'ARCHIVE_FOLDER_ID',       // 對應原本 Consolidated_file
    REPORTS_FOLDER_ID: 'REPORTS_FOLDER_ID',       // 對應原本 Reports
    REGRESSION_FOLDER_ID: 'REGRESSION_FOLDER_ID', // 對應原本 Regression
    TRIGGER_ID: 'TRIGGER_ID',
    TRIGGER_HOUR: 'TRIGGER_HOUR',
    TRIGGER_MINUTE: 'TRIGGER_MINUTE',
    SKIP_WEEKENDS: 'SKIP_WEEKENDS'
  },

  ROOT_FOLDER_NAME: 'TWSE_App',
  ARCHIVE_FOLDER_NAME: 'Consolidated_file',
  REPORTS_FOLDER_NAME: 'Reports',
  REGRESSION_FOLDER_NAME: 'Regression',

  SHEET_NAMES: {
    HISTORY: 'History',
    PORTFOLIO: 'Portfolio',
    REPORTS: 'Reports',
    RUN_LOG: 'RunLog',
    SKIP_DATES: 'SkipDates',
    BACKTEST: 'BacktestResults',
    FACTOR_SCAN: 'FactorScanResults'
  },

  // History 分頁欄位 - 對應 Colab final_df 的 desired_final_columns
  HISTORY_COLUMNS: [
    '日期', '證券代號', '證券名稱', '外資', '投信', '自營商', '三大法人買賣超股數',
    '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價',
    '漲跌(+/-)', '漲跌價差', '最後揭示買價', '最後揭示買量', '最後揭示賣價', '最後揭示賣量',
    '殖利率(%)', '本益比', '股價淨值比', '財報年/季'
  ],

  HISTORY_NUMERIC_COLUMNS: [
    '外資', '投信', '自營商', '三大法人買賣超股數',
    '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價',
    '漲跌價差', '最後揭示買價', '最後揭示買量', '最後揭示賣價', '最後揭示賣量',
    '殖利率(%)', '本益比', '股價淨值比'
  ],

  PORTFOLIO_COLUMNS: ['證券代號', '證券名稱', '成本', '買進日期', '備註'],

  // 給 Reports 分頁 / 手機 UI 用的精簡欄位
  REPORT_COLUMNS: [
    '日期', '證券代號', '證券名稱', 'Armor_Score', '操作策略', '建議動作',
    '實相解讀', 'Trend_Score', 'Inst_Part_Rank', 'IBF_20D_Rank', '監控連結', '參考最高價'
  ],

  // 給 Drive 上 xlsx 戰報快照用的完整欄位，跟原本 Colab v17.0 to_excel() 存出來的欄位一致
  FULL_REPORT_COLUMNS: [
    '日期', '證券代號', '證券名稱', '外資', '投信', '自營商', '三大法人買賣超股數',
    '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價',
    '漲跌(+/-)', '漲跌價差', '最後揭示買價', '最後揭示買量', '最後揭示賣價', '最後揭示賣量',
    '殖利率(%)', '本益比', '股價淨值比', '財報年/季',
    'Inst_Net', 'Inst_Participation', 'Inst_Part_MA5', 'Inst_Part_Rank',
    'Daily_Return', 'Is_Drop', 'Is_Inst_Buy_On_Drop', 'IBF_20D', 'IBF_20D_Rank',
    'MA20', 'MA20_Slope', 'Trend_Score', 'Vol_MA20', 'Vol_Ratio', 'Vol_Ratio_Rank',
    'MA60', 'BIAS_60', 'Armor_Score', 'Adjusted_Peak',
    '操作策略', '建議動作', '實相解讀', '監控連結', '參考最高價'
  ],

  RUN_LOG_COLUMNS: ['時間戳記', '類型', '狀態', '訊息', '耗時(秒)'],

  SKIP_DATES_COLUMNS: ['日期', '原因'],

  // 策略參數（原本寫死在各 cell，現在集中管理，可再開放給 UI 調整）
  STRATEGY: {
    LIQUIDITY_MIN: 40000000,
    TRAILING_STOP_PERCENT: 0.025
  },

  // Analysis.gs 每次只讀取最近 N 天的 History 資料來算 rolling 指標
  // （MA60 需要 60 個交易日 + IBF20/Vol20 緩衝，120 天日曆天數綽綽有餘，
  //  這是為了讓 Apps Script 6 分鐘執行上限下仍可全量重算，而不必無限制吃全部歷史）
  ANALYSIS_LOOKBACK_DAYS: 150,

  // Google Sheets 單一試算表上限是 10,000,000 個儲存格。History 有 24 欄，
  // 台股上市櫃合計約 1,700+ 檔，等於一個交易日大約增加 4 萬格。
  // 保留 270 天（約 9 個月，180 個交易日）大致落在 ~700 萬格，留給 Portfolio/Reports/RunLog 等分頁空間。
  // 超過保留天數的舊資料不會被丟掉，會先封存成 CSV 存進 Archive 資料夾（後台管理可以看到/下載），
  // 再從 History 分頁移除，需要更長歷史時可以調高這個數字或去 Archive 資料夾撈檔案。
  HISTORY_RETENTION_DAYS: 270,

  DEFAULT_TRIGGER_HOUR: 20,
  DEFAULT_TRIGGER_MINUTE: 30
};

/**
 * 取得（或建立）主要 Spreadsheet。
 */
function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(CONFIG.PROP_KEYS.SPREADSHEET_ID);
  var ss;
  if (id) {
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (e) {
      ss = null;
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('TWSE 法人動能選股 App 資料庫');
    props.setProperty(CONFIG.PROP_KEYS.SPREADSHEET_ID, ss.getId());
  }
  return ss;
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

function getRootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(CONFIG.PROP_KEYS.ROOT_FOLDER_ID);
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      // fall through and recreate
    }
  }
  var folder = getOrCreateFolder_(DriveApp.getRootFolder(), CONFIG.ROOT_FOLDER_NAME);
  props.setProperty(CONFIG.PROP_KEYS.ROOT_FOLDER_ID, folder.getId());
  return folder;
}

function getArchiveFolder_() {
  return getNamedSubfolder_(CONFIG.PROP_KEYS.ARCHIVE_FOLDER_ID, CONFIG.ARCHIVE_FOLDER_NAME);
}

function getReportsFolder_() {
  return getNamedSubfolder_(CONFIG.PROP_KEYS.REPORTS_FOLDER_ID, CONFIG.REPORTS_FOLDER_NAME);
}

function getRegressionFolder_() {
  return getNamedSubfolder_(CONFIG.PROP_KEYS.REGRESSION_FOLDER_ID, CONFIG.REGRESSION_FOLDER_NAME);
}

function getNamedSubfolder_(propKey, folderName) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(propKey);
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      // fall through and recreate
    }
  }
  var folder = getOrCreateFolder_(getRootFolder_(), folderName);
  props.setProperty(propKey, folder.getId());
  return folder;
}

/**
 * 初始化整個專案：建立 Spreadsheet + 分頁 + Drive 資料夾。
 * 第一次部署後，先手動執行這個函式一次（或由 doGet 的 setup 頁觸發）。
 */
function initializeProject() {
  var ss = getSpreadsheet_();
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.HISTORY, CONFIG.HISTORY_COLUMNS);
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.PORTFOLIO, CONFIG.PORTFOLIO_COLUMNS);
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.REPORTS, CONFIG.REPORT_COLUMNS);
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.RUN_LOG, CONFIG.RUN_LOG_COLUMNS);
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.SKIP_DATES, CONFIG.SKIP_DATES_COLUMNS);

  // 預設分頁 'Sheet1' 若還存在且是空的，就把它砍掉，保持整潔
  var def = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) {
    ss.deleteSheet(def);
  }

  getArchiveFolder_();
  getReportsFolder_();
  getRegressionFolder_();

  return {
    spreadsheetUrl: ss.getUrl(),
    rootFolderUrl: getRootFolder_().getUrl()
  };
}
