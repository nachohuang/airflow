/**
 * normalize.js
 * 共用的資料正規化純函式，跟 apps-script/src/Utils.gs 的 zfill4／normalizeDateStr
 * 同樣目的、同樣規則——這支 App 不只一張表需要「股票代號補零成4碼」「日期統一成
 * YYYY-MM-DD」這兩件事，每張表各自的 transform.js 都會用到，抽成共用模組，不要
 * 每張表各自複製一份（複製多份最怕的就是之後其中一份規則改了、其他份忘記同步改，
 * 兩張表的資料就會用不一樣的標準判斷「這個代號到底是不是同一檔股票」）。
 */

function zfill4(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  while (s.length < 4) s = '0' + s;
  return s;
}

/** export-sheets.gs 匯出的資料經過 JSON.stringify 之後，Sheets 裡原本是 Date
 *  型別的儲存格會變成 ISO 字串（例如 "2026-08-21T00:00:00.000Z"），不會是真正的
 *  JS Date 物件——這裡兩種輸入都處理，不假設一定是哪一種。 */
function normalizeDateStr(raw) {
  if (raw == null || raw === '') return '';
  if (raw instanceof Date) {
    var y = raw.getFullYear();
    var m = String(raw.getMonth() + 1).padStart(2, '0');
    var d = String(raw.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  var s = String(raw).trim();
  var m2 = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m2) return m2[1] + '-' + m2[2].padStart(2, '0') + '-' + m2[3].padStart(2, '0');
  return s;
}

module.exports = { zfill4: zfill4, normalizeDateStr: normalizeDateStr };
