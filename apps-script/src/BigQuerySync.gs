/**
 * BigQuerySync.gs
 * 把 Drive 上「每月一份」的歷史資料 CSV（HistoryFiles.gs）同步進 BigQuery 的原始表。
 * 這是「因子回歸模型」（FactorRegression.gs）的資料來源 —— Apps Script 本身不再需要
 * 一次讀進全部歷史來做迴歸，只需要把每個月的小檔案個別餵給 BigQuery，交給 BigQuery 做大量計算。
 *
 * 選用進階功能：需要使用者自己把這個 Apps Script 專案的 GCP 專案換成一個標準專案、
 * 啟用 BigQuery API + 綁定帳單帳戶，並在 Apps Script 編輯器「服務」加上 BigQuery 進階服務
 * （appsscript.json 已經預先宣告好 enabledAdvancedServices，但綁定 GCP 專案這一步只有
 * 使用者自己能做，跟 clasp login 一樣不能在這裡代勞）。詳見 README「因子回歸模型」章節。
 *
 * 每次同步只讀「一個月」的檔案內容，避免重演「一次讀整份大檔案很慢」的問題：
 *   1) 讀該月 CSV 原始文字（不重新解析成列陣列，只置換標題列，省掉一次全量 parse）
 *   2) 對 BigQuery 下一個 DELETE query，砍掉該月日期區間既有的資料（保持可重複執行、不會重複）
 *   3) 用 load job 把該月 CSV blob 直接餵進 BigQuery（WRITE_APPEND）
 */

// ---- 純函式（不碰 BigQuery / DriveApp，可在 Node.js 直接測試）----

/** BigQuery 資料表的欄位順序（ascii），對應 CONFIG.HISTORY_COLUMNS 的順序。 */
function bqColumnNames_() {
  return CONFIG.BQ_COLUMN_MAP.map(function (m) { return m.bq; });
}

/**
 * 把月份 CSV 原始文字的「標題列」換成 BigQuery 用的 ascii 欄名，其餘資料列原封不動。
 * 只做字串置換（不逐列 parse），所以即使檔案有幾千列也很快。
 */
function remapCsvHeaderToBigQuery_(csvText) {
  var text = csvText;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  var newlineIdx = text.indexOf('\n');
  var rest = newlineIdx === -1 ? '' : text.slice(newlineIdx + 1);
  return bqColumnNames_().join(',') + '\n' + rest;
}

/** 'yyyy-mm' -> 該月第一天/最後一天的 'yyyy-mm-dd'。 */
function monthStartEnd_(monthKey) {
  var parts = monthKey.split('-');
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10);
  var lastDay = new Date(year, month, 0).getDate();
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return {
    start: monthKey + '-01',
    end: monthKey + '-' + pad(lastDay)
  };
}

/** 刪除某個月份既有資料的 SQL（同步前先清掉，避免 WRITE_APPEND 造成重複列）。 */
function buildDeleteMonthSql_(fullTableRef, monthKey) {
  var range = monthStartEnd_(monthKey);
  return 'DELETE FROM `' + fullTableRef + '` WHERE date_str >= \'' + range.start + '\' AND date_str <= \'' + range.end + '\'';
}

// ---- Apps Script 專屬（需要 BigQuery 進階服務 + DriveApp，無法在 Node.js 測試）----

function getBigQuerySettings() {
  var props = PropertiesService.getScriptProperties();
  return {
    projectId: props.getProperty(CONFIG.PROP_KEYS.BIGQUERY_PROJECT_ID) || '',
    dataset: props.getProperty(CONFIG.PROP_KEYS.BIGQUERY_DATASET) || CONFIG.BIGQUERY_DATASET_DEFAULT
  };
}

function setBigQuerySettings(projectId, dataset) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(CONFIG.PROP_KEYS.BIGQUERY_PROJECT_ID, String(projectId || '').trim());
  props.setProperty(CONFIG.PROP_KEYS.BIGQUERY_DATASET, String(dataset || CONFIG.BIGQUERY_DATASET_DEFAULT).trim());
  return getBigQuerySettings();
}

function requireBigQueryProjectId_() {
  var settings = getBigQuerySettings();
  if (!settings.projectId) {
    throw new Error('還沒設定 BigQuery 專案 ID，請先在「因子回歸模型」設定裡填入你的 GCP 專案 ID。');
  }
  return settings;
}

function bqRawTableRef_(settings) {
  return settings.projectId + '.' + settings.dataset + '.' + CONFIG.BIGQUERY_RAW_TABLE;
}

function bqFeatureViewRef_(settings) {
  return settings.projectId + '.' + settings.dataset + '.' + CONFIG.BIGQUERY_FEATURE_VIEW;
}

function ensureBigQueryDataset_(settings) {
  try {
    BigQuery.Datasets.get(settings.projectId, settings.dataset);
  } catch (e) {
    BigQuery.Datasets.insert({
      datasetReference: { projectId: settings.projectId, datasetId: settings.dataset },
      location: CONFIG.BIGQUERY_LOCATION
    }, settings.projectId);
  }
}

function ensureRawTable_(settings) {
  try {
    BigQuery.Tables.get(settings.projectId, settings.dataset, CONFIG.BIGQUERY_RAW_TABLE);
  } catch (e) {
    var schema = { fields: bqColumnNames_().map(function (name) { return { name: name, type: 'STRING' }; }) };
    BigQuery.Tables.insert({
      tableReference: { projectId: settings.projectId, datasetId: settings.dataset, tableId: CONFIG.BIGQUERY_RAW_TABLE },
      schema: schema
    }, settings.projectId, settings.dataset);
  }
}

