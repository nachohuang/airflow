/**
 * factorRegression.js
 * 「跟隨市場更新」的因子有效性迴歸：以 BigQuery 因子特徵 view 為基礎，用
 * BigQuery ML 的 LASSO 線性迴歸（linear_reg + l1_reg）找出目前最能預測
 *   1) 後續一個月報酬率（label_return_1m）
 *   2) 相對大盤的抗跌力（label_downside_resistance）
 * 的因子組合。從 apps-script/src/FactorRegression.gs 複製純函式邏輯過來
 * （實際呼叫 BigQuery／寫入 Firestore 的 I/O 留給 index.js，見
 * runFactorRegressionCore_ 的說明）。
 *
 * 「相對大盤的抗跌力」定義（label_downside_resistance）：市場當日報酬
 * mkt_return(d) = 當天所有股票 daily_return 的橫斷面平均（等權重市場代理
 * 指標）。對每一檔股票、每一天 t，往後看 20 個交易日內「大盤下跌的那幾
 * 天」，算這檔股票在那些天的 (個股報酬 - 大盤報酬) 平均值——數字越大，
 * 代表大盤跌的時候這檔股票跌得比大盤少（甚至逆勢上漲）。
 *
 * 複製時機：2026-10-08，對照 apps-script/src/FactorRegression.gs 當時的
 * 內容。
 */
var config = require('./config');

/**
 * 因子特徵 + 兩個預測目標的 BigQuery view SQL——完整說明（產業資金流向
 * 矩陣、產業相對大盤強度、動能時機候選因子的算法跟理由）見
 * apps-script/src/FactorRegression.gs `buildFeatureViewSql_` 開頭的註解，
 * 這裡不重複抄一次，邏輯逐行對照原檔照搬，只把 CONFIG 換成這份 config.js。
 */
