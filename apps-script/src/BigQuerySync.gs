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

/** 刪除「指定幾個日期」既有資料的 SQL——每天寫入 history_raw 前先清掉當天既有的資料，
 *  避免 WRITE_APPEND 造成重複列，也讓「補抓/重新彙整區間」可以放心對同一天重複呼叫。 */
function buildDeleteDatesSql_(fullTableRef, dateStrs) {
  var list = dateStrs.map(function (d) { return "'" + d + "'"; }).join(', ');
  return 'DELETE FROM `' + fullTableRef + '` WHERE date_str IN (' + list + ')';
}

/** date_str 不是標準 yyyy-MM-dd（例如舊版寫入邏輯留下的 'yyyy/MM/dd'）的列數——這些列會被
 *  SAFE_CAST(date_str AS DATE) 悄悄忽略，讓仰賴它判斷「最新一天」的查詢（buildLatestDayFactorsSql_
 *  的 bounds CTE）卡在「格式正確的最後一天」，看起來像資料停在很久以前不動。給「系統與資料
 *  後台」的檢查/清理按鈕用。 */
function buildMalformedDateCountSql_(fullTableRef) {
  return "SELECT COUNT(*) AS cnt FROM `" + fullTableRef + "` WHERE NOT REGEXP_CONTAINS(date_str, r'^\\d{4}-\\d{2}-\\d{2}$')";
}

/** 清掉 history_raw 裡 date_str 格式不是 yyyy-MM-dd 的列——清掉之後那幾天等於沒有資料，
 *  要另外用「手動抓取/重新彙整區間」把那幾天重新抓一次（這次會用正規化過的格式寫入）。 */
function buildDeleteMalformedDateRowsSql_(fullTableRef) {
  return "DELETE FROM `" + fullTableRef + "` WHERE NOT REGEXP_CONTAINS(date_str, r'^\\d{4}-\\d{2}-\\d{2}$')";
}

/** 刪除前先查一次「格式錯誤的列實際上是哪幾天」的相異 date_str 清單——不查的話刪完就不知道
 *  要重新抓哪幾天，使用者只能用猜的（正是這次要解決的問題：刪完不知道怎麼重跑）。 */
function buildMalformedDateDistinctSql_(fullTableRef) {
  return "SELECT DISTINCT date_str FROM `" + fullTableRef + "` WHERE NOT REGEXP_CONTAINS(date_str, r'^\\d{4}-\\d{2}-\\d{2}$')";
}

/** BigQuery 外部資料表（讀 Google Drive 檔案）要求的 URI 格式。 */
function buildDriveFileUri_(fileId) {
  return 'https://drive.google.com/open?id=' + fileId;
}

/** 依參考單價（USD / TB）估算一次查詢的費用；bytesProcessed 可能是字串（API 回傳的 int64）。 */
function calcBqCost_(bytesProcessed, pricePerTb) {
  var bytes = parseInt(bytesProcessed, 10) || 0;
  var tb = bytes / (1024 * 1024 * 1024 * 1024);
  return tb * (pricePerTb || CONFIG.BIGQUERY_PRICE_PER_TB_DEFAULT);
}

/**
 * 去重 view 的 SQL：external 資料表可能同時包含「一次性大彙整檔」跟「每日排程持續累加的月份檔案」，
 * 日期範圍可能重疊，這裡依 (股票代號, 日期) 只留一筆，避免同一天的資料被算兩次。
 */
function buildDedupedViewSql_(externalTableRef, viewRef) {
  var otherCols = bqColumnNames_().filter(function (c) { return c !== 'date_str'; });
  var cols = [normalizedDateStrSqlExpr_() + ' AS date_str'].concat(otherCols).join(', ');
  return [
    'CREATE OR REPLACE VIEW `' + viewRef + '` AS',
    'WITH normalized AS (',
    '  SELECT ' + cols,
    '  FROM `' + externalTableRef + '`',
    ')',
    'SELECT * EXCEPT(rn) FROM (',
    '  SELECT *, ROW_NUMBER() OVER (PARTITION BY stock_id, date_str ORDER BY date_str) AS rn',
    '  FROM normalized',
    ')',
    'WHERE rn = 1'
  ].join('\n');
}

/**
 * materialized 模式不能靠 BigQuery 的 autodetect 去讀 CSV 標題列文字當欄名——實測發現這個
 * BigQuery 環境對非 ASCII（中文）標題列不支援「彈性欄名」，autodetect 會把每個中文字元都
 * 消毒成底線（例如「日期」變成底線加流水號區分碰撞），欄名資訊整個消失，完全比對不到。
 * 所以改成：Apps Script 自己（只讀檔案最前面一小段位元組，不是整個檔案）解析出每個檔案
 * 「實際的」標題列文字跟順序，再用這個順序建立位置對應的 schema（schema 欄名還是我們自己的
 * 乾淨 ascii 名稱，不假手 BigQuery 去讀中文）。這樣完全不依賴 BigQuery 的中文欄名支援，
 * 只要標題列文字跟我們預期的欄位「集合」一致（不要求順序一致），就能正確對應。
 *
 * 依 headerRow（某個檔案實際的標題列，依檔案裡的順序）解析出這個檔案的 schema 欄位定義
 * （在檔案的順序，欄名用我們自己的 ascii bq 名稱），比對時忽略開頭 BOM／前後空白。
 * 標題列有認不出來的欄位、或缺少某個系統需要的欄位，都直接丟出看得懂的錯誤。
 */
function resolveHeaderOrderMapping_(headerRow, columnMap) {
  var normalize = function (s) { return String(s).replace(/^\uFEFF/, '').trim(); };
  var byNormalizedCn = {};
  columnMap.forEach(function (m) { byNormalizedCn[normalize(m.cn)] = m; });

  var usedCn = {};
  var unrecognized = [];
  var fields = headerRow.map(function (h) {
    var match = byNormalizedCn[normalize(h)];
    if (!match) { unrecognized.push(h); return null; }
    usedCn[match.cn] = true;
    return { name: match.bq, type: 'STRING' };
  });

  if (unrecognized.length > 0) {
    throw new Error('這個檔案的標題列有系統認不出來的欄位：' + unrecognized.join('、') + '。');
  }
  var missing = columnMap.filter(function (m) { return !usedCn[m.cn]; }).map(function (m) { return m.cn; });
  if (missing.length > 0) {
    throw new Error('這個檔案的標題列缺少欄位：' + missing.join('、') + '。');
  }
  return fields;
}

/**
 * 依「檔案標題列文字」把來源檔案分組——大部分情況下同一批來源（例如我們自己每天產生的月份檔案）
 * 欄位順序都一樣，只會分成一組；如果混了不同來源、欄位順序不同的檔案，會分成好幾組，
 * 每組各自建一個位置正確對應的外部資料表，最後用 UNION ALL 合併，兩種順序都能正確讀取。
 */
function groupFileIdsByHeaderRow_(fileHeaderPairs) {
  var groups = [];
  var indexByKey = {};
  fileHeaderPairs.forEach(function (pair) {
    var key = pair.headerRow.join('\u0001');
    if (indexByKey[key] === undefined) {
      indexByKey[key] = groups.length;
      groups.push({ headerRow: pair.headerRow, fileIds: [] });
    }
    groups[indexByKey[key]].fileIds.push(pair.fileId);
  });
  return groups;
}

/**
 * date_str 正規化成 yyyy-MM-dd 的 SQL 運算式。來源 Drive CSV（不管是曾經的 native 模式每日
 * 寫入、或使用者手動上傳的既有彙整表）存的「日期」欄位其實是 formatSlashDate_ 產生的
 * 'yyyy/MM/dd' 顯示格式，不是 ISO 格式——這個問題原本以為只在 history_raw（見
 * normalizeRowsDateField_），後來發現 history_materialized 是直接從這些 CSV 的外部資料表
 * SELECT * 複製過來的，同樣的斜線格式一直都在，只是被 SAFE_CAST 悄悄忽略沒被發現。
 * 這裡在複製進原生表這一步統一轉成 ISO 格式：不只讓下游 SAFE_CAST(date_str AS DATE) 不再
 * 解析失敗，也讓「同一天但格式不同」的列在下面 PARTITION BY stock_id, date_str 去重時能被
 * 正確視為同一天——不然兩種格式的字串不相等，去重會誤判成兩篇不同日期的資料，各自留一筆，
 * 也是股票數/總列數異常暴增的成因之一。
 */
function normalizedDateStrSqlExpr_() {
  return "CASE WHEN REGEXP_CONTAINS(date_str, r'^\\d{4}/\\d{2}/\\d{2}$') THEN REPLACE(date_str, '/', '-') ELSE date_str END";
}

/**
 * materialized 模式的核心 SQL：把每組（欄位順序相同的一批檔案）各自的外部資料表
 * （schema 欄名都已經是我們自己的 ascii 名稱，見 resolveHeaderOrderMapping_）UNION ALL 起來，
 * 再依 (stock_id, date_str) 去重，複製進一份 BigQuery 原生表。
 */
function buildMaterializeSql_(groupTableRefs, materializedTableRef) {
  var otherCols = bqColumnNames_().filter(function (c) { return c !== 'date_str'; });
  var cols = [normalizedDateStrSqlExpr_() + ' AS date_str'].concat(otherCols).join(', ');
  var unionSql = groupTableRefs.map(function (ref) {
    return '  SELECT ' + cols + ' FROM `' + ref + '`';
  }).join('\n  UNION ALL\n');
  return [
    'CREATE OR REPLACE TABLE `' + materializedTableRef + '` AS',
    'WITH combined AS (',
    unionSql,
    ')',
    'SELECT * EXCEPT(rn) FROM (',
    '  SELECT *, ROW_NUMBER() OVER (PARTITION BY stock_id, date_str ORDER BY date_str) AS rn',
    '  FROM combined',
    ')',
    'WHERE rn = 1'
  ].join('\n');
}

/**
 * 「統一讀取 view」：把 history_raw（每天/補抓直接寫入，持續成長）跟 history_materialized
 * （從舊的 Drive 大檔案一次性整理進來的歷史基準，之後很少再變動）UNION 起來，同一天同一檔
 * 股票兩邊都有的話 history_raw 優先（它是比較新鮮的直接寫入結果，例如重新抓某一天覆蓋掉
 * 舊資料的情況）。materialized 模式讀的是這個 view，不是單一份表——這樣「今天」的資料一寫進
 * history_raw 馬上查得到，不用等 history_materialized 重新整理，也完全不會再需要 Apps Script
 * 重新掃一次 Drive 檔案。
 */
