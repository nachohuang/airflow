/**
 * schedule.js
 * 判斷「現在是不是該跑每日戰報」的純邏輯，從 apps-script/src/Scheduler.gs／
 * DataFetch.gs 的 shouldSkipToday_／shouldSkipDate_ 改寫。
 *
 * 跟 Apps Script 版不同的地方：Apps Script 可以在執行階段動態新增/刪除真正的
 * 時間觸發器（`ScriptApp.newTrigger().atHour(hour).nearMinute(minute)`），使用者
 * 在畫面上改時間，實際觸發時間馬上跟著變。Cloud Scheduler 的 cron 是部署時
 * 寫死的設定，沒辦法用同樣的方式動態改——要嘛額外串 Cloud Scheduler Admin API
 * （多一組 IAM 權限、多一個 GCP 依賴，只為了改一個 cron 字串），要嘛改成固定
 * 頻率 tick（這支採用的做法）：`index.js` 的 `generateDailyReportScheduled`
 * 每 5 分鐘被 Cloud Scheduler 叫醒一次，每次都呼叫這支函式判斷「現在的台北時間
 * 是不是落在使用者設定的目標時間、沒有跳過週末、也不是臨時停跑日」，不是就直接
 * return，不做任何事。使用者在 Admin 頁面改 `config/app` 的
 * `triggerHour`/`triggerMinute`/`skipWeekends`，或是在 `skip_dates` 加一筆，
 * 下一次 tick（最多等 5 分鐘）就會生效，不用重新部署。代價是觸發時間的精準度
 * 降到 tick 間隔的解析度（目前 5 分鐘一個區間，不是精準到那一分鐘）。
 */

/** 把任何時刻的 Date 轉成「數值上等於台北時間」的 Date——之後用 getUTCHours()／
 *  getUTCMinutes()／getUTCDay() 讀出來的就是台北時間的欄位，不是真正的 UTC。
 *  跟 lib/utils.js 的 todayStrTaipei_ 同一招。 */
function toTaipeiFields_(now) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

/** 現在的台北時間是不是落在「目標時間所在的 tick 區間」裡（例如 tickMinutes=5
 *  時，目標是 23:07，實際落在 23:05~23:09 這個區間內都算吻合）。 */
function isScheduledTick_(nowTaipei, triggerHour, triggerMinute, tickMinutes) {
  var targetHour = triggerHour === null || triggerHour === undefined ? 23 : triggerHour;
  var targetMinute = triggerMinute === null || triggerMinute === undefined ? 0 : triggerMinute;
  var tick = tickMinutes || 5;
  var hourMatches = nowTaipei.getUTCHours() === targetHour;
  var bucketMatches = Math.floor(nowTaipei.getUTCMinutes() / tick) === Math.floor(targetMinute / tick);
  return hourMatches && bucketMatches;
}

function isWeekend_(nowTaipei) {
  var day = nowTaipei.getUTCDay(); // 0=週日...6=週六（nowTaipei 已經位移過，這裡讀到的是台北的星期）
  return day === 0 || day === 6;
}

/**
 * now：真正的目前時刻（任何時區的 Date 都可以，內部會自己換算成台北時間）。
 * opts：
 *   triggerHour / triggerMinute：目標執行時間（台北時間，0-23／0-59），沒設定
 *     預設 23:00，跟 apps-script 版 DEFAULT_TRIGGER_HOUR 的精神一致。
 *   skipWeekends：週末要不要跳過，沒設定（null/undefined）預設 true，跟
 *     apps-script 版 `skipWeekendsProp === null ? true : ...` 的預設值一致。
 *   skipDates：Set<string>，內容是 `skip_dates` collection 的文件 ID
 *     （yyyy-MM-dd），今天若在這個集合裡就跳過。
 *   tickMinutes：Cloud Scheduler 實際 tick 的頻率（分鐘），預設 5，要跟
 *     `index.js` 裡 `onSchedule` 的 `schedule: '*​/N * * * *'` 的 N 一致。
 */
function shouldRunDailyReport_(now, opts) {
  opts = opts || {};
  var nowTaipei = toTaipeiFields_(now);
  if (!isScheduledTick_(nowTaipei, opts.triggerHour, opts.triggerMinute, opts.tickMinutes)) return false;
  var skipWeekends = opts.skipWeekends === null || opts.skipWeekends === undefined ? true : opts.skipWeekends;
  if (skipWeekends && isWeekend_(nowTaipei)) return false;
  var todayStr = nowTaipei.toISOString().slice(0, 10);
  if (opts.skipDates && opts.skipDates.has(todayStr)) return false;
  return true;
}

/**
 * 從 fromDateStr（含）到 toDateStr（含）逐天列出「需要補抓股價資料」的日期
 * 字串，跳過週末（skipWeekends）／`skipDates` 集合裡的日期，最多列出 maxDays
 * 天（超過的部分直接捨棄——自動每日排程只處理「正常情況下只差一兩天」的小
 * 缺口，缺口真的很大時要另外用「手動補抓區間」分批處理，不是這支函式要解決
 * 的問題，見 index.js `exports.runHistoryBackfill` 的說明）。
 *
 * 跟 apps-script/src/DataFetch.gs 的 `runScheduleStep2_` 邏輯等價，純函式化
 * 方便測試——那邊是「逐天呼叫 I/O＋累計結果」混在一起，這裡先把「該抓哪幾天」
 * 這一步獨立出來，I/O（實際呼叫 TWSE／寫 BigQuery）留給 index.js。
 *
 * `fromDateStr` 用純字串比較跟 `toDateStr` 比大小（`'yyyy-MM-dd'` 字典序剛好
 * 等於時間序），`fromDateStr > toDateStr`（已經追上進度）自然回傳空陣列，不用
 * 額外判斷。
 */
function buildCatchupDateList_(fromDateStr, toDateStr, opts) {
  opts = opts || {};
  var skipWeekends = opts.skipWeekends === null || opts.skipWeekends === undefined ? true : opts.skipWeekends;
  var skipDates = opts.skipDates || new Set();
  var maxDays = opts.maxDays || 10;

  var result = [];
  if (fromDateStr > toDateStr) return result;

  var cur = new Date(fromDateStr + 'T00:00:00Z');
  var end = new Date(toDateStr + 'T00:00:00Z');
  while (cur.getTime() <= end.getTime() && result.length < maxDays) {
    var d = cur.toISOString().slice(0, 10);
    var isWeekendDay = skipWeekends && (cur.getUTCDay() === 0 || cur.getUTCDay() === 6);
    if (!isWeekendDay && !skipDates.has(d)) result.push(d);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}

module.exports = {
  shouldRunDailyReport_: shouldRunDailyReport_,
  isScheduledTick_: isScheduledTick_,
  isWeekend_: isWeekend_,
  buildCatchupDateList_: buildCatchupDateList_
};
