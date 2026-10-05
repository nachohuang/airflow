/**
 * 直接 require lib/analysis.js（不經過 vm，不碰 apps-script/src/）測試這份 Firebase
 * 版「正本」本身的行為——跟 apps-script/test/analysis.test.js 幾乎是同一套案例，複製
 * 過來的理由見 lib/analysis.js 開頭的說明：這份正本以後會獨立修改，不能只靠跟 Apps
 * Script 比對（那是 parity.test.js 的職責，只在複製當下證明一次「起點一致」），平時的
 * 迴歸測試要靠這份自己的斷言。
 *
 * 刻意沒有複製的三個原始測試案例：
 *   - runAnalysis() 的兩個測試（原 11/12）：runAnalysis() 本身是 I/O orchestration
 *     （讀 History/Portfolio、寫 Reports），不屬於這份純運算核心，等 Cloud Function 的
 *     orchestration 層寫出來後，會在那一層另外補對應的測試（屆時會 mock Firestore/BigQuery）。
 *   - sanitizeRowForRpc_（原 13）：那是 google.script.run 跨 RPC 傳輸的 Date 序列化
 *     修正，Cloud Functions 用 JSON 回應，沒有這個問題，lib/utils.js 沒有複製這支函式。
 */
const assert = require('assert');
const analysis = require('../lib/analysis');
const utils = require('../lib/utils');
const config = require('../lib/config');

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
      '成交金額': 100000000,
      '開盤價': 20 + i * 0.3,
      '最高價': 20 + i * 0.3 + 0.5,
      '最低價': 20 + i * 0.3 - 0.5,
      '收盤價': 20 + i * 0.3,
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
  const computed = analysis.computeFactors_(rows, {});
  const sorted = utils.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);

  for (let i = 0; i < 18; i++) {
    assert.strictEqual(sorted[i].Armor_Score, null, 'day ' + i + ' 應該還沒有足夠資料算 Armor_Score');
  }
  const last = sorted[sorted.length - 1];
  assert.ok(typeof last.Armor_Score === 'number', '第 40 天應該已經有 Armor_Score');
  assert.ok(last.Trend_Score === 2, '持續上漲應該站上均線且均線向上，Trend_Score=2');
  console.log('Test 1 (Armor_Score availability) passed. last Armor_Score =', last.Armor_Score);
}

// --- 2. diagnoseRow_：無持股、量價齊揚 -> 應該給「🚀 趨勢啟動」---
{
  const rows = buildSyntheticHistory(40);
  const computed = analysis.computeFactors_(rows, {});
  const sorted = utils.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  assert.ok(approxEqual(last.Inst_Part_Rank, 1.0), '單一股票橫斷面排名應為 1.0');
  assert.ok(approxEqual(last.Vol_Ratio_Rank, 1.0));

  const diag = analysis.diagnoseRow_(last, {});
  assert.strictEqual(diag.strategy, '🚀 趨勢啟動');
  assert.strictEqual(diag.action, '建議：現價買入');
  console.log('Test 2 (diagnose - no holding, breakout) passed:', diag.strategy);
}

// --- 3. diagnoseRow_：有持股且從高點回落超過停損％ -> 應該給「止盈/止損」---
{
  const rows = buildSyntheticHistory(40);
  rows[rows.length - 1]['收盤價'] = 20 + 38 * 0.3 * 0.9;
  const portfolioMap = { '2330': { cost: 10, buyDate: rows[0]['日期'] } };
  const computed = analysis.computeFactors_(rows, portfolioMap);
  const sorted = utils.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  const diag = analysis.diagnoseRow_(last, portfolioMap);
  assert.strictEqual(diag.strategy, '🛑 止盈/止損');
  assert.strictEqual(diag.action, '建議：賣出');
  console.log('Test 3 (diagnose - trailing stop triggered) passed:', diag.strategy, diag.interpretation);
}

