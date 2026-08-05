const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// DataFetch.gs 裡「每日排程」的步驟引擎（runScheduledSteps_ / scheduledDailyFetch）依賴一堆
// 別的檔案的函式（getScheduleSettings、getHistoryOverview、backfillOneDay_ 之外的部分、
// getBigQuerySettings、materializeHistoryTableIfStale_、runAnalysisAndSave、
// runDailyAiDiagnosisForTopPicks）跟 Apps Script 服務（PropertiesService）。這裡用跟其他
// test 一樣的手法：先用最小 stub 把整個 DataFetch.gs 載進 vm context，然後「載入之後」再
// 個別覆寫這些函式（backfillOneDay_ 本身就是 DataFetch.gs 定義的，要等載入完才能蓋掉，
// 不然會被檔案裡真正的定義蓋回去——跟 industryMap.test.js 測 ensureIndustryMapSyncedToBigQuery_
// 的手法一樣），才能在不連真正的 TWSE/BigQuery/Sheets 的情況下，針對性驗證「任一步真的失敗
// 就整個硬停、不跑後面步驟」這個核心行為。

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
const fakeTriggers = [];
let newTriggerCalls = []; // 每個元素是這次 ScriptApp.newTrigger(handlerName) 呼叫的 handler 名稱
const ScriptApp = {
  getProjectTriggers: function () { return fakeTriggers; },
  newTrigger: function (handlerName) {
    newTriggerCalls.push(handlerName);
    return {
      timeBased: function () { return this; },
      after: function () { return this; },
      create: function () { return { getUniqueId: function () { return 'fake-trigger-id'; } }; }
    };
  },
  deleteTrigger: function () {}
};

const context = {
  console: console,
  PropertiesService: PropertiesService,
  ScriptApp: ScriptApp,
  Date: Date,
  CONFIG: { PROP_KEYS: { LAST_SCHEDULED_RUN: 'LAST_SCHEDULED_RUN', SCHEDULE_RESUME_JOB_STATE: 'SCHEDULE_RESUME_JOB_STATE' } }
};
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('DataFetch.gs');

/** 每個測試案例都重設 fakeProps + call-count spy，避免互相污染。 */
function resetFakeProps() {
  Object.keys(fakeProps).forEach(function (k) { delete fakeProps[k]; });
}

/** runScheduleStep1_/2_ 的 cursor 邏輯是拿 getHistoryOverview() 回傳的「最新資料日期」跟
 *  ctx.todayOnly（當下真正的今天，new Date()）比較算出要補抓幾天，不能在測試裡寫死絕對
 *  日期字串（例如 '2026-08-03'）——這份測試檔案曾經因為寫死日期，跨到隔天執行時「今天」
 *  往前推了一天，補抓天數從預期的 1 天變成 2 天，斷言失敗。一律用「離真正的今天幾天前」
 *  動態算，測試才不會因為執行的當下日期不同而跑出不一樣的結果。 */
