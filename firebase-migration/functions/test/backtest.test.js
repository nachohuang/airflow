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

// --- 9. resolveExitParams_：trust_momentum 有專屬覆寫，其他策略退回共用預設值 ---
{
  assert.deepStrictEqual(bt.resolveExitParams_('trust_momentum'), { maxHoldDays: 20, minHoldDaysBeforeStop: 15, catastrophicStopPct: 0.1 });
  assert.deepStrictEqual(bt.resolveExitParams_('rule_v17'), { maxHoldDays: bt.BACKTEST_MAX_HOLD_DAYS, minHoldDaysBeforeStop: 0, catastrophicStopPct: null });
  assert.deepStrictEqual(bt.resolveExitParams_('composite_accumulation'), { maxHoldDays: bt.BACKTEST_MAX_HOLD_DAYS, minHoldDaysBeforeStop: 0, catastrophicStopPct: null });
  console.log('Test resolveExitParams_ (trust_momentum override vs default fallback for every other strategy) passed.');
}

// --- 10. simulateTradeForward_：minHoldDaysBeforeStop 延後移動停損，但不影響達標出場；
//         catastrophicStopPct 讓保護期內的「毀滅性」崩跌還是會立刻出場，不是完全不設防 ---
{
  // 沒帶 minHoldDaysBeforeStop（沿用舊行為）：從高點 103 回落到 100（2.91%）第 2 天就停損出場。
  var track = [
    { '日期': '2026-02-01', '收盤價': 100 },
    { '日期': '2026-02-02', '收盤價': 103 },
    { '日期': '2026-02-03', '收盤價': 100 },
    { '日期': '2026-02-04', '收盤價': 100 },
    { '日期': '2026-02-05', '收盤價': 100 }
  ];
  var simNoOverride = bt.simulateTradeForward_(track, 0, 50, 0.025, 10);
  assert.strictEqual(simNoOverride.exitLabel, '🛑 止損');
  assert.strictEqual(simNoOverride.daysHeld, 2, '沒給 minHoldDaysBeforeStop 要維持原本「立刻停損」的行為');

  // 同一組資料，只給 minHoldDaysBeforeStop=3、不給 catastrophicStopPct：
  // 保護期內完全不檢查停損（純函式本身的預設行為——是否要設防由呼叫端決定，
  // 見 resolveExitParams_ 怎麼幫 trust_momentum 固定帶一個具體門檻）。
  var simWithOverride = bt.simulateTradeForward_(track, 0, 50, 0.025, 10, 3);
  assert.strictEqual(simWithOverride.exitLabel, '🛑 止損');
  assert.strictEqual(simWithOverride.daysHeld, 3, '沒給 catastrophicStopPct，minHoldDaysBeforeStop 應該完全關掉停損到保護期結束');

  // 達標出場不受 minHoldDaysBeforeStop 影響：就算設定很長的保護期，提早達標還是立刻出場。
  var targetTrack = [
    { '日期': '2026-02-01', '收盤價': 100 },
    { '日期': '2026-02-02', '收盤價': 110 } // +10%，達標
  ];
  var simTarget = bt.simulateTradeForward_(targetTrack, 0, 5, 0.025, 20, 15);
  assert.strictEqual(simTarget.exitLabel, '🎯 達標');
  assert.strictEqual(simTarget.daysHeld, 1, '達標出場不該被 minHoldDaysBeforeStop 擋住');

  // 2026-11-13 新增：保護期內出現「毀滅性」崩跌（15% 回落 >= 10% 的 catastrophicStopPct）
  // 要立刻出場，不是放到保護期結束才檢查——這是修正第一版「保護期內完全不設防」
  // 導致真實回測量到 44% 最大回落的那個 bug。
  var crashTrack = [
    { '日期': '2026-02-01', '收盤價': 100 },
    { '日期': '2026-02-02', '收盤價': 85 } // -15%，超過 10% 的毀滅性停損門檻
  ];
  var simCatastrophic = bt.simulateTradeForward_(crashTrack, 0, 50, 0.025, 20, 15, 0.1);
  assert.strictEqual(simCatastrophic.exitLabel, '🛑 止損');
  assert.strictEqual(simCatastrophic.daysHeld, 1, '保護期內的毀滅性崩跌應該立刻出場，不等保護期結束');

  // 同一個保護期、同一個 catastrophicStopPct，但只是中等回落（5% < 10%）：
  // 保護期內應該撐過去，不會被毀滅性停損誤觸發（跟一般 2.5% 門檻比起來是更寬的門檻，
  // 不是更嚴）。
  var moderateTrack = [
    { '日期': '2026-02-01', '收盤價': 100 },
    { '日期': '2026-02-02', '收盤價': 95 }, // -5%，低於 10% 門檻，保護期內不出場
    { '日期': '2026-02-03', '收盤價': 95 }
  ];
  var simModerate = bt.simulateTradeForward_(moderateTrack, 0, 50, 0.025, 20, 15, 0.1);
  assert.strictEqual(simModerate.exitLabel, '⏳ 未觸發出場', '保護期內中等回落（低於毀滅性門檻）不該被誤觸發出場');
  console.log('Test simulateTradeForward_ (minHoldDaysBeforeStop delays trailing stop, catastrophicStopPct still catches severe drawdowns, target-profit exit unaffected) passed.');
}

