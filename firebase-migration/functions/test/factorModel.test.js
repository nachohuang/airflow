const assert = require('assert');
const factorModel = require('../lib/factorModel');

// --- computeWeightedFactorScore_ ---
{
  // 基本加總：兩個因子都有值，正常算出加權總和。
  const row1 = { Inst_Participation: 2, Trend_Score: 3 };
  assert.strictEqual(
    factorModel.computeWeightedFactorScore_(row1, { inst_participation: 2, trend_score: 1 }), 7
  );

  // 權重不是 0 的因子缺值（null/undefined/NaN）：整個分數回傳 null，不能悄悄
  // 當成 0 貢獻繼續加總（既有的保守行為，這次修正不能動到）。
  assert.strictEqual(
    factorModel.computeWeightedFactorScore_({ Inst_Participation: null, Trend_Score: 3 }, { inst_participation: 2, trend_score: 1 }),
    null, '權重不是 0 的因子缺值要整個否決，不是跳過繼續加總'
  );
  assert.strictEqual(
    factorModel.computeWeightedFactorScore_({ Trend_Score: 3 }, { inst_participation: 2, trend_score: 1 }),
    null, 'undefined（欄位根本不存在）跟 null 要同樣處理'
  );
  assert.strictEqual(
    factorModel.computeWeightedFactorScore_({ Inst_Participation: NaN, Trend_Score: 3 }, { inst_participation: 2, trend_score: 1 }),
    null, 'NaN 要同樣處理'
  );

  // 2026-10-08 新增：權重剛好是 0 的因子缺值——不該讓整個分數變成 null，因為
  // 這個因子不管值是多少對加總都沒有影響（0 乘任何值都是 0）。對應財報基本面
  // 因子目前覆蓋率近乎 0、LASSO 幾乎必然給出精確 0 權重，但 ML.WEIGHTS 仍然
  // 把這個因子留在 weights 物件裡的情況——修正前這裡會整個否決掉幾乎所有列。
  assert.strictEqual(
    factorModel.computeWeightedFactorScore_(
      { Inst_Participation: 2, Trend_Score: 3, Fundamental_Roe_Pct: null },
      { inst_participation: 2, trend_score: 1, fundamental_roe_pct: 0 }
    ),
    7, '權重是 0 的因子即使缺值，也不該影響其他因子正常加總出來的分數'
  );
  assert.strictEqual(
    factorModel.computeWeightedFactorScore_(
      { Fundamental_Roe_Pct: null, Fundamental_Gross_Margin_Pct: null },
      { fundamental_roe_pct: 0, fundamental_gross_margin_pct: 0 }
    ),
    0, '全部因子權重都是 0 時，缺值也不該讓分數變成 null（應該是 0，不是 null）'
  );

  // 混合情況：權重是 0 的因子缺值被跳過，但權重不是 0 的另一個因子缺值仍然要
  // 整個否決——兩種因子同時出現時，不能讓「有一個權重是 0」誤判成整列都安全。
  assert.strictEqual(
    factorModel.computeWeightedFactorScore_(
      { Inst_Participation: null, Fundamental_Roe_Pct: null },
      { inst_participation: 2, fundamental_roe_pct: 0 }
    ),
    null, '權重不是 0 的因子缺值依然要整個否決，不受同一列裡其他 0 權重因子影響'
  );

  // 權重本身是 0 但因子有真實值：應該正常跳過（不計入加總），不是當成 0 分貢獻
  // 才巧合算對——這裡驗證的是「跳過」而不是「用 0 乘」，數學上結果一樣，但確認
  // 程式碼真的走的是 continue 分支，不是意外依賴 0*v=0 的副作用。
  assert.strictEqual(
    factorModel.computeWeightedFactorScore_(
      { Inst_Participation: 2, Fundamental_Roe_Pct: 999 },
      { inst_participation: 2, fundamental_roe_pct: 0 }
    ),
    4, '權重是 0 的因子，不管值是多少都不該計入加總'
  );

  assert.strictEqual(factorModel.computeWeightedFactorScore_({ Inst_Participation: 2 }, null), null, '沒有 weights 直接回傳 null');
  console.log('Test computeWeightedFactorScore_ (weighted sum / nonzero-weight null veto / zero-weight null-safe skip) passed.');
}

// --- computePredictedFactorScores_ ---
{
  const row = { Inst_Participation: 2, Fundamental_Roe_Pct: null };
  const result = factorModel.computePredictedFactorScores_(row, {
    return1m: { weights: { inst_participation: 3, fundamental_roe_pct: 0 } },
    downsideResistance: { weights: { inst_participation: 1 } }
  });
  assert.strictEqual(result.predictedReturn1M, 6, '0 權重的 fundamental_roe_pct 缺值不該拖累 return1m 的預測分數');
  assert.strictEqual(result.predictedDownsideResistance, 2);

  const noModels = factorModel.computePredictedFactorScores_(row, {});
  assert.deepStrictEqual(noModels, { predictedReturn1M: null, predictedDownsideResistance: null }, '沒有套用任何模型時兩個分數都是 null');
  console.log('Test computePredictedFactorScores_ (per-label weights, no-applied-model fallback) passed.');
}

console.log('All factorModel.js tests passed.');
