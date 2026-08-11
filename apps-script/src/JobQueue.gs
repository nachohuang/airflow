/**
 * JobQueue.gs
 * 「排程佇列」：把目前所有背景 job（重新計算戰報 / 資料範圍重新彙整 / 因子迴歸模型 /
 * 立即重新整理，四個都是各自檔案裡用時間觸發器實作的獨立狀態機，見 Analysis.gs /
 * DataFetch.gs / FactorRegression.gs / BigQuerySync.gs）彙整成同一份清單，給「系統與資料
 * 後台」的排程佇列區塊統一顯示狀態、錯誤內容，並提供「重新啟動」——不用回到各自的頁籤
 * 重新操作一次。只讀彙整 + 轉派重啟，不擁有任何 job 自己的狀態或邏輯。
 */

/** 背景 job 卡住太久沒更新的判定門檻（分鐘），六種 job 共用同一個保守值：正常情況下每種
 *  job 的單次 tick（或整個流程）都會在幾分鐘內有進度更新，超過這個門檻還是 'running' 且
 *  完全沒有更新，基本上可以確定是時間觸發器沒有真的被觸發，不是「還在算只是比較慢」。 */
var JOB_STALE_MINUTES_ = 30;

/**
 * 六個背景 job 的 getXJobStatus() 共用：如果目前狀態是「執行中」但已經超過 JOB_STALE_MINUTES_
 * 分鐘沒有任何更新，自動判定成逾時失敗並存回 Script Properties，不用等使用者自己發現卡住、
 * 跑到「系統與資料後台」手動按「重新啟動」或「刪除」。所有呼叫端（排程佇列彙整、各自頁籤
 * 打開時的檢查、前端輪詢迴圈）都是透過這幾個 getXJobStatus() 讀狀態，在這裡做一次自動修復，
 * 全部呼叫端都受益，不用每個檔案各自重複判斷邏輯。
 *
 * 根本原因：Apps Script 近乎即時（1~2 秒後觸發）的一次性時間觸發器，偶爾會不知道什麼原因
 * 沒有真的被 Google 平台觸發執行——這是 Apps Script 平台本身的可靠度限制，不是這裡程式
 * 邏輯的問題，無法 100% 避免，只能讓「卡住之後」的體驗盡量不需要人工介入。觸發器沒被觸發，
 * 狀態就永遠停在 'running' 不會再更新，跟過期的 setTimeout 沒有人清掉是一樣的道理。
 */
function autoHealStaleJobState_(propKey, state) {
  if (!state || state.status !== 'running' || !state.updatedAt) return state;
  var idleMinutes = (Date.now() - state.updatedAt) / 60000;
  if (idleMinutes < JOB_STALE_MINUTES_) return state;
  state.status = 'error';
  state.errorMessage = '已經 ' + Math.round(idleMinutes) + ' 分鐘沒有更新，時間觸發器很可能沒有被正常觸發，已自動判定逾時失敗，可以直接重新啟動。';
  state.updatedAt = Date.now();
  PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(state));
  return state;
}

/** 刻意延後到呼叫時才組出這份清單（而不是檔案最上層的 var）：Apps Script 不保證多個 .gs
 *  檔案裡「最上層程式碼」的執行順序，函式宣告本身沒問題，但如果在最上層就直接把其他檔案
 *  的函式當值取出來，遇到載入順序不巧排在該檔案前面就會出錯；包在函式裡面只在真的被呼叫
 *  時（一定是所有檔案都載入完畢後的某次請求）才取用，就不受載入順序影響。 */
function jobQueueDefs_() {
  return [
    { key: 'analysis', label: '重新計算戰報', getStatus: getAnalysisJobStatus },
    { key: 'backfill', label: '資料範圍重新彙整', getStatus: getBackfillJobStatus },
    { key: 'factorRegression', label: '因子迴歸模型', getStatus: getFactorRegressionJobStatus },
    { key: 'materialize', label: '立即重新整理（materialized）', getStatus: getMaterializeJobStatus },
    { key: 'backtest', label: 'v17.0 策略回測', getStatus: getBacktestV17JobStatus },
    { key: 'aiTask', label: 'AI 診斷／續抱／Top3', getStatus: getAiDiagnosisJobStatus },
    { key: 'industryMap', label: '產業對照表', getStatus: getIndustryMapRefreshJobStatus },
    // 'dailySchedule'（真正的每日時間觸發器）跟 'scheduleResume'（使用者手動「從這步重跑」／
    // 「立即測試」）故意分成兩張獨立卡片、各自獨立的 job 狀態——早期版本兩者共用同一個狀態，
    // 使用者手動測試時剛好真正的排程也在等續跑的觸發器，會互相蓋掉進度（見 DataFetch.gs
    // 的說明），分開後兩邊互不影響，畫面上也才看得出「今晚真正排程」跟「我剛剛手動測試」
    // 是兩件不同的事，不會再對不起來。
    { key: 'dailySchedule', label: '每日排程（自動觸發）', getStatus: getDailyScheduleJobStatus },
    { key: 'scheduleResume', label: '每日排程重跑（手動測試/續跑）', getStatus: getResumeScheduledRunJobStatus }
  ];
}

