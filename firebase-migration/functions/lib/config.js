/**
 * config.js
 * 戰報計算需要的設定常數，從 apps-script/src/Config.gs 複製過來（只複製
 * analysis.js / factorModel.js 用得到的那幾項，不是整份 CONFIG——Firebase
 * 版的設定架構是 Firestore 的 config/app 文件，不是整份照搬 Apps Script
 * 的 CONFIG 物件，這份只放「戰報計算邏輯本身需要的參數」）。
 *
 * 複製時機：2026-10-05，對照 apps-script/src/Config.gs 當時的內容。之後要
 * 調整策略參數（例如 LIQUIDITY_MIN 門檻），直接改這份，不用回頭改 Apps
 * Script 那份。
 */
var CONFIG = {
  // 策略參數（原本寫死在各 cell，後來集中管理）。
  STRATEGY: {
    LIQUIDITY_MIN: 40000000,
    TRAILING_STOP_PERCENT: 0.025
  },

  // Portfolio savePortfolioItem 新增買進紀錄時，股數欄位是空值的預設值（1 張），
  // 從 apps-script/src/Portfolio.gs 的 PORTFOLIO_DEFAULT_LOT_SHARES_ 複製。
  PORTFOLIO_DEFAULT_LOT_SHARES: 1000,

  // Analysis 每次只讀最近 N 天的歷史資料來算 rolling 指標
  // （MA60 需要 60 個交易日 + IBF20/Vol20 緩衝，120 天日曆天數綽綽有餘）。
  ANALYSIS_LOOKBACK_DAYS: 150,

  // 股票詳情頁（getStockDetail）的價格走勢圖要讀的天數，跟
  // apps-script/src/StockAnalysis.gs 的 getStockTimeSeries 預設值一致
  // （240 天日曆天數，MA60 需要 60 個交易日，其餘留給圖表本身的可視範圍）。
  STOCK_DETAIL_LOOKBACK_DAYS: 240,

  // 每日排程自動補抓股價資料時，單次 tick 最多補幾天的缺口——比 apps-script
  // 版 DataFetch.gs 的 MAX_CATCHUP_DAYS=5 大，因為那個 5 是 Apps Script 6
  // 分鐘硬性執行上限逼出來的保守值；Cloud Functions 的逾時是
  // generateDailyReportScheduled 自己宣告的（見 index.js），一天的抓取
  // （3 個 TWSE 端點 + 2 次 BigQuery 查詢）實測數秒等級，10 天的缺口遠遠
  // 不會撞到逾時。超過這個天數的缺口要用 Admin 頁面「手動補抓區間」
  // （exports.runHistoryBackfill，範圍不受這個常數限制）處理。
  HISTORY_FETCH_MAX_CATCHUP_DAYS: 10,

  // computeFactors_ 進來的 History 列，這些欄位要先轉成真正的 number。
  HISTORY_NUMERIC_COLUMNS: [
    '外資', '投信', '自營商', '三大法人買賣超股數',
    '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價',
    '漲跌價差', '最後揭示買價', '最後揭示買量', '最後揭示賣價', '最後揭示賣量',
    '殖利率(%)', '本益比', '股價淨值比'
  ],

  // AI 深度診斷呼叫 Claude／Gemini 用的模型名稱/token 上限，從
  // apps-script/src/Config.gs 複製（CONFIG.CLAUDE_MODEL 等）。
  CLAUDE_MODEL: 'claude-sonnet-5',
  CLAUDE_MAX_TOKENS: 3000,
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_MAX_TOKENS: 8192,

  // 給精簡戰報（Firestore reports/{date}/signals/{code}）用的欄位，對應
  // firestore/schema.md §3。
  REPORT_COLUMNS: [
    '日期', '證券代號', '證券名稱', 'Armor_Score', '操作策略', '建議動作',
    '實相解讀', 'Trend_Score', 'Inst_Part_Rank', 'IBF_20D_Rank', '監控連結', '參考最高價',
    '因子模型_預測1月報酬', '因子模型_預測抗跌力'
  ],

  // 完整欄位版本（對應原本 Colab v17.0 to_excel() 存出來的欄位），Firebase
  // 版如果還要保留「完整快照」這個功能，寫入 Cloud Storage 或另一個
  // collection 時用這份欄位順序。
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

  // factorModel.js 的 computeWeightedFactorScore_ 用：BigQuery 因子欄位名稱
  // → computeFactors_ 算出來的欄位名稱。
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
    pb_ratio: '股價淨值比',
    // 2026-10-08 新增：余博邏輯延伸的基本面因子接進即時預測分數，見
    // lib/analysis.js computeFactors_ 的 financialsIndex 參數——這 10 個
    // 欄位现在才有對應的 JS 計算邏輯，之前（config.js 下面
    // FUNDAMENTAL_CANDIDATE_COLUMNS 那段註解）刻意不加進這張表、讓
    // computeWeightedFactorScore_ 跳過，就是因為還沒有這段計算。
    fundamental_gross_margin_pct: 'Fundamental_Gross_Margin_Pct',
    fundamental_operating_margin_pct: 'Fundamental_Operating_Margin_Pct',
    fundamental_net_margin_pct: 'Fundamental_Net_Margin_Pct',
    fundamental_roe_pct: 'Fundamental_Roe_Pct',
    fundamental_gross_margin_streak: 'Fundamental_Gross_Margin_Streak',
    fundamental_operating_margin_streak: 'Fundamental_Operating_Margin_Streak',
    fundamental_net_margin_streak: 'Fundamental_Net_Margin_Streak',
    fundamental_roe_streak: 'Fundamental_Roe_Streak',
    fundamental_revenue_yoy_pct: 'Fundamental_Revenue_Yoy_Pct',
    fundamental_revenue_growth_streak: 'Fundamental_Revenue_Growth_Streak'
  },

  // ---- 2026-10-08 新增：FactorRegression.gs（因子迴歸模型）用的常數 ----
  // 10 個基礎候選因子＋2 個「動能時機」候選因子（股票自己的價量資料就能算，
  // 不需要產業對照表）——下面緊接著還會 push 進「產業資金流向」（24 個）／
  // 「產業相對大盤強度」（12 個）候選因子，合計 48 個，跟 apps-script 版
  // CONFIG.FACTOR_CANDIDATE_COLUMNS 的組成方式一致（見該檔案 Config.gs
  // 367~382 行：先定義基礎清單，再用 forEach+push 把動態產生的欄位名稱
  // 加進去，不是寫死整份清單——這裡沿用同一個「先宣告陣列，後面再 push」
  // 寫法，不是為了跟 apps-script 像而像，是因為 industryFlowFactorName／
  // industryRelMarketFactorName 這兩個函式要先定義好才能呼叫，物件字面量
  // 裡沒辦法一邊定義自己的方法一邊呼叫它們）。
  //
  // 'inst_accum_divergence_20d'／'days_since_new_low' 只加進這裡（訓練用候選
  // 因子），沒有加進上面的 BQ_FEATURE_TO_ANALYSIS_FIELD——跟 'industry_flow_*'
  // 同一個理由（見下面 FACTOR_CANDIDATE_COLUMNS 註解）：這兩個因子的算法
  // （橫斷面排名）不是 computeFactors_ 目前會算的量，要讓「今日戰報/回測」
  // 的即時預測分數用上這兩個因子，需要在 computeFactors_ 另外補上對應計算，
  // 這是獨立於「訓練」之外的下一步工作，不在這次範圍內。
  FACTOR_CANDIDATE_COLUMNS: [
    'inst_participation', 'inst_part_ma5', 'ibf_20d', 'trend_score', 'ma20_slope',
    'vol_ratio', 'bias60', 'dividend_yield', 'pe_ratio', 'pb_ratio',
    'inst_accum_divergence_20d', 'days_since_new_low'
  ],

  // 產業資金流向的候選因子矩陣：4 種法人類別 × 6 種移動平均窗口，跟
  // apps-script 版 FactorRegression.gs buildFeatureViewSql_ 開頭的完整
  // 說明一致（這裡不重複抄一次，見那支檔案）。
  INDUSTRY_FLOW_INVESTOR_TYPES: [
    { key: 'all', label: '三大法人合計', column: 'inst_net' },
    { key: 'foreign', label: '外資', column: 'foreign_v' },
    { key: 'trust', label: '投信', column: 'trust_v' },
    { key: 'dealer', label: '自營商', column: 'dealer_v' }
  ],
  INDUSTRY_FLOW_WINDOWS: [1, 5, 10, 15, 30, 60],

  industryFlowFactorName: function (typeKey, window) {
    return 'industry_flow_' + typeKey + '_' + window + 'd';
  },

  // 「產業相對大盤買賣超強度」候選因子：'all'（三大法人合計）用完整 6 種
  // 天期，其他分法人版本只用代表性的 1 天跟 20 天，避免候選因子數量從
  // 24 個再翻倍到 48 個。
  INDUSTRY_REL_MARKET_TYPE_WINDOWS: [1, 20],

  industryRelMarketWindowsForType: function (typeKey) {
    return typeKey === 'all' ? CONFIG.INDUSTRY_FLOW_WINDOWS : CONFIG.INDUSTRY_REL_MARKET_TYPE_WINDOWS;
  },

  industryRelMarketFactorName: function (typeKey, window) {
    return 'industry_rel_mkt_' + typeKey + '_' + window + 'd';
  },

  // 兩個要預測的目標（label）：後續一個月的報酬率、相對大盤的抗跌力。
  FACTOR_LABELS: {
    RETURN_1M: { key: 'return1m', column: 'label_return_1m', name: '後續1個月報酬率' },
    DOWNSIDE_RESISTANCE: { key: 'downsideResistance', column: 'label_downside_resistance', name: '相對大盤抗跌力' }
  },

  FACTOR_MODEL_L1_REG_DEFAULT: 0.05
};

