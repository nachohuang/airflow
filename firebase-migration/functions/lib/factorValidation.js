/**
 * factorValidation.js
 * 「深度命題」第一層：通用的 IC（Information Coefficient）／walk-forward
 * 統計驗證引擎——純邏輯，完全不碰法人資金流向的具體定義，也不碰
 * BigQuery／Firestore。跟 lib/backtest.js 驗證的是不同的問題：backtest.js
 * 問「照這個策略進出場，報酬/勝率好不好」；這裡問「某個因子的值，本身
 * 跟未來報酬的排序相關性夠不夠強、夠不夠穩定」——因子要先通過這一層，
 * 才值得拿去包成任何進出場規則。
 *
 * 新增時機：2026-11-09，「深度命題」（IC／walk-forward 驗證管線，拆法人
 * 身份別檢定）的第一個增量，見 README 對應章節的完整討論。
 */
var utils = require('./utils');
var groupBy = utils.groupBy;
var sortRows = utils.sortRows;
var normalizeDateStr = utils.normalizeDateStr;
var shiftN = utils.shiftN;
var percentRank = utils.percentRank;
var pearsonCorrelation = utils.pearsonCorrelation;

/**
 * 某一天的樣本數太少時（例如候選股票池本來就小，或大部分因子值/未來報酬
 * 算不出來），Spearman 相關係數在統計上沒有意義（n=2、3 時任何一組資料
 * 都能算出 ±1 的「完美相關」，純粹是樣本太少的假象，不是訊號）——低於
 * 這個門檻的那一天，IC 直接當 null（不計入平均），不是硬算一個不可信的
 * 數字進去污染整體統計。
 */
var MIN_DAILY_SAMPLE_SIZE_ = 10;

/**
 * 對應 pandas df['close'].pct_change(-n)：第 i 天往後數 n 個「這個陣列裡
 * 的下一筆」（通常是交易日，不是日曆日——這個陣列本來就只收錄有交易的
 * 那幾天，中間的假日本來就不存在列）的報酬率。用既有的 shiftN（n 為負數
 * 代表往未來看，見 utils.js 的說明）取到未來收盤價，不用另外寫一個反向
 * 迴圈。陣列尾端 n 天內（未來資料還沒發生）跟收盤價是 0/null 的列一律
 * 回傳 null，不是 0——報酬率算不出來跟「報酬率是 0」是兩件事，不能混為
 * 一談。
 */
function computeForwardReturns_(closeArr, n) {
  var futureClose = shiftN(closeArr, -n);
  return closeArr.map(function (c, i) {
    var f = futureClose[i];
    if (c === null || c === undefined || c === 0 || f === null || f === undefined) return null;
    return (f - c) / c;
  });
}

/**
 * 把一個原始數值陣列轉成名次（重用 utils.percentRank 既有的「同分取平均
 * 名次、null 不計入分母、結果為 null」邏輯，不重新寫一次排序+同分處理，
 * 包一層成 {v: 原始值} 的假列陣列去借用它）。Pearson 相關係數對單調線性
 * 變換不敏感，用 percentRank 回傳的「百分位名次」(0~1) 跟用「原始名次」
 * (1~n) 算出來的相關係數完全一樣，不需要另外還原成整數名次。
 */
function rankValues_(values) {
  var wrapped = values.map(function (v) { return { v: v }; });
  return percentRank(wrapped, 'v');
}

/**
 * Spearman 等級相關係數：先篩出「兩邊都有值」的共同配對子集，只對這個
 * 子集轉名次，再對名次陣列算 Pearson（這就是 Spearman 相關係數的標準
 * 定義，不是近似）。回傳 {ic, n}——ic 是相關係數（有效配對 < 2 時為
 * null，沿用 utils.pearsonCorrelation 本身的 null 處理），n 是共同配對數，
 * 呼叫端可以用這個 n 自己決定要不要信任這個 ic（見
 * MIN_DAILY_SAMPLE_SIZE_ 的說明）。
 *
 * 刻意不是「xs／ys 各自對完整陣列轉名次，再逐配對過濾 null」——如果其中
 * 一邊缺值的位置跟另一邊不同（例如 xs 在某個位置是 null，ys 在那個位置
 * 有值），各自對完整陣列（包含那些配不上對的值）轉出來的名次，分母
 * （n）不一樣，名次就不是算在同一個比較基準上，會讓「其實完全同向」的
 * 資料算出不是 ±1 的相關係數——這是寫測試時真的算出來、不是憑空預想的
 * 陷阱，所以才先篩共同子集，確保兩邊的名次是在同一組配對上算出來的。
 */
function spearmanRankCorrelation_(xs, ys) {
  var validX = [];
  var validY = [];
  for (var i = 0; i < xs.length; i++) {
    var x = xs[i];
    var y = ys[i];
    var xOk = x !== null && x !== undefined && !(typeof x === 'number' && isNaN(x));
    var yOk = y !== null && y !== undefined && !(typeof y === 'number' && isNaN(y));
    if (xOk && yOk) {
      validX.push(x);
      validY.push(y);
    }
  }
  var rxs = rankValues_(validX);
  var rys = rankValues_(validY);
  return { ic: pearsonCorrelation(rxs, rys), n: validX.length };
}

