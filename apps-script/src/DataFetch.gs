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

/** 對應 pandas 清理 '證券代號' 欄位：去掉 ="..." 包裝與多餘引號/空白，
 *  最後再過一次 sanitizeStockId_ 做格式驗證/正規化（去零寬字元、Excel 數字尾巴等），
 *  格式明顯不對的股票代號在這裡就會變成空字串、被呼叫端的 `if (!code) continue;` 跳過，
 *  不會讓髒資料一路流進歷史資料庫。 */
function cleanCode_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v).split('="').join('');
  s = s.replace(/^"+|"+$/g, '');
  s = s.trim();
  return sanitizeStockId_(s);
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
    var rawCode = (fields[idx['證券代號']] || '').trim();
    if (!rawCode || rawCode === '證券代號') continue;
    var code = sanitizeStockId_(rawCode);
    if (!code) continue;

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

/** 'yyyy-MM-dd'（給補抓 job 的 startStr/endStr/cursor 用，跟 formatYmd_ 的 'yyyyMMdd' 是
 *  不同格式——早期版本續跑用的日期字串誤用 formatYmd_，回傳的 'yyyyMMdd' 字串再餵回
 *  new Date(startStr + 'T00:00:00') 沒有 '-' 會解析失敗，續跑第二批就會整個壞掉）。 */
function formatDashedYmd_(date) {
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd');
}

/** 處理「一天」：跳過規則跟每日排程共用一份設定（後台管理的「六日不執行」與「臨時停跑日」）。 */
function backfillOneDay_(cur, settings) {
  var ymd = formatYmd_(cur);
  var skip = shouldSkipDate_(cur, settings);
  if (skip.skip) return { kind: 'skipped', date: ymd, reason: skip.reason };
  var slash = formatSlashDate_(cur);
  try {
    var rows = fetchAndMergeOneDay_(ymd, slash);
    upsertHistoryRows_(rows);
    return { kind: 'succeeded', date: ymd, rowCount: rows.length };
  } catch (e) {
    return { kind: 'failed', date: ymd, error: String(e.message || e) };
  }
}

// ============================================================
// 補抓/重新彙整區間：背景 job
// 用時間觸發器（跟每日排程共用同一套機制）在背景處理，完全不依賴瀏覽器分頁保持開啟或
// 保持連線——按下按鈕後這次呼叫立刻回傳，實際抓取工作在另一次獨立觸發的執行裡進行，
// 切到別的 App、關掉螢幕都不會中斷，前端只需要輪詢 getBackfillJobStatus() 顯示進度。
// ============================================================

function getBackfillJobState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.BACKFILL_JOB_STATE);
  return raw ? JSON.parse(raw) : null;
}

function saveBackfillJobState_(state) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.BACKFILL_JOB_STATE, JSON.stringify(state));
}

function deleteBackfillJobTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processBackfillJobTick_') ScriptApp.deleteTrigger(t);
  });
}

/** 前端「重新抓取/合併此區間」送出表單時呼叫：存好 job 狀態、排一個幾乎立刻觸發的一次性
 *  時間觸發器就馬上回傳（不在這次呼叫裡處理任何一天），所以這次 google.script.run 呼叫
 *  本身非常快，不會因為抓取本身很花時間而被瀏覽器分頁中斷。 */
function startBackfillJob(startStr, endStr) {
  deleteBackfillJobTriggers_();
  saveBackfillJobState_({
    startStr: startStr, endStr: endStr, cursor: startStr,
    succeeded: [], failed: [], skipped: [],
    status: 'running', updatedAt: Date.now()
  });
  ScriptApp.newTrigger('processBackfillJobTick_').timeBased().after(3000).create();
  return { status: 'running' };
}

/** 前端輪詢用：目前這個背景 job 的狀態。不管是不是自己那個分頁開的，任何時候打開頁面
 *  呼叫這個都看得到最新進度（或是已經做完的結果），因為狀態存在 Script Properties，
 *  不是存在瀏覽器分頁的記憶體裡。 */
function getBackfillJobStatus() {
  return autoHealStaleJobState_(CONFIG.PROP_KEYS.BACKFILL_JOB_STATE, getBackfillJobState_() || { status: 'idle' });
}

/** 使用者按「取消」：標記狀態，讓還在排隊中的下一次 tick 執行時看到就直接停下來，
 *  同時清掉已經排定、還沒觸發的觸發器（如果剛好卡在兩次 tick 之間）。 */
