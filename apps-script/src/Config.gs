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
    SCREENING_DIAGNOSTICS_CACHE: 'SCREENING_DIAGNOSTICS_CACHE', // {date, stats} JSON，避免 0 檔訊號時前端再重跑一次昂貴的歷史查詢
    BACKFILL_JOB_STATE: 'BACKFILL_JOB_STATE', // 「補抓/重新彙整區間」背景 job 的目前狀態（見 DataFetch.gs）
    ANALYSIS_JOB_STATE: 'ANALYSIS_JOB_STATE', // 「重新計算戰報」背景 job 的目前狀態（見 Analysis.gs）
    FACTOR_REGRESSION_JOB_STATE: 'FACTOR_REGRESSION_JOB_STATE', // 「執行因子迴歸」背景 job 的目前狀態（見 FactorRegression.gs）
    MATERIALIZE_JOB_STATE: 'MATERIALIZE_JOB_STATE', // 「立即重新整理」（materialized 模式）背景 job 的目前狀態（見 BigQuerySync.gs）
    BACKTEST_JOB_STATE: 'BACKTEST_JOB_STATE', // 「開始回測歷史戰報」背景 job 的目前狀態（見 Backtest.gs）
    AI_DIAGNOSIS_JOB_STATE: 'AI_DIAGNOSIS_JOB_STATE', // AI 診斷/續抱診斷/Top3 背景 job 的目前狀態（見 AiDiagnosis.gs）
    SCREENING_STRATEGY: 'SCREENING_STRATEGY', // 目前生效的「新進場訊號」篩選邏輯版本（見 Analysis.gs SCREENING_STRATEGIES）
    LAST_SCHEDULED_RUN: 'LAST_SCHEDULED_RUN', // 最近一次「每日自動排程」依序執行的每個步驟起訖時間/狀態（見 DataFetch.gs scheduledDailyFetch）
    INDUSTRY_MAP_LAST_REFRESH: 'INDUSTRY_MAP_LAST_REFRESH', // 產業對照表上次重新整理的結果摘要（見 IndustryMap.gs）
    INDUSTRY_MAP_JOB_STATE: 'INDUSTRY_MAP_JOB_STATE' // 「重新整理產業對照表」背景 job 的目前狀態（見 IndustryMap.gs）
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
    BIGQUERY_USAGE: 'BigQueryUsage',
    INDUSTRY_MAP: 'IndustryMap'
  },

  // 產業對照表（見 IndustryMap.gs）：股票代號 → 產業別的靜態參考資料，跟每天更新的 History
  // 是不同性質的東西，不接進每日排程，靠後台手動「重新整理產業對照表」觸發更新。
  // Phase 1 只負責把這份對照表抓下來、驗證品質、存起來，還沒有接進任何戰報因子計算。
  INDUSTRY_MAP_COLUMNS: ['證券代號', '證券名稱', '產業別', '市場別'],

  BIGQUERY_USAGE_COLUMNS: ['日期', '時間戳記', '類型', '掃描位元組數', '預估費用(USD)'],

  // BigQuery on-demand 查詢定價的參考單價（USD / TB 掃描量），這是概略預設值，不是即時公告的官方價格，
  // 一定會跟你實際帳單有落差，請自行到 https://cloud.google.com/bigquery/pricing 核對後在
  // 「資料總覽」頁籤修改。每月前 1TB 掃描量本身是免費的，這裡的估算沒有扣掉那個免費額度，
  // 所以正常使用量下，這裡算出來的「預估費用」通常會比實際帳單（$0）高，僅供參考掃描量趨勢用。
  BIGQUERY_PRICE_PER_TB_DEFAULT: 6.25,

  // 診斷類型：'深度診斷'（單檔，runAiDiagnosis）／'持股續抱診斷'（runPortfolioHoldDiagnosis）／
  // 'TOP3推薦'（runAiTopPicks，證券代號固定存 'TOP3'）。upsert 的比對鍵是 證券代號+日期+診斷類型
  // 三個一起比對，不會因為同一天對同一檔股票跑了不同類型的診斷互相覆蓋掉彼此。
  AI_DIAGNOSIS_COLUMNS: ['日期', '證券代號', '證券名稱', 'Armor_Score', '操作策略', '最終建議', '診斷類型', '診斷內容', '時間戳記'],

  AI_USAGE_COLUMNS: ['日期', '時間戳記', '供應商', '模型', '證券代號', '輸入Tokens', '輸出Tokens', '預估費用(USD)'],

  // Claude API 設定：模型可依需要換成 claude-opus-4-8 (更貴更強) 或 claude-haiku-4-5-20251001 (更便宜)
  CLAUDE_MODEL: 'claude-sonnet-5',
  CLAUDE_MAX_TOKENS: 3000,

  // Gemini API 設定（透過 Google AI Studio 申請的 key，走 Generative Language API）。
  // 模型名稱 Google 三不五時會更新/淘汰，如果呼叫失敗（HTTP 404）記得去
  // https://ai.google.dev/gemini-api/docs/models 查目前可用的模型名稱換掉。
  GEMINI_MODEL: 'gemini-2.5-flash',
  // gemini-2.5-flash 預設會用「思考」token，這些 token 跟最終答案共用同一個 maxOutputTokens
  // 額度——prompt 變長/變複雜（例如新增證交所官方財報資料後）会讓模型思考得更多，
  // 額度不夠時思考會把整個額度用完，最終答案是空的，回應會出現 finishReason: STOP
  // 但 content 沒有 parts（見 callGemini_ 的錯誤訊息）。3000 對這份診斷 prompt 的輸出格式
  // （財務表格＋三大流派辯證＋CoVE＋最終決策，本身就要上千字）太緊繃，提高到 8192 留夠空間。
  GEMINI_MAX_TOKENS: 8192,

  // 費用估算用的「參考單價」（USD / 每百萬 tokens）。這些是概略預設值，不是即時公告的官方價格，
  // 一定會跟你實際帳單有落差，請自行到官方頁面核對後在「後台管理」修改：
  // Claude: https://www.anthropic.com/pricing#api　Gemini: https://ai.google.dev/gemini-api/docs/pricing
  CLAUDE_PRICE_INPUT_PER_M_DEFAULT: 3,
  CLAUDE_PRICE_OUTPUT_PER_M_DEFAULT: 15,
  GEMINI_PRICE_INPUT_PER_M_DEFAULT: 0.3,
  GEMINI_PRICE_OUTPUT_PER_M_DEFAULT: 2.5,

  AI_DAILY_TOP_N_DEFAULT: 5,

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
  // 每天/補抓寫入的資料現在直接 append 進 history_raw（不再寫 Drive 月份檔案），
  // history_materialized 變成「一次性從舊的 Drive 大檔案整理進來的歷史基準」，很少再變動。
  // history_unified 把兩份表 UNION 起來（同一天同一檔股票撞到的話 history_raw 優先，
  // 因為它是比較新鮮的直接寫入），materialized 模式讀的是這個 view，不是單一份表。
  BIGQUERY_UNIFIED_VIEW: 'history_unified',
  BIGQUERY_FEATURE_VIEW: 'factor_features',
  // 產業對照表同步進 BigQuery 的小型參考表（見 IndustryMap.gs／BigQuerySync.gs），
  // 「重新整理產業對照表」成功後會盡量同步一份到這裡，只有設定了 BigQuery 才會同步，
  // 沒設定完全不影響 Phase 1/2 既有功能（Sheet 版本才是 Phase 1/2 唯一依賴的資料來源）。
  BIGQUERY_INDUSTRY_MAP_TABLE: 'industry_map',
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
  //
  // industry_flow_*（Phase 3，見 IndustryCapitalFlow.gs 的 Phase 2 唯讀驗證）刻意只加在
  // 這裡（進訓練），沒有加進下面的 BQ_FEATURE_TO_ANALYSIS_FIELD——這是有意的範圍界線：
  // 加進候選因子清單，就會被 BQML LASSO 一起訓練，「關鍵影響因子」卡片跟權重/R² 看得出
  // 這些因子有沒有預測力；但「即時預測分數」（今日戰報/回測用來排名的 PredictedResistance_Rank）
  // 還沒有接這些因子——要讓即時預測正確運作，today's/回測用的每一天資料都要用跟訓練時
  // 完全一致的「JOIN 產業對照表 + 依產業橫斷面加總」邏輯重算一次，這牽涉到另外兩支
  // SQL（buildLatestDayFactorsSql_／buildRangeFactorsSql_）都要同步更新且行為一致，
  // 沒辦法在這個環境實際連上 BigQuery 測試，貿然接上有一定機率讓現有戰報/回測功能
  // 因為改壞 SQL 而出錯。所以先只做「訓練＋觀察是否有效」這一步：這些因子如果被 LASSO
  // 選中且權重不是 0，computeWeightedFactorScore_ 會因為查不到 BQ_FEATURE_TO_ANALYSIS_FIELD
  // 對應欄位而直接跳過那一項（見該函式「理論上不會發生...保守跳過」的既有防呆邏輯），
  // 不會出錯、也不會讓預測分數變成 null——但也不會真的把這些因子的貢獻算進即時預測分數。
  // 等確認哪些因子在訓練結果裡真的有效，才值得投入去同步改那兩支 SQL（下一階段）。
  FACTOR_CANDIDATE_COLUMNS: [
    'inst_participation', 'inst_part_ma5', 'ibf_20d', 'trend_score', 'ma20_slope',
    'vol_ratio', 'bias60', 'dividend_yield', 'pe_ratio', 'pb_ratio'
  ],

  // 產業資金流向的候選因子矩陣：4 種法人類別（三大法人合計 + 外資/投信/自營商各自）
  // × 6 種移動平均窗口（1天=不平滑、5/10/15/30/60天），一次全部丟進訓練讓 LASSO 自己選
  // 哪個組合最有效——單日版本（1天窗口）實測權重太小、幾乎測不出對 R² 的貢獻，使用者要求
  // 同時試不同天數的移動平均，也要分拆不同法人來源分開試。每個組合都會產生一個名叫
  // industry_flow_<type>_<window>d 的候選因子欄位（見 buildFeatureViewSql_ 的產生邏輯），
  // 4*6=24 個，一起 push 進 FACTOR_CANDIDATE_COLUMNS。
  INDUSTRY_FLOW_INVESTOR_TYPES: [
    { key: 'all', label: '三大法人合計', column: 'inst_net' },
    { key: 'foreign', label: '外資', column: 'foreign_v' },
    { key: 'trust', label: '投信', column: 'trust_v' },
    { key: 'dealer', label: '自營商', column: 'dealer_v' }
  ],
  INDUSTRY_FLOW_WINDOWS: [1, 5, 10, 15, 30, 60],

  /** 產生單一「產業資金流向」候選因子欄位名稱，SQL 產生（FactorRegression.gs）跟這裡
   *  的候選因子清單都呼叫這個，兩邊命名保證一致，不會因為手動拼字漏掉或拼錯。 */
  industryFlowFactorName: function (typeKey, window) {
    return 'industry_flow_' + typeKey + '_' + window + 'd';
  },

  // 第二組「產業相對大盤買賣超強度」候選因子：算法跟上面的排名版不同（見
  // buildFeatureViewSql_ 說明），是「產業法人參與度 - 大盤法人參與度」，本身已經是
  // 正規化過的比率（不是原始股數），不會有 v1 那種量級差太多被 LASSO 壓到 0 的問題。
  // 為了避免候選因子數量爆炸（4*6=24 個排名版 + 4*6=24 個相對強度版 = 48，快逼近訓練資料
  // 欄位上限、也讓 LASSO 更難分辨誰有效），「三大法人合計」做完整 6 種天期，但外資/投信/
  // 自營商三個分法人版本只做 1 天（單日）跟 20 天（約一個月）兩個代表性天期，總共
  // 6 + 3*2 = 12 個，而不是完整展開的 24 個。
  INDUSTRY_REL_MARKET_TYPE_WINDOWS: [1, 20],

  /** 依法人類別決定「產業相對大盤強度」要算哪些天期窗口——'all'（三大法人合計）用完整
   *  6 種天期，其他分法人版本只用代表性的 1 天跟 20 天，見上面 INDUSTRY_REL_MARKET_TYPE_WINDOWS
   *  的說明。 */
  industryRelMarketWindowsForType: function (typeKey) {
    return typeKey === 'all' ? CONFIG.INDUSTRY_FLOW_WINDOWS : CONFIG.INDUSTRY_REL_MARKET_TYPE_WINDOWS;
  },

  /** 產生單一「產業相對大盤買賣超強度」候選因子欄位名稱，命名跟上面的 industryFlowFactorName
   *  故意用不同前綴（industry_rel_mkt_ vs industry_flow_），避免兩組因子互相搞混。 */
  industryRelMarketFactorName: function (typeKey, window) {
    return 'industry_rel_mkt_' + typeKey + '_' + window + 'd';
  },

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

  // 一列＝一筆買進紀錄（lot），不是一列一檔股票——同一檔股票可以有好幾筆買進紀錄（分批買進/
  // 加碼），「持股庫存」頁面會依證券代號聚合成加權平均成本/總股數。狀態='持有中' 或 '已賣出'，
  // 賣出時把同一檔股票所有「持有中」的紀錄一次標記成'已賣出'（見 Portfolio.gs closePortfolioPosition）。
  // 舊版（改版前）是一列一檔股票、沒有交易ID/股數/狀態欄位，第一次讀取時會自動轉換格式，
  // 見 Portfolio.gs migratePortfolioSheetIfNeeded_。
  PORTFOLIO_COLUMNS: ['交易ID', '證券代號', '證券名稱', '買進日期', '買進價格', '股數', '備註', '狀態', '賣出日期', '賣出價格'],

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

