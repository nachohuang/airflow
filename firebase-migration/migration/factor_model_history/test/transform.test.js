const assert = require('assert');
const { normalizeDateTimeStr, parseNumber, isApplied_, buildDocId_, transformFactorModelRow } = require('../transform');

// --- normalizeDateTimeStr／parseNumber：re-export 沒有漏掉或接錯 ---
{
  assert.strictEqual(normalizeDateTimeStr('2026-10-05 14:30:00'), '2026-10-05 14:30:00');
  assert.strictEqual(parseNumber('0.72'), 0.72);
  console.log('Test normalizeDateTimeStr/parseNumber re-export passed.');
}

// --- normalizeDateTimeStr：Sheets 把儲存格自動判斷成 Date 型別、JSON.stringify
//    序列化成 UTC ISO 字串時，要轉回台北時間，不能照抄 UTC 數字（那樣跟原始
//    寫入值會差 8 小時，而這個欄位是用來比對「是不是套用中那個版本」的鍵，
//    差 8 小時會直接比對失敗）---
{
  // 2026-10-05 14:30:00 台北時間 = 2026-10-05 06:30:00 UTC
  assert.strictEqual(normalizeDateTimeStr('2026-10-05T06:30:00.000Z'), '2026-10-05 14:30:00');
  const d = new Date('2026-10-05T06:30:00.000Z');
  assert.strictEqual(normalizeDateTimeStr(d), '2026-10-05 14:30:00', '真正的 Date 物件也要轉回台北時間字串');
  console.log('Test normalizeDateTimeStr (UTC ISO / Date object -> Taipei time string) passed.');
}

// --- isApplied_：跟 apps-script applyFactorModel_ 的比對邏輯一致，含「套用中」字樣才算 ---
{
  assert.strictEqual(isApplied_('✓ 套用中'), true);
  assert.strictEqual(isApplied_(''), false);
  assert.strictEqual(isApplied_(undefined), false);
  console.log('Test isApplied_ passed.');
}

// --- buildDocId_：空白換底線、冒號換連字號 ---
{
  assert.strictEqual(buildDocId_('2026-10-05 14:30:00', 'return1m'), '2026-10-05_14-30-00_return1m');
  console.log('Test buildDocId_ passed.');
}

// --- transformFactorModelRow：正常一筆的轉換結果 ---
{
  const row = {
    '執行時間': '2026-10-05 14:30:00', '標的Label': 'downsideResistance',
    'L1正規化強度': '0.05', '使用特徵': 'inst_participation, ibf_20d, trend_score',
    '訓練列數': '12000', 'R2': '0.312', '權重(JSON)': '{"inst_participation":0.4,"ibf_20d":0.2}',
    '狀態': '完成', '目前套用版本': '✓ 套用中'
  };
  const doc = transformFactorModelRow(row, '2026-10-05T00:00:00.000Z');
  assert.strictEqual(doc.id, '2026-10-05_14-30-00_downsideResistance');
  assert.strictEqual(doc.timestamp, '2026-10-05 14:30:00');
  assert.strictEqual(doc.labelKey, 'downsideResistance');
  assert.strictEqual(doc.l1Reg, 0.05);
  assert.deepStrictEqual(doc.featureColumns, ['inst_participation', 'ibf_20d', 'trend_score']);
  assert.strictEqual(doc.trainRows, 12000);
  assert.strictEqual(doc.r2, 0.312);
  assert.deepStrictEqual(doc.weights, { inst_participation: 0.4, ibf_20d: 0.2 });
  assert.strictEqual(doc.status, '完成');
  assert.strictEqual(doc.applied, true);
  assert.strictEqual(doc.migratedFrom, 'sheets:FactorModelHistory');
  console.log('Test transformFactorModelRow (basic, applied) passed.');
}

// --- transformFactorModelRow：沒有套用的歷史紀錄，applied 要是 false ---
{
  const row = {
    '執行時間': '2026-09-28 09:00:00', '標的Label': 'return1m',
    'L1正規化強度': '0.05', '使用特徵': 'trend_score', '訓練列數': '11000', 'R2': '0.28',
    '權重(JSON)': '{"trend_score":0.5}', '狀態': '完成', '目前套用版本': ''
  };
  const doc = transformFactorModelRow(row, 'x');
  assert.strictEqual(doc.applied, false);
  console.log('Test transformFactorModelRow (not applied) passed.');
}

// --- transformFactorModelRow：執行時間或標的Label空白要回傳 null ---
{
  assert.strictEqual(transformFactorModelRow({ '執行時間': '', '標的Label': 'return1m' }, 'x'), null);
  assert.strictEqual(transformFactorModelRow({ '執行時間': '2026-10-05 14:30:00', '標的Label': '' }, 'x'), null);
  console.log('Test transformFactorModelRow (blank timestamp or labelKey -> null, not imported) passed.');
}

// --- transformFactorModelRow：權重 JSON 解析失敗要降級成空物件，不能讓整筆遷移中斷 ---
{
  const row = { '執行時間': '2026-10-05 14:30:00', '標的Label': 'return1m', '權重(JSON)': '{not valid json' };
  const doc = transformFactorModelRow(row, 'x');
  assert.deepStrictEqual(doc.weights, {}, '權重 JSON 壞掉要降級成空物件，不能讓整筆遷移中斷');
  console.log('Test transformFactorModelRow (corrupt weights JSON -> empty object fallback) passed.');
}

// --- transformFactorModelRow：使用特徵缺欄位時 featureColumns 要是空陣列 ---
{
  const doc = transformFactorModelRow({ '執行時間': '2026-10-05 14:30:00', '標的Label': 'return1m' }, 'x');
  assert.deepStrictEqual(doc.featureColumns, []);
  assert.strictEqual(doc.status, '');
  console.log('Test transformFactorModelRow (missing optional fields default safely) passed.');
}

console.log('All transform.js tests passed.');
