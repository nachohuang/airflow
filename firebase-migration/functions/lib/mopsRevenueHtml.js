/**
 * mopsRevenueHtml.js
 * 歷史月營收回補——TWSE 官方 OpenAPI（t187ap05_L，`lib/financials.js`
 * `parseMonthlyRevenueRows_` 在用的那個）只回傳最新一期快照，沒有日期
 * 區間查詢參數，要回補更早的月份只能走「公開資訊觀測站 MOPS」的舊版
 * 靜態報表頁面：
 *
 *   https://mopsov.twse.com.tw/nas/t21/{market}/t21sc03_{民國年}_{月}_{company_type}.html
 *
 * （market：sii=上市／otc=上櫃，company_type：0=一般業），回應是 Big5
 * 編碼的純 HTML（不是 JSON），逐產業別各自一個 `<table>`。
 *
 * 這份網址格式是從開源套件 twmops（github.com/whchien/twmops）的原始碼
 * 逆推出來的——這個開發環境連不到 `*.twse.com.tw` 任何網域（含
 * `mopsov.twse.com.tw`），沒辦法直接連線核對；twmops 目前仍在維護、最近
 * 才發過新版，可信度比憑空猜測高。2026-10-08 使用者已經用手機瀏覽器
 * 實際打開過 `t21sc03_115_7_0.html`，畫面內容（逐產業別表格、公司代號／
 * 名稱／當月營收／上月營收／去年當月營收／上月比較增減(%)／去年同月
 * 增減(%)／當月累計營收／去年累計營收／前期比較增減(%)／備註 11 個
 * 欄位，依序對應這裡的位置索引）吻合這裡假設的格式，但部署後第一次
 * 實際執行回補仍然可能跟這裡假設的細節有落差，錯誤訊息會帶網址/狀態碼
 * 方便診斷。
 *
 * 只接月營收這一份——TWSE 官方財報（綜合損益表／資產負債表，四率四升
 * 用的那兩份）目前沒有找到對應的 MOPS 靜態歷史頁面格式，季報財務比率
 * 目前還是只能靠 OpenAPI 往後逐月累積，見
 * `FinancialsCoverageCard.vue`「已知限制」小節。
 *
 * 新增時機：2026-10-08。
 */

/** 把一段 HTML 文字裡所有的 `<table>...</table>` 區塊，各自拆成「列的
 *  陣列，每列是儲存格文字的陣列」——不是完整的 HTML parser（這個專案
 *  沒有引入 cheerio／node-html-parser 之類的依賴，跟 `index.js`
 *  `fetchGoodinfoText_` 用正規表示式去標籤同一個「夠用就好、不為了單一
 *  資料源引入新依賴」的風格），只處理 MOPS 這種單純
 *  `<table><tr><td>` 結構（沒有巢狀 table）。如果遇到巢狀 table，這個
 *  函式會把內層的 `<tr>` 也混進外層的列清單——呼叫端靠「欄位數量」跟
 *  `isMopsRevenueDataRow_` 的代號格式檢查把雜訊列濾掉，不是靠信任 HTML
 *  結構完全乾淨來保證正確性。 */
