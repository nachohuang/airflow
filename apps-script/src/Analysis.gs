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
 * 取得「最新一個交易日」每檔股票已經算好因子的列（scanRows）。
 * BigQuery 模式（external／materialized）下改呼叫 queryLatestDayFactorsFromBigQuery_()——
 * rolling 因子/橫斷面排名/Armor_Score 都在 BigQuery 裡算完，Apps Script 只拿回「今天」
 * 這一天的結果（約兩千列），不是 ANALYSIS_LOOKBACK_DAYS 天 x 全市場的原始資料（十幾萬列，
 * 會撞 Apps Script V8 記憶體上限）。native 模式（沒設定 BigQuery）維持原本讀 Drive 月份檔案
 * + 在 Apps Script 用 computeFactors_ 算的做法，資料量本來就小很多，不受影響。
 */
function computeLatestDayRows_(portfolioMap) {
  if (shouldUseBigQueryForReads_()) {
    return queryLatestDayFactorsFromBigQuery_(portfolioMap);
  }
  var rawRows = readRecentHistoryFromFiles_(CONFIG.ANALYSIS_LOOKBACK_DAYS);
  if (rawRows.length === 0) return [];
  var rows = computeFactors_(rawRows, portfolioMap);
  var latestDateStr = null;
  rows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (!latestDateStr || d > latestDateStr) latestDateStr = d;
  });
  if (!latestDateStr) return [];
  return rows.filter(function (r) { return normalizeDateStr(r['日期']) === latestDateStr; });
}

/** 這份戰報實際是從哪裡讀資料的：native（Drive 月份檔案）／external／materialized
 *  （BigQuery），前端拿這個字串顯示「資料來源」，不用讓使用者自己猜。跟 sourceMode 這個
 *  Script Property 設定值不完全一樣——沒設定 BigQuery 專案的話，就算 sourceMode 存的是
 *  external/materialized，實際讀取還是會落到 native（見 shouldUseBigQueryForReads_）。 */
function getEffectiveDataSourceMode_() {
  return shouldUseBigQueryForReads_() ? getBigQuerySettings().sourceMode : 'native';
}

/** 回報「這份戰報實際用了哪個區間的歷史資料」：以戰報日期為基準往前推 ANALYSIS_LOOKBACK_DAYS 天
 *  （MA60/rolling 因子的回看視窗），給前端顯示「使用資料：X ~ 戰報日期」用，讓使用者知道
 *  這次結果是用多少歷史資料算出來的，不是只用來源事後猜測。 */
function computeLookbackStartStr_(latestDateStr) {
  var d = new Date(latestDateStr + 'T00:00:00');
  d.setDate(d.getDate() - CONFIG.ANALYSIS_LOOKBACK_DAYS);
  return normalizeDateStr(d);
}

/**
 * 執行完整分析：取得「最新一天」已算好因子的列 -> 對每一列做診斷 -> 回傳戰報（未寫入任何地方）。
 */
