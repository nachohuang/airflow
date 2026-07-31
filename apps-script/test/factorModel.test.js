const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// BigQuerySync.gs / FactorRegression.gs 裡「不呼叫 BigQuery/DriveApp」的純函式，
// 用跟 historyFiles.test.js 一樣的手法：把 .gs 檔案載進共用的 vm context 直接測。
const context = { console: console, JSON: JSON, parseFloat: parseFloat, Math: Math };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('BigQuerySync.gs');
loadIntoContext('FactorRegression.gs');

// --- bqColumnNames_ ---
{
  const cols = context.bqColumnNames_();
  assert.strictEqual(cols.length, context.CONFIG.HISTORY_COLUMNS.length);
  assert.strictEqual(cols[0], 'date_str');
  assert.strictEqual(cols[1], 'stock_id');
  assert.strictEqual(cols[cols.length - 1], 'fin_report_period');
  console.log('Test bqColumnNames_ passed.');
}

// --- remapCsvHeaderToBigQuery_ ---
{
  const csvText = '﻿' + context.CONFIG.HISTORY_COLUMNS.join(',') + '\n2330,台積電,100\n2317,鴻海,50\n';
  const remapped = context.remapCsvHeaderToBigQuery_(csvText);
  const lines = remapped.split('\n');
  assert.strictEqual(lines[0], context.bqColumnNames_().join(','));
  assert.strictEqual(lines[1], '2330,台積電,100');
  assert.strictEqual(lines[2], '2317,鴻海,50');
  console.log('Test remapCsvHeaderToBigQuery_ passed.');
}

