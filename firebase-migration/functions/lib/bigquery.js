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
var INDUSTRY_MAP_TABLE = 'industry_map'; // 股票代號→產業別，見 buildSyncIndustryMapSql_

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

/** `industry_map` 的完整參照字串——跟 apps-script 版
 *  `BigQuerySync.gs bqIndustryMapTableRef_` 同一張表，給
 *  `lib/factorRegression.js buildFeatureViewSql_` 的因子特徵 view JOIN 用。 */
function industryMapTableRef_(bigQueryConfig) {
  return bigQueryConfig.projectId + '.' + bigQueryConfig.dataset + '.' + INDUSTRY_MAP_TABLE;
}

var FEATURE_VIEW = 'factor_features'; // lib/factorRegression.js buildFeatureViewSql_ 建的 view
var FEATURE_SNAPSHOT_TABLE = 'factor_features_snapshot'; // 訓練時凍結的一次性快照表

/** 因子迴歸模型的特徵 view 完整參照字串——跟 apps-script 版 `bqFeatureViewRef_` 同一張。 */
function featureViewRef_(bigQueryConfig) {
  return bigQueryConfig.projectId + '.' + bigQueryConfig.dataset + '.' + FEATURE_VIEW;
}

/** 訓練兩個 label 用的一次性快照表完整參照字串——跟 apps-script 版
 *  `bqFeatureSnapshotTableRef_` 同一張，見
 *  `lib/factorRegression.js buildFeatureSnapshotSql_` 的說明。 */