function runAnalysis() {
  var portfolioMap = getPortfolioMap_();
  var scanRows = computeLatestDayRows_(portfolioMap);
  if (scanRows.length === 0) {
    // scanRows 是空的代表連「最新一天」都讀不到任何一列資料——不是篩選篩掉，是資料來源
    // 那一關就沒東西可以篩。仍然附上 diagnostics（totalStocks 會是 0），讓呼叫端一眼看出
    // 「查無資料」跟「有資料但全部被篩掉」是兩件不同的事，不用另外猜。
    var emptyDiagnostics = computeScreeningStats_([], portfolioMap, null);
    emptyDiagnostics.reportCount = 0;
    return { latestDate: null, report: [], fullReport: [], diagnostics: emptyDiagnostics };
  }

  var latestDateStr = scanRows[0]['日期'];
  var appliedFactorModels = getAppliedFactorModels(); // 讀 FactorModelHistory 分頁，跟 BigQuery 無關，很快
  var report = [];
  var fullReport = [];
  scanRows.forEach(function (r) {
    var diag = diagnoseRow_(r, portfolioMap);
    if (diag.strategy === 'Neutral') return;
    var predicted = computePredictedFactorScores_(r, appliedFactorModels);
    r['因子模型_預測1月報酬'] = predicted.predictedReturn1M;
    r['因子模型_預測抗跌力'] = predicted.predictedDownsideResistance;
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
      '參考最高價': diag.peak,
      '因子模型_預測1月報酬': predicted.predictedReturn1M,
      '因子模型_預測抗跌力': predicted.predictedDownsideResistance
    });
    fullReport.push(buildFullReportRow_(r, diag));
  });
  report.sort(function (a, b) { return (b.Armor_Score || 0) - (a.Armor_Score || 0); });
  fullReport.sort(function (a, b) { return (b.Armor_Score || 0) - (a.Armor_Score || 0); });

  // 一律附上篩選漏斗統計（不只 0 檔訊號才附），讓「查看篩選漏斗明細」隨時可用，也方便之後
  // 換不同篩選/因子版本時比較漏斗人數的變化。reportCount 是這次實際跑出來的訊號數（跟
  // report.length 同一個數字），讓 getScreeningDiagnostics() 的即時查詢分支能明確標出
  // 「這次查到的資料實際上會產生幾檔訊號」，不用使用者自己拿漏斗最後幾關的數字去猜。
  var diagnostics = computeScreeningStats_(scanRows, portfolioMap, latestDateStr);
  diagnostics.reportCount = report.length;

  return {
    latestDate: latestDateStr,
    lookbackStart: computeLookbackStartStr_(latestDateStr),
    dataSourceMode: getEffectiveDataSourceMode_(),
    report: report,
    fullReport: fullReport,
    diagnostics: diagnostics
  };
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
  // 篩選漏斗一律快取，即使這次連 latestDate 都沒有（scanRows 是空的）——這樣「查看篩選漏斗
  // 明細」在「完全查無資料」的情況下也能立刻顯示原因，不用另外重新讀一次歷史資料。
  // savedToReport=true 標記這份漏斗統計是「真的存過 Reports 分頁」算出來的，跟
  // getScreeningDiagnostics() 自己臨時查詢（不會存檔）算出來的漏斗要分清楚——不然使用者
  // 會看到漏斗顯示「有 N 檔訊號」，回戰報頁卻還是「目前沒有任何戰報」，搞不清楚哪裡出問題
  // （這份統計其實是另一次「只查不存」的呼叫算出來的，不是這次已經存檔的結果）。
  if (result.diagnostics) {
    result.diagnostics.savedToReport = true;
    cacheScreeningDiagnostics_(result.diagnostics);
  }
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

// ============================================================
// 「重新計算戰報」背景 job（機制跟 DataFetch.gs 的補抓/重新彙整 job 相同）。
// 手機切到背景、螢幕關掉很容易讓瀏覽器中斷連線，這時如果是直接同步呼叫 runAnalysisAndSave，
// google.script.run 的 success handler 永遠不會被觸發，畫面就卡死在「分析中」——即使 Apps
// Script 那邊其實已經算完、也已經寫進 Reports 分頁了。改用時間觸發器在背景做，前端只需要
// 輪詢 getAnalysisJobStatus() 顯示進度，不受連線中斷影響。
// ============================================================

function getAnalysisJobState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.ANALYSIS_JOB_STATE);
  return raw ? JSON.parse(raw) : null;
}

function saveAnalysisJobState_(state) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.ANALYSIS_JOB_STATE, JSON.stringify(state));
}

function deleteAnalysisJobTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processAnalysisJobTick_') ScriptApp.deleteTrigger(t);
  });
}

/** 「最新戰報」重新整理 action sheet 的「重新計算戰報」呼叫：排一個幾乎立刻觸發的一次性
 *  時間觸發器就馬上回傳，實際分析在另一次獨立觸發的執行裡進行，這次 google.script.run
 *  呼叫本身非常快，不會因為分析本身要跑數十秒而被瀏覽器分頁中斷影響。 */
