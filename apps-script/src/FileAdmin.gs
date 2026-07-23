/**
 * FileAdmin.gs
 * 「後台管理」頁面：瀏覽/刪除 Config.gs 定義的三個 Drive 資料夾裡的檔案。
 * 'archive' 這個資料夾現在就是每月一份歷史資料 CSV 實際存放的地方（見 HistoryFiles.gs），
 * 不再是「超過保留期限才搬過去的封存」，資料本來就在這裡，這裡看到的就是即時的完整歷史。
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
    archive: '歷史資料',
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
