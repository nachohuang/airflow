const assert = require('assert');
const { JOB_KEY_TO_PROP_KEY_, buildConfigAppDoc, buildJobDocs } = require('../transform');

// --- buildConfigAppDoc：全部 key 都有值的正常情況 ---
{
  const configProps = {
    TRIGGER_HOUR: '9', TRIGGER_MINUTE: '5', SKIP_WEEKENDS: 'false',
    AI_PROVIDER: 'gemini', AI_DAILY_ENABLED: 'true', AI_DAILY_TOP_N: '7',
    CLAUDE_PRICE_INPUT: '4', CLAUDE_PRICE_OUTPUT: '20', GEMINI_PRICE_INPUT: '0.5', GEMINI_PRICE_OUTPUT: '3',
    BIGQUERY_PROJECT_ID: 'my-project', BIGQUERY_DATASET: 'my_dataset', BIGQUERY_SOURCE_MODE: 'materialized', BIGQUERY_PRICE_PER_TB: '7',
    SCREENING_STRATEGY: 'rule_v18'
  };
  const doc = buildConfigAppDoc(configProps, '2026-10-05T00:00:00.000Z');
  assert.strictEqual(doc.triggerHour, 9);
  assert.strictEqual(doc.triggerMinute, 5);
  assert.strictEqual(doc.skipWeekends, false);
  assert.strictEqual(doc.aiProvider, 'gemini');
  assert.strictEqual(doc.aiDailyEnabled, true);
  assert.strictEqual(doc.aiDailyTopN, 7);
  assert.deepStrictEqual(doc.pricing, { claudeInputPerM: 4, claudeOutputPerM: 20, geminiInputPerM: 0.5, geminiOutputPerM: 3 });
  assert.deepStrictEqual(doc.bigQuery, { projectId: 'my-project', dataset: 'my_dataset', sourceMode: 'materialized', pricePerTb: 7 });
  assert.strictEqual(doc.screeningStrategy, 'rule_v18');
  assert.strictEqual(doc.migratedFrom, 'scriptProperties:config');
  assert.strictEqual(doc.migratedAt, '2026-10-05T00:00:00.000Z');
  console.log('Test buildConfigAppDoc (all keys set) passed.');
}

// --- buildConfigAppDoc：全部 key 都沒設定過（null）時，要套用跟
//    apps-script 現行讀取邏輯一致的預設值 ---
{
  const doc = buildConfigAppDoc({}, 'x');
  assert.strictEqual(doc.triggerHour, 20, '跟 Scheduler.gs 的 DEFAULT_TRIGGER_HOUR 一致');
  assert.strictEqual(doc.triggerMinute, 30, '跟 Scheduler.gs 的 DEFAULT_TRIGGER_MINUTE 一致');
  assert.strictEqual(doc.skipWeekends, true, '沒設定過時預設跳過週末');
  assert.strictEqual(doc.aiProvider, 'claude');
  assert.strictEqual(doc.aiDailyEnabled, false);
  assert.strictEqual(doc.aiDailyTopN, 5);
  assert.deepStrictEqual(doc.pricing, { claudeInputPerM: 3, claudeOutputPerM: 15, geminiInputPerM: 0.3, geminiOutputPerM: 2.5 });
  assert.deepStrictEqual(doc.bigQuery, { projectId: '', dataset: 'twse_factor_model', sourceMode: 'native', pricePerTb: 6.25 });
  assert.strictEqual(doc.screeningStrategy, 'rule_v17');
  console.log('Test buildConfigAppDoc (all keys unset -> defaults match apps-script logic) passed.');
}

// --- buildConfigAppDoc：triggerHour/triggerMinute/價格欄位是 0 時要保留 0，
//    不能被當成「沒設定」退回預設值——跟 Scheduler.gs 的 isNaN 判斷、
//    AiDiagnosis.gs 的 num() 判斷一致 ---
{
  const doc = buildConfigAppDoc({ TRIGGER_HOUR: '0', TRIGGER_MINUTE: '0', CLAUDE_PRICE_INPUT: '0' }, 'x');
  assert.strictEqual(doc.triggerHour, 0, '凌晨 0 點是合法值，不該退回預設 20');
  assert.strictEqual(doc.triggerMinute, 0);
  assert.strictEqual(doc.pricing.claudeInputPerM, 0, '0 元是合法的價格設定，不該退回預設值');
  console.log('Test buildConfigAppDoc (zero values preserved, not treated as unset) passed.');
}

// --- buildConfigAppDoc：aiDailyTopN 是 0 時，要照抄 AiDiagnosis.gs 原本的
//    `|| DEFAULT` 怪癖退回預設值 5——這跟上面「0 要保留」是刻意不同的行為，
//    因為現行程式碼本身就是這樣寫的 ---
{
  const doc = buildConfigAppDoc({ AI_DAILY_TOP_N: '0' }, 'x');
  assert.strictEqual(doc.aiDailyTopN, 5, '照抄現行 `parseInt(...) || DEFAULT` 的既有怪癖');
  console.log('Test buildConfigAppDoc (aiDailyTopN 0 falls back to default, matching legacy `||` quirk) passed.');
}

// --- buildJobDocs：固定回傳 9 筆，即使全部都沒執行過（null），各自是
//    {status:'idle'} ---
{
  const docs = buildJobDocs({}, 'x');
  assert.strictEqual(docs.length, Object.keys(JOB_KEY_TO_PROP_KEY_).length);
  docs.forEach(function (doc) {
    assert.strictEqual(doc.status, 'idle');
    assert.strictEqual(doc.migratedFrom, 'scriptProperties:' + JOB_KEY_TO_PROP_KEY_[doc.id]);
  });
  console.log('Test buildJobDocs (all unset -> 9 idle docs) passed.');
}

// --- buildJobDocs：正常情況，某個 job 有真實的狀態 JSON，整份原樣帶過去 ---
{
  const jobProps = {
    backfill: JSON.stringify({ status: 'running', startStr: '2026-08-01', endStr: '2026-08-05', cursor: '2026-08-03', succeeded: ['2026-08-01'], failed: [], skipped: [] })
  };
  const docs = buildJobDocs(jobProps, '2026-10-05T00:00:00.000Z');
  const backfillDoc = docs.find(function (d) { return d.id === 'backfill'; });
  assert.strictEqual(backfillDoc.status, 'running');
  assert.strictEqual(backfillDoc.startStr, '2026-08-01');
  assert.strictEqual(backfillDoc.cursor, '2026-08-03');
  assert.deepStrictEqual(backfillDoc.succeeded, ['2026-08-01']);
  assert.strictEqual(backfillDoc.migratedAt, '2026-10-05T00:00:00.000Z');
  console.log('Test buildJobDocs (real job state JSON passed through as-is) passed.');
}

// --- buildJobDocs：壞掉的 JSON（理論上不該發生，但不該讓一個壞掉的 job
//    擋掉其他 8 個正常的一起失敗）---
{
  const docs = buildJobDocs({ analysis: '{not valid json' }, 'x');
  const analysisDoc = docs.find(function (d) { return d.id === 'analysis'; });
  assert.strictEqual(analysisDoc.status, 'unknown');
  assert.strictEqual(analysisDoc.raw, '{not valid json');
  const otherDoc = docs.find(function (d) { return d.id === 'backtest'; });
  assert.strictEqual(otherDoc.status, 'idle', '壞掉的 analysis 不該影響其他 job 的轉換結果');
  console.log('Test buildJobDocs (corrupt JSON for one job does not break the rest) passed.');
}

console.log('All transform.js tests passed.');
