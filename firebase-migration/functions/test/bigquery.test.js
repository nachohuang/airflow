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

// --- buildHistoryRangeSql_：opts.stocksOnly 要加上 LENGTH(stock_id) = 4，排除
//    權證／ETF——這是實際遇過的真實事故的修正：全市場查詢沒加這條件，查回來的
//    150 萬筆裡有 140 萬筆是 6 碼權證代號，全部撈進記憶體才在 computeFactors_
//    內部的篩選生效之前就把 Cloud Function 的記憶體耗盡。跟
//    apps-script/src/BigQuerySync.gs 的 buildLatestDayFactorsSql_ 是同一條
//    既有規則，不是臨時發明的 workaround ---
{
  const sql = bq.buildHistoryRangeSql_('proj.ds.history_unified', '2026-05-08', null, { stocksOnly: true });
  assert.ok(sql.indexOf('LENGTH(stock_id) = 4') !== -1, 'stocksOnly 應該加上 LENGTH(stock_id) = 4 條件');
  assert.ok(sql.indexOf("date_str >= '2026-05-08'") !== -1, '日期條件要跟 stocksOnly 條件一起用 AND 組合');

  const sqlWithoutFlag = bq.buildHistoryRangeSql_('proj.ds.history_unified', '2026-05-08', null);
  assert.ok(sqlWithoutFlag.indexOf('LENGTH(stock_id)') === -1, '沒帶 stocksOnly 就不該有這個條件（查詢個股分析/回測不該被這條件限制）');
  console.log('Test buildHistoryRangeSql_ (stocksOnly option excludes warrants/ETFs) passed.');
}

// --- buildHistoryRowsForCodesSql_：只查指定代號（IN 子句），startStr 選填，
//    代號字串裡的單引號要被濾掉（基本的 SQL injection 防護，跟
//    apps-script/src/BigQuerySync.gs 的 buildHistoryRowsForStocksSql_ 同一套規則）---
{
  const sql = bq.buildHistoryRowsForCodesSql_('proj.ds.history_unified', ['2330', '1101'], '2026-09-25');
  assert.ok(sql.indexOf("FROM `proj.ds.history_unified`") !== -1);
  assert.ok(sql.indexOf("stock_id IN ('2330', '1101')") !== -1, '應該用 IN 子句只查這幾檔代號');
  assert.ok(sql.indexOf("date_str >= '2026-09-25'") !== -1);
  assert.ok(sql.indexOf('LENGTH(stock_id)') === -1, '只查指定代號不需要 stocksOnly 的全市場過濾條件');

  const sqlNoStart = bq.buildHistoryRowsForCodesSql_('proj.ds.history_unified', ['2330']);
  assert.ok(sqlNoStart.indexOf('date_str >=') === -1, '沒帶 startStr 就不該有日期條件');

  const sqlInjection = bq.buildHistoryRowsForCodesSql_('proj.ds.history_unified', ["2330'; DROP TABLE x; --"]);
  assert.ok(sqlInjection.indexOf("stock_id IN ('2330; DROP TABLE x; --')") !== -1,
    '代號字串裡的單引號要被濾掉，不會提前結束字串字面值造成 SQL injection');
  console.log('Test buildHistoryRowsForCodesSql_ (IN clause, optional startStr, quote stripping) passed.');
}

// --- buildStockSearchSql_：只選 3 欄（計費考量）、LIKE 比對代號/名稱、濾掉
//    單引號跟 LIKE 萬用字元 ---
{
  const sql = bq.buildStockSearchSql_('proj.ds.history_unified', '台積電', '2026-09-01', 20);
  assert.ok(sql.indexOf('SELECT stock_id, stock_name, date_str FROM') !== -1, '只選搜尋需要的 3 欄，不要整組 24 欄（計費考量）');
  assert.ok(sql.indexOf("date_str >= '2026-09-01'") !== -1);
  assert.ok(sql.indexOf('LENGTH(stock_id) = 4') !== -1, '只搜一般股票，排除權證/ETF');
  assert.ok(sql.indexOf("stock_id LIKE '%台積電%'") !== -1 && sql.indexOf("stock_name LIKE '%台積電%'") !== -1);
  assert.ok(sql.indexOf('LIMIT 20') !== -1);

  const sqlNoLimit = bq.buildStockSearchSql_('proj.ds.history_unified', '2330', '2026-09-01');
  assert.ok(sqlNoLimit.indexOf('LIMIT 500') !== -1, '沒帶 limit 應該有預設值');

  const sqlInjection = bq.buildStockSearchSql_('proj.ds.history_unified', "%'; DROP TABLE x; --", '2026-09-01');
  assert.ok(sqlInjection.indexOf("LIKE '%; DROP TABLE x; --%'") !== -1,
    '搜尋字串裡的單引號跟 % _ 萬用字元都要被濾掉，剩下的字串只會變成 LIKE 比對的一部分，不會提前結束字串字面值');
  console.log('Test buildStockSearchSql_ (3-column select, LIKE match, quote/wildcard stripping) passed.');
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

// --- mapBqRowToHistoryRow_：stock_id 清洗後不合法（實測真實遇過的 OOM 事故成因：
//    4.9 萬個相異代號，正常應該只有一千多到兩千）要回傳 null，整列捨棄 ---
{
  assert.strictEqual(bq.mapBqRowToHistoryRow_({ date_str: 'x', stock_id: '12' }), null, '少於 4 碼要捨棄');
  assert.strictEqual(bq.mapBqRowToHistoryRow_({ date_str: 'x', stock_id: '1234567' }), null, '超過 6 碼要捨棄');
  assert.strictEqual(bq.mapBqRowToHistoryRow_({ date_str: 'x', stock_id: '' }), null, '空字串要捨棄');
  assert.strictEqual(bq.mapBqRowToHistoryRow_({ date_str: 'x', stock_id: null }), null, 'null 要捨棄');
  console.log('Test mapBqRowToHistoryRow_ (invalid stock_id -> null, row discarded) passed.');
}

// --- mapBqRowToHistoryRow_：stock_id 格式怪但清洗後是同一檔股票，要正確還原成
//    乾淨的代號，不能把格式變體當成另一檔股票 ---
{
  const row1 = bq.mapBqRowToHistoryRow_({ date_str: 'x', stock_id: '2330.0' });
  assert.strictEqual(row1['證券代號'], '2330', 'Excel/Sheets 數字尾巴 .0 要清掉');
  const row2 = bq.mapBqRowToHistoryRow_({ date_str: 'x', stock_id: ' 2330 ' });
  assert.strictEqual(row2['證券代號'], '2330', '前後空白要清掉');
  const row3 = bq.mapBqRowToHistoryRow_({ date_str: 'x', stock_id: '00635u' });
  assert.strictEqual(row3['證券代號'], '00635U', 'ETF 代號要統一轉大寫，跟乾淨格式的同一檔股票合併');
  console.log('Test mapBqRowToHistoryRow_ (dirty-but-valid stock_id variants normalize to the same code) passed.');
}

console.log('All bigquery.js tests passed.');
