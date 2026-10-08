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
    pb_ratio: '股價淨值比'
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

module.exports = CONFIG;
