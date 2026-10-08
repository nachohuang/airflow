/**
 * 「複製當下對不對得起來」的一次性比對：用跟 apps-script/test/analysis.test.js 一樣的
 * vm 技巧，把 apps-script/src/Config.gs + Utils.gs + FactorRegression.gs + Analysis.gs
 * 這幾份「正本」（還在跑的 Apps Script 系統）讀進 Node 的 vm context，拿同一批輸入分別
 * 餵給 vm 裡的原始函式跟 lib/analysis.js 這份新正本，斷言兩邊算出來的數字完全一致。
 *
 * 這支測試只在「複製的那一刻」有意義——apps-script/src/ 跟 firebase-migration/functions/
 * 從今天（2026-10-05）起是兩份獨立維護的程式碼，之後如果只改其中一邊、沒有理由讓另一邊
 * 的數字繼續對得起來，所以這支測試不是「兩邊永遠要一致」的迴歸測試，是留著證明「這次複製
 * 沒有抄錯」的歷史記錄；日常的迴歸測試看 test/analysis.test.js 就好。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const lib = require('../lib/analysis');
const libUtils = require('../lib/utils');
const factorRegressionLib = require('../lib/factorRegression');
const configLib = require('../lib/config');

const appsScriptSrc = path.join(__dirname, '..', '..', '..', 'apps-script', 'src');
const context = { console: console, module: undefined };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(appsScriptSrc, relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('FactorRegression.gs');
loadIntoContext('Analysis.gs');

function approxEqual(a, b, eps) {
  eps = eps || 1e-9;
  if (a === null || b === null) return a === b;
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
      '日期': dateStr, '證券代號': '2330', '證券名稱': '台積電',
      '外資': 50000, '投信': 100000, '自營商': 0, '三大法人買賣超股數': 150000,
      '成交股數': 5000000, '成交筆數': 10000, '成交金額': 100000000,
      '開盤價': 20 + i * 0.3, '最高價': 20 + i * 0.3 + 0.5, '最低價': 20 + i * 0.3 - 0.5, '收盤價': 20 + i * 0.3,
      '漲跌(+/-)': '+', '漲跌價差': 0.3,
      '最後揭示買價': 20 + i * 0.3, '最後揭示買量': 100, '最後揭示賣價': 20 + i * 0.3 + 0.1, '最後揭示賣量': 100,
      '殖利率(%)': 2.0, '本益比': 15, '股價淨值比': 3, '財報年/季': '2026Q1'
    });
  }
  return rows;
}

function assertRowsMatch(originalRows, portedRows, fields, label) {
  assert.strictEqual(originalRows.length, portedRows.length, label + '：列數不一致');
  for (let i = 0; i < originalRows.length; i++) {
    fields.forEach(function (f) {
      const a = originalRows[i][f];
      const b = portedRows[i][f];
      if (typeof a === 'number' && typeof b === 'number') {
        assert.ok(approxEqual(a, b), label + ' row ' + i + ' field ' + f + ' 不一致：原始 ' + a + ' vs 新版 ' + b);
      } else {
        assert.strictEqual(a, b, label + ' row ' + i + ' field ' + f + ' 不一致：原始 ' + JSON.stringify(a) + ' vs 新版 ' + JSON.stringify(b));
      }
    });
  }
}

const FACTOR_FIELDS = [
  'Inst_Net', 'Inst_Participation', 'Inst_Part_MA5', 'IBF_20D', 'Trend_Score',
  'Vol_MA20', 'Vol_Ratio', 'MA20', 'MA20_Slope', 'MA60', 'BIAS_60', 'Adjusted_Peak',
  'Daily_Return', 'Is_Drop', 'Is_Inst_Buy_On_Drop', 'Inst_Part_Rank', 'IBF_20D_Rank',
  'Vol_Ratio_Rank', 'Armor_Score'
];

// --- 1. computeFactors_：40 天穩定上漲的單一股票，逐欄位比對 ---
{
  const rowsA = buildSyntheticHistory(40);
  const rowsB = buildSyntheticHistory(40);
  const computedOriginal = context.sortRows(context.computeFactors_(rowsA, {}), [[function (r) { return r['日期']; }, 'asc']]);
  const computedPorted = libUtils.sortRows(lib.computeFactors_(rowsB, {}), [[function (r) { return r['日期']; }, 'asc']]);
  assertRowsMatch(computedOriginal, computedPorted, FACTOR_FIELDS, 'computeFactors_ (40d uptrend)');
  console.log('Parity 1 (computeFactors_, 40d uptrend) passed.');
}

// --- 2. computeFactors_：多股票刁鑽情境（零成交量、剛上市、橫斷面排名）---
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
  function buildCombined() {
    return []
      .concat(buildStockRows('2330', 0, 70, -1))
      .concat(buildStockRows('2603', 0, 70, 65))
      .concat(buildStockRows('1101', 55, 15, -1));
  }

  const computedOriginal = context.sortRows(
    context.computeFactors_(buildCombined(), {}),
    [['證券代號', 'asc'], [function (r) { return r['日期']; }, 'asc']]
  );
  const computedPorted = libUtils.sortRows(
    lib.computeFactors_(buildCombined(), {}),
    [['證券代號', 'asc'], [function (r) { return r['日期']; }, 'asc']]
  );
  assertRowsMatch(computedOriginal, computedPorted, FACTOR_FIELDS, 'computeFactors_ (multi-stock edge cases)');
  console.log('Parity 2 (computeFactors_, multi-stock edge cases) passed.');
}

// --- 3. diagnoseRow_／classifyEntrySignal_：持股止盈止損、持股守護、三種篩選策略 ---
{
  const rows = buildSyntheticHistory(40);
  const portfolioMap = { '2330': { cost: 15, buyDate: rows[0]['日期'] } };
  const computedOriginal = context.sortRows(context.computeFactors_(rows.map(function (r) { return Object.assign({}, r); }), portfolioMap), [[function (r) { return r['日期']; }, 'asc']]);
  const computedPorted = libUtils.sortRows(lib.computeFactors_(rows.map(function (r) { return Object.assign({}, r); }), portfolioMap), [[function (r) { return r['日期']; }, 'asc']]);
  const lastOriginal = computedOriginal[computedOriginal.length - 1];
  const lastPorted = computedPorted[computedPorted.length - 1];

  const diagOriginal = context.diagnoseRow_(lastOriginal, portfolioMap);
  const diagPorted = lib.diagnoseRow_(lastPorted, portfolioMap);
  assert.strictEqual(diagOriginal.strategy, diagPorted.strategy);
  assert.strictEqual(diagOriginal.action, diagPorted.action);
  assert.strictEqual(diagOriginal.interpretation, diagPorted.interpretation);

  const strategyScenarios = [
    { '成交金額': 200000000, Trend_Score: 2, Inst_Part_Rank: 0.9, Vol_Ratio_Rank: 0.9, IBF_20D_Rank: 0.9 },
    { '成交金額': 1000000, Trend_Score: 2, Inst_Part_Rank: 0.9, Vol_Ratio_Rank: 0.9, IBF_20D_Rank: 0.9 },
    { '成交金額': 200000000, Trend_Score: 2, Inst_Part_Rank: 0.5, Vol_Ratio_Rank: 0.5, IBF_20D_Rank: 0.9 },
    { '成交金額': 200000000, Trend_Score: 0, Inst_Part_Rank: 0.1, Vol_Ratio_Rank: 0.1, IBF_20D_Rank: 0.1, PredictedResistance_Rank: 0.95 }
  ];
  ['rule_v17', 'factor_model_rank', 'hybrid'].forEach(function (strategyKey) {
    strategyScenarios.forEach(function (row, idx) {
      const a = context.classifyEntrySignal_(row, strategyKey);
      const b = lib.classifyEntrySignal_(row, strategyKey);
      assert.strictEqual(a.strategy, b.strategy, strategyKey + ' scenario ' + idx + ' strategy 不一致');
      assert.strictEqual(a.action, b.action, strategyKey + ' scenario ' + idx + ' action 不一致');
      assert.strictEqual(a.interpretation, b.interpretation, strategyKey + ' scenario ' + idx + ' interpretation 不一致');
    });
  });
  console.log('Parity 3 (diagnoseRow_ / classifyEntrySignal_) passed.');
}

// --- 4. computePredictedResistanceRanks_：套用中的抗跌力模型 ---
{
  const rowsOriginal = [
    { '日期': '2026-07-30', '證券代號': 'A', Inst_Participation: 0.1 },
    { '日期': '2026-07-30', '證券代號': 'B', Inst_Participation: 0.5 },
    { '日期': '2026-07-30', '證券代號': 'C', Inst_Participation: 0.9 }
  ];
  const rowsPorted = rowsOriginal.map(function (r) { return Object.assign({}, r); });
  const applied = { downsideResistance: { weights: { inst_participation: 1 } } };
  context.computePredictedResistanceRanks_(rowsOriginal, applied);
  lib.computePredictedResistanceRanks_(rowsPorted, applied);
  for (let i = 0; i < rowsOriginal.length; i++) {
    assert.ok(approxEqual(rowsOriginal[i].PredictedDownsideResistance, rowsPorted[i].PredictedDownsideResistance));
    assert.ok(approxEqual(rowsOriginal[i].PredictedResistance_Rank, rowsPorted[i].PredictedResistance_Rank));
  }
  console.log('Parity 4 (computePredictedResistanceRanks_) passed.');
}

// --- 5. computeScreeningStats_ / screeningFunnelStages_ / computeLookbackStartStr_ ---
{
  const scanRows = [
    { '證券代號': '1101', '成交金額': 200000000, Trend_Score: 2, Inst_Part_Rank: null, Vol_Ratio_Rank: 0.9, IBF_20D_Rank: 0.8 },
    { '證券代號': '1102', '成交金額': 200000000, Trend_Score: 2, Inst_Part_Rank: 0.9, Vol_Ratio_Rank: null, IBF_20D_Rank: 0.8 },
    { '證券代號': '1103', '成交金額': 200000000, Trend_Score: 0, Inst_Part_Rank: 0.9, Vol_Ratio_Rank: 0.9, IBF_20D_Rank: null }
  ];
  const portfolioMap = { '1103': { cost: 10 } };
  // JSON 字串比較，不用 assert.deepStrictEqual：vm context 裡建出來的物件跟這個 Node
  // realm 的物件雖然內容一樣，prototype 來自不同 realm，deepStrictEqual 連 prototype
  // 也會比，會誤判成不相等（跟原本 apps-script/test/analysis.test.js 對 Date 物件
  // instanceof 跨 realm 失真的說明是同一類假象，不是數字或邏輯真的不一致）。
  const statsOriginal = context.computeScreeningStats_(scanRows, portfolioMap, '2026-07-30');
  const statsPorted = lib.computeScreeningStats_(scanRows, portfolioMap, '2026-07-30');
  assert.strictEqual(JSON.stringify(statsOriginal), JSON.stringify(statsPorted));

  const stagesOriginal = context.screeningFunnelStages_(statsOriginal);
  const stagesPorted = lib.screeningFunnelStages_(statsPorted);
  assert.strictEqual(JSON.stringify(stagesOriginal), JSON.stringify(stagesPorted));

  const lookbackOriginal = context.computeLookbackStartStr_('2026-07-31');
  const lookbackPorted = lib.computeLookbackStartStr_('2026-07-31');
  assert.strictEqual(lookbackOriginal, lookbackPorted);
  console.log('Parity 5 (computeScreeningStats_ / screeningFunnelStages_ / computeLookbackStartStr_) passed.');
}

// --- 6. FactorRegression.gs -> lib/factorRegression.js：逐一比對每個純函式
//    （SQL 組字串字串完全相等 + 權重整理邏輯），這是這批函式裡風險最高的一支
//    ——buildFeatureViewSql_ 組出來的是一大段多層 CTE 的 BigQuery SQL，純靠
//    人工比對很容易漏改一兩行，字串完全相等是最直接的保證。 ---
{
  const rawTableRef = 'proj.ds.history_raw';
  const industryMapTableRef = 'proj.ds.industry_map';
  const viewRef = 'proj.ds.factor_features';
  assert.strictEqual(
    context.buildFeatureViewSql_(rawTableRef, industryMapTableRef, viewRef),
    factorRegressionLib.buildFeatureViewSql_(rawTableRef, industryMapTableRef, viewRef),
    'buildFeatureViewSql_ 組出來的 SQL 字串要完全相等'
  );

  assert.strictEqual(context.factorModelName_('return1m'), factorRegressionLib.factorModelName_('return1m'));

  const snapshotRef = 'proj.ds.factor_features_snapshot';
  assert.strictEqual(
    context.buildFeatureSnapshotSql_(viewRef, snapshotRef),
    factorRegressionLib.buildFeatureSnapshotSql_(viewRef, snapshotRef)
  );

  // 候選因子清單本身兩邊是否一致——apps-script 原版是 48 個（10 基礎+2
  // 動能時機+24 產業資金流向+12 產業相對大盤強度），Firebase 版
  // 2026-10-08 之後額外 push 了 10 個「四率四升」基本面候選因子（見
  // config.js FUNDAMENTAL_CANDIDATE_COLUMNS 的說明，apps-script 版沒有
  // 對應邏輯，這是全新因子，不是照搬），所以只比對前 48 個（跟原版同一
  // 個順序/內容），後面額外的 10 個另外單獨斷言。JSON 字串比較（不用
  // deepStrictEqual）——跟上面 Parity 5 同一個理由：vm context 建出來的
  // 陣列 prototype 來自不同 realm，deepStrictEqual 連 prototype 也比，
  // 內容明明一樣也會誤判不相等。
  const portedCandidateColumns = configLib.FACTOR_CANDIDATE_COLUMNS.slice(0, 48);
  assert.strictEqual(
    JSON.stringify(context.CONFIG.FACTOR_CANDIDATE_COLUMNS), JSON.stringify(portedCandidateColumns),
    '照搬自 apps-script 的前 48 個候選因子兩邊要完全一致（含順序）'
  );
  assert.strictEqual(
    JSON.stringify(configLib.FACTOR_CANDIDATE_COLUMNS.slice(48)), JSON.stringify(configLib.FUNDAMENTAL_CANDIDATE_COLUMNS),
    '第 49 個之後要剛好是 FUNDAMENTAL_CANDIDATE_COLUMNS（全新因子，apps-script 沒有對應內容可比對）'
  );

  const modelRef = 'proj.ds.factor_model_return1m';
  assert.strictEqual(
    context.buildTrainModelSql_(modelRef, snapshotRef, 'label_return_1m', context.CONFIG.FACTOR_CANDIDATE_COLUMNS, 0.05),
    factorRegressionLib.buildTrainModelSql_(modelRef, snapshotRef, 'label_return_1m', portedCandidateColumns, 0.05)
  );

  assert.strictEqual(context.buildEvaluateSql_(modelRef), factorRegressionLib.buildEvaluateSql_(modelRef));
  assert.strictEqual(context.buildWeightsSql_(modelRef), factorRegressionLib.buildWeightsSql_(modelRef));

  const weightRows = [
    { processed_input: 'inst_participation', weight: '0.42' },
    { processed_input: '__INTERCEPT__', weight: '1.1' },
    { processed_input: 'trend_score', weight: '-0.05' }
  ];
  assert.strictEqual(
    JSON.stringify(context.summarizeWeights_(weightRows)), JSON.stringify(factorRegressionLib.summarizeWeights_(weightRows))
  );

  const weights = { a: 0.1, b: -0.9, c: 0.5, d: -0.05 };
  assert.strictEqual(
    JSON.stringify(context.topWeightedFeatures_(weights, 2)), JSON.stringify(factorRegressionLib.topWeightedFeatures_(weights, 2))
  );

  const statsViewRef = 'proj.ds.factor_features';
  assert.strictEqual(
    context.buildIndustryCapitalFlowStatsSql_(statsViewRef, 'industry_flow_all_5d'),
    factorRegressionLib.buildIndustryCapitalFlowStatsSql_(statsViewRef, 'industry_flow_all_5d')
  );

  console.log('Parity 6 (FactorRegression.gs -> lib/factorRegression.js, every pure function byte-for-byte) passed.');
}

console.log('All parity checks passed — lib/analysis.js matches apps-script/src/Analysis.gs at copy time (2026-10-05).');
