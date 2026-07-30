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

/** BigQuery 外部資料表（讀 Google Drive 檔案）要求的 URI 格式。 */
function buildDriveFileUri_(fileId) {
  return 'https://drive.google.com/open?id=' + fileId;
}

/**
 * 去重 view 的 SQL：external 資料表可能同時包含「一次性大彙整檔」跟「每日排程持續累加的月份檔案」，
 * 日期範圍可能重疊，這裡依 (股票代號, 日期) 只留一筆，避免同一天的資料被算兩次。
 */
function buildDedupedViewSql_(externalTableRef, viewRef) {
  return [
    'CREATE OR REPLACE VIEW `' + viewRef + '` AS',
    'SELECT * EXCEPT(rn) FROM (',
    '  SELECT *, ROW_NUMBER() OVER (PARTITION BY stock_id, date_str ORDER BY date_str) AS rn',
    '  FROM `' + externalTableRef + '`',
    ')',
    'WHERE rn = 1'
  ].join('\n');
}

/** 去重 view 目前涵蓋的日期範圍，給「資料總覽」跟開機摘要用。 */
function buildDateBoundsSql_(dedupedViewRef) {
  return 'SELECT MIN(date_str) AS min_date, MAX(date_str) AS max_date, ' +
    'COUNT(DISTINCT date_str) AS trading_days, COUNT(DISTINCT stock_id) AS stock_count, COUNT(*) AS row_count ' +
    'FROM `' + dedupedViewRef + '`';
}

/** 從去重 view 撈出指定日期區間（皆可留空）的原始欄位，給 Apps Script 端的分析邏輯用。 */
function buildHistoryRangeQuerySql_(dedupedViewRef, startStr, endStr) {
  var cols = bqColumnNames_().join(', ');
  var conds = [];
  if (startStr) conds.push("date_str >= '" + startStr + "'");
  if (endStr) conds.push("date_str <= '" + endStr + "'");
  var sql = 'SELECT ' + cols + ' FROM `' + dedupedViewRef + '`';
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  return sql;
}

/**
 * 把 BigQuery 查詢回來的一列（ascii 欄名、全部字串）轉回系統原本用的中文欄名列物件，
 * 數值欄位轉成 number（跟 HistoryFiles.gs 的 parseHistoryCsvText_ 是同一套規則），
 * 讓 Analysis.gs / Backtest.gs / FactorScan.gs / StockAnalysis.gs 完全不用改，
 * 拿到的列物件跟原本讀 Drive CSV 拿到的一模一樣。
 */
function mapBqRowToHistoryRow_(bqRow) {
  var row = {};
  CONFIG.BQ_COLUMN_MAP.forEach(function (m) {
    var v = bqRow[m.bq];
    row[m.cn] = CONFIG.HISTORY_NUMERIC_COLUMNS.indexOf(m.cn) !== -1 ? toNumber(v) : (v === undefined || v === null ? '' : String(v).trim());
  });
  return row;
}

// ---- Apps Script 專屬（需要 BigQuery 進階服務 + DriveApp，無法在 Node.js 測試）----

function getBigQuerySettings() {
  var props = PropertiesService.getScriptProperties();
  return {
    projectId: props.getProperty(CONFIG.PROP_KEYS.BIGQUERY_PROJECT_ID) || '',
    dataset: props.getProperty(CONFIG.PROP_KEYS.BIGQUERY_DATASET) || CONFIG.BIGQUERY_DATASET_DEFAULT,
    sourceMode: props.getProperty(CONFIG.PROP_KEYS.BIGQUERY_SOURCE_MODE) || CONFIG.BIGQUERY_SOURCE_MODE_DEFAULT
  };
}

function setBigQuerySourceMode(mode) {
  var m = (mode === 'external') ? 'external' : 'native';
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.BIGQUERY_SOURCE_MODE, m);
  return getBigQuerySettings();
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

function bqExternalTableRef_(settings) {
  return settings.projectId + '.' + settings.dataset + '.' + CONFIG.BIGQUERY_EXTERNAL_TABLE;
}

function bqDedupedViewRef_(settings) {
  return settings.projectId + '.' + settings.dataset + '.' + CONFIG.BIGQUERY_DEDUPED_VIEW;
}

/**
 * 因子回歸 / 歷史資料查詢實際要讀的來源表：
 *   native   -> history_raw（我們自己同步進去的資料，本身就不會重複，不需要去重）
 *   external -> history_deduped（外部資料表去重後的 view，涵蓋 Drive 資料夾裡所有 CSV 檔案）
 */