function buildFeatureViewSql_(rawTableRef, industryMapTableRef, viewRef) {
  var types = config.INDUSTRY_FLOW_INVESTOR_TYPES;
  var windows = config.INDUSTRY_FLOW_WINDOWS;

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
      var outName = config.industryFlowFactorName(t.key, w);
      rankLines.push('    CASE WHEN ' + maName + ' IS NULL THEN 0.5' +
        ' ELSE PERCENT_RANK() OVER (PARTITION BY dt ORDER BY ' + maName + ') END AS ' + outName);
    });
  });

  var finalFlowLines = [];
  types.forEach(function (t) {
    windows.forEach(function (w) {
      var name = config.industryFlowFactorName(t.key, w);
      finalFlowLines.push('  COALESCE(' + name + ', 0.5) AS ' + name);
    });
  });

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
    config.industryRelMarketWindowsForType(t.key).forEach(function (w) {
      var maName = 'industry_rel_mkt_ma_' + t.key + '_' + w + 'd';
      if (w === 1) {
        relMaLines.push('    industry_rel_mkt_raw_' + t.key + ' AS ' + maName);
      } else {
        relMaLines.push('    AVG(industry_rel_mkt_raw_' + t.key + ') OVER (PARTITION BY stock_id ORDER BY dt' +
          ' ROWS BETWEEN ' + (w - 1) + ' PRECEDING AND CURRENT ROW) AS ' + maName);
      }
      var outName = config.industryRelMarketFactorName(t.key, w);
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

/** 把 factor_features view 的結果凍結成一份快照表，供同一次執行對兩個
 *  label 訓練時共用，避免這段重 SQL 對同一個 view 跑兩次。 */
function buildFeatureSnapshotSql_(viewRef, snapshotTableRef) {
  return 'CREATE OR REPLACE TABLE `' + snapshotTableRef + '` AS SELECT * FROM `' + viewRef + '`';
}

/**
 * 訓練參數的選擇（`optimize_strategy`／`learn_rate_strategy`／
 * `max_iterations`／`min_rel_progress`）：apps-script 版實測發現候選因子
 * 擴充到 46+ 個之後，BigQuery ML 預設的梯度下降法配「提前停止」（損失改善
 * 低於 1% 就收斂，最多 20 輪）很容易在 L1 懲罰真正累積起作用之前就提前
 * 收斂，係數看起來還很接近沒做正規化的樣子。這裡明確指定
 * `BATCH_GRADIENT_DESCENT`＋`LINE_SEARCH`，並把 `max_iterations` 拉到
 * BQML 允許的上限 49（官方規定單次訓練必須小於 50，要跑更多輪得用
 * warm_start，這裡不需要）。
 */
function buildTrainModelSql_(modelRef, viewRef, labelColumn, featureColumns, l1Reg) {
  var selectCols = featureColumns.concat([labelColumn]).join(', ');
  // 2026-10-08 修正：基本面因子（fundamental_*，見 config.js
  // FUNDAMENTAL_CANDIDATE_COLUMNS）目前資料覆蓋率極低（財報因子才剛開始
  // 累積歷史），原本「全部候選因子都要 NOT NULL」的條件 AND 起來之後，
  // 幾乎每一列都會因為某個 fundamental_* 欄位是 NULL 被整列排除，訓練
  // 實測變成 0 筆資料（「Input data doesn't contain any rows」）——跟
  // ensureFinancialsSyncedToBigQuery_ 註解原本講好的設計（基本面因子缺
  // 資料「不影響其他既有候選因子正常訓練」）矛盾。改成只要求「非基本面
  // 因子」NOT NULL；基本面因子欄位繼續選進 SELECT 但不擋列，BigQuery ML
  // 在沒有 TRANSFORM 子句時，數值欄位的 NULL 預設就會自動用該欄位的平均值
  // 插補（mean imputation，見官方文件 Automatic feature preprocessing），
  // 不需要自己在 SQL 裡 COALESCE 成某個值。
  var fundamentalCols = config.FUNDAMENTAL_CANDIDATE_COLUMNS || [];
  var requiredNotNullCols = featureColumns.filter(function (c) {
    return fundamentalCols.indexOf(c) === -1;
  }).concat([labelColumn]);
  var notNullConds = requiredNotNullCols.map(function (c) { return c + ' IS NOT NULL'; }).join(' AND ');
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

/** 依權重絕對值排序，取前 count 個因子欄位名稱（給「目前生效模型」卡片列出
 *  「關鍵影響因子」用）。 */
function topWeightedFeatures_(weights, count) {
  if (!weights) return [];
  return Object.keys(weights).sort(function (a, b) {
    return Math.abs(weights[b]) - Math.abs(weights[a]);
  }).slice(0, count || 5);
}

/**
 * Firestore `factor_model_history` 文件 ID——跟 Phase 2 一次性遷移腳本
 * （firebase-migration/migration/factor_model_history/transform.js 的
 * buildDocId_）同一套公式，新訓練出來的結果要用同一套規則，才能跟遷移
 * 過去的舊資料共用同一個 collection、不會撞到或產生不一致的 ID 格式。
 * 同一次執行對兩個 label（return1m／downsideResistance）各留一筆，不能
 * 只用執行時間當鍵（那樣兩筆會互相覆蓋）。
 */
function buildFactorModelDocId_(timestamp, labelKey) {
  return timestamp.replace(/ /g, '_').replace(/:/g, '-') + '_' + labelKey;
}

/** 診斷用 SQL：查 factor_features view 裡指定產業資金流向因子的資料分佈
 *  ——LASSO 對「真的沒有預測力」跟「這欄根本是常數」這兩種情況，訓練出來
 *  的權重看起來會一樣（都可能是精確的 0），單看權重數字分不出來。
 *  columnName 呼叫端要先驗證過是合法的候選因子名稱（見
 *  isValidFactorCandidateColumn_），這裡直接把字串插進 SQL，不能接受
 *  任意輸入。 */
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

/** 驗證一個欄位名稱是不是候選因子清單裡合法的名稱——避免任意字串被插進
 *  `buildIndustryCapitalFlowStatsSql_` 的 SQL。 */
function isValidFactorCandidateColumn_(columnName) {
  return config.FACTOR_CANDIDATE_COLUMNS.indexOf(columnName) !== -1;
}

module.exports = {
  buildFeatureViewSql_: buildFeatureViewSql_,
  factorModelName_: factorModelName_,
  buildFeatureSnapshotSql_: buildFeatureSnapshotSql_,
  buildTrainModelSql_: buildTrainModelSql_,
  buildEvaluateSql_: buildEvaluateSql_,
  buildWeightsSql_: buildWeightsSql_,
  summarizeWeights_: summarizeWeights_,
  topWeightedFeatures_: topWeightedFeatures_,
  buildFactorModelDocId_: buildFactorModelDocId_,
  buildIndustryCapitalFlowStatsSql_: buildIndustryCapitalFlowStatsSql_,
  isValidFactorCandidateColumn_: isValidFactorCandidateColumn_
};