function cancelBackfillJob() {
  var state = getBackfillJobState_();
  if (state && state.status === 'running') {
    state.status = 'cancelled';
    state.updatedAt = Date.now();
    saveBackfillJobState_(state);
  }
  deleteBackfillJobTriggers_();
  return getBackfillJobStatus();
}

/**
 * 排程佇列的「刪除」按鈕呼叫：不管目前狀態是什麼，直接清掉狀態跟任何已排定的觸發器，
 * 回到乾淨的 idle。用在觸發器不知道為什麼沒有真的被 Apps Script 觸發、狀態卡在 running
 * 卻再也不會有進度的情況——這種情況下 cancelBackfillJob() 也沒用（它假設還會有下一次
 * tick 來看到 cancelled 狀態，但卡住的工作根本不會再有下一次 tick）。
 * 如果那個卡住的執行其實還是活的（只是很慢），刪除並不會真的中斷它，只是不再顯示/追蹤，
 * 它跑完後寫回的狀態會覆蓋掉這次刪除——這是 Apps Script 觸發器機制本身的限制，無法從
 * 另一次執行裡強制終止一次正在跑的執行。
 */
function clearBackfillJob_() {
  deleteBackfillJobTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.PROP_KEYS.BACKFILL_JOB_STATE);
  return { status: 'idle' };
}

/**
 * 真正做事的地方，由時間觸發器呼叫（不是 google.script.run），完全不受瀏覽器分頁影響。
 * 有 4.5 分鐘內部時間預算，時間到了就存好目前進度、排下一次 tick 繼續，直到整段
 * 區間跑完、被取消，或遇到未預期的例外（會被接住寫進 job 狀態變成 status:'error'，
 * 不會讓整條鏈就這樣默默停在 'running' 卻再也不會有進度）。
 */
function processBackfillJobTick_() {
  deleteBackfillJobTriggers_();
  var state = getBackfillJobState_();
  if (!state || state.status !== 'running') return;

  var scriptStart = Date.now();
  var TIME_BUDGET_MS = 4.5 * 60 * 1000;

  try {
    var settings = getScheduleSettings();
    var cur = new Date(state.cursor + 'T00:00:00');
    var end = new Date(state.endStr + 'T00:00:00');

    while (cur.getTime() <= end.getTime()) {
      // 每處理完一天都重新讀一次狀態，讓使用者按下「取消」能盡快生效，不用等整批時間預算跑完。
      var latest = getBackfillJobState_();
      if (!latest || latest.status !== 'running') return;

      if (Date.now() - scriptStart > TIME_BUDGET_MS) {
        state.cursor = formatDashedYmd_(cur);
        state.updatedAt = Date.now();
        saveBackfillJobState_(state);
        ScriptApp.newTrigger('processBackfillJobTick_').timeBased().after(3000).create();
        return;
      }

      var result = backfillOneDay_(cur, settings);
      if (result.kind === 'succeeded') state.succeeded.push(result.date);
      else if (result.kind === 'skipped') state.skipped.push({ date: result.date, reason: result.reason });
      else if (result.kind === 'failed') state.failed.push({ date: result.date, error: result.error });
      cur.setDate(cur.getDate() + 1);
    }

    state.status = 'done';
    state.cursor = null;
    state.updatedAt = Date.now();
    saveBackfillJobState_(state);
    logRun_('資料範圍重新彙整', '成功',
      '成功 ' + state.succeeded.length + ' 天、略過 ' + state.skipped.length + ' 天、失敗 ' + state.failed.length + ' 天',
      Math.round((Date.now() - scriptStart) / 1000));
  } catch (e) {
    state.status = 'error';
    state.errorMessage = String(e.message || e);
    state.updatedAt = Date.now();
    saveBackfillJobState_(state);
    logRun_('資料範圍重新彙整', '失敗', String(e.message || e), Math.round((Date.now() - scriptStart) / 1000));
  }
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

/** 每日排程「最近一次執行」步驟時間軸用：記一筆某個步驟的起訖時間/狀態/摘要進 steps 陣列。
 *  startedAt 由呼叫端在該步驟開始時先記下 Date.now()，這裡結束時才 push，這樣即使該步驟
 *  中途拋例外，只要外層有 try/catch 接住還是能正確記到「這步驟花了多久」。 */
function recordScheduledStep_(steps, label, status, detail, startedAt) {
  steps.push({ label: label, status: status, detail: detail || '', startedAt: startedAt, endedAt: Date.now() });
}

/** 供前端「每日自動排程」區塊顯示：最近一次 scheduledDailyFetch() 依序執行的每個步驟
 *  起訖時間、狀態、摘要——不用只看 RunLog 裡零散的幾筆訊息自己拼湊「到底跑到哪一步、
 *  卡在哪裡、花了多久」，一次看到完整時間軸。每次執行都會整包覆蓋，只保留最近一次。 */
function getLastScheduledRunSteps() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.LAST_SCHEDULED_RUN);
  return raw ? JSON.parse(raw) : null;
}