/**
 * stock_id 正規化的 SQL 版本，語意要跟 Utils.gs 的 sanitizeStockId_ 對齊：先去頭尾空白，
 * 再去掉 Excel/Sheets 把代號存成數字產生的小數點尾巴（"2330.0" -> "2330"），最後只留英數字。
 * 分兩次 REGEXP_REPLACE 是刻意的——如果把「去小數點尾巴」跟「只留英數字」寫成同一個正則的
 * 兩個分支一次做完，句點會被「只留英數字」那支直接吃掉，"2330.0" 會變成 "23300" 而不是
 * "2330"，兩個規則必須分開、按順序套用。
 */
function bqCleanStockIdExpr_() {
  return "REGEXP_REPLACE(REGEXP_REPLACE(TRIM(stock_id), r'\\.0+$', ''), r'[^0-9A-Za-z]', '')";
}

/**
 * 「統一讀取 view」：把 history_raw（每天/補抓直接寫入，持續成長）跟 history_materialized
 * （從舊的 Drive 大檔案一次性整理進來的歷史基準，之後很少再變動）UNION 起來，同一天同一檔
 * 股票兩邊都有的話 history_raw 優先（它是比較新鮮的直接寫入結果，例如重新抓某一天覆蓋掉
 * 舊資料的情況）。materialized 模式讀的是這個 view，不是單一份表——這樣「今天」的資料一寫進
 * history_raw 馬上查得到，不用等 history_materialized 重新整理，也完全不會再需要 Apps Script
 * 重新掃一次 Drive 檔案。
 *
 * stock_id 在這裡先正規化清洗過才拿去比對/輸出（見 bqCleanStockIdExpr_）：不同來源檔案
 * 對同一檔股票的 stock_id 字串格式不一致（多空白、Excel 把代號存成數字產生的 ".0" 尾巴…），
 * 不先清洗的話，UNION+去重會把「同一檔股票的不同格式」當成好幾檔不同股票——這是「股票數
 * （去重後）」異常暴增的根本原因。清洗完仍然不像股票代號（長度不在 4~6 碼、含非英數字）的
 * 直接排除，不會流進下游任何查詢。這個過濾只保證「像不像一個代號」，v17.0 策略本身只認
 * 4 碼一般股票的規則（LENGTH(stock_id) = 4）維持在 buildLatestDayFactorsSql_ 裡單獨處理，
 * 不動這裡（避免不小心排除掉合法的 5~6 碼 ETF/權證類代號，跟 computeFactors_ 的 Python
 * 對照行為保持一致）。
 */
function buildUnifiedViewSql_(rawRef, materializedRef, viewRef) {
  var cols = bqColumnNames_().join(', ');
  var otherCols = bqColumnNames_().filter(function (c) { return c !== 'stock_id'; }).join(', ');
  var cleanExpr = bqCleanStockIdExpr_();
  return [
    'CREATE OR REPLACE VIEW `' + viewRef + '` AS',
    'SELECT ' + cols + ' FROM (',
    '  SELECT *, ROW_NUMBER() OVER (PARTITION BY stock_id, date_str ORDER BY src_priority ASC) AS rn',
    '  FROM (',
    '    SELECT ' + cleanExpr + ' AS stock_id, ' + otherCols + ', 0 AS src_priority FROM `' + rawRef + '`',
    '    UNION ALL',
    '    SELECT ' + cleanExpr + ' AS stock_id, ' + otherCols + ', 1 AS src_priority FROM `' + materializedRef + '`',
    '  )',
    ')',
    "WHERE rn = 1 AND REGEXP_CONTAINS(stock_id, r'^[0-9A-Za-z]{4,6}$')"
  ].join('\n');
}

/** 去重 view 目前涵蓋的日期範圍，給「資料總覽」跟開機摘要用。 */
function buildDateBoundsSql_(dedupedViewRef) {
  return 'SELECT MIN(date_str) AS min_date, MAX(date_str) AS max_date, ' +
    'COUNT(DISTINCT date_str) AS trading_days, COUNT(DISTINCT stock_id) AS stock_count, COUNT(*) AS row_count ' +
    'FROM `' + dedupedViewRef + '`';
}

/**
 * 「資料總覽」的股票代號格式診斷：台股上市櫃全部加起來也就一千多到兩千檔，
 * 如果「股票數（去重後）」明顯超出這個量級（例如實測看到 5 萬多），幾乎可以確定不是
 * 「真的有這麼多股票」，而是同一檔股票的 stock_id 在不同來源檔案裡格式不一致
 * （多空白、少補零、全形半形…），導致 (stock_id, date_str) 去重跟 rolling 因子的
 * PARTITION BY stock_id 都把同一檔股票誤判成好幾檔不同的股票——不只污染統計數字，
 * 還會讓每一種「格式變體」各自的交易日不足，rolling 因子大量算不出來，也是「0 檔訊號」
 * 潛在的另一個成因。這裡一次查三種角度，只查一次省成本：
 *   'length'：依 stock_id 字元長度分組，正常應該幾乎全部是 4（碰到 5 碼 ETF 才會有 5）；
 *   'top'：出現次數最多的 20 個 stock_id（正常股票應該接近 129 天，不會少太多）；
 *   'rare'：出現次數最少的 20 個 stock_id（格式跑掉的變體通常只出現個幾次）。
 */
function buildStockIdQualitySql_(sourceRef) {
  return [
    // BigQuery 不接受 SELECT 清單裡對 GROUP BY 鍵再包一層函式（例如 CAST(LENGTH(stock_id) AS STRING)
    // 卻 GROUP BY LENGTH(stock_id)）——就算裡面是同一個表達式，BigQuery 也不認得兩者是同一組鍵，
    // 會報「references column stock_id which is neither grouped nor aggregated」。要先在子查詢裡
    // GROUP BY 完（SELECT 清單跟 GROUP BY 用一模一樣的 LENGTH(stock_id)），外層才能自由 CAST。
    "(SELECT 'length' AS kind, CAST(len AS STRING) AS key, cnt, distinct_ids FROM (",
    '  SELECT LENGTH(stock_id) AS len, COUNT(*) AS cnt, COUNT(DISTINCT stock_id) AS distinct_ids',
    '  FROM `' + sourceRef + '` GROUP BY LENGTH(stock_id)',
    ') ORDER BY cnt DESC)',
    'UNION ALL',
    "(SELECT 'top' AS kind, stock_id AS key, COUNT(*) AS cnt, CAST(NULL AS INT64) AS distinct_ids",
    '  FROM `' + sourceRef + '` GROUP BY stock_id ORDER BY cnt DESC LIMIT 20)',
    'UNION ALL',
    "(SELECT 'rare' AS kind, stock_id AS key, COUNT(*) AS cnt, CAST(NULL AS INT64) AS distinct_ids",
    '  FROM `' + sourceRef + '` GROUP BY stock_id ORDER BY cnt ASC LIMIT 20)'
  ].join('\n');
}

