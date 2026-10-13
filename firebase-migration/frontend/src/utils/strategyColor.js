/**
 * strategyColor.js
 * 跟舊版 apps-script/src/JavaScript.html 的 STRATEGY_HINT 同一份對照表
 * （操作策略字串 -> 顏色），用在戰報卡片／持股卡片／觀察清單卡片的策略
 * 文字上——舊版這樣做是為了讓使用者掃過一排卡片就能用顏色分辨「這是止損
 * 警示還是加碼訊號」，不用每筆都讀文字。字串本身跟
 * functions/lib/analysis.js 的 classifyEntrySignal_/diagnoseRow_ 寫死的
 * 四種 operating strategy 文案一致，那邊改了這裡要跟著改。
 */
const STRATEGY_COLOR = {
  '🛑 止盈/止損': 'var(--red)',
  '🛡️ 持股守護': 'var(--green)',
  '🚀 趨勢啟動': 'var(--accent)',
  '🔥 趨勢領航': 'var(--amber)',
  // 2026-10-13 新增：對應 functions/lib/analysis.js SCREENING_STRATEGIES
  // 的 early_accumulation（潛伏期）——趨勢還沒確立，刻意不用跟「趨勢啟動／
  // 趨勢領航」同一組偏「確定」的顏色，用比標題文字更淡的 --text（這個
  // CSS 變數集目前沒有專門的「中性/muted」token，--text 本來就是比
  // --text-h 更淡的本文顏色，拿來表達「這是比較早期、風險較高的訊號」，
  // 不是已經確認的進場訊號，已經夠用）。
  '🌱 潛伏期': 'var(--text)'
};

export function strategyColor(strategy) {
  return STRATEGY_COLOR[strategy] || 'var(--text-h)';
}