// 把「產業資金流向」4 種法人類別 × 6 種移動平均窗口的候選因子欄位名稱，全部 push 進候選
// 因子清單——集中寫在這裡（跟 CONFIG 物件本身分開），是因為要呼叫 CONFIG.industryFlowFactorName
// 這個剛剛定義好的函式，避免在物件字面量裡面互相引用自己還沒宣告完的屬性。
CONFIG.INDUSTRY_FLOW_INVESTOR_TYPES.forEach(function (t) {
  CONFIG.INDUSTRY_FLOW_WINDOWS.forEach(function (w) {
    CONFIG.FACTOR_CANDIDATE_COLUMNS.push(CONFIG.industryFlowFactorName(t.key, w));
  });
});

// 同樣道理，把「產業相對大盤買賣超強度」候選因子欄位名稱 push 進候選因子清單——'all' 用
// 完整 6 種天期，其他分法人版本只用代表性的 1 天跟 20 天（見 INDUSTRY_REL_MARKET_TYPE_WINDOWS
// 說明），總共 12 個。
CONFIG.INDUSTRY_FLOW_INVESTOR_TYPES.forEach(function (t) {
  CONFIG.industryRelMarketWindowsForType(t.key).forEach(function (w) {
    CONFIG.FACTOR_CANDIDATE_COLUMNS.push(CONFIG.industryRelMarketFactorName(t.key, w));
  });
});

