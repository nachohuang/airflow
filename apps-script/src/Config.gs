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
    SKIP_WEEKENDS: 'SKIP_WEEKENDS',
    ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
    GEMINI_API_KEY: 'GEMINI_API_KEY',
    AI_PROVIDER: 'AI_PROVIDER', // 'claude' | 'gemini'
    AI_DAILY_ENABLED: 'AI_DAILY_ENABLED',
    AI_DAILY_TOP_N: 'AI_DAILY_TOP_N',
    CLAUDE_PRICE_INPUT: 'CLAUDE_PRICE_INPUT',
    CLAUDE_PRICE_OUTPUT: 'CLAUDE_PRICE_OUTPUT',
    GEMINI_PRICE_INPUT: 'GEMINI_PRICE_INPUT',
    GEMINI_PRICE_OUTPUT: 'GEMINI_PRICE_OUTPUT'
  },

  // 使用者指定的 Drive 資料夾：App 的 Spreadsheet + Reports/Regression 資料夾都會直接放這裡面，
  // 不會再另外包一層自動建立的資料夾。要換掉的話，改這兩個 ID 就好（或透過 Script Properties 覆蓋）。
  DEFAULT_PARENT_FOLDER_ID: '1Phjl3LTlvJxIz49vH8KxXF2mV3v9VZeR',
  // 每月一份 ALL_COMBINED 歷史資料 CSV 放的資料夾（對應原本 Consolidated_file 的角色）。
  DEFAULT_HISTORY_FILES_FOLDER_ID: '10Eq1V9r_Wt9B7sqE2tEKuno8v4CmP-tP',

  REPORTS_FOLDER_NAME: 'Reports',
  REGRESSION_FOLDER_NAME: 'Regression',

  // 每月歷史資料檔名格式：YYYY-MM_ALL_COMBINED.csv
  HISTORY_FILE_SUFFIX: '_ALL_COMBINED.csv',

  SHEET_NAMES: {
    PORTFOLIO: 'Portfolio',
    REPORTS: 'Reports',
    RUN_LOG: 'RunLog',
    SKIP_DATES: 'SkipDates',
    BACKTEST: 'BacktestResults',
    FACTOR_SCAN: 'FactorScanResults',
    AI_DIAGNOSIS: 'AiDiagnosis',
    AI_USAGE: 'AiUsage'
  },

  AI_DIAGNOSIS_COLUMNS: ['日期', '證券代號', '證券名稱', 'Armor_Score', '操作策略', '最終建議', '診斷內容', '時間戳記'],

  AI_USAGE_COLUMNS: ['日期', '時間戳記', '供應商', '模型', '證券代號', '輸入Tokens', '輸出Tokens', '預估費用(USD)'],

  // Claude API 設定：模型可依需要換成 claude-opus-4-8 (更貴更強) 或 claude-haiku-4-5-20251001 (更便宜)
  CLAUDE_MODEL: 'claude-sonnet-5',
  CLAUDE_MAX_TOKENS: 3000,

  // Gemini API 設定（透過 Google AI Studio 申請的 key，走 Generative Language API）。
  // 模型名稱 Google 三不五時會更新/淘汰，如果呼叫失敗（HTTP 404）記得去
  // https://ai.google.dev/gemini-api/docs/models 查目前可用的模型名稱換掉。
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_MAX_TOKENS: 3000,

  // 費用估算用的「參考單價」（USD / 每百萬 tokens）。這些是概略預設值，不是即時公告的官方價格，
  // 一定會跟你實際帳單有落差，請自行到官方頁面核對後在「後台管理」修改：
  // Claude: https://www.anthropic.com/pricing#api　Gemini: https://ai.google.dev/gemini-api/docs/pricing
  CLAUDE_PRICE_INPUT_PER_M_DEFAULT: 3,
  CLAUDE_PRICE_OUTPUT_PER_M_DEFAULT: 15,
  GEMINI_PRICE_INPUT_PER_M_DEFAULT: 0.3,
  GEMINI_PRICE_OUTPUT_PER_M_DEFAULT: 2.5,

  AI_DAILY_TOP_N_DEFAULT: 3,

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

  // Analysis.gs 每次只讀最近 N 天的歷史資料來算 rolling 指標
  // （MA60 需要 60 個交易日 + IBF20/Vol20 緩衝，120 天日曆天數綽綽有餘）。
  // 歷史資料是按月分開存檔（HistoryFiles.gs），所以這裡只是決定要讀哪幾個月份的檔案，
  // 不會有 Google Sheets 儲存格數量上限的問題（那是舊版設計，已經不適用）。
  ANALYSIS_LOOKBACK_DAYS: 150,

  DEFAULT_TRIGGER_HOUR: 20,
  DEFAULT_TRIGGER_MINUTE: 30
};

