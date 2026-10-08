const assert = require('assert');
const fs = require('../lib/factorScan');

// --- 1. computeStreak_ ---
{
  assert.deepStrictEqual(fs.computeStreak_([1, 1, 0, 1, 1, 1, 0]), [1, 2, 0, 1, 2, 3, 0]);
  assert.deepStrictEqual(fs.computeStreak_([0, 0, 0]), [0, 0, 0]);
  assert.deepStrictEqual(fs.computeStreak_([]), []);
  console.log('Test computeStreak_ (accumulates while tag=1, resets on 0) passed.');
}

// --- 2. computeFactorScanFields_：單一股票，驗證補齊的欄位型態跟排序 ---
{
  function row(date, close, instTrust, instForeign, instDealer) {
    return {
      '證券代號': '1234', '日期': date, '收盤價': close,
      '成交股數': 1000000, '成交金額': 100000000,
      '投信': instTrust || 0, '外資': instForeign || 0, '自營商': instDealer || 0,
      '最後揭示買量': 100, '最後揭示賣量': 100
    };
  }
  // 刻意把輸入順序打亂，驗證 computeFactorScanFields_ 自己會依日期重新排序
  var rows = [
    row('2026-01-03', 102),
    row('2026-01-01', 100, 1000),
    row('2026-01-02', 101, -500)
  ];
  var computed = fs.computeFactorScanFields_(rows);
  assert.strictEqual(computed.length, 3);
  assert.deepStrictEqual(computed.map(function (r) { return r['日期']; }), ['2026-01-01', '2026-01-02', '2026-01-03'], '要依日期由舊到新排序');

  computed.forEach(function (r) {
    ['IBF_20D', 'Safety_Rank', 'Inst_Streak', 'Inst_Participation', 'Trend_Score', 'Next_5D_Return'].forEach(function (f) {
      assert.ok(f in r, '每一列都要補上 ' + f + ' 欄位（值可能是 null，但欄位要存在）');
    });
  });
  // 第一天法人淨買超 1000 > 0，連續天數從 1 開始
  assert.strictEqual(computed[0].Inst_Streak, 1);
  // 第二天法人淨賣超 -500 < 0，連續天數歸零
  assert.strictEqual(computed[1].Inst_Streak, 0);
  // 只有 3 天資料，位移 5 天後的未來收盤價查不到，Next_5D_Return 應該全部是 null
  computed.forEach(function (r) { assert.strictEqual(r.Next_5D_Return, null); });
  console.log('Test computeFactorScanFields_ (sorts by date, fills every research field, computes streak) passed.');
}

// --- 3. computeFactorScanFields_：代號不是 4 碼的列要被濾掉（跟 stocksOnly 同一個規則）---
{
  var rows = [
    { '證券代號': '00001T', '日期': '2026-01-01', '收盤價': 10, '成交股數': 1000, '成交金額': 10000, '投信': 0, '外資': 0, '自營商': 0, '最後揭示買量': 0, '最後揭示賣量': 0 },
    { '證券代號': '1234', '日期': '2026-01-01', '收盤價': 10, '成交股數': 1000, '成交金額': 10000, '投信': 0, '外資': 0, '自營商': 0, '最後揭示買量': 0, '最後揭示賣量': 0 }
  ];
  var computed = fs.computeFactorScanFields_(rows);
  assert.strictEqual(computed.length, 1);
  assert.strictEqual(computed[0]['證券代號'], '1234');
  console.log('Test computeFactorScanFields_ (filters out non-4-digit codes, e.g. warrants) passed.');
}

// --- 4. computeFactorCorrelations_：足夠資料量時能算出相關係數，且排序由大到小 ---
{
  // 建構一批合成資料：Inst_Participation 跟 Next_5D_Return 完美正相關，其餘因子固定值（相關係數算不出來，回傳 null）。
  var rows = [];
  for (var i = 0; i < 10; i++) {
    rows.push({
      Next_5D_Return: i * 0.01,
      Safety_Rank: 50, // 非 null，才會被 computeFactorCorrelations_ 篩進 validScan
      Inst_Streak: 1,
      Inst_Participation: i * 0.01, // 跟 Next_5D_Return 完全同步變化 -> 相關係數 1
      Trend_Score: 1,
      IBF_20D: 0.5
    });
  }
  var result = fs.computeFactorCorrelations_(rows);
  assert.strictEqual(result.sampleSize, 10);
  assert.strictEqual(result.correlations.length, fs.FACTOR_SCAN_CANDIDATE_FACTORS.length);
  assert.strictEqual(result.correlations[0].factor, 'Inst_Participation', 'Inst_Participation 跟目標完全正相關，應該排第一');
  assert.ok(Math.abs(result.correlations[0].correlation - 1) < 1e-9);
  // Inst_Streak/Trend_Score/IBF_20D 全部是常數，標準差是 0，相關係數算不出來 -> null
  var constantFactors = result.correlations.filter(function (c) { return c.factor !== 'Inst_Participation'; });
  constantFactors.forEach(function (c) { assert.strictEqual(c.correlation, null); });
  console.log('Test computeFactorCorrelations_ (computes correlation, sorts descending, null for constant series) passed.');
}

// --- 5. computeFactorCorrelations_：資料量不足（沒有任何一列同時有 Next_5D_Return 跟 Safety_Rank）---
{
  var rows = [{ Next_5D_Return: null, Safety_Rank: 50 }, { Next_5D_Return: 0.01, Safety_Rank: null }];
  var result = fs.computeFactorCorrelations_(rows);
  assert.strictEqual(result.sampleSize, 0);
  assert.deepStrictEqual(result.correlations, []);
  assert.ok(result.warning, '資料量不足要帶說明文字，不是靜默回傳空結果');
  console.log('Test computeFactorCorrelations_ (insufficient data -> warning, no silent empty result) passed.');
}
