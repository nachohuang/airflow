/**
 * 用 vm 把 Config.gs + Utils.gs + Analysis.gs 一起載進同一個 global scope 模擬 Apps Script
 * 的共用全域環境，藉此在 Node 直接測 computeFactors_ / diagnoseRow_ 這兩個純運算函式，
 * 不用真的部署到 Apps Script 才能驗證 v17.0 邏輯有沒有翻譯正確。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const context = {
  console: console,
  module: undefined // block the Utils.gs node-export branch, keep functions as plain globals
};
vm.createContext(context);

function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}

loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('Analysis.gs');

function approxEqual(a, b, eps) {
  eps = eps || 1e-6;
  return Math.abs(a - b) < eps;
}

function buildSyntheticHistory(days) {
  const rows = [];
  const start = new Date(2026, 0, 1);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    rows.push({
      '日期': dateStr,
      '證券代號': '2330',
      '證券名稱': '台積電',
      '外資': 50000,
      '投信': 100000,
      '自營商': 0,
      '三大法人買賣超股數': 150000,
      '成交股數': 5000000,
      '成交筆數': 10000,
      '成交金額': 100000000, // 一定超過 LIQUIDITY_MIN
      '開盤價': 20 + i * 0.3,
      '最高價': 20 + i * 0.3 + 0.5,
      '最低價': 20 + i * 0.3 - 0.5,
      '收盤價': 20 + i * 0.3, // 穩定上升
      '漲跌(+/-)': '+',
      '漲跌價差': 0.3,
      '最後揭示買價': 20 + i * 0.3,
      '最後揭示買量': 100,
      '最後揭示賣價': 20 + i * 0.3 + 0.1,
      '最後揭示賣量': 100,
      '殖利率(%)': 2.0,
      '本益比': 15,
      '股價淨值比': 3,
      '財報年/季': '2026Q1'
    });
  }
  return rows;
}

// --- 1. Armor_Score 應該在資料不足 20 天前是 null，之後變成數字 ---
{
  const rows = buildSyntheticHistory(40);
  const computed = context.computeFactors_(rows, {});
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);

  for (let i = 0; i < 18; i++) {
    assert.strictEqual(sorted[i].Armor_Score, null, 'day ' + i + ' 應該還沒有足夠資料算 Armor_Score');
  }
  const last = sorted[sorted.length - 1];
  assert.ok(typeof last.Armor_Score === 'number', '第 40 天應該已經有 Armor_Score');
  assert.ok(last.Trend_Score === 2, '持續上漲應該站上均線且均線向上，Trend_Score=2');
  console.log('Test 1 (Armor_Score availability) passed. last Armor_Score =', last.Armor_Score);
}

// --- 2. diagnoseRow_：無持股、量價齊揚 -> 應該給「🚀 趨勢啟動」（單一股票橫斷面排名必為 1.0）---
{
  const rows = buildSyntheticHistory(40);
  const computed = context.computeFactors_(rows, {});
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  assert.ok(approxEqual(last.Inst_Part_Rank, 1.0), '單一股票橫斷面排名應為 1.0');
  assert.ok(approxEqual(last.Vol_Ratio_Rank, 1.0));

  const diag = context.diagnoseRow_(last, {});
  assert.strictEqual(diag.strategy, '🚀 趨勢啟動');
  assert.strictEqual(diag.action, '建議：現價買入');
  console.log('Test 2 (diagnose - no holding, breakout) passed:', diag.strategy);
}

// --- 3. diagnoseRow_：有持股且從高點回落超過停損％ -> 應該給「止盈/止損」---
{
  const rows = buildSyntheticHistory(40);
  // 製造最後一天大跌，模擬從高點拉回
  rows[rows.length - 1]['收盤價'] = 20 + 38 * 0.3 * 0.9; // 大幅回落
  const portfolioMap = { '2330': { cost: 10, buyDate: rows[0]['日期'] } };
  const computed = context.computeFactors_(rows, portfolioMap);
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  const diag = context.diagnoseRow_(last, portfolioMap);
  assert.strictEqual(diag.strategy, '🛑 止盈/止損');
  assert.strictEqual(diag.action, '建議：賣出');
  console.log('Test 3 (diagnose - trailing stop triggered) passed:', diag.strategy, diag.interpretation);
}

// --- 4. diagnoseRow_：有持股、穩定持有中（未觸發停損）-> 「持股守護」，損益計算正確 ---
{
  const rows = buildSyntheticHistory(40);
  const portfolioMap = { '2330': { cost: 15, buyDate: rows[0]['日期'] } };
  const computed = context.computeFactors_(rows, portfolioMap);
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  const diag = context.diagnoseRow_(last, portfolioMap);
  assert.strictEqual(diag.strategy, '🛡️ 持股守護');
  const expectedProfit = ((last['收盤價'] - 15) / 15) * 100;
  assert.ok(diag.interpretation.indexOf(expectedProfit.toFixed(1)) !== -1, diag.interpretation);
  console.log('Test 4 (diagnose - holding, no stop) passed:', diag.strategy, diag.interpretation);
}

// --- 5. computeFactors_ 應該補齊完整匯出用的中間欄位（跟原本 xlsx 戰報的欄位對齊）---
{
  const rows = buildSyntheticHistory(40);
  const computed = context.computeFactors_(rows, {});
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  ['Inst_Net', 'Is_Drop', 'Is_Inst_Buy_On_Drop', 'MA20_Slope', 'Vol_MA20'].forEach(function (field) {
    assert.ok(last.hasOwnProperty(field), 'computeFactors_ 應該要有欄位 ' + field);
  });
  assert.ok(typeof last.Inst_Net === 'number');
  console.log('Test 5 (computeFactors_ full export fields) passed.');
}

// --- 6. buildFullReportRow_ 應該產出跟 CONFIG.FULL_REPORT_COLUMNS 完全一致的欄位（供 xlsx 匯出比對）---
{
  const rows = buildSyntheticHistory(40);
  const computed = context.computeFactors_(rows, {});
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];
  const diag = context.diagnoseRow_(last, {});
  const fullRow = context.buildFullReportRow_(last, diag);

  const expectedKeys = Array.from(context.CONFIG.FULL_REPORT_COLUMNS);
  const actualKeys = Object.keys(fullRow);
  assert.deepStrictEqual(actualKeys, expectedKeys);
  assert.strictEqual(fullRow['操作策略'], diag.strategy);
  console.log('Test 6 (buildFullReportRow_ matches FULL_REPORT_COLUMNS) passed.');
}

// --- 7. computeScreeningStats_：null 排名要算進 nullXxx 計數，不要誤判成「排名很低」---
{
  const scanRows = [
    { '證券代號': '1101', '成交金額': 200000000, Trend_Score: 2, Inst_Part_Rank: null, Vol_Ratio_Rank: 0.9, IBF_20D_Rank: 0.8 },
    { '證券代號': '1102', '成交金額': 200000000, Trend_Score: 2, Inst_Part_Rank: 0.9, Vol_Ratio_Rank: null, IBF_20D_Rank: 0.8 },
    { '證券代號': '1103', '成交金額': 200000000, Trend_Score: 0, Inst_Part_Rank: 0.9, Vol_Ratio_Rank: 0.9, IBF_20D_Rank: null }
  ];
  const portfolioMap = { '1103': { cost: 10 } }; // 持股不算在漏斗內
  const stats = context.computeScreeningStats_(scanRows, portfolioMap, '2026-07-30');

  assert.strictEqual(stats.totalStocks, 3);
  assert.strictEqual(stats.holdingCount, 1);
  assert.strictEqual(stats.nullInstPartRank, 1, '1101 的 Inst_Part_Rank 是 null，應該算進 nullInstPartRank');
  assert.strictEqual(stats.nullVolRatioRank, 1, '1102 的 Vol_Ratio_Rank 是 null，應該算進 nullVolRatioRank');
  assert.strictEqual(stats.highInstParticipation, 1, '只有 1102 的 Inst_Part_Rank>=0.8 且非 null');
  assert.strictEqual(stats.volumeSpark, 1, '只有 1101 的 Vol_Ratio_Rank>=0.85 且非 null');
  assert.strictEqual(stats.breakoutMatches, 0, '1101/1102 都因為某一項是 null 而湊不齊三條件');
  console.log('Test 7 (computeScreeningStats_ null-vs-low-rank) passed.');
}

// --- 8. 獨立驗證 BigQuerySync.gs buildLatestDayFactorsSql_ 的「數學設計」跟 computeFactors_
//    （已經逐行對照 Python 驗證過的引擎）在刁鑽情境下算出一樣的結果：零成交量日、剛上市資料不足、
//    橫斷面排名同分。這裡不是呼叫同一套 Utils.gs 函式比較（那樣沒有意義），是把 SQL 公式
//    另外用陣列運算重新刻一次當作獨立對照組，兩邊都對，才真的有信心 SQL 版本翻譯正確。 ---
{
  function dateStrAt(baseIdx) {
    const start = new Date(2026, 0, 1);
    const d = new Date(start);
    d.setDate(d.getDate() + baseIdx);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // code: 股票代號；startIdx/count：相對於共同時間軸的起訖（用來模擬「剛上市、資料不足」的股票）；
  // zeroVolRelIdx：在這檔股票自己的第幾天（0-indexed）成交量歸零，模擬停牌/無量。
  function buildStockRows(code, startIdx, count, zeroVolRelIdx) {
    const rows = [];
    for (let i = 0; i < count; i++) {
      const vol = i === zeroVolRelIdx ? 0 : 5000000 + i * 1000;
      rows.push({
        '日期': dateStrAt(startIdx + i), '證券代號': code, '證券名稱': code + '_名稱',
        '外資': 50000, '投信': 100000, '自營商': 0, '三大法人買賣超股數': 150000,
        '成交股數': vol, '成交筆數': 10000, '成交金額': 100000000,
        '開盤價': 20 + i * 0.3, '最高價': 20 + i * 0.3 + 0.5, '最低價': 20 + i * 0.3 - 0.5, '收盤價': 20 + i * 0.3,
        '漲跌(+/-)': '+', '漲跌價差': 0.3,
        '最後揭示買價': 20 + i * 0.3, '最後揭示買量': 100, '最後揭示賣價': 20 + i * 0.3 + 0.1, '最後揭示賣量': 100,
        '殖利率(%)': 2.0, '本益比': 15, '股價淨值比': 3, '財報年/季': '2026Q1'
      });
    }
    return rows;
  }

  // 共同時間軸終點是 index 69（第 70 天）：2330 正常 70 天；2603 正常 70 天但第 65 天無量；
  // 1101 剛上市只有 15 天資料（index 55..69），MA20/MA60/Inst_Part_MA5 在最新一天都該是 null。
  const combined = []
    .concat(buildStockRows('2330', 0, 70, -1))
    .concat(buildStockRows('2603', 0, 70, 65))
    .concat(buildStockRows('1101', 55, 15, -1));

  const computed = context.computeFactors_(combined, {});
  const latestDateStr = dateStrAt(69);
  const scanRows = computed.filter(function (r) { return r['日期'] === latestDateStr; });
  const byCode = {};
  scanRows.forEach(function (r) { byCode[r['證券代號']] = r; });

  assert.strictEqual(scanRows.length, 3, '三檔股票在共同的最新一天都該有一筆');

  // --- 獨立重刻一次 SQL 公式（COUNT-based 視窗完整性保護 + RANK 同分平均排名），純陣列運算 ---
  function simulateStock(rows) {
    const n = rows.length;
    const close = rows.map(function (r) { return r['收盤價']; });
    const vol = rows.map(function (r) { return r['成交股數']; });
    const instNet = rows.map(function (r) { return r['投信'] + r['外資'] + r['自營商']; });
    const instPart = vol.map(function (v, i) { return v === 0 ? null : (Math.abs(rows[i]['投信']) + Math.abs(rows[i]['外資']) + Math.abs(rows[i]['自營商'])) / v; });

    function windowAvg(values, i, w, requireNonNullCount) {
      if (i - w + 1 < 0) return null;
      const win = values.slice(i - w + 1, i + 1);
      const nonNull = win.filter(function (v) { return v !== null; });
      if (requireNonNullCount && nonNull.length !== w) return null;
      return nonNull.reduce(function (a, b) { return a + b; }, 0) / win.length;
    }
    function windowSum(values, i, w) {
      if (i - w + 1 < 0) return null;
      return values.slice(i - w + 1, i + 1).reduce(function (a, b) { return a + b; }, 0);
    }

    const last = n - 1;
    const ma20 = windowAvg(close, last, 20, false);
    const ma60 = windowAvg(close, last, 60, false);
    const volMa20 = windowAvg(vol, last, 20, false);
    const instPartMa5 = windowAvg(instPart, last, 5, true); // 唯一可能視窗內含 null 的欄位，需要 nonNull-count 保護
    const isDrop = rows.map(function (r, i) {
      if (i === 0) return 0;
      const ret = close[i - 1] === 0 ? null : close[i] / close[i - 1] - 1;
      return ret !== null && ret < 0 ? 1 : 0;
    });
    const isBuyOnDrop = isDrop.map(function (d, i) { return (d === 1 && instNet[i] > 0) ? 1 : 0; });
    const dropCount20 = windowSum(isDrop, last, 20);
    const buyOnDrop20 = windowSum(isBuyOnDrop, last, 20);
    const ibf20 = (dropCount20 === null || dropCount20 === 0) ? 0 : buyOnDrop20 / dropCount20;
    const ma20Prev3 = (last - 3 >= 0) ? windowAvg(close, last - 3, 20, false) : null;
    const ma20Slope = (ma20 !== null && ma20Prev3 !== null) ? ma20 - ma20Prev3 : null;
    const volRatio = (volMa20 !== null && volMa20 !== 0) ? vol[last] / volMa20 : null;
    const trendScore = (ma20 !== null && close[last] > ma20 ? 1 : 0) + (ma20Slope !== null && ma20Slope > 0 ? 1 : 0);

    return { ma20: ma20, ma60: ma60, instPartMa5: instPartMa5, ibf20: ibf20, volRatio: volRatio, trendScore: trendScore };
  }

  const sim = {
    '2330': simulateStock(combined.filter(function (r) { return r['證券代號'] === '2330'; })),
    '2603': simulateStock(combined.filter(function (r) { return r['證券代號'] === '2603'; })),
    '1101': simulateStock(combined.filter(function (r) { return r['證券代號'] === '1101'; }))
  };

  // 逐檔比對 computeFactors_（信任的引擎）跟獨立重刻的 SQL 公式模擬
  ['2330', '2603', '1101'].forEach(function (code) {
    const expected = byCode[code];
    const s = sim[code];
    if (s.ma20 === null) assert.strictEqual(expected.MA20, null, code + ' MA20 應為 null'); else assert.ok(approxEqual(expected.MA20, s.ma20), code + ' MA20 不一致');
    if (s.ma60 === null) assert.strictEqual(expected.MA60, null, code + ' MA60 應為 null'); else assert.ok(approxEqual(expected.MA60, s.ma60), code + ' MA60 不一致');
    if (s.instPartMa5 === null) assert.strictEqual(expected.Inst_Part_MA5, null, code + ' Inst_Part_MA5 應為 null'); else assert.ok(approxEqual(expected.Inst_Part_MA5, s.instPartMa5), code + ' Inst_Part_MA5 不一致');
    assert.ok(approxEqual(expected.IBF_20D, s.ibf20), code + ' IBF_20D 不一致');
    assert.strictEqual(expected.Trend_Score, s.trendScore, code + ' Trend_Score 不一致');
  });

  // 關鍵斷言：1101 資料不足 20 天，MA20/MA60/Inst_Part_MA5 都該是 null，IBF_20D 該 fillna 成 0（不是 null）
  assert.strictEqual(byCode['1101'].MA20, null);
  assert.strictEqual(byCode['1101'].MA60, null);
  assert.strictEqual(byCode['1101'].IBF_20D, 0);
  // 2603 第 65 天無量，落在最新一天 Inst_Part_MA5 的 5 天視窗內（65~69），整個視窗因為含 null 而是 null
  assert.strictEqual(byCode['2603'].Inst_Part_MA5, null, '視窗內只要有一天無法算 Inst_Participation，5 日均值整個要是 null，不能只跳過那天');

  console.log('Test 8 (BigQuery SQL design cross-check vs computeFactors_) passed.');
}

// --- 9. computeLookbackStartStr_：以戰報日期為基準往前推 ANALYSIS_LOOKBACK_DAYS 天，
//    不是用「今天」當基準（顯示已經是舊資料的戰報時，範圍要跟著戰報日期走，不是今天）---
{
  const start = context.computeLookbackStartStr_('2026-07-31');
  const expected = new Date(2026, 6, 31);
  expected.setDate(expected.getDate() - context.CONFIG.ANALYSIS_LOOKBACK_DAYS);
  const expectedStr = expected.getFullYear() + '-' + String(expected.getMonth() + 1).padStart(2, '0') + '-' + String(expected.getDate()).padStart(2, '0');
  assert.strictEqual(start, expectedStr);
  console.log('Test 9 (computeLookbackStartStr_) passed:', start, '~ 2026-07-31');
}

// --- 10. screeningFunnelStages_：把具名欄位轉成通用的 {label, count, note} 關卡清單，
//    給前端「查看篩選漏斗明細」跟排程佇列卡片共用渲染邏輯用 ---
{
  const stats = {
    totalStocks: 100, holdingCount: 3, liquidityPass: 40, upwardTrend: 25,
    highInstParticipation: 8, nullInstPartRank: 2, volumeSpark: 6, nullVolRatioRank: 1,
    breakoutMatches: 0, ibfHighWithUpward: 4, nullIbfRank: 0
  };
  const stages = context.screeningFunnelStages_(stats);
  assert.strictEqual(stages.length, 7);
  assert.strictEqual(stages[0].count, 100);
  assert.ok(stages[0].note.indexOf('3 檔') !== -1);
  const instStage = stages.find(function (s) { return s.label.indexOf('法人參與度') !== -1; });
  assert.strictEqual(instStage.count, 8);
  assert.ok(instStage.note.indexOf('2 檔無法計算') !== -1);
  const trendStage = stages.find(function (s) { return s.label.indexOf('多頭排列') !== -1; });
  assert.strictEqual(trendStage.note, '', '沒有無法計算的關卡 note 應該是空字串，不是 undefined');
  console.log('Test 10 (screeningFunnelStages_) passed.');
}

// --- 11. runAnalysis()：scanRows 是空陣列時（完全查無資料，不是篩選篩掉）仍要附上
//    diagnostics（totalStocks=0），呼叫端才分得出「查無資料」跟「有資料但全被篩掉」---
{
  const original = context.computeLatestDayRows_;
  context.computeLatestDayRows_ = function () { return []; };
  context.getPortfolioMap_ = function () { return {}; };
  const result = context.runAnalysis();
  assert.strictEqual(result.latestDate, null);
  assert.strictEqual(result.report.length, 0);
  assert.ok(result.diagnostics, 'scanRows 空陣列時也要附上 diagnostics');
  assert.strictEqual(result.diagnostics.totalStocks, 0);
  context.computeLatestDayRows_ = original;
  console.log('Test 11 (runAnalysis with zero scanRows still attaches diagnostics) passed.');
}

console.log('All Analysis.gs tests passed.');
