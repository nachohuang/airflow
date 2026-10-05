const assert = require('assert');
const bq = require('../lib/bigquery');

// --- sourceRefForRead_：external/native 用去重 view，materialized 用統一讀取 view ---
{
  const cfg = { projectId: 'my-proj', dataset: 'twse_factor_model', sourceMode: 'native' };
  assert.strictEqual(bq.sourceRefForRead_(cfg), 'my-proj.twse_factor_model.history_deduped');
  assert.strictEqual(bq.sourceRefForRead_(Object.assign({}, cfg, { sourceMode: 'external' })), 'my-proj.twse_factor_model.history_deduped');
  assert.strictEqual(bq.sourceRefForRead_(Object.assign({}, cfg, { sourceMode: 'materialized' })), 'my-proj.twse_factor_model.history_unified');
  console.log('Test sourceRefForRead_ passed.');
}

// --- buildHistoryRangeSql_：日期區間條件、全部欄位都要有、沒帶 start/end 時不加 WHERE ---
{
  const sql = bq.buildHistoryRangeSql_('proj.ds.history_deduped', '2026-08-01', '2026-10-05');
  assert.ok(sql.indexOf('FROM `proj.ds.history_deduped`') !== -1);
  assert.ok(sql.indexOf("date_str >= '2026-08-01'") !== -1);
  assert.ok(sql.indexOf("date_str <= '2026-10-05'") !== -1);
  assert.ok(sql.indexOf('stock_id') !== -1, 'SQL 應該要選到 stock_id 這個欄位');
  assert.ok(sql.indexOf('close_price') !== -1, 'SQL 應該要選到 close_price 這個欄位');

  const sqlNoRange = bq.buildHistoryRangeSql_('proj.ds.history_deduped', null, null);
  assert.ok(sqlNoRange.indexOf('WHERE') === -1, '沒帶日期區間就不該有 WHERE 子句');
  console.log('Test buildHistoryRangeSql_ passed.');
}

// --- mapBqRowToHistoryRow_：數值欄位轉 number，字串欄位保留字串，缺欄位用空字串 ---
{
  const bqRow = {
    date_str: '2026-08-21', stock_id: '2330', stock_name: '台積電',
    foreign_net: '50000', trust_net: '100000', dealer_net: '0', inst_net_shares: '150000',
    volume_shares: '5000000', trade_count: '10000', turnover: '100000000',
    open_price: '20.5', high_price: '21', low_price: '20', close_price: '20.8',
    change_sign: '+', change_amount: '0.3',
    bid_price: '20.7', bid_vol: '100', ask_price: '20.9', ask_vol: '100',
    dividend_yield: '2.0', pe_ratio: '15', pb_ratio: '3', fin_report_period: '2026Q1'
  };
  const row = bq.mapBqRowToHistoryRow_(bqRow);
  assert.strictEqual(row['日期'], '2026-08-21');
  assert.strictEqual(row['證券代號'], '2330');
  assert.strictEqual(row['收盤價'], 20.8);
  assert.strictEqual(typeof row['收盤價'], 'number');
  assert.strictEqual(row['財報年/季'], '2026Q1');
  assert.strictEqual(row['漲跌(+/-)'], '+');
  console.log('Test mapBqRowToHistoryRow_ (basic) passed.');
}

// --- mapBqRowToHistoryRow_：缺欄位/null 的數值欄位要變成 0，不是 NaN ---
{
  const row = bq.mapBqRowToHistoryRow_({ date_str: '2026-08-21', stock_id: '2330' });
  assert.strictEqual(row['收盤價'], 0, '缺欄位的數值欄位要是 0，不能是 NaN');
  assert.strictEqual(row['證券名稱'], '', '缺欄位的字串欄位要是空字串，不能是 undefined');
  console.log('Test mapBqRowToHistoryRow_ (missing fields default safely) passed.');
}

console.log('All bigquery.js tests passed.');
