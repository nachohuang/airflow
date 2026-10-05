/**
 * export-script-properties.gs
 * config/app 跟 jobs/{jobKey} 版遷移匯出腳本：跟其他表不一樣，來源不是
 * Sheets 分頁，是 Apps Script PropertiesService（Script Properties）裡的
 * key-value 設定跟背景 job 狀態。把下面明確列出的 key 讀出來，寫進 Drive
 * 根資料夾一個新檔案，供下載後餵給 import-firestore.js。
 *
 * ⚠️ 這份清單刻意只列出 config/app 跟 jobs/{jobKey} 需要的 key，**不會**讀取
 * ANTHROPIC_API_KEY／GEMINI_API_KEY（或任何其他 Script Properties key）——
 * 那兩個是真正的 API 金鑰，firestore/schema.md 明確說永遠不該進 Firestore，
 * 這支腳本從設計上就不去碰它們，不是「讀出來再小心不要用」，是根本不讀取，
 * 避免金鑰以任何形式出現在匯出的 JSON 檔案裡（那個檔案會先存在 Drive、
 * 下載到本機或 Cloud Shell，比留在 Script Properties 裡多了好幾個可能
 * 外流的環節）。
 *
 * 用法：把這支函式暫時加進既有 Apps Script 專案（任何 .gs 檔案都可以，只要
 * 能呼叫 PropertiesService），在 Apps Script 編輯器手動執行一次
 * exportConfigAndJobsToJson()，執行完在「執行紀錄」看得到輸出檔案的 Drive
 * 連結，下載那個 .json 檔案即可。
 *
 * ⚠️ 函式名稱不能用底線結尾（不是 exportConfigAndJobsToJson_）——Apps Script
 * 編輯器的「執行」下拉選單會把結尾底線的函式當內部函式直接隱藏，找不到不代表
 * 存檔失敗，是這個命名慣例本身被 UI 特殊處理（Watchlist spike 踩過這個坑，見
 * firebase-migration/README.md 的「已知的坑」段落）。
 *
 * 只是一次性的遷移工具，不是常駐功能——用完記得把暫時貼進去的這段函式刪掉、
 * 存檔，恢復原狀；apps-script/ 目錄本身完全沒有被這次遷移動到，現有的設定
 * 跟背景 job 功能繼續正常運作。
 */
function exportConfigAndJobsToJson() {
  var props = PropertiesService.getScriptProperties();

  // 對照 apps-script/src/Config.gs 的 PROP_KEYS，跟 firestore/schema.md §8
  // config/app 這份文件要用到的 key。
  var CONFIG_KEYS = [
    'TRIGGER_HOUR', 'TRIGGER_MINUTE', 'SKIP_WEEKENDS',
    'AI_PROVIDER', 'AI_DAILY_ENABLED', 'AI_DAILY_TOP_N',
    'CLAUDE_PRICE_INPUT', 'CLAUDE_PRICE_OUTPUT', 'GEMINI_PRICE_INPUT', 'GEMINI_PRICE_OUTPUT',
    'BIGQUERY_PROJECT_ID', 'BIGQUERY_DATASET', 'BIGQUERY_SOURCE_MODE', 'BIGQUERY_PRICE_PER_TB',
    'SCREENING_STRATEGY'
  ];

  // jobKey（Firestore 文件 ID，見 firestore/schema.md §9）→ Script Properties
  // 的 key，跟 apps-script/src/JobQueue.gs 的 jobQueueDefs_() 一致。不含
  // 'watchdog'——那份是 Firestore 版排程安全網自己第一次執行時才會產生的新
  // 文件，現在的 Script Properties 裡沒有對應資料可以遷移。
  var JOB_PROP_KEYS = {
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

  var configProps = {};
  CONFIG_KEYS.forEach(function (key) { configProps[key] = props.getProperty(key); });

  var jobProps = {};
  Object.keys(JOB_PROP_KEYS).forEach(function (jobKey) {
    jobProps[jobKey] = props.getProperty(JOB_PROP_KEYS[jobKey]);
  });

  var payload = {
    exportedAt: new Date().toISOString(),
    source: 'ScriptProperties(config+jobs)',
    configProps: configProps,
    jobProps: jobProps
  };
  var json = JSON.stringify(payload, null, 2);
  var fileName = 'config_and_jobs-export-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '.json';
  var file = DriveApp.getRootFolder().createFile(fileName, json, MimeType.PLAIN_TEXT);
  Logger.log('已匯出 config（%s 個 key）+ jobs（%s 個 job），檔案：%s',
    CONFIG_KEYS.length, Object.keys(JOB_PROP_KEYS).length, file.getUrl());
  return { fileUrl: file.getUrl(), fileName: fileName };
}
