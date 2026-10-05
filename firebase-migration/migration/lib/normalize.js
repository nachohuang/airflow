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

/** Sheets 儲存格常見型別問題（空字串/數字字串/真正的數字都可能出現）一律轉成
 *  真正的 number，parse 不出來就回傳 null——不要用 0 當預設值，0 是一個合法的
 *  股數/價格/分數，用 0 掩蓋「這欄本來就是空的或壞掉的」會讓後面的品質檢查看
 *  不出來。跟 zfill4／normalizeDateStr 同樣道理抽成共用模組：Portfolio 的
 *  買進價格/股數、AiDiagnosis 的 Armor_Score 都要用同一套「空值變 null、
 *  壞值也變 null」規則，不要每張表自己重新定義一次。 */
function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  var n = Number(raw);
  return isNaN(n) ? null : n;
}

/** 把一個 UTC 時刻的 Date 物件，格式化成台北時間（UTC+8）的 'YYYY-MM-DD HH:mm:ss'
 *  字串——不能用 getFullYear() 等本地時間方法，那是跑這支遷移腳本的機器自己的
 *  時區，不保證是台北時間；用 getTime() 加 8 小時再讀 UTC 欄位，結果才不受執行
 *  環境時區影響。 */
function formatAsTaipei_(date) {
  var t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) + ' ' +
    pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds());
}

/**
 * 「日期+時間」欄位（例如 FactorModelHistory 的「執行時間」）：跟
 * normalizeDateStr 類似的 Date 物件/字串判斷，但保留時間部分，統一格式成
 * 'YYYY-MM-DD HH:mm:ss'——跟 apps-script 原本
 * `Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss')`
 * 寫入時的格式一致。Sheets 儲存格如果被自動判斷成 Date 型別，export-sheets.gs
 * 匯出時 JSON.stringify 會呼叫 toISOString()，用的是 UTC 不是台北時間——這裡
 * 偵測到這種 ISO 字串時會轉回台北時間重建字串，不是原樣照抄 UTC 數字（那樣會
 * 跟原始寫入值差 8 小時，而這個欄位本身是用來判斷「套用中」版本的比對鍵，差
 * 8 小時會直接比對失敗）。
 */
function normalizeDateTimeStr(raw) {
  if (raw == null || raw === '') return '';
  if (raw instanceof Date) return formatAsTaipei_(raw);
  var s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/.test(s)) return formatAsTaipei_(new Date(s));
  return s;
}

module.exports = {
  zfill4: zfill4,
  normalizeDateStr: normalizeDateStr,
  normalizeDateTimeStr: normalizeDateTimeStr,
  parseNumber: parseNumber
};
