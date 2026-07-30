/**
 * DataFetch.gs
 * 對應 Colab Cell 1：每日向 TWSE 抓 T86(三大法人) / MI_INDEX(收盤行情) / BWIBBU_d(本益比等)，
 * 清理、合併後 upsert 進 History 分頁。
 *
 * 與原本 Colab 版本的差異：
 * - 原本是整段日期一次抓完、全部成功才落地存檔，任何一天失敗就整批放棄。
 * - 這裡改成「一天抓完就立刻寫入 Sheet」，單日失敗不影響已成功的其他日期，
 *   更符合 Apps Script 逐日觸發、且有 6 分鐘執行上限的執行模式。
 */

function fetchCsvText_(url) {
  var resp = UrlFetchApp.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error('HTTP ' + code + ' - ' + url);
  return resp.getContentText('Big5');
}

function splitLines_(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function parseCsvLine_(line) {
  if (!line || line.trim() === '') return [];
  var parsed = Utilities.parseCsv(line);
  return parsed.length ? parsed[0] : [];
}

function indexHeaders_(headers) {
  var m = {};
  headers.forEach(function (h, i) { m[String(h).trim()] = i; });
  return m;
}

/** 對應 pandas 清理 '證券代號' 欄位：去掉 ="..." 包裝與多餘引號/空白。 */
function cleanCode_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v).split('="').join('');
  s = s.replace(/^"+|"+$/g, '');
  return s.trim();
}

function formatYmd_(date) {
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyyMMdd');
}

function formatSlashDate_(date) {
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyy/MM/dd');
}

// ============================================================
// T86：三大法人買賣超
// ============================================================
function fetchT86_(dateStr) {
  var url = 'https://www.twse.com.tw/rwd/zh/fund/T86?date=' + dateStr + '&selectType=ALL&response=csv';
  var text = fetchCsvText_(url);
  var lines = splitLines_(text);
  if (lines.length < 4) throw new Error('T86 資料過少 (' + dateStr + ')');

  var headers = parseCsvLine_(lines[1]); // pandas header=1
  var idx = indexHeaders_(headers);
  if (idx['證券代號'] === undefined) throw new Error('T86 找不到證券代號欄位 (' + dateStr + ')');

  var rows = [];
  for (var i = 2; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.indexOf(',') === -1) continue;
    var fields = parseCsvLine_(line);
    if (fields.length < headers.length - 2) continue; // 跳過頁尾註記列
    var code = cleanCode_(fields[idx['證券代號']]);
    if (!code) continue;

    var dealerSelf = toNumber(fields[idx['自營商買賣超股數(自行買賣)']]);
    var dealerHedge = toNumber(fields[idx['自營商買賣超股數(避險)']]);

    rows.push({
      '證券代號': code,
      '證券名稱': (fields[idx['證券名稱']] || '').trim(),
      '外資': toNumber(fields[idx['外陸資買賣超股數(不含外資自營商)']]),
      '投信': toNumber(fields[idx['投信買賣超股數']]),
      '自營商': dealerSelf + dealerHedge,
      '三大法人買賣超股數': toNumber(fields[idx['三大法人買賣超股數']])
    });
  }
  if (rows.length < 5) throw new Error('T86 資料過少或格式異常 (' + dateStr + ')');
  return rows;
}

