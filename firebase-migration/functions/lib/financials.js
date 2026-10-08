/**
 * financials.js
 * 余適安（余博）法人選股邏輯裡「四率四升」（毛利率／營益率／淨利率／ROE
 * 連續上升）跟「月營收連續成長」的因子計算——這是全新邏輯，apps-script
 * 版沒有對應的程式碼可以照搬（那邊的 `TWSE_OFFICIAL_FINANCIALS_DATASETS_`
 * 只把這三份官方資料集原樣塞給 AI 診斷當文字參考，從來沒有解析成結構化
 * 數字，見 `AiDiagnosis.gs`／`aiDiagnosis.js` 的說明）。
 *
 * 資料來源是 TWSE OpenAPI 三個「一般業」端點（月營收／綜合損益表／資產
 * 負債表），欄位名稱沒有官方逐欄位文件可查（跟 `industryMap.js` 遇到
 * 同樣的限制），用關鍵字動態偵測，不寫死確切欄名；真的偵測不到就直接
 * 拋出清楚的錯誤，不會用錯欄位硬解析出垃圾數字。這個開發環境連不到
 * `openapi.twse.com.tw`，候選關鍵字清單是依 TWSE 這幾份官方報表長年
 * 公開、穩定的標準格式整理出來的，沒辦法在這裡實際連線核對，部署後
 * 第一次執行「重新整理財報因子」如果欄位偵測失敗，錯誤訊息會列出實際
 * 拿到的欄位名稱，照那個訊息回報就能一次修正，見 README 的完整說明。
 *
 * 新增時機：2026-10-08。
 */

/** 掃過樣本列的所有 key，依序找第一個「包含指定關鍵字之一」的欄位名稱，
 *  找不到回傳 null——跟 `lib/industryMap.js` 的 `detectFieldKey_` 同一套
 *  邏輯（各自獨立一份，不是共用模組：兩邊服務的資料集／關鍵字清單完全
 *  不同，合併成共用模組反而增加兩邊互相牽動的風險）。 */
function detectFieldKey_(sampleRow, substrings) {
  var keys = Object.keys(sampleRow);
  for (var i = 0; i < substrings.length; i++) {
    var match = keys.filter(function (k) { return k.indexOf(substrings[i]) !== -1; });
    if (match.length > 0) return match[0];
  }
  return null;
}

/**
 * TWSE OpenAPI 的日期欄位常見幾種格式：西元 'yyyy-MM-dd'／'yyyy/MM/dd'、
 * 民國年 'yyy/MM/dd'（例如 "115/03/31" 代表 2026-03-31），或完全沒有
 * 分隔符的民國年 7 碼字串（例如 "1150111" 代表民國 115 年 01 月 11
 * 日）——2026-10-08 用 WebSearch 查到 data.gov.tw 鏡像站「上市公司每月
 * 營業收入彙總表」資料集的範例「出表日期」欄位值就是這種 7 碼格式（這是
 * 鏡像站的範例，不是直接連線 `openapi.twse.com.tw` 核對到的，TWSE 自己
 * 的 JSON API 格式可能一致也可能不一致，保留原本的分隔符格式判斷當
 * 備援，不是只認這一種）。同時處理這幾種格式的保守判斷：年份欄位 >= 1911
 * 當西元年，< 1000 當民國年（+1911 轉西元），1000~1910 這個區間理論上
 * 不會出現，遇到就回傳 null 讓呼叫端知道這筆日期解析不出來，不是悄悄
 * 算出一個錯誤日期。回傳 'yyyy-MM-dd' 字串，解析失敗回傳 null。
 */
