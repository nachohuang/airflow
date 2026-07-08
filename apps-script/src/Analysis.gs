/**
 * Analysis.gs
 * 對應 Colab Cell 2「v17.0 趨勢共鳴版 - 法人高參與度與多頭動能導航模組」。
 * 只讀最近 CONFIG.ANALYSIS_LOOKBACK_DAYS 天的 History（見 SheetUtils.readRecentHistory_），
 * 用 Utils.gs 的 rolling/rank 函式重建 pandas 版的因子與 Armor_Score，最後對最新一天做選股/持股診斷。
 */

function getReportsSheet_() {
  return ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.REPORTS, CONFIG.REPORT_COLUMNS);
}

function diagnoseRow_(row, portfolioMap) {
  var isUpward = row.Trend_Score === 2;
  var isParticipationHigh = row.Inst_Part_Rank !== null && row.Inst_Part_Rank >= 0.8;
  var isVolSpark = row.Vol_Ratio_Rank !== null && row.Vol_Ratio_Rank >= 0.85;

  var strategy = 'Neutral';
  var action = '觀望';
  var interpretation = '盤整中';
  var url = 'https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=' + row['證券代號'];

  var holding = portfolioMap[row['證券代號']];
  if (holding) {
    var peak = row.Adjusted_Peak;
    var drawdown = peak ? (peak - row['收盤價']) / peak : 0;
    if (drawdown >= CONFIG.STRATEGY.TRAILING_STOP_PERCENT) {
      strategy = '🛑 止盈/止損';
      action = '建議：賣出';
      interpretation = '高點回落 ' + (drawdown * 100).toFixed(1) + '% (警戒)';
    } else {
      strategy = '🛡️ 持股守護';
      action = '建議：續抱';
      var profit = holding.cost ? (row['收盤價'] - holding.cost) / holding.cost : 0;
      interpretation = '趨勢持穩 | 損益: ' + (profit * 100).toFixed(1) + '%';
    }
  } else if (row['成交金額'] >= CONFIG.STRATEGY.LIQUIDITY_MIN) {
    if (isUpward && isParticipationHigh && isVolSpark) {
      strategy = '🚀 趨勢啟動';
      action = '建議：現價買入';
      interpretation = '法人密度極高且多頭慣性確立';
    } else if (isUpward && row.IBF_20D_Rank !== null && row.IBF_20D_Rank >= 0.7) {
      strategy = '🔥 趨勢領航';
      action = '建議：分批進場';
      interpretation = '多頭排列且法人支撐強勁';
    }
  }
  return { strategy: strategy, action: action, interpretation: interpretation, url: url, peak: row.Adjusted_Peak };
}

/**
 * 核心計算：對輸入的 History 列（未必是全部歷史，可以是任意子集）
 * 依 證券代號 分組計算所有 rolling 因子與 Armor_Score，並回傳補齊欄位後的列陣列（依原順序不保證）。
 * portfolioMap: {code: {cost, buyDate}}，來自 Portfolio.gs 的 getPortfolioMap_()。
 */
