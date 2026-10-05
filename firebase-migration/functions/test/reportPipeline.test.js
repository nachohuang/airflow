const assert = require('assert');
const { buildReport_ } = require('../lib/reportPipeline');

function buildSyntheticHistoryForCode(code, name, days, startPrice, dailyDelta, opts) {
  opts = opts || {};
  const instMultiplier = opts.instMultiplier || 1;
  const volumeFn = opts.volumeFn || function () { return 5000000; };
  const rows = [];
  const start = new Date(2026, 0, 1);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const vol = volumeFn(i);
    rows.push({
      '日期': dateStr, '證券代號': code, '證券名稱': name,
      '外資': 50000 * instMultiplier, '投信': 100000 * instMultiplier, '自營商': 0,
      '三大法人買賣超股數': 150000 * instMultiplier,
      '成交股數': vol, '成交筆數': 10000, '成交金額': 200000000,
      '開盤價': startPrice + i * dailyDelta, '最高價': startPrice + i * dailyDelta + 0.5,
      '最低價': startPrice + i * dailyDelta - 0.5, '收盤價': startPrice + i * dailyDelta,
      '漲跌(+/-)': '+', '漲跌價差': dailyDelta,
      '最後揭示買價': startPrice + i * dailyDelta, '最後揭示買量': 100,
      '最後揭示賣價': startPrice + i * dailyDelta + 0.1, '最後揭示賣量': 100,
      '殖利率(%)': 2.0, '本益比': 15, '股價淨值比': 3, '財報年/季': '2026Q1'
    });
  }
  return rows;
}

// --- 1. 沒有任何 History 資料 -> latestDate null，diagnostics.totalStocks 是 0 ---
{
  const result = buildReport_([], [], 'rule_v17', {});
  assert.strictEqual(result.latestDate, null);
  assert.strictEqual(result.reportDocs.length, 0);
  assert.strictEqual(result.diagnostics.totalStocks, 0);
  console.log('Test 1 (no history -> empty report with diagnostics) passed.');
}

// --- 2. 無持股、量價齊揚的單一股票 -> 應該產生一筆「🚀 趨勢啟動」的 Firestore 形狀文件 ---
{
  const historyRows = buildSyntheticHistoryForCode('2330', '台積電', 40, 20, 0.3);
  const result = buildReport_(historyRows, [], 'rule_v17', {});
  assert.strictEqual(result.reportDocs.length, 1);
  const doc = result.reportDocs[0];
  assert.strictEqual(doc.id, '2330');
  assert.strictEqual(doc.code, '2330');
  assert.strictEqual(doc.name, '台積電');
  assert.strictEqual(doc.strategy, '🚀 趨勢啟動');
  assert.strictEqual(doc.action, '建議：現價買入');
  assert.ok(typeof doc.armorScore === 'number');
  assert.strictEqual(doc.date, result.latestDate);
  assert.strictEqual(doc.predictedReturn1m, null, '沒有套用因子模型，預測分數該是 null');
  assert.strictEqual(doc.predictedDownsideResistance, null);
  console.log('Test 2 (single breakout stock -> one Firestore-shaped report doc) passed.');
}

// --- 3. 持股且觸發止損 -> 一定出現在報告裡（不受流動性/趨勢門檻限制），策略是止盈/止損 ---
{
  const historyRows = buildSyntheticHistoryForCode('2330', '台積電', 40, 20, 0.3);
  historyRows[historyRows.length - 1]['收盤價'] = 20 + 38 * 0.3 * 0.9; // 模擬從高點大幅拉回
  const lotDocs = [{ code: '2330', status: 'holding', buyPrice: 10, shares: 1000, buyDate: historyRows[0]['日期'] }];
  const result = buildReport_(historyRows, lotDocs, 'rule_v17', {});
  assert.strictEqual(result.reportDocs.length, 1);
  assert.strictEqual(result.reportDocs[0].strategy, '🛑 止盈/止損');
  assert.strictEqual(result.diagnostics.holdingCount, 1);
  console.log('Test 3 (holding with trailing stop triggered) passed.');
}

// --- 4. 流動性不足的股票 -> Neutral，不該出現在 reportDocs 裡 ---
{
  const historyRows = buildSyntheticHistoryForCode('9999', '冷門股', 40, 20, 0.3)
    .map(function (r) { return Object.assign({}, r, { '成交金額': 1000000 }); }); // 低於 LIQUIDITY_MIN
  const result = buildReport_(historyRows, [], 'rule_v17', {});
  assert.strictEqual(result.reportDocs.length, 0, '流動性不足應該被篩掉，不出現在報告裡');
  assert.strictEqual(result.diagnostics.totalStocks, 1, '但 diagnostics 仍要掃描到這檔股票');
  console.log('Test 4 (low liquidity stock filtered out, still counted in diagnostics) passed.');
}

