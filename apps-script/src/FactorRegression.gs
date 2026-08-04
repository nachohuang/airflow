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
 * （見 BigQuerySync.gs syncIndustryMapToBigQuery_）。LEFT JOIN 進來只用來算 industry_capital_flow
 * 這一個候選因子——查不到產業別（例如 ETF、上櫃股票，見 IndustryMap.gs 說明）的股票這個
 * 因子就是 NULL，不影響其他因子照常計算。
 *
 * industry_capital_flow 定義：「同產業其他股票（排除自己）當天法人買賣超的平均值」，不是
 * 單純把同產業全部股票的買賣超加總——加總的話會把「這檔股票自己的買賣超」也算進它自己的
 * 因子值裡，變成自己預測自己的循環相關，訓練出來的權重會失真；排除自己、只看「同業其他
 * 人在幹嘛」才是乾淨的橫斷面訊號。用 SAFE_DIVIDE 處理「這個產業當天只有這一檔股票」的
 * 邊界情況（分母是 0），這種情況因子值就是 NULL，不會撞到除以 0 的錯誤。
 */
function buildFeatureViewSql_(rawTableRef, industryMapTableRef, viewRef) {
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
    '    LAG(ma20, 3) OVER (PARTITION BY stock_id ORDER BY dt) AS ma20_3ago,',
    '    SUM(inst_net) OVER (PARTITION BY industry, dt) AS industry_inst_net_sum,',
    '    COUNT(*) OVER (PARTITION BY industry, dt) AS industry_stock_count',
    '  FROM step1',
    '),',
    'step3 AS (',
    '  SELECT *,',
    '    (ma20 - ma20_3ago) AS ma20_slope,',
    '    SUM(is_drop) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS drop_count_20,',
    '    SUM(is_inst_buy_on_drop) OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS buy_on_drop_20,',
    '    CASE WHEN industry IS NOT NULL AND industry_stock_count > 1',
    '      THEN SAFE_DIVIDE(industry_inst_net_sum - inst_net, industry_stock_count - 1) END AS industry_capital_flow',
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
    // COALESCE 成 0（不是留 NULL）：buildTrainModelSql_ 要求所有候選因子都 NOT NULL 才會拿去
    // 訓練，任何一列只要有一個因子是 NULL 就整列被排除。查不到產業別的股票（ETF、上櫃、
    // industry_map 還沒同步過）每天都會是 NULL，如果照其他因子一樣留 NULL，只要 industry_map
    // 覆蓋率沒有 100%，就會把大量列擋在訓練資料外——實測甚至遇過 industry_map 剛好是空的，
    // 導致「整批」被排除、訓練查詢直接回傳 0 列失敗（Input data doesn't contain any rows.）。
    // 用 0（=「沒有明顯的同業買賣超訊號」，是這個量本身合理的中性值）取代 NULL，其他因子
    // 都正常時這一列還是能拿去訓練，這個因子頂多在缺資料的列上貢獻中性訊號，不會拖累整批。
    '  COALESCE(industry_capital_flow, 0) AS industry_capital_flow,',
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
