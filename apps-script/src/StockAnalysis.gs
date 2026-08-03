/**
 * StockAnalysis.gs
 * 「個股分析」頁面：查詢單一股票代號的收盤價/均線/法人買賣超走勢，
 * 以及它過去每天在 Reports 分頁留下的 Armor_Score / 操作策略歷史，讓使用者看得出「序時變化」。
 */

/** 供前端下拉/自動完成用：依代號或名稱關鍵字搜尋最近有出現過的股票。 */
function searchStockCodes(query) {
  query = String(query || '').trim();
  if (!query) return [];
  var rows = readRecentHistory_(10); // 近幾天的資料就足夠列出代號/名稱對照
  var seen = {};
  var out = [];
  rows.forEach(function (r) {
    var code = zfill4(String(r['證券代號']).trim());
    var name = r['證券名稱'] || '';
    if (seen[code]) return;
    if (code.indexOf(query) !== -1 || name.indexOf(query) !== -1) {
      seen[code] = true;
      out.push({ code: code, name: name });
    }
  });
  return out.slice(0, 20);
}

/**
 * 供持股表單代號欄位失焦時查一次對應名稱用：跟 searchStockCodes（限最近 10 天，
 * 給打字自動完成用）不同，這裡查「這一檔股票、盡量不限日期範圍」，讓最近 10 天沒被
 * 每日掃描選中的冷門股也查得到名字（BigQuery 模式下不限日期範圍；檔案模式沒有「不限
 * 範圍」查詢，退而求其次抓最近約一年，仍然找不到就回傳 null，前端維持使用者自行輸入）。
 */
function getStockNameByCode(code) {
  code = zfill4(String(code || '').trim());
  if (!code) return null;
  if (shouldUseBigQueryForReads_()) {
    return queryLatestNameForCodeFromBigQuery_(code);
  }
  var rows = readRecentHistoryFromFiles_(400).filter(function (r) {
    return zfill4(String(r['證券代號']).trim()) === code;
  });
  if (rows.length === 0) return null;
  rows.sort(function (a, b) { return normalizeDateStr(a['日期']) < normalizeDateStr(b['日期']) ? 1 : -1; });
  return { code: code, name: rows[0]['證券名稱'] || '' };
}

/**
 * 回傳單一股票的時間序列（收盤價、MA5/20/60、法人買賣超）+ 歷史 Armor_Score 走勢。
 * days: 要往回抓多少天的 History（預設 240 天，留夠 buffer 讓 MA60 有意義）。
 */
function getStockTimeSeries(code, days) {
  code = zfill4(String(code || '').trim());
  if (!code) throw new Error('請提供股票代號');
  days = days || 240;

  var rows = readHistoryForCode_(code, days);
  if (rows.length === 0) return { code: code, name: '', series: [], scoreHistory: [] };

  rows.forEach(function (r) {
    CONFIG.HISTORY_NUMERIC_COLUMNS.forEach(function (c) { r[c] = toNumber(r[c]); });
  });
  rows = sortRows(rows, [[function (r) { return normalizeDateStr(r['日期']); }, 'asc']]);

  var closeArr = rows.map(function (r) { return r['收盤價']; });
  var ma5 = rollingMean(closeArr, 5);
  var ma20 = rollingMean(closeArr, 20);
  var ma60 = rollingMean(closeArr, 60);
  var instNetArr = rows.map(function (r) { return r['投信'] + r['外資'] + r['自營商']; });

  var series = rows.map(function (r, i) {
    return {
      date: normalizeDateStr(r['日期']),
      close: r['收盤價'],
      open: r['開盤價'],
      high: r['最高價'],
      low: r['最低價'],
      volume: r['成交股數'],
      instNet: instNetArr[i],
      foreign: r['外資'],
      trust: r['投信'],
      dealer: r['自營商'],
      ma5: ma5[i],
      ma20: ma20[i],
      ma60: ma60[i]
    };
  });

  var reportRows = readSheetObjects_(getReportsSheet_())
    .filter(function (r) { return zfill4(String(r['證券代號']).trim()) === code; })
    .map(function (r) {
      return {
        date: normalizeDateStr(r['日期']),
        armorScore: toNumberOrNull(r['Armor_Score']),
        strategy: r['操作策略'],
        action: r['建議動作']
      };
    })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });

  return {
    code: code,
    name: rows[rows.length - 1]['證券名稱'] || '',
    series: series,
    scoreHistory: reportRows,
    latestClose: closeArr[closeArr.length - 1]
  };
}
