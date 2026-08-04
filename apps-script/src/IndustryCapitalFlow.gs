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
 * 純函式：把「已經算好因子的最新一天全市場列」依產業分組，加總法人買賣超，依合計淨買超
 * 由大到小排序。抽成獨立純函式方便在 Node 測試，不用真的接 computeLatestDayRows_/Sheets
 * 就能驗證分組/加總/排序邏輯正確。codeToIndustry：{ 證券代號: 產業別文字 } 的查表，
 * 查不到的股票計入 unclassifiedCount，不會被硬塞進某個產業裡污染統計。
 *
 * 除了合計買賣超（Inst_Net，投信+外資+自營商），另外拆出三大法人各自的合計（foreignSum/
 * trustSum/dealerSum）——這是使用者驗證訊號時提出的：光看合計數字看不出「外資賣、投信買」
 * 這種分歧，拆開來才看得出來。
 *
 * 也計算「最大貢獻個股」（topContributor）跟它佔產業「總交易強度」（sumAbsInstNet，
 * 每檔買賣超取絕對值再加總，不是淨額）的比例——這是使用者驗證時發現的方法論疑慮：合計
 * 買賣超是簡單加總，只要產業裡有一檔權值股（例如半導體業的台積電）當天買賣超特別大，
 * 整個產業的排名就會被那一檔股票主導，不一定真的代表「整個產業」資金流向一致，
 * 用 sumAbsInstNet（而不是淨額）當分母才能正確衡量「這檔股票佔了多少交易強度」，
 * 淨額當分母在多空互相抵銷時會失真（甚至可能除以接近 0 的數字）。
 */
function aggregateIndustryCapitalFlow_(scanRows, codeToIndustry) {
  var groups = {};
  var unclassifiedCount = 0;
  (scanRows || []).forEach(function (r) {
    var code = zfill4(String(r['證券代號']).trim());
    var industry = codeToIndustry[code];
    if (!industry) { unclassifiedCount++; return; }
    if (!groups[industry]) {
      groups[industry] = {
        stockCount: 0, sumInstNet: 0, sumAbsInstNet: 0,
        foreignSum: 0, trustSum: 0, dealerSum: 0, topContributor: null
      };
    }
    var g = groups[industry];
    var instNet = r.Inst_Net || 0;
    g.stockCount++;
    g.sumInstNet += instNet;
    g.sumAbsInstNet += Math.abs(instNet);
    g.foreignSum += (r['外資'] || 0);
    g.trustSum += (r['投信'] || 0);
    g.dealerSum += (r['自營商'] || 0);
    if (!g.topContributor || Math.abs(instNet) > Math.abs(g.topContributor.instNet)) {
      g.topContributor = { code: code, name: r['證券名稱'] || '', instNet: instNet };
    }
  });
  var industries = Object.keys(groups).map(function (name) {
    var g = groups[name];
    var topContributor = null;
    if (g.topContributor) {
      topContributor = {
        code: g.topContributor.code,
        name: g.topContributor.name,
        instNet: g.topContributor.instNet,
        sharePct: g.sumAbsInstNet > 0 ? Math.round(Math.abs(g.topContributor.instNet) / g.sumAbsInstNet * 1000) / 10 : null
      };
    }
    return {
      industry: name,
      stockCount: g.stockCount,
      sumInstNet: g.sumInstNet,
      avgInstNet: g.stockCount > 0 ? g.sumInstNet / g.stockCount : 0,
      foreignSum: g.foreignSum,
      trustSum: g.trustSum,
      dealerSum: g.dealerSum,
      topContributor: topContributor
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
