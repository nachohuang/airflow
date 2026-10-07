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
module.exports = {
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
  }
};