/** 把 buildStockIdQualitySql_ 的三段結果（用 kind 欄位區分）拆回結構化物件。 */
function mapStockIdQualityRows_(rows) {
  var byLength = [];
  var topStocks = [];
  var rareStocks = [];
  rows.forEach(function (r) {
    if (r.kind === 'length') byLength.push({ length: parseInt(r.key, 10), rows: parseInt(r.cnt, 10), distinctIds: parseInt(r.distinct_ids, 10) });
    else if (r.kind === 'top') topStocks.push({ stockId: r.key, rows: parseInt(r.cnt, 10) });
    else if (r.kind === 'rare') rareStocks.push({ stockId: r.key, rows: parseInt(r.cnt, 10) });
  });
  byLength.sort(function (a, b) { return b.rows - a.rows; });
  return { byLength: byLength, topStocks: topStocks, rareStocks: rareStocks };
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

/**
 * 「今日戰報」／「篩選漏斗明細」專用：把 Analysis.gs computeFactors_ 的 rolling 因子 +
 * 橫斷面排名 + Armor_Score 邏輯整套搬進 BigQuery window function 算，只回傳「最新一個交易日」
 * 每檔股票已經算好的一列。取代原本把 ANALYSIS_LOOKBACK_DAYS 天的原始資料整包搬進 Apps Script
 * 再用 computeFactors_ 算一次的做法——150 天 x 全市場股票動輒十幾萬列，超出 Apps Script V8
 * 執行環境的記憶體上限（實測會直接噴「記憶體不足」）。BigQuery 本來就是為了這種規模的
 * 運算設計的，只要最後只回傳「今天」這一天算好的結果，Apps Script 端的資料量就從
 * 「天數 x 股票數」降到「股票數」。
 *
 * 每一步都刻意逐條對照 Utils.gs 的語意翻譯，不是「差不多」版本：
 *   - rollingApply（MA20/MA60/Vol_MA20/Inst_Part_MA5/dropCount20/buyOnDrop20）要求「整個視窗
 *     都有值」才給結果，視窗不足或視窗內有任何一格是 null 都是 null——用 COUNT(*) OVER (同一個
 *     frame) 是否等於視窗大小來判斷「視窗夠不夠長」，用 COUNT(欄位) OVER (同一個 frame) 是否
 *     跟 COUNT(*) 相等來判斷「視窗內有沒有 null」，兩者都成立才用 AVG()/SUM() 的結果，
 *     不能只依賴 BigQuery 內建 AVG()/SUM() 自動略過 null、自動接受不滿的視窗這兩種預設行為
 *     （那樣會跟 pandas rolling(min_periods=window) 的語意不一致）。
 *   - percentRank（Inst_Part_Rank/IBF_20D_Rank/Vol_Ratio_Rank）是 pandas rank(pct=True,
 *     method='average') 的語意（同分取名次平均、null 不計入分母），不是 BigQuery 內建
 *     PERCENT_RANK() 視窗函式的公式（那是 (rank-1)/(count-1)，完全是另一回事）。這裡改用
 *     RANK() 搭配「同分列數」手算「平均名次 / 非 null 筆數」，數學上等於 percentRank() 的作法。
 *   - Adjusted_Peak 這裡算的是「回看視窗內」的一般 expanding max（非持股的情況跟原本邏輯一致），
 *     持股的「從買進日起算」版本無法在這裡知道（買進日是使用者的持股資料，不是歷史資料的一部分），
 *     由 fetchAdjustedPeaksForHoldings_() 另外用小範圍查詢（只查有持股的幾檔股票）覆蓋。
 *
 * cutoffStr：只查這天（含）以後的原始資料，要跟 ANALYSIS_LOOKBACK_DAYS 對齊——
 * 不限制範圍的話，expanding max 等於算成「全部歷史以來的最高價」，跟原本「只看回看視窗內」
 * 的語意不一致。
 */
function buildLatestDayFactorsSql_(sourceRef, cutoffStr) {
  var byStockOrderDt = 'PARTITION BY stock_id ORDER BY dt';
  var w5 = 'ROWS BETWEEN 4 PRECEDING AND CURRENT ROW';
  var w20 = 'ROWS BETWEEN 19 PRECEDING AND CURRENT ROW';
  var w60 = 'ROWS BETWEEN 59 PRECEDING AND CURRENT ROW';
  return [
    'WITH bounds AS (',
    '  SELECT MAX(SAFE_CAST(date_str AS DATE)) AS latest_dt',
    '  FROM `' + sourceRef + '`',
    "  WHERE date_str >= '" + cutoffStr + "'",
    '),',
    'base AS (',
    '  SELECT',
    '    stock_id, stock_name, date_str, SAFE_CAST(date_str AS DATE) AS dt,',
    '    IFNULL(SAFE_CAST(foreign_net AS FLOAT64), 0) AS foreign_v,',
    '    IFNULL(SAFE_CAST(trust_net AS FLOAT64), 0) AS trust_v,',
    '    IFNULL(SAFE_CAST(dealer_net AS FLOAT64), 0) AS dealer_v,',
    '    IFNULL(SAFE_CAST(inst_net_shares AS FLOAT64), 0) AS inst_net_shares_v,',
    '    IFNULL(SAFE_CAST(volume_shares AS FLOAT64), 0) AS vol,',
    '    IFNULL(SAFE_CAST(trade_count AS FLOAT64), 0) AS trade_count_v,',
    '    IFNULL(SAFE_CAST(turnover AS FLOAT64), 0) AS turnover_v,',
    '    IFNULL(SAFE_CAST(open_price AS FLOAT64), 0) AS open_v,',
    '    IFNULL(SAFE_CAST(high_price AS FLOAT64), 0) AS high_v,',
    '    IFNULL(SAFE_CAST(low_price AS FLOAT64), 0) AS low_v,',
    '    IFNULL(SAFE_CAST(close_price AS FLOAT64), 0) AS close,',
    '    change_sign,',
    '    IFNULL(SAFE_CAST(change_amount AS FLOAT64), 0) AS change_amount_v,',
    '    IFNULL(SAFE_CAST(bid_price AS FLOAT64), 0) AS bid_price_v,',
    '    IFNULL(SAFE_CAST(bid_vol AS FLOAT64), 0) AS bid_vol_v,',
    '    IFNULL(SAFE_CAST(ask_price AS FLOAT64), 0) AS ask_price_v,',
    '    IFNULL(SAFE_CAST(ask_vol AS FLOAT64), 0) AS ask_vol_v,',
    '    IFNULL(SAFE_CAST(dividend_yield AS FLOAT64), 0) AS dividend_yield_v,',
    '    IFNULL(SAFE_CAST(pe_ratio AS FLOAT64), 0) AS pe_ratio_v,',
    '    IFNULL(SAFE_CAST(pb_ratio AS FLOAT64), 0) AS pb_ratio_v,',
    '    fin_report_period',
    '  FROM `' + sourceRef + '`',
    "  WHERE LENGTH(stock_id) = 4 AND date_str >= '" + cutoffStr + "'",
    '),',
    'win AS (',
    '  SELECT *,',
    '    (foreign_v + trust_v + dealer_v) AS inst_net,',
    '    SAFE_DIVIDE(ABS(foreign_v) + ABS(trust_v) + ABS(dealer_v), vol) AS inst_participation,',
    '    SAFE_DIVIDE(close, LAG(close) OVER (' + byStockOrderDt + ')) - 1 AS daily_return,',
    '    COUNT(*) OVER (' + byStockOrderDt + ' ' + w20 + ') AS cnt20,',
    '    COUNT(*) OVER (' + byStockOrderDt + ' ' + w60 + ') AS cnt60,',
    '    AVG(close) OVER (' + byStockOrderDt + ' ' + w20 + ') AS ma20_raw,',
    '    AVG(close) OVER (' + byStockOrderDt + ' ' + w60 + ') AS ma60_raw,',
    '    AVG(vol) OVER (' + byStockOrderDt + ' ' + w20 + ') AS vol_ma20_raw,',
    '    MAX(close) OVER (' + byStockOrderDt + ' ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS adjusted_peak_generic',
    '  FROM base',
    '),',
    'step1 AS (',
    '  SELECT *,',
    '    IF(cnt20 = 20, ma20_raw, NULL) AS ma20,',
    '    IF(cnt60 = 60, ma60_raw, NULL) AS ma60,',
    '    IF(cnt20 = 20, vol_ma20_raw, NULL) AS vol_ma20',
    '  FROM win',
    '),',
    'step2 AS (',
    '  SELECT *,',
    '    COUNT(*) OVER (' + byStockOrderDt + ' ' + w5 + ') AS cnt5,',
    '    COUNT(inst_participation) OVER (' + byStockOrderDt + ' ' + w5 + ') AS cnt5_nonnull,',
    '    AVG(inst_participation) OVER (' + byStockOrderDt + ' ' + w5 + ') AS inst_part_ma5_raw,',
    '    CASE WHEN daily_return < 0 THEN 1 ELSE 0 END AS is_drop,',
    '    CASE WHEN daily_return < 0 AND inst_net > 0 THEN 1 ELSE 0 END AS is_inst_buy_on_drop,',
    '    SAFE_DIVIDE(vol, vol_ma20) AS vol_ratio,',
    '    SAFE_DIVIDE(close - ma60, ma60) AS bias60,',
    '    LAG(ma20, 3) OVER (' + byStockOrderDt + ') AS ma20_3ago',
    '  FROM step1',
    '),',
    'step3 AS (',
    '  SELECT *,',
    '    IF(cnt5 = 5 AND cnt5_nonnull = 5, inst_part_ma5_raw, NULL) AS inst_part_ma5,',
    '    (ma20 - ma20_3ago) AS ma20_slope,',
    '    COUNT(*) OVER (' + byStockOrderDt + ' ' + w20 + ') AS cnt20b,',
    '    SUM(is_drop) OVER (' + byStockOrderDt + ' ' + w20 + ') AS drop_count_20_raw,',
    '    SUM(is_inst_buy_on_drop) OVER (' + byStockOrderDt + ' ' + w20 + ') AS buy_on_drop_20_raw',
    '  FROM step2',
    '),',
    'step4 AS (',
    '  SELECT *,',
    '    IF(cnt20b = 20, drop_count_20_raw, NULL) AS drop_count_20,',
    '    IF(cnt20b = 20, buy_on_drop_20_raw, NULL) AS buy_on_drop_20',
    '  FROM step3',
    '),',
    'step5 AS (',
    '  SELECT *,',
    '    CASE WHEN drop_count_20 IS NULL OR drop_count_20 = 0 THEN 0 ELSE buy_on_drop_20 / drop_count_20 END AS ibf_20d,',
    '    (CASE WHEN ma20 IS NOT NULL AND close > ma20 THEN 1 ELSE 0 END',
    '      + CASE WHEN ma20_slope IS NOT NULL AND ma20_slope > 0 THEN 1 ELSE 0 END) AS trend_score',
    '  FROM step4',
    '),',
    'latest AS (',
    // 「最新一天」要用 bounds（沒有 stock_id 格式篩選）決定，不能用 MAX(dt) FROM step5——
    // step5 是從已經濾掉 LENGTH(stock_id) != 4 的 base 算出來的，如果最新那幾天剛好大部分
    // stock_id 格式跑掉，MAX(dt) FROM step5 會悄悄退回「還有乾淨資料」的更舊一天，
    // 使用者會看到戰報停在很久以前、卻不知道明明資料庫裡有更新的資料。用 bounds 決定日期，
    // 這樣如果最新一天真的全部被篩掉，這裡就會是 0 列（誠實的「這天沒有乾淨資料」），
    // 不是靜靜地換一個更舊的日期。
    '  SELECT * FROM step5 WHERE dt = (SELECT latest_dt FROM bounds)',
    '),',
    'ranked AS (',
    '  SELECT *,',
    // BigQuery 不允許用 FLOAT64 表達式當 PARTITION BY 的分組鍵（"Partitioning by expressions
    // of type FLOAT64 is not allowed"），所以同分筆數不能用 COUNT(*) OVER (PARTITION BY x) 算，
    // 改用 RANGE BETWEEN CURRENT ROW AND CURRENT ROW——這是 BigQuery 對「數值型別」window frame
    // 的標準同分（peer group）寫法，算出來的「這個值總共有幾筆」跟原本 PARTITION BY 版本數學上
    // 完全等價，只是換一種 BigQuery 允許的語法。
    // 注意：RANGE frame 的 ORDER BY 不能加 NULLS LAST（BigQuery 實測會報「NULLS LAST not
    // supported with ascending sort order in RANGE clauses」），但這不影響正確性——同分筆數
    // 只看「值是否相等」，null 排在前面還是後面都不會改變「這個值總共有幾筆」的計算結果，
    // 而且外層已經用 CASE 把 null 那一列的最終結果蓋成 null 了。RANK() 本身不是 RANGE frame，
    // 不受這條限制，仍然保留 NULLS LAST 確保非 null 的名次不被 null 影響。
    '    CASE WHEN inst_part_ma5 IS NULL THEN NULL ELSE',
    '      (RANK() OVER (ORDER BY inst_part_ma5 ASC NULLS LAST) + (COUNT(*) OVER (ORDER BY inst_part_ma5 ASC RANGE BETWEEN CURRENT ROW AND CURRENT ROW) - 1) / 2.0) / COUNT(inst_part_ma5) OVER ()',
    '    END AS inst_part_rank,',
    '    CASE WHEN ibf_20d IS NULL THEN NULL ELSE',
    '      (RANK() OVER (ORDER BY ibf_20d ASC NULLS LAST) + (COUNT(*) OVER (ORDER BY ibf_20d ASC RANGE BETWEEN CURRENT ROW AND CURRENT ROW) - 1) / 2.0) / COUNT(ibf_20d) OVER ()',
    '    END AS ibf_20d_rank,',
    '    CASE WHEN vol_ratio IS NULL THEN NULL ELSE',
    '      (RANK() OVER (ORDER BY vol_ratio ASC NULLS LAST) + (COUNT(*) OVER (ORDER BY vol_ratio ASC RANGE BETWEEN CURRENT ROW AND CURRENT ROW) - 1) / 2.0) / COUNT(vol_ratio) OVER ()',
    '    END AS vol_ratio_rank',
    '  FROM latest',
    ')',
    'SELECT',
    '  stock_id, stock_name, date_str,',
    '  foreign_v AS foreign_net, trust_v AS trust_net, dealer_v AS dealer_net, inst_net_shares_v AS inst_net_shares,',
    '  vol AS volume_shares, trade_count_v AS trade_count, turnover_v AS turnover,',
    '  open_v AS open_price, high_v AS high_price, low_v AS low_price, close AS close_price,',
    '  change_sign, change_amount_v AS change_amount,',
    '  bid_price_v AS bid_price, bid_vol_v AS bid_vol, ask_price_v AS ask_price, ask_vol_v AS ask_vol,',
    '  dividend_yield_v AS dividend_yield, pe_ratio_v AS pe_ratio, pb_ratio_v AS pb_ratio, fin_report_period,',
    '  inst_net, inst_participation, inst_part_ma5, daily_return, is_drop, is_inst_buy_on_drop,',
    '  ibf_20d, ma20, ma20_slope, trend_score, vol_ma20, vol_ratio, ma60, bias60, adjusted_peak_generic,',
    '  inst_part_rank, ibf_20d_rank, vol_ratio_rank,',
    '  CASE WHEN inst_part_rank IS NULL OR ibf_20d_rank IS NULL OR vol_ratio_rank IS NULL THEN NULL',
    '    ELSE ROUND(inst_part_rank * 45 + ibf_20d_rank * 30 + vol_ratio_rank * 15 + trend_score * 10, 1)',
    '  END AS armor_score',
    'FROM ranked'
  ].join('\n');
}

/**
 * v17.0 回測（Backtest.gs runBacktestV17_）BigQuery 模式專用：跟 buildLatestDayFactorsSql_
 * 幾乎是同一套 pipeline（rolling 因子公式逐條相同，`base`/`win`/`step1`~`step5` 這幾層是
 * 直接照抄），差別只在最後兩層：
 *   1. 不是只留「最新一天」，是留 [rangeStartStr, rangeEndStr] 這整段區間（回測要看的是
 *      「這段期間內每一天」有沒有觸發訊號，不是只看最新一天）。
 *   2. 因為同時輸出多天的資料，橫斷面排名（inst_part_rank / ibf_20d_rank / vol_ratio_rank）
 *      的 RANK()/COUNT() OVER 都要多加一層 `PARTITION BY dt`，確保每一天的排名只跟「同一天」
 *      的其他候選互相比較，不會把不同天的分數混在一起排名（跟 Analysis.gs
 *      computePredictedResistanceRanks_ 依日期分組排名是同一個原則）。
 *
 * 這是回測從「把整段區間原始資料整包讀進 Apps Script、用 JS 重新算一次 rolling 因子」
 * 改成「跟今日戰報一樣把計算丟給 BigQuery，只搬回算好的結果」的關鍵——原本的做法在
 * materialized/external 模式下，30 天回測區間 + 150 天暖機 + 60 幾天追蹤緩衝，換算下來要
 * 搬十幾二十萬列原始資料進 Apps Script 逐一計算 rolling 因子，遠超過 Apps Script 單次執行
 * 6 分鐘的上限，背景 job 執行到一半直接被平台砍斷、狀態永遠卡在「執行中」不會再更新
 * （沒有任何錯誤處理程式碼有機會執行）。改成這裡之後，Apps Script 只需要接收「這段區間
 * 每天每檔股票已經算好因子」的結果，資料量從「暖機天數 x 全市場」降到「(區間+追蹤緩衝)
 * 天數 x 全市場」，而且完全不用在 Apps Script 裡重算任何 rolling 公式。
 *
 * warmupCutoffStr：rolling 因子（MA60 等）要看的暖機起點（通常是 rangeStartStr 往前推
 * CONFIG.ANALYSIS_LOOKBACK_DAYS 天），跟 buildLatestDayFactorsSql_ 的 cutoffStr 是同一個角色。
 */
function buildRangeFactorsSql_(sourceRef, warmupCutoffStr, rangeStartStr, rangeEndStr) {
  var byStockOrderDt = 'PARTITION BY stock_id ORDER BY dt';
  var w5 = 'ROWS BETWEEN 4 PRECEDING AND CURRENT ROW';
  var w20 = 'ROWS BETWEEN 19 PRECEDING AND CURRENT ROW';
  var w60 = 'ROWS BETWEEN 59 PRECEDING AND CURRENT ROW';
  return [
    'WITH base AS (',
    '  SELECT',
    '    stock_id, stock_name, date_str, SAFE_CAST(date_str AS DATE) AS dt,',
    '    IFNULL(SAFE_CAST(foreign_net AS FLOAT64), 0) AS foreign_v,',
    '    IFNULL(SAFE_CAST(trust_net AS FLOAT64), 0) AS trust_v,',
    '    IFNULL(SAFE_CAST(dealer_net AS FLOAT64), 0) AS dealer_v,',
    '    IFNULL(SAFE_CAST(inst_net_shares AS FLOAT64), 0) AS inst_net_shares_v,',
    '    IFNULL(SAFE_CAST(volume_shares AS FLOAT64), 0) AS vol,',
    '    IFNULL(SAFE_CAST(trade_count AS FLOAT64), 0) AS trade_count_v,',
    '    IFNULL(SAFE_CAST(turnover AS FLOAT64), 0) AS turnover_v,',
    '    IFNULL(SAFE_CAST(open_price AS FLOAT64), 0) AS open_v,',
    '    IFNULL(SAFE_CAST(high_price AS FLOAT64), 0) AS high_v,',
    '    IFNULL(SAFE_CAST(low_price AS FLOAT64), 0) AS low_v,',
    '    IFNULL(SAFE_CAST(close_price AS FLOAT64), 0) AS close,',
    '    change_sign,',
    '    IFNULL(SAFE_CAST(change_amount AS FLOAT64), 0) AS change_amount_v,',
    '    IFNULL(SAFE_CAST(bid_price AS FLOAT64), 0) AS bid_price_v,',
    '    IFNULL(SAFE_CAST(bid_vol AS FLOAT64), 0) AS bid_vol_v,',
    '    IFNULL(SAFE_CAST(ask_price AS FLOAT64), 0) AS ask_price_v,',
    '    IFNULL(SAFE_CAST(ask_vol AS FLOAT64), 0) AS ask_vol_v,',
    '    IFNULL(SAFE_CAST(dividend_yield AS FLOAT64), 0) AS dividend_yield_v,',
    '    IFNULL(SAFE_CAST(pe_ratio AS FLOAT64), 0) AS pe_ratio_v,',
    '    IFNULL(SAFE_CAST(pb_ratio AS FLOAT64), 0) AS pb_ratio_v,',
    '    fin_report_period',
    '  FROM `' + sourceRef + '`',
    "  WHERE LENGTH(stock_id) = 4 AND date_str >= '" + warmupCutoffStr + "'",
    '),',
    'win AS (',
    '  SELECT *,',
    '    (foreign_v + trust_v + dealer_v) AS inst_net,',
    '    SAFE_DIVIDE(ABS(foreign_v) + ABS(trust_v) + ABS(dealer_v), vol) AS inst_participation,',
    '    SAFE_DIVIDE(close, LAG(close) OVER (' + byStockOrderDt + ')) - 1 AS daily_return,',
    '    COUNT(*) OVER (' + byStockOrderDt + ' ' + w20 + ') AS cnt20,',
    '    COUNT(*) OVER (' + byStockOrderDt + ' ' + w60 + ') AS cnt60,',
    '    AVG(close) OVER (' + byStockOrderDt + ' ' + w20 + ') AS ma20_raw,',
    '    AVG(close) OVER (' + byStockOrderDt + ' ' + w60 + ') AS ma60_raw,',
    '    AVG(vol) OVER (' + byStockOrderDt + ' ' + w20 + ') AS vol_ma20_raw,',
    '    MAX(close) OVER (' + byStockOrderDt + ' ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS adjusted_peak_generic',
    '  FROM base',
    '),',
    'step1 AS (',
    '  SELECT *,',
    '    IF(cnt20 = 20, ma20_raw, NULL) AS ma20,',
    '    IF(cnt60 = 60, ma60_raw, NULL) AS ma60,',
    '    IF(cnt20 = 20, vol_ma20_raw, NULL) AS vol_ma20',
    '  FROM win',
    '),',
    'step2 AS (',
    '  SELECT *,',
    '    COUNT(*) OVER (' + byStockOrderDt + ' ' + w5 + ') AS cnt5,',
    '    COUNT(inst_participation) OVER (' + byStockOrderDt + ' ' + w5 + ') AS cnt5_nonnull,',
    '    AVG(inst_participation) OVER (' + byStockOrderDt + ' ' + w5 + ') AS inst_part_ma5_raw,',
    '    CASE WHEN daily_return < 0 THEN 1 ELSE 0 END AS is_drop,',
    '    CASE WHEN daily_return < 0 AND inst_net > 0 THEN 1 ELSE 0 END AS is_inst_buy_on_drop,',
    '    SAFE_DIVIDE(vol, vol_ma20) AS vol_ratio,',
    '    SAFE_DIVIDE(close - ma60, ma60) AS bias60,',
    '    LAG(ma20, 3) OVER (' + byStockOrderDt + ') AS ma20_3ago',
    '  FROM step1',
    '),',
    'step3 AS (',
    '  SELECT *,',
    '    IF(cnt5 = 5 AND cnt5_nonnull = 5, inst_part_ma5_raw, NULL) AS inst_part_ma5,',
    '    (ma20 - ma20_3ago) AS ma20_slope,',
    '    COUNT(*) OVER (' + byStockOrderDt + ' ' + w20 + ') AS cnt20b,',
    '    SUM(is_drop) OVER (' + byStockOrderDt + ' ' + w20 + ') AS drop_count_20_raw,',
    '    SUM(is_inst_buy_on_drop) OVER (' + byStockOrderDt + ' ' + w20 + ') AS buy_on_drop_20_raw',
    '  FROM step2',
    '),',
    'step4 AS (',
    '  SELECT *,',
    '    IF(cnt20b = 20, drop_count_20_raw, NULL) AS drop_count_20,',
    '    IF(cnt20b = 20, buy_on_drop_20_raw, NULL) AS buy_on_drop_20',
    '  FROM step3',
    '),',
    'step5 AS (',
    '  SELECT *,',
    '    CASE WHEN drop_count_20 IS NULL OR drop_count_20 = 0 THEN 0 ELSE buy_on_drop_20 / drop_count_20 END AS ibf_20d,',
    '    (CASE WHEN ma20 IS NOT NULL AND close > ma20 THEN 1 ELSE 0 END',
    '      + CASE WHEN ma20_slope IS NOT NULL AND ma20_slope > 0 THEN 1 ELSE 0 END) AS trend_score',
    '  FROM step4',
    '),',
    'ranged AS (',
    "  SELECT * FROM step5 WHERE dt BETWEEN DATE('" + rangeStartStr + "') AND DATE('" + rangeEndStr + "')",
    '),',
    'ranked AS (',
    '  SELECT *,',
    // 跟 buildLatestDayFactorsSql_ 同一套「RANGE frame 算同分筆數」寫法，差別只在每個 OVER
    // 子句都多加 PARTITION BY dt，讓排名限定在「同一天」內比較，不會跨天混在一起排名。
    '    CASE WHEN inst_part_ma5 IS NULL THEN NULL ELSE',
    '      (RANK() OVER (PARTITION BY dt ORDER BY inst_part_ma5 ASC NULLS LAST) + (COUNT(*) OVER (PARTITION BY dt ORDER BY inst_part_ma5 ASC RANGE BETWEEN CURRENT ROW AND CURRENT ROW) - 1) / 2.0) / COUNT(inst_part_ma5) OVER (PARTITION BY dt)',
    '    END AS inst_part_rank,',
    '    CASE WHEN ibf_20d IS NULL THEN NULL ELSE',
    '      (RANK() OVER (PARTITION BY dt ORDER BY ibf_20d ASC NULLS LAST) + (COUNT(*) OVER (PARTITION BY dt ORDER BY ibf_20d ASC RANGE BETWEEN CURRENT ROW AND CURRENT ROW) - 1) / 2.0) / COUNT(ibf_20d) OVER (PARTITION BY dt)',
    '    END AS ibf_20d_rank,',
    '    CASE WHEN vol_ratio IS NULL THEN NULL ELSE',
    '      (RANK() OVER (PARTITION BY dt ORDER BY vol_ratio ASC NULLS LAST) + (COUNT(*) OVER (PARTITION BY dt ORDER BY vol_ratio ASC RANGE BETWEEN CURRENT ROW AND CURRENT ROW) - 1) / 2.0) / COUNT(vol_ratio) OVER (PARTITION BY dt)',
    '    END AS vol_ratio_rank',
    '  FROM ranged',
    ')',
    'SELECT',
    '  stock_id, stock_name, date_str,',
    '  foreign_v AS foreign_net, trust_v AS trust_net, dealer_v AS dealer_net, inst_net_shares_v AS inst_net_shares,',
    '  vol AS volume_shares, trade_count_v AS trade_count, turnover_v AS turnover,',
    '  open_v AS open_price, high_v AS high_price, low_v AS low_price, close AS close_price,',
    '  change_sign, change_amount_v AS change_amount,',
    '  bid_price_v AS bid_price, bid_vol_v AS bid_vol, ask_price_v AS ask_price, ask_vol_v AS ask_vol,',
    '  dividend_yield_v AS dividend_yield, pe_ratio_v AS pe_ratio, pb_ratio_v AS pb_ratio, fin_report_period,',
    '  inst_net, inst_participation, inst_part_ma5, daily_return, is_drop, is_inst_buy_on_drop,',
    '  ibf_20d, ma20, ma20_slope, trend_score, vol_ma20, vol_ratio, ma60, bias60, adjusted_peak_generic,',
    '  inst_part_rank, ibf_20d_rank, vol_ratio_rank,',
    '  CASE WHEN inst_part_rank IS NULL OR ibf_20d_rank IS NULL OR vol_ratio_rank IS NULL THEN NULL',
    '    ELSE ROUND(inst_part_rank * 45 + ibf_20d_rank * 30 + vol_ratio_rank * 15 + trend_score * 10, 1)',
    '  END AS armor_score',
    'FROM ranked',
    'ORDER BY dt ASC'
  ].join('\n');
}

/**
 * 回測（Backtest.gs runBacktestV17_）BigQuery 模式入口：對應 queryLatestDayFactorsFromBigQuery_，
 * 差別是回傳的不是「最新一天」而是 [startStr, endStr] 整段區間。不處理持股 Adjusted_Peak
 * 覆蓋（回測的 portfolioMap 永遠是空物件，每個訊號都當成新進場，見 Backtest.gs 的說明），
 * 這點跟 queryLatestDayFactorsFromBigQuery_ 不同，所以不重用它、獨立一個函式。
 */
function queryFactorsRangeFromBigQuery_(startStr, endStr) {
  var settings = requireBigQueryProjectId_();
  refreshDataSourceForMode_(settings);

  var warmupStart = new Date(startStr + 'T00:00:00');
  warmupStart.setDate(warmupStart.getDate() - CONFIG.ANALYSIS_LOOKBACK_DAYS);
  var cutoffStr = normalizeDateStr(warmupStart);

  var sql = buildRangeFactorsSql_(sourceRefForBigQueryRead_(settings), cutoffStr, startStr, endStr);
  return runBqQuery_(sql, 'range_factors').map(mapBqLatestFactorRowToAnalysisRow_);
}

/** buildLatestDayFactorsSql_ 查詢結果（ascii 欄名，全部字串／null）轉回跟 computeFactors_
 *  輸出完全一樣形狀的列物件（中文欄名），讓 diagnoseRow_ / buildFullReportRow_ /
 *  computePredictedFactorScores_ 完全不用改。Adjusted_Peak 先填「一般 expanding max」，
 *  有持股的股票會在 Apps Script 端被 fetchAdjustedPeaksForHoldings_() 的結果覆蓋。 */
function mapBqLatestFactorRowToAnalysisRow_(bqRow) {
  return {
    '日期': normalizeDateStr(bqRow.date_str),
    '證券代號': zfill4(String(bqRow.stock_id || '').trim()),
    '證券名稱': String(bqRow.stock_name === null || bqRow.stock_name === undefined ? '' : bqRow.stock_name).trim(),
    '外資': toNumber(bqRow.foreign_net),
    '投信': toNumber(bqRow.trust_net),
    '自營商': toNumber(bqRow.dealer_net),
    '三大法人買賣超股數': toNumber(bqRow.inst_net_shares),
    '成交股數': toNumber(bqRow.volume_shares),
    '成交筆數': toNumber(bqRow.trade_count),
    '成交金額': toNumber(bqRow.turnover),
    '開盤價': toNumber(bqRow.open_price),
    '最高價': toNumber(bqRow.high_price),
    '最低價': toNumber(bqRow.low_price),
    '收盤價': toNumber(bqRow.close_price),
    '漲跌(+/-)': String(bqRow.change_sign === null || bqRow.change_sign === undefined ? '' : bqRow.change_sign).trim(),
    '漲跌價差': toNumber(bqRow.change_amount),
    '最後揭示買價': toNumber(bqRow.bid_price),
    '最後揭示買量': toNumber(bqRow.bid_vol),
    '最後揭示賣價': toNumber(bqRow.ask_price),
    '最後揭示賣量': toNumber(bqRow.ask_vol),
    '殖利率(%)': toNumber(bqRow.dividend_yield),
    '本益比': toNumber(bqRow.pe_ratio),
    '股價淨值比': toNumber(bqRow.pb_ratio),
    '財報年/季': String(bqRow.fin_report_period === null || bqRow.fin_report_period === undefined ? '' : bqRow.fin_report_period).trim(),

    Inst_Net: toNumber(bqRow.inst_net),
    Inst_Participation: toNumberOrNull(bqRow.inst_participation),
    Inst_Part_MA5: toNumberOrNull(bqRow.inst_part_ma5),
    Inst_Part_Rank: toNumberOrNull(bqRow.inst_part_rank),
    Daily_Return: toNumberOrNull(bqRow.daily_return),
    Is_Drop: toNumber(bqRow.is_drop),
    Is_Inst_Buy_On_Drop: toNumber(bqRow.is_inst_buy_on_drop),
    IBF_20D: toNumberOrNull(bqRow.ibf_20d),
    IBF_20D_Rank: toNumberOrNull(bqRow.ibf_20d_rank),
    MA20: toNumberOrNull(bqRow.ma20),
    MA20_Slope: toNumberOrNull(bqRow.ma20_slope),
    Trend_Score: toNumber(bqRow.trend_score),
    Vol_MA20: toNumberOrNull(bqRow.vol_ma20),
    Vol_Ratio: toNumberOrNull(bqRow.vol_ratio),
    Vol_Ratio_Rank: toNumberOrNull(bqRow.vol_ratio_rank),
    MA60: toNumberOrNull(bqRow.ma60),
    BIAS_60: toNumberOrNull(bqRow.bias60),
    Armor_Score: toNumberOrNull(bqRow.armor_score),
    Adjusted_Peak: toNumberOrNull(bqRow.adjusted_peak_generic)
  };
}

/** 只查「指定幾檔股票」的原始歷史列（給持股的「從買進日起算最高價」用，資料量小，
 *  跟今日戰報的全市場查詢完全無關，不會有記憶體問題）。 */
function buildHistoryRowsForStocksSql_(sourceRef, stockIds, startStr) {
  var cols = bqColumnNames_().join(', ');
  var idList = stockIds.map(function (id) { return "'" + String(id).replace(/'/g, '') + "'"; }).join(', ');
  var sql = 'SELECT ' + cols + ' FROM `' + sourceRef + '` WHERE stock_id IN (' + idList + ')';
  if (startStr) sql += " AND date_str >= '" + startStr + "'";
  return sql;
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
  var m = (mode === 'external' || mode === 'materialized') ? mode : 'native';
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.BIGQUERY_SOURCE_MODE, m);
  return getBigQuerySettings();
}

function setBigQuerySettings(projectId, dataset) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(CONFIG.PROP_KEYS.BIGQUERY_PROJECT_ID, String(projectId || '').trim());
  props.setProperty(CONFIG.PROP_KEYS.BIGQUERY_DATASET, String(dataset || CONFIG.BIGQUERY_DATASET_DEFAULT).trim());
  return getBigQuerySettings();
}

function getBigQueryPricing() {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty(CONFIG.PROP_KEYS.BIGQUERY_PRICE_PER_TB);
  return { pricePerTb: stored ? parseFloat(stored) : CONFIG.BIGQUERY_PRICE_PER_TB_DEFAULT };
}

function setBigQueryPricing(pricePerTb) {
  var v = parseFloat(pricePerTb);
  if (!isNaN(v) && v >= 0) {
    PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.BIGQUERY_PRICE_PER_TB, String(v));
  }
  return getBigQueryPricing();
}

function getBigQueryUsageSheet_() {
  return ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.BIGQUERY_USAGE, CONFIG.BIGQUERY_USAGE_COLUMNS);
}