function startAnalysisJob() {
  deleteAnalysisJobTriggers_();
  saveAnalysisJobState_({ status: 'running', updatedAt: Date.now() });
  ScriptApp.newTrigger('processAnalysisJobTick_').timeBased().after(1000).create();
  return { status: 'running' };
}

/** 前端輪詢用：狀態存在 Script Properties，不是存在瀏覽器分頁的記憶體裡，任何時候打開頁面
 *  呼叫這個都看得到最新進度（或是已經做完的結果）。 */
function getAnalysisJobStatus() {
  return getAnalysisJobState_() || { status: 'idle' };
}

/** 排程佇列的「刪除」按鈕呼叫：不管目前狀態是什麼，直接清掉狀態跟任何已排定的觸發器，
 *  回到乾淨的 idle。給觸發器不知道為什麼沒有真的被觸發、狀態卡在 running 卻再也不會有
 *  進度的情況用（見 DataFetch.gs 的 clearBackfillJob_ 同樣的說明跟限制）。 */
function clearAnalysisJob_() {
  deleteAnalysisJobTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.PROP_KEYS.ANALYSIS_JOB_STATE);
  return { status: 'idle' };
}

/**
 * 真正做事的地方，由時間觸發器呼叫（不是 google.script.run），完全不受瀏覽器分頁影響。
 * 分析本身是單一批次運算（不像補抓區間要一天一天跑），正常情況下一次 tick 就會跑完，
 * 這裡沒有像 processBackfillJobTick_ 那樣的時間預算/續跑機制；真的遇到未預期的例外
 * 會被接住寫進 job 狀態變成 status:'error'，不會讓狀態就這樣默默停在 'running'。
 */
function processAnalysisJobTick_() {
  deleteAnalysisJobTriggers_();
  var state = getAnalysisJobState_();
  if (!state || state.status !== 'running') return;

  var startTime = Date.now();
  try {
    var result = runAnalysisAndSave();
    var scannedCount = result.diagnostics ? result.diagnostics.totalStocks : null;
    state.status = 'done';
    state.latestDate = result.latestDate;
    state.reportCount = result.report ? result.report.length : 0;
    state.scannedCount = scannedCount;
    state.updatedAt = Date.now();
    saveAnalysisJobState_(state);
    logRun_('手動重新計算戰報', '成功',
      result.latestDate
        ? ('戰報日期 ' + result.latestDate + '，' + result.report.length + ' 檔訊號（共掃描 ' + scannedCount + ' 檔）')
        : ('沒有可用的歷史資料（掃描到 ' + scannedCount + ' 檔）'),
      Math.round((Date.now() - startTime) / 1000));
  } catch (e) {
    state.status = 'error';
    state.errorMessage = String(e.message || e);
    state.updatedAt = Date.now();
    saveAnalysisJobState_(state);
    logRun_('手動重新計算戰報', '失敗', String(e.message || e), Math.round((Date.now() - startTime) / 1000));
  }
}

/** 把「篩選漏斗明細」存進 Script Properties，隔天會自動被新的一筆覆蓋。快取 key 用「今天
 *  執行的日期」而不是 stats.latestDate——這樣就算這次掃描完全查無資料（latestDate 是 null），
 *  一樣能快取住「今天查過一次，結果是查無資料」這件事，不用每次打開頁面都重新查一次。 */
function cacheScreeningDiagnostics_(stats) {
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.PROP_KEYS.SCREENING_DIAGNOSTICS_CACHE,
    JSON.stringify({ cachedAt: normalizeDateStr(new Date()), stats: stats })
  );
}

/** 讀取今天的篩選漏斗明細快取；不存在或不是今天算的就回傳 null。 */
function readCachedScreeningDiagnostics_(todayStr) {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.SCREENING_DIAGNOSTICS_CACHE);
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    return parsed && parsed.cachedAt === todayStr ? parsed.stats : null;
  } catch (e) {
    return null;
  }
}

