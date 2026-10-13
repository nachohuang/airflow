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

// --- 11b. classifyEntrySignal_：early_accumulation（2026-10-13 新增，法人逢低接手、趨勢未確立） ---
{
  const liquid = { '成交金額': 200000000 };

  // 門檻剛好達標（0.85）、趨勢還沒確立（Trend_Score 1，兩個多頭條件只過一個）-> 應該命中
  const earlyHit = Object.assign({}, liquid, { Trend_Score: 1, IBF_20D_Rank: 0.85 });
  const earlyDiag = analysis.classifyEntrySignal_(earlyHit, 'early_accumulation');
  assert.strictEqual(earlyDiag.strategy, '🌱 潛伏期');
  assert.ok(earlyDiag.interpretation.indexOf('趨勢尚未確立') !== -1, earlyDiag.interpretation);

  // Trend_Score===2（趨勢已經確立）也不特別排除，一樣算命中——這支策略不要求「未確立」，
  // 只是「不要求確立」，兩者不一樣。
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, liquid, { Trend_Score: 2, IBF_20D_Rank: 0.9 }), 'early_accumulation').strategy,
    '🌱 潛伏期'
  );

  // Trend_Score===0（完全空頭排列，兩個多頭條件都沒過）要排除，避免接刀——即使法人逢低
  // 接手率再高也不行，這是唯一的保護機制。
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, liquid, { Trend_Score: 0, IBF_20D_Rank: 0.99 }), 'early_accumulation').strategy,
    'Neutral', 'Trend_Score===0（完全空頭）要被排除，不管法人接手率多高'
  );

  // 門檻差一點點（0.84999）不該命中
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, liquid, { Trend_Score: 1, IBF_20D_Rank: 0.84999 }), 'early_accumulation').strategy,
    'Neutral'
  );

  // IBF_20D_Rank 是 null（算不出來）要當成沒過門檻，不是拋錯
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, liquid, { Trend_Score: 1, IBF_20D_Rank: null }), 'early_accumulation').strategy,
    'Neutral'
  );

  // 流動性門檻一樣適用（跟其他策略共用同一個前置檢查，不是 early_accumulation 自己另外判斷）
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, liquid, { '成交金額': 1000000, Trend_Score: 1, IBF_20D_Rank: 0.9 }), 'early_accumulation').strategy,
    'Neutral'
  );

  console.log('Test 11b (classifyEntrySignal_: early_accumulation — IBF threshold, excludes Trend_Score===0, liquidity still applies) passed.');
}

// --- 11c. classifyEntrySignal_：composite_accumulation（2026-10-13 新增，三個訊號交叉驗證） ---
{
  const liquid = { '成交金額': 200000000 };
  const allPass = Object.assign({}, liquid, {
    Trend_Score: 1, IBF_20D_Rank: 0.75, Inst_Rank_20D: 0.8, Price_Rank_20D: 0.4,
    Inst_Accum_Divergence_20D: 0.4, Days_Since_New_Low_Rank: 0.5
  });

  // 三個門檻都剛好達標 -> 命中，interpretation 要秀出三個訊號各自的實際數值
  // （不是只有一句泛用的通過/不通過），呼應使用者「看能否看到邏輯內容供理解」的要求
  const diag = analysis.classifyEntrySignal_(allPass, 'composite_accumulation');
  assert.strictEqual(diag.strategy, '🧭 綜合吸籌');
  assert.ok(diag.interpretation.indexOf('75%') !== -1, diag.interpretation);
  assert.ok(diag.interpretation.indexOf('80%') !== -1 && diag.interpretation.indexOf('40%') !== -1, diag.interpretation);
  assert.ok(diag.interpretation.indexOf('50%') !== -1, diag.interpretation);

  // 三個條件任何一個沒過，都不該命中——逐一只改一個欄位讓它沒過
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, allPass, { IBF_20D_Rank: 0.74999 }), 'composite_accumulation').strategy,
    'Neutral', 'IBF_20D_Rank 差一點點沒過門檻'
  );
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, allPass, { Inst_Accum_Divergence_20D: 0.29999 }), 'composite_accumulation').strategy,
    'Neutral', 'Inst_Accum_Divergence_20D 差一點點沒過門檻'
  );
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, allPass, { Days_Since_New_Low_Rank: 0.29999 }), 'composite_accumulation').strategy,
    'Neutral', 'Days_Since_New_Low_Rank 差一點點沒過門檻'
  );

  // Trend_Score===0（完全空頭排列）要排除，跟 early_accumulation 一樣的保護機制
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, allPass, { Trend_Score: 0 }), 'composite_accumulation').strategy,
    'Neutral', 'Trend_Score===0 要被排除'
  );

  // Trend_Score===2（趨勢已經確立）不特別排除，一樣算命中
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, allPass, { Trend_Score: 2 }), 'composite_accumulation').strategy,
    '🧭 綜合吸籌'
  );

  // 三個欄位任何一個是 null（算不出來）都要當成沒過門檻，不是拋錯
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, allPass, { IBF_20D_Rank: null }), 'composite_accumulation').strategy,
    'Neutral'
  );
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, allPass, { Inst_Accum_Divergence_20D: null }), 'composite_accumulation').strategy,
    'Neutral'
  );
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, allPass, { Days_Since_New_Low_Rank: null }), 'composite_accumulation').strategy,
    'Neutral'
  );

  // 流動性門檻一樣適用
  assert.strictEqual(
    analysis.classifyEntrySignal_(Object.assign({}, allPass, { '成交金額': 1000000 }), 'composite_accumulation').strategy,
    'Neutral'
  );

  console.log('Test 11c (classifyEntrySignal_: composite_accumulation — three signals all required, excludes Trend_Score===0, null-safe, liquidity still applies) passed.');
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

