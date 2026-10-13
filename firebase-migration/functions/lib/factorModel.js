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
 * 0，沒有「被低估」的問題）。
 *
 * 2026-10-08 再修正：原本只在 `weights[bqName] === 0`（精確等於 0）時才跳過 null
 * 檢查，但使用者實測套用新模型後，`factor_model_rank`／`hybrid` 還是整個回測區間
 * 零訊號——這份訓練用的是 `optimize_strategy='BATCH_GRADIENT_DESCENT'`
 * （見 `lib/factorRegression.js buildTrainModelSql_` 的說明），不是封閉解的座標
 * 下降法，L1 正規化把「零資訊」因子的係數壓到極小但不精確等於 0 的浮點數（例如
 * `0.0000003`）是預期中的常見結果，不是異常——`=== 0` 這個精確比較幾乎抓不到這種
 * 情況，於是跟修正前一樣，這幾個覆蓋率近乎 0 的新因子的 null 值還是會把整個分數
 * 否決掉。改成「權重的絕對值小於 `NEGLIGIBLE_WEIGHT_EPSILON_`」就跳過 null
 * 檢查——其他因子（`bias60`／`inst_part_ma5` 等）經確認權重量級明顯大於這個門檻
 * （R² 看得出模型確實從這些因子學到了一些訊號，不會是跟雜訊同一個量級），不會被
 * 誤判成「可忽略」而被不小心放寬了保守的 null 否決邏輯。
 *
 * 2026-10-13 再修正：使用者套用了一版候選因子正確收斂到 20 個的新模型
 * （見 `config.LIVE_SCORED_FACTOR_CANDIDATE_COLUMNS` 的說明），
 * `factor_model_rank`／`hybrid` 還是整個回測區間零訊號——這次用 Cloud
 * Shell 查實際權重才發現是另一個獨立的根因：這次兩個 label 都給了
 * `fundamental_revenue_growth_streak` 不可忽略的權重（downsideResistance
 * -0.000107、return1m 0.00152，都大於 `NEGLIGIBLE_WEIGHT_EPSILON_`），
 * 但 `lib/bigquery.js buildFundamentalFeatureViewSql_`（訓練用）把這 10
 * 個 `fundamental_*` 因子查無資料時一律 `COALESCE(..., 0)`，`computeFactors_`
 * （即時/回測計算，見該函式 `financialsIndex` 參數的說明）查無資料時卻是
 * 留著真正的 `null`——這兩邊對「查無財報資料」的解讀不一致：模型是在
 * 「缺值＝0」的世界裡訓練出來的，但套用時卻被「缺值＝完全不能用，整個
 * 否決」的規則擋住。只要這 10 個因子裡任何一個被訓練分到不可忽略的權重
 * （不保證每次都是 `fundamental_revenue_growth_streak`，覆蓋率最差的那個
 * 剛好最常被選到，但原則上可能是任何一個），而這批因子的覆蓋率普遍偏
 * 低，就會導致幾乎每一列都被否決——不是訓練候選因子範圍或 epsilon
 * 門檻的問題，是這 10 個因子的「缺值該怎麼解讀」在訓練跟套用兩端沒有
 * 對齊。
 *
 * 修正：這 10 個 `fundamental_*` 因子（`config.FUNDAMENTAL_CANDIDATE_COLUMNS`）
 * 缺值時當成 `0`（跟訓練時的 `COALESCE(...,0)` 一致），不觸發整個分數
 * 否決；其他（基礎技術面）因子維持原本的否決邏輯不變——那批因子訓練時
 * 從來沒有被 0-imputation 過（`buildTrainModelSql_` 的 NOT NULL 篩選只
 * 排除了基本面因子，基礎因子缺值的列整個被排除在訓練資料外，不是補
 * 0），所以「缺值就否決」對它們仍然是正確、該維持的保守假設。這個改動
 * 只影響「基本面因子缺值時的解讀」，不影響上面兩段關於權重大小的判斷
 * （`computeFactors_` 算出來的 `Fundamental_*` 欄位本身仍然維持 `null`
 * 不變，因子檢視器這類顯示用途還是能正確分辨「真的是 0」跟「查無資料」
 * ——只有這支函式內部算加權分數時才把 null 當成 0）。
 */
var NEGLIGIBLE_WEIGHT_EPSILON_ = 1e-6;
var FUNDAMENTAL_BQ_NAMES_ = {};
config.FUNDAMENTAL_CANDIDATE_COLUMNS.forEach(function (c) { FUNDAMENTAL_BQ_NAMES_[c] = true; });

function computeWeightedFactorScore_(row, weights) {
  if (!weights) return null;
  var sum = 0;
  var keys = Object.keys(weights);
  for (var i = 0; i < keys.length; i++) {
    var bqName = keys[i];
    var analysisField = config.BQ_FEATURE_TO_ANALYSIS_FIELD[bqName];
    if (!analysisField) continue; // 理論上不會發生（權重欄位都來自候選因子清單），保守跳過
    var w = weights[bqName];
    // isNaN(w) 也視為可忽略一起跳過（NaN 權重不管乘上什麼值都只會污染 sum 變成
    // NaN，跟「這個因子沒有可用資訊」是同一個結論，不是另一種需要否決整個分數的
    // 情況）；`Math.abs(NaN) < epsilon` 恆為 false，不能只靠下面這個比較涵蓋到。
    if (isNaN(w) || Math.abs(w) < NEGLIGIBLE_WEIGHT_EPSILON_) continue; // 權重可忽略，這個因子不管缺不缺值對加總都沒有實質影響
    var v = row[analysisField];
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) {
      if (FUNDAMENTAL_BQ_NAMES_[bqName]) {
        v = 0; // 跟訓練時 buildFundamentalFeatureViewSql_ 的 COALESCE(...,0) 一致，不否決整個分數
      } else {
        return null;
      }
    }
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
  NEGLIGIBLE_WEIGHT_EPSILON_: NEGLIGIBLE_WEIGHT_EPSILON_,
  computeWeightedFactorScore_: computeWeightedFactorScore_,
  computePredictedFactorScores_: computePredictedFactorScores_
};