function computeFactors_(rows, portfolioMap) {
  rows.forEach(function (r) {
    r['證券代號'] = zfill4(String(r['證券代號']).trim());
    CONFIG.HISTORY_NUMERIC_COLUMNS.forEach(function (c) { r[c] = toNumber(r[c]); });
  });
  rows = rows.filter(function (r) { return r['證券代號'].length === 4; });
  rows = sortRows(rows, [
    ['證券代號', 'asc'],
    [function (r) { return normalizeDateStr(r['日期']); }, 'asc']
  ]);

  var byCode = groupBy(rows, function (r) { return r['證券代號']; });
  byCode.forEach(function (group, code) {
    var closeArr = group.map(function (r) { return r['收盤價']; });
    var volArr = group.map(function (r) { return r['成交股數']; });
    var instNetArr = group.map(function (r) { return r['投信'] + r['外資'] + r['自營商']; });
    var instParticipation = group.map(function (r) {
      var vol = r['成交股數'];
      if (!vol) return null;
      return (Math.abs(r['投信']) + Math.abs(r['外資']) + Math.abs(r['自營商'])) / vol;
    });
    var instPartMA5 = rollingMean(instParticipation, 5);

    var dailyReturn = pctChange(closeArr);
    var isDrop = dailyReturn.map(function (v) { return (v !== null && v < 0) ? 1 : 0; });
    var isInstBuyOnDrop = isDrop.map(function (v, i) { return (v === 1 && instNetArr[i] > 0) ? 1 : 0; });
    var dropCount20 = rollingSum(isDrop, 20);
    var buyOnDrop20 = rollingSum(isInstBuyOnDrop, 20);
    var ibf20 = dropCount20.map(function (dc, i) {
      if (!dc) return 0; // dropCount 為 null 或 0 都 fillna(0)
      return buyOnDrop20[i] / dc;
    });

    var ma20 = rollingMean(closeArr, 20);
    var ma20Slope = diffN(ma20, 3);
    var trendScore = closeArr.map(function (c, i) {
      var s = 0;
      if (ma20[i] !== null && c > ma20[i]) s += 1;
      if (ma20Slope[i] !== null && ma20Slope[i] > 0) s += 1;
      return s;
    });

    var volMA20 = rollingMean(volArr, 20);
    var volRatio = volArr.map(function (v, i) { return volMA20[i] ? v / volMA20[i] : null; });

    var ma60 = rollingMean(closeArr, 60);
    var bias60 = closeArr.map(function (c, i) { return ma60[i] ? (c - ma60[i]) / ma60[i] : null; });

    var holding = portfolioMap[code];
    var adjustedPeak;
    if (holding && holding.buyDate) {
      var dates = group.map(function (r) { return normalizeDateStr(r['日期']); });
      var startIdx = dates.findIndex(function (d) { return d >= holding.buyDate; });
      if (startIdx === -1) startIdx = dates.length;
      adjustedPeak = expandingMaxFromIndex(closeArr, startIdx, holding.cost);
    } else {
      adjustedPeak = expandingMax(closeArr);
    }

    for (var i = 0; i < group.length; i++) {
      group[i].Inst_Net = instNetArr[i];
      group[i].Inst_Participation = instParticipation[i];
      group[i].Inst_Part_MA5 = instPartMA5[i];
      group[i].IBF_20D = ibf20[i];
      group[i].Trend_Score = trendScore[i];
      group[i].Vol_MA20 = volMA20[i];
      group[i].Vol_Ratio = volRatio[i];
      group[i].MA20 = ma20[i];
      group[i].MA20_Slope = ma20Slope[i];
      group[i].MA60 = ma60[i];
      group[i].BIAS_60 = bias60[i];
      group[i].Adjusted_Peak = adjustedPeak[i];
      group[i].Daily_Return = dailyReturn[i];
      group[i].Is_Drop = isDrop[i];
      group[i].Is_Inst_Buy_On_Drop = isInstBuyOnDrop[i];
    }
  });

  // 橫斷面（同一天所有股票互相比較）百分位排名 + Armor_Score
  var byDate = groupBy(rows, function (r) { return normalizeDateStr(r['日期']); });
  byDate.forEach(function (dayRows) {
    var instPartRank = percentRank(dayRows, 'Inst_Part_MA5');
    var ibfRank = percentRank(dayRows, 'IBF_20D');
    var volRatioRank = percentRank(dayRows, 'Vol_Ratio');
    for (var i = 0; i < dayRows.length; i++) {
      dayRows[i].Inst_Part_Rank = instPartRank[i];
      dayRows[i].IBF_20D_Rank = ibfRank[i];
      dayRows[i].Vol_Ratio_Rank = volRatioRank[i];
      var t = dayRows[i].Trend_Score;
      var parts = [instPartRank[i], ibfRank[i], volRatioRank[i], t];
      var hasNull = parts.some(function (p) { return p === null || p === undefined; });
      dayRows[i].Armor_Score = hasNull ? null :
        Math.round((instPartRank[i] * 45 + ibfRank[i] * 30 + volRatioRank[i] * 15 + t * 10) * 10) / 10;
    }
  });

  return rows;
}

/**
 * 執行完整分析：讀最近 N 天 History -> 算因子 -> 對「最新一天」做診斷 -> 回傳戰報（未寫入任何地方）。
 */
