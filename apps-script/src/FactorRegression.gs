/**
 * FactorRegression.gs
 * 「跟隨市場更新」的因子有效性迴歸：以 BigQuery 因子特徵 view 為基礎，
 * 用 BigQuery ML 的 LASSO 線性迴歸（linear_reg + l1_reg）找出目前最能預測
 *   1) 後續一個月報酬率（label_return_1m）
 *   2) 相對大盤的抗跌力（label_downside_resistance）
 * 的因子組合，每次執行結果都記一筆到 FactorModelHistory 分頁，方便追蹤因子有效性是否隨市場漂移，
 * 也可以手動把某一版標記為「目前套用版本」。
 *
 * 「相對大盤的抗跌力」定義（label_downside_resistance）：
 *   市場當日報酬 mkt_return(d) = 當天所有股票 daily_return 的橫斷面平均（等權重市場代理指標）。
 *   對每一檔股票、每一天 t，往後看 20 個交易日內「大盤下跌的那幾天」，
 *   算這檔股票在那些天的 (個股報酬 - 大盤報酬) 平均值 —— 數字越大，代表大盤跌的時候這檔股票
 *   跌得比大盤少（甚至逆勢上漲），也就是「相對大盤抗跌力越強」。只看大盤下跌的天數，
 *   而不是股票自己的絕對回檔幅度，才是使用者要的「相對」定義。
 */

// ---- 純函式：SQL 組字串 + 結果整理（不呼叫 BigQuery，可在 Node.js 測試）----

/**
 * 因子特徵 + 兩個預測目標的 BigQuery view SQL。
 *
 * industryMapTableRef：Phase 3 新增，IndustryMap.gs 同步過去的「股票代號→產業別」小型參考表
 * （見 BigQuerySync.gs syncIndustryMapToBigQuery_）。LEFT JOIN 進來只用來算「產業資金流向」
 * 這一組候選因子——查不到產業別（例如 ETF、上櫃股票，見 IndustryMap.gs 說明）的股票這些
 * 因子就是中性值 0.5（見下方說明），不影響其他因子照常計算。
 *
 * 產業資金流向因子矩陣（v3）：CONFIG.INDUSTRY_FLOW_INVESTOR_TYPES（三大法人合計／外資／
 * 投信／自營商）× CONFIG.INDUSTRY_FLOW_WINDOWS（1/5/10/15/30/60 天移動平均）＝24 個候選
 * 因子，欄位名稱由 CONFIG.industryFlowFactorName(typeKey, window) 產生，格式
 * industry_flow_<type>_<window>d。加開這麼多組合是因為：
 *   - v1（單日、只看三大法人合計）實測權重被壓到剛好 0——原始股數量級（±2000萬）跟其他
 *     候選因子（0~1 排名/比率）差太多，L1 正規化天生更容易把大量級因子的係數壓到 0。
 *   - v2 換成排名版本後權重變成非零，但單日訊號雜訊大、對 R² 的貢獻小到測不太出來，
 *     所以這裡一次把多種移動平均窗口都算出來，讓 LASSO 自己挑哪個平滑程度最有效。
 *   - 使用者也要求把「三大法人合計」拆開，分別看外資／投信／自營商各自的同業訊號，
 *     不同法人買賣行為的意義本來就不一樣（外資偏長線、自營商偏短線），合計可能互相抵銷。
 *
 * 每一個因子的算法都一樣（只差來源欄位跟平滑窗口）：
 *   1. 「同產業其他股票（排除自己）當天該類法人買賣超的平均值」（industry_flow_raw_<type>）——
 *      不是單純把同產業全部股票加總，加總會把這檔股票自己的買賣超算進自己的因子值裡，
 *      變成自己預測自己的循環相關，訓練出來的權重會失真。
 *   2. 對這個原始值取 N 天移動平均（industry_flow_ma_<type>_<N>d，N=1 就是原始值本身）。
 *   3. 換算成「當天全市場的橫斷面排名百分位」（0~1，PERCENT_RANK），跟其他候選因子在
 *      同一個量級上，才能被 LASSO 公平比較。原始值是 NULL（查不到產業別）的列一律給
 *      中性值 0.5，不能留 NULL——buildTrainModelSql_ 要求所有候選因子都 NOT NULL 才會
 *      拿去訓練，NULL 會讓整列被排除在訓練資料外（實測真的發生過 industry_map 是空的
 *      時候，訓練查詢因此回傳 0 列直接失敗）。PERCENT_RANK 本身不會把 NULL 排序鍵留成
 *      NULL 輸出（BigQuery 對 NULL 一樣會給一個排名位置），一定要用 CASE 明確覆寫成
 *      0.5，不能只靠事後 COALESCE（COALESCE 對這裡不會生效，因為 PERCENT_RANK 的
 *      回傳值本來就不是 NULL）。24 個因子共用同一批 NULL 列（都是「查不到產業別」
 *      造成的，不分法人類別/窗口），對排名分母的影響是均勻、一致的極小比例（目前
 *      實測涵蓋率 99%+），不會讓 24 個因子之間的相對比較失真。
 *
 * 「產業相對大盤買賣超強度」候選因子（industry_rel_mkt_<type>_<window>d，見
 * CONFIG.industryRelMarketFactorName）：跟上面的排名版是不同角度的訊號——排名版回答
 * 「這支股票的產業，比其他股票的產業熱門/冷門」（橫斷面排名），這組回答「這個產業的資金，
 * 有沒有比大盤整體更積極地被買/賣」（產業 vs. 大盤的直接對比，帶正負號）。算法：
 *   1. 「同產業其他股票（排除自己）的法人參與度」= SUM(該類法人買賣超, 排除自己) /
 *      SUM(成交量, 排除自己)，跟現有的 inst_participation 是同一種算法，只是從個股層級
 *      換成產業層級。
 *   2. 「全市場其他股票（排除自己）的法人參與度」，算法一樣，分組換成全市場。
 *   3. industry_rel_mkt_raw_<type> = 產業參與度 - 大盤參與度，正值代表這個產業被買的力道
 *      比大盤平均積極，負值代表相對冷淡/被賣超。排除自己是延續上面同一個理由（避免自己
 *      預測自己的循環相關），市場層級樣本數很大、排不排除自己影響很小，但為了跟產業層級
 *      一致還是排除。
 *   4. 這個原始值本身就是「參與度」的差，量級跟其他 0~1 比率因子（如 inst_participation）
 *      接近，理論上不需要再轉排名也能避開 v1 的 LASSO 零權重問題，但為了跟現有 24 個因子
 *      的處理方式一致（也再保險一次量級問題），一樣先做 N 天移動平均，再轉成 0~1 橫斷面
 *      排名，NULL（查不到產業別）一樣給中性值 0.5。
 *   5. 候選數量控制：為了不讓因子數量從 24 個再翻倍到 48 個（LASSO 要挑的候選變太多、
 *      訓練也更慢），「三大法人合計」做完整 6 種天期，但外資/投信/自營商三個分法人版本
 *      只做 1 天跟 20 天兩個代表性天期，總共 6+3*2=12 個（見
 *      CONFIG.industryRelMarketWindowsForType）。
 *
 * 「動能時機」候選因子（inst_accum_divergence_20d、days_since_new_low）：使用者提出的
 * 問題是「現有的趨勢類因子（Trend_Score、BIAS_60）都是已經漲一段之後才會亮燈，能不能
 * 抓更早期的訊號」，這兩個因子分別對應兩個方向：
 *   - inst_accum_divergence_20d（法人安靜吃貨）：把「20天法人買超強度」（inst_net_sum_20d，
 *     排除自己股票沒有意義，這裡就是自己這檔股票的原始買賣超加總）跟「20天股價漲跌幅」
 *     （price_change_20d）都轉成當天全市場的橫斷面排名，兩者相減。正值越大代表「買超排名
 *     遠高於漲幅排名」——法人買得兇但股價還沒什麼反應，是在確認的趨勢因子還沒亮燈前就可能
 *     出現的訊號；負值代表股價漲幅超前買盤，可能是追價。
 *   - days_since_new_low（距離上次創新低的天數）：抓「止跌」而不是「已經上漲」，比均線
 *     黃金交叉（Trend_Score 的判定方式）更早——不用等均線翻揚，只要股價不再破 20 天新低，
 *     這個數字就會持續變大。算法：先標記每一天是不是「20天新低」（收盤價等於近 20 天
 *     的最低點），再用 MAX(CASE WHEN ... THEN dt END) OVER (... ROWS BETWEEN UNBOUNDED
 *     PRECEDING AND CURRENT ROW) 這個「找最近一次事件發生日期」的標準寫法，算出「最近一次
 *     創新低是哪一天」，兩個日期相減就是天數。原始天數量級跟其他 0~1 因子差太多（有 v1
 *     industry_capital_flow 被 LASSO 壓到 0 的前車之鑒），一樣轉成橫斷面排名。
 * 兩個都是股票自己的價量資料就能算，不需要外部資料源，NULL（資料不足 20 天，例如上市
 * 未滿一個月）一樣給中性值 0.5（inst_accum_divergence_20d 因為是兩個排名相減，中性值是
 * 0.5-0.5=0，不是 0.5，COALESCE 對應調整）。
 */
