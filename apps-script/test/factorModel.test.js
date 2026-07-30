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

console.log('All FactorRegression/BigQuerySync pure-function tests passed.');
