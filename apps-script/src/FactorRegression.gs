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

/** 因子特徵 + 兩個預測目標的 BigQuery view SQL。 */
function buildFeatureViewSql_(rawTableRef, viewRef) {
  return [
    'CREATE OR REPLACE VIEW `' + viewRef + '` AS',
    'WITH base AS (',
    '  SELECT',
    '    stock_id, stock_name,',
    '    SAFE_CAST(date_str AS DATE) AS dt,',
    '    SAFE_CAST(close_price AS FLOAT64) AS close,',
    '    SAFE_CAST(volume_shares AS FLOAT64) AS vol,',
    '    SAFE_CAST(foreign_net AS FLOAT64) AS foreign_v,',
    '    SAFE_CAST(trust_net AS FLOAT64) AS trust_v,',
    '    SAFE_CAST(dealer_net AS FLOAT64) AS dealer_v,',
    '    SAFE_CAST(dividend_yield AS FLOAT64) AS dividend_yield_f,',
    '    SAFE_CAST(pe_ratio AS FLOAT64) AS pe_ratio_f,',
    '    SAFE_CAST(pb_ratio AS FLOAT64) AS pb_ratio_f',
    '  FROM `' + rawTableRef + '`',
    '  WHERE LENGTH(stock_id) = 4',
    '),',
    'step1 AS (',
    '  SELECT *,',
    '    (foreign_v + trust_v + dealer_v) AS inst_net,',
    '    SAFE_DIVIDE(ABS(foreign_v) + ABS(trust_v) + ABS(dealer_v), vol) AS inst_participation,',
    '    SAFE_DIVIDE(close, LAG(close) OVER (PARTITION BY stock_id ORDER BY dt)) - 1 AS daily_return,',
    '    AVG(close) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,',
    '    AVG(close) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS ma60,',
    '    AVG(vol) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20',
    '  FROM base',
    '),',
    'step2 AS (',
    '  SELECT *,',
    '    AVG(inst_participation) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) AS inst_part_ma5,',
    '    CASE WHEN daily_return < 0 THEN 1 ELSE 0 END AS is_drop,',
    '    CASE WHEN daily_return < 0 AND inst_net > 0 THEN 1 ELSE 0 END AS is_inst_buy_on_drop,',
    '    SAFE_DIVIDE(vol, vol_ma20) AS vol_ratio,',
    '    SAFE_DIVIDE(close - ma60, ma60) AS bias60,',
    '    LAG(ma20, 3) OVER (PARTITION BY stock_id ORDER BY dt) AS ma20_3ago',
    '  FROM step1',
    '),',
    'step3 AS (',
    '  SELECT *,',
    '    (ma20 - ma20_3ago) AS ma20_slope,',
    '    SUM(is_drop) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS drop_count_20,',
    '    SUM(is_inst_buy_on_drop) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS buy_on_drop_20',
    '  FROM step2',
    '),',
    'step4 AS (',
    '  SELECT *,',
    '    CASE WHEN drop_count_20 IS NULL OR drop_count_20 = 0 THEN 0 ELSE buy_on_drop_20 / drop_count_20 END AS ibf_20d,',
    '    (CASE WHEN ma20 IS NOT NULL AND close > ma20 THEN 1 ELSE 0 END',
    '      + CASE WHEN ma20_slope IS NOT NULL AND ma20_slope > 0 THEN 1 ELSE 0 END) AS trend_score',
    '  FROM step3',
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
    '  label_return_1m, label_downside_resistance',
    'FROM labeled'
  ].join('\n');
}

/** BQML 訓練用的 model 名稱（同一個 label 每次重訓都是 CREATE OR REPLACE，同名覆蓋）。 */
function factorModelName_(labelKey) {
  return 'factor_model_' + labelKey;
}

function buildTrainModelSql_(modelRef, viewRef, labelColumn, featureColumns, l1Reg) {
  var selectCols = featureColumns.concat([labelColumn]).join(', ');
  var notNullConds = featureColumns.concat([labelColumn]).map(function (c) { return c + ' IS NOT NULL'; }).join(' AND ');
  return [
    'CREATE OR REPLACE MODEL `' + modelRef + '`',
    'OPTIONS(',
    "  model_type='linear_reg',",
    '  l1_reg=' + l1Reg + ',',
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
  runBqQuery_(buildFeatureViewSql_(bqActiveSourceTableRef_(settings), bqFeatureViewRef_(settings)), 'feature_view');
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

/** 前端：取得歷史執行紀錄（新到舊）。 */
function getFactorModelHistory(limit) {
  var rows = readSheetObjects_(getFactorModelHistorySheet_());
  rows.reverse();
  return rows.slice(0, limit || 50);
}

/** 前端：把某一筆歷史紀錄標記為「目前套用版本」（同一個 label 只會有一筆被標記）。 */
function applyFactorModel(timestamp, labelKey) {
  var sheet = getFactorModelHistorySheet_();
  var rows = readSheetObjects_(sheet);
  rows.forEach(function (r) {
    if (r['標的Label'] === labelKey) {
      r['目前套用版本'] = (r['執行時間'] === timestamp) ? '✓ 套用中' : '';
    }
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