function buildFeatureViewSql_(rawTableRef, industryMapTableRef, viewRef) {
  var types = CONFIG.INDUSTRY_FLOW_INVESTOR_TYPES;
  var windows = CONFIG.INDUSTRY_FLOW_WINDOWS;

  var industrySumLines = types.map(function (t) {
    return '    SUM(' + t.column + ') OVER (PARTITION BY industry, dt) AS industry_' + t.key + '_sum';
  });

  var rawFlowLines = types.map(function (t) {
    return '    CASE WHEN industry IS NOT NULL AND industry_stock_count > 1' +
      ' THEN SAFE_DIVIDE(industry_' + t.key + '_sum - ' + t.column + ', industry_stock_count - 1) END' +
      ' AS industry_flow_raw_' + t.key;
  });

  var maLines = [];
  types.forEach(function (t) {
    windows.forEach(function (w) {
      var maName = 'industry_flow_ma_' + t.key + '_' + w + 'd';
      if (w === 1) {
        maLines.push('    industry_flow_raw_' + t.key + ' AS ' + maName);
      } else {
        maLines.push('    AVG(industry_flow_raw_' + t.key + ') OVER (PARTITION BY stock_id ORDER BY dt' +
          ' ROWS BETWEEN ' + (w - 1) + ' PRECEDING AND CURRENT ROW) AS ' + maName);
      }
    });
  });

  var rankLines = [];
  types.forEach(function (t) {
    windows.forEach(function (w) {
      var maName = 'industry_flow_ma_' + t.key + '_' + w + 'd';
      var outName = CONFIG.industryFlowFactorName(t.key, w);
      rankLines.push('    CASE WHEN ' + maName + ' IS NULL THEN 0.5' +
        ' ELSE PERCENT_RANK() OVER (PARTITION BY dt ORDER BY ' + maName + ') END AS ' + outName);
    });
  });

  var finalFlowLines = [];
  types.forEach(function (t) {
    windows.forEach(function (w) {
      var name = CONFIG.industryFlowFactorName(t.key, w);
      finalFlowLines.push('  COALESCE(' + name + ', 0.5) AS ' + name);
    });
  });

  // ---- 「產業相對大盤買賣超強度」候選因子（見上方說明）----
  var mktSumLines = types.map(function (t) {
    return '    SUM(' + t.column + ') OVER (PARTITION BY dt) AS mkt_' + t.key + '_sum';
  });

  var relRawLines = types.map(function (t) {
    return '    CASE WHEN industry IS NOT NULL AND industry_stock_count > 1 AND (mkt_vol_sum - vol) != 0' +
      ' THEN SAFE_DIVIDE(industry_' + t.key + '_sum - ' + t.column + ', industry_vol_sum - vol)' +
      ' - SAFE_DIVIDE(mkt_' + t.key + '_sum - ' + t.column + ', mkt_vol_sum - vol) END' +
      ' AS industry_rel_mkt_raw_' + t.key;
  });

  var relMaLines = [];
  var relRankLines = [];
  var relFinalLines = [];
  types.forEach(function (t) {
    CONFIG.industryRelMarketWindowsForType(t.key).forEach(function (w) {
      var maName = 'industry_rel_mkt_ma_' + t.key + '_' + w + 'd';
      if (w === 1) {
        relMaLines.push('    industry_rel_mkt_raw_' + t.key + ' AS ' + maName);
      } else {
        relMaLines.push('    AVG(industry_rel_mkt_raw_' + t.key + ') OVER (PARTITION BY stock_id ORDER BY dt' +
          ' ROWS BETWEEN ' + (w - 1) + ' PRECEDING AND CURRENT ROW) AS ' + maName);
      }
      var outName = CONFIG.industryRelMarketFactorName(t.key, w);
      relRankLines.push('    CASE WHEN ' + maName + ' IS NULL THEN 0.5' +
        ' ELSE PERCENT_RANK() OVER (PARTITION BY dt ORDER BY ' + maName + ') END AS ' + outName);
      relFinalLines.push('  COALESCE(' + outName + ', 0.5) AS ' + outName);
    });
  });

  return [
    'CREATE OR REPLACE VIEW `' + viewRef + '` AS',
    'WITH base AS (',
    '  SELECT',
    '    h.stock_id, h.stock_name,',
    '    SAFE_CAST(h.date_str AS DATE) AS dt,',
    '    SAFE_CAST(h.close_price AS FLOAT64) AS close,',
    '    SAFE_CAST(h.volume_shares AS FLOAT64) AS vol,',
    '    SAFE_CAST(h.foreign_net AS FLOAT64) AS foreign_v,',
    '    SAFE_CAST(h.trust_net AS FLOAT64) AS trust_v,',
    '    SAFE_CAST(h.dealer_net AS FLOAT64) AS dealer_v,',
    '    SAFE_CAST(h.dividend_yield AS FLOAT64) AS dividend_yield_f,',
    '    SAFE_CAST(h.pe_ratio AS FLOAT64) AS pe_ratio_f,',
    '    SAFE_CAST(h.pb_ratio AS FLOAT64) AS pb_ratio_f,',
    '    im.industry AS industry',
    '  FROM `' + rawTableRef + '` h',
    '  LEFT JOIN `' + industryMapTableRef + '` im ON h.stock_id = im.stock_id',
    '  WHERE LENGTH(h.stock_id) = 4',
    '),',
    'step1 AS (',
    '  SELECT *,',
    '    (foreign_v + trust_v + dealer_v) AS inst_net,',
    '    SAFE_DIVIDE(ABS(foreign_v) + ABS(trust_v) + ABS(dealer_v), vol) AS inst_participation,',
    '    SAFE_DIVIDE(close, LAG(close) OVER (PARTITION BY stock_id ORDER BY dt)) - 1 AS daily_return,',
    '    AVG(close) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,',
    '    AVG(close) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS ma60,',
    '    AVG(vol) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,',
    '    MIN(close) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS low20d,',
    '    SAFE_DIVIDE(close, LAG(close, 20) OVER (PARTITION BY stock_id ORDER BY dt)) - 1 AS price_change_20d',
    '  FROM base',
    '),',
    'step2 AS (',
    '  SELECT *,',
    '    AVG(inst_participation) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) AS inst_part_ma5,',
    '    CASE WHEN daily_return < 0 THEN 1 ELSE 0 END AS is_drop,',
    '    CASE WHEN daily_return < 0 AND inst_net > 0 THEN 1 ELSE 0 END AS is_inst_buy_on_drop,',
    '    SAFE_DIVIDE(vol, vol_ma20) AS vol_ratio,',
    '    SAFE_DIVIDE(close - ma60, ma60) AS bias60,',
    '    LAG(ma20, 3) OVER (PARTITION BY stock_id ORDER BY dt) AS ma20_3ago,',
    '    (close = low20d) AS is_new_low,',
    '    SUM(inst_net) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS inst_net_sum_20d,',
    industrySumLines.join(',\n') + ',',
    '    COUNT(*) OVER (PARTITION BY industry, dt) AS industry_stock_count,',
    '    SUM(vol) OVER (PARTITION BY industry, dt) AS industry_vol_sum,',
    mktSumLines.join(',\n') + ',',
    '    SUM(vol) OVER (PARTITION BY dt) AS mkt_vol_sum',
    '  FROM step1',
    '),',
    'step3 AS (',
    '  SELECT *,',
    '    (ma20 - ma20_3ago) AS ma20_slope,',
    '    SUM(is_drop) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS drop_count_20,',
    '    SUM(is_inst_buy_on_drop) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS buy_on_drop_20,',
    '    MAX(CASE WHEN is_new_low THEN dt END) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS last_new_low_date,',
    rawFlowLines.join(',\n') + ',',
    relRawLines.join(',\n'),
    '  FROM step2',
    '),',
    'step3ma AS (',
    '  SELECT *,',
    '    DATE_DIFF(dt, last_new_low_date, DAY) AS days_since_new_low_raw,',
    maLines.concat(relMaLines).join(',\n'),
    '  FROM step3',
    '),',
    'step3rank AS (',
    '  SELECT *,',
    '    CASE WHEN inst_net_sum_20d IS NULL THEN 0.5 ELSE PERCENT_RANK() OVER (PARTITION BY dt ORDER BY inst_net_sum_20d) END AS inst_rank_20d,',
    '    CASE WHEN price_change_20d IS NULL THEN 0.5 ELSE PERCENT_RANK() OVER (PARTITION BY dt ORDER BY price_change_20d) END AS price_rank_20d,',
    '    CASE WHEN days_since_new_low_raw IS NULL THEN 0.5 ELSE PERCENT_RANK() OVER (PARTITION BY dt ORDER BY days_since_new_low_raw) END AS days_since_new_low,',
    rankLines.concat(relRankLines).join(',\n'),
    '  FROM step3ma',
    '),',
    'step4 AS (',
    '  SELECT *,',
    '    CASE WHEN drop_count_20 IS NULL OR drop_count_20 = 0 THEN 0 ELSE buy_on_drop_20 / drop_count_20 END AS ibf_20d,',
    '    (CASE WHEN ma20 IS NOT NULL AND close > ma20 THEN 1 ELSE 0 END',
    '      + CASE WHEN ma20_slope IS NOT NULL AND ma20_slope > 0 THEN 1 ELSE 0 END) AS trend_score,',
    '    (inst_rank_20d - price_rank_20d) AS inst_accum_divergence_20d',
    '  FROM step3rank',
    '),',
    'market AS (',
    '  SELECT dt, AVG(daily_return) AS mkt_return',
    '  FROM step4',
    '  WHERE daily_return IS NOT NULL',
    '  GROUP BY dt',
    '),',
    'joined AS (',
    '  SELECT step4.*, market.mkt_return',
    '  FROM step4 LEFT JOIN market USING (dt)',
    '),',
    'labeled AS (',
    '  SELECT *,',
    '    (SAFE_DIVIDE(LEAD(close, 20) OVER (PARTITION BY stock_id ORDER BY dt), close) - 1) AS label_return_1m,',
    '    AVG(CASE WHEN mkt_return < 0 THEN daily_return - mkt_return END)',
    '      OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING) AS label_downside_resistance',
    '  FROM joined',
    ')',
    'SELECT',
    '  stock_id, stock_name, dt AS date,',
    '  inst_participation, inst_part_ma5, ibf_20d, trend_score, ma20_slope, vol_ratio, bias60,',
    '  dividend_yield_f AS dividend_yield, pe_ratio_f AS pe_ratio, pb_ratio_f AS pb_ratio,',
    finalFlowLines.join(',\n') + ',',
    relFinalLines.join(',\n') + ',',
    '  COALESCE(inst_accum_divergence_20d, 0) AS inst_accum_divergence_20d,',
    '  COALESCE(days_since_new_low, 0.5) AS days_since_new_low,',
    '  label_return_1m, label_downside_resistance',
    'FROM labeled'
  ].join('\n');
}

