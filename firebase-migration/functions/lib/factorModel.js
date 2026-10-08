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

/**
 * row：computeFactors_ 算完的一列；weights：{bqFeatureName: weight}（來自套用中的
 * 因子迴歸模型）。任何一個「權重不是 0」的因子在這一列裡的值是 null/NaN，整個分數
 * 直接回傳 null——不能只跳過那一項繼續加總，那樣等於悄悄把缺漏的因子當成 0 貢獻，
 * 會讓分數看起來比實際情況更可信。
 *
 * 2026-10-08 修正：原本不管權重是多少，只要值是 null 就整個回傳 null（從
 * apps-script/src/FactorRegression.gs 原樣複製，apps-script 版候選因子清單裡
 * 從來沒有哪個因子覆蓋率近乎 0，這個邊界情況從沒真的發生過）。今天新加的 10 個
 * `fundamental_*` 財報因子目前覆蓋率近乎 0，LASSO 訓練出來的權重幾乎必然是精確的
 * 0（零變異的欄位在迴歸裡沒有係數可言）——但 `ML.WEIGHTS` 會把權重是 0 的因子也
 * 列進結果，`weights` 物件裡還是有這些 key，於是迴圈跑到這幾個 key 時，`row` 上
 * 對應欄位是 null（沒有 as-of 財報資料可查），不管權重是不是 0 都直接整個回傳
 * null——使用者實測遇到的「因子模型排名精選／混合策略在整個回測區間完全沒有任何
 * 訊號」就是這個原因：幾乎每一列都因為這幾個新因子是 null 被整個否決掉，不是因為
 * 模型本身真的判斷每一檔股票都不該進場。
 *
 * 權重剛好是 0 時，這個因子不管真實值是多少（包括缺值）對加總的貢獻本來就一定是
 * 0——「跳過它」跟「它值的多少改變最終結果」在這個情況下是同一件事，不是上面那段
 * 「悄悄假設缺值貢獻為 0」的風險（那段風險的前提是權重不是 0，缺值被當成 0 貢獻
 * 才會把分數算得比實際情況更可信；權重真的是 0 時，就算有真實值，貢獻也還是
 * 0，沒有「被低估」的問題）。所以只在 `weights[bqName] === 0` 時才跳過 null 檢查，
 * 其他權重不是 0 的因子維持原本「缺值就整個否決」的保守邏輯不變。
 */
function computeWeightedFactorScore_(row, weights) {
  if (!weights) return null;
  var sum = 0;
  var keys = Object.keys(weights);
  for (var i = 0; i < keys.length; i++) {
    var bqName = keys[i];
    var analysisField = config.BQ_FEATURE_TO_ANALYSIS_FIELD[bqName];
    if (!analysisField) continue; // 理論上不會發生（權重欄位都來自候選因子清單），保守跳過
    var w = weights[bqName];
    if (w === 0) continue; // 權重是 0，這個因子不管缺不缺值對加總都沒有影響
    var v = row[analysisField];
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return null;
    sum += w * v;
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