function parseTwseDate_(raw) {
  var s = String(raw || '').trim();

  var m = s.match(/^(\d{2,4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    var y = parseInt(m[1], 10);
    var mo = parseInt(m[2], 10);
    var d = parseInt(m[3], 10);
    if (y < 1000) y += 1911;
    if (y < 1911 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  // 無分隔符的民國年 7 碼（yyyMMDD，例如 "1150111"）——固定寬度 3+2+2，
  // 跟 normalizeYearMonth_ 處理 5 碼民國年月同一個「不能用貪婪 regex
  // 硬吃」的理由。
  var m2 = s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (m2) {
    var y2 = parseInt(m2[1], 10) + 1911;
    var mo2 = parseInt(m2[2], 10);
    var d2 = parseInt(m2[3], 10);
    if (mo2 < 1 || mo2 > 12 || d2 < 1 || d2 > 31) return null;
    return y2 + '-' + String(mo2).padStart(2, '0') + '-' + String(d2).padStart(2, '0');
  }

  return null;
}

/**
 * 解析 TWSE t187ap05_L（上市公司每月營業收入彙總表）的原始列，轉成
 * `{code, name, period, reportDate, reportDateIsEstimated, revenue,
 *   revenueYoyPct, source}` 陣列（`source` 固定是 `'openapi'`——跟
 * `lib/mopsRevenueHtml.js parseMopsRevenueTables_` 的 `'mopsBackfill'`
 * 對應，兩個來源寫進同一個 `financials_monthly` collection，sanity check
 * 抽樣表格用這個欄位標示每一筆到底是哪個來源抓到的）。`period` 是
 * 'yyyy-MM'（資料年月，財報所屬月份）
 * ，`reportDate` 是 'yyyy-MM-dd'（實際公開可得日期，訓練時間對齊要用
 * 這個，不是 `period`，見 `parseIncomeStatementRows_` 同一個「避免未來
 * 函數」的理由）。
 *
 * 2026-10-08：原本以為這份報表沒有公告日期欄位，用「月底+10天」估算，
 * 後來用 WebSearch 查到 data.gov.tw 鏡像站「上市公司每月營業收入彙總表」
 * 資料集的欄位清單跟範例資料，確認其實有「出表日期」這個官方欄位（這是
 * 鏡像站的資料，不是直接連線 `openapi.twse.com.tw` 核對到的，優先信任
 * 官方欄位，抓不到才退回估算當備援，不是只認其中一種）。
 *
 * `revenueYoyPct` 優先用官方已經算好的「去年同月增減(%)」欄位（TWSE 這份
 * 報表本來就有這一欄，不用自己重算一次，官方數字比我們用當月營收/去年
 * 當月營收自己除出來的更不容易因為單位換算出錯），查不到才退而求其次，
 * 用「當月營收」跟「去年當月營收」自己算。
 */
function parseMonthlyRevenueRows_(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new Error('TWSE 月營收資料回傳是空的，可能是端點或格式已經改變。');
  }
  var sample = rawRows[0];
  var codeKey = detectFieldKey_(sample, ['公司代號', '證券代號']);
  var nameKey = detectFieldKey_(sample, ['公司名稱', '證券名稱']);
  var periodKey = detectFieldKey_(sample, ['資料年月']);
  var reportDateKey = detectFieldKey_(sample, ['出表日期']);
  var revenueKey = detectFieldKey_(sample, ['當月營收']);
  var yoyKey = detectFieldKey_(sample, ['去年同月增減', '去年同月增减']);
  var lastYearRevenueKey = detectFieldKey_(sample, ['去年當月營收', '去年同月營收']);
  if (!codeKey || !periodKey || !revenueKey) {
    throw new Error('TWSE 月營收資料裡找不到代號／資料年月／當月營收欄位（目前欄位：' +
      Object.keys(sample).join('、') + '），可能是資料格式已經改變，需要人工確認。');
  }

  return rawRows.map(function (r) {
    var code = String(r[codeKey] || '').trim();
    var revenue = parseFloat(String(r[revenueKey] || '').replace(/,/g, ''));
    var periodRaw = String(r[periodKey] || '').trim(); // 常見格式 '11503'（民國年月）或 '2026-03'
    var period = normalizeYearMonth_(periodRaw);
    var officialReportDate = reportDateKey ? parseTwseDate_(r[reportDateKey]) : null;
    var reportDate = officialReportDate || (period ? estimateMonthlyRevenueReportDate_(period) : null);
    var revenueYoyPct = null;
    if (yoyKey && r[yoyKey] !== undefined && r[yoyKey] !== '') {
      revenueYoyPct = parseFloat(String(r[yoyKey]).replace(/,/g, ''));
    } else if (lastYearRevenueKey) {
      var lastYearRevenue = parseFloat(String(r[lastYearRevenueKey] || '').replace(/,/g, ''));
      if (lastYearRevenue) revenueYoyPct = (revenue - lastYearRevenue) / lastYearRevenue * 100;
    }
    return {
      code: code,
      name: nameKey ? String(r[nameKey] || '').trim() : '',
      period: period,
      reportDate: reportDate,
      reportDateIsEstimated: !officialReportDate,
      revenue: isNaN(revenue) ? null : revenue,
      revenueYoyPct: (revenueYoyPct === null || isNaN(revenueYoyPct)) ? null : revenueYoyPct,
      source: 'openapi'
    };
  }).filter(function (r) { return r.code.length === 4 && r.period && r.revenue !== null; });
}

/** 月營收資料如果真的沒有「出表日期」欄位（或偵測失敗），用「月底 + 10
 *  個日曆天」估算實際公開可得日期——對齊 TWSE 月營收法定公告期限（當月
 *  結束後 10 日內公告），是沒辦法連線核對官方確切公告日時的保守備援，
 *  比直接用月份本身（等於假設 3/1 就知道 3 月營收）更不容易製造未來
 *  函數。優先順序見 `parseMonthlyRevenueRows_` 的說明：有官方「出表
 *  日期」欄位一律優先用那個，這支只在抓不到那個欄位時當備援。 */
function estimateMonthlyRevenueReportDate_(period) {
  var parts = period.split('-').map(Number);
  var lastDay = new Date(Date.UTC(parts[0], parts[1], 0)); // 下個月第 0 天 = 這個月最後一天
  lastDay.setUTCDate(lastDay.getUTCDate() + 10);
  return lastDay.toISOString().slice(0, 10);
}

/**
 * 「資料年月」欄位常見是 6 碼民國年月字串（例如 '11503' 代表民國115年3月，
 * 也可能補零成 '011503' 或帶分隔符），這裡跟 `parseTwseDate_` 同一個
 * 「年份 < 1000 當民國年」判斷式，統一轉成 'yyyy-MM'。
 */
function normalizeYearMonth_(raw) {
  var s = String(raw || '').trim();
  // 有分隔符（'2026-03'／'2026/03'／'115/03'）。
  var m = s.match(/^(\d{2,4})[-/](\d{1,2})$/);
  if (m) {
    var y = parseInt(m[1], 10);
    var mo = parseInt(m[2], 10);
    if (y < 1000) y += 1911;
    if (y < 1911 || y > 2200 || mo < 1 || mo > 12) return null;
    return y + '-' + String(mo).padStart(2, '0');
  }
  // 無分隔符的民國年月（5 碼，例如 '11503' 代表民國 115 年 3 月）——不能
  // 用跟上面同一條「年份隨意吃到 4 碼」的 regex，貪婪比對會把 5 碼字串
  // 切成 4+1 碼（'1150'+'3'）而不是正確的 3+2 碼（'115'+'03'），只好
  // 另外用固定寬度 3+2 的 pattern 處理這個已知格式。
  var m2 = s.match(/^(\d{3})(\d{2})$/);
  if (m2) {
    var y2 = parseInt(m2[1], 10) + 1911;
    var mo2 = parseInt(m2[2], 10);
    if (mo2 < 1 || mo2 > 12) return null;
    return y2 + '-' + String(mo2).padStart(2, '0');
  }
  return null;
}

/** 從出表日期估算財報所屬季度標籤（'yyyy-Qn'）——財報公告通常落在季度
 *  結束後 45~75 天（法定期限），用「公告日往前推 60 天（居中的保守估計）
 *  所在的季度」反推所屬季度。這是沒有明確「年度／季別」欄位時的退路，
 *  見 `parseIncomeStatementRows_` 優先用官方欄位、這個函式只是備案。 */
function estimateFiscalQuarterFromReportDate_(reportDateStr) {
  if (!reportDateStr) return null;
  var d = new Date(reportDateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 60);
  var y = d.getUTCFullYear();
  var q = Math.floor(d.getUTCMonth() / 3) + 1;
  return y + '-Q' + q;
}

/**
 * 解析 TWSE t187ap06_L_ci（上市公司綜合損益表，一般業）的原始列，算出
 * 毛利率／營益率／淨利率，轉成
 * `{code, name, period, fiscalPeriod, revenue, grossProfit, operatingIncome,
 *   netIncome, grossMarginPct, operatingMarginPct, netMarginPct}` 陣列。
 * `period` 用「出表日期」（官方公告日，不是財報所屬季度的期末日）當作
 * 這筆資料「實際公開可得」的時間點——因子迴歸訓練要跟歷史股價做時間
 * 對齊時，用公告日而不是季度期末日，才不會有「用還沒公布的財報資料
 * 回測」這種未來函數偷看答案的問題（見
 * `lib/bigquery.js buildFundamentalFeatureViewSql_` 的說明）；找不到
 * 「出表日期」欄位就直接拋錯，不會用季度期末日頂替——那樣會製造一個
 * 使用者察覺不到的系統性偏誤，比拋錯讓人工確認更糟。
 *
 * `fiscalPeriod`（'yyyy-Qn'，財報「所屬」季度，跟 `period` 的「公告
 * 日」是不同概念）只給「資料完整性月曆」這種彙總呈現用，不影響訓練的
 * 時間對齊邏輯（那一塊只看 `period`／公告日）——優先偵測官方的
 * 「年度」／「季別」欄位，沒有才退而求其次用
 * `estimateFiscalQuarterFromReportDate_` 用公告日反推估計，兩者準確度
 * 不同，呼叫端（月曆 UI）要看得出來是不是用了估計值。
 */
function parseIncomeStatementRows_(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new Error('TWSE 綜合損益表資料回傳是空的，可能是端點或格式已經改變。');
  }
  var sample = rawRows[0];
  var codeKey = detectFieldKey_(sample, ['公司代號', '證券代號']);
  var nameKey = detectFieldKey_(sample, ['公司名稱', '證券名稱']);
  var reportDateKey = detectFieldKey_(sample, ['出表日期']);
  var revenueKey = detectFieldKey_(sample, ['營業收入']);
  var grossProfitKey = detectFieldKey_(sample, ['營業毛利']);
  var operatingIncomeKey = detectFieldKey_(sample, ['營業利益']);
  var netIncomeKey = detectFieldKey_(sample, ['本期淨利', '本期淨利（淨損）']);
  var yearKey = detectFieldKey_(sample, ['年度']);
  var quarterKey = detectFieldKey_(sample, ['季別']);
  if (!codeKey || !reportDateKey || !revenueKey) {
    throw new Error('TWSE 綜合損益表資料裡找不到代號／出表日期／營業收入欄位（目前欄位：' +
      Object.keys(sample).join('、') + '），可能是資料格式已經改變，需要人工確認。');
  }
  var fiscalPeriodIsEstimated = !(yearKey && quarterKey);

  return rawRows.map(function (r) {
    var code = String(r[codeKey] || '').trim();
    var reportDate = parseTwseDate_(r[reportDateKey]);
    var revenue = parseFloat(String(r[revenueKey] || '').replace(/,/g, ''));
    var grossProfit = grossProfitKey ? parseFloat(String(r[grossProfitKey] || '').replace(/,/g, '')) : NaN;
    var operatingIncome = operatingIncomeKey ? parseFloat(String(r[operatingIncomeKey] || '').replace(/,/g, '')) : NaN;
    var netIncome = netIncomeKey ? parseFloat(String(r[netIncomeKey] || '').replace(/,/g, '')) : NaN;
    var hasRevenue = !isNaN(revenue) && revenue !== 0;
    var fiscalPeriod = (yearKey && quarterKey)
      ? (String(r[yearKey] || '').trim() ? (parseInt(r[yearKey], 10) < 1000 ? parseInt(r[yearKey], 10) + 1911 : parseInt(r[yearKey], 10)) + '-Q' + String(r[quarterKey] || '').trim() : null)
      : estimateFiscalQuarterFromReportDate_(reportDate);
    return {
      code: code,
      name: nameKey ? String(r[nameKey] || '').trim() : '',
      period: reportDate,
      fiscalPeriod: fiscalPeriod,
      fiscalPeriodIsEstimated: fiscalPeriodIsEstimated,
      revenue: isNaN(revenue) ? null : revenue,
      grossProfit: isNaN(grossProfit) ? null : grossProfit,
      operatingIncome: isNaN(operatingIncome) ? null : operatingIncome,
      netIncome: isNaN(netIncome) ? null : netIncome,
      grossMarginPct: (hasRevenue && !isNaN(grossProfit)) ? (grossProfit / revenue * 100) : null,
      operatingMarginPct: (hasRevenue && !isNaN(operatingIncome)) ? (operatingIncome / revenue * 100) : null,
      netMarginPct: (hasRevenue && !isNaN(netIncome)) ? (netIncome / revenue * 100) : null
    };
  }).filter(function (r) { return r.code.length === 4 && r.period; });
}

/**
 * 解析 TWSE t187ap07_L_ci（上市公司資產負債表，一般業）的原始列，轉成
 * `{code, period, equity}` 陣列——`period` 一樣用「出表日期」，跟
 * `parseIncomeStatementRows_` 同一個「用公告日避免未來函數」的理由。
 */
function parseBalanceSheetRows_(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new Error('TWSE 資產負債表資料回傳是空的，可能是端點或格式已經改變。');
  }
  var sample = rawRows[0];
  var codeKey = detectFieldKey_(sample, ['公司代號', '證券代號']);
  var reportDateKey = detectFieldKey_(sample, ['出表日期']);
  var equityKey = detectFieldKey_(sample, ['權益總計', '權益總額']);
  if (!codeKey || !reportDateKey || !equityKey) {
    throw new Error('TWSE 資產負債表資料裡找不到代號／出表日期／權益總計欄位（目前欄位：' +
      Object.keys(sample).join('、') + '），可能是資料格式已經改變，需要人工確認。');
  }

  return rawRows.map(function (r) {
    var code = String(r[codeKey] || '').trim();
    var reportDate = parseTwseDate_(r[reportDateKey]);
    var equity = parseFloat(String(r[equityKey] || '').replace(/,/g, ''));
    return { code: code, period: reportDate, equity: isNaN(equity) ? null : equity };
  }).filter(function (r) { return r.code.length === 4 && r.period; });
}

/**
 * 把損益表跟資產負債表依「代號＋出表日期」合併，算出 ROE（本期淨利／
 * 權益總計）。兩份報表照 TWSE 的慣例通常同一天一起公告（同一季的財報），
 * 但不保證绝对一致，合併鍵還是用代號＋日期完整比對，對不到的那一筆
 * roePct 就是 null（跟其他合併失敗的欄位一樣，不是拋錯整批放棄——損益表
 * 本身的毛利率/營益率/淨利率不受影響，只有 ROE 這一項算不出來）。
 */
function joinIncomeAndEquity_(incomeRows, balanceRows) {
  var equityByKey = {};
  (balanceRows || []).forEach(function (r) {
    equityByKey[r.code + '|' + r.period] = r.equity;
  });
  return (incomeRows || []).map(function (r) {
    var equity = equityByKey[r.code + '|' + r.period];
    var roePct = (equity && r.netIncome !== null) ? (r.netIncome / equity * 100) : null;
    return Object.assign({}, r, { roePct: (roePct === null || isNaN(roePct)) ? null : roePct });
  });
}

/** 資料品質檢查，回傳問題清單（空陣列代表沒問題）——跟 `industryMap.js`
 *  `validateIndustryMapRows_` 同一個「寧可保留舊資料」原則：筆數太少
 *  （可能是抓到非「一般業」子集，或端點格式改變）就整批放棄這次更新。 */
function validateFinancialRows_(rows, label, minCount) {
  var issues = [];
  var n = rows ? rows.length : 0;
  if (n < (minCount || 500)) {
    issues.push(label + '只抓到 ' + n + ' 筆，遠低於預期的上市公司（一般業）數量，可能是資料源出問題。');
  }
  return issues;
}

/**
 * 通用「連續上升」計次：依 period 由舊到新排序後，這一期的值比上一期嚴格
 * 更大就累加，持平或下降就歸零——跟 `lib/factorScan.js computeStreak_`
 * 同一個「累加/歸零」骨架，差別是那支比的是固定的 0/1 標籤，這裡比的是
 * 「這一期比上一期大」這個動態條件。任一期的值是 null（缺資料）一律當
 * 「沒有延續」處理（歸零，不是跳過不比較），避免缺一期資料卻被當成
 * 「中間沒有中斷」而不正確地延續了連續紀錄。
 */
function computeIncreaseStreak_(sortedValues) {
  var out = new Array(sortedValues.length).fill(0);
  var run = 0;
  for (var i = 0; i < sortedValues.length; i++) {
    var cur = sortedValues[i];
    var prev = i > 0 ? sortedValues[i - 1] : null;
    if (cur !== null && prev !== null && cur > prev) {
      run += 1;
    } else {
      run = 0;
    }
    out[i] = (cur === null) ? null : run;
  }
  return out;
}

/**
 * 對一批「已經依代號分組、組內依 period 由舊到新排序好」的財報列
 * （`joinIncomeAndEquity_` 的輸出），各自算出毛利率／營益率／淨利率／
 * ROE 的連續上升期數，就地加上 `grossMarginStreak`／`operatingMarginStreak`／
 * `netMarginStreak`／`roeStreak` 四個欄位，回傳同一批列。
 */
function computeFundamentalStreaks_(sortedRowsByCode) {
  var out = [];
  sortedRowsByCode.forEach(function (rows) {
    var grossStreaks = computeIncreaseStreak_(rows.map(function (r) { return r.grossMarginPct; }));
    var opStreaks = computeIncreaseStreak_(rows.map(function (r) { return r.operatingMarginPct; }));
    var netStreaks = computeIncreaseStreak_(rows.map(function (r) { return r.netMarginPct; }));
    var roeStreaks = computeIncreaseStreak_(rows.map(function (r) { return r.roePct; }));
    rows.forEach(function (r, i) {
      out.push(Object.assign({}, r, {
        grossMarginStreak: grossStreaks[i],
        operatingMarginStreak: opStreaks[i],
        netMarginStreak: netStreaks[i],
        roeStreak: roeStreaks[i]
      }));
    });
  });
  return out;
}

/** 月營收連續成長（`revenueYoyPct > 0` 連續幾個月）——跟
 *  `computeFundamentalStreaks_` 分開一支，因為月營收是獨立的月頻資料，
 *  不是跟季報同一批列。對一批「已經依代號分組、組內依 period 由舊到新
 *  排序好」的月營收列，就地加上 `revenueGrowthStreak` 欄位。 */
function computeRevenueGrowthStreaks_(sortedRowsByCode) {
  var out = [];
  sortedRowsByCode.forEach(function (rows) {
    var tags = rows.map(function (r) { return (r.revenueYoyPct !== null) ? (r.revenueYoyPct > 0 ? 1 : 0) : null; });
    var run = 0;
    rows.forEach(function (r, i) {
      var tag = tags[i];
      if (tag === 1) { run += 1; } else { run = 0; }
      out.push(Object.assign({}, r, { revenueGrowthStreak: (tag === null) ? null : run }));
    });
  });
  return out;
}

/**
 * 2026-10-08 新增：把余博邏輯延伸的基本面因子接進「今日戰報/回測」即時
 * 預測分數——跟 `lib/bigquery.js buildFundamentalFeatureViewSql_` 同一個
 * 「公告日 <= 這一天」point-in-time 語意，但這裡是給 JS 端
 * `analysis.js computeFactors_` 逐股逐日查「當下最新一期財報」用，不是
 * SQL。先用 `buildAsOfIndex_` 把一批列依代號分組＋依日期由舊到新排序，
 * 再用 `lookupAsOf_` 對單一（代號、日期）做「這個代號裡，日期 <= 查詢
 * 日期的最後一筆」二分搜尋——語意上完全對應 BigQuery 那段
 * `WHERE fr2.stock_id = base.stock_id AND fr2.report_date <= base.date`
 * 的相關子查詢，只是換成在記憶體裡用已排序陣列做。
 */

/** 把一批列依 `code` 分組，組內依 `getDateStr(row)` 回傳的日期字串
 *  （'yyyy-MM-dd'）由舊到新排序。`getDateStr` 回傳 falsy 的列直接捨棄
 *  （沒有可比較的日期，沒辦法參與 as-of 查詢）。季報財務比率要傳
 *  `function(r){return r.period;}`（`period` 本身就是公告日，見
 *  `parseIncomeStatementRows_` 的說明），月營收要傳
 *  `function(r){return r.reportDate;}`（`period` 是 'yyyy-MM' 所屬月份，
 *  不是公告日）——兩邊欄位語意不同，刻意不替呼叫端預設猜一個。 */
function buildAsOfIndex_(rows, getDateStr) {
  var byCode = {};
  (rows || []).forEach(function (r) {
    var d = getDateStr(r);
    if (!d) return;
    if (!byCode[r.code]) byCode[r.code] = [];
    byCode[r.code].push({ reportDate: d, data: r });
  });
  Object.keys(byCode).forEach(function (code) {
    byCode[code].sort(function (a, b) { return a.reportDate < b.reportDate ? -1 : (a.reportDate > b.reportDate ? 1 : 0); });
  });
  return byCode;
}

/** 對單一代號查「日期 <= dateStr 的最後一筆」（`byCode` 是
 *  `buildAsOfIndex_` 的回傳值）——二分搜尋，`byCode[code]` 本身已經排序
 *  好，不用每次查詢都線性掃過。代號不存在、或代號底下所有紀錄的日期都
 *  晚於 `dateStr`（例如這檔股票還沒公告過任何財報）回傳 `null`，不是
 *  拋錯或退而求其次抓「最早一筆」——那樣等於用未來的資料回答過去的
 *  問題，違反 point-in-time 正確性。 */
function lookupAsOf_(byCode, code, dateStr) {
  var records = byCode[code];
  if (!records || records.length === 0) return null;
  var lo = 0, hi = records.length - 1, result = null;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (records[mid].reportDate <= dateStr) { result = records[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result ? result.data : null;
}

module.exports = {
  detectFieldKey_: detectFieldKey_,
  parseTwseDate_: parseTwseDate_,
  normalizeYearMonth_: normalizeYearMonth_,
  estimateFiscalQuarterFromReportDate_: estimateFiscalQuarterFromReportDate_,
  estimateMonthlyRevenueReportDate_: estimateMonthlyRevenueReportDate_,
  parseMonthlyRevenueRows_: parseMonthlyRevenueRows_,
  parseIncomeStatementRows_: parseIncomeStatementRows_,
  parseBalanceSheetRows_: parseBalanceSheetRows_,
  buildAsOfIndex_: buildAsOfIndex_,
  lookupAsOf_: lookupAsOf_,
  joinIncomeAndEquity_: joinIncomeAndEquity_,
  validateFinancialRows_: validateFinancialRows_,
  computeIncreaseStreak_: computeIncreaseStreak_,
  computeFundamentalStreaks_: computeFundamentalStreaks_,
  computeRevenueGrowthStreaks_: computeRevenueGrowthStreaks_
};