/** 每次 runBqQuery_ 跑完一段 SQL 就記一筆用量，供「資料總覽」頁籤顯示累積掃描量/預估費用。 */
function logBqUsage_(label, bytesProcessed) {
  var pricing = getBigQueryPricing();
  var cost = calcBqCost_(bytesProcessed, pricing.pricePerTb);
  var now = new Date();
  appendSheetObjects_(getBigQueryUsageSheet_(), CONFIG.BIGQUERY_USAGE_COLUMNS, [{
    '日期': Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd'),
    '時間戳記': Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'),
    '類型': label,
    '掃描位元組數': parseInt(bytesProcessed, 10) || 0,
    '預估費用(USD)': Math.round(cost * 1e6) / 1e6
  }]);
}

/** 前端「資料總覽」頁籤：BigQuery 用量摘要（近 N 天，依日期加總）。 */
function getBigQueryUsageSummary(days) {
  var rows = readSheetObjects_(getBigQueryUsageSheet_());
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days || 30));
  var cutoffStr = normalizeDateStr(cutoff);

  var byDate = {};
  var totalCost = 0, totalBytes = 0, totalCalls = 0;
  var todayStr = normalizeDateStr(new Date());
  var todayCost = 0;

  rows.forEach(function (r) {
    // Google Sheets 會把 logBqUsage_ 寫進去的 'yyyy-MM-dd' 字串自動轉型成 Date 儲存格，
    // 讀回來時 r['日期'] 其實是 Date 物件，String(dateObj) 會變成
    // "Thu Jul 30 2026 00:00:00 GMT+0800 (台北標準時間)" 這種格式，拿去跟 cutoffStr／
    // todayStr 這種 'yyyy-MM-dd' 字串比較或當分組 key 都不對，要用 normalizeDateStr 轉回一致格式
    // （這個檔案其他讀 Sheets 日期欄位的地方都是這樣處理，這裡漏掉了）。
    var d = normalizeDateStr(r['日期']);
    if (d < cutoffStr) return;
    var bytes = parseInt(r['掃描位元組數'], 10) || 0;
    var cost = parseFloat(r['預估費用(USD)']) || 0;
    if (!byDate[d]) byDate[d] = { date: d, calls: 0, bytes: 0, cost: 0 };
    byDate[d].calls += 1;
    byDate[d].bytes += bytes;
    byDate[d].cost += cost;
    totalCost += cost;
    totalBytes += bytes;
    totalCalls += 1;
    if (d === todayStr) todayCost += cost;
  });

  var daily = Object.keys(byDate).map(function (d) { return byDate[d]; }).sort(function (a, b) { return b.date < a.date ? -1 : 1; });
  return { daily: daily, totalCost: totalCost, totalBytes: totalBytes, totalCalls: totalCalls, todayCost: todayCost, days: days || 30 };
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