/**
 * 前端「今日戰報」頁面呼叫用。Reports 分頁如果已經有今天的資料，直接回傳快取結果，
 * 不重跑一次「讀歷史 -> 算因子」（external 模式下這一步要重新掃一次 BigQuery/Drive 檔案，
 * 是整個流程裡最慢的部分）；只有還沒有今天的資料時才會真的算一次。
 * 想強制重算（例如剛改了持股、想馬上看新的續抱/止損判斷），用最新戰報頁「重新計算戰報」
 * （呼叫 startAnalysisJob 背景 job，一定會真的重跑，不會被這裡的快取擋下來）。
 */
function getDashboardReport() {
  var todayStr = normalizeDateStr(new Date());
  var cached = readSheetObjects_(getReportsSheet_()).filter(function (r) {
    return normalizeDateStr(r['日期']) === todayStr;
  });
  if (cached.length > 0) {
    cached.sort(function (a, b) { return (toNumberOrNull(b['Armor_Score']) || 0) - (toNumberOrNull(a['Armor_Score']) || 0); });
    return { latestDate: todayStr, report: cached, fullReport: [], cached: true };
  }
  return runAnalysisAndSave();
}

/**
 * 純讀取版：只讀 Reports 分頁目前存的「最近一次」戰報，不管是不是今天，絕對不會觸發
 * 任何計算（不讀歷史、不查 BigQuery）。前端「今日戰報」頁面打開時改呼叫這個，避免單純
 * 打開頁面就意外觸發一次昂貴、可能失敗的即時計算；真的要重新產生，靠右上角重新整理選
 * 「重新計算戰報」（呼叫 startAnalysisJob 背景 job）另外手動觸發。
 */
function getCachedDashboardReport() {
  var rows = readSheetObjects_(getReportsSheet_());
  if (rows.length === 0) return { latestDate: null, report: [], cached: true };

  var latestDateStr = null;
  rows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (!latestDateStr || d > latestDateStr) latestDateStr = d;
  });
  var latestRows = rows.filter(function (r) { return normalizeDateStr(r['日期']) === latestDateStr; });
  latestRows.sort(function (a, b) { return (toNumberOrNull(b['Armor_Score']) || 0) - (toNumberOrNull(a['Armor_Score']) || 0); });
  return {
    latestDate: latestDateStr,
    lookbackStart: computeLookbackStartStr_(latestDateStr),
    dataSourceMode: getEffectiveDataSourceMode_(),
    report: latestRows,
    cached: true,
    isToday: latestDateStr === normalizeDateStr(new Date())
  };
}

/**
 * 除錯用：直接回報 Reports 分頁「現在」的實際狀態，不做任何篩選/排序——用來確認
 * getCachedDashboardReport() 讀到的到底是不是預期的資料。跟 getCachedDashboardReport()
 * 讀的是完全同一個 sheet 物件（同一個 getReportsSheet_()），如果這裡顯示有資料、但「戰報與
 * 個股」還是顯示「目前還沒有任何戰報」，代表問題在前端渲染那一段，不是資料庫或讀取邏輯本身；
 * 如果這裡也是 0 列，代表問題出在「寫入」那一段（例如 upsertRowsByDate_ 沒有真的執行到，
 * 或寫進了另一份試算表），不是「讀取」的問題。給「系統與資料後台」的除錯按鈕用。
 */
function getReportsSheetDebugInfo() {
  var ss = getSpreadsheet_();
  var sheet = getReportsSheet_();
  var rows = readSheetObjects_(sheet);
  var dateCounts = {};
  rows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    dateCounts[d] = (dateCounts[d] || 0) + 1;
  });
  var dates = Object.keys(dateCounts).sort();
  return {
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    sheetName: sheet.getName(),
    sheetLastRow: sheet.getLastRow(),
    sheetLastColumn: sheet.getLastColumn(),
    totalRows: rows.length,
    distinctDates: dates,
    rowsPerDate: dateCounts
  };
}