/** BQML 訓練用的 model 名稱（同一個 label 每次重訓都是 CREATE OR REPLACE，同名覆蓋）。 */
function factorModelName_(labelKey) {
  return 'factor_model_' + labelKey;
}

/**
 * 診斷用：查 factor_features view 裡指定產業資金流向因子（v3 之後有 24 種組合，見
 * buildFeatureViewSql_ 的說明）的資料分佈——因為 LASSO 對「真的沒有預測力」跟「這欄根本
 * 是常數」這兩種情況，訓練出來的權重看起來會一樣（都很可能是精確的 0，LASSO 本來就是
 * 設計成會把沒用的因子壓到剛好 0），單看權重數字沒辦法分辨到底是「這個因子真的沒用」
 * 還是「這個因子根本沒有真實資料」。
 *
 * columnName 一定要是 CONFIG.FACTOR_CANDIDATE_COLUMNS 裡的合法欄位名稱（呼叫端
 * getIndustryCapitalFlowFactorStats() 會先驗證），這裡直接字串插進 SQL，不能接受
 * 任意輸入。
 *
 * 0.5 是「沒有資料的中性值」（見 buildFeatureViewSql_ 的說明），不是 0——所以這裡算的是
 * 「跟 0.5 剛好相等」的筆數，配合標準差一起看：標準差接近 0（理論上真實排名分佈的標準差
 * 應該落在 0.28~0.29 附近，接近均勻分布）或幾乎所有列都卡在 0.5，代表資料本身有問題，
 * 不是這個因子真的沒有預測力。
 */