function bqMaterializedTableRef_(settings) {
  return settings.projectId + '.' + settings.dataset + '.' + CONFIG.BIGQUERY_MATERIALIZED_TABLE;
}

function bqUnifiedViewRef_(settings) {
  return settings.projectId + '.' + settings.dataset + '.' + CONFIG.BIGQUERY_UNIFIED_VIEW;
}

/**
 * 因子回歸 / 歷史資料查詢實際要讀的來源表：
 *   native       -> history_raw（我們自己同步進去的資料，本身就不會重複，不需要去重）
 *   external     -> history_deduped（外部資料表去重後的 view，即時讀 Drive，位置對應 schema）
 *   materialized -> history_unified（history_raw 每天直接寫入的新資料 UNION history_materialized
 *                   那份從舊 Drive 大檔案整理進來的歷史基準，見 buildUnifiedViewSql_）
 */
function bqActiveSourceTableRef_(settings) {
  if (settings.sourceMode === 'external') return bqDedupedViewRef_(settings);
  if (settings.sourceMode === 'materialized') return bqUnifiedViewRef_(settings);
  return bqRawTableRef_(settings);
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

/** 有沒有設定 BigQuery 專案——一旦設定了，每天/補抓寫入一律直接進 BigQuery（見
 *  upsertHistoryRowsToBigQuery_），不再另外寫 Drive 月份 CSV 檔案；沒有設定 BigQuery
 *  的使用者維持原本寫 Drive 月份檔案的行為，不受影響。 */
function shouldWriteToBigQuery_() {
  return !!getBigQuerySettings().projectId;
}

/**
 * 把要寫進 history_raw 的列的「日期」欄位正規化成 yyyy-MM-dd 再回傳新陣列（不改原本的列物件，
 * Drive 月份 CSV 那條路徑還是要用原本 formatSlashDate_ 產生的 'yyyy/MM/dd' 顯示格式，不能共用
 * 同一份被改過的列）。
 *
 * 每日抓取的列物件的「日期」欄位是 formatSlashDate_ 產生的 'yyyy/MM/dd'（沿用 TWSE 慣用的顯示
 * 格式，不是 ISO 格式）。history_raw 的 date_str 卻要能被 BigQuery 的 SAFE_CAST(date_str AS
 * DATE) 解析成功（只接受 'yyyy-MM-dd'），不正規化直接寫進去的話，這幾天的資料在任何用
 * SAFE_CAST 判斷「最新一天」的查詢裡（例如 buildLatestDayFactorsSql_ 的 bounds CTE）都會被
 * 悄悄跳過——資料總覽用 MAX(date_str) 做純字串比較不受影響，還是看得到日期範圍有更新，但
 * 戰報會像是卡住不動一樣，一直停在「格式正確的最後一天」。這裡統一正規化成 yyyy-MM-dd，
 * 跟 history_materialized（從 Drive CSV 整理進來的舊資料基準）的格式對齊。
 */
function normalizeRowsDateField_(rows) {
  return rows.map(function (r) {
    var copy = {};
    for (var k in r) copy[k] = r[k];
    copy['日期'] = normalizeDateStr(r['日期']);
    return copy;
  });
}

/**
 * 把新抓到的資料（正常一次只有一天，但寫成通用版本也能一次處理多天，例如舊版 CSV 匯入）
 * 直接 WRITE_APPEND 進 history_raw，取代寫進 Drive 月份 CSV 檔案——避免使用者手上的歷史大檔案
 * 越滾越大，某一天 Apps Script 讀不動整個檔案（跟這次修好的 BigQuery 查詢記憶體問題是同一種
 * 風險，只是換成檔案讀寫）。一天的資料量很小（通常不到兩千列），轉成 CSV blob 上傳給
 * BigQuery load job 完全不會有大小問題，做法跟既有的 loadMonthIntoBigQuery_（月份同步）一致：
 * 先刪掉這些日期既有的資料再 append，維持可重複執行、不會重複。
 */
function upsertHistoryRowsToBigQuery_(newRows) {
  if (!newRows || newRows.length === 0) return { dates: [], totalRows: 0 };
  var settings = requireBigQueryProjectId_();
  ensureBigQueryDataset_(settings);
  ensureRawTable_(settings);

  var dates = [];
  var seen = {};
  newRows.forEach(function (r) {
    var d = normalizeDateStr(r['日期']);
    if (!seen[d]) { seen[d] = true; dates.push(d); }
  });

  runBqQuery_(buildDeleteDatesSql_(bqRawTableRef_(settings), dates), 'delete_dates');

  var csv = remapCsvHeaderToBigQuery_(rowsToCsv_(CONFIG.HISTORY_COLUMNS, normalizeRowsDateField_(newRows)));
  var blob = Utilities.newBlob(csv, 'text/csv', 'daily.csv');
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

  waitForBqLoadJob_(settings.projectId, job.jobReference.jobId, job.jobReference.location || CONFIG.BIGQUERY_LOCATION);
  return { dates: dates, totalRows: newRows.length };
}

/** 執行一段 SQL（DML 或 query），等到 job 跑完，回傳 rows（查詢類）或 null（DML 類）。
 *  label 只是給用量紀錄分類用（例如 'train_model'／'history_range'），不影響查詢本身。
 *  結果會依 pageToken 撈完全部分頁——歷史查詢動輒十幾萬列，遠超過 getQueryResults 單頁上限，
 *  只讀第一頁會在沒有 ORDER BY 的情況下隨機漏掉大量列，導致 rolling 因子出現大量 null。 */
function runBqQuery_(sql, label) {
  var settings = requireBigQueryProjectId_();
  var job = BigQuery.Jobs.query({
    query: sql,
    useLegacySql: false,
    location: CONFIG.BIGQUERY_LOCATION,
    timeoutMs: 30000
  }, settings.projectId);

  var jobId = job.jobReference.jobId;
  var location = job.jobReference.location || CONFIG.BIGQUERY_LOCATION;
  var result = waitForBqJob_(settings.projectId, jobId, location);
  logBqUsage_(label || 'query', result.totalBytesProcessed);

  if (!result.schema) return [];
  var fields = result.schema.fields.map(function (f) { return f.name; });
  var rawRows = (result.rows || []).slice();

  var pageToken = result.pageToken;
  while (pageToken) {
    var page = BigQuery.Jobs.getQueryResults(settings.projectId, jobId, { location: location, pageToken: pageToken });
    if (page.rows) rawRows = rawRows.concat(page.rows);
    pageToken = page.pageToken;
  }

  return rawRows.map(function (row) {
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

/** 輪詢一個「load job」（BigQuery.Jobs.insert 的 configuration.load，不是 query job）直到完成。
 *  load job 沒有查詢結果可以撈，BigQuery.Jobs.getQueryResults 只認得 query job，
 *  對 load job 呼叫會直接報錯「is not a query job」，要改用 BigQuery.Jobs.get 檢查
 *  job.status.state，這是既有的月份同步（loadMonthIntoBigQuery_）跟新的每日直接寫入
 *  （upsertHistoryRowsToBigQuery_）共用的錯誤，一次修好。 */
function waitForBqLoadJob_(projectId, jobId, location) {
  var deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    var job = BigQuery.Jobs.get(projectId, jobId, { location: location });
    if (job.status && job.status.state === 'DONE') {
      if (job.status.errorResult) {
        throw new Error('BigQuery load job 失敗：' + job.status.errorResult.message);
      }
      return job;
    }
    Utilities.sleep(1000);
  }
  throw new Error('BigQuery load job 逾時（超過 4 分鐘）。');
}

/** 把某個月份的 CSV 檔案內容（換過欄名）用 load job 塞進 BigQuery 原始表。 */
function loadMonthIntoBigQuery_(settings, monthKey) {
  var file = findMonthlyFile_(monthKey);
  if (!file) return { monthKey: monthKey, loaded: 0, skipped: true };

  var text = file.getBlob().getDataAsString('UTF-8');
  var remapped = remapCsvHeaderToBigQuery_(text);
  var blob = Utilities.newBlob(remapped, 'text/csv', monthKey + '.csv');

  runBqQuery_(buildDeleteMonthSql_(bqRawTableRef_(settings), monthKey), 'delete_month');

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

  waitForBqLoadJob_(settings.projectId, job.jobReference.jobId, job.jobReference.location || CONFIG.BIGQUERY_LOCATION);
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

/** 歷史資料夾裡所有看起來是 CSV 的檔案（不分是一次性大彙整檔還是每日排程的月份檔案），
 *  同時回傳 id（BigQuery 外部資料表要用）跟 name（給使用者看「涵蓋了哪幾個檔案」用，
 *  只顯示一個數字看不出是不是漏掉了預期的檔案）。 */
function listAllHistoryCsvFiles_() {
  var folder = getArchiveFolder_();
  var it = folder.getFiles();
  var files = [];
  while (it.hasNext()) {
    var f = it.next();
    if (/\.csv$/i.test(f.getName())) files.push({ id: f.getId(), name: f.getName() });
  }
  return files;
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
  runBqQuery_(buildDedupedViewSql_(bqExternalTableRef_(settings), bqDedupedViewRef_(settings)), 'dedup_view');
}

/**
 * 把 external 資料表重新指向歷史資料夾裡「目前所有」CSV 檔案，並重建去重 view。
 * 這是純 metadata + 一次 view 定義操作（不會讀檔案內容），所以再大/再多的檔案也不會卡住。
 */
function refreshExternalHistoryTable() {
  var settings = requireBigQueryProjectId_();
  ensureBigQueryDataset_(settings);
  var files = listAllHistoryCsvFiles_();
  if (files.length === 0) throw new Error('歷史資料夾裡沒有任何 CSV 檔案，無法建立外部資料表。');
  ensureExternalHistoryTable_(settings, files.map(function (f) { return f.id; }));
  ensureDedupedView_(settings);
  return { fileCount: files.length, fileNames: files.map(function (f) { return f.name; }) };
}

/**
 * 讀某個 Drive 檔案「最前面一小段」內容取出標題列，不讀整個檔案（用 Range header 的 HTTP
 * 部分內容請求，不是 DriveApp.getBlob()，所以再大的檔案也只讀幾 KB，不會撞到讀取上限）。
 */
function fetchFileHeaderRow_(fileId) {
  var url = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media';
  var resp = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      Range: 'bytes=0-8191'
    },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code !== 200 && code !== 206) {
    throw new Error('讀取檔案標題列失敗（HTTP ' + code + '，檔案 ID：' + fileId + '）。');
  }
  var text = resp.getContentText('UTF-8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  var newlineIdx = text.indexOf('\n');
  var firstLine = (newlineIdx === -1 ? text : text.slice(0, newlineIdx)).replace(/\r$/, '');
  var parsed = Utilities.parseCsv(firstLine);
  return parsed[0].map(function (h) { return String(h).trim(); });
}

/**
 * Materialized 模式：對資料夾裡每個 CSV 檔案讀一次標題列（見 fetchFileHeaderRow_），
 * 依實際偵測到的欄位順序分組（見 groupFileIdsByHeaderRow_），每組各自建一個外部資料表
 * （schema 是我們自己算出來的位置對應，欄名用乾淨 ascii 名稱，不假手 BigQuery 認中文欄名）。
 */
function ensureExternalTablesForHeaderGroups_(settings, fileIds) {
  var fileHeaderPairs = fileIds.map(function (fileId) {
    return { fileId: fileId, headerRow: fetchFileHeaderRow_(fileId) };
  });
  var groups = groupFileIdsByHeaderRow_(fileHeaderPairs);

  return groups.map(function (group, i) {
    var schemaFields = resolveHeaderOrderMapping_(group.headerRow, CONFIG.BQ_COLUMN_MAP);
    var tableId = CONFIG.BIGQUERY_AUTODETECT_EXTERNAL_TABLE + '_g' + i;
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
        sourceUris: group.fileIds.map(buildDriveFileUri_),
        autodetect: false,
        csvOptions: { skipLeadingRows: 1, allowJaggedRows: true, allowQuotedNewlines: true },
        schema: { fields: schemaFields }
      }
    }, settings.projectId, settings.dataset);
    return settings.projectId + '.' + settings.dataset + '.' + tableId;
  });
}

