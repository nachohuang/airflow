const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Scheduler.gs 的排程安全網（ensureScheduleWatchdogTrigger_／deleteScheduleWatchdogTrigger_／
// watchdogResumeStuckScheduleJobs_，見那邊的說明：真正的每日 CLOCK 觸發器已知會可靠觸發，
// 但它排出來、實際執行 5 個步驟用的 after(3000) 一次性觸發器偶爾會直接不被平台觸發，安全網
// 是另外裝一支間隔固定、相對可靠的週期性觸發器，定期把卡住的 daily／resume 排程車道自動
// 續跑，不用等使用者自己發現卡住再手動按「重新啟動」）依賴 DataFetch.gs（daily/resume 車道
// 的 job 狀態讀寫、startJobLane_）跟 JobQueue.gs（restartJob，安全網卡住時拿來自動續跑用的
// 同一支函式，跟使用者手動按「重新啟動」共用）。用跟 aiDiagnosis.test.js／watchlist.test.js
// 一樣的手法：最小 fake Sheet／PropertiesService／SpreadsheetApp 把整串依賴載進同一個 vm
// context——只會實際執行到「dailySchedule」「scheduleResume」這兩個分支用到的函式，
// JobQueue.gs 裡其餘七種背景 job 各自的 startXxxJob 沒有載入也沒關係，JS 只有真的執行到
// 那個分支時才需要那個識別字存在，這裡的測試案例都不會踩到那些分支。

const fakeProps = {};
const PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function (key) { return Object.prototype.hasOwnProperty.call(fakeProps, key) ? fakeProps[key] : null; },
      setProperty: function (key, value) { fakeProps[key] = value; },
      deleteProperty: function (key) { delete fakeProps[key]; }
    };
  }
};

function makeFakeSheet_() {
  var grid = [];
  return {
    getLastRow: function () { return grid.length; },
    getLastColumn: function () { return grid.length ? grid[0].length : 0; },
    getRange: function (row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getValues: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) {
            var rowArr = grid[row - 1 + r] || [];
            var line = [];
            for (var c = 0; c < numCols; c++) line.push(rowArr[col - 1 + c] !== undefined ? rowArr[col - 1 + c] : '');
            out.push(line);
          }
          return out;
        },
        setValues: function (values) {
          for (var r = 0; r < values.length; r++) {
            var targetRow = row - 1 + r;
            while (grid.length <= targetRow) grid.push([]);
            for (var c = 0; c < values[r].length; c++) grid[targetRow][col - 1 + c] = values[r][c];
          }
        }
      };
    },
    clearContents: function () { grid = []; },
    deleteRows: function () {},
    setFrozenRows: function () {}
  };
}

var fakeSheets = {};
const SpreadsheetApp = {
  openById: function () {
    return {
      getSheetByName: function (name) { return fakeSheets[name] || null; },
      insertSheet: function (name) { var s = makeFakeSheet_(); fakeSheets[name] = s; return s; }
    };
  }
};

const Utilities = {
  formatDate: function (date, tz, fmt) {
    function pad(n) { return String(n).padStart(2, '0'); }
    return fmt
      .replace('yyyy', date.getFullYear())
      .replace('MM', pad(date.getMonth() + 1))
      .replace('dd', pad(date.getDate()))
      .replace('HH', pad(date.getHours()))
      .replace('mm', pad(date.getMinutes()))
      .replace('ss', pad(date.getSeconds()));
  }
};

// 一次性／週期性觸發器都用同一個 builder 模擬，記錄每次 create() 實際排定的 handler 名稱跟
// 間隔設定（everyMinutes(n) 或 everyDays(1) 這種），讓測試可以直接斷言「安全網裝的是週期性
// 觸發器，不是又一個近乎即時的一次性觸發器」——這正是安全網存在的意義，如果裝錯成一次性的，
// 等於完全沒有解決問題。
var fakeTriggers = [];
var newTriggerCalls = [];
const ScriptApp = {
  getProjectTriggers: function () { return fakeTriggers; },
  newTrigger: function (handlerName) {
    var rec = { handler: handlerName, kind: null };
    newTriggerCalls.push(rec);
    var builder = {
      timeBased: function () { return builder; },
      after: function () { rec.kind = 'after'; return builder; },
      everyMinutes: function (n) { rec.kind = 'everyMinutes(' + n + ')'; return builder; },
      everyDays: function () { rec.kind = 'everyDays'; return builder; },
      atHour: function () { return builder; },
      nearMinute: function () { return builder; },
      inTimezone: function () { return builder; },
      create: function () {
        var fakeT = {
          getHandlerFunction: function () { return handlerName; },
          getUniqueId: function () { return 'fake-' + handlerName + '-' + fakeTriggers.length; }
        };
        fakeTriggers.push(fakeT);
        return fakeT;
      }
    };
    return builder;
  },
  deleteTrigger: function (t) {
    var idx = fakeTriggers.indexOf(t);
    if (idx !== -1) fakeTriggers.splice(idx, 1);
  }
};