// 把「產業資金流向」「產業相對大盤買賣超強度」候選因子欄位名稱 push 進候選
// 因子清單——集中寫在這裡（跟 CONFIG 物件字面量本身分開），因為要呼叫
// CONFIG.industryFlowFactorName 這個剛剛定義好的函式，見上面的說明。
// 合計 4*6=24 個（產業資金流向）+ 6+3*2=12 個（產業相對大盤強度），
// 跟 apps-script 版 Config.gs 完全對應。
CONFIG.INDUSTRY_FLOW_INVESTOR_TYPES.forEach(function (t) {
  CONFIG.INDUSTRY_FLOW_WINDOWS.forEach(function (w) {
    CONFIG.FACTOR_CANDIDATE_COLUMNS.push(CONFIG.industryFlowFactorName(t.key, w));
  });
});
CONFIG.INDUSTRY_FLOW_INVESTOR_TYPES.forEach(function (t) {
  CONFIG.industryRelMarketWindowsForType(t.key).forEach(function (w) {
    CONFIG.FACTOR_CANDIDATE_COLUMNS.push(CONFIG.industryRelMarketFactorName(t.key, w));
  });
});

// ---- 2026-10-08 新增：余適安（余博）法人選股邏輯延伸的基本面候選因子
// ----「四率四升」（毛利率／營益率／淨利率／ROE 連續上升）跟「月營收連續
// 成長」，apps-script 版沒有對應邏輯（全新因子，不是照搬），見
// `lib/financials.js`（解析＋計算）跟 `lib/bigquery.js
// buildFundamentalFeatureViewSql_`（點對點正確的 JOIN，疊在
// `factor_features` view 之上，不是直接改那支 view 本身）的完整說明。
//
// 2026-10-08 補充：這 10 個因子已經接進 `BQ_FEATURE_TO_ANALYSIS_FIELD`
// （見上方），`computeFactors_` 透過 `financialsIndex` 參數（
// `lib/financials.js buildAsOfIndex_`／`lookupAsOf_`，JS 版「公告日 <=
// 這一天」point-in-time 查詢，語意跟 BigQuery 那段 SQL 完全對應）算出
// 對應值，即時預測分數現在用得上這批因子了。還是跟產業資金流向因子
// （`industry_flow_*`／`industry_rel_mkt_*`，36 個）、
// `inst_accum_divergence_20d`／`days_since_new_low` 這 38 個因子不同
// 範圍界線——那批目前仍然沒有對應的 JS 計算邏輯，還是只能訓練用，不在
// 這次的範圍內。
CONFIG.FUNDAMENTAL_CANDIDATE_COLUMNS = [
  'fundamental_gross_margin_pct', 'fundamental_operating_margin_pct',
  'fundamental_net_margin_pct', 'fundamental_roe_pct',
  'fundamental_gross_margin_streak', 'fundamental_operating_margin_streak',
  'fundamental_net_margin_streak', 'fundamental_roe_streak',
  'fundamental_revenue_yoy_pct', 'fundamental_revenue_growth_streak'
];
CONFIG.FUNDAMENTAL_CANDIDATE_COLUMNS.forEach(function (c) { CONFIG.FACTOR_CANDIDATE_COLUMNS.push(c); });