// --- 11. simulateBacktestForStrategy_：trust_momentum 透過 resolveExitParams_ 真的套用到完整流程，其他策略不受影響 ---
{
  function momentumRow(date, close, overrides) {
    return Object.assign({
      '證券代號': '5678', '證券名稱': '動能測試股', '日期': date, '收盤價': close,
      '成交金額': 100000000, 'Trend_Score': 0, 'Inst_Part_Rank': 0, 'Vol_Ratio_Rank': 0, 'IBF_20D_Rank': 0,
      'Trust_Buy_Streak_Rank': 0
    }, overrides || {});
  }
  // 16 個交易日：第 0 天進場，第 1 天衝高到 103，第 2 天起回落到 100（跌幅 2.91%：
  // 超過一般 2.5% 門檻，但低於保護期內 10% 的毀滅性停損門檻）並一路持平到第 15 天——
  // 一般規則第 2 天就該停損，trust_momentum 的保護期內這個跌幅不算毀滅性、應該撐過去，
  // 直到第 15 天保護期結束、切回 2.5% 敏感門檻才觸發停損。
  var rows = [momentumRow('2026-03-01', 100, { 'Trend_Score': 1, 'Trust_Buy_Streak_Rank': 0.9 })];
  for (var d = 1; d <= 15; d++) {
    var dateStr = '2026-03-' + String(d + 1).padStart(2, '0');
    rows.push(momentumRow(dateStr, d === 1 ? 103 : 100));
  }
  var momentumResult = bt.simulateBacktestForStrategy_(rows, '2026-03-01', '2026-03-01', 5, 'trust_momentum');
  assert.strictEqual(momentumResult.trades.length, 1);
  assert.strictEqual(momentumResult.trades[0].exitLabel, '🛑 止損');
  assert.strictEqual(momentumResult.trades[0].daysHeld, 15, 'trust_momentum 應該把停損延到保護期（15 天）結束才觸發');

  // 同一組價格走勢，換成 rule_v17 的進場條件、strategyKey 也改成 rule_v17：
  // 沒有專屬覆寫，應該維持原本「第 2 天立刻停損」的行為，證明這個改動沒有動到其他策略。
  var ruleRows = rows.map(function (r, i) {
    return i === 0
      ? Object.assign({}, r, { 'Trend_Score': 2, 'Inst_Part_Rank': 0.9, 'Vol_Ratio_Rank': 0.9, 'IBF_20D_Rank': 0.9 })
      : r;
  });
  var ruleResult = bt.simulateBacktestForStrategy_(ruleRows, '2026-03-01', '2026-03-01', 5, 'rule_v17');
  assert.strictEqual(ruleResult.trades.length, 1);
  assert.strictEqual(ruleResult.trades[0].exitLabel, '🛑 止損');
  assert.strictEqual(ruleResult.trades[0].daysHeld, 2, 'rule_v17 沒有專屬覆寫，應該維持原本立刻停損的行為');
  console.log('Test simulateBacktestForStrategy_ (trust_momentum exit override wired end-to-end, other strategies unaffected) passed.');
}