function buildIndustryCapitalFlowStatsSql_(viewRef, columnName) {
  return [
    'SELECT',
    '  COUNT(*) AS total_rows,',
    '  COUNTIF(' + columnName + ' IS NOT NULL) AS non_null_count,',
    '  COUNTIF(' + columnName + ' != 0.5) AS non_neutral_count,',
    '  MIN(' + columnName + ') AS min_v,',
    '  MAX(' + columnName + ') AS max_v,',
    '  AVG(' + columnName + ') AS avg_v,',
    '  STDDEV(' + columnName + ') AS stddev_v',
    'FROM `' + viewRef + '`'
  ].join('\n');
}

/**
 * 實測發現：候選因子從 24 個擴充到 46 個之後，把 l1_reg 從 0.05 加倍到 0.1，幾乎所有權重
 * 都沒什麼變化（差異在小數點第4~5位以後）——不是 L1 強度不夠，是訓練根本沒有跑到收斂。
 * BigQuery ML 的預設是梯度下降法配「提前停止」（一次迭代的損失改善低於 1% 就收斂，最多
 * 只跑 20 輪），候選因子多、彼此又高度相關時，每一步梯度下降能帶來的損失改善天生就很小，
 * 很容易在 L1 懲罰真正累積起作用之前就提前收斂，係數看起來還很接近沒做正規化的樣子。
 * 所以這裡明確加上：
 *   - optimize_strategy='BATCH_GRADIENT_DESCENT'：l1_reg 沒有封閉解，一定要用梯度下降法
 *     才有意義（NORMAL_EQUATION 無法處理 L1 懲罰項），不留給 AUTO_STRATEGY 自動判斷。
 *   - learn_rate_strategy='LINE_SEARCH'：自動找每一步最適合的學習率，比固定學習率更容易
 *     穩定收斂。
 *   - max_iterations 拉高、min_rel_progress 門檻調嚴：讓訓練真的跑到收斂，L1 懲罰才有機會
 *     確實把不重要的因子壓到 0，而不是被提前停止打斷。BQML 對單次訓練的 max_iterations
 *     有硬性上限「必須小於 50」（實測撞過這個限制，錯誤訊息明確要求改用 warm_start 才能
 *     跑更多輪），所以這裡只能設到 49，不能像原本想的設 100。
 */
