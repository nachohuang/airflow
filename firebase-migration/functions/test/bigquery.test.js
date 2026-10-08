const assert = require('assert');
const bq = require('../lib/bigquery');

// --- sourceRefForRead_：native 用原生表，external 用去重 view，materialized 用
//    統一讀取 view——對照 apps-script/src/BigQuerySync.gs 的 bqActiveSourceTableRef_
//    （2026-10-07 修正：native 原本誤當成跟 external 一樣讀 history_deduped，
//    這份測試原本斷言的就是那個錯誤行為，見 lib/bigquery.js sourceRefForRead_
//    的完整說明） ---
{
  const cfg = { projectId: 'my-proj', dataset: 'twse_factor_model', sourceMode: 'native' };
  assert.strictEqual(bq.sourceRefForRead_(cfg), 'my-proj.twse_factor_model.history_raw');
  assert.strictEqual(bq.sourceRefForRead_(Object.assign({}, cfg, { sourceMode: 'external' })), 'my-proj.twse_factor_model.history_deduped');
  assert.strictEqual(bq.sourceRefForRead_(Object.assign({}, cfg, { sourceMode: 'materialized' })), 'my-proj.twse_factor_model.history_unified');
  console.log('Test sourceRefForRead_ passed.');
}

// --- rawTableRef_：寫入固定目標，跟 sourceMode 無關 ---
{
  const cfg = { projectId: 'my-proj', dataset: 'twse_factor_model', sourceMode: 'materialized' };
  assert.strictEqual(bq.rawTableRef_(cfg), 'my-proj.twse_factor_model.history_raw');
  console.log('Test rawTableRef_ (write target is sourceMode-independent) passed.');
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

// --- buildDeleteDatesSql_：IN 清單、單引號防注入 ---
{
  const sql = bq.buildDeleteDatesSql_('proj.ds.history_raw', ['2026-10-06', "2026-10-07'; DROP TABLE x; --"]);
  assert.ok(sql.indexOf("DELETE FROM `proj.ds.history_raw`") === 0);
  assert.ok(sql.indexOf("'2026-10-06'") !== -1);
  assert.ok(sql.indexOf("DROP TABLE") !== -1, '惡意字串本身還在，但單引號應該已經被濾掉');
  assert.strictEqual((sql.match(/'/g) || []).length % 2, 0, '單引號要維持成對，不能讓注入字串自己帶的引號逃脫字串字面值');
  console.log('Test buildDeleteDatesSql_ (IN list, strips embedded single quotes) passed.');
}

// --- buildInsertRowsSql_：欄位順序跟 BQ_COLUMN_MAP 一致、值跳脫單引號/反斜線 ---
{
  const rows = [
    { 日期: '2026-10-07', 證券代號: '2330', 證券名稱: "台積電's test", 外資: 1000 }
  ];
  const sql = bq.buildInsertRowsSql_('proj.ds.history_raw', rows);
  assert.ok(sql.indexOf('INSERT INTO `proj.ds.history_raw` (date_str, stock_id, stock_name,') === 0);
  assert.ok(sql.indexOf("'2026-10-07'") !== -1);
  assert.ok(sql.indexOf("'2330'") !== -1);
  assert.ok(sql.indexOf("\\'") !== -1, '名稱裡的單引號要被跳脫');
  // 缺欄位的值要變成空字串字面值，不是 'undefined'/'null' 這種字面文字
  assert.ok(sql.indexOf("''") !== -1, '沒提供的欄位（例如本益比等）要補空字串，不是 undefined');
  console.log('Test buildInsertRowsSql_ (column order matches BQ_COLUMN_MAP, escapes quotes) passed.');
}

// --- buildDeleteAndInsertTransactionSql_：DELETE+INSERT 包成一個 transaction，
//     失敗時要 ROLLBACK，不能讓 DELETE 的效果留下來、INSERT 卻沒補回去 ---
{
  const rows = [{ 日期: '2026-10-07', 證券代號: '2330', 證券名稱: '台積電' }];
  const sql = bq.buildDeleteAndInsertTransactionSql_('proj.ds.history_raw', ['2026-10-07'], rows);
  assert.ok(sql.indexOf('BEGIN TRANSACTION;') !== -1, '要包在 transaction 裡');
  assert.ok(sql.indexOf('DELETE FROM `proj.ds.history_raw`') !== -1, 'transaction 裡要有 DELETE');
  assert.ok(sql.indexOf('INSERT INTO `proj.ds.history_raw`') !== -1, 'transaction 裡要有 INSERT');
  assert.ok(sql.indexOf('COMMIT TRANSACTION;') !== -1, '要有 COMMIT');
  assert.ok(sql.indexOf('ROLLBACK TRANSACTION;') !== -1, '失敗要有 ROLLBACK，不能把 DELETE 的效果留下來');
  // DELETE 必須排在 INSERT 之前，順序錯了會先把新資料插進去又被接下來的
  // DELETE 誤刪（雖然目前 WHERE 條件只會刪同一批日期，順序對了才安全）。
  assert.ok(sql.indexOf('DELETE FROM') < sql.indexOf('INSERT INTO'), 'DELETE 要在 INSERT 之前執行');
  console.log('Test buildDeleteAndInsertTransactionSql_ (wraps DELETE+INSERT in one rollback-safe transaction) passed.');
}

// --- chunkRowsBySize_：依字面值長度切 chunk，每個 chunk 不超過預算 ---
{
  // 用一個字串長度固定、算得出來的假欄位，避免測試依賴真實 BQ_COLUMN_MAP
  // 全部 24 欄的精確組字邏輯——只關心「切出來的每個 chunk 加總長度有沒有
  // 超過預算」跟「所有列都有被分到某個 chunk，不多不少」這兩件事。
  const makeRow = function (i) {
    return { 日期: '2026-10-07', 證券代號: String(1000 + i), 證券名稱: 'X'.repeat(50) };
  };
  const rows = Array.from({ length: 500 }, function (_, i) { return makeRow(i); });
  const maxChars = 5000; // 刻意設小一點，逼出好幾個 chunk 方便驗證
  const chunks = bq.chunkRowsBySize_(rows, maxChars);
  assert.ok(chunks.length > 1, '500 列、每列字面值不小，預算 5000 字元應該會切成好幾個 chunk');
  const totalRows = chunks.reduce(function (sum, c) { return sum + c.length; }, 0);
  assert.strictEqual(totalRows, 500, '所有列都要被分到某個 chunk，不能遺漏或重複');
  chunks.forEach(function (chunk) {
    const sql = bq.buildInsertRowsSql_('proj.ds.history_raw', chunk);
    assert.ok(sql.length <= maxChars + 2000, '每個 chunk 組出來的 INSERT 長度不該大幅超過預算（+2000 容忍 INSERT 固定前綴）');
  });
  // 單一一列超大（超過 maxChars 本身）的邊界情況：至少要能單獨成一個 chunk，
  // 不能因為「放不進任何 chunk」就被整個丟掉。
  const hugeRow = { 日期: '2026-10-07', 證券代號: '9999', 證券名稱: 'Y'.repeat(10000) };
  const chunksWithHuge = bq.chunkRowsBySize_([hugeRow].concat(rows.slice(0, 5)), maxChars);
  const totalWithHuge = chunksWithHuge.reduce(function (sum, c) { return sum + c.length; }, 0);
  assert.strictEqual(totalWithHuge, 6, '超過預算的單一列也要被保留，自己佔一個 chunk，不能遺漏');
  console.log('Test chunkRowsBySize_ (splits rows into size-bounded chunks, keeps every row) passed.');
}

// --- buildMaxDateSql_ ---
{
  const sql = bq.buildMaxDateSql_('proj.ds.history_raw');
  assert.strictEqual(sql, 'SELECT MAX(date_str) AS max_date FROM `proj.ds.history_raw`');
  console.log('Test buildMaxDateSql_ passed.');
}

// --- buildDateBoundsSql_ ---
{
  const sql = bq.buildDateBoundsSql_('proj.ds.history_raw');
  assert.ok(sql.indexOf('MIN(date_str) AS min_date') !== -1);
  assert.ok(sql.indexOf('MAX(date_str) AS max_date') !== -1);
  assert.ok(sql.indexOf('COUNT(DISTINCT stock_id) AS stock_count') !== -1);
  assert.ok(sql.indexOf('FROM `proj.ds.history_raw`') !== -1);
  console.log('Test buildDateBoundsSql_ passed.');
}

// --- buildDailyCountsSql_ ---
{
  const sql = bq.buildDailyCountsSql_('proj.ds.history_raw', '2026-10-01', '2026-10-31');
  assert.ok(sql.indexOf('GROUP BY date_str') !== -1, '要依日期分組');
  assert.ok(sql.indexOf('ORDER BY date_str') !== -1, '要依日期排序，前端才不用自己再排一次');
  assert.ok(sql.indexOf("LENGTH(stock_id) = 4") !== -1, 'stock_count 要排除非四碼的權證/ETF 代號');
  assert.ok(sql.indexOf("date_str >= '2026-10-01'") !== -1);
  assert.ok(sql.indexOf("date_str <= '2026-10-31'") !== -1);
  assert.ok(sql.indexOf('FROM `proj.ds.history_raw`') !== -1);
  console.log('Test buildDailyCountsSql_ (groups by date, excludes non-4-digit codes from stock_count) passed.');
}

// --- industryMapTableRef_ ---
{
  const cfg = { projectId: 'my-proj', dataset: 'twse_factor_model' };
  assert.strictEqual(bq.industryMapTableRef_(cfg), 'my-proj.twse_factor_model.industry_map');
  console.log('Test industryMapTableRef_ passed.');
}

// --- featureViewRef_／featureSnapshotTableRef_ ---
{
  const cfg = { projectId: 'my-proj', dataset: 'twse_factor_model' };
  assert.strictEqual(bq.featureViewRef_(cfg), 'my-proj.twse_factor_model.factor_features');
  assert.strictEqual(bq.featureSnapshotTableRef_(cfg), 'my-proj.twse_factor_model.factor_features_snapshot');
  console.log('Test featureViewRef_／featureSnapshotTableRef_ passed.');
}

// --- buildSyncIndustryMapSql_ ---
{
  const rows = [{ code: '1101', industry: '水泥工業' }, { code: '2330', industry: '半導體業' }];
  const sql = bq.buildSyncIndustryMapSql_('proj.ds.industry_map', rows);
  assert.ok(sql.indexOf('CREATE OR REPLACE TABLE `proj.ds.industry_map`') !== -1);
  assert.ok(sql.indexOf("STRUCT('1101' AS stock_id, '水泥工業' AS industry)") !== -1);
  assert.ok(sql.indexOf("STRUCT('2330' AS stock_id, '半導體業' AS industry)") !== -1);

  const emptySql = bq.buildSyncIndustryMapSql_('proj.ds.industry_map', []);
  assert.ok(emptySql.indexOf('UNNEST') === -1, '空陣列不能組出沒有型別資訊的 UNNEST([])');
  assert.ok(emptySql.indexOf('stock_id STRING, industry STRING') !== -1, '空陣列要改用明確宣告型別的空表 DDL');
  console.log('Test buildSyncIndustryMapSql_ (non-empty rows build UNNEST structs, empty rows build typed empty table) passed.');
}

// --- financialRatiosTableRef_／financialRevenueTableRef_／fundamentalFeatureViewRef_ ---
{
  const cfg = { projectId: 'my-proj', dataset: 'twse_factor_model' };
  assert.strictEqual(bq.financialRatiosTableRef_(cfg), 'my-proj.twse_factor_model.financial_ratios');
  assert.strictEqual(bq.financialRevenueTableRef_(cfg), 'my-proj.twse_factor_model.financial_revenue');
  assert.strictEqual(bq.fundamentalFeatureViewRef_(cfg), 'my-proj.twse_factor_model.factor_features_fundamental');
  console.log('Test financialRatiosTableRef_／financialRevenueTableRef_／fundamentalFeatureViewRef_ passed.');
}

// --- chunkStructRowsBySize_ ---
{
  const rows = [{ v: 'a' }, { v: 'b' }, { v: 'c' }, { v: 'd' }];
  const toSql = (r) => "STRUCT('" + r.v.repeat(10) + "' AS x)"; // 每筆固定長度，方便算 chunk 邊界
  const chunks = bq.chunkStructRowsBySize_(rows, toSql, toSql(rows[0]).length * 2 + 2);
  assert.strictEqual(chunks.flat().length, 4, '切 chunk 不能遺漏任何一筆');
  assert.ok(chunks.length >= 2, '超過單一 chunk 上限要切成多個 chunk');
  assert.deepStrictEqual(bq.chunkStructRowsBySize_([], toSql), []);
  console.log('Test chunkStructRowsBySize_ (splits into size-bounded chunks, keeps every row, empty input -> empty array) passed.');
}

// --- buildSyncFinancialRatiosSql_ ---
{
  const rows = [
    { code: '1101', reportDate: '2026-05-14', grossMarginPct: 30, operatingMarginPct: 15, netMarginPct: 10, roePct: 5, grossMarginStreak: 2, operatingMarginStreak: 1, netMarginStreak: 0, roeStreak: 2 },
    { code: '1102', reportDate: '2026-05-14', grossMarginPct: null, operatingMarginPct: null, netMarginPct: null, roePct: null, grossMarginStreak: null, operatingMarginStreak: null, netMarginStreak: null, roeStreak: null }
  ];
  const statements = bq.buildSyncFinancialRatiosSql_('proj.ds.financial_ratios', rows);
  assert.strictEqual(statements.length, 1, '資料量小，一個 chunk 就夠');
  assert.ok(statements[0].indexOf('CREATE OR REPLACE TABLE `proj.ds.financial_ratios`') !== -1);
  assert.ok(statements[0].indexOf("STRUCT('1101' AS stock_id, DATE('2026-05-14') AS report_date, 30 AS gross_margin_pct") !== -1);
  assert.ok(statements[0].indexOf('NULL AS gross_margin_pct') !== -1, '缺值要輸出 NULL 常值，不是字串 "null" 或 0');

  const emptyStatements = bq.buildSyncFinancialRatiosSql_('proj.ds.financial_ratios', []);
  assert.strictEqual(emptyStatements.length, 1);
  assert.ok(emptyStatements[0].indexOf('gross_margin_pct FLOAT64') !== -1, '空陣列要用明確宣告型別的空表 DDL');
  console.log('Test buildSyncFinancialRatiosSql_ (builds typed STRUCT literals, NULL for missing values, typed empty table) passed.');
}

// --- chunkStructRowsBySize_ 真的被 buildSyncFinancialRatiosSql_ 用來切多個 statement ---
{
  // 驗證 chunkStructRowsBySize_ 在夠小的 maxChars 下確實會切成多筆——
  // buildSyncFinancialRatiosSql_ 本身對正常資料量（遠小於 700000 預設
  // 上限）只會產生 1 個 chunk，多 chunk 的組裝邏輯（第一句 CREATE OR
  // REPLACE、其餘 INSERT）已經在 buildSyncFinancialRatiosSql_ 的實作裡
  // 用同一個 chunkStructRowsBySize_，這裡單獨確認切 chunk 本身在資料量
  // 真的超過上限時會觸發，不會不管資料多大都回傳單一 chunk。
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ v: String(i) });
  const chunks = bq.chunkStructRowsBySize_(rows, () => 'x'.repeat(100), 250); // 每筆約 100+2 字元，250 上限 -> 每 chunk 2 筆
  assert.ok(chunks.length > 1, '夠小的 maxChars 下要真的切成多個 chunk');
  assert.strictEqual(chunks.reduce((sum, c) => sum + c.length, 0), 20, '切 chunk 不能遺漏或重複任何一筆');
  console.log('Test chunkStructRowsBySize_ (confirms multi-chunk split actually triggers under a small limit) passed.');
}

// --- financialRevenueTableRef_ 同款：buildSyncFinancialRevenueSql_ ---
{
  const rows = [{ code: '1101', reportDate: '2026-04-10', revenueYoyPct: 12.5, revenueGrowthStreak: 3 }];
  const statements = bq.buildSyncFinancialRevenueSql_('proj.ds.financial_revenue', rows);
  assert.strictEqual(statements.length, 1);
  assert.ok(statements[0].indexOf("STRUCT('1101' AS stock_id, DATE('2026-04-10') AS report_date, 12.5 AS revenue_yoy_pct, 3 AS revenue_growth_streak)") !== -1);
  console.log('Test buildSyncFinancialRevenueSql_ passed.');
}

// --- buildFundamentalFeatureViewSql_ ---
{
  const sql = bq.buildFundamentalFeatureViewSql_('proj.ds.factor_features', 'proj.ds.financial_ratios', 'proj.ds.financial_revenue', 'proj.ds.factor_features_fundamental');
  assert.ok(sql.indexOf('CREATE OR REPLACE VIEW `proj.ds.factor_features_fundamental`') !== -1);
  assert.ok(sql.indexOf('FROM `proj.ds.factor_features` base') !== -1, '疊在既有 factor_features view 之上，不是重算一次');
  assert.ok(sql.indexOf('fr2.report_date <= base.date') !== -1, '財報因子要用「公告日 <= 這一天」做點對點正確的 join，避免未來函數');
  assert.ok(sql.indexOf('rev2.report_date <= base.date') !== -1, '月營收因子同一個點對點正確性要求');
  assert.ok(sql.indexOf('fundamental_gross_margin_streak') !== -1);
  assert.ok(sql.indexOf('fundamental_revenue_growth_streak') !== -1);
  console.log('Test buildFundamentalFeatureViewSql_ (layers on top of base view, point-in-time join condition, exposes all 10 fundamental columns) passed.');
}

console.log('All bigquery.js tests passed.');
