/**
 * factorModel.js
 * 因子模型預測分數計算，從 apps-script/src/FactorRegression.gs 複製過來
 * （只複製兩支純函式，不含實際呼叫 BigQuery 訓練模型、寫入
 * FactorModelHistory 分頁的那些 I/O 邏輯——那段屬於「因子迴歸模型」功能本身
 * 的遷移範圍，跟戰報計算不是同一件事，這裡只需要「給一列已經算好因子的資料 +
 * 一組套用中的權重，算出預測分數」這個最終消費端用得到的計算）。
 *
 * 複製時機：2026-10-05，對照 apps-script/src/FactorRegression.gs 當時的
 * 內容。
 */
var config = require('./config');

/** row：computeFactors_ 算完的一列；weights：{bqFeatureName: weight}（來自套用中的
 *  因子迴歸模型）。任何一個因子在這一列裡的值是 null/NaN，整個分數直接回傳 null——
 *  不能只跳過那一項繼續加總，那樣等於悄悄把缺漏的因子當成 0 貢獻，會讓分數看起來
 *  比實際情況更可信。 */
function computeWeightedFactorScore_(row, weights) {
  if (!weights) return null;
  var sum = 0;
  var keys = Object.keys(weights);
  for (var i = 0; i < keys.length; i++) {
    var bqName = keys[i];
    var analysisField = config.BQ_FEATURE_TO_ANALYSIS_FIELD[bqName];
    if (!analysisField) continue; // 理論上不會發生（權重欄位都來自候選因子清單），保守跳過
    var v = row[analysisField];
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return null;
    sum += weights[bqName] * v;
  }
  return sum;
}

/**
 * 對一列資料算出兩個目標各自的「因子模型預測分數」（用目前套用中的權重，沒有套用中的
 * 版本就是 null）。appliedModels：{return1m: {weights,...}, downsideResistance: {weights,...}}，
 * 沒有套用任何模型時傳 {} 即可（rule_v17 這個預設策略完全不需要這個）。
 */
function computePredictedFactorScores_(row, appliedModels) {
  var applied = appliedModels || {};
  return {
    predictedReturn1M: applied.return1m ? computeWeightedFactorScore_(row, applied.return1m.weights) : null,
    predictedDownsideResistance: applied.downsideResistance ? computeWeightedFactorScore_(row, applied.downsideResistance.weights) : null
  };
}

module.exports = {
  computeWeightedFactorScore_: computeWeightedFactorScore_,
  computePredictedFactorScores_: computePredictedFactorScores_
};