// --- 12. aggregateBacktestAcrossPeriods_：用這個 session 實際跑過的三段真實數字重建 ---
{
  function summaryRow(label, s) {
    return { strategyLabel: label, summary: s };
  }
  // trust_momentum 這個 session 實測過的三段真實結果：56 天區間墊底（29.68%／-0.17%／4.5）、
  // 07-23~08-31 最高（45.58%，沒有完整 avgReturn/avgDaysHeld 紀錄的那次就不編造，
  // 只用兩段有完整數字的真實資料＋一段模擬的「因子模型沒套用」錯誤，驗證三種情況都處理得到）。
  var periodResults = [
    {
      startDate: '2026-09-16', endDate: '2026-11-10',
      results: {
        trust_momentum: summaryRow('🏦 法人動能', { signalCount: 2864, winRate: 33.92, targetHitRate: 28, avgReturn: -0.17, avgDaysHeld: 4.5, maxDrawdown: 20 }),
        composite_accumulation: summaryRow('🧭 綜合吸籌', { signalCount: 188, winRate: 54.26, targetHitRate: 46.28, avgReturn: 2.14, avgDaysHeld: 5.3, maxDrawdown: 9.82 })
      }
    },
    {
      startDate: '2026-07-23', endDate: '2026-08-31',
      results: {
        trust_momentum: summaryRow('🏦 法人動能', { signalCount: 500, winRate: 45.58, targetHitRate: 40, avgReturn: 1.2, avgDaysHeld: 6, maxDrawdown: 11 }),
        composite_accumulation: summaryRow('🧭 綜合吸籌', { signalCount: 120, winRate: 43.21, targetHitRate: 38, avgReturn: 0.8, avgDaysHeld: 5, maxDrawdown: 10 })
      }
    },
    {
      // 第三段：composite_accumulation 這段因子模型沒套用（error），trust_momentum 正常有結果——
      // 驗證 error 這種「個別策略在個別期間跑不出來」的情況會被保留在 periods 裡，
      // 但不會汙染 aggregate（分母只看有 summary 的期間）。
      startDate: '2026-05-01', endDate: '2026-06-10',
      results: {
        trust_momentum: summaryRow('🏦 法人動能', { signalCount: 300, winRate: 38.55, targetHitRate: 33.45, avgReturn: -2.85, avgDaysHeld: 8.2, maxDrawdown: 18.95 }),
        composite_accumulation: { strategyLabel: '🧭 綜合吸籌', error: '需要先套用一版抗跌力因子迴歸模型。' }
      }
    }
  ];
  var agg = bt.aggregateBacktestAcrossPeriods_(periodResults);

  assert.strictEqual(agg.trust_momentum.periods.length, 3);
  assert.strictEqual(agg.trust_momentum.aggregate.periodsTested, 3);
  assert.strictEqual(agg.trust_momentum.aggregate.periodsWithSignal, 3);
  // (-0.17 + 1.2 + -2.85) / 3 = -0.6066... 四捨五入到小數點後兩位
  assert.strictEqual(agg.trust_momentum.aggregate.avgReturnMean, -0.61);
  assert.strictEqual(agg.trust_momentum.aggregate.maxDrawdownWorst, 20, '最大回落要取跨期最差，不是平均——一次嚴重回落不該被其他期間的溫和表現平均掉');
  assert.strictEqual(agg.trust_momentum.aggregate.positivePeriods, 1, '三段裡只有 07-23~08-31 那段平均報酬是正的');
  assert.strictEqual(agg.trust_momentum.aggregate.positiveRate, round(1 / 3 * 100, 1));

  assert.strictEqual(agg.composite_accumulation.periods.length, 3, '第三段的 error 要保留在 periods 裡，不是整個被排除');
  assert.strictEqual(agg.composite_accumulation.periods[2].error, '需要先套用一版抗跌力因子迴歸模型。');
  assert.strictEqual(agg.composite_accumulation.aggregate.periodsTested, 3);
  assert.strictEqual(agg.composite_accumulation.aggregate.periodsWithSignal, 2, '分母只算有 summary 的期間，不把 error 那段算進去');
  assert.strictEqual(agg.composite_accumulation.aggregate.positivePeriods, 2, '有 summary 的兩段都是正報酬');

  function round(v, d) { var m = Math.pow(10, d); return Math.round(v * m) / m; }
  console.log('Test aggregateBacktestAcrossPeriods_ (reconstructs this session\'s real trust_momentum/composite_accumulation multi-period numbers, worst-case max drawdown not averaged, error periods kept but excluded from aggregate denominator) passed.');
}