const context = {
  console: console, PropertiesService: PropertiesService, ScriptApp: ScriptApp,
  SpreadsheetApp: SpreadsheetApp, Utilities: Utilities
};
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('SheetUtils.gs');
loadIntoContext('DataFetch.gs');
loadIntoContext('JobQueue.gs');
loadIntoContext('Scheduler.gs');
fakeProps[context.CONFIG.PROP_KEYS.SPREADSHEET_ID] = 'fake-spreadsheet-id';

function resetAll_() {
  Object.keys(fakeProps).forEach(function (k) { delete fakeProps[k]; });
  fakeProps[context.CONFIG.PROP_KEYS.SPREADSHEET_ID] = 'fake-spreadsheet-id';
  fakeTriggers.length = 0;
  newTriggerCalls.length = 0;
  fakeSheets = {};
}

// --- 1. ensureScheduleWatchdogTrigger_：第一次呼叫要建立一個週期性（不是一次性）的安全網
//    觸發器；已經存在時再呼叫一次不該重複建立第二個 ---
{
  resetAll_();
  context.ensureScheduleWatchdogTrigger_();
  assert.strictEqual(fakeTriggers.length, 1, '應該要建立一個安全網觸發器');
  assert.strictEqual(fakeTriggers[0].getHandlerFunction(), 'watchdogResumeStuckScheduleJobs_');
  assert.strictEqual(newTriggerCalls[0].kind, 'everyMinutes(15)', '安全網要是週期性觸發器，不能又是一次性的 after(...)——那樣完全沒解決問題');

  context.ensureScheduleWatchdogTrigger_();
  assert.strictEqual(fakeTriggers.length, 1, '已經存在安全網觸發器時，再呼叫一次不該疊出第二個');
  console.log('Test 1 (ensureScheduleWatchdogTrigger_ creates a periodic trigger once, idempotent) passed.');
}

// --- 2. deleteScheduleWatchdogTrigger_：刪除安全網觸發器，不影響其他 handler 的觸發器 ---
{
  resetAll_();
  context.ensureScheduleWatchdogTrigger_();
  context.ScriptApp.newTrigger('someOtherHandler_').timeBased().after(3000).create();
  assert.strictEqual(fakeTriggers.length, 2);

  context.deleteScheduleWatchdogTrigger_();
  assert.strictEqual(fakeTriggers.length, 1, '應該只刪掉安全網自己的觸發器');
  assert.strictEqual(fakeTriggers[0].getHandlerFunction(), 'someOtherHandler_', '不該動到其他 handler 的觸發器');
  console.log('Test 2 (deleteScheduleWatchdogTrigger_ only removes its own trigger) passed.');
}

// --- 3. setSchedule / disableSchedule：啟用排程時要順便確保安全網存在，停用排程時要順便
//    把安全網一起拆掉（沒有排程可看了，安全網也沒有存在的意義）---
{
  resetAll_();
  context.setSchedule(21, 30, true);
  var handlers = fakeTriggers.map(function (t) { return t.getHandlerFunction(); });
  assert.ok(handlers.indexOf('scheduledDailyFetch') !== -1, '應該要建立每日排程本身的 CLOCK 觸發器');
  assert.ok(handlers.indexOf('watchdogResumeStuckScheduleJobs_') !== -1, 'setSchedule 應該順便確保安全網觸發器存在');

  context.disableSchedule();
  var handlersAfterDisable = fakeTriggers.map(function (t) { return t.getHandlerFunction(); });
  assert.strictEqual(handlersAfterDisable.indexOf('scheduledDailyFetch'), -1, '停用排程要刪掉每日排程本身的觸發器');
  assert.strictEqual(handlersAfterDisable.indexOf('watchdogResumeStuckScheduleJobs_'), -1, '停用排程也該順便把安全網一起拆掉，沒有排程可看了留著沒有意義');
  console.log('Test 3 (setSchedule installs watchdog, disableSchedule removes it) passed.');
}

// --- 4. watchdogResumeStuckScheduleJobs_：daily 車道卡在 running 超過門檻分鐘數沒更新，
//    要自動呼叫 restartJob('dailySchedule') 續跑（跟使用者手動按「重新啟動」是同一支函式）---
{
  resetAll_();
  context.saveJobLaneState_(context.CONFIG.PROP_KEYS.DAILY_SCHEDULE_JOB_STATE, {
    status: 'running', stepIndex: 0, overallStartedAt: Date.now() - 20 * 60 * 1000,
    updatedAt: Date.now() - 20 * 60 * 1000 // 20 分鐘沒更新，超過安全網門檻（12 分鐘）
  });
  newTriggerCalls.length = 0;

  context.watchdogResumeStuckScheduleJobs_();

  const state = context.getJobLaneState_(context.CONFIG.PROP_KEYS.DAILY_SCHEDULE_JOB_STATE);
  assert.strictEqual(state.status, 'running', 'restartJob 重新啟動後車道狀態應該回到 running（重新從 stepIndex 開始）');
  assert.ok(newTriggerCalls.some(function (c) { return c.handler === 'processDailyScheduleJobTick_'; }),
    '應該要重新排一個 processDailyScheduleJobTick_ 的續跑觸發器，等同呼叫 restartJob(\'dailySchedule\')');
  console.log('Test 4 (watchdog auto-restarts a stuck dailySchedule lane) passed.');
}