function buildTrainModelSql_(modelRef, viewRef, labelColumn, featureColumns, l1Reg) {
  var selectCols = featureColumns.concat([labelColumn]).join(', ');
  var notNullConds = featureColumns.concat([labelColumn]).map(function (c) { return c + ' IS NOT NULL'; }).join(' AND ');
  return [
    'CREATE OR REPLACE MODEL `' + modelRef + '`',
    'OPTIONS(',
    "  model_type='linear_reg',",
    "  optimize_strategy='BATCH_GRADIENT_DESCENT',",
    "  learn_rate_strategy='LINE_SEARCH',",
    '  l1_reg=' + l1Reg + ',',
    '  max_iterations=49,',
    '  min_rel_progress=0.0001,',
    "  input_label_cols=['" + labelColumn + "'],",
    "  data_split_method='RANDOM',",
    '  data_split_eval_fraction=0.2',
    ') AS',
    'SELECT ' + selectCols,
    'FROM `' + viewRef + '`',
    'WHERE ' + notNullConds
  ].join('\n');
}

function buildEvaluateSql_(modelRef) {
  return 'SELECT * FROM ML.EVALUATE(MODEL `' + modelRef + '`)';
}

function buildWeightsSql_(modelRef) {
  return "SELECT * FROM ML.WEIGHTS(MODEL `" + modelRef + "`) WHERE processed_input != '__INTERCEPT__' ORDER BY ABS(weight) DESC";
}

/** 把 ML.WEIGHTS 回傳的列整理成 {feature: weight} 物件（依權重絕對值排序）。 */
function summarizeWeights_(weightRows) {
  var out = {};
  weightRows.forEach(function (r) {
    out[r.processed_input] = parseFloat(r.weight);
  });
  return out;
}

/** 依權重絕對值排序，取前 count 個因子欄位名稱（給「目前生效模型」卡片列出「關鍵影響因子」
 *  用，權重絕對值愈大代表這個因子對預測結果的影響愈大，不分正負向）。抽成獨立的純函式，
 *  不用真的接 BigQuery/Sheets 就能測試。 */
function topWeightedFeatures_(weights, count) {
  if (!weights) return [];
  return Object.keys(weights).sort(function (a, b) {
    return Math.abs(weights[b]) - Math.abs(weights[a]);
  }).slice(0, count || 5);
}

/**
 * 用套用中的一組 BQML 權重，對 Analysis.gs 已經算好因子的一列資料算出 Σ(權重 × 因子值)。
 * row 是 computeFactors_ 算完後的列（Inst_Participation / IBF_20D / ... 都已經在上面）。
 * 只要缺任何一項權重對應的因子值，就回傳 null（不給可能誤導的部分預測值），
 * 例如剛上市不滿 60 天的股票 BIAS_60 還是 null，或某天法人資料缺漏。
 */
function computeWeightedFactorScore_(row, weights) {
  if (!weights) return null;
  var sum = 0;
  var keys = Object.keys(weights);
  for (var i = 0; i < keys.length; i++) {
    var bqName = keys[i];
    var analysisField = CONFIG.BQ_FEATURE_TO_ANALYSIS_FIELD[bqName];
    if (!analysisField) continue; // 理論上不會發生（權重欄位都來自候選因子清單），保守跳過
    var v = row[analysisField];
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return null;
    sum += weights[bqName] * v;
  }
  return sum;
}

/**
 * 對一列資料算出兩個目標各自的「因子模型預測分數」（用目前套用中的權重，沒有套用中的版本就是 null）。
 * appliedModels 是 getAppliedFactorModels() 的回傳值：{return1m: {weights,...}, downsideResistance: {weights,...}}。
 */
