const assert = require('assert');
const { zfill4, normalizeDateStr, parseNumber, translateStatus, transformPortfolioRow } = require('../transform');

// --- zfill4／normalizeDateStr：跟 watchlist 共用同一份 lib/normalize，這裡只是
//    確認 re-export 沒有漏掉或接錯 ---
{
  assert.strictEqual(zfill4('330'), '0330');
  assert.strictEqual(normalizeDateStr('2026/8/21'), '2026-08-21');
  console.log('Test zfill4/normalizeDateStr re-export passed.');
}

// --- parseNumber：空字串/null/undefined 一律回傳 null，不能用 0 當預設值——0 是
//    合法的股數/價格，用 0 掩蓋壞資料會讓品質檢查看不出來 ---
{
  assert.strictEqual(parseNumber('123.5'), 123.5);
  assert.strictEqual(parseNumber(2000), 2000);
  assert.strictEqual(parseNumber(''), null);
  assert.strictEqual(parseNumber(null), null);
  assert.strictEqual(parseNumber(undefined), null);
  assert.strictEqual(parseNumber('abc'), null, '無法解析的字串要回傳 null，不是 NaN');
  console.log('Test parseNumber passed.');
}

// --- translateStatus：中文狀態翻成英文列舉，空白/未知值比照 Portfolio.gs 的
//    `r['狀態'] || '持有中'` 預設邏輯，當成 holding ---
{
  assert.strictEqual(translateStatus('持有中'), 'holding');
  assert.strictEqual(translateStatus('已賣出'), 'sold');
  assert.strictEqual(translateStatus(''), 'holding');
  assert.strictEqual(translateStatus(undefined), 'holding');
  console.log('Test translateStatus passed.');
}

// --- transformPortfolioRow：正常一筆持有中的轉換結果 ---
{
  const row = {
    '交易ID': 'tx-001', '證券代號': '330', '證券名稱': '某某股',
    '買進日期': '2026-08-21', '買進價格': '105.5', '股數': '1000',
    '備註': '長期', '狀態': '持有中', '賣出日期': '', '賣出價格': ''
  };
  const doc = transformPortfolioRow(row, '2026-09-30T00:00:00.000Z');
  assert.strictEqual(doc.id, 'tx-001', '文件 ID 要跟 transactionId 一樣');
  assert.strictEqual(doc.transactionId, 'tx-001');
  assert.strictEqual(doc.code, '0330');
  assert.strictEqual(doc.name, '某某股');
  assert.strictEqual(doc.buyDate, '2026-08-21');
  assert.strictEqual(doc.buyPrice, 105.5);
  assert.strictEqual(doc.shares, 1000);
  assert.strictEqual(doc.note, '長期');
  assert.strictEqual(doc.status, 'holding');
  assert.strictEqual(doc.sellDate, null);
  assert.strictEqual(doc.sellPrice, null);
  assert.strictEqual(doc.migratedFrom, 'sheets:Portfolio');
  assert.strictEqual(doc.migratedAt, '2026-09-30T00:00:00.000Z');
  console.log('Test transformPortfolioRow (basic, holding) passed.');
}

// --- transformPortfolioRow：已賣出一筆，sellDate/sellPrice 要有值、狀態要翻成 sold ---
{
  const row = {
    '交易ID': 'tx-002', '證券代號': '2330', '證券名稱': '台積電',
    '買進日期': '2026-01-10', '買進價格': '600', '股數': '10',
    '狀態': '已賣出', '賣出日期': '2026-06-15', '賣出價格': '720'
  };
  const doc = transformPortfolioRow(row, 'x');
  assert.strictEqual(doc.status, 'sold');
  assert.strictEqual(doc.sellDate, '2026-06-15');
  assert.strictEqual(doc.sellPrice, 720);
  console.log('Test transformPortfolioRow (sold) passed.');
}

// --- transformPortfolioRow：交易ID空白要回傳 null，不能匯入一筆沒有主鍵的垃圾文件 ---
{
  assert.strictEqual(transformPortfolioRow({ '交易ID': '', '證券代號': '2330' }, 'x'), null);
  assert.strictEqual(transformPortfolioRow({ '交易ID': '   ', '證券代號': '2330' }, 'x'), null);
  console.log('Test transformPortfolioRow (blank transactionId -> null, not imported) passed.');
}

// --- transformPortfolioRow：名稱/備註缺欄位時要用空字串，不能是 undefined ---
{
  const doc = transformPortfolioRow({ '交易ID': 'tx-003', '證券代號': '2330', '買進價格': '600', '股數': '10' }, 'x');
  assert.strictEqual(doc.name, '', 'name 缺欄位要是空字串，不能是 undefined');
  assert.strictEqual(doc.note, '', 'note 缺欄位要是空字串，不能是 undefined');
  console.log('Test transformPortfolioRow (missing optional fields default to empty string, not undefined) passed.');
}

console.log('All transform.js tests passed.');