// --- 13. computeFactors_：financialsIndex 選填參數，接進基本面因子 ---
// 2026-10-08 新增：余博邏輯延伸的基本面因子接進「今日戰報/回測」即時
// 預測分數，見 lib/analysis.js computeFactors_ 的 financialsIndex 參數
// 說明跟 lib/financials.js buildAsOfIndex_／lookupAsOf_ 的 point-in-time
// 查詢邏輯。
{
  const financialsLib = require('../lib/financials');
  const factorModel = require('../lib/factorModel');
  const rows = buildSyntheticHistory(5); // 日期 2026-01-01 ~ 2026-01-05

  // 13a：不帶 financialsIndex（既有呼叫端，例如 parity 測試）——完全不補欄位，
  // 不是補 null，行為要跟這個參數加進來之前一模一樣。
  const withoutIndex = analysis.computeFactors_(rows.map(function (r) { return Object.assign({}, r); }), {});
  assert.ok(!withoutIndex[0].hasOwnProperty('Fundamental_Roe_Pct'), '沒帶 financialsIndex 不應該補上 Fundamental_* 欄位');

  // 13b：帶 financialsIndex——2026-01-03 公告一期季報，2026-01-01/02 應該查不到
  // （point-in-time，不能偷看未來），2026-01-03 起維持這期的值。
  const quarterlyRows = [{ code: '2330', period: '2026-01-03', grossMarginPct: 30, roePct: 5, roeStreak: 2 }];
  const monthlyRows = [{ code: '2330', reportDate: '2026-01-02', revenueYoyPct: 12, revenueGrowthStreak: 3 }];
  const financialsIndex = {
    quarterlyByCode: financialsLib.buildAsOfIndex_(quarterlyRows, function (r) { return r.period; }),
    monthlyByCode: financialsLib.buildAsOfIndex_(monthlyRows, function (r) { return r.reportDate; })
  };
  const withIndex = utils.sortRows(
    analysis.computeFactors_(rows.map(function (r) { return Object.assign({}, r); }), {}, financialsIndex),
    [[function (r) { return r['日期']; }, 'asc']]
  );
  assert.strictEqual(withIndex[0].Fundamental_Roe_Pct, null, '公告日之前要是 null');
  assert.strictEqual(withIndex[1].Fundamental_Roe_Pct, null);
  assert.strictEqual(withIndex[2].Fundamental_Roe_Pct, 5, '公告日當天開始要查得到');
  assert.strictEqual(withIndex[2].Fundamental_Gross_Margin_Pct, 30);
  assert.strictEqual(withIndex[2].Fundamental_Roe_Streak, 2);
  assert.strictEqual(withIndex[4].Fundamental_Roe_Pct, 5, '之後幾天要維持同一期的值');
  assert.strictEqual(withIndex[1].Fundamental_Revenue_Yoy_Pct, 12, '月營收公告日是 2026-01-02，比季報早一天');
  assert.strictEqual(withIndex[0].Fundamental_Revenue_Yoy_Pct, null);

  // 13c：端到端——config.BQ_FEATURE_TO_ANALYSIS_FIELD 對照表要能把
  // fundamental_roe_pct 的權重正確映射到 computeWeightedFactorScore_ 用得上
  // 的欄位，不是只停在 computeFactors_ 這一層。
  const score = factorModel.computeWeightedFactorScore_(withIndex[2], { fundamental_roe_pct: 2 });
  assert.strictEqual(score, 10, '5 (Fundamental_Roe_Pct) * 2 (權重) = 10');

  console.log('Test 13 (computeFactors_ financialsIndex: backward-compatible when omitted, as-of lookup, wired into computeWeightedFactorScore_) passed.');
}