/**
 * 2026-10-09 新增：使用者實測套用因子迴歸模型後，`factor_model_rank`／
 * `hybrid` 整個回測區間零訊號——追到根因是 `FACTOR_CANDIDATE_COLUMNS`
 * （訓練用候選因子，58 個）跟 `BQ_FEATURE_TO_ANALYSIS_FIELD`（即時計算
 * 真的支援、`computeWeightedFactorScore_` 不會跳過的因子，只有 20 個）
 * 範圍對不齊：另外 38 個（36 個產業資金流向/相對大盤強度因子＋
 * `inst_accum_divergence_20d`／`days_since_new_low`）訓練時 LASSO 可以
 * 自由選用、權重可能很大（這次使用者實測的「關鍵影響因子」裡大半都是
 * 這一批），但 `computeWeightedFactorScore_` 遇到沒對照表的因子一律直接
 * `continue`（跳過，不管權重多大）——等於模型真正學到的預測力大部分
 * 被即時計算端整個忽略，只剩少數剛好落在這 20 個裡的因子還有效，預測
 * 分數在全市場幾乎擠在一起，排名永遠衝不到 `factor_model_rank` 要求的
 * 前 10%。這不是今天財報因子那次的問題，是這兩個策略從加進 Firebase
 * 版以來，從沒真的被一個「權重大部分落在產業因子上」的模型完整驗證過。
 *
 * 短期修正（完整把 38 個因子接進 `computeFactors_` 工作量大，見 README
 * 的完整討論）：訓練時把候選因子限制在這 20 個「即時計算真的支援」的
 * 因子，直接用 `Object.keys(BQ_FEATURE_TO_ANALYSIS_FIELD)` 算出來——
 * 不另外手刻一份清單，兩邊永遠自動同步，之後 `BQ_FEATURE_TO_ANALYSIS_FIELD`
 * 加了新因子，這份清單自動跟著變，不會再發生「訓練用候選因子」跟
 * 「即時計算支援因子」兩份清單各自維護、逐漸對不齊的情況。訓練出來的
 * 模型會喪失產業資金流向這塊的預測力，但換來的是訓練出來的每一個因子
 * 的權重，回測/戰報都保證用得上，不會再有「訓練分數看起來不錯、套用
 * 後卻完全沒有訊號」的落差。
 */
CONFIG.LIVE_SCORED_FACTOR_CANDIDATE_COLUMNS = Object.keys(CONFIG.BQ_FEATURE_TO_ANALYSIS_FIELD);

module.exports = CONFIG;
