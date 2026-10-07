/**
 * bigquery.js
 * 查詢 History（股價/籌碼時序資料，Phase 2 的結論是這張表留在 BigQuery、不搬進
 * Firestore，見 firebase-migration/README.md「每天累積的股價及市場資料在哪裡
 * 遷移」的說明）需要的純函式：組 SQL 字串、把查詢回來的 ascii 欄名列轉回
 * computeFactors_ 期待的中文欄名列。從 apps-script/src/BigQuerySync.gs 複製，
 * 只複製純函式，不含實際呼叫 BigQuery API 的部分（那段需要 @google-cloud/bigquery
 * client，由呼叫這個模組的 Cloud Function 自己處理）。
 *
 * 複製時機：2026-10-05，對照 apps-script/src/BigQuerySync.gs 當時的內容。
 */
var config = require('./config');
var sanitizeStockId_ = require('./utils').sanitizeStockId_;

/** BigQuery 資料表的欄位順序（ascii），對應 CONFIG.BQ_COLUMN_MAP 的順序。 */
var BQ_COLUMN_MAP = [
  { cn: '日期', bq: 'date_str' },
  { cn: '證券代號', bq: 'stock_id' },
  { cn: '證券名稱', bq: 'stock_name' },
  { cn: '外資', bq: 'foreign_net' },
  { cn: '投信', bq: 'trust_net' },
  { cn: '自營商', bq: 'dealer_net' },
  { cn: '三大法人買賣超股數', bq: 'inst_net_shares' },
  { cn: '成交股數', bq: 'volume_shares' },
  { cn: '成交筆數', bq: 'trade_count' },
  { cn: '成交金額', bq: 'turnover' },
  { cn: '開盤價', bq: 'open_price' },
  { cn: '最高價', bq: 'high_price' },
  { cn: '最低價', bq: 'low_price' },
  { cn: '收盤價', bq: 'close_price' },
  { cn: '漲跌(+/-)', bq: 'change_sign' },
  { cn: '漲跌價差', bq: 'change_amount' },
  { cn: '最後揭示買價', bq: 'bid_price' },
  { cn: '最後揭示買量', bq: 'bid_vol' },
  { cn: '最後揭示賣價', bq: 'ask_price' },
  { cn: '最後揭示賣量', bq: 'ask_vol' },
  { cn: '殖利率(%)', bq: 'dividend_yield' },
  { cn: '本益比', bq: 'pe_ratio' },
  { cn: '股價淨值比', bq: 'pb_ratio' },
  { cn: '財報年/季', bq: 'fin_report_period' }
];

var RAW_TABLE = 'history_raw'; // sourceMode: native
var DEDUPED_VIEW = 'history_deduped'; // sourceMode: external
var UNIFIED_VIEW = 'history_unified'; // sourceMode: materialized

function bqColumnNames_() {
  return BQ_COLUMN_MAP.map(function (m) { return m.bq; });
}

/**
 * config/app 的 bigQuery 設定（projectId/dataset/sourceMode，Phase 2 已經遷移進
 * Firestore）→ 這次查詢要讀的來源表/view 的完整參照字串。跟
 * apps-script/src/BigQuerySync.gs 的 `bqActiveSourceTableRef_` 同一套規則：
 *   native       -> history_raw（每天直接寫入的原生表，本身就不會重複，不需要去重）
 *   external     -> history_deduped（外部資料表去重後的 view，即時讀 Drive）
 *   materialized -> history_unified（history_raw 每天直接寫入的新資料 UNION
 *                   history_materialized 那份從舊 Drive 大檔案整理進來的歷史基準）
 *
 * **2026-10-07 修正**：這支函式原本把 native 也當成 external 處理（兩者都讀
 * history_deduped），跟 apps-script 版的對照邏輯不一致——Firebase 版沒有
 * Drive 這條讀取路徑（見 README「每日股價資料抓取」那節），`history_deduped`
 * 只有「有在寫 Drive 外部資料表」才會更新；native 模式的每日新資料只會寫進
 * history_raw（見 `buildInsertRowsSql_`／`buildDeleteDatesSql_`），不會出現在
 * history_deduped 依賴的 history_external 裡，native 模式讀 history_deduped
 * 只會看到「開始用 BigQuery 之前最後一次寫 Drive」那個時間點就凍結的舊資料
 * ——這正是真實發生過的「戰報卡在很久以前的某一天不動」事故的根本原因，不是
 * 排程沒有在跑，是讀錯了來源表。
 */
