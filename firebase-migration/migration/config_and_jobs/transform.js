/**
 * transform.js
 * 純函式：把從 Script Properties 匯出的設定值跟背景 job 狀態，轉成 Firestore
 * 文件的形狀。跟其他表不一樣的地方——這兩份資料的來源不是 Sheets 的一列列
 * 資料，是 Apps Script PropertiesService 裡一組 key-value（而且全部都是
 * 字串，Script Properties 本身不分型別），所以沒有「一筆 sheetRow 轉一筆
 * doc」的概念，改成「一份 configProps／jobProps 物件轉一份 config/app 文件
 * ／最多 9 份 jobs/{jobKey} 文件」。
 *
 * 對照 firestore/schema.md §8（config/app）、§9（jobs/{jobKey}）。
 *
 * 刻意不處理 API 金鑰（ANTHROPIC_API_KEY／GEMINI_API_KEY）——那兩個金鑰永遠
 * 不該進 Firestore，export-script-properties.gs 本身就沒有讀取這兩個 key，
 * 這裡的 transform 連碰都不會碰到它們。
 */

/** 跟 apps-script/src/Scheduler.gs 的 `isNaN(hour) ? DEFAULT : hour` 邏輯一致：
 *  0 是合法值（例如凌晨 0 點），只有「根本解析不出數字」才退回預設值。 */
function parseIntKeepZero_(raw, fallback) {
  var n = parseInt(raw, 10);
  return isNaN(n) ? fallback : n;
}

/** 跟 apps-script/src/AiDiagnosis.gs 的 `getPricingSettings()` 裡 `num()` 邏輯
 *  一致：0 是合法的價格（例如免費額度內），只有解析不出數字才退回預設值。 */
function parseFloatKeepZero_(raw, fallback) {
  var n = parseFloat(raw);
  return isNaN(n) ? fallback : n;
}

/** 跟 apps-script/src/AiDiagnosis.gs 的 `parseInt(...) || CONFIG.AI_DAILY_TOP_N_DEFAULT`
 *  邏輯一致——這裡故意沿用原本的 `||` 寫法，跟上面兩個 helper 不同：如果使用者
 *  真的把 Top N 設成 0，現行程式碼本來就會當成「沒設定」退回預設值 5，不是
 *  這支遷移工具自己發明的行為差異，是如實保留既有邏輯的既有怪癖。 */
function parseTopNWithLegacyZeroFallback_(raw, fallback) {
  return parseInt(raw, 10) || fallback;
}

/**
 * configProps：export-script-properties.gs 匯出的 JSON 裡 `configProps` 物件，
 * 鍵名是 Script Properties 的原始 key（跟 apps-script/src/Config.gs 的
 * PROP_KEYS 一致），值都是字串或 null（未設定過的 key）。
 * migratedAtIso：這次遷移執行的時間戳記（ISO 字串）。
 *
 * 回傳 config/app 這份單一文件該有的欄位——每個欄位的預設值都照抄對應的
 * apps-script 現行讀取邏輯（Scheduler.gs／AiDiagnosis.gs／BigQuerySync.gs／
 * Analysis.gs），不是這支遷移工具自己發明的預設值。
 */
function buildConfigAppDoc(configProps, migratedAtIso) {
  var p = configProps || {};
  return {
    triggerHour: parseIntKeepZero_(p.TRIGGER_HOUR, 20),
    triggerMinute: parseIntKeepZero_(p.TRIGGER_MINUTE, 30),
    skipWeekends: p.SKIP_WEEKENDS == null ? true : p.SKIP_WEEKENDS === 'true',
    aiProvider: p.AI_PROVIDER === 'gemini' ? 'gemini' : 'claude',
    aiDailyEnabled: p.AI_DAILY_ENABLED === 'true',
    aiDailyTopN: parseTopNWithLegacyZeroFallback_(p.AI_DAILY_TOP_N, 5),
    pricing: {
      claudeInputPerM: parseFloatKeepZero_(p.CLAUDE_PRICE_INPUT, 3),
      claudeOutputPerM: parseFloatKeepZero_(p.CLAUDE_PRICE_OUTPUT, 15),
      geminiInputPerM: parseFloatKeepZero_(p.GEMINI_PRICE_INPUT, 0.3),
      geminiOutputPerM: parseFloatKeepZero_(p.GEMINI_PRICE_OUTPUT, 2.5)
    },
    bigQuery: {
      projectId: p.BIGQUERY_PROJECT_ID || '',
      dataset: p.BIGQUERY_DATASET || 'twse_factor_model',
      sourceMode: p.BIGQUERY_SOURCE_MODE || 'native',
      pricePerTb: parseFloatKeepZero_(p.BIGQUERY_PRICE_PER_TB, 6.25)
    },
    screeningStrategy: p.SCREENING_STRATEGY || 'rule_v17',
    migratedAt: migratedAtIso,
    migratedFrom: 'scriptProperties:config'
  };
}