/**
 * 純函式：對「已經算完因子、篩到最新一天」的 scanRows 統計篩選漏斗每一關卡掉多少檔股票，
 * 方便判斷到底是「今天市場真的沒有符合條件的股票」（v16.10 策略本來就選得很嚴，
 * 這是正常情況），還是「資料有問題」（例如 external 模式欄位順序對錯，導致排名/因子值全部異常）。
 * 由 runAnalysis()（0 檔訊號時）與 getScreeningDiagnostics()（快取沒命中時）共用，
 * 避免同一天內為了看漏斗明細，把昂貴的 readRecentHistory_ + computeFactors_ 重跑第二次。
 */
function computeScreeningStats_(scanRows, portfolioMap, latestDateStr) {
  var stats = {
    latestDate: latestDateStr,
    totalStocks: scanRows.length,
    holdingCount: 0,
    liquidityPass: 0,
    upwardTrend: 0,
    highInstParticipation: 0,
    volumeSpark: 0,
    breakoutMatches: 0,
    ibfHighWithUpward: 0,
    nullInstPartRank: 0,
    nullVolRatioRank: 0,
    nullIbfRank: 0
  };

  scanRows.forEach(function (r) {
    if (portfolioMap[r['證券代號']]) { stats.holdingCount++; return; } // 持股一律有訊號（續抱/止損），不算在篩選漏斗裡
    if (r['成交金額'] >= CONFIG.STRATEGY.LIQUIDITY_MIN) stats.liquidityPass++;
    var isUpward = r.Trend_Score === 2;
    if (isUpward) stats.upwardTrend++;

    if (r.Inst_Part_Rank === null || r.Inst_Part_Rank === undefined) stats.nullInstPartRank++;
    else if (r.Inst_Part_Rank >= 0.8) stats.highInstParticipation++;

    if (r.Vol_Ratio_Rank === null || r.Vol_Ratio_Rank === undefined) stats.nullVolRatioRank++;
    else if (r.Vol_Ratio_Rank >= 0.85) stats.volumeSpark++;

    if (r.IBF_20D_Rank === null || r.IBF_20D_Rank === undefined) stats.nullIbfRank++;
    else if (isUpward && r.IBF_20D_Rank >= 0.7) stats.ibfHighWithUpward++;

    var isParticipationHigh = r.Inst_Part_Rank !== null && r.Inst_Part_Rank !== undefined && r.Inst_Part_Rank >= 0.8;
    var isVolSpark = r.Vol_Ratio_Rank !== null && r.Vol_Ratio_Rank !== undefined && r.Vol_Ratio_Rank >= 0.85;
    if (r['成交金額'] >= CONFIG.STRATEGY.LIQUIDITY_MIN && isUpward && isParticipationHigh && isVolSpark) stats.breakoutMatches++;
  });

  return stats;
}

/**
 * 「篩選漏斗明細」彈出視窗呼叫。優先回傳今天稍早（不管是「重新計算戰報」背景 job 或這次
 * 呼叫本身）算過、快取在 Script Properties 裡的漏斗明細；沒有快取才真的重新讀一次歷史資料
 * 計算（例如今天第一次呼叫、還沒有任何快取的情況）。
 *
 * 這裡故意呼叫完整的 runAnalysis()（會實際跑 diagnoseRow_ 判斷每一列的策略），而不是只呼叫
 * computeScreeningStats_ 算漏斗關卡數字——因為漏斗最後一關的數字（例如「同時符合趨勢啟動
 * 三條件」）不等於「實際會出現在戰報的訊號數」（診斷邏輯還有持股/止盈止損等其他分支），
 * 要用同一套邏輯算出真正的訊號數（reportCount）才不會誤導。
 * 但這裡「只算不存」，不會呼叫 upsertRowsByDate_ 寫回 Reports 分頁、也不會匯出 Excel
 * 快照——只是讓使用者快速看一眼「如果現在按重新計算戰報，大概會有幾檔訊號」，savedToReport
 * 標記為 false，前端會據此提醒「這是即時查詢結果，還沒有存成正式戰報」，避免使用者誤以為
 * 看到漏斗有訊號、戰報頁卻還是空的是一個 bug。
 */
