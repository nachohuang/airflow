/**
 * useCallable.js
 * 呼叫 Cloud Functions onCall function 的統一入口，跟舊版 apps-script/src/
 * JavaScript.html 的 callServer() 是同一個精神（固定的逾時／錯誤處理，呼叫端
 * 不用每次自己重複寫 try/catch）——底層協定不一樣（這裡是 Firebase callable
 * SDK，不是 google.script.run），但對元件呼叫端要解決的問題是一樣的。
 *
 * err.message 就是 functions/index.js 用 HttpsError(code, message) 丟出來的
 * 中文訊息（例如 assertOwnerAuth_／assertNotHolding_ 的說明文字），SDK 收到
 * 之後包成 FirebaseError，直接顯示給使用者看即可，不用再另外翻譯一次。
 *
 * 2026-10-07 修正：預設 timeout 原本固定寫死 30 秒，但後端大多數 onCall
 * function 宣告的 timeoutSeconds 是 180 秒（見 index.js RUNTIME_OPTS_），
 * runHistoryBackfill 更是 540 秒——client 端的逾時比後端宣告的執行預算短
 * 很多，會導致後端其實還在正常跑、甚至已經跑完，前端卻先放棄顯示
 * 「deadline-exceeded」（使用者在「補抓區間」實際遇到的狀況）。改成預設
 * 跟著後端 RUNTIME_OPTS_ 的 180 秒走，呼叫端可以用第三個參數覆寫成更長
 * （例如 runHistoryBackfill 對應後端的 540 秒）。
 */
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

export async function callFn(name, data, timeoutMs) {
  const fn = httpsCallable(functions, name, { timeout: timeoutMs || 180000 });
  const res = await fn(data);
  return res.data;
}