function computePredictedFactorScores_(row, appliedModels) {
  var applied = appliedModels || {};
  return {
    predictedReturn1M: applied.return1m ? computeWeightedFactorScore_(row, applied.return1m.weights) : null,
    predictedDownsideResistance: applied.downsideResistance ? computeWeightedFactorScore_(row, applied.downsideResistance.weights) : null
  };
}

// ---- Apps Script 專屬：實際呼叫 BigQuery + 寫入 FactorModelHistory 分頁 ----

function ensureFeatureView_(settings) {
  if (settings.sourceMode === 'external' || settings.sourceMode === 'materialized') {
    refreshDataSourceForMode_(settings);
  }
  // 就算使用者從來沒按過「重新整理產業對照表」，industry_map 表也要先確保存在（可以是空的）——
  // 不然 buildFeatureViewSql_ 的 LEFT JOIN 對到不存在的表會直接讓整個訓練失敗，而不是優雅地
  // 讓 industry_capital_flow 全部是 0（其他因子照常訓練）。
  ensureIndustryMapTable_(settings);
  // 自動檢核：確保 industry_map 表裡真的有資料，不用使用者自己記得要先手動重新整理過
  // 一次才能讓 industry_capital_flow 這個因子有意義（見 IndustryMap.gs 的說明跟這個問題
  // 實際發生過一次的經過）。
  ensureIndustryMapSyncedToBigQuery_();
  runBqQuery_(buildFeatureViewSql_(bqActiveSourceTableRef_(settings), bqIndustryMapTableRef_(settings), bqFeatureViewRef_(settings)), 'feature_view');
}

function trainFactorModel_(settings, labelDef, l1Reg) {
  var modelRef = settings.projectId + '.' + settings.dataset + '.' + factorModelName_(labelDef.key);
  var viewRef = bqFeatureViewRef_(settings);

  runBqQuery_(buildTrainModelSql_(modelRef, viewRef, labelDef.column, CONFIG.FACTOR_CANDIDATE_COLUMNS, l1Reg), 'train_model');

  var evalRows = runBqQuery_(buildEvaluateSql_(modelRef), 'evaluate');
  var weightRows = runBqQuery_(buildWeightsSql_(modelRef), 'weights');
  var weights = summarizeWeights_(weightRows);
  var r2 = evalRows.length > 0 ? parseFloat(evalRows[0].r2_score) : null;

  return {
    labelKey: labelDef.key,
    labelName: labelDef.name,
    r2: r2,
    weights: weights,
    featureColumns: CONFIG.FACTOR_CANDIDATE_COLUMNS,
    l1Reg: l1Reg
  };
}

/** 前端下拉選單用：列出全部產業相關候選因子——24 種「產業資金流向」（同業橫斷面排名，
 *  4 種法人類別 × 6 種移動平均窗口）+ 12 種「產業相對大盤強度」（產業參與度 - 大盤參與度，
 *  三大法人合計 6 種天期 + 外資/投信/自營商各自 2 種代表天期），給「檢查資料分佈」跟
 *  權重顯示用的中文標籤對照。兩組用標籤尾巴的括號文字區分，避免混淆。 */
function getIndustryFlowFactorOptions() {
  var options = [];
  CONFIG.INDUSTRY_FLOW_INVESTOR_TYPES.forEach(function (t) {
    CONFIG.INDUSTRY_FLOW_WINDOWS.forEach(function (w) {
      options.push({
        value: CONFIG.industryFlowFactorName(t.key, w),
        label: t.label + ' · ' + w + '天' + (w === 1 ? '（單日）' : '移動平均') + '（同業排名）'
      });
    });
  });
  CONFIG.INDUSTRY_FLOW_INVESTOR_TYPES.forEach(function (t) {
    CONFIG.industryRelMarketWindowsForType(t.key).forEach(function (w) {
      options.push({
        value: CONFIG.industryRelMarketFactorName(t.key, w),
        label: t.label + ' · ' + w + '天' + (w === 1 ? '（單日）' : '移動平均') + '（相對大盤強度）'
      });
    });
  });
  return options;
}

/**
 * 前端「檢查資料分佈」按鈕呼叫：直接查 factor_features view 裡指定產業資金流向因子實際的
 * 資料分佈，用來回答「這個因子的權重是 0，到底是真的沒有預測力，還是這一欄根本沒有真實
 * 資料（例如 industry_map 沒同步好）」——這兩種情況訓練出來的權重可能長得一模一樣
 * （LASSO 本來就會把沒用的因子壓到剛好 0），不看實際資料分佈沒辦法分辨。
 *
 * factorName 一定要是候選因子清單裡合法的名稱才會真的查詢，避免任意字串被插進 SQL。
 */
function getIndustryCapitalFlowFactorStats(factorName) {
  if (CONFIG.FACTOR_CANDIDATE_COLUMNS.indexOf(factorName) === -1) {
    throw new Error('不是合法的候選因子名稱：' + factorName);
  }
  var settings = requireBigQueryProjectId_();
  ensureFeatureView_(settings);
  var rows = runBqQuery_(buildIndustryCapitalFlowStatsSql_(bqFeatureViewRef_(settings), factorName), 'industry_capital_flow_stats');
  if (!rows || rows.length === 0) {
    return { totalRows: 0, nonNullCount: 0, nonNeutralCount: 0, min: null, max: null, avg: null, stddev: null };
  }
  var r = rows[0];
  return {
    totalRows: parseInt(r.total_rows, 10) || 0,
    nonNullCount: parseInt(r.non_null_count, 10) || 0,
    nonNeutralCount: parseInt(r.non_neutral_count, 10) || 0,
    min: r.min_v === null || r.min_v === undefined ? null : parseFloat(r.min_v),
    max: r.max_v === null || r.max_v === undefined ? null : parseFloat(r.max_v),
    avg: r.avg_v === null || r.avg_v === undefined ? null : parseFloat(r.avg_v),
    stddev: r.stddev_v === null || r.stddev_v === undefined ? null : parseFloat(r.stddev_v)
  };
}

