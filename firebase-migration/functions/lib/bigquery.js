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

/** 從來源 view 撈出指定日期區間（皆可留空）的原始欄位。 */
function buildHistoryRangeSql_(sourceRef, startStr, endStr) {
  var cols = bqColumnNames_().join(', ');
  var conds = [];
  if (startStr) conds.push("date_str >= '" + startStr + "'");
  if (endStr) conds.push("date_str <= '" + endStr + "'");
  var sql = 'SELECT ' + cols + ' FROM `' + sourceRef + '`';
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  return sql;
}

/** 把 BigQuery 查詢回來的一列（ascii 欄名、全部字串）轉回 computeFactors_ 期待的
 *  中文欄名列物件，數值欄位轉成 number——跟 mapBqRowToHistoryRow_ 同一套規則，
 *  讓 lib/analysis.js 的 computeFactors_ 完全不用改，拿到的列物件跟 Apps Script
 *  版讀 Drive CSV／讀 BigQuery 拿到的一模一樣。 */
function mapBqRowToHistoryRow_(bqRow) {
  var row = {};
  BQ_COLUMN_MAP.forEach(function (m) {
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