function daysAgoStr_(n) {
  var d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function makeCallSpy() {
  const calls = { step1: 0, step2: 0, step3: 0, step4: 0, step5: 0 };
  context.getScheduleSettings = function () { return { skipWeekends: true, skipDates: [] }; };
  // 最新資料是「昨天」-> cursor 從「今天」開始 -> 剛好 1 天要補抓。
  context.getHistoryOverview = function () { calls.step1++; return { max: daysAgoStr_(1) }; };
  context.backfillOneDay_ = function (cur) { calls.step2++; return { kind: 'succeeded', date: daysAgoStr_(0), rowCount: 10 }; };
  context.getBigQuerySettings = function () { calls.step3++; return { projectId: '', sourceMode: 'materialized' }; };
  context.materializeHistoryTableIfStale_ = function () {};
  context.runAnalysisAndSave = function () { calls.step4++; return { latestDate: daysAgoStr_(0), report: [1, 2, 3], diagnostics: { totalStocks: 2000 } }; };
  context.runDailyAiDiagnosisForTopPicks = function () { calls.step5++; return { skipped: true, reason: '未開啟每日自動 AI 診斷' }; };
  context.logRun_ = function () {};
  return calls;
}

// --- runScheduledSteps_: 全部步驟都成功 -> overallStatus success，5 步都跑到 ---
{
  resetFakeProps();
  const calls = makeCallSpy();
  const result = context.runScheduledSteps_(0, null);
  assert.strictEqual(result.overallStatus, 'success');
  assert.strictEqual(result.steps.length, 5);
  assert.strictEqual(calls.step1, 1);
  assert.strictEqual(calls.step2, 1);
  assert.strictEqual(calls.step3, 1);
  assert.strictEqual(calls.step4, 1);
  console.log('Test runScheduledSteps_ (all steps succeed) passed.');
}

// --- runScheduledSteps_: 第 1 步丟例外 -> 整個硬停，後面 4 步都不跑 ---
{
  resetFakeProps();
  const calls = makeCallSpy();
  context.getHistoryOverview = function () { calls.step1++; throw new Error('查詢最新資料日期失敗'); };
  const result = context.runScheduledSteps_(0, null);
  assert.strictEqual(result.overallStatus, 'failed');
  assert.strictEqual(result.steps.length, 1, '只應該記錄第 1 步（失敗），不該有第 2~5 步的紀錄');
  assert.strictEqual(result.steps[0].status, 'failed');
  assert.ok(result.steps[0].detail.indexOf('查詢最新資料日期失敗') !== -1);
  assert.strictEqual(calls.step2, 0, '第 1 步失敗後，第 2 步（補抓資料）不該被呼叫');
  assert.strictEqual(calls.step3, 0);
  assert.strictEqual(calls.step4, 0);
  assert.strictEqual(calls.step5, 0);
  console.log('Test runScheduledSteps_ (step 1 throws -> hard stop) passed.');
}

// --- runScheduledSteps_: 第 2 步全部日期都失敗（一天都沒成功）-> 視為整步失敗，硬停 ---
{
  resetFakeProps();
  const calls = makeCallSpy();
  context.backfillOneDay_ = function () { calls.step2++; return { kind: 'failed', date: '2026-08-04', error: 'TWSE 連線逾時' }; };
  const result = context.runScheduledSteps_(0, null);
  assert.strictEqual(result.overallStatus, 'failed');
  assert.strictEqual(result.steps.length, 2);
  assert.strictEqual(result.steps[1].status, 'failed');
  assert.strictEqual(calls.step3, 0, '補抓資料整步失敗後，後面步驟只會重算同一份舊資料，不該繼續跑');
  assert.strictEqual(calls.step4, 0);
  console.log('Test runScheduledSteps_ (step 2 all days fail -> hard stop) passed.');
}

// --- runScheduledSteps_: 第 2 步部分日期失敗（至少一天成功）-> 算 partial，繼續往下跑 ---
{
  resetFakeProps();
  const calls = makeCallSpy();
  let dayCount = 0;
  context.backfillOneDay_ = function () {
    calls.step2++;
    dayCount++;
    return dayCount === 1
      ? { kind: 'succeeded', date: daysAgoStr_(1), rowCount: 5 }
      : { kind: 'failed', date: daysAgoStr_(0), error: '部分失敗' };
  };
  context.getHistoryOverview = function () { calls.step1++; return { max: daysAgoStr_(2) }; }; // 讓 cursor 涵蓋兩天（今天跟昨天）
  const result = context.runScheduledSteps_(0, null);
  assert.strictEqual(result.steps[1].status, 'partial', '至少有一天成功，補抓資料這步不該算整步失敗');
  assert.strictEqual(result.overallStatus, 'partial');
  assert.strictEqual(calls.step3, 1, '有成功抓到新資料，後面步驟應該照常繼續跑');
  assert.strictEqual(calls.step4, 1);
  console.log('Test runScheduledSteps_ (step 2 partial fail -> continues) passed.');
}

// --- runScheduledSteps_: 第 4 步（重新計算戰報）丟例外 -> 前 3 步成功，第 5 步不跑 ---
{
  resetFakeProps();
  const calls = makeCallSpy();
  context.runAnalysisAndSave = function () { calls.step4++; throw new Error('BigQuery 查詢失敗'); };
  const result = context.runScheduledSteps_(0, null);
  assert.strictEqual(result.overallStatus, 'failed');
  assert.strictEqual(result.steps.length, 4);
  assert.strictEqual(result.steps[3].status, 'failed');
  assert.strictEqual(calls.step5, 0, '重新計算戰報失敗後，每日自動AI診斷不該繼續跑（診斷的候選名單來自戰報）');
  console.log('Test runScheduledSteps_ (step 4 throws -> step 5 skipped) passed.');
}

// --- runScheduledSteps_: 從第 3 步（index=2）開始重跑，沿用前面兩步的舊紀錄，不重跑 ---
{
  resetFakeProps();
  const calls = makeCallSpy();
  const previousSteps = [
    { label: '檢查最新資料日期', status: 'success', detail: '舊紀錄1', startedAt: 1, endedAt: 2 },
    { label: '補抓資料', status: 'success', detail: '舊紀錄2', startedAt: 3, endedAt: 4 },
    { label: 'BigQuery 整理', status: 'failed', detail: '原本失敗的那次', startedAt: 5, endedAt: 6 }
  ];
  const result = context.runScheduledSteps_(2, previousSteps);
  assert.strictEqual(result.steps[0].detail, '舊紀錄1', '重跑不該動到第 1 步的舊紀錄');
  assert.strictEqual(result.steps[1].detail, '舊紀錄2', '重跑不該動到第 2 步的舊紀錄');
  assert.strictEqual(calls.step1, 0, '從第 3 步重跑，第 1 步不該被重新呼叫');
  assert.strictEqual(calls.step2, 0, '從第 3 步重跑，第 2 步不該被重新呼叫');
  assert.strictEqual(calls.step3, 1, '第 3 步應該被重新執行');
  assert.strictEqual(result.overallStatus, 'success');
  console.log('Test runScheduledSteps_ (resume from step index -> reuses earlier steps) passed.');
}

// --- runScheduledSteps_: 時間預算在第一步開始前就已經用完（例如上一段 tick 已經跑了很
// 久）-> 一步都不跑，直接回傳 nextStepIndex=startIndex，狀態是 'running'（不是失敗）,
// 讓呼叫端知道要排下一次 tick 繼續。這是修「Apps Script 單次執行 6 分鐘上限會直接砍斷、
// 任何 try/catch 都接不住」這個實際發生過的問題的核心機制。 ---
{
  resetFakeProps();
  const calls = makeCallSpy();
  const longAgoBudgetStart = Date.now() - context.SCHEDULE_STEP_TIME_BUDGET_MS_ - 1000;
  const result = context.runScheduledSteps_(0, null, longAgoBudgetStart);
  assert.strictEqual(result.overallStatus, 'running', '時間預算用完不該算失敗，只是這段先停在這裡');
  assert.strictEqual(result.nextStepIndex, 0, '一步都還沒開始跑，下一次應該從第 0 步繼續');
  assert.strictEqual(result.steps.length, 0);
  assert.strictEqual(calls.step1, 0, '時間預算已經用完，第 1 步不該被呼叫');
  console.log('Test runScheduledSteps_ (time budget already exhausted -> stops before any step, status running) passed.');
}

// --- processScheduleResumeJobTick_: runScheduledSteps_ 回傳 nextStepIndex 非 null（時間
// 預算用完、還沒跑到底）時，要更新進度並排下一次 tick 繼續，這次 tick 不能標記成 done——
// 直接覆寫 context.runScheduledSteps_ 本身，跟 runScheduledSteps_ 的真實計時邏輯脫鉤，
// 專注驗證 processScheduleResumeJobTick_ 的協調邏輯本身對不對。 ---
{
  resetFakeProps();
  newTriggerCalls = [];
  const originalRunScheduledSteps = context.runScheduledSteps_;
  context.runScheduledSteps_ = function () {
    return { steps: [{ label: '補抓資料', status: 'partial', detail: 'x', startedAt: 1, endedAt: 2 }], overallStatus: 'running', summary: 'x', nextStepIndex: 2 };
  };
  context.saveScheduleResumeJobState_({ status: 'running', stepIndex: 0, overallStartedAt: Date.now(), updatedAt: Date.now() });
  context.processScheduleResumeJobTick_();
  const state = context.getScheduleResumeJobState_();
  assert.strictEqual(state.status, 'running', '時間預算用完時這次 tick 不該把工作標記成 done');
  assert.strictEqual(state.stepIndex, 2, '進度應該更新成 runScheduledSteps_ 回傳的 nextStepIndex');
  assert.ok(newTriggerCalls.indexOf('processScheduleResumeJobTick_') !== -1, '應該要排一個新的一次性觸發器繼續下一段');
  context.runScheduledSteps_ = originalRunScheduledSteps;
  console.log('Test processScheduleResumeJobTick_ (budget exhausted -> reschedules, stays running) passed.');
}

// --- processScheduleResumeJobTick_: runScheduledSteps_ 回傳 nextStepIndex=null（真的跑到
// 底了，不管成功/部分成功/失敗）時，這次 tick 才該標記成 done/error，不該再排下一次 tick。 ---
{
  resetFakeProps();
  newTriggerCalls = [];
  const originalRunScheduledSteps2 = context.runScheduledSteps_;
  context.runScheduledSteps_ = function () {
    return { steps: [], overallStatus: 'failed', summary: '第 2 步：failed', nextStepIndex: null };
  };
  context.saveScheduleResumeJobState_({ status: 'running', stepIndex: 0, overallStartedAt: Date.now(), updatedAt: Date.now() });
  context.processScheduleResumeJobTick_();
  const state2 = context.getScheduleResumeJobState_();
  assert.strictEqual(state2.status, 'error', 'runScheduledSteps_ 回傳失敗時，job 狀態也該是 error');
  assert.ok(state2.errorMessage.indexOf('failed') !== -1);
  assert.strictEqual(newTriggerCalls.indexOf('processScheduleResumeJobTick_'), -1, '已經跑到底了，不該再排下一次 tick');
  context.runScheduledSteps_ = originalRunScheduledSteps2;
  console.log('Test processScheduleResumeJobTick_ (reaches the end -> marks done/error, no reschedule) passed.');
}

// --- scheduledDailyFetch: 正常情況（不略過）現在應該是「排一個背景 job 就馬上回傳」，
// 不再是「同步跑完整套 5 個步驟」——這正是這次要修的問題本身：同步跑完整套很容易超過
// Apps Script 6 分鐘單次執行上限，被平台直接砍斷。 ---
{
  resetFakeProps();
  const calls = makeCallSpy();
  context.shouldSkipToday_ = function () { return { skip: false, reason: '' }; };
  context.scheduledDailyFetch();
  const jobState = context.getScheduleResumeJobState_();
  assert.ok(jobState, '應該要排一個背景 job');
  assert.strictEqual(jobState.status, 'running');
  assert.strictEqual(jobState.stepIndex, 0);
  assert.strictEqual(calls.step1, 0, 'scheduledDailyFetch 本身不該同步執行任何步驟——那是 tick 的工作');
  console.log('Test scheduledDailyFetch (normal case -> starts background job instead of running synchronously) passed.');
}

// --- scheduledDailyFetch: 最外層安全網——就算某個步驟之外的地方（例如 shouldSkipToday_）
// 丟出完全沒被接住的例外，也要讓「最近一次排程執行」記到「失敗＋錯誤訊息」，不能永遠停在
// null（「尚未執行過」），這是實際踩過的問題：BigQuery 整理有跑的痕跡，但「最近一次排程
// 執行」卻一直顯示尚未執行過，追查後發現是某個環節拋出了沒被接住的例外。 ---
{
  resetFakeProps();
  context.shouldSkipToday_ = function () { throw new Error('讀取試算表失敗'); };
  assert.strictEqual(context.getLastScheduledRunSteps(), null, '測試前提：一開始應該是 null（模擬「尚未執行過」）');
  context.scheduledDailyFetch();
  const last = context.getLastScheduledRunSteps();
  assert.ok(last, '就算最外層丟出未預期的例外，也應該要有紀錄，不能還是 null');
  assert.strictEqual(last.overallStatus, 'failed');
  assert.ok(last.summary.indexOf('讀取試算表失敗') !== -1, '要看得到實際的錯誤訊息，不能只講「失敗」');
  console.log('Test scheduledDailyFetch (uncaught exception outside steps still gets recorded) passed.');
}

console.log('All DataFetch.gs schedule-engine tests passed.');