// ============================================================
// MI_INDEX：每日收盤行情
// ============================================================
function fetchMiIndex_(dateStr) {
  var url = 'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=' + dateStr + '&type=ALL&response=csv';
  var text = fetchCsvText_(url);
  var lines = splitLines_(text);

  var startIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('每日收盤行情(全部)') !== -1) { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error('MI_INDEX 找不到「每日收盤行情(全部)」區塊 (' + dateStr + ')');

  var headerIdx = -1;
  for (var j = startIdx; j < Math.min(startIdx + 10, lines.length); j++) {
    if (lines[j].indexOf('證券代號') !== -1) { headerIdx = j; break; }
  }
  if (headerIdx === -1) throw new Error('MI_INDEX 找不到證券代號標題列 (' + dateStr + ')');

  var cleaned = [];
  for (var k = headerIdx; k < lines.length; k++) {
    var line = lines[k];
    var commaCount = (line.match(/,/g) || []).length;
    if (commaCount >= 10) cleaned.push(line.split('="').join('"'));
  }
  if (cleaned.length < 2) throw new Error('MI_INDEX 資料為空或格式異常 (' + dateStr + ')');

  var headers = parseCsvLine_(cleaned[0]).map(function (h) { return String(h).trim(); });
  var idx = indexHeaders_(headers);
  if (idx['證券代號'] === undefined) throw new Error('MI_INDEX 找不到證券代號欄位 (' + dateStr + ')');

  var rows = [];
  for (var r = 1; r < cleaned.length; r++) {
    var fields = parseCsvLine_(cleaned[r]);
    if (fields.length < headers.length - 2) continue;
    var code = (fields[idx['證券代號']] || '').trim();
    if (!code || code === '證券代號') continue;

    rows.push({
      '證券代號': code,
      '證券名稱': idx['證券名稱'] !== undefined ? (fields[idx['證券名稱']] || '').trim() : '',
      '成交股數': toNumber(fields[idx['成交股數']]),
      '成交筆數': toNumber(fields[idx['成交筆數']]),
      '成交金額': toNumber(fields[idx['成交金額']]),
      '開盤價': toNumber(fields[idx['開盤價']]),
      '最高價': toNumber(fields[idx['最高價']]),
      '最低價': toNumber(fields[idx['最低價']]),
      '收盤價': toNumber(fields[idx['收盤價']]),
      '漲跌(+/-)': idx['漲跌(+/-)'] !== undefined ? (fields[idx['漲跌(+/-)']] || '').trim() : '',
      '漲跌價差': toNumber(fields[idx['漲跌價差']]),
      '最後揭示買價': toNumber(fields[idx['最後揭示買價']]),
      '最後揭示買量': toNumber(fields[idx['最後揭示買量']]),
      '最後揭示賣價': toNumber(fields[idx['最後揭示賣價']]),
      '最後揭示賣量': toNumber(fields[idx['最後揭示賣量']]),
      '本益比': toNumber(fields[idx['本益比']])
    });
  }
  if (rows.length < 5) throw new Error('MI_INDEX 資料過少 (' + dateStr + ')');
  return rows;
}

// ============================================================
// BWIBBU_d：殖利率 / 本益比 / 股價淨值比
// ============================================================
function fetchBwibbu_(dateStr) {
  var url = 'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=' + dateStr + '&selectType=ALL&response=csv';
  var text = fetchCsvText_(url);
  var lines = splitLines_(text);

  var headerIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('證券代號') !== -1) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error('BWIBBU 找不到證券代號標題列 (' + dateStr + ')');

  var dataLines = [];
  for (var k = headerIdx; k < lines.length; k++) {
    var line = lines[k];
    var commaCount = (line.match(/,/g) || []).length;
    if (commaCount >= 5) dataLines.push(line);
  }
  if (dataLines.length < 2) throw new Error('BWIBBU 資料為空或格式異常 (' + dateStr + ')');

  var headers = parseCsvLine_(dataLines[0]).map(function (h) { return String(h).trim(); });
  var idx = indexHeaders_(headers);
  if (idx['證券代號'] === undefined) throw new Error('BWIBBU 找不到證券代號欄位 (' + dateStr + ')');

  var rows = [];
  for (var r = 1; r < dataLines.length; r++) {
    var fields = parseCsvLine_(dataLines[r]);
    if (fields.length < headers.length - 2) continue;
    var code = cleanCode_(fields[idx['證券代號']]);
    if (!code) continue;
    rows.push({
      '證券代號': code,
      '殖利率(%)': idx['殖利率(%)'] !== undefined ? toNumber(fields[idx['殖利率(%)']]) : 0,
      '本益比': idx['本益比'] !== undefined ? toNumber(fields[idx['本益比']]) : 0,
      '股價淨值比': idx['股價淨值比'] !== undefined ? toNumber(fields[idx['股價淨值比']]) : 0,
      '財報年/季': idx['財報年/季'] !== undefined ? (fields[idx['財報年/季']] || '').trim() : ''
    });
  }
  return rows;
}