/**
 * ============================================================================
 * 重要教訓（2026-08-03 資料「消失」事故根因記錄，請務必讀完再修改本檔案任何一個
 * 「取得（或建立）持久化資源」的函式——Spreadsheet、Root/Archive/Reports/Regression
 * 資料夾都算）：
 *
 * 症狀：使用者回報 History／Reports／Portfolio／AiDiagnosis／每日戰報全部憑空消失，
 * 畫面顯示「目前還沒有任何戰報」，但 Drive 裡明明有同一天匯出的戰報 xlsx 檔案；
 * 之後使用者自己在 Drive 裡發現多出一個全新資料夾，裡面是全新建立、內容是空的
 * Spreadsheet／Reports／Regression 資料夾——原本的資料並沒有真的被刪除，只是
 * App 悄悄換去讀寫別的地方。
 *
 * 根因：本檔案裡原本有多個「取得（或建立）持久化資源」的函式，邏輯都是「先嘗試用
 * Script Properties 存的 ID 開啟既有資源，開啟失敗（不管什麼原因：暫時性 API 錯誤、
 * 額度限制、Properties 意外被清空……）就默默 fallback 去新建一個空白資源、然後
 * 用新資源的 ID 覆蓋掉 Script Properties」。這種寫法在 Apps Script 環境下特別危險：
 *   1. UrlFetch/DriveApp/SpreadsheetApp 呼叫本來就偶爾會有暫時性失敗，機率不算低，
 *      而 openById 失敗「不代表資源真的不見了」，代表要處理錯誤，而不是造一個新的頂替。
 *   2. Script Properties 覆蓋是立即生效、沒有版本歷史、也沒有任何確認步驟，覆蓋掉的
 *      舊 ID 沒有內建救援機制——原本資料變成孤兒檔案，只能靠使用者自己去 Drive 大海撈針找。
 *   3. 從使用者角度看，這是「資料無聲消失」：沒有任何錯誤訊息，畫面只是安靜地變成空的，
 *      非常難察覺、更難回溯原因，往往要等使用者自己發現「數字對不起來」才會被回報。
 *
 * 規則（以後任何新增/修改「取得或建立持久化資源」的函式都必須遵守，沒有例外）：
 *   - 只有在「Script Properties 裡從來沒有存過這個 ID」時，才可以自動新建資源。
 *   - 只要 ID 已經存在、但用這個 ID 開啟資源失敗，一律要讓錯誤直接往外拋出，
 *     絕對不能默默 fallback 去新建或另外尋找一個資源來頂替、更不能自動覆蓋掉
 *     Script Properties 裡已經存的 ID。
 *   - 每一個持久化資源都要能在後台「儲存位置總覽」（見 getStorageDiagnostics()）
 *     看到目前狀態（正常／無法開啟＋錯誤訊息），並且要有手動覆蓋（貼網址/ID）的
 *     復原路徑——因為「靜默壞掉」比「馬上噴錯」危險太多倍，寧可讓使用者在後台
 *     看到刺眼的紅字，也不要讓資料在背後被默默棄置。
 * ============================================================================
 */