function jobQueueDetail_(key, state) {
  if (key === 'backfill') {
    if (state.status === 'idle') return '';
    var succeeded = (state.succeeded || []).length;
    var failed = (state.failed || []).length;
    var skipped = (state.skipped || []).length;
    return '區間 ' + (state.startStr || '') + ' ~ ' + (state.endStr || '') +
      '　成功 ' + succeeded + '、略過 ' + skipped + (failed ? '、失敗 ' + failed : '') +
      (state.cursor ? '　處理到 ' + state.cursor : '');
  }
  if (key === 'factorRegression') {
    if (state.status === 'idle') return '';
    var parts = [];
    if (state.l1Reg !== undefined) parts.push('L1正規化強度 ' + state.l1Reg);
    (state.results || []).forEach(function (r) {
      parts.push(r.labelName + (r.error ? '：失敗' : '：R²=' + (r.r2 === null || r.r2 === undefined ? '-' : Number(r.r2).toFixed(4))));
    });
    return parts.join('　');
  }
  if (key === 'analysis') {
    if (state.status !== 'done') return '';
    if (!state.latestDate) {
      return '⚠️ 掃描到 ' + (state.scannedCount === null || state.scannedCount === undefined ? '0' : state.scannedCount) +
        ' 檔資料、沒有找到任何一天可用的戰報資料，請到「戰報與個股」按「查看篩選漏斗明細」或檢查「資料總覽」的資料來源設定';
    }
    return '戰報日期 ' + state.latestDate + '，' + state.reportCount + ' 檔訊號' +
      (state.scannedCount !== null && state.scannedCount !== undefined ? '（共掃描 ' + state.scannedCount + ' 檔）' : '');
  }
  if (key === 'materialize') {
    if (state.status !== 'done') return '';
    var names = state.fileNames || [];
    return '涵蓋 ' + (state.fileCount === null || state.fileCount === undefined ? names.length : state.fileCount) +
      ' 個來源檔案' + (names.length ? '：' + names.join('、') : '');
  }
  if (key === 'backtest') {
    if (state.status !== 'done') return '';
    var res = state.result;
    if (!res) return '';
    if (state.mode === 'all') {
      return Object.keys(res.results || {}).map(function (k) {
        var r = res.results[k];
        return r.strategyLabel + '：' + (r.summary ? '勝率 ' + r.summary.winRate + '%' : (r.error || r.warning || '無結果'));
      }).join('　');
    }
    var strategyPart = res.strategyLabel ? '［' + res.strategyLabel + '］' : '';
    if (!res.summary) return strategyPart + (res.warning || '');
    return strategyPart + state.startStr + '~' + state.endStr + '　' + res.summary.signalCount + ' 筆訊號、勝率 ' + res.summary.winRate + '%';
  }
  if (key === 'aiTask') {
    if (state.status !== 'done') return '';
    var taskLabel = { diagnosis: 'AI 深度診斷', hold: '持股續抱診斷', topPicks: 'Top3 橫向比較' }[state.taskType] || state.taskType;
    var target = (state.payload && state.payload.code) ? state.payload.code :
      (state.payload && state.payload.codes ? state.payload.codes.join(', ') : '');
    var res2 = state.result;
    var resultPart = Array.isArray(res2)
      ? res2.map(function (r) { return r.ok ? r.code + '：' + r.verdict : r.code + '：失敗'; }).join('、')
      : (res2 && res2.ok === false ? '失敗：' + res2.error : (res2 && res2.verdict ? res2.verdict : ''));
    return taskLabel + (target ? '（' + target + '）' : '') + (resultPart ? '　' + resultPart : '');
  }
  if (key === 'industryMap') {
    if (state.status !== 'done') return '';
    var s = state.result;
    if (!s) return '';
    return '共 ' + s.totalCount + ' 筆（上市 ' + s.twseCount + '，上櫃 ' + s.tpexCount + '）' +
      (s.coverage && s.coverage.checked ? '　涵蓋率 ' + s.coverage.coveragePct + '%' : '') +
      (s.tpexWarning ? '　⚠️ ' + s.tpexWarning : '');
  }
  if (key === 'scheduleResume' || key === 'dailySchedule') {
    if (state.status === 'idle') return '';
    var stepLabel = (SCHEDULE_STEP_DEFS_[state.stepIndex] && SCHEDULE_STEP_DEFS_[state.stepIndex].label) || ('第 ' + (state.stepIndex + 1) + ' 步');
    return '從「' + stepLabel + '」開始' + (state.status === 'error' ? '：' + state.errorMessage : '');
  }
  return '';
}

