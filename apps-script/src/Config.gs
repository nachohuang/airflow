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
    GEMINI_PRICE_OUTPUT: 'GEMINI_PRICE_OUTPUT',
    BIGQUERY_PROJECT_ID: 'BIGQUERY_PROJECT_ID',
    BIGQUERY_DATASET: 'BIGQUERY_DATASET',
    BIGQUERY_SOURCE_MODE: 'BIGQUERY_SOURCE_MODE', // 'native' | 'external' | 'materialized'
    BIGQUERY_PRICE_PER_TB: 'BIGQUERY_PRICE_PER_TB',
    BIGQUERY_MATERIALIZED_LAST_REFRESH: 'BIGQUERY_MATERIALIZED_LAST_REFRESH',
    SCREENING_DIAGNOSTICS_CACHE: 'SCREENING_DIAGNOSTICS_CACHE' // {date, stats} JSON，避免 0 檔訊號時前端再重跑一次昂貴的歷史查詢
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
    AI_USAGE: 'AiUsage',
    FACTOR_MODEL_HISTORY: 'FactorModelHistory',
    BIGQUERY_USAGE: 'BigQueryUsage'
  },

  BIGQUERY_USAGE_COLUMNS: ['日期', '時間戳記', '類型', '掃描位元組數', '預估費用(USD)'],

  // BigQuery on-demand 查詢定價的參考單價（USD / TB 掃描量），這是概略預設值，不是即時公告的官方價格，
  // 一定會跟你實際帳單有落差，請自行到 https://cloud.google.com/bigquery/pricing 核對後在
  // 「資料總覽」頁籤修改。每月前 1TB 掃描量本身是免費的，這裡的估算沒有扣掉那個免費額度，
  // 所以正常使用量下，這裡算出來的「預估費用」通常會比實際帳單（$0）高，僅供參考掃描量趨勢用。
  BIGQUERY_PRICE_PER_TB_DEFAULT: 6.25,

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

  // BigQuery 因子回歸模型設定（選用進階功能，見 README「因子回歸模型」章節）。
  // Apps Script 專案本身沒有 GCP 專案的概念，要使用者自己在 Apps Script 編輯器把
  // 「Google Cloud Platform (GCP) 專案」換成自己的標準專案、啟用 BigQuery API + 綁定帳單，
  // 這裡填的 BIGQUERY_PROJECT_ID 就是那個標準專案的 Project ID（不是 Apps Script 的專案）。
  BIGQUERY_DATASET_DEFAULT: 'twse_factor_model',
  BIGQUERY_RAW_TABLE: 'history_raw',
  BIGQUERY_EXTERNAL_TABLE: 'history_external',
  BIGQUERY_DEDUPED_VIEW: 'history_deduped',
  BIGQUERY_AUTODETECT_EXTERNAL_TABLE: 'history_external_autodetect',
  BIGQUERY_MATERIALIZED_TABLE: 'history_materialized',
  BIGQUERY_MATERIALIZED_MAX_AGE_MINUTES: 360, // 超過這個時間沒重新整理過，讀取時會自動重新整理一次
  BIGQUERY_FEATURE_VIEW: 'factor_features',
  BIGQUERY_LOCATION: 'US', // BigQuery Dataset 所在地區，跟後面所有 query 的 location 要一致
  // 資料來源模式：
  //   'native'       -> 用「同步歷史資料到 BigQuery」把我們自己的月份 CSV 逐月載入 history_raw
  //                     （管理型資料表，查詢快），只服務「因子回歸模型」，核心功能（今日戰報/個股分析/
  //                     回測研究）維持讀 Drive 月份檔案。
  //   'external'     -> 完全不匯入。BigQuery 建一個指向 Drive 資料夾「所有」CSV 檔案的外部資料表
  //                     （history_external，位置對應 schema，欄位順序要跟系統一致），查詢時即時讀
  //                     Drive 檔案，沒有存副本，每次都要重新掃描，速度較慢。
  //   'materialized' -> 推薦：不用匯入、查詢快、且用「欄名」對應不怕欄位順序不同。做法是先建一個
  //                     autodetect 的外部資料表（欄名直接用 CSV 標題列文字，不是位置），
  //                     再用 SQL 依欄名把資料複製進一份 BigQuery 原生表（history_materialized），
  //                     Apps Script 全程不碰檔案內容（複製動作是 BigQuery 自己做的）。
  //                     這份原生表會依 BIGQUERY_MATERIALIZED_MAX_AGE_MINUTES 自動判斷要不要重新整理
  //                     （太舊才重新整理，不是每次查詢都重來，所以比 external 模式快很多），
  //                     每日排程跑完也會自動觸發一次重新整理，正常情況下完全不用手動按任何按鈕。
  BIGQUERY_SOURCE_MODE_DEFAULT: 'native',

  // 歷史資料 CSV 欄名（中文）-> BigQuery 欄名（ascii，BigQuery 對特殊符號欄名支援有限，
  // 統一轉成安全的英文欄名），順序必須跟 HISTORY_COLUMNS 完全一致（用陣列索引對應）。
  BQ_COLUMN_MAP: [
    { cn: '日期', bq: 'date_str' },
    { cn: '證券代號', bq: 'stock_id' },
    { cn: '證券名稱', bq: 'stock_name' },
    { cn: '外資', bq: 'foreign_net' },
    { cn: '投信', bq: 'trust_net' },
    { cn: '自營商', bq: 'dealer_net' },
    { cn: '三大法人買賣超股數', bq: 'inst_net_shares' },
    { cn: '成交股數', bq: 'volume_shares' },
    { cn: '成交筆數', bq: 'trade_count' },
    { cn: '成交金額', bq: 'turnover' },
    { cn: '開盤價', bq: 'open_price' },
    { cn: '最高價', bq: 'high_price' },
    { cn: '最低價', bq: 'low_price' },
    { cn: '收盤價', bq: 'close_price' },
    { cn: '漲跌(+/-)', bq: 'change_sign' },
    { cn: '漲跌價差', bq: 'change_amount' },
    { cn: '最後揭示買價', bq: 'bid_price' },
    { cn: '最後揭示買量', bq: 'bid_vol' },
    { cn: '最後揭示賣價', bq: 'ask_price' },
    { cn: '最後揭示賣量', bq: 'ask_vol' },
    { cn: '殖利率(%)', bq: 'dividend_yield' },
    { cn: '本益比', bq: 'pe_ratio' },
    { cn: '股價淨值比', bq: 'pb_ratio' },
    { cn: '財報年/季', bq: 'fin_report_period' }
  ],

  // 拿來做迴歸的候選因子欄位（都是 factor_features view 算出來的欄位名稱）。
  FACTOR_CANDIDATE_COLUMNS: [
    'inst_participation', 'inst_part_ma5', 'ibf_20d', 'trend_score', 'ma20_slope',
    'vol_ratio', 'bias60', 'dividend_yield', 'pe_ratio', 'pb_ratio'
  ],

  // BigQuery 因子回歸的候選欄位名稱 -> Analysis.gs computeFactors_ 算出來的同一個量（或原始 CSV 欄位）
  // 的欄位名稱。套用某一版因子模型後，Analysis.gs 用這個對照表把 BQML 權重乘回每天算好的因子值，
  // 算出「因子模型預測分數」跟 Armor_Score 並列顯示（不會取代 Armor_Score）。
  BQ_FEATURE_TO_ANALYSIS_FIELD: {
    inst_participation: 'Inst_Participation',
    inst_part_ma5: 'Inst_Part_MA5',
    ibf_20d: 'IBF_20D',
    trend_score: 'Trend_Score',
    ma20_slope: 'MA20_Slope',
    vol_ratio: 'Vol_Ratio',
    bias60: 'BIAS_60',
    dividend_yield: '殖利率(%)',
    pe_ratio: '本益比',
    pb_ratio: '股價淨值比'
  },

  // 兩個要預測的目標（label），對應「後續一個月的漲跌」跟「相對大盤的抗跌力」。
  FACTOR_LABELS: {
    RETURN_1M: { key: 'return1m', column: 'label_return_1m', name: '後續1個月報酬率' },
    DOWNSIDE_RESISTANCE: { key: 'downsideResistance', column: 'label_downside_resistance', name: '相對大盤抗跌力' }
  },

  FACTOR_MODEL_L1_REG_DEFAULT: 0.05,

  FACTOR_MODEL_COLUMNS: [
    '執行時間', '標的Label', 'L1正規化強度', '使用特徵', '訓練列數',
    'R2', '權重(JSON)', '狀態', '目前套用版本'
  ],

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
    '實相解讀', 'Trend_Score', 'Inst_Part_Rank', 'IBF_20D_Rank', '監控連結', '參考最高價',
    '因子模型_預測1月報酬', '因子模型_預測抗跌力'
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
    '操作策略', '建議動作', '實相解讀', '監控連結', '參考最高價',
    '因子模型_預測1月報酬', '因子模型_預測抗跌力'
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

/** 前端「歷史資料夾設定」：把每月歷史 CSV 的存放資料夾換成使用者指定的既有資料夾。 */
function setHistoryFolderId(folderId) {
  var id = String(folderId || '').trim();
  var folder;
  try {
    folder = DriveApp.getFolderById(id);
  } catch (e) {
    throw new Error('找不到這個資料夾（ID: ' + id + '），請確認資料夾 ID 正確，且這個 Google 帳號有權限存取。');
  }
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.ARCHIVE_FOLDER_ID, folder.getId());
  return getHistoryFolderInfo();
}

function getHistoryFolderInfo() {
  var folder = getArchiveFolder_();
  return { folderId: folder.getId(), folderUrl: folder.getUrl(), folderName: folder.getName() };
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
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.FACTOR_MODEL_HISTORY, CONFIG.FACTOR_MODEL_COLUMNS);
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.BIGQUERY_USAGE, CONFIG.BIGQUERY_USAGE_COLUMNS);

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
