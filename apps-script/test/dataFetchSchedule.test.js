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
const ScriptApp = {
  getProjectTriggers: function () { return fakeTriggers; },
  newTrigger: function () {
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

function makeCallSpy() {
  const calls = { step1: 0, step2: 0, step3: 0, step4: 0, step5: 0 };
  context.getScheduleSettings = function () { return { skipWeekends: true, skipDates: [] }; };
  context.getHistoryOverview = function () { calls.step1++; return { max: '2026-08-03' }; };
  context.backfillOneDay_ = function (cur) { calls.step2++; return { kind: 'succeeded', date: '2026-08-04', rowCount: 10 }; };
  context.getBigQuerySettings = function () { calls.step3++; return { projectId: '', sourceMode: 'materialized' }; };
  context.materializeHistoryTableIfStale_ = function () {};
  context.runAnalysisAndSave = function () { calls.step4++; return { latestDate: '2026-08-04', report: [1, 2, 3], diagnostics: { totalStocks: 2000 } }; };
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
      ? { kind: 'succeeded', date: '2026-08-03', rowCount: 5 }
      : { kind: 'failed', date: '2026-08-04', error: '部分失敗' };
  };
  context.getHistoryOverview = function () { calls.step1++; return { max: '2026-08-02' }; }; // 讓 cursor 涵蓋兩天
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
