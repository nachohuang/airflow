/**
 * JobQueue.gs
 * 「排程佇列」：把目前所有背景 job（重新計算戰報 / 資料範圍重新彙整 / 因子迴歸模型，
 * 三個都是各自檔案裡用時間觸發器實作的獨立狀態機，見 Analysis.gs / DataFetch.gs /
 * FactorRegression.gs）彙整成同一份清單，給「系統與資料後台」的排程佇列區塊統一顯示
 * 狀態、錯誤內容，並提供「重新啟動」——不用回到各自的頁籤重新操作一次。
 * 只讀彙整 + 轉派重啟，不擁有任何 job 自己的狀態或邏輯。
 */

/** 刻意延後到呼叫時才組出這份清單（而不是檔案最上層的 var）：Apps Script 不保證多個 .gs
 *  檔案裡「最上層程式碼」的執行順序，函式宣告本身沒問題，但如果在最上層就直接把其他檔案
 *  的函式當值取出來，遇到載入順序不巧排在該檔案前面就會出錯；包在函式裡面只在真的被呼叫
 *  時（一定是所有檔案都載入完畢後的某次請求）才取用，就不受載入順序影響。 */
function jobQueueDefs_() {
  return [
    { key: 'analysis', label: '重新計算戰報', getStatus: getAnalysisJobStatus },
    { key: 'backfill', label: '資料範圍重新彙整', getStatus: getBackfillJobStatus },
    { key: 'factorRegression', label: '因子迴歸模型', getStatus: getFactorRegressionJobStatus }
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
    return '已重新計算完成，戰報頁會顯示最新結果';
  }
  return '';
}

/** 前端「排程佇列」區塊呼叫：回傳三個背景 job 目前各自的狀態、進度摘要、能不能重啟。 */
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
      canRestart: status === 'error' || (def.key === 'backfill' && status === 'cancelled')
    };
  });
}

/** 排程佇列的「重新啟動」按鈕呼叫：用該 job 上一次的參數重新排一次背景工作。 */
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
  throw new Error('未知的工作類型：' + key);
}
