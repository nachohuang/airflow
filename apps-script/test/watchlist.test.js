const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// 跟 aiDiagnosis.test.js 一樣的手法：用一個最小的記憶體版假 Sheet 撐住
// readSheetObjects_/writeSheetObjects_/appendSheetObjects_ 實際會呼叫的
// getRange/getValues/setValues/clearContents 這幾個方法，不用真的接 Google Sheets。
const fakeProps = {};
const PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function (key) { return Object.prototype.hasOwnProperty.call(fakeProps, key) ? fakeProps[key] : null; },
      setProperty: function (key, value) { fakeProps[key] = value; },
      deleteProperty: function (key) { delete fakeProps[key]; }
    };
  }
};

function makeFakeSheet_() {
  var grid = [];
  return {
    getLastRow: function () { return grid.length; },
    getLastColumn: function () { return grid.length ? grid[0].length : 0; },
    getRange: function (row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getValues: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) {
            var rowArr = grid[row - 1 + r] || [];
            var line = [];
            for (var c = 0; c < numCols; c++) line.push(rowArr[col - 1 + c] !== undefined ? rowArr[col - 1 + c] : '');
            out.push(line);
          }
          return out;
        },
        setValues: function (values) {
          for (var r = 0; r < values.length; r++) {
            var targetRow = row - 1 + r;
            while (grid.length <= targetRow) grid.push([]);
            for (var c = 0; c < values[r].length; c++) grid[targetRow][col - 1 + c] = values[r][c];
          }
        }
      };
    },
    clearContents: function () { grid = []; },
    setFrozenRows: function () {}
  };
}

var fakeSheets = {};
const SpreadsheetApp = {
  openById: function () {
    return {
      getSheetByName: function (name) { return fakeSheets[name] || null; },
      insertSheet: function (name) { var s = makeFakeSheet_(); fakeSheets[name] = s; return s; }
    };
  }
};

const Utilities = {
  formatDate: function (date, tz, fmt) {
    function pad(n) { return String(n).padStart(2, '0'); }
    return fmt
      .replace('yyyy', date.getFullYear())
      .replace('MM', pad(date.getMonth() + 1))
      .replace('dd', pad(date.getDate()))
      .replace('HH', pad(date.getHours()))
      .replace('mm', pad(date.getMinutes()))
      .replace('ss', pad(date.getSeconds()));
  },
  getUuid: function () { return 'fake-uuid-' + Math.random().toString(36).slice(2); }
};

const context = {
  console: console, PropertiesService: PropertiesService, SpreadsheetApp: SpreadsheetApp, Utilities: Utilities,
  logRun_: function () {},
  // getWatchlist() 補救措施會在名稱是空的時候呼叫 getStockNameByCode（StockAnalysis.gs，
  // 這裡不載入整份檔案跟它一堆依賴）——所有測試案例都會直接帶名稱，不會真的用到這個
  // fallback，這裡放一個不應該被呼叫到的假實作，測試才會在假設意外被打破時明確失敗。
  getStockNameByCode: function () { throw new Error('這個測試案例不該呼叫到 getStockNameByCode（應該都有帶名稱）'); },
  // getWatchlist() 會讀 Reports 表算「最近一次戰報燈號」，這裡的測試都不關心這部分，
  // 給一個固定回傳空陣列的假 getReportsSheet_，避免還要另外載入 Analysis.gs 一整條依賴鏈。
  getReportsSheet_: function () { return { name: 'FakeReports' }; }
};
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('SheetUtils.gs');
loadIntoContext('Portfolio.gs');
loadIntoContext('Watchlist.gs');
fakeProps[context.CONFIG.PROP_KEYS.SPREADSHEET_ID] = 'fake-spreadsheet-id';