/**
 * rows：已經算好「候選因子欄位」跟「未來報酬欄位」的列（任意股票、任意
 * 日期混在一起都可以，這裡會依「日期」分組）。對每一天的橫斷面分別算一次
 * Spearman IC，回傳依日期排序的時間序列 [{date, ic, n}, ...]。
 * minSampleSize 選填，預設 MIN_DAILY_SAMPLE_SIZE_。
 */
function computeIcSeries_(rows, factorField, forwardReturnField, minSampleSize) {
  var minN = minSampleSize || MIN_DAILY_SAMPLE_SIZE_;
  var byDate = groupBy(rows, function (r) { return normalizeDateStr(r['日期']); });
  var series = [];
  byDate.forEach(function (dayRows, dateStr) {
    var xs = dayRows.map(function (r) { return r[factorField]; });
    var ys = dayRows.map(function (r) { return r[forwardReturnField]; });
    var result = spearmanRankCorrelation_(xs, ys);
    series.push({ date: dateStr, ic: result.n >= minN ? result.ic : null, n: result.n });
  });
  return sortRows(series, [['date', 'asc']]);
}

/**
 * icSeries（任意順序都可以，這裡不假設已排序）的彙總統計：有效天數
 * （ic 不是 null 的那幾天）、平均 IC、標準差、t-stat（mean / (std/sqrt(n))）、
 * 粗略顯著性判定（|t| >= 2，約略對應雙尾 95% 信心水準——這是常用的經驗
 * 法則近似值，不是精確查表得出的 p-value，這個專案沒有引入統計套件，
 * 跟 lib/financials.js 這類「夠用就好、不為單一用途引套件」的既有風格
 * 一致）。有效天數 < 2 時 stdIc／tStat／significant 都是 null（標準差跟
 * t 檢定在只有 0、1 個樣本時沒有意義，不能硬算）。
 *
 * 標準差剛好是 0（每一天的 IC 完全相同，零變異）是另一個邊界情況，
 * 寫端到端測試時真的碰到過：t-stat 公式在這裡會除以 0，但這其實是
 * 「訊號完全穩定、每一天都指向同一個方向，沒有任何一天反例」的最極端
 * 情況，比一般的統計顯著性更強，不是算不出來——反過來，如果連平均值
 * 本身都是 0（每天都是 0），那是「完全沒有效果」，一樣不需要查 t 分配表。
 * 這兩種都直接由 `meanIc` 是否非 0 判斷 `significant`，`tStat` 留
 * `null`（沒有一個有限的數字能代表「無窮大」，用 `Infinity` 會在
 * JSON／Firestore 序列化時變成 `null`，反而更難分辨是哪一種情況）。
 */
function summarizeIcSeries_(icSeries) {
  var valid = icSeries.filter(function (d) { return d.ic !== null && d.ic !== undefined && !isNaN(d.ic); });
  var n = valid.length;
  if (n === 0) return { n: 0, meanIc: null, stdIc: null, tStat: null, significant: null };
  var meanIc = valid.reduce(function (s, d) { return s + d.ic; }, 0) / n;
  if (n < 2) return { n: n, meanIc: meanIc, stdIc: null, tStat: null, significant: null };
  var sq = valid.reduce(function (s, d) { return s + (d.ic - meanIc) * (d.ic - meanIc); }, 0);
  var stdIc = Math.sqrt(sq / (n - 1));
  if (stdIc === 0) return { n: n, meanIc: meanIc, stdIc: 0, tStat: null, significant: meanIc !== 0 };
  var tStat = meanIc / (stdIc / Math.sqrt(n));
  var significant = Math.abs(tStat) >= 2;
  return { n: n, meanIc: meanIc, stdIc: stdIc, tStat: tStat, significant: significant };
}

/**
 * 把已經排序的 icSeries 切成連續不重疊的區段，每段 foldSizeDays 筆（這裡
 * 的「天」是 icSeries 本身的筆數，也就是真正有算出樣本數的交易日，不是
 * 日曆天——icSeries 本來就只會有交易日的列，中間假日本來就不存在）。
 * 最後一段不滿 foldSizeDays 也會保留（筆數會反映在該段的 summary.n
 * 裡，呼叫端自己判斷要不要採信筆數明顯偏少的最後一段）。
 */
function splitWalkForwardFolds_(icSeries, foldSizeDays) {
  var sorted = sortRows(icSeries, [['date', 'asc']]);
  var folds = [];
  for (var i = 0; i < sorted.length; i += foldSizeDays) {
    folds.push(sorted.slice(i, i + foldSizeDays));
  }
  return folds;
}

