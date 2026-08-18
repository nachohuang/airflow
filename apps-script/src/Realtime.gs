/**
 * Realtime.gs
 * 個股即時內外盤（委買委賣五檔）查詢：直接呼叫證交所看盤系統自己在用的即時報價端點
 * （mis.twse.com.tw），不透過任何第三方套件——這支端點跟已經串的 openapi.twse.com.tw
 * 不一樣，不是正式文件化的公開 API，是網站前端自己在用的內部端點，沒有官方保證格式
 * 不會改版，只當作「輔助判斷買賣時機」的參考資訊，不寫入 Reports／不影響戰報評分，
 * 也不會被排程或戰報批次呼叫到（這支端點官方註明限速「每 5 秒 3 個請求」，只做使用者
 * 在個股詳情主動查詢單一檔股票用，不能拿來掃全市場）。
 */

/** 建立一次 session 拿 cookie：跟瀏覽器打開看盤頁面時一樣，部分情況下沒有這個 cookie
 *  查詢會失敗或被視為異常流量，拿不到就算了，後面還是會試著直接查（不因此整個中斷）。 */
function fetchTwseMisCookie_() {
  var resp = UrlFetchApp.fetch('https://mis.twse.com.tw/stock/index.jsp', { muteHttpExceptions: true });
  var headers = resp.getAllHeaders();
  var cookies = headers['Set-Cookie'] || headers['set-cookie'];
  if (!cookies) return '';
  var list = Array.isArray(cookies) ? cookies : [cookies];
  return list.map(function (c) { return String(c).split(';')[0]; }).join('; ');
}

/** 五檔字串（例如 "620.00_619.00_618.00_0.00_0.00_"）依 "_" 切開，過濾掉切完是空字串的
 *  尾巴，轉成數字陣列；沒有掛單的檔位會是 0，保留（不過濾 0）讓呼叫端自己判斷。 */
function parseMisLevels_(str) {
  if (!str) return [];
  return String(str).split('_').filter(function (s) { return s !== ''; }).map(function (s) { return Number(s); });
}

/**
 * 純函式：綜合「委買委賣力道比」與「現價在當日高低區間的相對位置」，算出一個 0~100 的
 * 「買賣力道評估分數」——分數愈高代表當下愈偏向「委買力道強、且價位在當日區間裡相對偏低」。
 *
 * 這是刻意跟「🚨 持股續抱評估」（AI 深度診斷，看公司體質/趨勢，判斷值不值得繼續抱或加碼、
 * 是長線的基本面判斷）分開設計的短期戰術指標：這裡只回答「當下這個價位，掛單簿的買賣力道
 * 跟今天的相對高低位置，偏多還是偏空」，完全不看公司基本面、不看持股成本、也不看任何歷史
 * 趨勢——只是「這一刻」的參考，不是操作建議，更不是續抱評估的替代品。
 *
 * 權重：委買委賣力道比佔 60%（掛單簿當下的多空力道，是最直接的買賣壓訊號，權重較高），
 * 當日價位相對高低點的位置佔 40%（愈接近當日最低點分數愈高——單純描述「現在站在今天的
 * 價格區間裡相對低檔或高檔」，不含任何技術分析或趨勢判斷，不代表「便宜」或「見底」）。
 * high === low（例如剛開盤還沒有價格波動）時，價位位置這項給中性值 50，避免除以 0。
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
 * 前端「個股詳情」畫面「查詢即時內外盤」按鈕呼叫。code 是 4 碼股票代號，不先判斷是上市
 * 還是上櫃，兩種前綴（tse_/otc_）用 "|" 合併成一次查詢，MIS 回傳的 msgArray 只會有真正
 * 存在的那一筆（同一個代號不可能同時是上市又是上櫃）。
 */
function getRealtimeQuote(code) {
  var c = zfill4(String(code || '').trim());
  if (!c) throw new Error('請提供股票代號');

  var cookie = '';
  try { cookie = fetchTwseMisCookie_(); } catch (e) { /* 拿不到 cookie 也繼續往下試 */ }

  var exCh = 'tse_' + c + '.tw|otc_' + c + '.tw';
  var url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + encodeURIComponent(exCh) + '&_=' + Date.now();
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: cookie ? { Cookie: cookie } : {}
    });
  } catch (e) {
    // muteHttpExceptions 只會壓住「有回應但是錯誤狀態碼」的情況；連線層級直接失敗（例如
    // 這支非正式端點暫時拒絕連線）UrlFetchApp 還是會直接拋例外，訊息是 Apps Script 內部
    // 產生的「無法開啟網址：<完整URL>」，直接讓使用者看到既不好懂也沒必要暴露內部網址，
    // 這裡攔下來換成跟下面 HTTP 錯誤狀態碼一致的白話訊息。
    throw new Error('證交所即時報價伺服器暫時無法連線，可能是網路問題或剛好被限速，稍後再試一次。');
  }
  if (resp.getResponseCode() !== 200) {
    throw new Error('證交所即時報價查詢失敗（HTTP ' + resp.getResponseCode() + '），可能是暫時性問題或剛好遇到限速，稍後再試一次。');
  }

  var json;
  try {
    json = JSON.parse(resp.getContentText('UTF-8'));
  } catch (e) {
    throw new Error('證交所即時報價回傳格式異常，無法解析，稍後再試一次。');
  }

  var arr = json.msgArray || [];
  if (arr.length === 0) {
    return { code: c, ok: false, message: '目前查不到即時報價，可能是非交易時間、股票代號錯誤，或這檔股票剛好沒有掛單資料。' };
  }
  var q = arr[0];

  var bidPrices = parseMisLevels_(q.b);
  var bidVolumes = parseMisLevels_(q.g);
  var askPrices = parseMisLevels_(q.a);
  var askVolumes = parseMisLevels_(q.f);
  var bidLevels = bidPrices.map(function (p, i) { return { price: p, volume: bidVolumes[i] || 0 }; });
  var askLevels = askPrices.map(function (p, i) { return { price: p, volume: askVolumes[i] || 0 }; });

  var buyPressure = bidVolumes.reduce(function (s, v) { return s + v; }, 0);
  var sellPressure = askVolumes.reduce(function (s, v) { return s + v; }, 0);
  var total = buyPressure + sellPressure;
  var buyRatio = total > 0 ? buyPressure / total : null;

  var latestPrice = (q.z && q.z !== '-') ? Number(q.z) : null;
  var highPrice = q.h ? Number(q.h) : null;
  var lowPrice = q.l ? Number(q.l) : null;
  var verdict = computeBuySellVerdict_(buyRatio, latestPrice, highPrice, lowPrice);

  return {
    code: c,
    ok: true,
    name: q.n || '',
    latestPrice: latestPrice,
    openPrice: q.o ? Number(q.o) : null,
    highPrice: highPrice,
    lowPrice: lowPrice,
    accumulatedVolume: q.v ? Number(q.v) : null,
    timestamp: q.tlong ? Number(q.tlong) : null,
    bidLevels: bidLevels,
    askLevels: askLevels,
    buyPressure: buyPressure,
    sellPressure: sellPressure,
    buyRatio: buyRatio,
    verdict: verdict
  };
}