/**
 * 把資料夾裡所有 CSV（不管欄位順序是否一致）複製進 history_materialized 原生表（見 buildMaterializeSql_）。
 * 這是真的會讀資料、寫進原生儲存的操作（不是純 metadata），所以不應該每次查詢都做一次——
 * 交給 materializeHistoryTableIfStale_ 判斷多久沒整理才需要重來。
 */
function materializeHistoryTable() {
  var settings = requireBigQueryProjectId_();
  ensureBigQueryDataset_(settings);
  var files = listAllHistoryCsvFiles_();
  if (files.length === 0) throw new Error('歷史資料夾裡沒有任何 CSV 檔案，無法整理進 BigQuery。');
  var groupTableRefs = ensureExternalTablesForHeaderGroups_(settings, files.map(function (f) { return f.id; }));
  runBqQuery_(buildMaterializeSql_(groupTableRefs, bqMaterializedTableRef_(settings)), 'materialize');
  ensureUnifiedView_(settings);
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.BIGQUERY_MATERIALIZED_LAST_REFRESH, String(Date.now()));
  var fileNames = files.map(function (f) { return f.name; });
  logRun_('BigQuery 整理', '成功', 'history_materialized 已重新整理（' + files.length + ' 個來源檔案：' +
    fileNames.join('、') + '，' + groupTableRefs.length + ' 種欄位順序）', 0);
  return { fileCount: files.length, fileNames: fileNames, groupCount: groupTableRefs.length };
}

