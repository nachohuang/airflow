/**
 * Utils.gs
 * 純運算工具，取代 Colab 版本中大量使用的 pandas groupby / rolling / rank。
 * 這個檔案刻意不呼叫任何 Apps Script 專屬服務（SpreadsheetApp / DriveApp 等），
 * 這樣才能在本機用 Node.js 直接單元測試（見 test/utils.test.js）。
 */

/** 把可能帶逗號、'--'、null 的字串轉成數字，失敗一律回 0（對應 pandas fillna(0)）。 */
function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  var s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '--') return 0;
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** 同 toNumber，但轉換失敗時回傳 null 而非 0（用於不該被硬塞 0 的欄位）。 */
function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  var s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '--') return null;
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function isNullish_(v) {
  return v === null || v === undefined || (typeof v === 'number' && isNaN(v));
}

/** 股票代號補零到 4 碼（只補不截斷，5 碼 ETF 代號會維持 5 碼)。 */
function zfill4(code) {
  var s = String(code === null || code === undefined ? '' : code).trim();
  while (s.length < 4) s = '0' + s;
  return s;
}

/**
 * 清洗＋驗證股票代號：不同來源檔案對同一檔股票的 stock_id 字串格式常常不一致——多空白、
 * 零寬字元/BOM、Excel 或 Google Sheets 把代號當數字存產生的 ".0" 尾巴、千分位逗號殘留等，
 * 這些格式差異會讓同一檔股票在 BigQuery 去重時被當成好幾檔不同的股票（這就是「股票數
 * （去重後）」異常暴增到 5 萬多筆的根本原因）。這裡統一清洗成同一種表示法：
 *   1. 去除零寬字元/BOM
 *   2. 去頭尾空白
 *   3. 去掉 Excel/Sheets 把代號存成數字產生的小數點尾巴（例如 "2330.0" -> "2330"）
 *   4. 去除內部空白與千分位逗號
 *   5. 只保留英數字
 * 清洗後長度不在 4~6 碼範圍內（台股一般股票 4 碼，部分 ETF/權證類 5~6 碼）視為無效，
 * 回傳空字串，呼叫端要自己決定怎麼處理無效值（通常是整列捨棄）。
 * 這只負責「格式是否像一個代號」，不負責「補零到固定長度」——那是 zfill4 的責任，
 * 兩個函式刻意分開，呼叫端依需要各自組合。
 */
function sanitizeStockId_(rawId) {
  if (rawId === null || rawId === undefined) return '';
  var s = String(rawId);
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.trim();
  s = s.replace(/\.0+$/, '');
  s = s.replace(/[,\s]/g, '');
  s = s.replace(/[^0-9A-Za-z]/g, '');
  if (s.length < 4 || s.length > 6) return '';
  return s.toUpperCase();
}

