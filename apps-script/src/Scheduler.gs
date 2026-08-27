/**
 * Scheduler.gs
 * 管理每日自動抓資料的時間觸發器：可調整啟動時間、可整批停用六日、
 * 可設定臨時停跑日（例如颱風假、證交所公告延後），並透過 RunLog 讓失敗看得到。
 */

function getSkipDatesSheet_() {
  return ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.SKIP_DATES, CONFIG.SKIP_DATES_COLUMNS);
}

function listSkipDates() {
  return readSheetObjects_(getSkipDatesSheet_())
    .map(function (r) { return { date: normalizeDateStr(r['日期']), reason: r['原因'] || '' }; })
    .filter(function (r) { return r.date; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

function addSkipDate(dateStr, reason) {
  var sheet = getSkipDatesSheet_();
  var rows = readSheetObjects_(sheet).filter(function (r) { return normalizeDateStr(r['日期']) !== dateStr; });
  rows.push({ '日期': dateStr, '原因': reason || '' });
  writeSheetObjects_(sheet, CONFIG.SKIP_DATES_COLUMNS, rows);
  logRun_('排程設定', '成功', '新增停跑日 ' + dateStr + (reason ? '（' + reason + '）' : ''), 0);
  return listSkipDates();
}

function removeSkipDate(dateStr) {
  var sheet = getSkipDatesSheet_();
  var rows = readSheetObjects_(sheet).filter(function (r) { return normalizeDateStr(r['日期']) !== dateStr; });
  writeSheetObjects_(sheet, CONFIG.SKIP_DATES_COLUMNS, rows);
  logRun_('排程設定', '成功', '移除停跑日 ' + dateStr, 0);
  return listSkipDates();
}

function triggerExists_(id) {
  if (!id) return false;
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getUniqueId() === id; });
}

function deleteExistingTrigger_() {
  var props = PropertiesService.getScriptProperties();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scheduledDailyFetch') ScriptApp.deleteTrigger(t);
  });
  props.deleteProperty(CONFIG.PROP_KEYS.TRIGGER_ID);
}

/** 供前端「後台管理」頁面顯示目前排程狀態。 */
function getScheduleSettings() {
  var props = PropertiesService.getScriptProperties();
  var hour = parseInt(props.getProperty(CONFIG.PROP_KEYS.TRIGGER_HOUR), 10);
  var minute = parseInt(props.getProperty(CONFIG.PROP_KEYS.TRIGGER_MINUTE), 10);
  var skipWeekendsProp = props.getProperty(CONFIG.PROP_KEYS.SKIP_WEEKENDS);
  var triggerId = props.getProperty(CONFIG.PROP_KEYS.TRIGGER_ID);
  return {
    hour: isNaN(hour) ? CONFIG.DEFAULT_TRIGGER_HOUR : hour,
    minute: isNaN(minute) ? CONFIG.DEFAULT_TRIGGER_MINUTE : minute,
    skipWeekends: skipWeekendsProp === null ? true : skipWeekendsProp === 'true',
    enabled: triggerExists_(triggerId),
    skipDates: listSkipDates()
  };
}

/** 建立/更新每日時間觸發器（先刪舊的再建新的，同一時間只會有一個）。 */
function setSchedule(hour, minute, skipWeekends) {
  hour = Math.max(0, Math.min(23, parseInt(hour, 10)));
  minute = Math.max(0, Math.min(59, parseInt(minute, 10)));

  deleteExistingTrigger_();
  var trigger = ScriptApp.newTrigger('scheduledDailyFetch')
    .timeBased()
    .everyDays(1)
    .atHour(hour)
    .nearMinute(minute)
    .inTimezone('Asia/Taipei')
    .create();

  var props = PropertiesService.getScriptProperties();
  props.setProperty(CONFIG.PROP_KEYS.TRIGGER_ID, trigger.getUniqueId());
  props.setProperty(CONFIG.PROP_KEYS.TRIGGER_HOUR, String(hour));
  props.setProperty(CONFIG.PROP_KEYS.TRIGGER_MINUTE, String(minute));
  props.setProperty(CONFIG.PROP_KEYS.SKIP_WEEKENDS, skipWeekends ? 'true' : 'false');

  ensureScheduleWatchdogTrigger_();

  logRun_('排程設定', '成功',
    '設定每日約 ' + hour + ':' + String(minute).padStart(2, '0') + ' 執行' + (skipWeekends ? '（六日不跑）' : '（含六日）'), 0);
  return getScheduleSettings();
}

function disableSchedule() {
  deleteExistingTrigger_();
  deleteScheduleWatchdogTrigger_();
  logRun_('排程設定', '成功', '已停用每日自動排程', 0);
  return getScheduleSettings();
}

// ============================================================
// 排程安全網：Apps Script 近乎即時的一次性觸發器（見 DataFetch.gs startJobLane_ 的說明，
// scheduledDailyFetch 真正觸發後，實際 5 個步驟是排一個 after(3000) 的一次性觸發器在另一次
// 獨立執行裡才開始跑）已知偶爾會直接不被平台觸發，不是拋例外、也不是撞到觸發器數量上限
// （這兩種 startJobLane_ 已經能接住並立刻標記成 error），單純就是平台本身對這種近乎即時的
// 一次性觸發器沒有 100% 的觸發保證。這種情況下工作會卡在「執行中」，只能等
// autoHealStaleJobState_ 被動偵測到太久沒更新（前端輪詢/開啟頁面時才會觸發），使用者
// 自己發現、自己按「重新啟動」——但每日排程是半夜自動觸發，沒有人在看畫面，等於每次卡住
// 都要放到隔天才會被發現，變成「每天都這樣」。
//
// 解法是另外裝一支「週期性」觸發器（不是近乎即時的一次性觸發器，是 Apps Script 官方回報
// 相對可靠的固定間隔觸發器）當安全網，定期檢查 daily／resume 這兩條排程車道有沒有卡住，
// 卡住就直接呼叫 restartJob 自動續跑，不用等使用者自己發現。只顧這兩條排程車道，不管
// 其餘七種背景 job（因子迴歸模型／回測／AI 診斷…）——那些都是使用者手動觸發，觸發當下
// 人就在畫面前，卡住了自己會發現、自己按重新啟動，跟半夜自動觸發、沒有人在看畫面的每日
// 排程是完全不同的情境，不需要也不該幫使用者自動重跑他們手動啟動、可能還沒決定要不要
// 重跑的工作。
// ============================================================