function featureSnapshotTableRef_(bigQueryConfig) {
  return bigQueryConfig.projectId + '.' + bigQueryConfig.dataset + '.' + FEATURE_SNAPSHOT_TABLE;
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

/**
 * 2026-10-08 新增：Admin 頁面「資料完整性月曆」用——某個區間（通常是一整
 * 個月）每一天各自的四碼股票筆數／總列數，`GROUP BY date_str`，一次查
 * 整個月，不用為了核對資料完整性一天一天手動呼叫 `buildDateBoundsSql_`。
 * `stock_count` 只算 `LENGTH(stock_id) = 4` 的代號（排除權證/ETF，跟
 * `buildHistoryRangeSql_` 的 `stocksOnly` 同一個理由——權證代號是 6 碼，
 * 流通中的數量遠超過一般股票，混進來會讓「筆數」這個數字失真，看不出
 * 股票本身的資料到底有沒有缺）；`row_count` 是這天全部列數（含權證/ETF）
 * 當對照用，兩者差距異常大的話，可能代表權證資料比例不正常。 */
function buildDailyCountsSql_(sourceRef, fromDateStr, toDateStr) {
  return 'SELECT date_str, ' +
    'COUNT(DISTINCT CASE WHEN LENGTH(stock_id) = 4 THEN stock_id END) AS stock_count, ' +
    'COUNT(*) AS row_count ' +
    'FROM `' + sourceRef + '` ' +
    "WHERE date_str >= '" + fromDateStr + "' AND date_str <= '" + toDateStr + "' " +
    'GROUP BY date_str ORDER BY date_str';
}

/**
 * 2026-10-08 新增：把產業對照表（已經通過 lib/industryMap.js
 * `validateIndustryMapRows_` 驗證過的 `{code, industry}` 列）整份同步進
 * BigQuery `industry_map` 表，給還沒遷移的 FactorRegression.gs 因子特徵
 * view JOIN 用。跟 apps-script 版 `syncIndustryMapToBigQuery_` 一樣是
 * 「目前狀態」的整份覆蓋（不是逐日累積的歷史資料），但走法不同：apps-script
 * 版用 BigQuery.Jobs.insert 的 CSV load job（Apps Script 進階服務的既有
 * 模式），這裡改成跟其他表一致的手刻 SQL 字串（`CREATE OR REPLACE TABLE
 * ... AS SELECT`），不用另外處理 CSV 跳脫跟 load job 輪詢。
 *
 * 全市場上市櫃公司數量級（上千檔）遠小於 `history_raw` 動輒「天數 × 股票數」
 * 的規模，實測組出來的 SQL 長度遠低於 1MB 上限，不需要像
 * `buildInsertRowsSql_`／`chunkRowsBySize_` 那樣切 chunk。
 *
 * rows 是空陣列時（例如完全抓不到任何資料，理論上不會發生——呼叫端的
 * `validateIndustryMapRows_` 會先擋掉），`UNNEST([])` 沒有型別資訊會直接
 * 報錯，改用明確宣告欄位型別的空表 DDL，不是省略這個分支。
 */
function buildSyncIndustryMapSql_(tableRef, rows) {
  if (!rows || rows.length === 0) {
    return 'CREATE OR REPLACE TABLE `' + tableRef + '` (stock_id STRING, industry STRING)';
  }
  var structs = rows.map(function (r) {
    return 'STRUCT(' + escapeVal_(r.code) + ' AS stock_id, ' + escapeVal_(r.industry) + ' AS industry)';
  }).join(',\n    ');
  return 'CREATE OR REPLACE TABLE `' + tableRef + '` AS\nSELECT * FROM UNNEST([\n    ' + structs + '\n  ])';
}

var FINANCIAL_RATIOS_TABLE = 'financial_ratios'; // 季報毛利率/營益率/淨利率/ROE，見 buildFinancialRatiosStructSql_
var FINANCIAL_REVENUE_TABLE = 'financial_revenue'; // 月營收 YoY，見 buildFinancialRevenueStructSql_
var FUNDAMENTAL_FEATURE_VIEW = 'factor_features_fundamental'; // 疊加財報因子後的訓練用 view，見 buildFundamentalFeatureViewSql_

function financialRatiosTableRef_(bigQueryConfig) {
  return bigQueryConfig.projectId + '.' + bigQueryConfig.dataset + '.' + FINANCIAL_RATIOS_TABLE;
}
function financialRevenueTableRef_(bigQueryConfig) {
  return bigQueryConfig.projectId + '.' + bigQueryConfig.dataset + '.' + FINANCIAL_REVENUE_TABLE;
}
function fundamentalFeatureViewRef_(bigQueryConfig) {
  return bigQueryConfig.projectId + '.' + bigQueryConfig.dataset + '.' + FUNDAMENTAL_FEATURE_VIEW;
}

/** SQL 數字字面值：null/undefined/NaN 一律輸出 `NULL`（不加引號，這是
 *  FLOAT64/INT64 欄位，不是字串），跟 `escapeVal_`（给字串欄位用）分開，
 *  避免把數字欄位誤輸出成帶引號的字串常值。 */
function numOrNull_(v) {
  return (v === null || v === undefined || typeof v !== 'number' || isNaN(v)) ? 'NULL' : String(v);
}

/** 把「rows 依 rowToStructSql(row) 轉成的 STRUCT 字面值長度」切成多個
 *  chunk，每個 chunk 的 SQL 文字長度控制在 maxChars 以內——跟
 *  `chunkRowsBySize_`（`history_raw` 專用）同一個「列數可能隨著重複執行
 *  累積到不小，不能假設資料量小」的教訓（見該函式的完整說明：
 *  `financial_ratios`／`financial_revenue` 是跨多次「重新整理財報因子」
 *  累積出來的歷史，不是像 `industry_map` 那樣每次都是全市場一次性覆蓋
 *  的靜態快照，列數會隨時間成長），這裡是通用版本，不綁定特定欄位結構。 */
function chunkStructRowsBySize_(rows, rowToStructSql, maxChars) {
  maxChars = maxChars || 700000;
  var chunks = [];
  var current = [];
  var currentLen = 0;
  (rows || []).forEach(function (row) {
    var sql = rowToStructSql(row);
    var addLen = sql.length + (current.length > 0 ? 2 : 0);
    if (current.length > 0 && currentLen + addLen > maxChars) {
      chunks.push(current);
      current = [row];
      currentLen = sql.length;
    } else {
      current.push(row);
      currentLen += addLen;
    }
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 單筆季報財務比率列（`lib/financials.js joinIncomeAndEquity_`／
 *  `computeFundamentalStreaks_` 的輸出，已經轉成 `reportDate`／
 *  `grossMarginPct` 等欄名）的 STRUCT 字面值。 */
function financialRatioStructSql_(r) {
  return 'STRUCT(' + escapeVal_(r.code) + ' AS stock_id, DATE(' + escapeVal_(r.reportDate) + ') AS report_date, ' +
    numOrNull_(r.grossMarginPct) + ' AS gross_margin_pct, ' + numOrNull_(r.operatingMarginPct) + ' AS operating_margin_pct, ' +
    numOrNull_(r.netMarginPct) + ' AS net_margin_pct, ' + numOrNull_(r.roePct) + ' AS roe_pct, ' +
    numOrNull_(r.grossMarginStreak) + ' AS gross_margin_streak, ' + numOrNull_(r.operatingMarginStreak) + ' AS operating_margin_streak, ' +
    numOrNull_(r.netMarginStreak) + ' AS net_margin_streak, ' + numOrNull_(r.roeStreak) + ' AS roe_streak)';
}

var FINANCIAL_RATIOS_COLUMNS_DDL_ = 'stock_id STRING, report_date DATE, gross_margin_pct FLOAT64, ' +
  'operating_margin_pct FLOAT64, net_margin_pct FLOAT64, roe_pct FLOAT64, gross_margin_streak INT64, ' +
  'operating_margin_streak INT64, net_margin_streak INT64, roe_streak INT64';

/** 把累積到的季報財務比率整份覆蓋同步進 BigQuery `financial_ratios`
 *  表——`CREATE OR REPLACE TABLE`，不是逐筆 append，所以呼叫端每次都要
 *  傳「目前累積到的完整歷史」（見 `lib/financials.js` 開頭的說明：TWSE
 *  OpenAPI 這幾個端點是目前快照，不是歷史歸檔，累積歷史的責任在 Firestore
 *  那一層，這裡只是把累積好的結果同步一份給 BigQuery 查）。回傳 SQL
 *  陣列（第一句 `CREATE OR REPLACE TABLE ... AS SELECT`，後續是
 *  `INSERT INTO ... SELECT`），呼叫端依序執行——不用 `chunkRowsBySize_`
 *  那樣額外包 transaction，因為這是「整份重新覆蓋」不是「增量 UPSERT」，
 *  其中一個 chunk 失敗、下一次重新整理會自然重新覆蓋，不會留下用一半的
 *  髒資料跟正式資料混在一起看不出來。 */
function buildSyncFinancialRatiosSql_(tableRef, rows) {
  if (!rows || rows.length === 0) {
    return ['CREATE OR REPLACE TABLE `' + tableRef + '` (' + FINANCIAL_RATIOS_COLUMNS_DDL_ + ')'];
  }
  var chunks = chunkStructRowsBySize_(rows, financialRatioStructSql_);
  return chunks.map(function (chunk, i) {
    var structsSql = chunk.map(financialRatioStructSql_).join(',\n    ');
    var body = 'SELECT * FROM UNNEST([\n    ' + structsSql + '\n  ])';
    return i === 0
      ? 'CREATE OR REPLACE TABLE `' + tableRef + '` AS\n' + body
      : 'INSERT INTO `' + tableRef + '`\n' + body;
  });
}

/** 單筆月營收列（`lib/financials.js computeRevenueGrowthStreaks_` 的
 *  輸出）的 STRUCT 字面值。`reportDate` 是估算的「實際公開可得日期」
 *  （月底+10 個日曆天，對齊 TWSE 月營收法定公告期限，見
 *  `lib/financials.js` 的完整說明），不是財報所屬月份本身。 */
function financialRevenueStructSql_(r) {
  return 'STRUCT(' + escapeVal_(r.code) + ' AS stock_id, DATE(' + escapeVal_(r.reportDate) + ') AS report_date, ' +
    numOrNull_(r.revenueYoyPct) + ' AS revenue_yoy_pct, ' + numOrNull_(r.revenueGrowthStreak) + ' AS revenue_growth_streak)';
}

var FINANCIAL_REVENUE_COLUMNS_DDL_ = 'stock_id STRING, report_date DATE, revenue_yoy_pct FLOAT64, revenue_growth_streak INT64';

/** 跟 `buildSyncFinancialRatiosSql_` 同一個模式，月營收版本。 */
function buildSyncFinancialRevenueSql_(tableRef, rows) {
  if (!rows || rows.length === 0) {
    return ['CREATE OR REPLACE TABLE `' + tableRef + '` (' + FINANCIAL_REVENUE_COLUMNS_DDL_ + ')'];
  }
  var chunks = chunkStructRowsBySize_(rows, financialRevenueStructSql_);
  return chunks.map(function (chunk, i) {
    var structsSql = chunk.map(financialRevenueStructSql_).join(',\n    ');
    var body = 'SELECT * FROM UNNEST([\n    ' + structsSql + '\n  ])';
    return i === 0
      ? 'CREATE OR REPLACE TABLE `' + tableRef + '` AS\n' + body
      : 'INSERT INTO `' + tableRef + '`\n' + body;
  });
}

/**
 * 在既有的（apps-script parity 驗證過、原封不動不碰的）`factor_features`
 * view 之上，再疊一層「財報基本面因子」——刻意不直接修改
 * `lib/factorRegression.js buildFeatureViewSql_` 本身：那支函式逐行
 * 對照 apps-script 原始碼做過字串完全相等的驗證（見 test/parity.test.js
 * Parity 6），直接在裡面插入新邏輯風險是「改壞一段已經驗證過在正式環境
 * 可以跑的 SQL」，報酬（省一次 CREATE VIEW）完全不值得冒這個險。這裡
 * 另外建一個 view，用點對點（point-in-time）正確的方式把財報因子接上去：
 * 對每一個 (stock_id, date)，LEFT JOIN「這個 date 當天已經公開可得、
 * 最新一期」的財務比率/月營收資料（用 `report_date <= date` 的相關子查詢
 * 取最大值），不是直接 JOIN 同一天的資料（財報季度要等出表日期公告後
 * 才算「市場知道」，用季度期末日或當月月份直接對齊會製造未來函數——
 * 回測/訓練會「提前看到」財報季結束但還沒公告的資訊，見
 * `lib/financials.js parseIncomeStatementRows_` 的說明）。
 *
 * 訓練（`runFactorRegressionCore_`）之後改成對這個疊加後的 view 做
 * snapshot／訓練，不是原本的 `factor_features`，10 個新因子欄位名稱
 * （`fundamental_` 前綴）要加進 `config.js` 的 `FACTOR_CANDIDATE_COLUMNS`
 * 才會真的被 LASSO 考慮進去。
 */
/**
 * 2026-10-08 再修正：找不到任何財報資料的 (stock_id, date) 這幾個新欄位
 * 原本一律留著 NULL（不特別 COALESCE），指望 BigQuery ML 訓練時用內建
 * 的 mean imputation 處理（見 `lib/factorRegression.js
 * buildTrainModelSql_` 的說明）——但使用者實測遇到財報資料目前覆蓋率
 * 是真的「完全 0 筆」（`financial_ratios` 還只有極少數公司有資料、
 * 跟 `factor_features` 的歷史日期範圍幾乎沒有重疊），BigQuery ML 連
 * mean 都算不出來，直接報錯：
 *   "Failed to calculate mean since the entries in corresponding
 *    column 'fundamental_gross_margin_pct' are all NULLs."
 * 這是 mean imputation 本身的已知極限：欄位一筆非 NULL 值都沒有的話，
 * 平均值這個概念就不存在，不是「覆蓋率低」可以優雅處理的情況，是
 *「覆蓋率剛好是 0」這個邊界直接讓它整個失敗。
 *
 * 改成在這裡明確 COALESCE 成 0——跟 `lib/factorRegression.js
 * buildFeatureViewSql_` 本身既有的慣例一致（`inst_accum_divergence_20d`
 * 缺值 COALESCE 成 0、`days_since_new_low` 缺值 COALESCE 成 0.5），
 * 用一個固定常數取代「沒有資料」，不依賴 BigQuery ML 的自動插補
 * （不管覆蓋率是 0 還是部分覆蓋，COALESCE 後這個欄位永遠有值，不會再
 * 讓訓練整個報錯）。已知取捨：0 不是這幾個百分比欄位（毛利率／營益率／
 * 淨利率／ROE）統計意義上的「中性值」（不像其他因子用 0.5 代表
 * percentile rank 的中位數），在覆蓋率還很低的現階段，LASSO 看到的
 * 「大多數列都是常數 0」會讓這些因子的迴歸權重趨近於 0（學不到真正的
 * 預測力）——這是預期中的過渡狀態，不是 bug，隨財報資料逐季累積、
 * 真實覆蓋率提高後會自然改善，詳見 README「已知限制」。
 */
/**
 * 2026-10-08 修正：原本的寫法在 `LEFT JOIN ... ON` 的條件裡用相關子查詢
 * （`fr.report_date = (SELECT MAX(...) WHERE fr2.stock_id = base.stock_id
 * AND fr2.report_date <= base.date)`）直接參照外層 `base` 的欄位，這段
 * SQL 從寫出來到現在都沒有機會真的連上 BigQuery 執行過（這個開發環境
 * 連不到 BigQuery，部署流程也一直卡在其他問題，直到今天使用者實際按
 * 「開始訓練」才第一次真正執行到這段 SQL）——實際執行會被 BigQuery
 * 拒絕：`Unsupported subquery with table in join predicate.`，這是
 * BigQuery Standard SQL 的已知限制，JOIN 的 ON 子句裡不能放「參照到
 * 外層資料表」的相關子查詢。
 *
 * 改用 `ARRAY_AGG(... ORDER BY report_date DESC LIMIT 1)[OFFSET(0)]`
 * 先在獨立的 CTE 裡把「每個 (stock_id, date) 組合，日期 <= 這一天的
 * 最後一期財報」算出來（用一般的不等式 JOIN + GROUP BY，不是相關子
 * 查詢），再用普通的等值 JOIN 接回 base——語意完全不變（point-in-time
 * 正確性：JOIN 條件還是 `report_date <= base.date`，只是算「最後一筆」
 * 的方式換了，不是用 SQL 本身做不到的寫法），BigQuery 也能正常執行。
 */
function buildFundamentalFeatureViewSql_(baseFeatureViewRef, financialRatiosTableRef, financialRevenueTableRef, outputViewRef) {
  return [
    'CREATE OR REPLACE VIEW `' + outputViewRef + '` AS',
    'WITH base_fr AS (',
    '  SELECT base.stock_id, base.date,',
    '    ARRAY_AGG(fr ORDER BY fr.report_date DESC LIMIT 1)[OFFSET(0)] AS fr',
    '  FROM `' + baseFeatureViewRef + '` base',
    '  JOIN `' + financialRatiosTableRef + '` fr',
    '    ON fr.stock_id = base.stock_id AND fr.report_date <= base.date',
    '  GROUP BY base.stock_id, base.date',
    '),',
    'base_rev AS (',
    '  SELECT base.stock_id, base.date,',
    '    ARRAY_AGG(rev ORDER BY rev.report_date DESC LIMIT 1)[OFFSET(0)] AS rev',
    '  FROM `' + baseFeatureViewRef + '` base',
    '  JOIN `' + financialRevenueTableRef + '` rev',
    '    ON rev.stock_id = base.stock_id AND rev.report_date <= base.date',
    '  GROUP BY base.stock_id, base.date',
    ')',
    'SELECT',
    '  base.*,',
    '  COALESCE(base_fr.fr.gross_margin_pct, 0) AS fundamental_gross_margin_pct,',
    '  COALESCE(base_fr.fr.operating_margin_pct, 0) AS fundamental_operating_margin_pct,',
    '  COALESCE(base_fr.fr.net_margin_pct, 0) AS fundamental_net_margin_pct,',
    '  COALESCE(base_fr.fr.roe_pct, 0) AS fundamental_roe_pct,',
    '  COALESCE(base_fr.fr.gross_margin_streak, 0) AS fundamental_gross_margin_streak,',
    '  COALESCE(base_fr.fr.operating_margin_streak, 0) AS fundamental_operating_margin_streak,',
    '  COALESCE(base_fr.fr.net_margin_streak, 0) AS fundamental_net_margin_streak,',
    '  COALESCE(base_fr.fr.roe_streak, 0) AS fundamental_roe_streak,',
    '  COALESCE(base_rev.rev.revenue_yoy_pct, 0) AS fundamental_revenue_yoy_pct,',
    '  COALESCE(base_rev.rev.revenue_growth_streak, 0) AS fundamental_revenue_growth_streak',
    'FROM `' + baseFeatureViewRef + '` base',
    'LEFT JOIN base_fr ON base_fr.stock_id = base.stock_id AND base_fr.date = base.date',
    'LEFT JOIN base_rev ON base_rev.stock_id = base.stock_id AND base_rev.date = base.date'
  ].join('\n');
}

module.exports = {
  BQ_COLUMN_MAP: BQ_COLUMN_MAP,
  bqColumnNames_: bqColumnNames_,
  sourceRefForRead_: sourceRefForRead_,
  rawTableRef_: rawTableRef_,
  industryMapTableRef_: industryMapTableRef_,
  featureViewRef_: featureViewRef_,
  featureSnapshotTableRef_: featureSnapshotTableRef_,
  buildHistoryRangeSql_: buildHistoryRangeSql_,
  buildHistoryRowsForCodesSql_: buildHistoryRowsForCodesSql_,
  buildStockSearchSql_: buildStockSearchSql_,
  mapBqRowToHistoryRow_: mapBqRowToHistoryRow_,
  buildDeleteDatesSql_: buildDeleteDatesSql_,
  buildInsertRowsSql_: buildInsertRowsSql_,
  buildDeleteAndInsertTransactionSql_: buildDeleteAndInsertTransactionSql_,
  chunkRowsBySize_: chunkRowsBySize_,
  buildMaxDateSql_: buildMaxDateSql_,
  buildDateBoundsSql_: buildDateBoundsSql_,
  buildDailyCountsSql_: buildDailyCountsSql_,
  buildSyncIndustryMapSql_: buildSyncIndustryMapSql_,
  financialRatiosTableRef_: financialRatiosTableRef_,
  financialRevenueTableRef_: financialRevenueTableRef_,
  fundamentalFeatureViewRef_: fundamentalFeatureViewRef_,
  chunkStructRowsBySize_: chunkStructRowsBySize_,
  buildSyncFinancialRatiosSql_: buildSyncFinancialRatiosSql_,
  buildSyncFinancialRevenueSql_: buildSyncFinancialRevenueSql_,
  buildFundamentalFeatureViewSql_: buildFundamentalFeatureViewSql_
};