/**
 * 取得（或建立）主要 Spreadsheet，並確保它放在使用者指定的根資料夾裡（不是 Drive 根目錄）。
 *
 * 注意：只有在「從來沒有設定過 SPREADSHEET_ID」時才會自動新建一個空白資料庫。
 * 如果 SPREADSHEET_ID 已經有值、但 openById 失敗（例如暫時的 API 錯誤、權限問題），
 * 一律讓錯誤往外丟出，絕對不能默默建立新的空白 Spreadsheet 並覆蓋掉原本的 ID——
 * 這樣會讓既有的 History／Reports／Portfolio／AiDiagnosis 資料在使用者眼中「憑空消失」。
 */
function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(CONFIG.PROP_KEYS.SPREADSHEET_ID);
  if (id) {
    return SpreadsheetApp.openById(id);
  }
  var ss = SpreadsheetApp.create('TWSE 法人動能選股 App 資料庫');
  props.setProperty(CONFIG.PROP_KEYS.SPREADSHEET_ID, ss.getId());
  moveFileIntoFolder_(ss.getId(), getRootFolder_());
  return ss;
}

/**
 * 供後台「系統與資料後台」頁面顯示目前實際指向哪一個資料庫 Spreadsheet，
 * 並標示是否能正常開啟（讓使用者能及早發現「資料庫被切換成空白檔案」之類的問題）。
 */