/** 抓單一日期，合併 T86 (inner) + MI_INDEX + BWIBBU (left)，回傳 History 欄位格式的列陣列。 */
function fetchAndMergeOneDay_(dateStr, formattedDate) {
  var t86Rows = fetchT86_(dateStr);
  var miRows = fetchMiIndex_(dateStr);
  var bwRows = fetchBwibbu_(dateStr);

  var miByCode = {};
  miRows.forEach(function (r) { miByCode[r['證券代號']] = r; });
  var bwByCode = {};
  bwRows.forEach(function (r) { bwByCode[r['證券代號']] = r; });

  var merged = [];
  t86Rows.forEach(function (t) {
    var mi = miByCode[t['證券代號']];
    if (!mi) return; // inner join：MI_INDEX 沒有這檔就跳過（比照原本 pandas inner merge）
    var bw = bwByCode[t['證券代號']] || {};
    merged.push({
      '日期': formattedDate,
      '證券代號': t['證券代號'],
      '證券名稱': t['證券名稱'] || mi['證券名稱'] || '',
      '外資': t['外資'],
      '投信': t['投信'],
      '自營商': t['自營商'],
      '三大法人買賣超股數': t['三大法人買賣超股數'],
      '成交股數': mi['成交股數'],
      '成交筆數': mi['成交筆數'],
      '成交金額': mi['成交金額'],
      '開盤價': mi['開盤價'],
      '最高價': mi['最高價'],
      '最低價': mi['最低價'],
      '收盤價': mi['收盤價'],
      '漲跌(+/-)': mi['漲跌(+/-)'],
      '漲跌價差': mi['漲跌價差'],
      '最後揭示買價': mi['最後揭示買價'],
      '最後揭示買量': mi['最後揭示買量'],
      '最後揭示賣價': mi['最後揭示賣價'],
      '最後揭示賣量': mi['最後揭示賣量'],
      '殖利率(%)': bw['殖利率(%)'] !== undefined ? bw['殖利率(%)'] : 0,
      '本益比': bw['本益比'] !== undefined ? bw['本益比'] : mi['本益比'],
      '股價淨值比': bw['股價淨值比'] !== undefined ? bw['股價淨值比'] : 0,
      '財報年/季': bw['財報年/季'] || ''
    });
  });
  if (merged.length === 0) throw new Error('T86 與 MI_INDEX 合併後沒有資料 (' + dateStr + ')');
  return merged;
}

/** 'yyyy-MM-dd'（給 backfillHistory 的 startStr/endStr/nextStart 用，跟 formatYmd_ 的
 *  'yyyyMMdd' 是不同格式——之前 nextStart 誤用 formatYmd_，回傳的 'yyyyMMdd' 字串再餵回
 *  new Date(startStr + 'T00:00:00') 沒有 '-' 會解析失敗，續跑第二批就會整個壞掉）。 */
function formatDashedYmd_(date) {
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd');
}

/**
 * 補抓/重新合併一段日期區間，**一次只處理一天**，抓完立刻 upsert 進 History（同日期資料
 * 會被新抓到的取代），回傳這一天的結果 + 還有沒有下一天要繼續（nextStart）。跳過規則跟
 * 每日排程共用一份設定（後台管理的「六日不執行」與「臨時停跑日」）。
 *
 * 之前是內部跑 4.5 分鐘時間預算、一次處理一整批天數，前端只能在「一整批」結束後才更新一次
 * 進度，使用者完全看不到目前處理到哪一天；而且單次呼叫動輒好幾分鐘，手機瀏覽器切到背景時
 * 這一整批很容易被中斷、噴出網路錯誤，而且中斷後不知道實際做到哪一天。改成一次一天之後，
 * 每次 google.script.run 呼叫只有一天的 TWSE 抓取時間（通常幾秒），前端可以逐天顯示「目前在
 * 處理哪一天」，就算中途被中斷，也只損失「正在處理的這一天」，重新呼叫同一天繼續就好，
 * 不用整批重來。
 */