function getScreeningDiagnostics() {
  var todayStr = normalizeDateStr(new Date());
  var stats = readCachedScreeningDiagnostics_(todayStr);
  if (!stats) {
    var analysis = runAnalysis();
    stats = analysis.diagnostics;
    stats.savedToReport = false;
    cacheScreeningDiagnostics_(stats);
  }
  stats.stages = screeningFunnelStages_(stats);
  return stats;
}

/**
 * 把 computeScreeningStats_ 算出來的具名欄位轉成一份「有順序的關卡清單」，純粹給顯示用
 * （前端「查看篩選漏斗明細」畫面、排程佇列卡片都吃這個 {label, count, note} 形狀）。
 * 之後如果換一套不同的篩選/因子版本、關卡定義完全不同，只要另外寫一個回傳同樣形狀陣列的
 * 函式（例如 screeningFunnelStagesV2_），前端渲染邏輯完全不用改。
 */
function screeningFunnelStages_(stats) {
  return [
    { label: '掃描到的股票數（含持股）', count: stats.totalStocks, note: stats.holdingCount ? stats.holdingCount + ' 檔是持股，不計入下面漏斗' : '' },
    { label: '成交金額達門檻', count: stats.liquidityPass, note: '' },
    { label: '多頭排列（Trend_Score=2）', count: stats.upwardTrend, note: '' },
    { label: '法人參與度前20%', count: stats.highInstParticipation, note: stats.nullInstPartRank ? stats.nullInstPartRank + ' 檔無法計算' : '' },
    { label: '量能前15%', count: stats.volumeSpark, note: stats.nullVolRatioRank ? stats.nullVolRatioRank + ' 檔無法計算' : '' },
    { label: '同時符合「趨勢啟動」三條件', count: stats.breakoutMatches, note: '' },
    { label: '多頭+法人逢低承接前30%（「趨勢領航」）', count: stats.ibfHighWithUpward, note: stats.nullIbfRank ? stats.nullIbfRank + ' 檔無法計算' : '' }
  ];
}

/**
 * 把戰報匯出成 .xlsx 存進 Drive 的 Reports 資料夾（完整欄位版本，對應原本 Colab 的存檔格式）。
 * 做法：先建立一份暫存 Google Sheet 寫入資料，透過 export URL 轉存 xlsx blob，再刪除暫存表單。
 * 同一天可能因為手動重試、debug 而重複執行「重新計算戰報」，檔名是依日期算出來的固定值，
 * 每次都直接存新檔案的話同一天會愈堆愈多份內容幾乎一樣的快照——建檔前先把資料夾裡同名的
 * 舊檔案丟進垃圾桶，維持「同一天最多一份、永遠是最新一次算出來的結果」。
 */
function exportReportToDrive_(fullReportRows, dateStr) {
  if (!fullReportRows || fullReportRows.length === 0) return null;
  var fileName = dateStr.replace(/-/g, '') + '_v17.0_趨勢共鳴戰報.xlsx';
  var folder = getReportsFolder_();

  var tempName = 'tmp_export_' + dateStr;
  var tempSs = SpreadsheetApp.create(tempName);
  var tempSheet = tempSs.getSheets()[0];
  writeSheetObjects_(tempSheet, CONFIG.FULL_REPORT_COLUMNS, fullReportRows);
  SpreadsheetApp.flush();

  var exportUrl = 'https://docs.google.com/spreadsheets/d/' + tempSs.getId() + '/export?format=xlsx';
  var resp = UrlFetchApp.fetch(exportUrl, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  var blob = resp.getBlob().setName(fileName);

  removeExistingFilesByName_(folder, fileName);
  var file = folder.createFile(blob);

  DriveApp.getFileById(tempSs.getId()).setTrashed(true);
  return file.getId();
}

/** 把資料夾裡跟 fileName 完全同名的檔案都丟進垃圾桶（用在匯出前清掉舊版同名快照）。 */
function removeExistingFilesByName_(folder, fileName) {
  var it = folder.getFilesByName(fileName);
  while (it.hasNext()) {
    it.next().setTrashed(true);
  }
}