// getWatchlist() 呼叫 getReportsSheet_() 再 readSheetObjects_() 它——用一個真正的空白假表
// 撐住，比覆寫 getReportsSheet_ 更貼近真實路徑（readSheetObjects_ 是真的載入的版本）。
context.getReportsSheet_ = function () {
  fakeSheets['Reports'] = fakeSheets['Reports'] || makeFakeSheet_();
  return fakeSheets['Reports'];
};

// getWatchlist() 也會呼叫 getLatestCloseByCode_（Portfolio.gs）補最新收盤價——這支函式底下
// 一路連到 History/BigQuery 讀取那整條不相干的子系統（shouldUseBigQueryForReads_ 需要
// getBigQuerySettings 等一堆這裡完全沒載入的依賴），這裡的測試只關心觀察清單本身的 CRUD／
// 跟持股庫存互相檢查重複的邏輯，不關心價格數字，直接在這個邊界上蓋掉，不用把整條依賴鏈
// 都載進來。
context.getLatestCloseByCode_ = function () { return {}; };

function resetFakeSheets_() { fakeSheets = {}; }

// --- 1. addToWatchlist：正常加入一檔股票，代號要補零成 4 碼，加入日期要自動帶今天 ---
{
  resetFakeSheets_();
  var result = context.addToWatchlist('330', '某某股', '之前戰報出現過，後來排名掉出去了');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].code, '0330', '代號要補零成 4 碼');
  assert.strictEqual(result[0].name, '某某股');
  assert.strictEqual(result[0].note, '之前戰報出現過，後來排名掉出去了');
  assert.ok(result[0].addedDate, '加入日期要自動帶今天，不能是空的');
  console.log('Test 1 (addToWatchlist basic add, code zero-padded) passed.');
}

// --- 2. addToWatchlist：同一檔股票重複加入，不該產生第二列，只更新名稱/備註 ---
{
  resetFakeSheets_();
  context.addToWatchlist('2603', '長榮', '第一次加入的備註');
  var result = context.addToWatchlist('2603', '長榮海運', '更新後的備註');
  assert.strictEqual(result.length, 1, '重複加入同一檔股票不該產生第二列');
  assert.strictEqual(result[0].name, '長榮海運', '重複加入要更新名稱');
  assert.strictEqual(result[0].note, '更新後的備註', '重複加入要更新備註');
  console.log('Test 2 (addToWatchlist duplicate add updates in place, no duplicate rows) passed.');
}

// --- 3. addToWatchlist：股票代號不可為空 ---
{
  resetFakeSheets_();
  assert.throws(function () { context.addToWatchlist('', '無代號'); }, /股票代號不可為空/);
  console.log('Test 3 (addToWatchlist rejects empty code) passed.');
}

// --- 4. addToWatchlist：跟持股庫存互相檢查重複——已經是「持有中」的股票不能加進觀察清單 ---
{
  resetFakeSheets_();
  context.savePortfolioItem({ code: '2330', name: '台積電', cost: 600, buyDate: '2026-08-01', shares: 1000 });
  assert.throws(function () { context.addToWatchlist('2330', '台積電'); }, /目前是持有中的股票/,
    '已經持有的股票應該被擋下來，不能重複加進觀察清單');
  var watchlist = context.getWatchlist();
  assert.strictEqual(watchlist.length, 0, '被擋下來的加入不該留下任何觀察清單紀錄');
  console.log('Test 4 (addToWatchlist blocks codes already held in portfolio) passed.');
}

// --- 5. addToWatchlist：曾經持有但已經賣出（狀態不是「持有中」）的股票，可以重新加入觀察清單 ---
{
  resetFakeSheets_();
  context.savePortfolioItem({ code: '2330', name: '台積電', cost: 600, buyDate: '2026-08-01', shares: 1000 });
  context.closePortfolioPosition('2330', '2026-08-15', 650);
  var result = context.addToWatchlist('2330', '台積電', '已經賣出，想繼續觀察後續走勢');
  assert.strictEqual(result.length, 1, '已賣出（不是持有中）的股票應該可以正常加進觀察清單');
  console.log('Test 5 (addToWatchlist allows re-adding a closed/sold position) passed.');
}