function backfillHistory(startStr, endStr) {
  var cur = new Date(startStr + 'T00:00:00');
  var end = new Date(endStr + 'T00:00:00');
  if (cur.getTime() > end.getTime()) {
    return { done: true, result: null, nextStart: null };
  }

  var settings = getScheduleSettings();
  var ymd = formatYmd_(cur);
  var result;
  var skip = shouldSkipDate_(cur, settings);
  if (skip.skip) {
    result = { kind: 'skipped', date: ymd, reason: skip.reason };
  } else {
    var slash = formatSlashDate_(cur);
    try {
      var rows = fetchAndMergeOneDay_(ymd, slash);
      upsertHistoryRows_(rows);
      result = { kind: 'succeeded', date: ymd };
    } catch (e) {
      result = { kind: 'failed', date: ymd, error: String(e.message || e) };
    }
  }

  var next = new Date(cur);
  next.setDate(next.getDate() + 1);
  var done = next.getTime() > end.getTime();
  return { done: done, result: result, nextStart: done ? null : formatDashedYmd_(next) };
}

/** 手動「立即更新今日資料」按鈕用。 */
function runManualFetchToday() {
  var startTime = Date.now();
  var today = new Date();
  var ymd = formatYmd_(today);
  var slash = formatSlashDate_(today);
  try {
    var rows = fetchAndMergeOneDay_(ymd, slash);
    var result = upsertHistoryRows_(rows);
    var dur = Math.round((Date.now() - startTime) / 1000);
    logRun_('手動更新', '成功', '已更新 ' + ymd + '，' + rows.length + ' 檔股票', dur);
    return { ok: true, date: ymd, count: rows.length, totalRows: result.totalRows };
  } catch (e) {
    var dur2 = Math.round((Date.now() - startTime) / 1000);
    logRun_('手動更新', '失敗', String(e.message || e), dur2);
    return { ok: false, date: ymd, error: String(e.message || e) };
  }
}

/** 由時間觸發器呼叫的每日排程進入點（實作在 Scheduler.gs 的 shouldSkipToday_ 一起使用）。 */
function scheduledDailyFetch() {
  var startTime = Date.now();
  var today = new Date();
  var skip = shouldSkipToday_(today);
  if (skip.skip) {
    logRun_('每日排程', '略過', skip.reason, 0);
    return;
  }
  var ymd = formatYmd_(today);
  var slash = formatSlashDate_(today);
  try {
    var rows = fetchAndMergeOneDay_(ymd, slash);
    upsertHistoryRows_(rows);
    try {
      // materialized 模式下，today 剛寫進 Drive 的新資料要先重新整理進 BigQuery 原生表，
      // 不然 runAnalysisAndSave() 可能讀到「重新整理間隔還沒到」的舊版本，漏掉今天這筆。
      var bqSettings = getBigQuerySettings();
      if (bqSettings.projectId && bqSettings.sourceMode === 'materialized') {
        materializeHistoryTableIfStale_(0);
      }
    } catch (materializeErr) {
      logRun_('每日排程-BigQuery整理', '失敗', String(materializeErr.message || materializeErr), 0);
    }
    try {
      runAnalysisAndSave();
    } catch (analysisErr) {
      logRun_('每日排程-分析', '失敗', String(analysisErr.message || analysisErr), 0);
    }
    try {
      runDailyAiDiagnosisForTopPicks();
    } catch (aiErr) {
      logRun_('每日排程-AI診斷', '失敗', String(aiErr.message || aiErr), 0);
    }
    var dur = Math.round((Date.now() - startTime) / 1000);
    logRun_('每日排程', '成功', '已更新 ' + ymd + '，' + rows.length + ' 檔股票', dur);
  } catch (e) {
    var dur2 = Math.round((Date.now() - startTime) / 1000);
    logRun_('每日排程', '失敗', String(e.message || e), dur2);
  }
}