// --- 14. computeFactors_：composite_accumulation 用到的新因子（Inst_Net_Sum_20D／
// Price_Change_20D／Days_Since_New_Low_Raw／橫斷面排名／Inst_Accum_Divergence_20D，
// 2026-10-13 新增）---
{
  function dateStrAt14(baseIdx) {
    const start = new Date(2026, 0, 1);
    const d = new Date(start);
    d.setDate(d.getDate() + baseIdx);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function buildRow14(code, idx, close, instNet) {
    return {
      '日期': dateStrAt14(idx), '證券代號': code, '證券名稱': code + '_名稱',
      '外資': instNet, '投信': 0, '自營商': 0, '三大法人買賣超股數': instNet,
      '成交股數': 5000000, '成交筆數': 10000, '成交金額': 100000000,
      '開盤價': close, '最高價': close + 0.5, '最低價': close - 0.5, '收盤價': close,
      '漲跌(+/-)': '+', '漲跌價差': 0.3,
      '最後揭示買價': close, '最後揭示買量': 100, '最後揭示賣價': close + 0.1, '最後揭示賣量': 100,
      '殖利率(%)': 2.0, '本益比': 15, '股價淨值比': 3, '財報年/季': '2026Q1'
    };
  }

  // AAAA：前 30 天（index 0~29）每天跌 1 點，連續創新低；index 29 是最低點（71），
  // 從 index 30 開始反彈每天漲 2 點，最後一天（index 34）距離上次創新低應該是 5 天。
  // 法人每天買超固定 1000（20 天累積買超排名會比 BBBB 高）。
  const aaaaRows = [];
  for (let i = 0; i < 30; i++) aaaaRows.push(buildRow14('AAAA', i, 100 - i, 1000));
  for (let i = 30; i < 35; i++) aaaaRows.push(buildRow14('AAAA', i, 71 + (i - 29) * 2, 1000));

  // BBBB：全程穩定上漲（20 天漲幅排名會比 AAAA 高，而且視窗內從來沒有創過新低），
  // 法人每天買超只有 500（20 天累積買超排名會比 AAAA 低）。
  const bbbbRows = [];
  for (let i = 0; i < 35; i++) bbbbRows.push(buildRow14('BBBB', i, 50 + i * 0.5, 500));

  const computed14 = analysis.computeFactors_(aaaaRows.concat(bbbbRows), {});
  const latestDateStr14 = dateStrAt14(34);
  const byCode14 = {};
  computed14.filter(function (r) { return r['日期'] === latestDateStr14; })
    .forEach(function (r) { byCode14[r['證券代號']] = r; });

  assert.strictEqual(byCode14.AAAA.Days_Since_New_Low_Raw, 5, '最後一天（index 34）距離上次創新低（index 29）應該是 5 天');
  assert.strictEqual(byCode14.BBBB.Days_Since_New_Low_Raw, null, 'BBBB 持續上漲，20 天視窗內從未創過新低，應該是 null，不是 0 或任意數字');
  assert.ok(byCode14.AAAA.Price_Change_20D < 0, 'AAAA 20 天前收盤 86、現在 81，20 天漲幅應該是負的');
  assert.ok(byCode14.BBBB.Price_Change_20D > 0, 'BBBB 持續上漲，20 天漲幅應該是正的');
  assert.ok(byCode14.AAAA.Inst_Net_Sum_20D > byCode14.BBBB.Inst_Net_Sum_20D, 'AAAA 每天買超 1000 > BBBB 每天買超 500，20 天累積應該更高');

  // 只有兩檔股票同一天橫斷面排名：數值大的那檔是 1.0，小的是 0.5
  // （pandas rank(pct=True) 兩筆資料的標準結果）。
  assert.strictEqual(byCode14.AAAA.Inst_Rank_20D, 1.0);
  assert.strictEqual(byCode14.BBBB.Inst_Rank_20D, 0.5);
  assert.strictEqual(byCode14.AAAA.Price_Rank_20D, 0.5);
  assert.strictEqual(byCode14.BBBB.Price_Rank_20D, 1.0);

  // BBBB 的 Days_Since_New_Low_Raw 是 null，排名要 COALESCE 成中性值 0.5，不是被排除在
  // 外當成最低分；AAAA 是唯一有值的那筆，橫斷面排名是 1.0（1/1）。
  assert.strictEqual(byCode14.AAAA.Days_Since_New_Low_Rank, 1.0);
  assert.strictEqual(byCode14.BBBB.Days_Since_New_Low_Rank, 0.5);

  // Inst_Accum_Divergence_20D = Inst_Rank_20D − Price_Rank_20D：AAAA 法人買超排名領先、
  // 漲幅排名落後 -> 正值（資金流向領先價格）；BBBB 相反 -> 負值。
  assert.ok(approxEqual(byCode14.AAAA.Inst_Accum_Divergence_20D, 0.5), byCode14.AAAA.Inst_Accum_Divergence_20D);
  assert.ok(approxEqual(byCode14.BBBB.Inst_Accum_Divergence_20D, -0.5), byCode14.BBBB.Inst_Accum_Divergence_20D);

  console.log('Test 14 (computeFactors_: Inst_Net_Sum_20D / Price_Change_20D / Days_Since_New_Low_Raw / cross-sectional ranks with null-coalesced-to-0.5 / Inst_Accum_Divergence_20D) passed.');
}

console.log('All analysis.js tests passed.');