function extractHtmlTables_(html) {
  var tables = [];
  var tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  var tableMatch;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    var rows = [];
    var rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    var rowMatch;
    while ((rowMatch = rowRe.exec(tableMatch[1])) !== null) {
      var cells = [];
      var cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      var cellMatch;
      while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
        cells.push(stripHtmlToText_(cellMatch[1]));
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

/** 單一儲存格內容去標籤＋常見 HTML 實體還原，跟 `index.js`
 *  `fetchGoodinfoText_` 的去標籤正規表示式同一套手法。 */
function stripHtmlToText_(cellHtml) {
  return String(cellHtml || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 跟 twmops 原始碼逆推出來的小計／標題列過濾規則一致：代號欄位要是
 *  4 碼以上、開頭是數字、不在「合計」這類標題/小計字樣清單裡，欄位數要
 *  至少 5 欄（不足 5 欄的雜訊列，例如版頭/註解列，直接濾掉）。 */
var MOPS_REVENUE_ROW_BLACKLIST_ = ['合計', '合計:', '公司代號', '公司'];

function isMopsRevenueDataRow_(cells) {
  if (!Array.isArray(cells) || cells.length < 5) return false;
  var code = cells[0];
  if (!code || code.length < 4) return false;
  if (MOPS_REVENUE_ROW_BLACKLIST_.indexOf(code) !== -1) return false;
  if (!/^[0-9]/.test(code)) return false;
  return true;
}

/** 數字欄位常見是千分位逗號字串，也可能是「-」（代表沒有數字），統一轉成
 *  number 或 null（不是 NaN，避免呼叫端要額外判斷 NaN）。 */
function parseMopsNumber_(raw) {
  var s = String(raw == null ? '' : raw).trim().replace(/,/g, '');
  if (s === '' || s === '-') return null;
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/** 'yyyy-MM' 轉成 MOPS 網址要用的民國年＋月份。 */
function mopsPeriodToRocYearMonth_(period) {
  var parts = String(period || '').split('-').map(Number);
  if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return { rocYear: parts[0] - 1911, month: parts[1] };
}

var MOPS_REVENUE_BASE_URL_ = 'https://mopsov.twse.com.tw/nas/t21';

/** 組出單一（市場、月份）要抓的 MOPS 靜態頁面網址，`period` 是
 *  'yyyy-MM'，`companyType` 預設 0（一般業，跟現有 OpenAPI 來源的範圍
 *  限制一致）。`period` 格式不對（或轉出來的民國年是負數）回傳 null，
 *  讓呼叫端決定要不要當錯誤處理，這支本身不拋例外。 */
function buildMopsRevenueUrl_(market, period, companyType) {
  var rm = mopsPeriodToRocYearMonth_(period);
  if (!rm || rm.rocYear <= 0 || rm.month < 1 || rm.month > 12) return null;
  return MOPS_REVENUE_BASE_URL_ + '/' + market + '/t21sc03_' + rm.rocYear + '_' + rm.month + '_' + (companyType == null ? 0 : companyType) + '.html';
}

/** 把 `extractHtmlTables_` 回傳的多個表格，解析成跟
 *  `lib/financials.js parseMonthlyRevenueRows_` 同一個輸出形狀的月營收
 *  列陣列（`{code, name, period, reportDate, reportDateIsEstimated,
 *  revenue, revenueYoyPct}`，多一個 `source` 欄位方便抽樣表格標示資料
 *  來源）。欄位用「位置索引」對應（不是標題文字比對——這個頁面沒有
 *  `<th>` 標題列可靠地重複出現在每個產業別區塊，位置索引是 twmops
 *  原始碼逆推出來的方式），索引順序：
 *  [0]代號 [1]名稱 [2]當月營收 [3]上月營收 [4]去年當月營收
 *  [5]上月比較增減% [6]去年同月增減% [7]當月累計營收 [8]去年累計營收
 *  [9]前期比較增減% [10]備註。
 *
 *  `period`／`reportDate` 由呼叫端傳入（這個網址本身就是按月分開抓的，
 *  不像 OpenAPI 回應裡每一列自己帶「資料年月」欄位）——`reportDate`
 *  一律是估算值，這個靜態頁面只有整頁共用的「出表日期」（代表頁面產生
 *  ／快照時間，不是每家公司實際公告日），不能拿來當逐公司的 reportDate
 *  用，呼叫端要自己用 `financials.js estimateMonthlyRevenueReportDate_`
 *  算出保守估計值傳進來。 */
function parseMopsRevenueTables_(tables, period, reportDate) {
  var out = [];
  (tables || []).forEach(function (rows) {
    rows.forEach(function (cells) {
      if (!isMopsRevenueDataRow_(cells)) return;
      var revenue = parseMopsNumber_(cells[2]);
      if (revenue === null) return;
      var code = cells[0].trim();
      out.push({
        code: code,
        name: (cells[1] || '').trim(),
        period: period,
        reportDate: reportDate,
        reportDateIsEstimated: true,
        revenue: revenue,
        revenueYoyPct: cells.length > 6 ? parseMopsNumber_(cells[6]) : null,
        source: 'mopsBackfill'
      });
    });
  });
  return out.filter(function (r) { return r.code.length === 4; });
}

/** 列出 `startPeriod` 到 `endPeriod`（含頭尾，皆為 'yyyy-MM'）之間每一個
 *  月份，由舊到新排序——回補迴圈用這個決定要依序抓哪些月份。
 *  `startPeriod` 晚於 `endPeriod` 回傳空陣列，不拋例外。 */
function enumeratePeriodsInclusive_(startPeriod, endPeriod) {
  var start = String(startPeriod || '').split('-').map(Number);
  var end = String(endPeriod || '').split('-').map(Number);
  if (start.length !== 2 || end.length !== 2 || start.some(isNaN) || end.some(isNaN)) return [];
  var periods = [];
  var y = start[0], m = start[1];
  var guard = 0;
  while ((y < end[0] || (y === end[0] && m <= end[1])) && guard < 1000) {
    periods.push(y + '-' + String(m).padStart(2, '0'));
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    guard += 1;
  }
  return periods;
}

module.exports = {
  extractHtmlTables_: extractHtmlTables_,
  stripHtmlToText_: stripHtmlToText_,
  isMopsRevenueDataRow_: isMopsRevenueDataRow_,
  parseMopsNumber_: parseMopsNumber_,
  mopsPeriodToRocYearMonth_: mopsPeriodToRocYearMonth_,
  buildMopsRevenueUrl_: buildMopsRevenueUrl_,
  parseMopsRevenueTables_: parseMopsRevenueTables_,
  enumeratePeriodsInclusive_: enumeratePeriodsInclusive_
};