function bqActiveSourceTableRef_(settings) {
  return settings.sourceMode === 'external' ? bqDedupedViewRef_(settings) : bqRawTableRef_(settings);
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

/** 歷史資料夾裡所有看起來是 CSV 的檔案 ID（不分是一次性大彙整檔還是每日排程的月份檔案）。 */
function listAllHistoryCsvFileIds_() {
  var folder = getArchiveFolder_();
  var it = folder.getFiles();
  var ids = [];
  while (it.hasNext()) {
    var f = it.next();
    if (/\.csv$/i.test(f.getName())) ids.push(f.getId());
  }
  return ids;
}

/**
 * External 模式：建立（或重建）一個指向 Drive 檔案的 BigQuery 外部資料表，查詢時 BigQuery 直接讀
 * Drive 上的檔案內容，Apps Script 完全不會去讀這些檔案，也就不會撞到 Drive 大檔案讀取上限。
 * 一次涵蓋資料夾裡「所有」CSV 檔案（一次性大彙整檔 + 每日排程持續累加的月份檔案），
 * 日期範圍重疊的部分交給 history_deduped view 去重，這裡不用自己挑「哪一個檔案」。
 * 缺點：查詢速度比 native 模式（先載入 BigQuery 原生儲存）慢，檔案越大/越多越明顯。
 */
function ensureExternalHistoryTable_(settings, fileIds) {
  var tableId = CONFIG.BIGQUERY_EXTERNAL_TABLE;
  try {
    BigQuery.Tables.remove(settings.projectId, settings.dataset, tableId);
  } catch (e) {
    // 表不存在就算了，繼續往下建立新的
  }
  BigQuery.Tables.insert({
    tableReference: { projectId: settings.projectId, datasetId: settings.dataset, tableId: tableId },
    type: 'EXTERNAL',
    externalDataConfiguration: {
      sourceFormat: 'CSV',
      sourceUris: fileIds.map(buildDriveFileUri_),
      autodetect: false,
      csvOptions: { skipLeadingRows: 1, allowJaggedRows: true, allowQuotedNewlines: true },
      schema: { fields: bqColumnNames_().map(function (name) { return { name: name, type: 'STRING' }; }) }
    }
  }, settings.projectId, settings.dataset);
}

function ensureDedupedView_(settings) {
  runBqQuery_(buildDedupedViewSql_(bqExternalTableRef_(settings), bqDedupedViewRef_(settings)));
}

/**
 * 把 external 資料表重新指向歷史資料夾裡「目前所有」CSV 檔案，並重建去重 view。
 * 這是純 metadata + 一次 view 定義操作（不會讀檔案內容），所以再大/再多的檔案也不會卡住。
 * 執行因子迴歸、或任何一次核心功能的歷史查詢（external 模式）前都會自動呼叫這個函式，不用手動同步。
 */
function refreshExternalHistoryTable() {
  var settings = requireBigQueryProjectId_();
  ensureBigQueryDataset_(settings);
  var fileIds = listAllHistoryCsvFileIds_();
  if (fileIds.length === 0) throw new Error('歷史資料夾裡沒有任何 CSV 檔案，無法建立外部資料表。');
  ensureExternalHistoryTable_(settings, fileIds);
  ensureDedupedView_(settings);
  return { fileCount: fileIds.length };
}

/**
 * External 模式下，核心功能（今日戰報／個股分析／回測研究／因子相關性掃描）取得歷史資料列的入口，
 * 取代原本直接讀 Drive 月份檔案的 readRecentHistoryFromFiles_ / readHistoryRangeFromFiles_
 * （見 SheetUtils.gs 的 readRecentHistory_ / readHistoryRange_，依目前的資料來源模式決定要呼叫哪一個）。
 * 回傳格式（中文欄名、數值已轉型）跟原本讀 Drive CSV 完全一樣，下游計算邏輯不用改。
 */
function queryHistoryRowsFromBigQuery_(startStr, endStr) {
  var settings = requireBigQueryProjectId_();
  refreshExternalHistoryTable();
  var rows = runBqQuery_(buildHistoryRangeQuerySql_(bqDedupedViewRef_(settings), startStr, endStr));
  return rows.map(mapBqRowToHistoryRow_);
}

/** External 模式下的資料範圍摘要（開機資訊 + 「資料總覽」頁籤用），取代讀 Drive 月份檔案算出來的版本。 */
function getHistoryDateBoundsFromBigQuery_() {
  var settings = requireBigQueryProjectId_();
  refreshExternalHistoryTable();
  var rows = runBqQuery_(buildDateBoundsSql_(bqDedupedViewRef_(settings)));
  if (!rows.length || !rows[0].min_date) return { min: null, max: null, tradingDays: 0, stockCount: 0, rowCount: 0 };
  return {
    min: rows[0].min_date,
    max: rows[0].max_date,
    tradingDays: parseInt(rows[0].trading_days, 10),
    stockCount: parseInt(rows[0].stock_count, 10),
    rowCount: parseInt(rows[0].row_count, 10)
  };
}

/** 前端「資料總覽」頁籤：目前資料來源模式下的描述性統計摘要。 */
function getHistoryOverview() {
  var settings = getBigQuerySettings();
  if (settings.projectId && settings.sourceMode === 'external') {
    var bounds = getHistoryDateBoundsFromBigQuery_();
    return {
      mode: 'external',
      min: bounds.min,
      max: bounds.max,
      tradingDays: bounds.tradingDays,
      stockCount: bounds.stockCount,
      rowCount: bounds.rowCount
    };
  }
  var fileBounds = getHistoryDateBounds();
  return {
    mode: 'native',
    min: fileBounds.min,
    max: fileBounds.max,
    monthsAvailable: fileBounds.monthsAvailable
  };
}