/** 前端「排程佇列」區塊呼叫：回傳三個背景 job 目前各自的狀態、進度摘要、能不能重啟/刪除。 */
function getJobQueueOverview() {
  return jobQueueDefs_().map(function (def) {
    var state = def.getStatus() || { status: 'idle' };
    var status = state.status || 'idle';
    return {
      key: def.key,
      label: def.label,
      status: status,
      updatedAt: state.updatedAt || null,
      detail: jobQueueDetail_(def.key, state),
      errorMessage: state.errorMessage || null,
      // running 也允許重啟：時間觸發器有時候不知道什麼原因就是沒有真的被 Apps Script 觸發，
      // 狀態會卡在 running 卻再也不會有進度更新，跟 error/cancelled 一樣需要使用者手動介入，
      // 不能只靠等待（等不到）。是否真的卡住由使用者自己看「更新時間」判斷。
      canRestart: status === 'error' || status === 'running' || (def.key === 'backfill' && status === 'cancelled'),
      canDelete: status !== 'idle'
    };
  });
}

/** 排程佇列的「重新啟動」按鈕呼叫：用該 job 上一次的參數重新排一次背景工作。
 *  如果目前狀態其實還在執行中（不是卡住，只是比較慢），重新啟動不會中斷那次執行——
 *  Apps Script 沒有辦法從另一次執行裡強制終止一次正在跑的觸發器執行，兩邊都跑完後，
 *  最後寫回狀態的那個會蓋過另一個，這是背景 job 用時間觸發器實作時無法避免的限制，
 *  前端按鈕會在使用者按下時另外提示一次。 */
function restartJob(key) {
  if (key === 'analysis') return startAnalysisJob();
  if (key === 'backfill') {
    var backfillState = getBackfillJobStatus();
    if (!backfillState || !backfillState.startStr) throw new Error('沒有可重新啟動的資料範圍重新彙整工作');
    return startBackfillJob(backfillState.cursor || backfillState.startStr, backfillState.endStr);
  }
  if (key === 'factorRegression') {
    var regressionState = getFactorRegressionJobStatus();
    return startFactorRegressionJob(regressionState && regressionState.l1Reg);
  }
  if (key === 'materialize') return startMaterializeJob();
  if (key === 'backtest') {
    var backtestState = getBacktestV17JobStatus();
    if (!backtestState || !backtestState.startStr) throw new Error('沒有可重新啟動的回測工作');
    if (backtestState.mode === 'all') {
      return startBacktestAllStrategiesJob(backtestState.startStr, backtestState.endStr, backtestState.targetProfit);
    }
    return startBacktestV17Job(backtestState.startStr, backtestState.endStr, backtestState.targetProfit, backtestState.strategyKey);
  }
  if (key === 'aiTask') {
    var aiState = getAiDiagnosisJobStatus();
    if (!aiState || !aiState.taskType) throw new Error('沒有可重新啟動的 AI 任務');
    return startAiDiagnosisJob(aiState.taskType, aiState.payload);
  }
  if (key === 'industryMap') return startIndustryMapRefreshJob();
  if (key === 'dailySchedule') {
    var dailyState = getDailyScheduleJobStatus();
    if (!dailyState || dailyState.stepIndex === undefined) throw new Error('沒有可重新啟動的每日排程工作');
    startDailyScheduleJob_(dailyState.stepIndex);
    return { status: 'running' };
  }
  if (key === 'scheduleResume') {
    var resumeState = getResumeScheduledRunJobStatus();
    if (!resumeState || resumeState.stepIndex === undefined) throw new Error('沒有可重新啟動的每日排程重跑工作');
    return startResumeScheduledRunJob(resumeState.stepIndex);
  }
  throw new Error('未知的工作類型：' + key);
}

