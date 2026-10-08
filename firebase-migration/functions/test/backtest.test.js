const assert = require('assert');
const bt = require('../lib/backtest');

// --- 1. simulateTradeForward_：達標出場 ---
{
  var track = [
    { '日期': '2026-01-05', '收盤價': 100 },
    { '日期': '2026-01-06', '收盤價': 102 }, // +2%，未達標
    { '日期': '2026-01-07', '收盤價': 106 }, // +6%，達標（目標 5%）
    { '日期': '2026-01-08', '收盤價': 110 }  // 不該被追蹤到這裡，已經在前一天出場
  ];
  var sim = bt.simulateTradeForward_(track, 0, 5, 0.025, 40);
  assert.strictEqual(sim.exitLabel, '🎯 達標');
  assert.strictEqual(sim.exitDate, '2026-01-07');
  assert.strictEqual(sim.daysHeld, 2);
  assert.strictEqual(sim.finalReturnPct, 6);
  console.log('Test simulateTradeForward_ (hits target profit, exits that day) passed.');
}

// --- 2. simulateTradeForward_：移動停損出場（從高點回落） ---
{
  var track = [
    { '日期': '2026-01-05', '收盤價': 100 },
    { '日期': '2026-01-06', '收盤價': 103 }, // 新高點 103
    { '日期': '2026-01-07', '收盤價': 100 }  // 從 103 回落到 100，回落 2.91% >= 2.5% 門檻，觸發止損
  ];
  var sim = bt.simulateTradeForward_(track, 0, 5, 0.025, 40);
  assert.strictEqual(sim.exitLabel, '🛑 止損');
  assert.strictEqual(sim.exitDate, '2026-01-07');
  assert.ok(sim.worstDrawdownPct >= 2.5);
  console.log('Test simulateTradeForward_ (trailing stop triggers on drawdown from peak) passed.');
}

// --- 3. simulateTradeForward_：追蹤天數用完都沒觸發，停在最後一天 ---
{
  var track = [
    { '日期': '2026-01-05', '收盤價': 100 },
    { '日期': '2026-01-06', '收盤價': 101 },
    { '日期': '2026-01-07', '收盤價': 102 }
  ];
  var sim = bt.simulateTradeForward_(track, 0, 50, 0.5, 40); // 目標跟停損門檻都設很寬，不會被觸發
  assert.strictEqual(sim.exitLabel, '⏳ 未觸發出場');
  assert.strictEqual(sim.exitDate, '2026-01-07', '資料用完就停在最後一筆');
  console.log('Test simulateTradeForward_ (runs out of tracked days without triggering exit) passed.');
}

// --- 4. simulateTradeForward_：進場當天收盤價是 0/無效值，回傳 null ---
{
  var track = [{ '日期': '2026-01-05', '收盤價': 0 }, { '日期': '2026-01-06', '收盤價': 100 }];
  assert.strictEqual(bt.simulateTradeForward_(track, 0, 5, 0.025, 40), null);
  console.log('Test simulateTradeForward_ (invalid entry price returns null) passed.');
}

// --- 5. validateBacktestRange_ ---
{
  assert.deepStrictEqual(bt.validateBacktestRange_('2026-01-01', '2026-01-31'), { ok: true });
  assert.ok(bt.validateBacktestRange_('2026-02-01', '2026-01-01').error, '結束日早於起始日要回傳錯誤');
  assert.ok(bt.validateBacktestRange_('2026-01-01', '2026-12-31').error, '超過 BACKTEST_MAX_RANGE_DAYS 要回傳錯誤');
  console.log('Test validateBacktestRange_ (ok / negative range / too-large range) passed.');
}

// --- 6. computeBacktestLoadEndStr_ ---
{
  var loadEnd = bt.computeBacktestLoadEndStr_('2026-01-31');
  assert.ok(loadEnd > '2026-01-31', '要往後延伸，蓋過最大持有天數的追蹤緩衝');
  console.log('Test computeBacktestLoadEndStr_ (extends past endStr for trade-tracking buffer) passed.');
}

// --- 7. simulateBacktestForStrategy_：完整跑一次 rule_v17，驗證訊號辨識+交易模擬+彙總統計 ---
{
  function row(date, close, overrides) {
    return Object.assign({
      '證券代號': '1234', '證券名稱': '測試股', '日期': date, '收盤價': close,
      '成交金額': 100000000, 'Trend_Score': 0, 'Inst_Part_Rank': 0, 'Vol_Ratio_Rank': 0, 'IBF_20D_Rank': 0
    }, overrides || {});
  }
  var rows = [
    row('2026-01-05', 100, { 'Trend_Score': 2, 'Inst_Part_Rank': 0.9, 'Vol_Ratio_Rank': 0.9, 'IBF_20D_Rank': 0.9 }), // 🚀 訊號日
    row('2026-01-06', 102),
    row('2026-01-07', 106), // +6%，達標出場
    row('2026-01-08', 110)
  ];
  var result = bt.simulateBacktestForStrategy_(rows, '2026-01-05', '2026-01-05', 5, 'rule_v17');
  assert.strictEqual(result.trades.length, 1);
  assert.strictEqual(result.trades[0].code, '1234');
  assert.strictEqual(result.trades[0].entryStrategy, '🚀 趨勢啟動');
  assert.strictEqual(result.trades[0].exitLabel, '🎯 達標');
  assert.strictEqual(result.summary.signalCount, 1);
  assert.strictEqual(result.summary.winRate, 100);
  assert.strictEqual(result.summary.targetHitRate, 100);
  console.log('Test simulateBacktestForStrategy_ (recognizes signal, simulates trade, aggregates summary) passed.');
}

// --- 8. simulateBacktestForStrategy_：區間內沒有任何訊號，回傳 warning 不是空陣列就沒說明 ---
{
  function neutralRow(date) {
    return { '證券代號': '1234', '證券名稱': '測試股', '日期': date, '收盤價': 100, '成交金額': 100000000 };
  }
  var rows = [neutralRow('2026-01-05'), neutralRow('2026-01-06')];
  var result = bt.simulateBacktestForStrategy_(rows, '2026-01-05', '2026-01-06', 5, 'rule_v17');
  assert.strictEqual(result.trades.length, 0);
  assert.strictEqual(result.summary, null);
  assert.ok(result.warning, '沒有訊號要帶說明文字，不是靜默回傳空結果');
  console.log('Test simulateBacktestForStrategy_ (no signals in range -> warning, no summary) passed.');
}