function runAnalysis() {
  var rawRows = readRecentHistory_(CONFIG.ANALYSIS_LOOKBACK_DAYS);
  if (rawRows.length === 0) return { latestDate: null, report: [], fullReport: [] };

  var portfolioMap = getPortfolioMap_();
  var rows = computeFactors_(rawRows, portfolioMap);

  var latestDateStr = null;
  rows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (!latestDateStr || d > latestDateStr) latestDateStr = d;
  });
  if (!latestDateStr) return { latestDate: null, report: [], fullReport: [] };

  var scanRows = rows.filter(function (r) { return normalizeDateStr(r['日期']) === latestDateStr; });
  var report = [];
  var fullReport = [];
  scanRows.forEach(function (r) {
    var diag = diagnoseRow_(r, portfolioMap);
    if (diag.strategy === 'Neutral') return;
    report.push({
      '日期': latestDateStr,
      '證券代號': r['證券代號'],
      '證券名稱': r['證券名稱'],
      'Armor_Score': r.Armor_Score,
      '操作策略': diag.strategy,
      '建議動作': diag.action,
      '實相解讀': diag.interpretation,
      'Trend_Score': r.Trend_Score,
      'Inst_Part_Rank': r.Inst_Part_Rank,
      'IBF_20D_Rank': r.IBF_20D_Rank,
      '監控連結': diag.url,
      '參考最高價': diag.peak
    });
    fullReport.push(buildFullReportRow_(r, diag));
  });
  report.sort(function (a, b) { return (b.Armor_Score || 0) - (a.Armor_Score || 0); });
  fullReport.sort(function (a, b) { return (b.Armor_Score || 0) - (a.Armor_Score || 0); });

  return { latestDate: latestDateStr, report: report, fullReport: fullReport };
}

/** 組出跟原本 Colab v17.0 to_excel() 一致的完整欄位列（見 CONFIG.FULL_REPORT_COLUMNS）。 */
function buildFullReportRow_(r, diag) {
  var diagFields = {
    '操作策略': diag.strategy,
    '建議動作': diag.action,
    '實相解讀': diag.interpretation,
    '監控連結': diag.url,
    '參考最高價': diag.peak
  };
  var row = {};
  CONFIG.FULL_REPORT_COLUMNS.forEach(function (col) {
    row[col] = diagFields.hasOwnProperty(col) ? diagFields[col] : r[col];
  });
  return row;
}

/**
 * 執行分析並落地：寫入 Reports 分頁（精簡欄位，同日期覆蓋，給手機 UI 用）+
 * 匯出一份完整欄位的 Excel 快照到 Drive Reports 資料夾
 * （對應原本 Colab to_excel() 到 google_drive_folder_output_report_dir 的動作，也是後台管理要管的檔案）。
 */
function runAnalysisAndSave() {
  var result = runAnalysis();
  if (!result.latestDate) return result;

  var sheet = getReportsSheet_();
  upsertRowsByDate_(sheet, CONFIG.REPORT_COLUMNS, result.report);

  try {
    exportReportToDrive_(result.fullReport, result.latestDate);
  } catch (e) {
    logRun_('戰報匯出', '失敗', String(e.message || e), 0);
  }
  return result;
}

/** 前端「今日戰報」頁面呼叫用：跑一次分析並存檔，回傳結果給畫面渲染。 */
function getDashboardReport() {
  return runAnalysisAndSave();
}

/**
 * 把戰報匯出成 .xlsx 存進 Drive 的 Reports 資料夾（完整欄位版本，對應原本 Colab 的存檔格式）。
 * 做法：先建立一份暫存 Google Sheet 寫入資料，透過 export URL 轉存 xlsx blob，再刪除暫存表單。
 */
function exportReportToDrive_(fullReportRows, dateStr) {
  if (!fullReportRows || fullReportRows.length === 0) return null;
  var tempName = 'tmp_export_' + dateStr;
  var tempSs = SpreadsheetApp.create(tempName);
  var tempSheet = tempSs.getSheets()[0];
  writeSheetObjects_(tempSheet, CONFIG.FULL_REPORT_COLUMNS, fullReportRows);
  SpreadsheetApp.flush();

  var exportUrl = 'https://docs.google.com/spreadsheets/d/' + tempSs.getId() + '/export?format=xlsx';
  var resp = UrlFetchApp.fetch(exportUrl, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  var fileName = dateStr.replace(/-/g, '') + '_v17.0_趨勢共鳴戰報.xlsx';
  var blob = resp.getBlob().setName(fileName);
  var file = getReportsFolder_().createFile(blob);

  DriveApp.getFileById(tempSs.getId()).setTrashed(true);
  return file.getId();
}