function getSpreadsheetInfo() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(CONFIG.PROP_KEYS.SPREADSHEET_ID);
  if (!id) {
    return { configured: false, ok: false, id: '', name: '', url: '' };
  }
  try {
    var ss = SpreadsheetApp.openById(id);
    return {
      configured: true,
      ok: true,
      id: id,
      name: ss.getName(),
      url: ss.getUrl()
    };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      id: id,
      name: '',
      url: 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
      error: String(e.message || e)
    };
  }
}

/**
 * 讓使用者手動把資料庫指向另一個既有的 Spreadsheet（例如資料被誤切換成空白檔案後，
 * 找回原本的「TWSE 法人動能選股 App 資料庫」檔案並貼上網址／ID 復原）。
 * 會先嘗試開啟該 Spreadsheet 確認可以正常存取，才會真的覆蓋 SPREADSHEET_ID。
 */
function setSpreadsheetId(idOrUrl) {
  var input = String(idOrUrl || '').trim();
  if (!input) throw new Error('請輸入 Spreadsheet 網址或 ID。');
  var match = input.match(/\/spreadsheets\/d\/([-\w]{20,})/);
  var id = match ? match[1] : input;
  var ss = SpreadsheetApp.openById(id);
  var name = ss.getName();
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.SPREADSHEET_ID, id);
  return { id: id, name: name, url: ss.getUrl() };
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