/** 執行一段 SQL（DML 或 query），等到 job 跑完，回傳 rows（查詢類）或 null（DML 類）。 */
function runBqQuery_(sql) {
  var settings = requireBigQueryProjectId_();
  var job = BigQuery.Jobs.query({
    query: sql,
    useLegacySql: false,
    location: CONFIG.BIGQUERY_LOCATION,
    timeoutMs: 30000
  }, settings.projectId);

  job = waitForBqJob_(settings.projectId, job.jobReference.jobId, job.jobReference.location || CONFIG.BIGQUERY_LOCATION);

  if (!job.schema || !job.rows) return [];
  var fields = job.schema.fields.map(function (f) { return f.name; });
  return job.rows.map(function (row) {
    var obj = {};
    row.f.forEach(function (cell, i) { obj[fields[i]] = cell.v; });
    return obj;
  });
}

/** 輪詢 Jobs.getQueryResults 直到完成，回傳最終結果（含 rows/schema，若有）。 */
function waitForBqJob_(projectId, jobId, location) {
  var deadline = Date.now() + 4 * 60 * 1000; // 留給 Apps Script 6 分鐘上限一些餘裕
  while (Date.now() < deadline) {
    var result = BigQuery.Jobs.getQueryResults(projectId, jobId, { location: location });
    if (result.jobComplete) {
      if (result.errors && result.errors.length > 0) {
        throw new Error('BigQuery 查詢失敗：' + result.errors.map(function (e) { return e.message; }).join('; '));
      }
      return result;
    }
    Utilities.sleep(1000);
  }
  throw new Error('BigQuery 查詢逾時（超過 4 分鐘），可能是資料量太大，稍後再試一次。');
}

/** 把某個月份的 CSV 檔案內容（換過欄名）用 load job 塞進 BigQuery 原始表。 */
function loadMonthIntoBigQuery_(settings, monthKey) {
  var file = findMonthlyFile_(monthKey);
  if (!file) return { monthKey: monthKey, loaded: 0, skipped: true };

  var text = file.getBlob().getDataAsString('UTF-8');
  var remapped = remapCsvHeaderToBigQuery_(text);
  var blob = Utilities.newBlob(remapped, 'text/csv', monthKey + '.csv');

  runBqQuery_(buildDeleteMonthSql_(bqRawTableRef_(settings), monthKey));

  var job = BigQuery.Jobs.insert({
    configuration: {
      load: {
        destinationTable: {
          projectId: settings.projectId,
          datasetId: settings.dataset,
          tableId: CONFIG.BIGQUERY_RAW_TABLE
        },
        sourceFormat: 'CSV',
        skipLeadingRows: 1,
        writeDisposition: 'WRITE_APPEND',
        schema: { fields: bqColumnNames_().map(function (name) { return { name: name, type: 'STRING' }; }) }
      }
    }
  }, settings.projectId, blob);

  waitForBqJob_(settings.projectId, job.jobReference.jobId, job.jobReference.location || CONFIG.BIGQUERY_LOCATION);
  return { monthKey: monthKey, loaded: true };
}

/**
 * 同步「一個」月份到 BigQuery（讀檔/刪除/載入）。前端一次只呼叫一個月份、逐一顯示進度，
 * 比一次處理全部月份更看得到現在同步到哪個檔案，資料量大時也不會卡在單一次執行裡看不到狀態。
 */
function syncOneMonthToBigQuery(monthKey) {
  var settings = requireBigQueryProjectId_();
  ensureBigQueryDataset_(settings);
  ensureRawTable_(settings);
  var startTime = Date.now();
  var result = loadMonthIntoBigQuery_(settings, monthKey);
  logRun_('BigQuery 同步', result.skipped ? '略過' : '成功',
    (result.skipped ? '找不到月份檔案：' : '已同步：') + monthlyFileName_(monthKey),
    Math.round((Date.now() - startTime) / 1000));
  return result;
}

/**
 * 同步全部（或部分）月份到 BigQuery——保留給不需要逐月進度顯示的呼叫方式用（例如排程自動同步）。
 * 前端「同步歷史資料到 BigQuery」按鈕改用 listSyncableMonths() + syncOneMonthToBigQuery() 逐月呼叫，
 * 才能顯示「現在同步到哪個檔案」的進度。
 */
function syncHistoryToBigQuery(monthKeys) {
  var months = monthKeys && monthKeys.length ? monthKeys : listAvailableMonths_();
  var done = [];
  var startTime = Date.now();
  var budgetMs = 4.5 * 60 * 1000;

  for (var i = 0; i < months.length; i++) {
    if (Date.now() - startTime > budgetMs) {
      var remaining = months.slice(i);
      logRun_('BigQuery 同步', '部分完成', '已同步 ' + done.join(',') + '，剩餘 ' + remaining.join(','), Math.round((Date.now() - startTime) / 1000));
      return { doneMonths: done, remainingMonths: remaining };
    }
    syncOneMonthToBigQuery(months[i]);
    done.push(months[i]);
  }

  return { doneMonths: done, remainingMonths: [] };
}

/** 前端用：列出目前 Drive 上有哪些月份可以同步。 */
function listSyncableMonths() {
  return listAvailableMonths_();
}
