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

console.log('All FactorRegression/BigQuerySync pure-function tests passed.');