/**
 * Reports / Regression 沒有各自的既有資料夾 ID，所以在根資料夾（使用者指定的那個）底下自動建立
 * 同名子資料夾。只有在「從來沒存過 ID」時才會用名稱找/建；ID 已經存在但開啟失敗就直接拋出錯誤，
 * 不會默默改成另外找或新建一個來頂替（理由見本檔案上方的事故根因記錄）。
 */
function getNamedSubfolder_(propKey, folderName) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(propKey);
  if (id) {
    return DriveApp.getFolderById(id);
  }
  var folder = getOrCreateFolder_(getRootFolder_(), folderName);
  props.setProperty(propKey, folder.getId());
  return folder;
}

/**
 * 讓使用者手動把「根資料夾」指向另一個既有的 Drive 資料夾（例如發現資料被靜默切換到
 * 別的資料夾後，找回原本使用的根資料夾並貼上網址／ID 復原）。換根資料夾之後，Reports／
 * Regression 這兩個「用名稱自動尋找/建立的子資料夾」快取的 ID 也一併清掉，強制下次
 * 存取時改成在新根資料夾底下重新用名稱尋找——這樣如果原本的 Reports/Regression 資料夾
 * 本來就在新根資料夾下面，會直接找到，不會又生出一份新的空資料夾。
 */
function setRootFolderId(idOrUrl) {
  var input = String(idOrUrl || '').trim();
  if (!input) throw new Error('請輸入資料夾網址或 ID。');
  var match = input.match(/\/folders\/([-\w]{10,})/);
  var id = match ? match[1] : input;
  var folder = DriveApp.getFolderById(id);
  var props = PropertiesService.getScriptProperties();
  props.setProperty(CONFIG.PROP_KEYS.ROOT_FOLDER_ID, folder.getId());
  props.deleteProperty(CONFIG.PROP_KEYS.REPORTS_FOLDER_ID);
  props.deleteProperty(CONFIG.PROP_KEYS.REGRESSION_FOLDER_ID);
  return { id: folder.getId(), name: folder.getName(), url: folder.getUrl() };
}

/**
 * 後台「儲存位置總覽」：一次列出全部 5 個持久化資源（Spreadsheet + 4 個 Drive 資料夾）目前
 * 實際指向哪裡、能不能正常開啟。每一項獨立 try/catch，一項失敗不影響其他項的顯示——這樣
 * 使用者才能一眼看出「到底是哪一個資源被靜默換掉了」，直接跟自己手上的 Drive 連結核對。
 */
function getStorageDiagnostics() {
  var checks = [
    { key: 'spreadsheet', label: '資料庫 Spreadsheet', fn: function () {
      var ss = getSpreadsheet_();
      return { name: ss.getName(), url: ss.getUrl() };
    } },
    { key: 'root', label: '根資料夾', fn: function () {
      var f = getRootFolder_();
      return { name: f.getName(), url: f.getUrl() };
    } },
    { key: 'archive', label: '歷史資料夾（History CSV）', fn: function () {
      var f = getArchiveFolder_();
      return { name: f.getName(), url: f.getUrl() };
    } },
    { key: 'reports', label: '每日戰報資料夾（Reports xlsx）', fn: function () {
      var f = getReportsFolder_();
      return { name: f.getName(), url: f.getUrl() };
    } },
    { key: 'regression', label: '回測／因子掃描資料夾（Regression）', fn: function () {
      var f = getRegressionFolder_();
      return { name: f.getName(), url: f.getUrl() };
    } }
  ];
  return checks.map(function (c) {
    try {
      var info = c.fn();
      return { key: c.key, label: c.label, ok: true, name: info.name, url: info.url };
    } catch (e) {
      return { key: c.key, label: c.label, ok: false, name: '', url: '', error: String(e.message || e) };
    }
  });
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
  ensureSheetWithHeaders_(ss, CONFIG.SHEET_NAMES.INDUSTRY_MAP, CONFIG.INDUSTRY_MAP_COLUMNS);

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
