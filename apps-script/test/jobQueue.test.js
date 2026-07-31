const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// JobQueue.gs 裡「不呼叫 Apps Script 服務」的純函式（jobQueueDetail_），用跟其他 test 一樣的
// 手法把 .gs 檔案載進共用的 vm context 直接測。getJobQueueOverview_/restartJob 依賴
// PropertiesService/ScriptApp，不在這裡測（跟 DataFetch.gs 的補抓 job、Analysis.gs 的
// 重新計算 job 一樣，屬於只能在真正的 Apps Script 環境驗證的部分）。
const context = { console: console, Number: Number };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('JobQueue.gs');

// --- jobQueueDetail_: backfill ---
{
  assert.strictEqual(context.jobQueueDetail_('backfill', { status: 'idle' }), '');
  const detail = context.jobQueueDetail_('backfill', {
    status: 'running', startStr: '2026-01-01', endStr: '2026-01-31', cursor: '2026-01-15',
    succeeded: ['2026-01-01', '2026-01-02'], failed: [{ date: '2026-01-03', error: 'x' }], skipped: []
  });
  assert.ok(detail.indexOf('2026-01-01 ~ 2026-01-31') !== -1);
  assert.ok(detail.indexOf('成功 2') !== -1);
  assert.ok(detail.indexOf('失敗 1') !== -1);
  assert.ok(detail.indexOf('處理到 2026-01-15') !== -1);
  console.log('Test jobQueueDetail_ (backfill) passed.');
}

// --- jobQueueDetail_: factorRegression ---
{
  assert.strictEqual(context.jobQueueDetail_('factorRegression', { status: 'idle' }), '');
  const detail = context.jobQueueDetail_('factorRegression', {
    status: 'done', l1Reg: 0.05,
    results: [
      { labelName: '後續1個月報酬率', r2: 0.1234 },
      { labelName: '相對大盤抗跌力', error: 'boom' }
    ]
  });
  assert.ok(detail.indexOf('L1正規化強度 0.05') !== -1);
  assert.ok(detail.indexOf('後續1個月報酬率：R²=0.1234') !== -1);
  assert.ok(detail.indexOf('相對大盤抗跌力：失敗') !== -1);
  console.log('Test jobQueueDetail_ (factorRegression) passed.');
}

// --- jobQueueDetail_: analysis ---
{
  assert.strictEqual(context.jobQueueDetail_('analysis', { status: 'running' }), '');

  const noData = context.jobQueueDetail_('analysis', { status: 'done', latestDate: null, scannedCount: 0 });
  assert.ok(noData.indexOf('掃描到 0 檔資料') !== -1, '完全查無資料時要明講「掃描到 0 檔」，不能只講「已完成」');

  const withData = context.jobQueueDetail_('analysis', {
    status: 'done', latestDate: '2026-07-30', reportCount: 12, scannedCount: 1980
  });
  assert.ok(withData.indexOf('2026-07-30') !== -1);
  assert.ok(withData.indexOf('12 檔訊號') !== -1);
  assert.ok(withData.indexOf('共掃描 1980 檔') !== -1);
  console.log('Test jobQueueDetail_ (analysis) passed.');
}

// --- jobQueueDetail_: materialize ---
{
  assert.strictEqual(context.jobQueueDetail_('materialize', { status: 'running' }), '');
  const detail = context.jobQueueDetail_('materialize', {
    status: 'done', fileCount: 3, fileNames: ['2026-01_ALL_COMBINED.csv', '2026-02_ALL_COMBINED.csv', '2026-03_ALL_COMBINED.csv']
  });
  assert.ok(detail.indexOf('涵蓋 3 個來源檔案') !== -1);
  assert.ok(detail.indexOf('2026-01_ALL_COMBINED.csv') !== -1);
  assert.ok(detail.indexOf('2026-02_ALL_COMBINED.csv') !== -1);
  console.log('Test jobQueueDetail_ (materialize) passed.');
}

console.log('All JobQueue.gs tests passed.');