// --- 5. watchdogResumeStuckScheduleJobs_：還沒卡住超過門檻（剛更新沒多久）不該動它，
//    避免正常執行中的工作被誤判成卡住、平白重新啟動一次 ---
{
  resetAll_();
  context.saveJobLaneState_(context.CONFIG.PROP_KEYS.DAILY_SCHEDULE_JOB_STATE, {
    status: 'running', stepIndex: 2, overallStartedAt: Date.now() - 60 * 1000, updatedAt: Date.now() - 60 * 1000 // 才 1 分鐘前
  });
  newTriggerCalls.length = 0;

  context.watchdogResumeStuckScheduleJobs_();

  const state = context.getJobLaneState_(context.CONFIG.PROP_KEYS.DAILY_SCHEDULE_JOB_STATE);
  assert.strictEqual(state.stepIndex, 2, '還沒卡住超過門檻不該被重新啟動，stepIndex 應該維持原狀');
  assert.strictEqual(newTriggerCalls.length, 0, '不該多排任何觸發器');
  console.log('Test 5 (watchdog leaves a recently-updated running job alone) passed.');
}

// --- 6. watchdogResumeStuckScheduleJobs_：狀態是 'idle'／'done'／'error'（不是 'running'）
//    時不該去動它——安全網只處理「卡在執行中卻太久沒更新」這一種情況，其餘狀態代表已經有
//    明確結果（完成／失敗），使用者自己看得到，不該被安全網默默動過 ---
{
  resetAll_();
  context.saveJobLaneState_(context.CONFIG.PROP_KEYS.DAILY_SCHEDULE_JOB_STATE, {
    status: 'error', stepIndex: 1, updatedAt: Date.now() - 60 * 60 * 1000, errorMessage: '之前已知的失敗原因'
  });
  newTriggerCalls.length = 0;

  context.watchdogResumeStuckScheduleJobs_();

  const state = context.getJobLaneState_(context.CONFIG.PROP_KEYS.DAILY_SCHEDULE_JOB_STATE);
  assert.strictEqual(state.status, 'error', '已經是明確的 error 狀態不該被安全網動過');
  assert.strictEqual(state.errorMessage, '之前已知的失敗原因');
  assert.strictEqual(newTriggerCalls.length, 0);
  console.log('Test 6 (watchdog ignores non-running states like error) passed.');
}

// --- 7. watchdogResumeStuckScheduleJobs_：daily／resume 兩條車道各自獨立處理，一條卡住
//    另一條沒卡住時，只該重新啟動卡住的那一條 ---
{
  resetAll_();
  context.saveJobLaneState_(context.CONFIG.PROP_KEYS.DAILY_SCHEDULE_JOB_STATE, {
    status: 'running', stepIndex: 0, overallStartedAt: Date.now() - 20 * 60 * 1000, updatedAt: Date.now() - 20 * 60 * 1000
  });
  context.saveJobLaneState_(context.CONFIG.PROP_KEYS.SCHEDULE_RESUME_JOB_STATE, {
    status: 'running', stepIndex: 3, overallStartedAt: Date.now() - 60 * 1000, updatedAt: Date.now() - 60 * 1000
  });
  newTriggerCalls.length = 0;

  context.watchdogResumeStuckScheduleJobs_();

  const dailyState = context.getJobLaneState_(context.CONFIG.PROP_KEYS.DAILY_SCHEDULE_JOB_STATE);
  const resumeState = context.getJobLaneState_(context.CONFIG.PROP_KEYS.SCHEDULE_RESUME_JOB_STATE);
  assert.strictEqual(dailyState.stepIndex, 0, 'daily 車道卡住了，重新啟動後應該從原本記錄的 stepIndex 開始');
  assert.ok(newTriggerCalls.some(function (c) { return c.handler === 'processDailyScheduleJobTick_'; }));
  assert.strictEqual(resumeState.stepIndex, 3, 'resume 車道還沒卡住超過門檻，不該被動到');
  assert.ok(!newTriggerCalls.some(function (c) { return c.handler === 'processScheduleResumeJobTick_'; }),
    'resume 車道沒卡住，不該多排它的續跑觸發器');
  console.log('Test 7 (watchdog handles daily/resume lanes independently) passed.');
}

console.log('All Scheduler.gs watchdog tests passed.');