/**
 * 取得（或建立）主要 Spreadsheet，並確保它放在使用者指定的根資料夾裡（不是 Drive 根目錄）。
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
    moveFileIntoFolder_(ss.getId(), getRootFolder_());
  }
  return ss;
}

/** 把檔案從目前所在的父資料夾移到指定資料夾（Apps Script 沒有直接的「搬移」API，用移除舊parent+加新parent達成）。 */
function moveFileIntoFolder_(fileId, destFolder) {
  try {
    var file = DriveApp.getFileById(fileId);
    var parents = file.getParents();
    while (parents.hasNext()) {
      parents.next().removeFile(file);
    }
    destFolder.addFile(file);
  } catch (e) {
    // 搬移失敗不影響功能本身（例如權限問題），檔案還是能正常使用，只是位置沒搬過去
  }
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

/** App 的「家目錄」——使用者指定的既有資料夾，Spreadsheet 跟 Reports/Regression 都放在這底下。 */
function getRootFolder_() {
  return getFolderById_(CONFIG.PROP_KEYS.ROOT_FOLDER_ID, CONFIG.DEFAULT_PARENT_FOLDER_ID, '根');
}

/** 每月一份歷史資料 CSV 存放的資料夾（對應原本 Consolidated_file，也是使用者指定的既有資料夾）。 */
function getArchiveFolder_() {
  return getFolderById_(CONFIG.PROP_KEYS.ARCHIVE_FOLDER_ID, CONFIG.DEFAULT_HISTORY_FILES_FOLDER_ID, '歷史資料');
}

/** 依 Script Properties 記住的 ID（或預設 ID）直接取用一個既有資料夾；資料夾一定要已經存在，不會自動建立。 */
function getFolderById_(propKey, defaultId, label) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(propKey) || defaultId;
  try {
    var folder = DriveApp.getFolderById(id);
    props.setProperty(propKey, folder.getId());
    return folder;
  } catch (e) {
    throw new Error('找不到「' + label + '」資料夾（ID: ' + id + '），請確認資料夾 ID 正確，且這個 Google 帳號有權限存取。');
  }
}

function getReportsFolder_() {
  return getNamedSubfolder_(CONFIG.PROP_KEYS.REPORTS_FOLDER_ID, CONFIG.REPORTS_FOLDER_NAME);
}

function getRegressionFolder_() {
  return getNamedSubfolder_(CONFIG.PROP_KEYS.REGRESSION_FOLDER_ID, CONFIG.REGRESSION_FOLDER_NAME);
}

/** Reports / Regression 沒有各自的既有資料夾 ID，所以在根資料夾（使用者指定的那個）底下自動建立同名子資料夾。 */
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
 * 初始化整個專案：建立 Spreadsheet + 分頁 + 確認 Drive 資料夾都存在。
 * 第一次部署後，先手動執行這個函式一次（或由 doGet 的 setup 頁觸發）。
 *
 * 會建立的東西（都在 CONFIG.DEFAULT_PARENT_FOLDER_ID 這個資料夾裡）：
 *   - 1 份 Spreadsheet「TWSE 法人動能選股 App 資料庫」，內含 Portfolio / Reports / RunLog /
 *     SkipDates / AiDiagnosis / AiUsage 這幾個分頁（History 已改成 Drive 上的月份 CSV 檔，不是分頁）
 *   - Reports/ 資料夾（每日戰報 xlsx 快照）
 *   - Regression/ 資料夾（回測/因子掃描結果 CSV）
 * 另外 CONFIG.DEFAULT_HISTORY_FILES_FOLDER_ID 這個資料夾放每月一份的 ALL_COMBINED 歷史資料 CSV。
 */
function initializeProject() {
  var ss = getSpreadsheet_();
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.PORTFOLIO, CONFIG.PORTFOLIO_COLUMNS);
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.REPORTS, CONFIG.REPORT_COLUMNS);
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.RUN_LOG, CONFIG.RUN_LOG_COLUMNS);
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.SKIP_DATES, CONFIG.SKIP_DATES_COLUMNS);
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.AI_DIAGNOSIS, CONFIG.AI_DIAGNOSIS_COLUMNS);
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.AI_USAGE, CONFIG.AI_USAGE_COLUMNS);

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
