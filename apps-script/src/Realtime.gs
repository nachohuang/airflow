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
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: cookie ? { Cookie: cookie } : {}
  });
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

  var interpretation;
  if (buyRatio === null) {
    interpretation = '目前五檔掛單量都是 0，暫時無法判斷買賣力道。';
  } else if (buyRatio >= 0.6) {
    interpretation = '委買掛單量明顯大於委賣，偏多方力道（僅反映當下掛單簿，不是已成交籌碼方向，僅供參考）。';
  } else if (buyRatio <= 0.4) {
    interpretation = '委賣掛單量明顯大於委買，偏空方力道（僅反映當下掛單簿，不是已成交籌碼方向，僅供參考）。';
  } else {
    interpretation = '委買委賣掛單量接近，多空力道不明顯。';
  }

  return {
    code: c,
    ok: true,
    name: q.n || '',
    latestPrice: (q.z && q.z !== '-') ? Number(q.z) : null,
    openPrice: q.o ? Number(q.o) : null,
    highPrice: q.h ? Number(q.h) : null,
    lowPrice: q.l ? Number(q.l) : null,
    accumulatedVolume: q.v ? Number(q.v) : null,
    timestamp: q.tlong ? Number(q.tlong) : null,
    bidLevels: bidLevels,
    askLevels: askLevels,
    buyPressure: buyPressure,
    sellPressure: sellPressure,
    buyRatio: buyRatio,
    interpretation: interpretation
  };
}
