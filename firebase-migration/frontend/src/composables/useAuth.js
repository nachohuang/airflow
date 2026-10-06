/**
 * useAuth.js
 * 全域（singleton）的登入狀態——onAuthStateChanged 在這個檔案第一次被 import
 * 時就訂閱一次，整個 App 共用同一份 currentUser，不是每個元件各自訂閱一次。
 * 真正的存取控制不在這裡：這裡只負責「有沒有登入」，「登入的是不是擁有者本人」
 * 交給 Cloud Functions 的 assertOwnerAuth_ 去擋（見 functions/index.js），前端
 * 這層就算被繞過也不會有資料外洩或竄改的風險。
 */
import { ref } from 'vue';
import { onAuthStateChanged, signInWithPopup, signOut as firebaseSignOut } from 'firebase/auth';
import { auth, googleProvider } from '../firebase';

const currentUser = ref(null);
const authReady = ref(false);

onAuthStateChanged(auth, function (user) {
  currentUser.value = user;
  authReady.value = true;
});

export function useAuth() {
  async function signIn() {
    await signInWithPopup(auth, googleProvider);
  }
  async function signOut() {
    await firebaseSignOut(auth);
  }
  return { currentUser, authReady, signIn, signOut };
}