// --- monthStartEnd_ ---
// (用 Object.assign 攤平成主 realm 的物件，避免 vm context 跨 realm 造成 deepStrictEqual 誤判)
{
  assert.deepStrictEqual(Object.assign({}, context.monthStartEnd_('2026-07')), { start: '2026-07-01', end: '2026-07-31' });
  assert.deepStrictEqual(Object.assign({}, context.monthStartEnd_('2026-02')), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepStrictEqual(Object.assign({}, context.monthStartEnd_('2024-02')), { start: '2024-02-01', end: '2024-02-29' }); // 閏年
  console.log('Test monthStartEnd_ passed.');
}

// --- buildDriveFileUri_ ---
{
  assert.strictEqual(context.buildDriveFileUri_('abcDEF123456'), 'https://drive.google.com/open?id=abcDEF123456');
  console.log('Test buildDriveFileUri_ passed.');
}

// --- calcBqCost_ ---
{
  const oneTb = 1024 * 1024 * 1024 * 1024;
  assert.ok(Math.abs(context.calcBqCost_(oneTb, 6.25) - 6.25) < 1e-9);
  assert.ok(Math.abs(context.calcBqCost_(oneTb / 2, 6.25) - 3.125) < 1e-9);
  assert.strictEqual(context.calcBqCost_(0, 6.25), 0);
  assert.strictEqual(context.calcBqCost_('12345', 6.25), context.calcBqCost_(12345, 6.25)); // API 回傳的是字串
  // 沒指定單價時用預設值
  assert.ok(Math.abs(context.calcBqCost_(oneTb) - context.CONFIG.BIGQUERY_PRICE_PER_TB_DEFAULT) < 1e-9);
  console.log('Test calcBqCost_ passed.');
}

// --- buildDeleteMonthSql_ ---
{
  const sql = context.buildDeleteMonthSql_('proj.ds.history_raw', '2026-07');
  assert.ok(sql.indexOf('DELETE FROM `proj.ds.history_raw`') === 0);
  assert.ok(sql.indexOf("date_str >= '2026-07-01'") !== -1);
  assert.ok(sql.indexOf("date_str <= '2026-07-31'") !== -1);
  console.log('Test buildDeleteMonthSql_ passed.');
}

// --- buildDeleteDatesSql_ ---
{
  const sql = context.buildDeleteDatesSql_('proj.ds.history_raw', ['2026-07-21', '2026-07-22']);
  assert.ok(sql.indexOf('DELETE FROM `proj.ds.history_raw`') === 0);
  assert.ok(sql.indexOf("date_str IN ('2026-07-21', '2026-07-22')") !== -1);
  console.log('Test buildDeleteDatesSql_ passed.');
}

// --- buildMalformedDateCountSql_ / buildDeleteMalformedDateRowsSql_：找出/清掉 date_str 不是
//     yyyy-MM-dd 的列（例如舊版寫入邏輯留下的 'yyyy/MM/dd'，會被 SAFE_CAST(date_str AS DATE)
//     悄悄忽略，讓「最新戰報」卡在格式正確的最後一天）---
{
  const countSql = context.buildMalformedDateCountSql_('proj.ds.history_raw');
  assert.ok(countSql.indexOf('SELECT COUNT(*) AS cnt FROM `proj.ds.history_raw`') === 0);
  assert.ok(countSql.indexOf("NOT REGEXP_CONTAINS(date_str, r'^\\d{4}-\\d{2}-\\d{2}$')") !== -1);

  const deleteSql = context.buildDeleteMalformedDateRowsSql_('proj.ds.history_raw');
  assert.ok(deleteSql.indexOf('DELETE FROM `proj.ds.history_raw`') === 0);
  assert.ok(deleteSql.indexOf("NOT REGEXP_CONTAINS(date_str, r'^\\d{4}-\\d{2}-\\d{2}$')") !== -1);

  const distinctSql = context.buildMalformedDateDistinctSql_('proj.ds.history_raw');
  assert.ok(distinctSql.indexOf('SELECT DISTINCT date_str FROM `proj.ds.history_raw`') === 0);
  assert.ok(distinctSql.indexOf("NOT REGEXP_CONTAINS(date_str, r'^\\d{4}-\\d{2}-\\d{2}$')") !== -1);
  console.log('Test buildMalformedDateCountSql_ / buildDeleteMalformedDateRowsSql_ / buildMalformedDateDistinctSql_ passed.');
}

// --- normalizeRowsDateField_：寫進 history_raw 前把 formatSlashDate_ 的 'yyyy/MM/dd' 轉成
//     yyyy-MM-dd（不然 SAFE_CAST(date_str AS DATE) 解析失敗，這是這次修的實際 bug）；
//     不能動到原本的列物件，Drive 月份 CSV 路徑還要繼續用未改過的 'yyyy/MM/dd' 顯示格式 ---
{
  const original = [
    { '日期': '2026/07/30', '證券代號': '2330', '收盤價': 100 },
    { '日期': '2026-07-21', '證券代號': '1101', '收盤價': 50 }
  ];
  const normalized = context.normalizeRowsDateField_(original);
  assert.strictEqual(normalized[0]['日期'], '2026-07-30');
  assert.strictEqual(normalized[1]['日期'], '2026-07-21');
  assert.strictEqual(normalized[0]['證券代號'], '2330', '其他欄位要原封不動保留');
  assert.strictEqual(original[0]['日期'], '2026/07/30', '不能動到原本的列物件（Drive CSV 路徑還要用未改過的格式）');
  console.log('Test normalizeRowsDateField_ passed.');
}

// --- buildUnifiedViewSql_：history_raw（每天直接寫入）UNION history_materialized（舊資料基準），
//     同一天同一檔股票兩邊都有的話 history_raw 要贏（比較新鮮）---
{
  const sql = context.buildUnifiedViewSql_('proj.ds.history_raw', 'proj.ds.history_materialized', 'proj.ds.history_unified');
  assert.ok(sql.indexOf('CREATE OR REPLACE VIEW `proj.ds.history_unified`') === 0);
  assert.ok(sql.indexOf('FROM `proj.ds.history_raw`') !== -1);
  assert.ok(sql.indexOf('FROM `proj.ds.history_materialized`') !== -1);
  assert.ok(sql.indexOf('0 AS src_priority FROM `proj.ds.history_raw`') !== -1, 'history_raw 要標更低的 src_priority 才會在同分時贏');
  assert.ok(sql.indexOf('1 AS src_priority FROM `proj.ds.history_materialized`') !== -1);
  assert.ok(sql.indexOf('PARTITION BY stock_id, date_str ORDER BY src_priority ASC') !== -1);
  assert.ok(sql.indexOf('WHERE rn = 1') !== -1);
  // 每個候選欄位都要出現在最終 SELECT 清單裡（不能漏欄位）
  context.CONFIG.BQ_COLUMN_MAP.forEach(function (m) {
    assert.ok(sql.indexOf(m.bq) !== -1, 'missing column in unified view: ' + m.bq);
  });

  // stock_id 兩邊 UNION 之前都要先清洗過（跟 Utils.gs sanitizeStockId_ 對齊），不然不同來源
  // 檔案對同一檔股票的格式差異會讓去重失效——這是「股票數（去重後）」異常暴增的根本原因。
  const cleanExpr = context.bqCleanStockIdExpr_();
  assert.ok(cleanExpr.indexOf("TRIM(stock_id)") !== -1);
  assert.ok(cleanExpr.indexOf("\\.0+$") !== -1, '要先去掉 Excel 把代號存成數字產生的小數點尾巴');
  assert.ok(sql.indexOf(cleanExpr + ' AS stock_id') !== -1, 'raw 跟 materialized 兩邊都要用同一個清洗表達式');
  const cleanCount = sql.split(cleanExpr + ' AS stock_id').length - 1;
  assert.strictEqual(cleanCount, 2, 'UNION 的兩邊（history_raw 跟 history_materialized）都要清洗，不能只洗一邊');

  // 清洗完仍然不像股票代號（長度不在 4~6 碼、含非英數字）的要被排除，不能流進下游查詢
  assert.ok(sql.indexOf("REGEXP_CONTAINS(stock_id, r'^[0-9A-Za-z]{4,6}$')") !== -1);
  console.log('Test buildUnifiedViewSql_ passed.');
}

// --- buildFeatureViewSql_ ---
{
  const sql = context.buildFeatureViewSql_('proj.ds.history_raw', 'proj.ds.factor_features');
  assert.ok(sql.indexOf('CREATE OR REPLACE VIEW `proj.ds.factor_features`') === 0);
  assert.ok(sql.indexOf('FROM `proj.ds.history_raw`') !== -1);
  // 兩個 label 都要在
  assert.ok(sql.indexOf('label_return_1m') !== -1);
  assert.ok(sql.indexOf('label_downside_resistance') !== -1);
  // label_return_1m 一定要用 SAFE_DIVIDE，避免收盤價是 0（缺值/停牌）時撞到 division by zero
  assert.ok(sql.indexOf('SAFE_DIVIDE(LEAD(close, 20)') !== -1);
  // 抗跌力只看大盤下跌的天數（相對大盤，不是絕對回檔）
  assert.ok(sql.indexOf('WHEN mkt_return < 0 THEN daily_return - mkt_return') !== -1);
  assert.ok(sql.indexOf('ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING') !== -1);
  // 候選因子欄位都要出現在最終 SELECT
  context.CONFIG.FACTOR_CANDIDATE_COLUMNS.forEach(function (col) {
    assert.ok(sql.indexOf(col) !== -1, 'missing candidate column: ' + col);
  });
  console.log('Test buildFeatureViewSql_ passed.');
}

// --- buildTrainModelSql_ ---
{
  const sql = context.buildTrainModelSql_(
    'proj.ds.factor_model_return1m', 'proj.ds.factor_features', 'label_return_1m',
    ['inst_part_ma5', 'ibf_20d'], 0.05
  );
  assert.ok(sql.indexOf("model_type='linear_reg'") !== -1);
  assert.ok(sql.indexOf('l1_reg=0.05') !== -1);
  assert.ok(sql.indexOf("input_label_cols=['label_return_1m']") !== -1);
  assert.ok(sql.indexOf('inst_part_ma5, ibf_20d, label_return_1m') !== -1);
  assert.ok(sql.indexOf('inst_part_ma5 IS NOT NULL AND ibf_20d IS NOT NULL AND label_return_1m IS NOT NULL') !== -1);
  console.log('Test buildTrainModelSql_ passed.');
}

// --- buildEvaluateSql_ / buildWeightsSql_ ---
{
  assert.strictEqual(context.buildEvaluateSql_('proj.ds.m'), 'SELECT * FROM ML.EVALUATE(MODEL `proj.ds.m`)');
  const weightsSql = context.buildWeightsSql_('proj.ds.m');
  assert.ok(weightsSql.indexOf('ML.WEIGHTS(MODEL `proj.ds.m`)') !== -1);
  assert.ok(weightsSql.indexOf('__INTERCEPT__') !== -1);
  console.log('Test buildEvaluateSql_ / buildWeightsSql_ passed.');
}

// --- summarizeWeights_ ---
{
  const weights = context.summarizeWeights_([
    { processed_input: 'ibf_20d', weight: '0.31' },
    { processed_input: 'inst_part_ma5', weight: '-0.12' }
  ]);
  assert.deepStrictEqual(Object.assign({}, weights), { ibf_20d: 0.31, inst_part_ma5: -0.12 });
  console.log('Test summarizeWeights_ passed.');
}

// --- resolveHeaderOrderMapping_ ---
{
  const columnMap = context.CONFIG.BQ_COLUMN_MAP;
  // 正常情況：標題列跟系統預期同樣的欄位「順序」
  const sameOrderHeader = columnMap.map(function (m) { return m.cn; });
  const fields1 = context.resolveHeaderOrderMapping_(sameOrderHeader, columnMap);
  assert.strictEqual(fields1.length, columnMap.length);
  assert.strictEqual(fields1[0].name, columnMap[0].bq);
  assert.strictEqual(fields1[0].type, 'STRING');
  console.log('Test resolveHeaderOrderMapping_ (same order) passed.');

  // 欄位順序被打亂（例如某個匯出工具欄位順序不同）：股票代號排第一，日期排第二
  const shuffled = columnMap.slice();
  const tmp = shuffled[0]; shuffled[0] = shuffled[1]; shuffled[1] = tmp;
  const shuffledHeader = shuffled.map(function (m) { return m.cn; });
  const fields2 = context.resolveHeaderOrderMapping_(shuffledHeader, columnMap);
  assert.strictEqual(fields2[0].name, columnMap[1].bq); // 第一欄現在是「證券代號」
  assert.strictEqual(fields2[1].name, columnMap[0].bq); // 第二欄現在是「日期」
  console.log('Test resolveHeaderOrderMapping_ (shuffled order still resolves correctly) passed.');

  // 開頭帶 BOM 的標題列也要能正確比對（忽略 BOM／前後空白再比對）
  const withBomHeader = columnMap.map(function (m, i) { return i === 0 ? '﻿' + m.cn : m.cn; });
  const fields3 = context.resolveHeaderOrderMapping_(withBomHeader, columnMap);
  assert.strictEqual(fields3[0].name, columnMap[0].bq);
  console.log('Test resolveHeaderOrderMapping_ (BOM-prefixed header) passed.');

  // 缺欄位、或有認不出來的欄位，都要丟出看得懂的錯誤
  const missingHeader = columnMap.slice(1).map(function (m) { return m.cn; });
  assert.throws(function () { context.resolveHeaderOrderMapping_(missingHeader, columnMap); }, /日期/);
  const unrecognizedHeader = columnMap.map(function (m) { return m.cn; });
  unrecognizedHeader[0] = '不知道是什麼的欄位';
  assert.throws(function () { context.resolveHeaderOrderMapping_(unrecognizedHeader, columnMap); }, /不知道是什麼的欄位/);
  console.log('Test resolveHeaderOrderMapping_ (missing/unrecognized column throws clear error) passed.');
}

// --- groupFileIdsByHeaderRow_ ---
{
  const headerA = ['日期', '證券代號'];
  const headerB = ['證券代號', '日期'];
  const pairs = [
    { fileId: 'f1', headerRow: headerA },
    { fileId: 'f2', headerRow: headerB },
    { fileId: 'f3', headerRow: headerA }
  ];
  const groups = context.groupFileIdsByHeaderRow_(pairs);
  assert.strictEqual(groups.length, 2);
  assert.deepStrictEqual(Object.assign([], groups[0].fileIds), ['f1', 'f3']);
  assert.deepStrictEqual(Object.assign([], groups[1].fileIds), ['f2']);
  console.log('Test groupFileIdsByHeaderRow_ passed.');
}

// --- buildMaterializeSql_ ---
{
  const sql = context.buildMaterializeSql_(['proj.ds.history_external_autodetect_g0', 'proj.ds.history_external_autodetect_g1'], 'proj.ds.history_materialized');
  assert.ok(sql.indexOf('CREATE OR REPLACE TABLE `proj.ds.history_materialized`') === 0);
  assert.ok(sql.indexOf('FROM `proj.ds.history_external_autodetect_g0`') !== -1);
  assert.ok(sql.indexOf('FROM `proj.ds.history_external_autodetect_g1`') !== -1);
  assert.ok(sql.indexOf('UNION ALL') !== -1);
  // 每組都是用我們自己的 ascii 欄名（date_str, stock_id...），不是中文欄名
  assert.ok(sql.indexOf('SELECT date_str,') !== -1 || sql.indexOf('SELECT date_str, stock_id') !== -1);
  // 去重邏輯
  assert.ok(sql.indexOf('PARTITION BY stock_id, date_str') !== -1);
  assert.ok(sql.indexOf('WHERE rn = 1') !== -1);
  console.log('Test buildMaterializeSql_ passed.');
}

// --- buildDedupedViewSql_ ---
{
  const sql = context.buildDedupedViewSql_('proj.ds.history_external', 'proj.ds.history_deduped');
  assert.ok(sql.indexOf('CREATE OR REPLACE VIEW `proj.ds.history_deduped`') === 0);
  assert.ok(sql.indexOf('FROM `proj.ds.history_external`') !== -1);
  assert.ok(sql.indexOf('PARTITION BY stock_id, date_str') !== -1);
  assert.ok(sql.indexOf('WHERE rn = 1') !== -1);
  console.log('Test buildDedupedViewSql_ passed.');
}

// --- buildHistoryRangeQuerySql_ ---
{
  const both = context.buildHistoryRangeQuerySql_('proj.ds.history_deduped', '2026-01-01', '2026-07-31');
  assert.ok(both.indexOf('FROM `proj.ds.history_deduped`') !== -1);
  assert.ok(both.indexOf("date_str >= '2026-01-01'") !== -1);
  assert.ok(both.indexOf("date_str <= '2026-07-31'") !== -1);
  assert.ok(both.indexOf('AND') !== -1);

  const noRange = context.buildHistoryRangeQuerySql_('proj.ds.history_deduped', null, null);
  assert.ok(noRange.indexOf('WHERE') === -1);

  const startOnly = context.buildHistoryRangeQuerySql_('proj.ds.history_deduped', '2026-01-01', null);
  assert.ok(startOnly.indexOf("date_str >= '2026-01-01'") !== -1);
  assert.ok(startOnly.indexOf('date_str <=') === -1);
  console.log('Test buildHistoryRangeQuerySql_ passed.');
}

// --- buildDateBoundsSql_ ---
{
  const sql = context.buildDateBoundsSql_('proj.ds.history_deduped');
  assert.ok(sql.indexOf('MIN(date_str) AS min_date') !== -1);
  assert.ok(sql.indexOf('MAX(date_str) AS max_date') !== -1);
  assert.ok(sql.indexOf('FROM `proj.ds.history_deduped`') !== -1);
  console.log('Test buildDateBoundsSql_ passed.');
}

// --- mapBqRowToHistoryRow_ ---
{
  const bqRow = { date_str: '2026-07-30', stock_id: '2330', stock_name: '台積電', close_price: '1000.5', foreign_net: '1234' };
  const row = context.mapBqRowToHistoryRow_(bqRow);
  assert.strictEqual(row['日期'], '2026-07-30');
  assert.strictEqual(row['證券代號'], '2330');
  assert.strictEqual(row['證券名稱'], '台積電');
  assert.strictEqual(row['收盤價'], 1000.5); // 數值欄位轉成 number
  assert.strictEqual(row['外資'], 1234);
  // 完整欄位數要跟 HISTORY_COLUMNS 一致
  assert.strictEqual(Object.keys(row).length, context.CONFIG.HISTORY_COLUMNS.length);
  console.log('Test mapBqRowToHistoryRow_ passed.');
}

// --- computeWeightedFactorScore_ / computePredictedFactorScores_ ---
{
  const row = { Inst_Participation: 0.1, IBF_20D: 0.5, Trend_Score: 2, BIAS_60: null };
  const weights = { inst_participation: 2, ibf_20d: 1 };
  // 0.1*2 + 0.5*1 = 0.7
  const score = context.computeWeightedFactorScore_(row, weights);
  assert.ok(Math.abs(score - 0.7) < 1e-9);
  console.log('Test computeWeightedFactorScore_ (basic weighted sum) passed.');

  // 缺任何一項因子值就回傳 null，不給誤導性的部分預測值
  const weightsNeedingMissing = { inst_participation: 2, bias60: 1 };
  assert.strictEqual(context.computeWeightedFactorScore_(row, weightsNeedingMissing), null);
  console.log('Test computeWeightedFactorScore_ (missing factor -> null) passed.');

  assert.strictEqual(context.computeWeightedFactorScore_(row, null), null);
  console.log('Test computeWeightedFactorScore_ (no weights -> null) passed.');

  const predicted = context.computePredictedFactorScores_(row, { return1m: { weights: weights } });
  assert.ok(Math.abs(predicted.predictedReturn1M - 0.7) < 1e-9);
  assert.strictEqual(predicted.predictedDownsideResistance, null);
  console.log('Test computePredictedFactorScores_ passed.');

  const predictedNoModels = context.computePredictedFactorScores_(row, {});
  assert.strictEqual(predictedNoModels.predictedReturn1M, null);
  assert.strictEqual(predictedNoModels.predictedDownsideResistance, null);
  console.log('Test computePredictedFactorScores_ (no applied models) passed.');
}

// --- buildLatestDayFactorsSql_：今日戰報 BigQuery 模式的核心 SQL，逐項核對關鍵語意有沒有漏掉 ---
{
  const sql = context.buildLatestDayFactorsSql_('proj.ds.history_materialized', '2026-03-01');
  assert.ok(sql.indexOf("FROM `proj.ds.history_materialized`") !== -1);
  assert.ok(sql.indexOf("date_str >= '2026-03-01'") !== -1, '要用 cutoff 限制範圍，不然 expanding max 會變成全部歷史以來');
  assert.ok(sql.indexOf('LENGTH(stock_id) = 4') !== -1);

  // 「最新一天是哪一天」要從沒有 stock_id 格式篩選的 bounds CTE 決定，只在 cutoff 之後
  // 加條件；如果連 LENGTH(stock_id)=4 都篩了才找 MAX(dt)，遇到最新幾天大部分 stock_id
  // 格式跑掉時會悄悄退回還有乾淨資料的舊日期，使用者會看到戰報停在很久以前的日期，
  // 卻不知道資料庫其實已經有更新的資料。
  const boundsSection = sql.slice(sql.indexOf('bounds AS ('), sql.indexOf('base AS ('));
  assert.ok(boundsSection.indexOf('MAX(SAFE_CAST(date_str AS DATE)) AS latest_dt') !== -1);
  assert.ok(boundsSection.indexOf("date_str >= '2026-03-01'") !== -1);
  assert.ok(boundsSection.indexOf('LENGTH(stock_id)') === -1, 'bounds 不能篩 stock_id 格式，不然「最新一天」的判斷會被污染資料誤導');

  // rolling window 大小要對：MA20/Vol_MA20/IBF20 用 19 PRECEDING，MA60 用 59 PRECEDING，Inst_Part_MA5 用 4 PRECEDING
  assert.ok(sql.indexOf('ROWS BETWEEN 19 PRECEDING AND CURRENT ROW') !== -1);
  assert.ok(sql.indexOf('ROWS BETWEEN 59 PRECEDING AND CURRENT ROW') !== -1);
  assert.ok(sql.indexOf('ROWS BETWEEN 4 PRECEDING AND CURRENT ROW') !== -1);

  // 每個 rolling 平均/加總都要有「視窗滿不滿」的 IF 保護，不能直接依賴 BigQuery AVG()/SUM() 的預設行為
  // （那樣視窗不足時會用部分資料算出非 null 結果，跟 Utils.gs rollingApply 的語意不符）
  assert.ok(sql.indexOf('IF(cnt20 = 20, ma20_raw, NULL)') !== -1);
  assert.ok(sql.indexOf('IF(cnt60 = 60, ma60_raw, NULL)') !== -1);
  assert.ok(sql.indexOf('IF(cnt20 = 20, vol_ma20_raw, NULL)') !== -1);
  assert.ok(sql.indexOf('IF(cnt5 = 5 AND cnt5_nonnull = 5, inst_part_ma5_raw, NULL)') !== -1);
  assert.ok(sql.indexOf('IF(cnt20b = 20, drop_count_20_raw, NULL)') !== -1);
  assert.ok(sql.indexOf('IF(cnt20b = 20, buy_on_drop_20_raw, NULL)') !== -1);

  // IBF_20D 沒有足夠視窗時要 fillna(0)，不是留 null
  assert.ok(sql.indexOf('WHEN drop_count_20 IS NULL OR drop_count_20 = 0 THEN 0') !== -1);

  // 只取最新一天，不是整段回看範圍都回傳
  assert.ok(sql.indexOf('WHERE dt = (SELECT latest_dt FROM bounds)') !== -1);
  // 「最新一天」要用完全沒有 stock_id 格式篩選的 bounds 決定，不能用「已經濾掉髒資料的
  // step5」自己的 MAX(dt)——不然如果最新幾天剛好大部分 stock_id 格式跑掉，會悄悄退回
  // 舊的乾淨日期，使用者完全看不出資料庫其實有更新的資料。
  assert.ok(sql.indexOf('MAX(dt) FROM step5') === -1, '不能再用濾過的 step5 自己決定最新日期');
  assert.ok(sql.indexOf('bounds AS (') !== -1);
  assert.ok(sql.indexOf('MAX(SAFE_CAST(date_str AS DATE)) AS latest_dt') !== -1);
  assert.ok(sql.indexOf('FROM `proj.ds.history_materialized`') !== -1, 'bounds 也要查同一個 sourceRef');

  // percentRank 是「平均名次 / 非 null 筆數」，不是 BigQuery 內建 PERCENT_RANK()
  assert.ok(sql.indexOf('PERCENT_RANK()') === -1, '不能用 BigQuery 內建 PERCENT_RANK()，公式跟 pandas rank(pct=True) 不一樣');
  assert.ok(sql.indexOf('RANK() OVER (ORDER BY inst_part_ma5 ASC NULLS LAST)') !== -1);
  assert.ok(sql.indexOf('RANK() OVER (ORDER BY ibf_20d ASC NULLS LAST)') !== -1);
  assert.ok(sql.indexOf('RANK() OVER (ORDER BY vol_ratio ASC NULLS LAST)') !== -1);

  // 同分筆數不能用 PARTITION BY 一個 FLOAT64 欄位算——BigQuery 實測會直接報錯
  // "Partitioning by expressions of type FLOAT64 is not allowed"，只能用 RANGE BETWEEN
  // CURRENT ROW AND CURRENT ROW 這個 BigQuery 允許的同分（peer group）寫法。
  assert.ok(sql.indexOf('PARTITION BY inst_part_ma5') === -1, 'FLOAT64 欄位不能當 PARTITION BY 鍵，BigQuery 會報錯');
  assert.ok(sql.indexOf('PARTITION BY ibf_20d') === -1);
  assert.ok(sql.indexOf('PARTITION BY vol_ratio') === -1);
  assert.ok(sql.indexOf('RANGE BETWEEN CURRENT ROW AND CURRENT ROW') !== -1);
  // RANGE frame 的 ORDER BY 不能加 NULLS LAST（BigQuery 實測會報「NULLS LAST not supported
  // with ascending sort order in RANGE clauses」），RANK() 不是 RANGE frame 不受此限、要保留。
  assert.ok(sql.indexOf('ASC NULLS LAST RANGE BETWEEN') === -1, 'RANGE frame 前面不能有 NULLS LAST');
  assert.ok(sql.indexOf('ASC RANGE BETWEEN CURRENT ROW AND CURRENT ROW') !== -1, 'RANGE frame 的 ORDER BY 要用預設 null 排序');

  // Armor_Score 權重要對：法人參與度 45 + IBF 30 + 量能 15 + Trend_Score*10，任何一項 null 就整體 null
  assert.ok(sql.indexOf('inst_part_rank * 45 + ibf_20d_rank * 30 + vol_ratio_rank * 15 + trend_score * 10') !== -1);
  assert.ok(sql.indexOf('WHEN inst_part_rank IS NULL OR ibf_20d_rank IS NULL OR vol_ratio_rank IS NULL THEN NULL') !== -1);

  // 原始欄位（IFNULL 預設 0，對應 toNumber 的行為，不能讓 SAFE_CAST 的 null 到處亂傳）都要出現
  context.CONFIG.BQ_COLUMN_MAP.forEach(function (m) {
    if (m.bq === 'date_str' || m.bq === 'stock_id' || m.bq === 'stock_name') return;
    assert.ok(sql.indexOf(m.bq) !== -1, 'missing raw column: ' + m.bq);
  });
  console.log('Test buildLatestDayFactorsSql_ passed.');
}

// --- mapBqLatestFactorRowToAnalysisRow_：ascii 結果列轉回中文欄名，null 要原樣保留、數字要轉型 ---
{
  const bqRow = {
    date_str: '2026-07-21', stock_id: '2330', stock_name: ' 台積電 ',
    foreign_net: '1000', trust_net: '-500', dealer_net: '0', inst_net_shares: '500',
    volume_shares: '20000000', trade_count: '9000', turnover: '3000000000',
    open_price: '600', high_price: '610', low_price: '595', close_price: '605',
    change_sign: '+', change_amount: '5', bid_price: '604', bid_vol: '10', ask_price: '605.5', ask_vol: '8',
    dividend_yield: '1.8', pe_ratio: '22.3', pb_ratio: '6.1', fin_report_period: '115/1',
    inst_net: '500', inst_participation: '0.025', inst_part_ma5: null, daily_return: '0.01',
    is_drop: '0', is_inst_buy_on_drop: '0', ibf_20d: '0', ma20: null, ma20_slope: null,
    trend_score: '1', vol_ma20: null, vol_ratio: null, ma60: null, bias60: null,
    adjusted_peak_generic: '620', inst_part_rank: null, ibf_20d_rank: '0.4', vol_ratio_rank: null,
    armor_score: null
  };
  const row = context.mapBqLatestFactorRowToAnalysisRow_(bqRow);

  assert.strictEqual(row['日期'], '2026-07-21');
  assert.strictEqual(row['證券代號'], '2330');
  assert.strictEqual(row['證券名稱'], '台積電');
  assert.strictEqual(row['成交金額'], 3000000000);
  assert.strictEqual(row['收盤價'], 605);
  assert.strictEqual(row.Inst_Net, 500);
  assert.ok(Math.abs(row.Inst_Participation - 0.025) < 1e-9);
  assert.strictEqual(row.Inst_Part_MA5, null, '視窗不足應該維持 null，不要被轉型成 0');
  assert.strictEqual(row.Inst_Part_Rank, null);
  assert.ok(Math.abs(row.IBF_20D_Rank - 0.4) < 1e-9);
  assert.strictEqual(row.Trend_Score, 1);
  assert.strictEqual(row.Armor_Score, null);
  assert.strictEqual(row.Adjusted_Peak, 620);
  console.log('Test mapBqLatestFactorRowToAnalysisRow_ passed.');
}

// --- buildHistoryRowsForStocksSql_：持股「從買進日起算最高價」用的小範圍查詢 ---
{
  const sql = context.buildHistoryRowsForStocksSql_('proj.ds.history_deduped', ['2330', '2603'], '2026-01-15');
  assert.ok(sql.indexOf("FROM `proj.ds.history_deduped`") !== -1);
  assert.ok(sql.indexOf("stock_id IN ('2330', '2603')") !== -1);
  assert.ok(sql.indexOf("date_str >= '2026-01-15'") !== -1);

  const sqlNoStart = context.buildHistoryRowsForStocksSql_('proj.ds.history_deduped', ['2330'], null);
  assert.ok(sqlNoStart.indexOf('date_str >=') === -1, '沒有 startStr 就不該加這個條件');
  console.log('Test buildHistoryRowsForStocksSql_ passed.');
}

// --- buildStockIdQualitySql_ / mapStockIdQualityRows_：股票代號格式診斷 ---
{
  const sql = context.buildStockIdQualitySql_('proj.ds.history_materialized');
  assert.ok(sql.indexOf("FROM `proj.ds.history_materialized`") !== -1);
  assert.ok(sql.indexOf("'length' AS kind") !== -1);
  assert.ok(sql.indexOf("'top' AS kind") !== -1);
  assert.ok(sql.indexOf("'rare' AS kind") !== -1);
  assert.ok(sql.indexOf('GROUP BY LENGTH(stock_id)') !== -1);
  assert.ok(sql.indexOf('ORDER BY cnt DESC LIMIT 20') !== -1);
  assert.ok(sql.indexOf('ORDER BY cnt ASC LIMIT 20') !== -1);
  // GROUP BY 鍵不能在 SELECT 清單裡直接包一層函式（BigQuery 實測會報
  // "references column stock_id which is neither grouped nor aggregated"），
  // 一定要先在子查詢裡 GROUP BY 完，外層才能對已經分組好的結果做 CAST。
  assert.ok(sql.indexOf('CAST(LENGTH(stock_id)') === -1, 'GROUP BY 鍵不能在 SELECT 清單裡直接包一層函式');
  assert.ok(sql.indexOf('SELECT LENGTH(stock_id) AS len') !== -1, '要先在子查詢裡單純 GROUP BY LENGTH(stock_id)');
  assert.ok(sql.indexOf('CAST(len AS STRING)') !== -1, '外層對已分組完的結果自由 CAST 才安全');
  console.log('Test buildStockIdQualitySql_ passed.');

  const rawRows = [
    { kind: 'length', key: '4', cnt: '1900000', distinct_ids: '1800' },
    { kind: 'length', key: '7', cnt: '73715', distinct_ids: '52305' },
    { kind: 'top', key: '2330', cnt: '129' },
    { kind: 'top', key: '2603', cnt: '129' },
    { kind: 'rare', key: '2330\r', cnt: '1' },
    { kind: 'rare', key: ' 2330', cnt: '2' }
  ];
  const parsed = context.mapStockIdQualityRows_(rawRows);
  assert.strictEqual(parsed.byLength.length, 2);
  assert.strictEqual(parsed.byLength[0].length, 4, '筆數最多的長度該排第一');
  assert.strictEqual(parsed.byLength[0].distinctIds, 1800);
  assert.strictEqual(parsed.topStocks.length, 2);
  assert.strictEqual(parsed.topStocks[0].stockId, '2330');
  assert.strictEqual(parsed.rareStocks.length, 2);
  assert.strictEqual(parsed.rareStocks[0].stockId, '2330\r');
  console.log('Test mapStockIdQualityRows_ passed.');
}

console.log('All FactorRegression/BigQuerySync pure-function tests passed.');