// --- 5. 多股票：持股 + 訊號股 + 被篩掉的股票混在一起，報告依 armorScore 排序 ---
{
  const rowsHolding = buildSyntheticHistoryForCode('1101', '持股股', 40, 50, 0.1); // 緩漲，不會觸發止損
  // 2330 除了股價強力上漲，法人參與度（investor net x5）跟最近 5 天成交量（3 倍放量）都刻意
  // 做得比其他兩檔高，這樣橫斷面排名（Inst_Part_Rank／Vol_Ratio_Rank）才會真的把它排到最前面，
  // 不會因為三檔股票的法人/成交量輸入值一樣而全部打成平手排名 0.5、永遠觸發不了規則式門檻。
  const rowsBreakout = buildSyntheticHistoryForCode('2330', '台積電', 40, 20, 0.3, {
    instMultiplier: 5,
    volumeFn: function (i) { return i < 35 ? 5000000 : 15000000; }
  });
  const rowsFlat = buildSyntheticHistoryForCode('9999', '盤整股', 40, 30, 0); // 完全平盤，Trend_Score 不會是 2
  const historyRows = rowsHolding.concat(rowsBreakout).concat(rowsFlat);
  const lotDocs = [{ code: '1101', status: 'holding', buyPrice: 45, shares: 1000, buyDate: rowsHolding[0]['日期'] }];
  const result = buildReport_(historyRows, lotDocs, 'rule_v17', {});

  const codes = result.reportDocs.map(function (d) { return d.code; });
  assert.ok(codes.indexOf('1101') !== -1, '持股一定要出現（續抱或止損）');
  assert.ok(codes.indexOf('2330') !== -1, '強力上漲的非持股股票應該出現訊號');
  assert.ok(codes.indexOf('9999') === -1, '完全平盤的非持股股票應該是 Neutral，不出現');

  for (let i = 1; i < result.reportDocs.length; i++) {
    assert.ok((result.reportDocs[i - 1].armorScore || 0) >= (result.reportDocs[i].armorScore || 0), '報告要依 armorScore 由高到低排序');
  }
  console.log('Test 5 (multi-stock report, sorted by armorScore) passed.');
}

// --- 6. factor_model_rank 策略但沒有套用中的模型 -> strategyError，reportDocs 是空的 ---
{
  const historyRows = buildSyntheticHistoryForCode('2330', '台積電', 40, 20, 0.3);
  const result = buildReport_(historyRows, [], 'factor_model_rank', {});
  assert.strictEqual(result.reportDocs.length, 0);
  assert.ok(result.strategyError, '沒有套用中的模型時應該附上 strategyError 說明原因');
  console.log('Test 6 (factor_model_rank without applied model -> strategyError) passed.');
}

// --- 7. factor_model_rank 策略，有套用中的模型（跟 Firestore factor_model_history
//    遷移完成後 index.js 的 fetchAppliedFactorModels_ 組出來的形狀一致）-> 橫斷面
//    排名最高的股票要出現在報告裡，且預測分數欄位要有值，不是 null ---
{
  const flatA = buildSyntheticHistoryForCode('1101', '盤整A', 40, 50, 0); // Trend_Score 應為 0
  const flatB = buildSyntheticHistoryForCode('1102', '盤整B', 40, 30, 0); // Trend_Score 應為 0
  const rising = buildSyntheticHistoryForCode('2330', '台積電', 40, 20, 0.3); // Trend_Score 應為 2，橫斷面排名最高
  const historyRows = flatA.concat(flatB).concat(rising);
  // weights 的 key 是 BigQuery 欄位名稱（'trend_score'），對應 lib/config.js
  // BQ_FEATURE_TO_ANALYSIS_FIELD 的 'Trend_Score'，跟 index.js
  // fetchAppliedFactorModels_() 從 Firestore factor_model_history 讀出來的
  // weights 形狀一致。
  const appliedFactorModels = { downsideResistance: { weights: { trend_score: 1 } } };
  const result = buildReport_(historyRows, [], 'factor_model_rank', appliedFactorModels);

  assert.ok(!result.strategyError, '有套用中的模型時不該有 strategyError');
  const codes = result.reportDocs.map(function (d) { return d.code; });
  assert.ok(codes.indexOf('2330') !== -1, '橫斷面排名最高（Trend_Score=2，唯一最大值）的股票應該觸發 factor_model_rank 訊號');
  assert.ok(codes.indexOf('1101') === -1 && codes.indexOf('1102') === -1, '排名不夠高的兩檔盤整股不該出現');

  const doc = result.reportDocs.find(function (d) { return d.code === '2330'; });
  assert.strictEqual(doc.predictedDownsideResistance, 2, '權重 {trend_score:1} 時，預測分數應該等於 Trend_Score 本身');
  assert.strictEqual(doc.predictedReturn1m, null, '只套用了 downsideResistance，predictedReturn1m 應該仍是 null');
  console.log('Test 7 (factor_model_rank with an applied model -> top-ranked stock gets a signal with predicted scores) passed.');
}

console.log('All reportPipeline.js tests passed.');