function saveLastScheduledRunSteps_(steps, overallStatus, summary, startedAt) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.LAST_SCHEDULED_RUN, JSON.stringify({
    steps: steps, overallStatus: overallStatus, summary: summary, startedAt: startedAt, endedAt: Date.now()
  }));
}

/**
 * 每日排程 5 個步驟的定義 + 執行引擎。每個 runner 接收共用的 ctx（跨步驟傳遞像 cursor/
 * todayOnly/settings 這種需要往後帶的值），回傳 { status: 'success'|'partial'|'skipped',
 * detail: string }，或直接 throw（真的出錯，不是「這步驟本身設計上就允許的部分失敗」）。
 *
 * runScheduledSteps_ 依序執行，只要有一步 throw，立刻停止、不跑後面的步驟——這是使用者
 * 明確要的行為：後面步驟只是拿同一份舊資料重算一次一模一樣的舊結果，沒有意義，寧可停
 * 下來讓人看到哪一步壞了、針對性重跑，而不是蒙混過關、讓「排程跑完了」的假象掩蓋掉
 * 「其實資料根本沒更新」的事實。'partial'（目前只有補抓資料會用到：部分日期失敗但至少
 * 有成功的）不算整步失敗，會繼續跑下一步。
 */
var SCHEDULE_STEP_DEFS_ = [
  { label: '檢查最新資料日期', run: runScheduleStep1_ },
  { label: '補抓資料', run: runScheduleStep2_ },
  { label: 'BigQuery 整理', run: runScheduleStep3_ },
  { label: '重新計算戰報', run: runScheduleStep4_ },
  { label: '每日自動 AI 診斷', run: runScheduleStep5_ }
];

/** 檢查大表目前最新資料日期，決定要從哪一天開始補抓；抓不到既有最新日期時（例如全新
 *  安裝、或查詢本身失敗——後者會直接 throw，交給外層引擎判定整步失敗、停止後續步驟）
 *  就從「今天」開始抓。 */
function runScheduleStep1_(ctx) {
  var overview = getHistoryOverview();
  var cursor = null;
  if (overview && overview.max) {
    var next = new Date(overview.max + 'T00:00:00');
    next.setDate(next.getDate() + 1);
    cursor = new Date(next.getFullYear(), next.getMonth(), next.getDate());
  }
  if (!cursor || cursor > ctx.todayOnly) cursor = ctx.todayOnly;
  ctx.cursor = cursor;
  return { status: 'success', detail: overview && overview.max ? '目前最新資料：' + overview.max : '查無既有資料，改抓今天' };
}

/** 從 ctx.cursor 逐天抓到今天為止（含）。單次執行最多補 MAX_CATCHUP_DAYS 天，避免缺口
 *  太大時單一步驟自己就跑超過時間預算（見 runScheduledSteps_ 的時間預算說明——目前只有
 *  「跨步驟」之間會檢查預算、換下一次 tick 繼續，單一步驟內部（例如這裡逐天迴圈）還沒有
 *  拆更細的時間預算檢查，缺口太大時這步本身還是有機會跑很久）；缺口更大時請改用「資料
 *  總覽」的「重新抓取/合併此區間」背景 job（那個才是真的逐日都有時間預算、分批續跑）。
 *  一整天都沒抓到（succeeded 是空的、又確實有失敗）才 throw、判定整步失敗停止後續步驟——
 *  只要至少有一天成功，代表有新資料值得往下跑（重新計算戰報才有意義），算 partial 不算
 *  整步失敗。 */