var SCHEDULE_WATCHDOG_HANDLER_ = 'watchdogResumeStuckScheduleJobs_';
var SCHEDULE_WATCHDOG_STUCK_MINUTES_ = 12; // 比 JOB_STALE_MINUTES_（JobQueue.gs，30 分鐘）
// 短，讓安全網通常會搶在被動偵測之前就先自動續跑，使用者很少會真的看到卡住的畫面。

/** 只在還沒有這支安全網觸發器時才建立（避免重複呼叫 setSchedule 疊出好幾個）。 */
function ensureScheduleWatchdogTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === SCHEDULE_WATCHDOG_HANDLER_; });
  if (exists) return;
  ScriptApp.newTrigger(SCHEDULE_WATCHDOG_HANDLER_).timeBased().everyMinutes(15).create();
}

function deleteScheduleWatchdogTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === SCHEDULE_WATCHDOG_HANDLER_) ScriptApp.deleteTrigger(t);
  });
}

/** 安全網觸發器本身呼叫的函式：檢查 daily／resume 兩條車道，卡住的話直接呼叫 restartJob
 *  自動續跑（跟使用者手動按「重新啟動」是同一支函式，同一套邏輯，只是不用等人來按）。
 *  reused 的 restartJob 本身遇到「其實還在執行中，只是比較慢」也不會中斷既有執行，見它
 *  自己的說明——這裡沿用同樣的安全假設，不用另外處理。單一車道自動續跑失敗（例如真的
 *  沒有可重新啟動的既有進度）不該影響另一條車道，各自獨立 try/catch。 */
function watchdogResumeStuckScheduleJobs_() {
  [
    { key: 'dailySchedule', propKey: CONFIG.PROP_KEYS.DAILY_SCHEDULE_JOB_STATE },
    { key: 'scheduleResume', propKey: CONFIG.PROP_KEYS.SCHEDULE_RESUME_JOB_STATE }
  ].forEach(function (lane) {
    try {
      var state = getJobLaneState_(lane.propKey);
      if (!state || state.status !== 'running' || !state.updatedAt) return;
      var idleMinutes = (Date.now() - state.updatedAt) / 60000;
      if (idleMinutes < SCHEDULE_WATCHDOG_STUCK_MINUTES_) return;
      logRun_('排程安全網', '成功', lane.key + ' 卡住已經 ' + Math.round(idleMinutes) + ' 分鐘沒有更新，自動重新啟動續跑', 0);
      restartJob(lane.key);
    } catch (e) {
      logRun_('排程安全網', '失敗', lane.key + ' 自動重新啟動失敗：' + String(e.message || e), 0);
    }
  });
}

/** scheduledDailyFetch() 開跑前的守門邏輯：週末 / 使用者設定的臨時停跑日一律跳過。 */
function shouldSkipToday_(date) {
  return shouldSkipDate_(date, getScheduleSettings());
}

/**
 * 跟 shouldSkipToday_ 邏輯相同，但設定值由呼叫端先讀好傳進來，
 * 讓 backfillOneDay_() 補一段日期區間時不用每天都重讀一次 Script Properties / SkipDates 分頁。
 */
function shouldSkipDate_(date, settings) {
  var dow = date.getDay();
  if (settings.skipWeekends && (dow === 0 || dow === 6)) {
    return { skip: true, reason: '週末不執行（六日不跑設定）' };
  }
  var dateStr = normalizeDateStr(date);
  var match = settings.skipDates.filter(function (s) { return s.date === dateStr; })[0];
  if (match) {
    return { skip: true, reason: '設定的停跑日：' + (match.reason || '未填原因') };
  }
  return { skip: false, reason: '' };
}

/**
 * 手動「立即更新」：嘗試抓今天資料 + 重跑分析，繞過六日/停跑日檢查（測試/補跑用）。
 * 供 後台管理 的「立即測試執行」按鈕與 最新戰報 頁面的手動刷新共用。
 *
 * 抓「今天」很容易失敗（例如證交所 T86 三大法人資料要收盤後一段時間才公布，太早按重新整理
 * 就會抓到「資料過少」），但這不代表沒有戰報可以看——不管今天抓不抓得到，都照樣重新跑一次
 * 分析，分析本來就會自動使用歷史資料裡目前最新的一天（見 computeLatestDayRows_），今天抓到了
 * 就是用今天，抓不到就自動退回目前最新的既有資料，不會因為今天還沒抓到就完全沒有結果可看。
 * fetch 欄位還是會誠實回報「今天」這次抓取本身成不成功，前端可以據此顯示提醒，但不會擋住
 * 顯示 analysis 的結果。
 */
function runManualFullUpdate() {
  var fetchResult = runManualFetchToday();
  var analysis = null;
  try {
    analysis = runAnalysisAndSave();
  } catch (e) {
    logRun_('手動更新-分析', '失敗', String(e.message || e), 0);
  }
  return { fetch: fetchResult, analysis: analysis };
}