/** 排程佇列的「刪除」按鈕呼叫：轉派給各自檔案的 clearXJob_，不管目前狀態是什麼都清回 idle。 */
function deleteJob(key) {
  if (key === 'analysis') return clearAnalysisJob_();
  if (key === 'backfill') return clearBackfillJob_();
  if (key === 'factorRegression') return clearFactorRegressionJob_();
  if (key === 'materialize') return clearMaterializeJob_();
  if (key === 'backtest') return clearBacktestV17Job_();
  if (key === 'aiTask') return clearAiDiagnosisJob_();
  if (key === 'industryMap') return clearIndustryMapRefreshJob_();
  if (key === 'dailySchedule') return clearDailyScheduleJob_();
  if (key === 'scheduleResume') return clearScheduleResumeJob_();
  throw new Error('未知的工作類型：' + key);
}

/** 九種背景 job 的時間觸發器 handler 函式名稱——「強制清空所有背景工作」只會動這幾個，
 *  不會碰到「每日自動排程」的 CLOCK 觸發器本身（scheduledDailyFetch，見 Scheduler.gs，
 *  那是每天固定時間觸發的核心功能，不是這裡管的一次性背景 job；但它排出來的
 *  processDailyScheduleJobTick_ 一次性續跑觸發器，如果剛好卡在執行中，還是會被這裡清掉，
 *  跟其他背景 job 一樣）。 */
function knownJobTickHandlers_() {
  return ['processAnalysisJobTick_', 'processBackfillJobTick_', 'processFactorRegressionJobTick_',
    'processMaterializeJobTick_', 'processBacktestV17JobTick_', 'processAiDiagnosisJobTick_',
    'processIndustryMapJobTick_', 'processDailyScheduleJobTick_', 'processScheduleResumeJobTick_'];
}

/**
 * 排程佇列的「強制清空所有背景工作」按鈕：把九個 job 的狀態都清回 idle，同時直接掃過整個
 * 專案目前註冊的觸發器列表，刪掉任何 handler 名稱符合這九種 tick 函式的觸發器。
 * 不是只呼叫九個 clearXJob_（那些各自只刪自己認得的 handler，理論上涵蓋範圍一樣，但這裡
 * 用「直接掃過觸發器列表」再確認一次，避免萬一有某個角落遺留、沒有被任何 job 狀態追蹤到
 * 的孤兒觸發器——例如很久以前用過的 handler 名稱、或某次刪除呼叫剛好失敗——這種觸發器
 * 不會出現在排程佇列的任何一張卡片裡，卻仍然會在排定的時間自己觸發、佔用執行配額，
 * 從使用者的角度看就是「感覺卡住了但排程佇列什麼都沒顯示」。
 */
function stopAllJobs() {
  clearAnalysisJob_();
  clearBackfillJob_();
  clearFactorRegressionJob_();
  clearMaterializeJob_();
  clearBacktestV17Job_();
  clearAiDiagnosisJob_();
  clearIndustryMapRefreshJob_();
  clearDailyScheduleJob_();
  clearScheduleResumeJob_();
  var handlers = knownJobTickHandlers_();
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  logRun_('強制清空背景工作', '成功', '已清空 9 個背景 job 狀態，額外刪除 ' + removed + ' 個殘留觸發器', 0);
  return { removedTriggerCount: removed };
}

/**
 * 除錯用：列出整個專案目前所有已註冊的時間觸發器（含「每日自動排程」），確認有沒有預期外
 * 堆積的孤兒觸發器——正常情況下每種 job 同時最多只會有 0 或 1 個觸發器（每次 startXJob 都
 * 會先刪除同 handler 的舊觸發器才建立新的），如果這裡看到同一個 handler 出現兩次以上，
 * 或出現一個現在程式碼裡已經不存在的 handler 名稱，就是有問題（後者會導致該次觸發完全
 * 靜默失敗，Apps Script 找不到對應函式，狀態永遠不會更新）。
 */
function listAllRegisteredTriggers() {
  return ScriptApp.getProjectTriggers().map(function (t) {
    return {
      handlerFunction: t.getHandlerFunction(),
      eventType: String(t.getEventType()),
      triggerSource: String(t.getTriggerSource()),
      uniqueId: t.getUniqueId()
    };
  });
}
