const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// SheetUtils.gs 裡跟「執行紀錄」篩選相關的函式（runLogCategoryOf_ / getRecentRunLogs /
// getRunLogCategories）。跟 aiDiagnosis.test.js 的手法一樣，用一個最小的記憶體版假 Sheet
// 撐住 getRange/getValues/setValues/clearContents，不用真的接 Google Sheets。

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

const context = { console: console, PropertiesService: PropertiesService, SpreadsheetApp: SpreadsheetApp };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('SheetUtils.gs');
fakeProps[context.CONFIG.PROP_KEYS.SPREADSHEET_ID] = 'fake-spreadsheet-id';

// --- runLogCategoryOf_：取第一個「-」前的文字分組 ---
{
  assert.strictEqual(context.runLogCategoryOf_('每日排程-補抓資料'), '每日排程');
  assert.strictEqual(context.runLogCategoryOf_('每日排程'), '每日排程', '沒有「-」的類型，整串就是它自己的分組');
  assert.strictEqual(context.runLogCategoryOf_(''), '');
  assert.strictEqual(context.runLogCategoryOf_(null), '', '不能因為傳 null 就拋例外');
  assert.strictEqual(context.runLogCategoryOf_(undefined), '');
  console.log('Test runLogCategoryOf_ passed.');
}

// --- getRecentRunLogs / getRunLogCategories：篩選要在「取最近 N 筆」之前做，不能先限制
//    筆數再篩，不然「最近 50 筆全部類型」裡剛好沒幾筆是目標類別時，篩完會誤以為幾乎沒有
//    紀錄——這裡刻意讓目標類別的紀錄不在最近幾筆裡，驗證還是篩得到 ---
{
  fakeSheets = {};
  var sheet = context.ensureSheetWithHeaders_(context.getSpreadsheet_(), context.CONFIG.SHEET_NAMES.RUN_LOG, context.CONFIG.RUN_LOG_COLUMNS);
  var rows = [
    { '時間戳記': 't1', '類型': '每日排程', '狀態': '成功', '訊息': 'm1', '耗時(秒)': 1 },
    { '時間戳記': 't2', '類型': 'AI診斷', '狀態': '成功', '訊息': 'm2', '耗時(秒)': 1 },
    { '時間戳記': 't3', '類型': 'AI診斷', '狀態': '成功', '訊息': 'm3', '耗時(秒)': 1 },
    { '時間戳記': 't4', '類型': '每日排程-補抓資料', '狀態': '失敗', '訊息': 'm4', '耗時(秒)': 1 },
    { '時間戳記': 't5', '類型': 'AI診斷', '狀態': '成功', '訊息': 'm5', '耗時(秒)': 1 }
  ];
  context.writeSheetObjects_(sheet, context.CONFIG.RUN_LOG_COLUMNS, rows);

  var allLogs = context.getRecentRunLogs(50);
  assert.strictEqual(allLogs.length, 5, '不帶類別篩選要拿到全部');
  assert.strictEqual(allLogs[0]['訊息'], 'm5', '要新到舊排序（reverse 過)');

  var scheduleOnly = context.getRecentRunLogs(50, '每日排程');
  assert.strictEqual(scheduleOnly.length, 2, '「每日排程」跟「每日排程-補抓資料」都要算進同一個分組');
  assert.deepStrictEqual([...scheduleOnly.map(function (r) { return r['訊息']; })], ['m4', 'm1'], '篩選後一樣要新到舊排序');

  var scheduleOnlyLimit1 = context.getRecentRunLogs(1, '每日排程');
  assert.strictEqual(scheduleOnlyLimit1.length, 1, '篩選要在限制筆數之前做，不能因為 limit=1 先把全表切成 1 筆才篩');
  assert.strictEqual(scheduleOnlyLimit1[0]['訊息'], 'm4', '限制 1 筆時要是「篩選後最新的那 1 筆」，不是全表最新那 1 筆（剛好不是目標類別）');

  var categories = context.getRunLogCategories();
  assert.deepStrictEqual([...categories], ['AI診斷', '每日排程'], '要回傳不重複、排序過的分組清單');
  console.log('Test getRecentRunLogs / getRunLogCategories (category filtering applied before limiting, correct grouping) passed.');
}

console.log('All SheetUtils.gs RunLog-category tests passed.');