// --- 6. removeFromWatchlist：正常移除、移除不存在的代號要是安全的 no-op（不拋例外） ---
{
  resetFakeSheets_();
  context.addToWatchlist('2603', '長榮');
  context.addToWatchlist('9910', '豐泰');
  var afterRemove = context.removeFromWatchlist('2603');
  assert.strictEqual(afterRemove.length, 1);
  assert.strictEqual(afterRemove[0].code, '9910', '不該連帶刪到其他代號');

  var afterNoop = context.removeFromWatchlist('0000');
  assert.strictEqual(afterNoop.length, 1, '移除不存在的代號要是安全的 no-op，不能拋例外或動到其他紀錄');
  console.log('Test 6 (removeFromWatchlist removes correctly, no-op for missing code) passed.');
}

// --- 7. savePortfolioItem 新增一筆全新持有時，要自動把同一檔股票從觀察清單移除（互相檢查
//    重複的另一半：加入觀察清單時擋掉已持有的股票，這裡反過來確保「買進之後」觀察清單
//    自動同步，不用使用者自己記得刪） ---
{
  resetFakeSheets_();
  context.addToWatchlist('2603', '長榮', '觀察中');
  context.addToWatchlist('9910', '豐泰', '也在觀察');
  assert.strictEqual(context.getWatchlist().length, 2);

  context.savePortfolioItem({ code: '2603', name: '長榮', cost: 180, buyDate: '2026-08-20', shares: 1000 });
  var watchlistAfterBuy = context.getWatchlist();
  assert.strictEqual(watchlistAfterBuy.length, 1, '2603 被買進之後，應該自動從觀察清單移除');
  assert.strictEqual(watchlistAfterBuy[0].code, '9910', '不該連帶動到沒有被買進的其他觀察中股票');
  console.log('Test 7 (savePortfolioItem new holding auto-removes matching watchlist entry) passed.');
}

// --- 8. savePortfolioItem 加碼買進（既有持股再買一筆，lotId 一樣是空字串）不該因為觀察清單
//    裡沒有這檔股票就出錯——removeFromWatchlistSilently_ 對「本來就不在清單」要是安全的 ---
{
  resetFakeSheets_();
  context.savePortfolioItem({ code: '2330', name: '台積電', cost: 600, buyDate: '2026-08-01', shares: 1000 });
  assert.doesNotThrow(function () {
    context.savePortfolioItem({ code: '2330', name: '台積電', cost: 620, buyDate: '2026-08-10', shares: 1000 });
  }, '加碼買進時，即使這檔股票本來就不在觀察清單裡，也不該因為嘗試移除而出錯');
  console.log('Test 8 (savePortfolioItem add-lot for a code not on the watchlist does not throw) passed.');
}

// --- 9. savePortfolioItem 編輯既有 lot（帶 lotId）不該觸發觀察清單移除邏輯以外的副作用——
//    這裡驗證編輯不會誤刪其他還在觀察中的股票 ---
{
  resetFakeSheets_();
  context.addToWatchlist('9910', '豐泰', '觀察中');
  var portfolioAfterAdd = context.savePortfolioItem({ code: '2330', name: '台積電', cost: 600, buyDate: '2026-08-01', shares: 1000 });
  var lotId = portfolioAfterAdd[0].lots[0].id;
  context.savePortfolioItem({ lotId: lotId, code: '2330', name: '台積電', cost: 605, buyDate: '2026-08-01', shares: 1000 });
  assert.strictEqual(context.getWatchlist().length, 1, '編輯既有 lot 不該影響觀察清單裡跟這次編輯無關的其他股票');
  console.log('Test 9 (savePortfolioItem editing an existing lot does not disturb unrelated watchlist entries) passed.');
}

console.log('All Watchlist.gs tests passed.');