/** 建立/更新「統一讀取 view」（見 buildUnifiedViewSql_ 的說明）。history_raw 表如果還不存在
 *  （全新安裝、還沒寫過任何一天資料）就先建立一個空的。CREATE OR REPLACE VIEW 只是存 SQL 定義，
 *  幾乎不花時間也不算查詢用量；view 本身每次被查詢時都會即時反映 history_raw 當下最新的內容，
 *  不需要每次寫入新資料都重建 view。 */
function ensureUnifiedView_(settings) {
  ensureRawTable_(settings);
  runBqQuery_(buildUnifiedViewSql_(bqRawTableRef_(settings), bqMaterializedTableRef_(settings), bqUnifiedViewRef_(settings)), 'ensure_unified_view');
}

function getMaterializedLastRefreshMs_() {
  var v = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.BIGQUERY_MATERIALIZED_LAST_REFRESH);
  return v ? parseInt(v, 10) : 0;
}

/**
 * 只有「超過設定的最長間隔沒重新整理過」才真的重新整理，其餘時候直接沿用既有的原生表——
 * 這是 materialized 模式比 external 模式快的關鍵：不是每次查詢都重新掃一次 Drive。
 * maxAgeMinutesOverride 傳 0 代表強制重新整理（手動按鈕、每日排程用）。
 */
function materializeHistoryTableIfStale_(maxAgeMinutesOverride) {
  var maxAgeMinutes = (maxAgeMinutesOverride === 0 || maxAgeMinutesOverride) ? maxAgeMinutesOverride : CONFIG.BIGQUERY_MATERIALIZED_MAX_AGE_MINUTES;
  var lastMs = getMaterializedLastRefreshMs_();
  var ageMinutes = lastMs === 0 ? Infinity : (Date.now() - lastMs) / 60000;
  if (ageMinutes >= maxAgeMinutes) {
    return materializeHistoryTable();
  }
  return { skipped: true, ageMinutes: ageMinutes };
}

/** 依目前資料來源模式，執行查詢前該做的「準備」動作（external 重新指向檔案；materialized 視新舊決定要不要重新整理）。 */
function refreshDataSourceForMode_(settings) {
  if (settings.sourceMode === 'materialized') return materializeHistoryTableIfStale_();
  return refreshExternalHistoryTable();
}

/** 依目前資料來源模式，實際要查詢的來源（external 用去重 view；materialized 用「統一讀取 view」，
 *  UNION 了每天直接寫入的 history_raw 跟舊資料整理進來的 history_materialized，見 buildUnifiedViewSql_）。 */
function sourceRefForBigQueryRead_(settings) {
  return settings.sourceMode === 'materialized' ? bqUnifiedViewRef_(settings) : bqDedupedViewRef_(settings);
}

/**
 * BigQuery 模式（external／materialized）下，個股分析／回測研究／因子相關性掃描
 * 取得「一段日期區間」原始歷史資料列的入口，取代原本直接讀 Drive 月份檔案的
 * readRecentHistoryFromFiles_ / readHistoryRangeFromFiles_（見 SheetUtils.gs 的
 * readRecentHistory_ / readHistoryRange_，依目前的資料來源模式決定要呼叫哪一個）。
 * 回傳格式（中文欄名、數值已轉型）跟原本讀 Drive CSV 完全一樣，下游計算邏輯不用改。
 * 「今日戰報」／篩選漏斗明細改用 queryLatestDayFactorsFromBigQuery_()（見下方），
 * 不再整段搬進 Apps Script 算，避免全市場 x 回看天數的資料量塞爆 Apps Script 記憶體。
 */
function queryHistoryRowsFromBigQuery_(startStr, endStr) {
  var settings = requireBigQueryProjectId_();
  refreshDataSourceForMode_(settings);
  var rows = runBqQuery_(buildHistoryRangeQuerySql_(sourceRefForBigQueryRead_(settings), startStr, endStr), 'history_range');
  return rows.map(mapBqRowToHistoryRow_);
}

/**
 * 「今日戰報」／篩選漏斗明細的 BigQuery 模式入口：整段 rolling 因子 + 排名 + Armor_Score
 * 都在 BigQuery 裡算完（buildLatestDayFactorsSql_），Apps Script 只拿回「最新一個交易日」
 * 每檔股票已經算好的一列（約兩千列），不是 ANALYSIS_LOOKBACK_DAYS 天 x 全市場的原始資料
 * （十幾萬列，會撞 Apps Script V8 記憶體上限）。
 * portfolioMap 只用來知道「有哪些持股」，讓 fetchAdjustedPeaksForHoldings_() 用小範圍查詢
 * 覆蓋這幾檔股票「從買進日起算」的最高價（一般股票的 Adjusted_Peak 已經在主查詢裡算好）。
 */
function queryLatestDayFactorsFromBigQuery_(portfolioMap) {
  var settings = requireBigQueryProjectId_();
  refreshDataSourceForMode_(settings);

  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.ANALYSIS_LOOKBACK_DAYS);
  var sql = buildLatestDayFactorsSql_(sourceRefForBigQueryRead_(settings), normalizeDateStr(cutoff));
  var rows = runBqQuery_(sql, 'latest_day_factors').map(mapBqLatestFactorRowToAnalysisRow_);

  var peaks = fetchAdjustedPeaksForHoldings_(portfolioMap, settings);
  rows.forEach(function (r) {
    if (peaks.hasOwnProperty(r['證券代號'])) r.Adjusted_Peak = peaks[r['證券代號']];
  });
  return rows;
}

/**
 * 「個股分析」（getStockTimeSeries）與「持股庫存」（getLatestCloseByCode_/持股續抱診斷）
 * BigQuery 模式專用：只查「指定這幾檔股票、最近 N 天」的原始歷史列（資料量是「股票數 x days
 * 天」，跟 queryHistoryRowsFromBigQuery_ 的全市場查詢完全不同量級）。個股走勢／持股庫存卡在
 * loading 不動的根因都是同一種——原本呼叫 readRecentHistory_(days)，BigQuery 模式下會把
 * 「全市場 x days 天」的原始資料全部搬進 Apps Script，再用 JS 篩出需要的幾檔股票，資料量大時
 * 直接撞到 Apps Script 6 分鐘執行上限，整次 RPC 沒有任何回應、前端永遠停在 loading 狀態
 * （手機瀏覽器則更容易在等待過程中連線被中斷，變成「NetworkError: 連線失敗，原因 HTTP 0」）。
 */
