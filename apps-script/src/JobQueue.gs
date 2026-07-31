/**
 * JobQueue.gs
 * 「排程佇列」：把目前所有背景 job（重新計算戰報 / 資料範圍重新彙整 / 因子迴歸模型 /
 * 立即重新整理，四個都是各自檔案裡用時間觸發器實作的獨立狀態機，見 Analysis.gs /
 * DataFetch.gs / FactorRegression.gs / BigQuerySync.gs）彙整成同一份清單，給「系統與資料
 * 後台」的排程佇列區塊統一顯示狀態、錯誤內容，並提供「重新啟動」——不用回到各自的頁籤
 * 重新操作一次。只讀彙整 + 轉派重啟，不擁有任何 job 自己的狀態或邏輯。
 */

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
    { key: 'backtest', label: 'v17.0 策略回測', getStatus: getBacktestV17JobStatus }
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
    if (!res || !res.summary) return res && res.warning ? res.warning : '';
    return state.startStr + '~' + state.endStr + '　' + res.summary.signalCount + ' 筆訊號、勝率 ' + res.summary.winRate + '%';
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
    return startBacktestV17Job(backtestState.startStr, backtestState.endStr, backtestState.targetProfit);
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
  throw new Error('未知的工作類型：' + key);
}

/** 五種背景 job 的時間觸發器 handler 函式名稱——「強制清空所有背景工作」只會動這幾個，
 *  不會碰到「每日自動排程」（scheduledDailyFetch，見 Scheduler.gs，那是核心功能本身，
 *  不是這裡管的「背景 job」）。 */
function knownJobTickHandlers_() {
  return ['processAnalysisJobTick_', 'processBackfillJobTick_', 'processFactorRegressionJobTick_',
    'processMaterializeJobTick_', 'processBacktestV17JobTick_'];
}

/**
 * 排程佇列的「強制清空所有背景工作」按鈕：把五個 job 的狀態都清回 idle，同時直接掃過整個
 * 專案目前註冊的觸發器列表，刪掉任何 handler 名稱符合這五種 tick 函式的觸發器。
 * 不是只呼叫五個 clearXJob_（那些各自只刪自己認得的 handler，理論上涵蓋範圍一樣，但這裡
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
  var handlers = knownJobTickHandlers_();
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  logRun_('強制清空背景工作', '成功', '已清空 5 個背景 job 狀態，額外刪除 ' + removed + ' 個殘留觸發器', 0);
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
