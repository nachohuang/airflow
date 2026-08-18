const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// getRealtimeQuote 除了純函式 computeBuySellVerdict_ 之外還會呼叫 UrlFetchApp，用一個
// 可以每個測試各自覆寫 fetch 行為的 stub，模擬「連線層級直接失敗」（UrlFetchApp.fetch 本身
// 拋例外，不是回傳錯誤狀態碼）跟「拿 cookie 那次呼叫失敗但不中斷後續」兩種情境。
var fetchImpl = null;
const UrlFetchApp = { fetch: function (url, opts) { return fetchImpl(url, opts); } };
const context = { console: console, UrlFetchApp: UrlFetchApp };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Utils.gs');
loadIntoContext('Realtime.gs');

// --- 1. 委買力道強 + 現價貼近當日低點 -> 高分、偏向有利買進 ---
{
  const v = context.computeBuySellVerdict_(0.8, 100, 110, 95);
  // pressureScore = 80, rangeScore = (110-100)/(110-95)*100 = 66.67
  // score = 80*0.6 + 66.67*0.4 = 48 + 26.67 = 74.67
  assert.ok(v.score > 65, 'expected score > 65, got ' + v.score);
  assert.strictEqual(v.label, '🟢 偏向有利買進');
  console.log('Test 1 (strong bid pressure + near daily low -> favorable buy) passed:', v.score);
}

// --- 2. 委賣力道強 + 現價貼近當日高點 -> 低分、偏向有利賣出 ---
{
  const v = context.computeBuySellVerdict_(0.2, 108, 110, 95);
  // pressureScore = 20, rangeScore = (110-108)/(110-95)*100 = 13.33
  // score = 20*0.6 + 13.33*0.4 = 12 + 5.33 = 17.33
  assert.ok(v.score < 35, 'expected score < 35, got ' + v.score);
  assert.strictEqual(v.label, '🔴 偏向有利賣出');
  console.log('Test 2 (strong ask pressure + near daily high -> favorable sell) passed:', v.score);
}

// --- 3. 力道與價位都中性 -> 多空不明顯 ---
{
  const v = context.computeBuySellVerdict_(0.5, 102, 110, 95);
  assert.ok(v.score > 35 && v.score < 65, 'expected neutral score, got ' + v.score);
  assert.strictEqual(v.label, '⚪ 多空不明顯');
  console.log('Test 3 (neutral pressure and price position) passed:', v.score);
}

// --- 4. buyRatio 是 null（掛單量全部是 0）-> 資料不足 ---
{
  const v = context.computeBuySellVerdict_(null, 102, 110, 95);
  assert.strictEqual(v.score, null);
  assert.strictEqual(v.label, '⚪ 資料不足');
  console.log('Test 4 (buyRatio null -> insufficient data) passed');
}

// --- 5. highPrice === lowPrice（今天還沒有價格波動）-> 價位分數用中性值 50，不是 NaN ---
{
  const v = context.computeBuySellVerdict_(0.6, 100, 100, 100);
  // rangeScore = 50 (中性), pressureScore = 60, score = 60*0.6 + 50*0.4 = 36 + 20 = 56
  assert.ok(!Number.isNaN(v.score), 'score should not be NaN when high === low');
  assert.ok(Math.abs(v.score - 56) < 0.01, 'expected score ~56, got ' + v.score);
  console.log('Test 5 (high === low -> neutral range score, no NaN) passed:', v.score);
}

// --- 6. getRealtimeQuote：連線層級直接失敗（UrlFetchApp.fetch 本身拋例外，例如這支非正式
//    端點暫時拒絕連線）要被攔下來換成白話訊息，不能讓 Apps Script 原始的「無法開啟網址：
//    <完整URL>」內部例外文字直接被拋到前端 ---
{
  var callCount = 0;
  fetchImpl = function (url) {
    callCount++;
    if (url.indexOf('index.jsp') !== -1) throw new Error('無法開啟網址：https://mis.twse.com.tw/stock/index.jsp');
    throw new Error('無法開啟網址：' + url);
  };
  assert.throws(function () { context.getRealtimeQuote('2330'); }, function (err) {
    return err.message === '證交所即時報價伺服器暫時無法連線，可能是網路問題或剛好被限速，稍後再試一次。';
  }, '連線層級失敗要換成白話訊息，不能洩漏原始例外文字（含內部網址）');
  assert.ok(callCount >= 1, '至少要嘗試呼叫過 fetch');
  console.log('Test 6 (connection-level fetch failure -> friendly error, not raw exception) passed.');
}

// --- 7. getRealtimeQuote：拿 cookie 那次呼叫失敗（fetchTwseMisCookie_ 內部已經 try/catch）
//    不該中斷主要查詢，主要查詢本身正常回應時還是要能拿到報價 ---
{
  fetchImpl = function (url) {
    if (url.indexOf('index.jsp') !== -1) throw new Error('無法開啟網址：https://mis.twse.com.tw/stock/index.jsp');
    return {
      getAllHeaders: function () { return {}; },
      getResponseCode: function () { return 200; },
      getContentText: function () {
        return JSON.stringify({ msgArray: [{ n: '台積電', z: '600', o: '590', h: '605', l: '585', v: '12345', tlong: '1700000000000', b: '599.00_', g: '10_', a: '600.00_', f: '5_' }] });
      }
    };
  };
  var q = context.getRealtimeQuote('2330');
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.name, '台積電');
  console.log('Test 7 (cookie fetch fails but main quote fetch still succeeds) passed.');
}

console.log('All Realtime.gs tests passed.');
