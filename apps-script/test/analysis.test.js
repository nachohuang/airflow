/**
 * 用 vm 把 Config.gs + Utils.gs + Analysis.gs 一起載進同一個 global scope 模擬 Apps Script
 * 的共用全域環境，藉此在 Node 直接測 computeFactors_ / diagnoseRow_ 這兩個純運算函式，
 * 不用真的部署到 Apps Script 才能驗證 v17.0 邏輯有沒有翻譯正確。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const context = {
  console: console,
  module: undefined // block the Utils.gs node-export branch, keep functions as plain globals
};
vm.createContext(context);

function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}

loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('Analysis.gs');

function approxEqual(a, b, eps) {
  eps = eps || 1e-6;
  return Math.abs(a - b) < eps;
}

function buildSyntheticHistory(days) {
  const rows = [];
  const start = new Date(2026, 0, 1);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    rows.push({
      '日期': dateStr,
      '證券代號': '2330',
      '證券名稱': '台積電',
      '外資': 50000,
      '投信': 100000,
      '自營商': 0,
      '三大法人買賣超股數': 150000,
      '成交股數': 5000000,
      '成交筆數': 10000,
      '成交金額': 100000000, // 一定超過 LIQUIDITY_MIN
      '開盤價': 20 + i * 0.3,
      '最高價': 20 + i * 0.3 + 0.5,
      '最低價': 20 + i * 0.3 - 0.5,
      '收盤價': 20 + i * 0.3, // 穩定上升
      '漲跌(+/-)': '+',
      '漲跌價差': 0.3,
      '最後揭示買價': 20 + i * 0.3,
      '最後揭示買量': 100,
      '最後揭示賣價': 20 + i * 0.3 + 0.1,
      '最後揭示賣量': 100,
      '殖利率(%)': 2.0,
      '本益比': 15,
      '股價淨值比': 3,
      '財報年/季': '2026Q1'
    });
  }
  return rows;
}

// --- 1. Armor_Score 應該在資料不足 20 天前是 null，之後變成數字 ---
{
  const rows = buildSyntheticHistory(40);
  const computed = context.computeFactors_(rows, {});
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);

  for (let i = 0; i < 18; i++) {
    assert.strictEqual(sorted[i].Armor_Score, null, 'day ' + i + ' 應該還沒有足夠資料算 Armor_Score');
  }
  const last = sorted[sorted.length - 1];
  assert.ok(typeof last.Armor_Score === 'number', '第 40 天應該已經有 Armor_Score');
  assert.ok(last.Trend_Score === 2, '持續上漲應該站上均線且均線向上，Trend_Score=2');
  console.log('Test 1 (Armor_Score availability) passed. last Armor_Score =', last.Armor_Score);
}

// --- 2. diagnoseRow_：無持股、量價齊揚 -> 應該給「🚀 趨勢啟動」（單一股票橫斷面排名必為 1.0）---
{
  const rows = buildSyntheticHistory(40);
  const computed = context.computeFactors_(rows, {});
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  assert.ok(approxEqual(last.Inst_Part_Rank, 1.0), '單一股票橫斷面排名應為 1.0');
  assert.ok(approxEqual(last.Vol_Ratio_Rank, 1.0));

  const diag = context.diagnoseRow_(last, {});
  assert.strictEqual(diag.strategy, '🚀 趨勢啟動');
  assert.strictEqual(diag.action, '建議：現價買入');
  console.log('Test 2 (diagnose - no holding, breakout) passed:', diag.strategy);
}

// --- 3. diagnoseRow_：有持股且從高點回落超過停損％ -> 應該給「止盈/止損」---
{
  const rows = buildSyntheticHistory(40);
  // 製造最後一天大跌，模擬從高點拉回
  rows[rows.length - 1]['收盤價'] = 20 + 38 * 0.3 * 0.9; // 大幅回落
  const portfolioMap = { '2330': { cost: 10, buyDate: rows[0]['日期'] } };
  const computed = context.computeFactors_(rows, portfolioMap);
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  const diag = context.diagnoseRow_(last, portfolioMap);
  assert.strictEqual(diag.strategy, '🛑 止盈/止損');
  assert.strictEqual(diag.action, '建議：賣出');
  console.log('Test 3 (diagnose - trailing stop triggered) passed:', diag.strategy, diag.interpretation);
}

// --- 4. diagnoseRow_：有持股、穩定持有中（未觸發停損）-> 「持股守護」，損益計算正確 ---
{
  const rows = buildSyntheticHistory(40);
  const portfolioMap = { '2330': { cost: 15, buyDate: rows[0]['日期'] } };
  const computed = context.computeFactors_(rows, portfolioMap);
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  const diag = context.diagnoseRow_(last, portfolioMap);
  assert.strictEqual(diag.strategy, '🛡️ 持股守護');
  const expectedProfit = ((last['收盤價'] - 15) / 15) * 100;
  assert.ok(diag.interpretation.indexOf(expectedProfit.toFixed(1)) !== -1, diag.interpretation);
  console.log('Test 4 (diagnose - holding, no stop) passed:', diag.strategy, diag.interpretation);
}

// --- 5. computeFactors_ 應該補齊完整匯出用的中間欄位（跟原本 xlsx 戰報的欄位對齊）---
{
  const rows = buildSyntheticHistory(40);
  const computed = context.computeFactors_(rows, {});
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];

  ['Inst_Net', 'Is_Drop', 'Is_Inst_Buy_On_Drop', 'MA20_Slope', 'Vol_MA20'].forEach(function (field) {
    assert.ok(last.hasOwnProperty(field), 'computeFactors_ 應該要有欄位 ' + field);
  });
  assert.ok(typeof last.Inst_Net === 'number');
  console.log('Test 5 (computeFactors_ full export fields) passed.');
}

// --- 6. buildFullReportRow_ 應該產出跟 CONFIG.FULL_REPORT_COLUMNS 完全一致的欄位（供 xlsx 匯出比對）---
{
  const rows = buildSyntheticHistory(40);
  const computed = context.computeFactors_(rows, {});
  const sorted = context.sortRows(computed, [[function (r) { return r['日期']; }, 'asc']]);
  const last = sorted[sorted.length - 1];
  const diag = context.diagnoseRow_(last, {});
  const fullRow = context.buildFullReportRow_(last, diag);

  const expectedKeys = Array.from(context.CONFIG.FULL_REPORT_COLUMNS);
  const actualKeys = Object.keys(fullRow);
  assert.deepStrictEqual(actualKeys, expectedKeys);
  assert.strictEqual(fullRow['操作策略'], diag.strategy);
  console.log('Test 6 (buildFullReportRow_ matches FULL_REPORT_COLUMNS) passed.');
}

console.log('All Analysis.gs tests passed.');