function queryHistoryRowsForCodesFromBigQuery_(codes, days) {
  if (!codes || codes.length === 0) return [];
  var settings = requireBigQueryProjectId_();
  refreshDataSourceForMode_(settings);
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  var sql = buildHistoryRowsForStocksSql_(sourceRefForBigQueryRead_(settings), codes, normalizeDateStr(cutoff));
  return runBqQuery_(sql, 'stock_history_multi').map(mapBqRowToHistoryRow_);
}

/**
 * 對有持股的每一檔股票，只查「這幾檔股票、從最早買進日起算」的原始歷史列
 * （資料量是「持股數 x 天數」，跟全市場查詢完全不同量級，不會有記憶體問題），
 * 完整重用（不是重寫）已經驗證過的 computeFactors_ + expandingMaxFromIndex 邏輯算出
 * 「從買進日起算的最高價」，回傳 {證券代號: peak} 給 queryLatestDayFactorsFromBigQuery_()
 * 覆蓋主查詢算出來的「一般 expanding max」版本。
 */
function fetchAdjustedPeaksForHoldings_(portfolioMap, settings) {
  var stockIds = Object.keys(portfolioMap || {});
  if (stockIds.length === 0) return {};

  var earliestBuy = null;
  stockIds.forEach(function (id) {
    var bd = portfolioMap[id] && portfolioMap[id].buyDate;
    if (bd && (!earliestBuy || bd < earliestBuy)) earliestBuy = bd;
  });

  var sql = buildHistoryRowsForStocksSql_(sourceRefForBigQueryRead_(settings), stockIds, earliestBuy);
  var rawRows = runBqQuery_(sql, 'holdings_peak').map(mapBqRowToHistoryRow_);
  if (rawRows.length === 0) return {};

  var computed = computeFactors_(rawRows, portfolioMap);
  var latestByStock = {};
  computed.forEach(function (r) {
    var code = r['證券代號'];
    var d = normalizeDateStr(r['日期']);
    if (!latestByStock[code] || d > latestByStock[code].date) {
      latestByStock[code] = { date: d, peak: r.Adjusted_Peak };
    }
  });
  var out = {};
  Object.keys(latestByStock).forEach(function (code) { out[code] = latestByStock[code].peak; });
  return out;
}

/** BigQuery 模式下的資料範圍摘要（開機資訊 + 「資料總覽」頁籤用），取代讀 Drive 月份檔案算出來的版本。 */
function getHistoryDateBoundsFromBigQuery_() {
  var settings = requireBigQueryProjectId_();
  refreshDataSourceForMode_(settings);
  var rows = runBqQuery_(buildDateBoundsSql_(sourceRefForBigQueryRead_(settings)), 'date_bounds');
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
  if (settings.projectId && (settings.sourceMode === 'external' || settings.sourceMode === 'materialized')) {
    var bounds = getHistoryDateBoundsFromBigQuery_();
    var result = {
      mode: settings.sourceMode,
      min: bounds.min,
      max: bounds.max,
      tradingDays: bounds.tradingDays,
      stockCount: bounds.stockCount,
      rowCount: bounds.rowCount
    };
    if (settings.sourceMode === 'materialized') {
      var lastMs = getMaterializedLastRefreshMs_();
      result.lastRefresh = lastMs ? Utilities.formatDate(new Date(lastMs), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss') : null;
      var sizeBytes = getMaterializedTableSizeBytes_(settings);
      if (sizeBytes !== null) {
        result.sizeBytes = sizeBytes;
        result.sizeLabel = formatBytes_(sizeBytes);
      }
    }
    return result;
  }
  var fileBounds = getHistoryDateBounds();
  return {
    mode: 'native',
    min: fileBounds.min,
    max: fileBounds.max,
    monthsAvailable: fileBounds.monthsAvailable
  };
}

/** history_materialized 原生表目前的儲存大小（Tables.get 是免費的 metadata 呼叫，不算查詢用量）。
 *  external 模式是 view，沒有自己的儲存量可看，不提供。 */
/** history_materialized（舊資料一次性整理進來的基準）+ history_raw（每天直接寫入、持續成長）
 *  兩份表加起來的儲存量——資料現在分散在這兩份表裡，只看 materialized 那份會低估總量。 */
function getMaterializedTableSizeBytes_(settings) {
  var total = 0;
  var found = false;
  [CONFIG.BIGQUERY_MATERIALIZED_TABLE, CONFIG.BIGQUERY_RAW_TABLE].forEach(function (tableId) {
    try {
      var table = BigQuery.Tables.get(settings.projectId, settings.dataset, tableId);
      total += table.numBytes ? parseInt(table.numBytes, 10) : 0;
      found = true;
    } catch (e) {
      // 這份表還不存在（例如還沒寫過任何一天的資料），跳過不計入
    }
  });
  return found ? total : null;
}

/** 前端「資料總覽」：股票代號格式診斷（見 buildStockIdQualitySql_ 的詳細說明）。 */
function getHistoryStockIdQualityCheck() {
  var settings = requireBigQueryProjectId_();
  refreshDataSourceForMode_(settings);
  var rows = runBqQuery_(buildStockIdQualitySql_(sourceRefForBigQueryRead_(settings)), 'stock_id_quality');
  return mapStockIdQualityRows_(rows);
}

/** 前端「資料總覽」：檢查 history_raw 裡有幾列 date_str 格式不是 yyyy-MM-dd（見
 *  buildMalformedDateCountSql_ 的說明——這種列會讓「最新戰報」卡在格式正確的最後一天）。
 *  只查 history_raw，不查 history_unified/materialized，因為問題只會出在直接寫入的 history_raw；
 *  history_materialized 是從 Drive CSV 整理進來的舊資料基準，格式一直是正確的。 */
function getMalformedDateRowCount() {
  var settings = requireBigQueryProjectId_();
  var rows = runBqQuery_(buildMalformedDateCountSql_(bqRawTableRef_(settings)), 'malformed_date_check');
  return { count: rows.length ? parseInt(rows[0].cnt, 10) : 0 };
}

/** 前端「清理格式錯誤的日期資料」按鈕：刪掉 history_raw 裡 date_str 格式不對的列。
 *  清掉之後那幾天就沒有資料了，要另外用「手動抓取/重新彙整區間」把那幾天重新抓一次
 *  （這次寫入時 upsertHistoryRowsToBigQuery_ 已經會正規化成 yyyy-MM-dd，不會再壞掉）。
 *  刪除前先查一次實際受影響的日期清單（用 normalizeDateStr 轉成正常格式），一起回傳給前端，
 *  不然使用者刪完只知道「刪了幾列」，不知道要重新抓哪幾天。 */
function cleanupMalformedDateRows() {
  var settings = requireBigQueryProjectId_();
  var distinctRows = runBqQuery_(buildMalformedDateDistinctSql_(bqRawTableRef_(settings)), 'malformed_date_check');
  var affectedDates = distinctRows.map(function (r) { return normalizeDateStr(r.date_str); }).sort();
  var before = distinctRows.length ? getMalformedDateRowCount().count : 0;
  if (before > 0) {
    runBqQuery_(buildDeleteMalformedDateRowsSql_(bqRawTableRef_(settings)), 'cleanup_malformed_dates');
  }
  logRun_('清理日期格式錯誤資料', '成功',
    '刪除 ' + before + ' 列 history_raw 裡 date_str 格式不是 yyyy-MM-dd 的資料（受影響日期：' +
    (affectedDates.length ? affectedDates.join(', ') : '無') + '）', 0);
  return { deletedCount: before, affectedDates: affectedDates };
}

/** 前端「立即重新整理」按鈕（materialized 模式）：強制重新整理，不管多久前才整理過。
 *  保留給 materializeHistoryTableIfStale_ 的其他呼叫端（例如查詢前的自動判斷）直接同步呼叫用；
 *  手動按鈕改走下面的背景 job（startMaterializeJob），不要再直接呼叫這個。 */
function refreshMaterializedHistoryTable() {
  return materializeHistoryTableIfStale_(0);
}

// ============================================================
// 「立即重新整理」（materialized 模式）背景 job（機制跟其他三個背景 job 相同）。
// 要讀資料夾裡所有 CSV 檔案的標題列 + 跑 CREATE OR REPLACE TABLE AS SELECT，檔案一多容易
// 超過瀏覽器/行動網路能穩定撐住的連線時間，跟因子迴歸、重新計算戰報是同一類問題。
// ============================================================

function getMaterializeJobState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEYS.MATERIALIZE_JOB_STATE);
  return raw ? JSON.parse(raw) : null;
}

function saveMaterializeJobState_(state) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEYS.MATERIALIZE_JOB_STATE, JSON.stringify(state));
}

function deleteMaterializeJobTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processMaterializeJobTick_') ScriptApp.deleteTrigger(t);
  });
}

/** 前端「立即重新整理」按鈕呼叫：排一個幾乎立刻觸發的一次性時間觸發器就馬上回傳，
 *  實際整理在另一次獨立觸發的執行裡進行，不受這次瀏覽器連線影響。 */
function startMaterializeJob() {
  deleteMaterializeJobTriggers_();
  saveMaterializeJobState_({ status: 'running', updatedAt: Date.now() });
  ScriptApp.newTrigger('processMaterializeJobTick_').timeBased().after(1000).create();
  return { status: 'running' };
}

/** 前端輪詢用：狀態存在 Script Properties，任何時候打開頁面呼叫都看得到最新進度或結果。 */
function getMaterializeJobStatus() {
  return getMaterializeJobState_() || { status: 'idle' };
}

/** 排程佇列的「刪除」按鈕呼叫：不管目前狀態是什麼，直接清掉狀態跟任何已排定的觸發器。 */
function clearMaterializeJob_() {
  deleteMaterializeJobTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.PROP_KEYS.MATERIALIZE_JOB_STATE);
  return { status: 'idle' };
}

/** 真正做事的地方，由時間觸發器呼叫，完全不受瀏覽器分頁影響。單一批次，沒有時間預算/續跑機制。 */
function processMaterializeJobTick_() {
  deleteMaterializeJobTriggers_();
  var state = getMaterializeJobState_();
  if (!state || state.status !== 'running') return;

  var startTime = Date.now();
  try {
    var result = materializeHistoryTable();
    state.status = 'done';
    state.fileCount = result.fileCount;
    state.fileNames = result.fileNames;
    state.updatedAt = Date.now();
    saveMaterializeJobState_(state);
  } catch (e) {
    state.status = 'error';
    state.errorMessage = String(e.message || e);
    state.updatedAt = Date.now();
    saveMaterializeJobState_(state);
    logRun_('BigQuery 整理', '失敗', String(e.message || e), Math.round((Date.now() - startTime) / 1000));
  }
}