function getFactorModelHistorySheet_() {
  return ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.FACTOR_MODEL_HISTORY, CONFIG.FACTOR_MODEL_COLUMNS);
}

function logFactorModelRun_(result, timestamp) {
  var sheet = getFactorModelHistorySheet_();
  appendSheetObjects_(sheet, CONFIG.FACTOR_MODEL_COLUMNS, [{
    '執行時間': timestamp,
    '標的Label': result.labelKey,
    'L1正規化強度': result.l1Reg,
    '使用特徵': result.featureColumns.join(', '),
    '訓練列數': result.trainRows || '',
    'R2': result.r2,
    '權重(JSON)': JSON.stringify(result.weights),
    '狀態': '完成',
    '目前套用版本': ''
  }]);
}

/**
 * 主入口：對兩個 label 各跑一次 BQML 訓練，結果各記一筆到 FactorModelHistory。
 * 前端「執行本週因子迴歸」按鈕呼叫這個。建議每週跑一次（資料量還小的階段跑太頻繁沒有意義，
 * 因子有效性不會一天一天大幅變動）。
 */
function runFactorRegression(l1Reg) {
  var settings = requireBigQueryProjectId_();
  ensureFeatureView_(settings);

  var reg = l1Reg || CONFIG.FACTOR_MODEL_L1_REG_DEFAULT;
  var timestamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  var results = [];

  Object.keys(CONFIG.FACTOR_LABELS).forEach(function (key) {
    var labelDef = CONFIG.FACTOR_LABELS[key];
    try {
      var result = trainFactorModel_(settings, labelDef, reg);
      logFactorModelRun_(result, timestamp);
      results.push(result);
    } catch (e) {
      logRun_('因子迴歸', '失敗', labelDef.name + '：' + String(e.message || e), 0);
      results.push({ labelKey: labelDef.key, labelName: labelDef.name, error: String(e.message || e) });
    }
  });

  return { timestamp: timestamp, results: results };
}

// ============================================================
// 「執行因子迴歸」背景 job（機制跟 DataFetch.gs 的補抓 job／Analysis.gs 的重新計算 job 相同）。
// BQML 訓練 + 評估 + 取權重要對兩個 label 各跑一輪，實測常常超過一般瀏覽器/行動網路能穩定
// 撐住的連線時間，手機切到背景更容易直接把連線中斷、前端 success handler 永遠等不到，才會
// 看到「NetworkError: 連線失敗，原因 HTTP 0」——即使 BigQuery 那邊其實還在跑或已經跑完。
// 改用時間觸發器在背景做，前端只需要輪詢 getFactorRegressionJobStatus() 顯示進度。
// ============================================================

function getFactorRegressionJobState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.FACTOR_REGRESSION_JOB_STATE);
  return raw ? JSON.parse(raw) : null;
}

function saveFactorRegressionJobState_(state) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.FACTOR_REGRESSION_JOB_STATE, JSON.stringify(state));
}

function deleteFactorRegressionJobTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processFactorRegressionJobTick_') ScriptApp.deleteTrigger(t);
  });
}

/** 前端「執行因子迴歸」按鈕呼叫：排一個幾乎立刻觸發的一次性時間觸發器就馬上回傳，
 *  實際訓練在另一次獨立觸發的執行裡進行，不受這次瀏覽器連線影響。 */
function startFactorRegressionJob(l1Reg) {
  deleteFactorRegressionJobTriggers_();
  saveFactorRegressionJobState_({
    status: 'running', l1Reg: l1Reg || CONFIG.FACTOR_MODEL_L1_REG_DEFAULT, updatedAt: Date.now()
  });
  ScriptApp.newTrigger('processFactorRegressionJobTick_').timeBased().after(3000).create();
  return { status: 'running' };
}

/** 前端輪詢用：狀態存在 Script Properties，任何時候打開頁面呼叫都看得到最新進度或結果。 */
function getFactorRegressionJobStatus() {
  return autoHealStaleJobState_(CONFIG.PROP_KEYS.FACTOR_REGRESSION_JOB_STATE, getFactorRegressionJobState_() || { status: 'idle' });
}

/** 排程佇列的「刪除」按鈕呼叫：不管目前狀態是什麼，直接清掉狀態跟任何已排定的觸發器，
 *  回到乾淨的 idle。給觸發器不知道為什麼沒有真的被觸發、狀態卡在 running 卻再也不會有
 *  進度的情況用（見 DataFetch.gs 的 clearBackfillJob_ 同樣的說明跟限制）。 */
function clearFactorRegressionJob_() {
  deleteFactorRegressionJobTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.PROP_KEYS.FACTOR_REGRESSION_JOB_STATE);
  return { status: 'idle' };
}

/** 真正做事的地方，由時間觸發器呼叫，完全不受瀏覽器分頁影響。跟 processAnalysisJobTick_
 *  一樣是單一批次（對兩個 label 各跑一次），沒有像補抓 job 那樣的時間預算/續跑機制。 */
