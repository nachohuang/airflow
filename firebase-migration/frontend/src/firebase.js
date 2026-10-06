/**
 * firebase.js
 * Firebase 客戶端 SDK 初始化（跟 functions/ 底下用 firebase-admin 的伺服端初始化
 * 完全是兩套東西，不要搞混——這份是瀏覽器端用的，權限等級低很多，所有真正的
 * 存取控制都在 Cloud Functions 那端的 assertOwnerAuth_ 跟 Firestore Security
 * Rules，不是靠這裡藏什麼東西）。
 *
 * 設定值從 Vite 的環境變數讀（VITE_ 開頭才會被打包進前端，見 .env.example），
 * 不要把這些值寫死在程式碼裡——雖然 Firebase 的 apiKey 本來就不是機密（它只是
 * 用來識別專案，不是認證用的密鑰，真正的存取控制在 Security Rules／Cloud
 * Functions），但不同環境（例如之後如果要做 staging）要能換設定檔，不用改程式碼。
 */
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFunctions } from 'firebase/functions';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  // eslint-disable-next-line no-console
  console.error(
    '缺少 Firebase 設定——請在 frontend/.env（複製 .env.example 改）填入 VITE_FIREBASE_* 這幾個值，' +
      '從 Firebase Console → 專案設定 → 一般 → 「你的應用程式」（如果還沒註冊過網頁應用程式，先註冊一個）複製。'
  );
}

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

/** 戰報（`reports/{date}/signals`）是唯讀的衍生資料，`firestore.rules` 已經開放
 *  擁有者直接讀（見 schema.md §3／rules 的 `match /reports/{date}`），不需要像
 *  Watchlist/Portfolio 那樣繞道 onCall function——前端直接用 Firestore client SDK
 *  讀（甚至可以用 onSnapshot 即時監聽），比多開一支 Cloud Function 再轉一手簡單。 */
export const db = getFirestore(app);

/** index.js 的 RUNTIME_OPTS_ 沒指定 region，v2 function 預設部署在 us-central1——
 *  這裡要跟後端部署的 region 對上，不對會打到一個不存在的 endpoint。 */
export const functions = getFunctions(app, import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || 'us-central1');
