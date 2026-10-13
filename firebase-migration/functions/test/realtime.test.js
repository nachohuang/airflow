const assert = require('assert');
const realtime = require('../lib/realtime');

// --- parseMisLevels_ ---
{
  assert.deepStrictEqual(realtime.parseMisLevels_('620.00_619.00_618.00_0.00_0.00_'), [620, 619, 618, 0, 0]);
  assert.deepStrictEqual(realtime.parseMisLevels_(''), []);
  assert.deepStrictEqual(realtime.parseMisLevels_(null), []);
  assert.deepStrictEqual(realtime.parseMisLevels_(undefined), []);
  assert.deepStrictEqual(realtime.parseMisLevels_('100.5_'), [100.5], '尾端空字串要被濾掉，不要混進一個 NaN');
  console.log('Test parseMisLevels_ (splits on underscore, drops trailing empty, handles null/empty) passed.');
}

// --- computeBuySellVerdict_ ---
{
  assert.deepStrictEqual(
    realtime.computeBuySellVerdict_(null, 100, 105, 95),
    { score: null, label: '⚪ 資料不足', detail: '目前五檔掛單量都是 0，無法計算買賣力道評估。' },
    'buyRatio 是 null（五檔都是 0）時要回報資料不足，不是算出一個假分數'
  );

  // buyRatio=1（全部都是委買）、現價在當日最低點 -> pressureScore=100, rangeScore=100 -> score=100
  const strong = realtime.computeBuySellVerdict_(1, 95, 105, 95);
  assert.strictEqual(strong.score, 100);
  assert.strictEqual(strong.label, '🟢 偏向有利買進');

  // buyRatio=0（全部都是委賣）、現價在當日最高點 -> pressureScore=0, rangeScore=0 -> score=0
  const weak = realtime.computeBuySellVerdict_(0, 105, 105, 95);
  assert.strictEqual(weak.score, 0);
  assert.strictEqual(weak.label, '🔴 偏向有利賣出');

  // buyRatio=0.5 且價位在正中間 -> score=50 -> 多空不明顯
  const neutral = realtime.computeBuySellVerdict_(0.5, 100, 105, 95);
  assert.strictEqual(neutral.score, 50);
  assert.strictEqual(neutral.label, '⚪ 多空不明顯');

  // high === low（剛開盤還沒有價格波動）：rangeScore 給中性值 50，不除以 0
  const noRange = realtime.computeBuySellVerdict_(1, 100, 100, 100);
  assert.strictEqual(noRange.score, 80, 'pressureScore=100*0.6 + rangeScore=50*0.4 = 80');

  // 邊界分數：high===low 時 rangeScore 固定 50（貢獻 20 分），buyRatio=0.75
  // 時 pressureScore=75（貢獻 45 分）剛好湊出 score=65.0（買進門檻）；
  // buyRatio=0.25 剛好湊出 score=35.0（賣出門檻）。
  assert.strictEqual(realtime.computeBuySellVerdict_(0.75, 100, 100, 100).score, 65);
  assert.strictEqual(realtime.computeBuySellVerdict_(0.75, 100, 100, 100).label, '🟢 偏向有利買進');
  assert.strictEqual(realtime.computeBuySellVerdict_(0.25, 100, 100, 100).score, 35);
  assert.strictEqual(realtime.computeBuySellVerdict_(0.25, 100, 100, 100).label, '🔴 偏向有利賣出');
  console.log('Test computeBuySellVerdict_ (pressure/range weighting, neutral high===low guard, score thresholds) passed.');
}

// --- computeBookSpreadAndMidpoint_ ---
{
  const bidLevels = [{ price: 100, volume: 10 }, { price: 99.5, volume: 20 }];
  const askLevels = [{ price: 101, volume: 5 }, { price: 101.5, volume: 15 }];
  assert.deepStrictEqual(
    realtime.computeBookSpreadAndMidpoint_(bidLevels, askLevels),
    { spread: 1, midpointEstimate: 100.5 }
  );

  assert.deepStrictEqual(
    realtime.computeBookSpreadAndMidpoint_([], askLevels),
    { spread: null, midpointEstimate: null },
    '買方完全沒有掛單（例如跌停鎖死）時不該硬算出一個沒意義的價差'
  );
  assert.deepStrictEqual(
    realtime.computeBookSpreadAndMidpoint_(bidLevels, []),
    { spread: null, midpointEstimate: null },
    '賣方完全沒有掛單（例如漲停鎖死）時同樣要回傳 null'
  );
  assert.deepStrictEqual(
    realtime.computeBookSpreadAndMidpoint_([{ price: 0, volume: 0 }], askLevels),
    { spread: null, midpointEstimate: null },
    '最佳買價是 0（視同沒有掛單）也要回傳 null，不是當成真的 0 元委買'
  );
  console.log('Test computeBookSpreadAndMidpoint_ (spread/midpoint from best bid/ask, null when either side empty) passed.');
}

console.log('All realtime.js tests passed.');