/**
 * Walk-forward 驗證報告：整體統計 + 逐區段統計 + 「跨區段方向一致性」
 * （signConsistency，0~1：有算出平均 IC 的區段裡，跟多數區段同號的比例。
 * 1 代表每一段都同一個方向，訊號很穩定；接近 0.5 代表正負各半，等於
 * 整體平均值很可能只是不同方向的區段互相抵消湊出來的，不能信任）。
 */
function walkForwardIcReport_(icSeries, foldSizeDays) {
  var folds = splitWalkForwardFolds_(icSeries, foldSizeDays);
  var foldReports = folds.map(function (fold) {
    var summary = summarizeIcSeries_(fold);
    return {
      startDate: fold.length ? fold[0].date : null,
      endDate: fold.length ? fold[fold.length - 1].date : null,
      tradingDays: fold.length,
      summary: summary
    };
  });
  var signs = foldReports
    .filter(function (f) { return f.summary.meanIc !== null && f.summary.meanIc !== 0; })
    .map(function (f) { return f.summary.meanIc > 0 ? 1 : -1; });
  var positiveCount = signs.filter(function (s) { return s === 1; }).length;
  var negativeCount = signs.length - positiveCount;
  var signConsistency = signs.length ? Math.max(positiveCount, negativeCount) / signs.length : null;

  return {
    overall: summarizeIcSeries_(icSeries),
    folds: foldReports,
    foldCount: foldReports.length,
    signConsistency: signConsistency
  };
}

/**
 * 「深度命題」第三層的第一步：把 `computeForwardReturns_` 接到一批已經
 * 依股票代號分組好因子的 rows 上——對每個身份別分組，依日期排序、算出
 * 每個 horizon（例如 5/10/20 交易日）的未來報酬，就地補上
 * `FwdReturn_{n}D` 欄位。即使呼叫端給的 rows 已經排序過，這裡還是會
 * 重新依「代號、日期」排序一次——這支是獨立可重用的純函式，不該假設
 * 呼叫端的排序紀律，跟 lib/analysis.js computeFactors_ 自己也會重新排序
 * 一次是同一個理由。
 */
function attachForwardReturns_(rows, horizons) {
  var sorted = sortRows(rows, [
    ['證券代號', 'asc'],
    [function (r) { return normalizeDateStr(r['日期']); }, 'asc']
  ]);
  var byCode = groupBy(sorted, function (r) { return r['證券代號']; });
  byCode.forEach(function (group) {
    var closeArr = group.map(function (r) { return r['收盤價']; });
    horizons.forEach(function (n) {
      var fwd = computeForwardReturns_(closeArr, n);
      for (var i = 0; i < group.length; i++) group[i]['FwdReturn_' + n + 'D'] = fwd[i];
    });
  });
  return sorted;
}

/**
 * 整條驗證管線的頂層純函式：給一批已經算好「候選因子欄位」的 rows
 * （例如 lib/flowFactors.js computeFlowPersistenceFactors_ 的輸出），
 * 對每個 (因子, horizon) 組合各自跑一次完整的 walk-forward IC 驗證，
 * 回傳 `{ [factorField]: { ['h'+n]: walkForwardIcReport_ 的結果 } }`
 * 這樣的巢狀結構。
 *
 * 不會回傳每天逐筆的 IC 時間序列（只回傳 walkForwardIcReport_ 已經算好
 * 的彙總統計跟逐區段摘要）——驗證的因子數×horizon 數量一多，逐日明細
 * 會很快膨脹，而且呼叫端（Cloud Function 的回傳值／Firestore 文件）
 * 要看的是「這個因子站不站得住腳」的結論，不是重新畫一次時間序列圖，
 * 需要逐日明細時再另外開一個查詢路徑，不要預設就夾帶。
 */
function runIcValidationBatch_(rows, factorFields, horizons, foldSizeDays, minSampleSize) {
  var withReturns = attachForwardReturns_(rows, horizons);
  var report = {};
  factorFields.forEach(function (factorField) {
    report[factorField] = {};
    horizons.forEach(function (n) {
      var forwardField = 'FwdReturn_' + n + 'D';
      var icSeries = computeIcSeries_(withReturns, factorField, forwardField, minSampleSize);
      report[factorField]['h' + n] = walkForwardIcReport_(icSeries, foldSizeDays);
    });
  });
  return report;
}

module.exports = {
  MIN_DAILY_SAMPLE_SIZE_: MIN_DAILY_SAMPLE_SIZE_,
  computeForwardReturns_: computeForwardReturns_,
  rankValues_: rankValues_,
  spearmanRankCorrelation_: spearmanRankCorrelation_,
  computeIcSeries_: computeIcSeries_,
  summarizeIcSeries_: summarizeIcSeries_,
  splitWalkForwardFolds_: splitWalkForwardFolds_,
  walkForwardIcReport_: walkForwardIcReport_,
  attachForwardReturns_: attachForwardReturns_,
  runIcValidationBatch_: runIcValidationBatch_
};