/** 依 keyFn 分組，回傳 Map(key -> rows[])，保留原始相對順序。 */
function groupBy(rows, keyFn) {
  var map = new Map();
  for (var i = 0; i < rows.length; i++) {
    var k = keyFn(rows[i]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(rows[i]);
  }
  return map;
}

/** 泛用多鍵排序：comparators 是 [[fieldOrFn, 'asc'|'desc'], ...] */
function sortRows(rows, comparators) {
  var copy = rows.slice();
  copy.sort(function (a, b) {
    for (var i = 0; i < comparators.length; i++) {
      var field = comparators[i][0];
      var dir = comparators[i][1] === 'desc' ? -1 : 1;
      var av = typeof field === 'function' ? field(a) : a[field];
      var bv = typeof field === 'function' ? field(b) : b[field];
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
    }
    return 0;
  });
  return copy;
}

function sum_(arr) {
  var s = 0;
  for (var i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

function mean_(arr) {
  return arr.length === 0 ? null : sum_(arr) / arr.length;
}

/** 樣本標準差 (ddof=1)，對應 pandas 預設的 .std()。 */
function sampleStd_(arr) {
  if (arr.length < 2) return null;
  var m = mean_(arr);
  var sq = 0;
  for (var i = 0; i < arr.length; i++) sq += (arr[i] - m) * (arr[i] - m);
  return Math.sqrt(sq / (arr.length - 1));
}

/**
 * 對一個「已依日期排序」的數值陣列做滾動視窗運算。
 * 對應 pandas rolling(window).func()，預設 min_periods = window
 * （視窗內只要有任何一格是 null/NaN，該筆結果就是 null）。
 */
function rollingApply(values, window, reducerFn) {
  var n = values.length;
  var out = new Array(n).fill(null);
  for (var i = 0; i < n; i++) {
    if (i - window + 1 < 0) continue;
    var windowVals = values.slice(i - window + 1, i + 1);
    var hasNull = false;
    for (var j = 0; j < windowVals.length; j++) {
      if (isNullish_(windowVals[j])) { hasNull = true; break; }
    }
    if (hasNull) continue;
    out[i] = reducerFn(windowVals);
  }
  return out;
}

function rollingMean(values, window) {
  return rollingApply(values, window, mean_);
}

function rollingStd(values, window) {
  return rollingApply(values, window, sampleStd_);
}

function rollingSum(values, window) {
  return rollingApply(values, window, sum_);
}

function rollingMin(values, window) {
  return rollingApply(values, window, function (a) { return Math.min.apply(null, a); });
}

function rollingMax(values, window) {
  return rollingApply(values, window, function (a) { return Math.max.apply(null, a); });
}

/** 對應 pandas Series.pct_change()：(v[i]-v[i-1])/v[i-1]，前一筆為 0/null 時回 null。 */
function pctChange(values) {
  var n = values.length;
  var out = new Array(n).fill(null);
  for (var i = 1; i < n; i++) {
    var prev = values[i - 1];
    var cur = values[i];
    if (isNullish_(prev) || isNullish_(cur) || prev === 0) continue;
    out[i] = (cur - prev) / prev;
  }
  return out;
}

/** 對應 pandas Series.diff(n)。 */
function diffN(values, n) {
  var len = values.length;
  var out = new Array(len).fill(null);
  for (var i = n; i < len; i++) {
    if (isNullish_(values[i]) || isNullish_(values[i - n])) continue;
    out[i] = values[i] - values[i - n];
  }
  return out;
}

/** 對應 pandas Series.shift(n)（n 可為負數，代表往未來看）。 */
function shiftN(values, n) {
  var len = values.length;
  var out = new Array(len).fill(null);
  for (var i = 0; i < len; i++) {
    var src = i - n;
    if (src < 0 || src >= len) continue;
    out[i] = values[src];
  }
  return out;
}

/** 從頭開始的累積最大值 (expanding().max())。 */
function expandingMax(values) {
  var out = new Array(values.length).fill(null);
  var curMax = null;
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (!isNullish_(v)) {
      curMax = curMax === null ? v : Math.max(curMax, v);
    }
    out[i] = curMax;
  }
  return out;
}

/**
 * 座標邏輯用的「持有期最高價」：
 * startIdx 之前維持 floorValue（成本價）常數；
 * startIdx 起改成 max(floorValue, 該區間收盤價的累積最大值)。
 * 對應 v17.0 compute_adjusted_peak_v17。
 */
function expandingMaxFromIndex(values, startIdx, floorValue) {
  var out = new Array(values.length).fill(floorValue);
  var curMax = floorValue;
  for (var i = startIdx; i < values.length; i++) {
    var v = values[i];
    if (!isNullish_(v)) {
      curMax = Math.max(curMax, v);
    }
    out[i] = curMax;
  }
  return out;
}

/**
 * 同一天橫斷面的百分位排名，對應 pandas groupby('日期')[field].rank(pct=True)
 * (method='average'，NaN 不計入分母、結果為 null)。
 * rows: 同一天的資料列陣列；回傳與 rows 等長、對應每列排名百分位的陣列。
 */
function percentRank(rows, field) {
  var out = new Array(rows.length).fill(null);
  var indexed = [];
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i][field];
    if (!isNullish_(v)) indexed.push({ i: i, v: v });
  }
  var n = indexed.length;
  if (n === 0) return out;
  indexed.sort(function (a, b) { return a.v - b.v; });
  var i = 0;
  while (i < n) {
    var j = i;
    while (j + 1 < n && indexed[j + 1].v === indexed[i].v) j++;
    var avgRank = (i + 1 + j + 1) / 2;
    var pct = avgRank / n;
    for (var k = i; k <= j; k++) out[indexed[k].i] = pct;
    i = j + 1;
  }
  return out;
}

/** Pearson correlation coefficient，忽略任一邊為 null 的配對。 */
function pearsonCorrelation(xs, ys) {
  var xa = [], ya = [];
  for (var i = 0; i < xs.length; i++) {
    if (!isNullish_(xs[i]) && !isNullish_(ys[i])) {
      xa.push(xs[i]);
      ya.push(ys[i]);
    }
  }
  var n = xa.length;
  if (n < 2) return null;
  var mx = mean_(xa), my = mean_(ya);
  var sxy = 0, sxx = 0, syy = 0;
  for (var j = 0; j < n; j++) {
    var dx = xa[j] - mx, dy = ya[j] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** yyyy-MM-dd 字串比較用的日期正規化（避免時區問題，純字串操作）。 */
function normalizeDateStr(v) {
  if (v === null || v === undefined) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var y = v.getFullYear();
    var m = String(v.getMonth() + 1).padStart(2, '0');
    var d = String(v.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  var s = String(v).trim();
  var m2 = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m2) {
    return m2[1] + '-' + String(m2[2]).padStart(2, '0') + '-' + String(m2[3]).padStart(2, '0');
  }
  var m3 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m3) return m3[1] + '-' + m3[2] + '-' + m3[3];
  return s.slice(0, 10);
}

// ---- Node.js 測試用的匯出（Apps Script 執行環境沒有 module，這段不會被執行到）----
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    toNumber: toNumber,
    toNumberOrNull: toNumberOrNull,
    zfill4: zfill4,
    sanitizeStockId_: sanitizeStockId_,
    groupBy: groupBy,
    sortRows: sortRows,
    rollingMean: rollingMean,
    rollingStd: rollingStd,
    rollingSum: rollingSum,
    rollingMin: rollingMin,
    rollingMax: rollingMax,
    pctChange: pctChange,
    diffN: diffN,
    shiftN: shiftN,
    expandingMax: expandingMax,
    expandingMaxFromIndex: expandingMaxFromIndex,
    percentRank: percentRank,
    pearsonCorrelation: pearsonCorrelation,
    normalizeDateStr: normalizeDateStr
  };
}