function sourceRefForRead_(bigQueryConfig) {
  var view = bigQueryConfig.sourceMode === 'materialized' ? UNIFIED_VIEW
    : bigQueryConfig.sourceMode === 'external' ? DEDUPED_VIEW
      : RAW_TABLE;
  return bigQueryConfig.projectId + '.' + bigQueryConfig.dataset + '.' + view;
}

/** `history_raw` 的完整參照字串——每天／補抓直接寫入的原生表，跟
 *  `sourceRefForRead_` 可能因為 sourceMode 讀到別的 view/table 不同，寫入
 *  一律固定寫這張表（跟 apps-script 版 `upsertHistoryRowsToBigQuery_` 一致，
 *  不管 sourceMode 設什麼，新抓到的資料都是先進 history_raw，external／
 *  materialized 模式各自的 view 再從這裡或 Drive 間接看到）。 */
function rawTableRef_(bigQueryConfig) {
  return bigQueryConfig.projectId + '.' + bigQueryConfig.dataset + '.' + RAW_TABLE;
}

/**
 * 從來源 view 撈出指定日期區間（皆可留空）的原始欄位。
 *
 * opts.stocksOnly：true 時加上 `LENGTH(stock_id) = 4` 條件，只留一般股票，排除
 * 權證／ETF（6 碼權證代號，例如「正新國票58購01」這種券商發行、到期就換發新代號
 * 的衍生商品——台股市場流通中的權證代號有上萬張，遠超過一般股票的一千多到兩千檔，
 * 這套法人動能/量能篩選邏輯本來就不是設計給權證用的）。跟
 * apps-script/src/BigQuerySync.gs 的 `buildLatestDayFactorsSql_`／
 * apps-script/src/Analysis.gs 的 `computeFactors_`（`rows.filter(r =>
 * r['證券代號'].length === 4)`）是同一條既有規則——這裡刻意在 SQL 查詢階段就套用，
 * 不是等資料全部撈回 Node 之後才濾掉：全市場 + 全部權證一次查，實測有 150 萬筆
 * （其中 140 萬筆是權證），早一步在 SQL 擋掉可以省下這些資料的傳輸跟記憶體成本，
 * 不是等 computeFactors_ 內部的篩選才生效（那時資料已經整批撈進記憶體、逐欄位
 * 轉型過一輪了，為時已晚）。
 */
function buildHistoryRangeSql_(sourceRef, startStr, endStr, opts) {
  var cols = bqColumnNames_().join(', ');
  var conds = [];
  if (startStr) conds.push("date_str >= '" + startStr + "'");
  if (endStr) conds.push("date_str <= '" + endStr + "'");
  if (opts && opts.stocksOnly) conds.push('LENGTH(stock_id) = 4');
  var sql = 'SELECT ' + cols + ' FROM `' + sourceRef + '`';
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  return sql;
}

/**
 * 只查「指定幾檔股票」的原始歷史列——從
 * apps-script/src/BigQuerySync.gs 的 `buildHistoryRowsForStocksSql_` 複製，給
 * Watchlist／Portfolio 卡片要顯示的「最新收盤價」用：資料量小（只查呼叫端實際
 * 需要的幾檔代號，不是全市場），跟今日戰報的全市場查詢完全無關，不會有記憶體
 * 問題，所以不需要跟 `buildHistoryRangeSql_` 共用同一支函式、也不需要
 * `stocksOnly` 這種全市場專用的篩選。
 */