function runScheduleStep2_(ctx) {
  var MAX_CATCHUP_DAYS = 5;
  var succeeded = [], skipped = [], failed = [], truncated = false, processedDays = 0, totalRowCount = 0;
  var cursor = ctx.cursor;
  while (cursor <= ctx.todayOnly) {
    if (processedDays >= MAX_CATCHUP_DAYS) { truncated = true; break; }
    var dayResult = backfillOneDay_(cursor, ctx.settings);
    if (dayResult.kind === 'succeeded') { succeeded.push(dayResult.date); totalRowCount += dayResult.rowCount || 0; }
    else if (dayResult.kind === 'skipped') skipped.push(dayResult.date);
    else failed.push(dayResult.date + '：' + dayResult.error);
    processedDays++;
    cursor.setDate(cursor.getDate() + 1);
  }
  if (truncated) {
    logRun_('每日排程-補抓資料', '失敗',
      '資料缺口超過 ' + MAX_CATCHUP_DAYS + ' 天，本次只補到 ' + (succeeded[succeeded.length - 1] || skipped[skipped.length - 1] || '（無）') +
      '，剩餘天數請用「資料總覽」的「重新抓取/合併此區間」補齊', 0);
  }
  var summary = '成功 ' + succeeded.length + ' 天' + (succeeded.length ? '，共 ' + totalRowCount + ' 筆' : '') +
    (skipped.length ? '、略過 ' + skipped.length + ' 天' : '') +
    (failed.length ? '、失敗 ' + failed.length + ' 天（' + failed.join('; ') + '）' : '') + (truncated ? '（缺口過大，已截斷）' : '');
  if (succeeded.length === 0 && failed.length > 0) throw new Error(summary);
  return { status: (failed.length || truncated) ? 'partial' : 'success', detail: summary };
}

/** materialized 模式下，剛寫進去的新資料要先重新整理進 BigQuery 原生表。 */
function runScheduleStep3_(ctx) {
  var bqSettings = getBigQuerySettings();
  if (bqSettings.projectId && bqSettings.sourceMode === 'materialized') {
    materializeHistoryTableIfStale_(0);
    return { status: 'success', detail: '' };
  }
  return { status: 'skipped', detail: '非 materialized 模式，略過' };
}

/** 重新計算戰報。 */
function runScheduleStep4_(ctx) {
  var analysisResult = runAnalysisAndSave();
  var detail = analysisResult && analysisResult.latestDate
    ? '戰報日期 ' + analysisResult.latestDate + '，' + analysisResult.report.length + ' 檔訊號' +
      (analysisResult.diagnostics && analysisResult.diagnostics.totalStocks !== undefined ? '（共掃描 ' + analysisResult.diagnostics.totalStocks + ' 檔）' : '')
    : '沒有可用的歷史資料，查無戰報';
  return { status: 'success', detail: detail };
}

/** 每日自動 AI 診斷（候選名單深度診斷 + Top3 橫向比較）。 */
function runScheduleStep5_(ctx) {
  var aiResult = runDailyAiDiagnosisForTopPicks();
  if (aiResult.skipped) return { status: 'skipped', detail: aiResult.reason };
  var detail = '候選名單深度診斷：' + (aiResult.shortlist.ok ? '成功' : '失敗（' + aiResult.shortlist.error + '）') +
    '　Top3 橫向比較：' + (aiResult.topPicks.ok ? '成功' : '失敗（' + aiResult.topPicks.error + '）');
  return { status: (aiResult.shortlist.ok && aiResult.topPicks.ok) ? 'success' : 'partial', detail: detail };
}

/**
 * Apps Script 單次執行大約有 6 分鐘的硬性上限，超過會被平台直接強制終止——不是拋出一般的
 * JS 例外，程式碼完全沒有機會再繼續執行，任何 try/catch 都接不住。實測真的撞過這個問題：
 * `scheduledDailyFetch()` 原本把 5 個步驟全部同步塞在同一次執行裡（沒有補抓資料天數比較多、
 * 或每日自動 AI 診斷要對好幾檔股票各自呼叫 AI API 時，很容易跑超過 6 分鐘），導致
 * 「最近一次排程執行」永遠是 null——不是沒被觸發，是每次真的觸發了，卻都在寫入執行紀錄
 * 之前就被平台砍斷，saveLastScheduledRunSteps_ 永遠沒有機會被呼叫到。
 * 所以留 1.5 分鐘緩衝、只給 4.5 分鐘時間預算，跟其他背景 job（補抓區間、AI 診斷…）的
 * 4.5 分鐘預算是同一個保守值。這個預算是在「跨步驟之間」檢查（每個步驟開始前才看還有沒有
 * 預算），不是拆到每個步驟內部——單一步驟本身（尤其補抓資料如果缺口比較大、或 AI 診斷
 * 要跑好幾檔股票）理論上還是有機會單獨超過預算，但正常情況下（一天只補一天的量）每步
 * 都遠遠不到 4.5 分鐘，這個殘餘風險先不處理，真的缺口很大時本來就有專門的「重新抓取/合併
 * 此區間」背景 job 可以用。
 */