// --- 4. diagnoseRow_：有持股、穩定持有中（未觸發停損）-> 「持股守護」，損益計算正確 ---
{
  const rows = buildSyntheticHistory(40);
  const portfolioMap = { '2330': { cost: 15, buyDate: rows[0]['日期'] } };
  const computed = analysis.computeFactors_(rows, portfolioMap);
  const sorted = utils.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  const diag = analysis.diagnoseRow_(last, portfolioMap);
  assert.strictEqual(diag.strategy, '🛡️ 持股守護');
  const expectedProfit = ((last['收盤價'] - 15) / 15) * 100;
  assert.ok(diag.interpretation.indexOf(expectedProfit.toFixed(1)) !== -1, diag.interpretation);
  console.log('Test 4 (diagnose - holding, no stop) passed:', diag.strategy, diag.interpretation);
}

// --- 5. computeFactors_ 應該補齊完整匯出用的中間欄位 ---
{
  const rows = buildSyntheticHistory(40);
  const computed = analysis.computeFactors_(rows, {});
  const sorted = utils.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  ['Inst_Net', 'Is_Drop', 'Is_Inst_Buy_On_Drop', 'MA20_Slope', 'Vol_MA20'].forEach(function (field) {
    assert.ok(last.hasOwnProperty(field), 'computeFactors_ 應該要有欄位 ' + field);
  });
  assert.ok(typeof last.Inst_Net === 'number');
  console.log('Test 5 (computeFactors_ full export fields) passed.');
}

// --- 6. buildFullReportRow_ 應該產出跟 config.FULL_REPORT_COLUMNS 完全一致的欄位 ---
{
  const rows = buildSyntheticHistory(40);
  const computed = analysis.computeFactors_(rows, {});
  const sorted = utils.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];
  const diag = analysis.diagnoseRow_(last, {});
  const fullRow = analysis.buildFullReportRow_(last, diag);

  assert.deepStrictEqual(Object.keys(fullRow), config.FULL_REPORT_COLUMNS);
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
  const portfolioMap = { '1103': { cost: 10 } };
  const stats = analysis.computeScreeningStats_(scanRows, portfolioMap, '2026-07-30');

  assert.strictEqual(stats.totalStocks, 3);
  assert.strictEqual(stats.holdingCount, 1);
  assert.strictEqual(stats.nullInstPartRank, 1);
  assert.strictEqual(stats.nullVolRatioRank, 1);
  assert.strictEqual(stats.highInstParticipation, 1);
  assert.strictEqual(stats.volumeSpark, 1);
  assert.strictEqual(stats.breakoutMatches, 0);
  console.log('Test 7 (computeScreeningStats_ null-vs-low-rank) passed.');
}