function buildHistoryRowsForCodesSql_(sourceRef, stockIds, startStr) {
  var cols = bqColumnNames_().join(', ');
  var idList = stockIds.map(function (id) { return "'" + String(id).replace(/'/g, '') + "'"; }).join(', ');
  var sql = 'SELECT ' + cols + ' FROM `' + sourceRef + '` WHERE stock_id IN (' + idList + ')';
  if (startStr) sql += " AND date_str >= '" + startStr + "'";
  return sql;
}

/**
 * 股票搜尋（代號或名稱模糊比對）——從 apps-script/src/StockAnalysis.gs 的
 * `searchStockCodes` 改寫：原版只掃最近 10 天的 Sheets 檔案，這裡改成查
 * BigQuery 最近 `cutoffStr` 以後、一般股票（排除權證/ETF，理由同
 * `buildHistoryRangeSql_` 的 `stocksOnly`）的原始列，用 `LIKE` 比對代號/名稱，
 * 依日期新到舊排序——呼叫端（index.js 的 `searchStockCodes`）再依代號去重
 * （同一支股票很多天都會出現，只取最新那筆的名稱），取前幾筆當結果。
 * query 裡的單引號／SQL LIKE 萬用字元（`%`／`_`）都濾掉，避免使用者輸入的
 * 搜尋字串意外改變查詢語意或造成注入。
 */
function buildStockSearchSql_(sourceRef, query, cutoffStr, limit) {
  // 只選搜尋用得到的 3 欄，不是 bqColumnNames_() 整組 24 欄——BigQuery 是照掃描
  // 的欄位位元組數計費，搜尋結果只需要代號/名稱/日期，沒理由多付其他 21 欄的錢。
  var q = String(query).replace(/['%_]/g, '');
  var sql = 'SELECT stock_id, stock_name, date_str FROM `' + sourceRef + '`' +
    " WHERE date_str >= '" + cutoffStr + "' AND LENGTH(stock_id) = 4" +
    " AND (stock_id LIKE '%" + q + "%' OR stock_name LIKE '%" + q + "%')" +
    ' ORDER BY date_str DESC' +
    ' LIMIT ' + (Number(limit) || 500);
  return sql;
}

/**
 * 把 BigQuery 查詢回來的一列（ascii 欄名、全部字串）轉回 computeFactors_ 期待的
 * 中文欄名列物件，數值欄位轉成 number，讓 lib/analysis.js 的 computeFactors_
 * 完全不用改。
 *
 * 回傳 null 代表這列的 stock_id 清洗後不是合法代號（4~6 碼英數字），整列捨棄——
 * 不能讓格式跑掉的代號變體混進 computeFactors_，不只污染計算結果，實測遇過真實
 * 案例：某次查詢回來的「相異代號數」高達 4.9 萬（正常應該是一千多到兩千），
 * Cloud Function 因此把這堆假股票全部分組、算 rolling 因子，記憶體直接爆掉
 * OOM。sanitizeStockId_ 這支清洗函式是這支 App 原本就有、专门處理這個問題的
 * 既有邏輯（見 lib/utils.js 的說明），這裡在資料從 BigQuery 進來的第一關就
 * 套用，不是事後才補救。
 */
function mapBqRowToHistoryRow_(bqRow) {
  var code = sanitizeStockId_(bqRow.stock_id);
  if (!code) return null;
  var row = {};
  BQ_COLUMN_MAP.forEach(function (m) {
    if (m.bq === 'stock_id') { row[m.cn] = code; return; }
    var v = bqRow[m.bq];
    if (config.HISTORY_NUMERIC_COLUMNS.indexOf(m.cn) !== -1) {
      var n = typeof v === 'number' ? v : parseFloat(v);
      row[m.cn] = isNaN(n) ? 0 : n;
    } else {
      row[m.cn] = (v === undefined || v === null) ? '' : String(v).trim();
    }
  });
  return row;
}

// ---------------- 每日股價資料寫入 `history_raw`（見 lib/twseFetch.js） ----------------

/** 刪除「指定幾個日期」既有資料的 SQL——寫入前先清掉當天既有的資料，避免兩次
 *  寫入同一天造成重複列（例如重新抓某一天覆蓋掉舊資料，或排程/手動補抓對同
 *  一天重複呼叫），跟 apps-script/src/BigQuerySync.gs 的 `buildDeleteDatesSql_`
 *  同一個用途。 */
function buildDeleteDatesSql_(tableRef, dateStrs) {
  var list = dateStrs.map(function (d) { return "'" + String(d).replace(/'/g, '') + "'"; }).join(', ');
  return 'DELETE FROM `' + tableRef + '` WHERE date_str IN (' + list + ')';
}

/**
 * 把合併好的列（`lib/twseFetch.js` 的 `mergeDayRows_` 輸出，中文欄名）寫進
 * `history_raw` 的 INSERT DML。`history_raw` 的 schema 全部欄位都是 STRING
 * （見 README「每日股價資料抓取」那節——跟 apps-script 版 `ensureRawTable_`
 * 建表時的 schema 一致，數值轉型留到讀取時 `mapBqRowToHistoryRow_` 做），
 * 所以每個值都當字串字面值處理，不用區分欄位型別。
 *
 * **2026-10-07 架構決定：用 DML INSERT，不是 load job**——apps-script 版把
 * 整天的資料轉成 CSV blob 餵給 BigQuery load job（`upsertHistoryRowsToBigQuery_`）
 * ，Node 版改用一般的 `INSERT ... VALUES (...), (...)` DML 敘述，原因：
 *   1. 一天的資料量很小（通常一千多列），組成一條 INSERT 敘述完全不會超過
 *      BigQuery 查詢文字 1MB 的上限，不需要 load job 的額外複雜度（準備
 *      blob／等待 load job 完成）。
 *   2. DML INSERT 寫入的列可以立刻被後續的 DELETE 刪除；BigQuery 的
 *      streaming insert（`tabledata.insertAll`）寫入的列會先進「串流緩衝區」，
 *      緩衝區裡的資料短時間內（官方說法是最多到 90 分鐘）無法被 DML 刪除或
 *      更新——如果改用 streaming insert，補抓/重新抓某一天時的
 *      「先刪除當天舊資料再寫入」這個 idempotent 寫法會在緩衝區未清空前
 *      失敗，load job／一般 DML 都沒有這個限制，才是正確選擇。
 */
/** 單一欄位值轉成 SQL 字串字面值——`buildInsertRowsSql_`／`chunkRowsBySize_`
 *  共用，避免兩處各自重複寫一次跳脫邏輯。 */
function escapeVal_(v) {
  return "'" + String(v === undefined || v === null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function buildInsertRowsSql_(tableRef, rows) {
  var cols = BQ_COLUMN_MAP;
  var valuesSql = rows.map(function (row) {
    return '(' + cols.map(function (m) { return escapeVal_(row[m.cn]); }).join(', ') + ')';
  }).join(',\n');
  return 'INSERT INTO `' + tableRef + '` (' + bqColumnNames_().join(', ') + ')\nVALUES\n' + valuesSql;
}

/**
 * **2026-10-07 修正一個讓補抓整個失效的 bug**：原本的架構假設「一天的資料量
 * 很小（通常一千多列），組成一條 INSERT 敘述完全不會超過 BigQuery 查詢文字
 * 1MB 的上限」——使用者實際補抓時發現這個假設是錯的，TWSE 一天的資料遠不止
 * 「一千多列」這個估計（MI_INDEX／T86 實際涵蓋的證券數量比想像中多很多），
 * 組出來的 INSERT 敘述實測落在 3.2MB~3.8MB，是 1MB 上限的 3 倍以上，補抓
 * 七天「全部」都因為 `The query is too large` 失敗，一天都抓不進來。
 *
 * 修正：把一天的 rows 依組出來的 SQL 字面值長度切成多個 chunk，每個 chunk
 * 控制在 `maxChars`（預設 700,000，比 1,048,576 的上限留了接近 350K 的
 * 安全邊界，給 DELETE 敘述／transaction 包裝文字／估算誤差留空間）以內，
 * 每個 chunk 各自是一次獨立的 INSERT，不會讓單一 query 文字超過上限。
 *
 * 回傳「列陣列的陣列」（不是組好的 SQL 字串），因為呼叫端（index.js
 * `writeHistoryRowsToBigQuery_`）要對「第一個 chunk」用
 * `buildDeleteAndInsertTransactionSql_` 包進交易（DELETE+第一批 INSERT
 * 綁在一起，失敗會整個 rollback，不會重演「DELETE 成功但這天資料完全
 * 插不進去」那個資料遺失的 bug），「其餘 chunk」才各自用單純的
 * `buildInsertRowsSql_`（DELETE 已經在第一個 chunk 的交易裡做過一次，
 * 不用也不該再做第二次）。
 *
 * 這個設計的已知取捨：如果第一個 chunk 的交易成功，但「後面」某個 chunk
 * 失敗，這一天會停在「只插入了前幾個 chunk」的不完整狀態，不是這次修正
 * 之前「整天資料完全消失」那麼糟，但也不是完全沒有風險。因為這整條管線
 * 本來就是「先刪除這個日期的既有資料、再整批寫入」的 idempotent 設計，
 * 重新補抓同一天會先清掉這個不完整的殘留、重新寫一次完整的資料，使用者
 * 只要照正常流程對失敗的日期重試一次就會自我修復，不需要額外的復原工具。
 */
function chunkRowsBySize_(rows, maxChars) {
  maxChars = maxChars || 700000;
  var chunks = [];
  var current = [];
  var currentLen = 0;
  rows.forEach(function (row) {
    var rowSql = '(' + BQ_COLUMN_MAP.map(function (m) { return escapeVal_(row[m.cn]); }).join(', ') + ')';
    var addLen = rowSql.length + (current.length > 0 ? 2 : 0); // ',\n' 分隔符號
    if (current.length > 0 && currentLen + addLen > maxChars) {
      chunks.push(current);
      current = [row];
      currentLen = rowSql.length;
    } else {
      current.push(row);
      currentLen += addLen;
    }
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * 把「刪除這些日期既有資料」跟「插入新資料」包成一個 BigQuery multi-statement
 * script，當一個 query job 送出——**2026-10-07 修正一個真的發生過的資料遺失
 * bug**：原本 `writeHistoryRowsToBigQuery_`（index.js）是兩次獨立的
 * `client.query()` 呼叫，先 DELETE 再 INSERT。使用者實際補抓時，如果 INSERT
 * 那一步失敗（TWSE 資料不完整、BigQuery 暫時性錯誤、網路中斷…），DELETE
 * 已經先成功執行完了——那一天「原本已經存在」的資料就這樣被刪掉、沒有新
 * 資料補回去，從「沒抓到新的」變成「連舊的都不見了」。`getHistoryOverview`
 * 的 `maxDate`／`tradingDays` 实際出现过從 2026-10-02／179 天倒退回
 * 2026-09-30／178 天，就是這個 bug 造成的。
 *
 * 改成 `BEGIN TRANSACTION; DELETE ...; INSERT ...; COMMIT TRANSACTION;`
 * 包在一個 `BEGIN ... EXCEPTION WHEN ERROR THEN ROLLBACK TRANSACTION; RAISE
 * ... END;` 區塊裡，當一個 query job 送出：INSERT 失敗時交易會先
 * ROLLBACK（撤銷 DELETE 的效果，那天原本的資料完整保留），再用 RAISE 把
 * 錯誤往外丟，呼叫端（`fetchOneDayAndWrite_`）原本的 try/catch 照常把這天
 * 記成 `failed`——行為上「這天失敗了」沒有變，差別只在「失敗的時候不會
 * 順便把原本好好的資料也弄丟」。
 */
function buildDeleteAndInsertTransactionSql_(tableRef, dateStrs, rows) {
  return 'BEGIN\n' +
    '  BEGIN TRANSACTION;\n' +
    '  ' + buildDeleteDatesSql_(tableRef, dateStrs) + ';\n' +
    '  ' + buildInsertRowsSql_(tableRef, rows) + ';\n' +
    '  COMMIT TRANSACTION;\n' +
    'EXCEPTION WHEN ERROR THEN\n' +
    '  ROLLBACK TRANSACTION;\n' +
    '  RAISE USING MESSAGE = @@error.message;\n' +
    'END;';
}

/** `history_raw` 目前最新的 `date_str`——每日排程／補抓用這個決定要從哪一天
 *  開始補（下一天）。查無任何資料時回傳 null（全新安裝，或這張表還是空的），
 *  呼叫端自行決定 fallback（通常是從今天開始抓）。 */
function buildMaxDateSql_(tableRef) {
  return 'SELECT MAX(date_str) AS max_date FROM `' + tableRef + '`';
}

/** 資料總覽（Admin 頁面顯示用）：日期範圍／交易日數／股票數／總列數，查的是
 *  `sourceRef`（通常是 `sourceRefForRead_` 算出來的那個，也就是這個 App 實際
 *  在用的來源），不是固定查 `history_raw`——這樣看到的數字跟戰報實際讀到的
 *  資料是同一份，不會「總覽看起來資料很新，戰報卻用著別的來源算出舊結果」。
 *  跟 apps-script 版 `buildDateBoundsSql_` 一致。 */
function buildDateBoundsSql_(sourceRef) {
  return 'SELECT MIN(date_str) AS min_date, MAX(date_str) AS max_date, ' +
    'COUNT(DISTINCT date_str) AS trading_days, COUNT(DISTINCT stock_id) AS stock_count, COUNT(*) AS row_count ' +
    'FROM `' + sourceRef + '`';
}

module.exports = {
  BQ_COLUMN_MAP: BQ_COLUMN_MAP,
  bqColumnNames_: bqColumnNames_,
  sourceRefForRead_: sourceRefForRead_,
  rawTableRef_: rawTableRef_,
  buildHistoryRangeSql_: buildHistoryRangeSql_,
  buildHistoryRowsForCodesSql_: buildHistoryRowsForCodesSql_,
  buildStockSearchSql_: buildStockSearchSql_,
  mapBqRowToHistoryRow_: mapBqRowToHistoryRow_,
  buildDeleteDatesSql_: buildDeleteDatesSql_,
  buildInsertRowsSql_: buildInsertRowsSql_,
  buildDeleteAndInsertTransactionSql_: buildDeleteAndInsertTransactionSql_,
  chunkRowsBySize_: chunkRowsBySize_,
  buildMaxDateSql_: buildMaxDateSql_,
  buildDateBoundsSql_: buildDateBoundsSql_
};