var SCHEDULE_STEP_TIME_BUDGET_MS_ = 4.5 * 60 * 1000;

/**
 * 依序執行每日排程步驟，從 startIndex（0-based）開始，每個步驟開始前先檢查時間預算
 * （budgetStartMs 到現在經過的時間）夠不夠，預算用完就停在這裡（不算失敗，只是這次
 * tick 先做到這裡），回傳 nextStepIndex 讓呼叫端（processScheduleResumeJobTick_）知道
 * 要排下一次 tick 從哪一步繼續。真的 throw（步驟本身出錯，不是時間預算問題）才會整個
 * 判定成失敗、硬停不再繼續——這是使用者明確要的行為：後面步驟只是拿同一份舊資料重算一次
 * 一模一樣的舊結果，沒有意義，寧可停下來讓人看到哪一步壞了、針對性重跑，而不是蒙混過關。
 * previousSteps 是「上一次執行紀錄」的 steps 陣列，取 startIndex 之前的部分直接沿用
 * （不重跑，保留原本的起訖時間/狀態/摘要），讓畫面上的時間軸不管重跑幾次、跨幾個 tick，
 * 都是完整的 5 步紀錄。
 */
function runScheduledSteps_(startIndex, previousSteps, budgetStartMs) {
  var tickStart = Date.now();
  var budgetDeadline = (budgetStartMs || tickStart) + SCHEDULE_STEP_TIME_BUDGET_MS_;
  var steps = (previousSteps || []).slice(0, startIndex);
  var today = new Date();
  var ctx = {
    settings: getScheduleSettings(),
    todayOnly: new Date(today.getFullYear(), today.getMonth(), today.getDate())
  };

  var i = startIndex;
  var timedOut = false;
  for (; i < SCHEDULE_STEP_DEFS_.length; i++) {
    if (Date.now() >= budgetDeadline) { timedOut = true; break; }
    var def = SCHEDULE_STEP_DEFS_[i];
    var stepStart = Date.now();
    try {
      var result = def.run(ctx);
      recordScheduledStep_(steps, def.label, result.status, result.detail, stepStart);
    } catch (e) {
      logRun_('每日排程-' + def.label, '失敗', String(e.message || e), 0);
      recordScheduledStep_(steps, def.label, 'failed', String(e.message || e), stepStart);
      i = SCHEDULE_STEP_DEFS_.length; // 硬停：後面的步驟不用再跑，直接視為跑到底（非 timeout）
      break;
    }
  }

  var hasFailed = steps.some(function (s) { return s.status === 'failed'; });
  var hasPartial = steps.some(function (s) { return s.status === 'partial'; });
  var reachedEnd = i >= SCHEDULE_STEP_DEFS_.length;
  var stillPending = timedOut && !reachedEnd && !hasFailed;
  var overallStatus = hasFailed ? 'failed' : (stillPending ? 'running' : (hasPartial ? 'partial' : 'success'));
  var summary = steps.map(function (s) { return s.label + '：' + s.status; }).join('、') +
    (stillPending ? '（時間預算用完，已自動排下一段繼續）' : '');
  logRun_('每日排程', hasFailed ? '失敗' : (stillPending ? '執行中' : (overallStatus === 'partial' ? '部分成功' : '成功')),
    summary, Math.round((Date.now() - tickStart) / 1000));
  saveLastScheduledRunSteps_(steps, overallStatus, summary, budgetStartMs || tickStart);
  return { steps: steps, overallStatus: overallStatus, summary: summary, nextStepIndex: stillPending ? i : null };
}

/**
 * 由時間觸發器呼叫的每日排程進入點（實作在 Scheduler.gs 的 shouldSkipToday_ 一起使用）。
 * 只做「檢查今天該不該跑」+ 排一個背景 job 就馬上回傳，實際 5 個步驟在另一次獨立觸發的
 * 執行裡進行（跟「從這步重跑」共用同一套機制，見下方）——這支函式本身現在只做很少的事，
 * 幾乎不可能跑到接近 6 分鐘上限，這正是要修的問題本身：改之前這裡直接同步跑完整套 5 個
 * 步驟，補抓資料天數多、或 AI 診斷要對好幾檔股票各自呼叫 AI API 時很容易超過 Apps Script
 * 6 分鐘的單次執行上限，被平台直接強制終止（不是拋出例外，任何 try/catch 都接不住），
 * 導致「最近一次排程執行」永遠是 null。外層仍然包一層 try/catch 當最後防線，防的是
 * shouldSkipToday_/startResumeScheduledRunJob 本身丟出的例外（例如試算表讀取失敗），
 * 兩者都是快速操作，不會有超時風險。
 */