function processFactorRegressionJobTick_() {
  deleteFactorRegressionJobTriggers_();
  var state = getFactorRegressionJobState_();
  if (!state || state.status !== 'running') return;

  var startTime = Date.now();
  try {
    var res = runFactorRegression(state.l1Reg);
    state.status = 'done';
    state.timestamp = res.timestamp;
    state.results = res.results;
    state.updatedAt = Date.now();
    saveFactorRegressionJobState_(state);
    var okCount = res.results.filter(function (r) { return !r.error; }).length;
    logRun_('因子迴歸', okCount === res.results.length ? '成功' : '部分失敗',
      res.results.map(function (r) { return r.labelName + (r.error ? '：失敗' : '：R²=' + r.r2); }).join('、'),
      Math.round((Date.now() - startTime) / 1000));
  } catch (e) {
    state.status = 'error';
    state.errorMessage = String(e.message || e);
    state.updatedAt = Date.now();
    saveFactorRegressionJobState_(state);
    logRun_('因子迴歸', '失敗', String(e.message || e), Math.round((Date.now() - startTime) / 1000));
  }
}

/** 前端：取得歷史執行紀錄（新到舊）。「執行時間」欄位是 'yyyy-MM-dd HH:mm:ss' 格式的字串
 *  寫進去的，但 Google Sheets 常把這種看起來像日期時間的字串自動存成 Date 物件，讀回來
 *  直接回傳給前端有可能讓整包回傳值序列化失敗（見 sanitizeRowForRpc_ 的說明），要先過一層。 */
function getFactorModelHistory(limit) {
  var rows = readSheetObjects_(getFactorModelHistorySheet_());
  rows.reverse();
  return rows.slice(0, limit || 50).map(sanitizeRowForRpc_);
}

/**
 * 前端：把某一次「執行因子迴歸」（timestamp）產生的所有 label（1個月報酬 + 抗跌力）一起
 * 標記為「目前套用版本」，同時清掉其他所有版本（不管哪個 label）的套用標記。
 *
 * 套用刻意做成「整個版本」等級的動作，不是兩個 label 各自獨立套用——原本可以分開套用會導致
 * 「目前生效的到底是哪一版」沒有單一答案（例如 1個月報酬用 A 版、抗跌力卻套用 B 版），
 * 使用者在畫面上完全看不出這種不一致，也很難回答「這一版模型」對戰報的影響是什麼。
 *
 * timestamp 是前端從 getFactorModelHistory() 拿到、已經過 sanitizeRowForRpc_ 正規化的字串；
 * 這裡讀回來的 r['執行時間'] 則可能是 Sheets 自動轉型出來的 Date 物件（要看那一列是不是
 * 剛好碰上自動轉型），兩邊都要正規化成同樣格式才能正確比對，不能直接用 === 比字串跟
 * Date 物件。
 */
function applyFactorModel(timestamp) {
  var sheet = getFactorModelHistorySheet_();
  var rows = readSheetObjects_(sheet);
  rows.forEach(function (r) {
    var rowTimestamp = (r['執行時間'] instanceof Date) ? formatDateForRpc_(r['執行時間']) : r['執行時間'];
    r['目前套用版本'] = (rowTimestamp === timestamp) ? '✓ 套用中' : '';
  });
  writeSheetObjects_(sheet, CONFIG.FACTOR_MODEL_COLUMNS, rows);
  return { ok: true };
}

/** 前端：目前套用中的因子組合（給之後要接回選股邏輯時查詢用；目前只是記錄+顯示，不會自動影響 Armor_Score）。 */
function getAppliedFactorModels() {
  var rows = readSheetObjects_(getFactorModelHistorySheet_());
  var applied = {};
  rows.forEach(function (r) {
    if (String(r['目前套用版本'] || '').indexOf('套用中') !== -1) {
      applied[r['標的Label']] = {
        timestamp: r['執行時間'],
        r2: r['R2'],
        weights: JSON.parse(r['權重(JSON)'] || '{}')
      };
    }
  });
  return applied;
}

/**
 * 前端「策略研究 > 因子回歸模型」的「🌟 目前生效模型」卡片專用：把 getAppliedFactorModels()
 * 的原始資料整理成前端可以直接渲染的白話版本（人性化的中文因子名稱對照表放在前端
 * JavaScript.html，這裡只回傳依權重絕對值排序好的原始 bq 欄位名稱清單）。
 * sameVersion 標記兩個 label 目前套用的是不是同一次執行（正常情況下 applyFactorModel()
 * 一定會讓兩者一致，這裡保留判斷是為了保護舊資料或未來手動改過 Sheet 的邊界情況）。
 */
function getActiveFactorModelSummary() {
  var applied = getAppliedFactorModels();
  var r1 = applied[CONFIG.FACTOR_LABELS.RETURN_1M.key];
  var dr = applied[CONFIG.FACTOR_LABELS.DOWNSIDE_RESISTANCE.key];
  if (!r1 && !dr) return { active: false };

  function tsOf_(m) {
    if (!m) return null;
    return (m.timestamp instanceof Date) ? formatDateForRpc_(m.timestamp) : m.timestamp;
  }
  function summarize_(m) {
    if (!m) return null;
    return { timestamp: tsOf_(m), r2: m.r2, topFeatures: topWeightedFeatures_(m.weights, 5) };
  }

  var r1Timestamp = tsOf_(r1);
  var drTimestamp = tsOf_(dr);

  return {
    active: true,
    sameVersion: !!(r1Timestamp && drTimestamp && r1Timestamp === drTimestamp),
    return1m: summarize_(r1),
    downsideResistance: summarize_(dr)
  };
}