// --- 8. 多股票刁鑽情境：零成交量日、剛上市資料不足、橫斷面排名同分 ---
{
  function dateStrAt(baseIdx) {
    const start = new Date(2026, 0, 1);
    const d = new Date(start);
    d.setDate(d.getDate() + baseIdx);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

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

  const combined = []
    .concat(buildStockRows('2330', 0, 70, -1))
    .concat(buildStockRows('2603', 0, 70, 65))
    .concat(buildStockRows('1101', 55, 15, -1));

  const computed = analysis.computeFactors_(combined, {});
  const latestDateStr = dateStrAt(69);
  const scanRows = computed.filter(function (r) { return r['日期'] === latestDateStr; });
  const byCode = {};
  scanRows.forEach(function (r) { byCode[r['證券代號']] = r; });

  assert.strictEqual(scanRows.length, 3, '三檔股票在共同的最新一天都該有一筆');
  assert.strictEqual(byCode['1101'].MA20, null);
  assert.strictEqual(byCode['1101'].MA60, null);
  assert.strictEqual(byCode['1101'].IBF_20D, 0);
  assert.strictEqual(byCode['2603'].Inst_Part_MA5, null, '視窗內只要有一天無法算 Inst_Participation，5 日均值整個要是 null');
  console.log('Test 8 (multi-stock edge cases) passed.');
}

// --- 9. computeLookbackStartStr_：以戰報日期為基準往前推 ANALYSIS_LOOKBACK_DAYS 天 ---
{
  const start = analysis.computeLookbackStartStr_('2026-07-31');
  const expected = new Date(2026, 6, 31);
  expected.setDate(expected.getDate() - config.ANALYSIS_LOOKBACK_DAYS);
  const expectedStr = expected.getFullYear() + '-' + String(expected.getMonth() + 1).padStart(2, '0') + '-' + String(expected.getDate()).padStart(2, '0');
  assert.strictEqual(start, expectedStr);
  console.log('Test 9 (computeLookbackStartStr_) passed:', start, '~ 2026-07-31');
}

// --- 10. screeningFunnelStages_：把具名欄位轉成通用的 {label, count, note} 關卡清單 ---
{
  const stats = {
    totalStocks: 100, holdingCount: 3, liquidityPass: 40, upwardTrend: 25,
    highInstParticipation: 8, nullInstPartRank: 2, volumeSpark: 6, nullVolRatioRank: 1,
    breakoutMatches: 0, ibfHighWithUpward: 4, nullIbfRank: 0
  };
  const stages = analysis.screeningFunnelStages_(stats);
  assert.strictEqual(stages.length, 7);
  assert.strictEqual(stages[0].count, 100);
  assert.ok(stages[0].note.indexOf('3 檔') !== -1);
  const instStage = stages.find(function (s) { return s.label.indexOf('法人參與度') !== -1; });
  assert.strictEqual(instStage.count, 8);
  console.log('Test 10 (screeningFunnelStages_) passed.');
}

// --- 11. classifyEntrySignal_：rule_v17／factor_model_rank／hybrid 三種版本 ---
{
  const baseRow = { '成交金額': 200000000, Trend_Score: 2, Inst_Part_Rank: 0.9, Vol_Ratio_Rank: 0.9, IBF_20D_Rank: 0.9 };
  const lowLiquidityRow = Object.assign({}, baseRow, { '成交金額': 1000000 });

  assert.strictEqual(analysis.classifyEntrySignal_(lowLiquidityRow, 'rule_v17').strategy, 'Neutral');
  assert.strictEqual(analysis.classifyEntrySignal_(baseRow, 'rule_v17').strategy, '🚀 趨勢啟動');
  const ibfOnlyRow = Object.assign({}, baseRow, { Inst_Part_Rank: 0.5, Vol_Ratio_Rank: 0.5 });
  assert.strictEqual(analysis.classifyEntrySignal_(ibfOnlyRow, 'rule_v17').strategy, '🔥 趨勢領航');
  const highRankButRuleFail = Object.assign({}, baseRow, {
    Inst_Part_Rank: 0.1, Vol_Ratio_Rank: 0.1, IBF_20D_Rank: 0.1, PredictedResistance_Rank: 0.99
  });
  assert.strictEqual(analysis.classifyEntrySignal_(highRankButRuleFail, 'rule_v17').strategy, 'Neutral');

  assert.strictEqual(analysis.classifyEntrySignal_(baseRow, 'factor_model_rank').strategy, 'Neutral');
  const highRankRow = Object.assign({}, baseRow, {
    Trend_Score: 0, Inst_Part_Rank: 0.1, Vol_Ratio_Rank: 0.1, IBF_20D_Rank: 0.1, PredictedResistance_Rank: 0.95
  });
  const modelDiag = analysis.classifyEntrySignal_(highRankRow, 'factor_model_rank');
  assert.strictEqual(modelDiag.strategy, '🚀 趨勢啟動');
  assert.ok(modelDiag.interpretation.indexOf('模型精選') !== -1, modelDiag.interpretation);
  assert.strictEqual(analysis.classifyEntrySignal_(Object.assign({}, baseRow, { PredictedResistance_Rank: 0.5 }), 'factor_model_rank').strategy, 'Neutral');
  assert.strictEqual(analysis.classifyEntrySignal_(Object.assign({}, lowLiquidityRow, { PredictedResistance_Rank: 0.99 }), 'factor_model_rank').strategy, 'Neutral');

  const hybridDiag = analysis.classifyEntrySignal_(Object.assign({}, baseRow, { PredictedResistance_Rank: 0.8 }), 'hybrid');
  assert.strictEqual(hybridDiag.strategy, '🚀 趨勢啟動');
  assert.ok(hybridDiag.interpretation.indexOf('模型排名前') !== -1, hybridDiag.interpretation);
  assert.strictEqual(analysis.classifyEntrySignal_(Object.assign({}, baseRow, { PredictedResistance_Rank: 0.5 }), 'hybrid').strategy, 'Neutral');
  const hybridRankOnlyRow = Object.assign({}, baseRow, {
    Inst_Part_Rank: 0.1, Vol_Ratio_Rank: 0.1, IBF_20D_Rank: 0.1, PredictedResistance_Rank: 0.99
  });
  assert.strictEqual(analysis.classifyEntrySignal_(hybridRankOnlyRow, 'hybrid').strategy, 'Neutral');

  assert.strictEqual(analysis.classifyEntrySignal_(baseRow, undefined).strategy, '🚀 趨勢啟動');
  assert.strictEqual(analysis.classifyEntrySignal_(baseRow, 'not_a_real_strategy').strategy, '🚀 趨勢啟動');

  console.log('Test 11 (classifyEntrySignal_) passed.');
}

// --- 12. computePredictedResistanceRanks_：依日期分組各自排名 ---
{
  const rowsNoModel = [{ '日期': '2026-07-30', Inst_Participation: 0.5 }];
  analysis.computePredictedResistanceRanks_(rowsNoModel, {});
  assert.strictEqual(rowsNoModel[0].PredictedDownsideResistance, null);
  assert.strictEqual(rowsNoModel[0].PredictedResistance_Rank, null);

  const rows = [
    { '日期': '2026-07-30', '證券代號': 'A', Inst_Participation: 0.1 },
    { '日期': '2026-07-30', '證券代號': 'B', Inst_Participation: 0.5 },
    { '日期': '2026-07-30', '證券代號': 'C', Inst_Participation: 0.9 }
  ];
  const applied = { downsideResistance: { weights: { inst_participation: 1 } } };
  analysis.computePredictedResistanceRanks_(rows, applied);
  assert.ok(approxEqual(rows[0].PredictedDownsideResistance, 0.1));
  assert.ok(approxEqual(rows[2].PredictedDownsideResistance, 0.9));
  assert.ok(approxEqual(rows[0].PredictedResistance_Rank, 1 / 3));
  assert.ok(approxEqual(rows[1].PredictedResistance_Rank, 2 / 3));
  assert.ok(approxEqual(rows[2].PredictedResistance_Rank, 3 / 3));

  const rowsMultiDay = [
    { '日期': '2026-07-29', '證券代號': 'A', Inst_Participation: 100 },
    { '日期': '2026-07-30', '證券代號': 'B', Inst_Participation: 0.1 },
    { '日期': '2026-07-30', '證券代號': 'C', Inst_Participation: 0.9 }
  ];
  analysis.computePredictedResistanceRanks_(rowsMultiDay, applied);
  assert.ok(approxEqual(rowsMultiDay[0].PredictedResistance_Rank, 1.0), '單獨一天只有一檔，排名必為 1.0');
  assert.ok(approxEqual(rowsMultiDay[1].PredictedResistance_Rank, 0.5));
  assert.ok(approxEqual(rowsMultiDay[2].PredictedResistance_Rank, 1.0));

  console.log('Test 12 (computePredictedResistanceRanks_) passed.');
}

console.log('All analysis.js tests passed.');
