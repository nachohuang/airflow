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

  logRun_('排程設定', '成功',
    '設定每日約 ' + hour + ':' + String(minute).padStart(2, '0') + ' 執行' + (skipWeekends ? '（六日不跑）' : '（含六日）'), 0);
  return getScheduleSettings();
}

function disableSchedule() {
  deleteExistingTrigger_();
  logRun_('排程設定', '成功', '已停用每日自動排程', 0);
  return getScheduleSettings();
}

/** scheduledDailyFetch() 開跑前的守門邏輯：週末 / 使用者設定的臨時停跑日一律跳過。 */
function shouldSkipToday_(date) {
  var settings = getScheduleSettings();
  var dow = date.getDay();
  if (settings.skipWeekends && (dow === 0 || dow === 6)) {
    return { skip: true, reason: '週末不執行（六日不跑設定）' };
  }
  var todayStr = normalizeDateStr(date);
  var match = settings.skipDates.filter(function (s) { return s.date === todayStr; })[0];
  if (match) {
    return { skip: true, reason: '設定的停跑日：' + (match.reason || '未填原因') };
  }
  return { skip: false, reason: '' };
}

/**
 * 手動「立即更新」：抓今天資料 + 重跑分析，繞過六日/停跑日檢查（測試/補跑用）。
 * 供 後台管理 的「立即測試執行」按鈕與 今日戰報 頁面的手動刷新共用。
 */
function runManualFullUpdate() {
  var fetchResult = runManualFetchToday();
  var analysis = null;
  if (fetchResult.ok) {
    try {
      analysis = runAnalysisAndSave();
    } catch (e) {
      logRun_('手動更新-分析', '失敗', String(e.message || e), 0);
    }
  }
  return { fetch: fetchResult, analysis: analysis };
}
