/**
 * IndustryCapitalFlow.gs
 * Phase 2（唯讀驗證）：用「產業對照表」（IndustryMap.gs）把今天全市場的法人買賣超
 * （Inst_Net，投信+外資+自營商合計）依產業分組加總，看資金今天偏向流入哪個產業。
 *
 * 純粹是「讓人肉眼確認這個訊號合不合理」的唯讀快照，不寫入 Reports、不影響 Armor_Score
 * 或任何篩選/評分邏輯，也還沒有變成因子迴歸模型的候選因子——要等這裡的數字先被人工
 * 確認過看起來合理，才會進到 Phase 3（真的餵進因子迴歸模型）。
 *
 * 目前產業對照表只有上市股票有資料（見 IndustryMap.gs 對上櫃資料源的說明），追蹤中的
 * 股票本來就 100% 是上市股票（DataFetch.gs 的三個每日抓取端點全部是 www.twse.com.tw，
 * 從來沒有抓過上櫃／TPEX 資料），所以這裡看到的涵蓋率不會因為上櫃缺口而失真。
 */

/**
 * 純函式：把「已經算好因子的最新一天全市場列」依產業分組，加總法人買賣超（Inst_Net），
 * 依合計淨買超由大到小排序。抽成獨立純函式方便在 Node 測試，不用真的接
 * computeLatestDayRows_/Sheets 就能驗證分組/加總/排序/平均值邏輯正確。
 * codeToIndustry：{ 證券代號: 產業別文字 } 的查表，查不到的股票計入 unclassifiedCount，
 * 不會被硬塞進某個產業裡污染統計。
 */
function aggregateIndustryCapitalFlow_(scanRows, codeToIndustry) {
  var groups = {};
  var unclassifiedCount = 0;
  (scanRows || []).forEach(function (r) {
    var code = zfill4(String(r['證券代號']).trim());
    var industry = codeToIndustry[code];
    if (!industry) { unclassifiedCount++; return; }
    if (!groups[industry]) groups[industry] = { stockCount: 0, sumInstNet: 0 };
    groups[industry].stockCount++;
    groups[industry].sumInstNet += (r.Inst_Net || 0);
  });
  var industries = Object.keys(groups).map(function (name) {
    var g = groups[name];
    return {
      industry: name,
      stockCount: g.stockCount,
      sumInstNet: g.sumInstNet,
      avgInstNet: g.stockCount > 0 ? g.sumInstNet / g.stockCount : 0
    };
  });
  industries.sort(function (a, b) { return b.sumInstNet - a.sumInstNet; });
  return { unclassifiedCount: unclassifiedCount, industries: industries };
}

/**
 * 前端「產業資金流向」按鈕呼叫：拿今天全市場已經算好因子的資料（跟今日戰報同一份計算
 * 結果，不用另外重算）+ 產業對照表，即時分組加總。故意用同步呼叫（不是背景 job）——
 * 跟「查看篩選漏斗明細」（getScreeningDiagnostics）是同一類唯讀查詢，同樣的效能特性，
 * 那個一直是同步呼叫沒出過問題，這裡先比照辦理；真的遇到手機連線中斷的問題再改背景 job。
 */
function getIndustryCapitalFlowSnapshot() {
  var scanRows = computeLatestDayRows_({});
  if (scanRows.length === 0) {
    return { latestDate: null, totalStocks: 0, unclassifiedCount: 0, industries: [] };
  }
  var latestDate = normalizeDateStr(scanRows[0]['日期']);
  var codeToIndustry = {};
  readSheetObjects_(getIndustryMapSheet_()).forEach(function (r) {
    codeToIndustry[zfill4(String(r['證券代號']).trim())] = r['產業別'];
  });
  var agg = aggregateIndustryCapitalFlow_(scanRows, codeToIndustry);
  return {
    latestDate: latestDate,
    totalStocks: scanRows.length,
    unclassifiedCount: agg.unclassifiedCount,
    industries: agg.industries
  };
}
