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

var DEDUPED_VIEW = 'history_deduped'; // sourceMode: external
var UNIFIED_VIEW = 'history_unified'; // sourceMode: materialized

function bqColumnNames_() {
  return BQ_COLUMN_MAP.map(function (m) { return m.bq; });
}

/** config/app 的 bigQuery 設定（projectId/dataset/sourceMode，Phase 2 已經遷移進
 *  Firestore）→ 這次查詢要讀的來源 view 的完整參照字串。跟
 *  apps-script/src/BigQuerySync.gs 的 sourceRefForBigQueryRead_ 同一套規則：
 *  materialized 用「統一讀取 view」（UNION 了 history_raw 跟 history_materialized），
 *  其餘（含 native 退回的 external 行為）用去重 view。 */
function sourceRefForRead_(bigQueryConfig) {
  var view = bigQueryConfig.sourceMode === 'materialized' ? UNIFIED_VIEW : DEDUPED_VIEW;
  return bigQueryConfig.projectId + '.' + bigQueryConfig.dataset + '.' + view;
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

module.exports = {
  BQ_COLUMN_MAP: BQ_COLUMN_MAP,
  bqColumnNames_: bqColumnNames_,
  sourceRefForRead_: sourceRefForRead_,
  buildHistoryRangeSql_: buildHistoryRangeSql_,
  mapBqRowToHistoryRow_: mapBqRowToHistoryRow_
};
