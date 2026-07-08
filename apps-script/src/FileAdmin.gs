/**
 * FileAdmin.gs
 * 「後台管理」頁面：瀏覽/刪除 Config.gs 定義的三個 Drive 資料夾裡的檔案，
 * 並提供把 History / 回測 / 因子掃描結果封存成檔案的動作（讓這些資料夾裡真的有東西可以管理）。
 * 刪除採「移到垃圾桶」而非永久刪除，保留復原空間。
 */

function folderByKey_(key) {
  if (key === 'archive') return getArchiveFolder_();
  if (key === 'reports') return getReportsFolder_();
  if (key === 'regression') return getRegressionFolder_();
  throw new Error('未知的資料夾: ' + key);
}

function formatBytes_(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  var units = ['KB', 'MB', 'GB'];
  var v = bytes;
  for (var i = 0; i < units.length; i++) {
    v = v / 1024;
    if (v < 1024 || i === units.length - 1) return v.toFixed(1) + ' ' + units[i];
  }
}

/** 供前端列出某個資料夾（archive/reports/regression）裡的檔案。 */
function listFiles(folderKey) {
  var folder = folderByKey_(folderKey);
  var it = folder.getFiles();
  var out = [];
  while (it.hasNext()) {
    var f = it.next();
    out.push({
      id: f.getId(),
      name: f.getName(),
      sizeBytes: f.getSize(),
      sizeLabel: formatBytes_(f.getSize()),
      updated: Utilities.formatDate(f.getLastUpdated(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm'),
      url: f.getUrl()
    });
  }
  out.sort(function (a, b) { return a.updated < b.updated ? 1 : -1; });
  return out;
}

/** 三個資料夾的總覽（檔案數/總大小），給後台管理首頁用。 */
function getFolderSummary() {
  var keys = ['archive', 'reports', 'regression'];
  var labels = {
    archive: CONFIG.ARCHIVE_FOLDER_NAME,
    reports: CONFIG.REPORTS_FOLDER_NAME,
    regression: CONFIG.REGRESSION_FOLDER_NAME
  };
  return keys.map(function (k) {
    var files = listFiles(k);
    var totalBytes = files.reduce(function (s, f) { return s + f.sizeBytes; }, 0);
    return {
      key: k,
      label: labels[k],
      fileCount: files.length,
      totalSizeLabel: formatBytes_(totalBytes),
      folderUrl: folderByKey_(k).getUrl()
    };
  });
}

/** 刪除（移至垃圾桶）指定檔案。 */
function deleteFile(fileId) {
  var file = DriveApp.getFileById(fileId);
  var name = file.getName();
  file.setTrashed(true);
  logRun_('後台管理', '成功', '刪除檔案（移至垃圾桶）：' + name, 0);
  return { ok: true };
}

function rowsToCsv_(columns, rows) {
  var lines = [columns.join(',')];
  rows.forEach(function (r) {
    lines.push(columns.map(function (c) {
      var v = r[c];
      if (v === null || v === undefined) v = '';
      v = String(v);
      if (v.indexOf(',') !== -1 || v.indexOf('"') !== -1 || v.indexOf('\n') !== -1) {
        v = '"' + v.replace(/"/g, '""') + '"';
      }
      return v;
    }).join(','));
  });
  return lines.join('\n');
}

/**
 * 把超過 CONFIG.HISTORY_RETENTION_DAYS 的舊 History 資料封存成 CSV 存進 Archive 資料夾，
 * 再從 History 分頁移除，避免 Sheets 撞到 10,000,000 格的硬上限。
 * 由 SheetUtils.upsertHistoryRows_ 在每次寫入資料後自動呼叫，不需要手動觸發。
 */
function archiveOldHistory_() {
  var sheet = getHistorySheet_();
  var rows = readSheetObjects_(sheet);
  if (rows.length === 0) return { archived: 0 };

  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.HISTORY_RETENTION_DAYS);
  var cutoffStr = normalizeDateStr(cutoff);

  var oldRows = rows.filter(function (r) { return normalizeDateStr(r['日期']) < cutoffStr; });
  if (oldRows.length === 0) return { archived: 0 };

  var dates = oldRows.map(function (r) { return normalizeDateStr(r['日期']); });
  var minD = dates.reduce(function (a, b) { return a < b ? a : b; });
  var maxD = dates.reduce(function (a, b) { return a > b ? a : b; });
  var csv = '\uFEFF' + rowsToCsv_(CONFIG.HISTORY_COLUMNS, oldRows);
  var fileName = minD.replace(/-/g, '') + '_' + maxD.replace(/-/g, '') + '_ALL_COMBINED_archived.csv';
  var blob = Utilities.newBlob(csv, 'text/csv', fileName);
  getArchiveFolder_().createFile(blob);

  var keptRows = rows.filter(function (r) { return normalizeDateStr(r['日期']) >= cutoffStr; });
  writeSheetObjects_(sheet, CONFIG.HISTORY_COLUMNS, keptRows);

  logRun_('自動封存', '成功',
    '已封存 ' + oldRows.length + ' 筆超過 ' + CONFIG.HISTORY_RETENTION_DAYS + ' 天的舊資料到 ' + fileName +
    '，History 分頁現在保留 ' + keptRows.length + ' 筆', 0);
  return { archived: oldRows.length, fileName: fileName, remaining: keptRows.length };
}

/** 把整份 History 封存成 CSV 存進 Archive 資料夾，對應原本的 ALL_COMBINED.csv。 */
function exportHistorySnapshotToDrive() {
  var rows = readSheetObjects_(getHistorySheet_());
  if (rows.length === 0) throw new Error('History 目前沒有資料可封存');
  var dates = rows.map(function (r) { return normalizeDateStr(r['日期']); });
  var minD = dates.reduce(function (a, b) { return a < b ? a : b; });
  var maxD = dates.reduce(function (a, b) { return a > b ? a : b; });
  var csv = '\uFEFF' + rowsToCsv_(CONFIG.HISTORY_COLUMNS, rows);
  var fileName = minD.replace(/-/g, '') + '_' + maxD.replace(/-/g, '') + '_ALL_COMBINED.csv';
  var blob = Utilities.newBlob(csv, 'text/csv', fileName);
  var file = getArchiveFolder_().createFile(blob);
  logRun_('後台管理', '成功', '已封存 History 快照：' + fileName, 0);
  return { id: file.getId(), name: fileName, url: file.getUrl() };
}

/** 把「回測研究」頁面跑出來的回測結果存成 CSV，放進 Regression 資料夾。 */
function saveBacktestToDrive(backtestResult) {
  if (!backtestResult || !backtestResult.results || backtestResult.results.length === 0) {
    throw new Error('沒有回測結果可以存檔');
  }
  var columns = ['證券代號', '證券名稱', '進場IBF_Rank', 'WIP_穩定度(STD)', 'Depth_MA5',
    'Market_Trend_Entry', 'Peak_Return%', 'Final_Return%', 'Days_to_Peak', 'Win_Label'];
  var csv = '\uFEFF' + rowsToCsv_(columns, backtestResult.results);
  var fileName = backtestResult.startDay.replace(/-/g, '') + '_' + backtestResult.endDay.replace(/-/g, '') + '_v16.10_回測結果.csv';
  var blob = Utilities.newBlob(csv, 'text/csv', fileName);
  var file = getRegressionFolder_().createFile(blob);
  logRun_('回測研究', '成功', '已匯出回測結果：' + fileName, 0);
  return { id: file.getId(), name: fileName, url: file.getUrl() };
}

/** 把因子相關性掃描結果存成 CSV，放進 Regression 資料夾。 */
function saveFactorScanToDrive(scanResult) {
  if (!scanResult || !scanResult.correlations || scanResult.correlations.length === 0) {
    throw new Error('沒有因子掃描結果可以存檔');
  }
  var columns = ['factor', 'correlation'];
  var csv = '\uFEFF' + rowsToCsv_(columns, scanResult.correlations);
  var fileName = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd_HHmm') + '_因子相關性掃描.csv';
  var blob = Utilities.newBlob(csv, 'text/csv', fileName);
  var file = getRegressionFolder_().createFile(blob);
  logRun_('回測研究', '成功', '已匯出因子掃描結果：' + fileName, 0);
  return { id: file.getId(), name: fileName, url: file.getUrl() };
}
