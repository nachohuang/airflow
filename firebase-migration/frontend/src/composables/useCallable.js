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
 */
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

export async function callFn(name, data) {
  const fn = httpsCallable(functions, name, { timeout: 30000 });
  const res = await fn(data);
  return res.data;
}
