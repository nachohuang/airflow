/**
 * stockDetail.js
 * 股票詳情頁（戰報卡片點進去看的頁面）要用的純邏輯：把 BigQuery 查回來的原始
 * History 列（已經過 lib/bigquery.js 的 mapBqRowToHistoryRow_ 轉成中文欄名）
 * 轉成前端時間序列圖要的英文欄名形狀，順便算 MA5/MA20/MA60——跟
 * apps-script/src/StockAnalysis.gs 的 getStockTimeSeries() 同一套邏輯，但
 * I/O（查 BigQuery／Firestore）留給 index.js，這裡只管「資料到手之後怎麼轉換」，
 * 不需要雲端憑證就能單元測試。
 */
var utils = require('./utils');

/**
 * historyRows：某一檔股票的原始 History 列（不用先排序，這支自己會排）。
 * 回傳依日期由舊到新排序的時間序列陣列，每筆帶 MA5/20/60（資料筆數不到視窗
 * 長度時該筆是 null，跟 utils.rollingMean 的規則一致，例如前 4 天沒有 MA5）。
 */
function buildPriceSeries_(historyRows) {
  var sorted = (historyRows || []).slice().sort(function (a, b) {
    return a['日期'] < b['日期'] ? -1 : (a['日期'] > b['日期'] ? 1 : 0);
  });
  var closes = sorted.map(function (r) { return r['收盤價']; });
  var ma5 = utils.rollingMean(closes, 5);
  var ma20 = utils.rollingMean(closes, 20);
  var ma60 = utils.rollingMean(closes, 60);
  return sorted.map(function (r, i) {
    return {
      date: r['日期'],
      close: r['收盤價'],
      open: r['開盤價'],
      high: r['最高價'],
      low: r['最低價'],
      volume: r['成交股數'],
      instNet: r['三大法人買賣超股數'],
      foreign: r['外資'],
      trust: r['投信'],
      dealer: r['自營商'],
      ma5: ma5[i],
      ma20: ma20[i],
      ma60: ma60[i]
    };
  });
}

/**
 * Firestore `reports/{date}/signals` 裡某一檔代號的文件（collectionGroup 查
 * 回來的），轉成「戰報燈號歷史」表格要的精簡形狀，依日期新到舊排序。
 */
function buildScoreHistory_(signalDocs) {
  return (signalDocs || [])
    .map(function (d) {
      return { date: d.date, armorScore: d.armorScore, strategy: d.strategy, action: d.action };
    })
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
}

module.exports = {
  buildPriceSeries_: buildPriceSeries_,
  buildScoreHistory_: buildScoreHistory_
};
