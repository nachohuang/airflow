/**
 * realtime.js
 * 個股即時內外盤（委買委賣五檔）純函式邏輯，從 apps-script/src/Realtime.gs
 * 複製過來（只複製純運算部分，實際呼叫 mis.twse.com.tw 的 I/O 留給
 * index.js `exports.getRealtimeQuote`，跟這支 App 其他地方「lib/ 純函式
 * ＋ index.js I/O」同一個分工）。
 *
 * 這支端點（`mis.twse.com.tw`）是證交所看盤系統自己在用的即時報價端點，
 * 不是正式文件化的公開 API，沒有官方保證格式不會改版，限速「每 5 秒 3 個
 * 請求」——只做使用者在個股詳情主動查詢單一檔股票用，不寫入 Reports／
 * 不影響戰報評分，也不會被排程或戰報批次呼叫到（不能拿來掃全市場）。
 *
 * 複製時機：2026-10-13，對照 apps-script/src/Realtime.gs 當時的內容。
 */
var utils = require('./utils');
var round_ = utils.round_;

/** 五檔字串（例如 "620.00_619.00_618.00_0.00_0.00_"）依 "_" 切開，過濾掉切完是
 *  空字串的尾巴，轉成數字陣列；沒有掛單的檔位會是 0，保留（不過濾 0）讓呼叫端
 *  自己判斷。 */
function parseMisLevels_(str) {
  if (!str) return [];
  return String(str).split('_').filter(function (s) { return s !== ''; }).map(function (s) { return Number(s); });
}

/**
 * 綜合「委買委賣力道比」與「現價在當日高低區間的相對位置」，算出一個 0~100 的
 * 「買賣力道評估分數」——分數愈高代表當下愈偏向「委買力道強、且價位在當日區間
 * 裡相對偏低」。
 *
 * 這是刻意跟「AI 深度診斷」（看公司體質/趨勢，長線的基本面判斷）分開設計的
 * 短期戰術指標：這裡只回答「當下這個價位，掛單簿的買賣力道跟今天的相對高低
 * 位置，偏多還是偏空」，完全不看公司基本面、不看持股成本、也不看任何歷史
 * 趨勢——只是「這一刻」的參考，不是操作建議。
 *
 * 權重：委買委賣力道比佔 60%（掛單簿當下的多空力道，是最直接的買賣壓訊號，
 * 權重較高），當日價位相對高低點的位置佔 40%（愈接近當日最低點分數愈高——
 * 單純描述「現在站在今天的價格區間裡相對低檔或高檔」，不含任何技術分析或
 * 趨勢判斷，不代表「便宜」或「見底」）。high === low（例如剛開盤還沒有價格
 * 波動）時，價位位置這項給中性值 50，避免除以 0。
 */
function computeBuySellVerdict_(buyRatio, latestPrice, highPrice, lowPrice) {
  if (buyRatio === null || buyRatio === undefined) {
    return { score: null, label: '⚪ 資料不足', detail: '目前五檔掛單量都是 0，無法計算買賣力道評估。' };
  }
  var pressureScore = buyRatio * 100;
  var rangeScore;
  if (highPrice === null || lowPrice === null || latestPrice === null || highPrice === lowPrice) {
    rangeScore = 50;
  } else {
    rangeScore = (highPrice - latestPrice) / (highPrice - lowPrice) * 100;
    rangeScore = Math.max(0, Math.min(100, rangeScore));
  }

  var score = Math.round((pressureScore * 0.6 + rangeScore * 0.4) * 10) / 10;

  var label, detail;
  if (score >= 65) {
    label = '🟢 偏向有利買進';
    detail = '委買力道較強，且現價在當日區間中相對偏低。';
  } else if (score <= 35) {
    label = '🔴 偏向有利賣出';
    detail = '委賣力道較強，且現價在當日區間中相對偏高。';
  } else {
    label = '⚪ 多空不明顯';
    detail = '委買委賣力道與價位都沒有明顯偏向。';
  }
  return { score: score, label: label, detail: detail };
}

/**
 * 從五檔委買委賣算出「價差」（賣一－買一）跟「盤口中間價估算」——證交所有時候
 * 這個時間點還沒有明確的最近成交價可以揭示（例如剛好卡在集合競價），這時候
 * `latestPrice` 會是 null，這裡算一個「買一/賣一均價」當備援參考值——這是
 * 我們自己用盤口價位反推出來的估計值，不是證交所揭示的真正成交價，呼叫端
 * 顯示時一定要清楚標明「估算」，不能跟真正的成交價混在一起看。任一邊沒有
 * 掛單（例如漲跌停鎖死只剩單邊）就回傳 null，不硬算一個沒有意義的價差/
 * 中間價。
 */
function computeBookSpreadAndMidpoint_(bidLevels, askLevels) {
  var bestBid = (bidLevels && bidLevels.length && bidLevels[0].price) ? bidLevels[0].price : null;
  var bestAsk = (askLevels && askLevels.length && askLevels[0].price) ? askLevels[0].price : null;
  if (bestBid === null || bestAsk === null) return { spread: null, midpointEstimate: null };
  return {
    spread: round_(bestAsk - bestBid, 2),
    midpointEstimate: round_((bestAsk + bestBid) / 2, 2)
  };
}

module.exports = {
  parseMisLevels_: parseMisLevels_,
  computeBuySellVerdict_: computeBuySellVerdict_,
  computeBookSpreadAndMidpoint_: computeBookSpreadAndMidpoint_
};
