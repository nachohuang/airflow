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

// --- jobQueueDetail_: backtest ---
{
  assert.strictEqual(context.jobQueueDetail_('backtest', { status: 'running' }), '');

  const withWarning = context.jobQueueDetail_('backtest', {
    status: 'done', startStr: '2026-07-01', endStr: '2026-07-31',
    result: { warning: '這段區間內沒有符合 v17.0 進場條件的訊號。' }
  });
  assert.ok(withWarning.indexOf('沒有符合') !== -1);

  const withResult = context.jobQueueDetail_('backtest', {
    status: 'done', startStr: '2026-07-01', endStr: '2026-07-31',
    result: { summary: { signalCount: 23, winRate: 68.5 } }
  });
  assert.ok(withResult.indexOf('2026-07-01~2026-07-31') !== -1);
  assert.ok(withResult.indexOf('23 筆訊號') !== -1);
  assert.ok(withResult.indexOf('勝率 68.5%') !== -1);

  // mode='all'：三種策略各自的結果（含成功/無訊號/缺模型三種情況）都要並列顯示，
  // 不能因為其中一版失敗就整條摘要都不見
  const allModeResult = context.jobQueueDetail_('backtest', {
    status: 'done', mode: 'all', startStr: '2026-07-01', endStr: '2026-07-31',
    result: {
      results: {
        rule_v17: { strategyLabel: 'v17.0 規則式門檻（現行）', summary: { winRate: 68.5 } },
        factor_model_rank: { strategyLabel: '因子模型排名精選', error: '需要先套用一版抗跌力因子迴歸模型' },
        hybrid: { strategyLabel: '規則式門檻＋模型排名混合', warning: '這段區間內沒有符合條件的訊號。' }
      }
    }
  });
  assert.ok(allModeResult.indexOf('v17.0 規則式門檻（現行）：勝率 68.5%') !== -1);
  assert.ok(allModeResult.indexOf('因子模型排名精選：需要先套用一版抗跌力因子迴歸模型') !== -1);
  assert.ok(allModeResult.indexOf('規則式門檻＋模型排名混合：這段區間內沒有符合條件的訊號。') !== -1);
  console.log('Test jobQueueDetail_ (backtest) passed.');
}

// --- jobQueueDetail_: aiTask ---
{
  assert.strictEqual(context.jobQueueDetail_('aiTask', { status: 'running' }), '');

  const holdDone = context.jobQueueDetail_('aiTask', {
    status: 'done', taskType: 'hold', payload: { code: '5434' },
    result: { ok: true, code: '5434', verdict: '強力續抱' }
  });
  assert.ok(holdDone.indexOf('持股續抱診斷') !== -1);
  assert.ok(holdDone.indexOf('5434') !== -1);
  assert.ok(holdDone.indexOf('強力續抱') !== -1);

  const holdFailed = context.jobQueueDetail_('aiTask', {
    status: 'done', taskType: 'hold', payload: { code: '5434' },
    result: { ok: false, code: '5434', error: 'API 金鑰未設定' }
  });
  assert.ok(holdFailed.indexOf('失敗：API 金鑰未設定') !== -1, '任務本身失敗（ok:false）也要能看出原因，不能只顯示空白');

  // diagnosis 是批次的（一次可能對多個代號跑），結果是陣列，每個代號各自的成功/失敗都要列出
  const diagnosisDone = context.jobQueueDetail_('aiTask', {
    status: 'done', taskType: 'diagnosis', payload: { codes: ['2603', '2890'] },
    result: [
      { ok: true, code: '2603', verdict: '分批布局' },
      { ok: false, code: '2890', error: '抓取 Goodinfo 失敗' }
    ]
  });
  assert.ok(diagnosisDone.indexOf('2603, 2890') !== -1);
  assert.ok(diagnosisDone.indexOf('2603：分批布局') !== -1);
  assert.ok(diagnosisDone.indexOf('2890：失敗') !== -1);

  const topPicksDone = context.jobQueueDetail_('aiTask', {
    status: 'done', taskType: 'topPicks', payload: null,
    result: { ok: true, date: '2026-08-03', candidateCount: 12, text: '...' }
  });
  assert.ok(topPicksDone.indexOf('Top3 橫向比較') !== -1);
  console.log('Test jobQueueDetail_ (aiTask) passed.');
}

// --- jobQueueDetail_: industryMap ---
{
  assert.strictEqual(context.jobQueueDetail_('industryMap', { status: 'running' }), '');

  const done = context.jobQueueDetail_('industryMap', {
    status: 'done',
    result: {
      totalCount: 980, twseCount: 980, tpexCount: 0,
      coverage: { checked: true, coveragePct: 49.2 },
      tpexWarning: '上櫃（TPEX）產業別資料源尚未確認正確的 API 路徑，目前只有上市股票有產業別資料。'
    }
  });
  assert.ok(done.indexOf('共 980 筆') !== -1);
  assert.ok(done.indexOf('上市 980，上櫃 0') !== -1);
  assert.ok(done.indexOf('涵蓋率 49.2%') !== -1);
  assert.ok(done.indexOf('尚未確認正確的 API 路徑') !== -1, '上櫃資料源還沒接上時，警告要顯示在排程佇列摘要裡讓使用者看到');
  console.log('Test jobQueueDetail_ (industryMap) passed.');
}

console.log('All JobQueue.gs tests passed.');