function scheduledDailyFetch() {
  var startTime = Date.now();
  try {
    var today = new Date();
    var skip = shouldSkipToday_(today);
    if (skip.skip) {
      logRun_('每日排程', '略過', skip.reason, 0);
      saveLastScheduledRunSteps_([], 'skipped', skip.reason, startTime);
      return;
    }
    startResumeScheduledRunJob(0);
  } catch (e) {
    logRun_('每日排程', '失敗', '未預期的例外（步驟外層）：' + String(e.message || e), Math.round((Date.now() - startTime) / 1000));
    saveLastScheduledRunSteps_([], 'failed', '未預期的例外：' + String(e.message || e), startTime);
  }
}

// ============================================================
// 每日排程實際執行的背景 job（機制跟其他背景 job 相同）：scheduledDailyFetch() 跟前端
// 「從這步重跑」／「立即測試整套排程流程」都是排這個 job，只是起始 stepIndex 不同
// （0＝從頭開始，N＝從失敗那步繼續）。單一 tick 跑不完（時間預算用完）會自動排下一次
// tick 從中斷的地方繼續，不會被 Apps Script 6 分鐘單次執行上限打斷（見 runScheduledSteps_
// 的說明）。
// ============================================================

function getScheduleResumeJobState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.SCHEDULE_RESUME_JOB_STATE);
  return raw ? JSON.parse(raw) : null;
}

function saveScheduleResumeJobState_(state) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.SCHEDULE_RESUME_JOB_STATE, JSON.stringify(state));
}

function deleteScheduleResumeJobTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processScheduleResumeJobTick_') ScriptApp.deleteTrigger(t);
  });
}

/** 排一個幾乎立刻觸發的一次性時間觸發器就馬上回傳，實際重跑在另一次獨立觸發的執行裡
 *  進行，不受這次呼叫端（瀏覽器連線或時間觸發器本身）影響。stepIndex 是 0-based 的步驟
 *  編號（0=檢查最新資料日期 ... 4=每日自動AI診斷）。overallStartedAt 是這整段（可能跨
 *  多個 tick）的起始時間，用來算時間預算的截止點跟畫面上顯示的總耗時——每次呼叫這個
 *  函式都視為一次新的開始（不管是真正排程觸發、使用者按「從這步重跑」、還是「立即測試」），
 *  重設成現在時間。 */
function startResumeScheduledRunJob(stepIndex) {
  deleteScheduleResumeJobTriggers_();
  saveScheduleResumeJobState_({ status: 'running', stepIndex: stepIndex, overallStartedAt: Date.now(), updatedAt: Date.now() });
  ScriptApp.newTrigger('processScheduleResumeJobTick_').timeBased().after(3000).create();
  return { status: 'running' };
}

function getResumeScheduledRunJobStatus() {
  return autoHealStaleJobState_(CONFIG.PROP_KEYS.SCHEDULE_RESUME_JOB_STATE, getScheduleResumeJobState_() || { status: 'idle' });
}

function clearScheduleResumeJob_() {
  deleteScheduleResumeJobTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.PROP_KEYS.SCHEDULE_RESUME_JOB_STATE);
  return { status: 'idle' };
}

function processScheduleResumeJobTick_() {
  deleteScheduleResumeJobTriggers_();
  var state = getScheduleResumeJobState_();
  if (!state || state.status !== 'running') return;
  try {
    var last = getLastScheduledRunSteps();
    var result = runScheduledSteps_(state.stepIndex, last ? last.steps : null, state.overallStartedAt);
    if (result.nextStepIndex !== null) {
      // 時間預算用完，還沒跑到底：更新進度、排下一次 tick 繼續，這次 tick 先不標記成 done。
      state.stepIndex = result.nextStepIndex;
      state.updatedAt = Date.now();
      saveScheduleResumeJobState_(state);
      ScriptApp.newTrigger('processScheduleResumeJobTick_').timeBased().after(3000).create();
      return;
    }
    state.status = result.overallStatus === 'failed' ? 'error' : 'done';
    if (result.overallStatus === 'failed') state.errorMessage = result.summary;
  } catch (e) {
    state.status = 'error';
    state.errorMessage = String(e.message || e);
  }
  state.updatedAt = Date.now();
  saveScheduleResumeJobState_(state);
}