/** jobKey（Firestore 文件 ID）→ Script Properties 的 key，跟
 *  apps-script/src/JobQueue.gs 的 jobQueueDefs_() 一致。不含 'watchdog'——
 *  那是 Scheduler.gs 的安全網自己在 Firestore 版本第一次跑的時候才會寫入的
 *  新文件，現在 Script Properties 裡還沒有對應的既有資料可以遷移，等 Phase 3
 *  接進 Cloud Functions 之後，它會自然產生，不需要（也沒辦法）用這支工具
 *  提前生出來。 */
var JOB_KEY_TO_PROP_KEY_ = {
  backfill: 'BACKFILL_JOB_STATE',
  analysis: 'ANALYSIS_JOB_STATE',
  factorRegression: 'FACTOR_REGRESSION_JOB_STATE',
  materialize: 'MATERIALIZE_JOB_STATE',
  backtest: 'BACKTEST_JOB_STATE',
  aiTask: 'AI_DIAGNOSIS_JOB_STATE',
  industryMap: 'INDUSTRY_MAP_JOB_STATE',
  dailySchedule: 'DAILY_SCHEDULE_JOB_STATE',
  scheduleResume: 'SCHEDULE_RESUME_JOB_STATE'
};

/** 每個 job 自己的狀態 JSON 形狀都不一樣（見 apps-script/src/DataFetch.gs／
 *  Analysis.gs／BigQuerySync.gs／AiDiagnosis.gs 各自的 saveXJobState_），
 *  這支工具不逐欄位重新定義——整份原樣存進 Firestore（schema.md §9 本來就說
 *  「幾乎可以照搬」）。沒設定過的 job（從來沒執行過）當成 {status:'idle'}；
 *  解析失敗（理論上不該發生，但遷移腳本不該假設來源一定乾淨）保留原始字串，
 *  降級成 {status:'unknown', raw: ...}，不讓一個壞掉的 job 狀態擋掉其他
 *  8 個正常的 job 一起失敗。 */
function parseJobStateJson_(raw) {
  if (raw == null || raw === '') return { status: 'idle' };
  try {
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : { status: 'unknown', raw: String(raw) };
  } catch (e) {
    return { status: 'unknown', raw: String(raw) };
  }
}

/**
 * jobProps：export-script-properties.gs 匯出的 JSON 裡 `jobProps` 物件，
 * 鍵名是 jobKey（backfill/analysis/...），值是對應 Script Properties 裡
 * 存的原始 JSON 字串（或 null，代表這個 job 從來沒執行過、該 key 不存在）。
 * migratedAtIso：這次遷移執行的時間戳記（ISO 字串）。
 *
 * 回傳一個陣列，每個元素是一份 jobs/{jobKey} 文件該有的欄位（含 `id` 當
 * Firestore 文件 ID）。固定回傳 9 筆（JOB_KEY_TO_PROP_KEY_ 裡列的全部
 * jobKey），不會因為某個 job 從來沒執行過就跳過——「這個 job 存在、目前是
 * idle」跟「這個 job 不存在」是不一樣的資訊，都該有一份文件。
 */
function buildJobDocs(jobProps, migratedAtIso) {
  var p = jobProps || {};
  return Object.keys(JOB_KEY_TO_PROP_KEY_).map(function (jobKey) {
    var state = parseJobStateJson_(p[jobKey]);
    var doc = {};
    Object.keys(state).forEach(function (k) { doc[k] = state[k]; });
    doc.id = jobKey;
    doc.migratedAt = migratedAtIso;
    doc.migratedFrom = 'scriptProperties:' + JOB_KEY_TO_PROP_KEY_[jobKey];
    return doc;
  });
}

module.exports = {
  JOB_KEY_TO_PROP_KEY_: JOB_KEY_TO_PROP_KEY_,
  parseJobStateJson_: parseJobStateJson_,
  buildConfigAppDoc: buildConfigAppDoc,
  buildJobDocs: buildJobDocs
};
