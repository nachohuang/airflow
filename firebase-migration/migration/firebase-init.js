/**
 * firebase-init.js
 * 共用的 Firestore 初始化邏輯，import-firestore.js／validate.js 都靠這支拿到
 * db 物件。刻意明確傳入 projectId，不完全依賴 firebase-admin 自動偵測——用
 * `gcloud auth application-default login` 產生的使用者憑證（Cloud Shell 預設
 * 就是這種）不像服務帳戶金鑰檔案一樣，本身就帶著 project_id，沒有明確傳入的話
 * 常常會連錯專案，或直接初始化失敗。
 *
 * 專案 ID 決定順序：
 *   1. GOOGLE_CLOUD_PROJECT／GCLOUD_PROJECT 環境變數（Cloud Shell 執行過
 *      `gcloud config set project` 之後，這兩個環境變數會自動帶上）
 *   2. 這裡的預設值（跟 ../.firebaserc 裡設定的專案一致，本機沒特別設環境
 *      變數時的保險）
 *
 * 憑證來源（firebase-admin 的 applicationDefault()）：
 *   - Cloud Shell／本機跑過 `gcloud auth application-default login`：不用
 *     額外設定，直接讀 gcloud 產生的使用者憑證。
 *   - 本機用服務帳戶金鑰檔案：設環境變數 GOOGLE_APPLICATION_CREDENTIALS 指到
 *     金鑰檔案路徑。
 *   兩種方式這支程式碼完全不用分別處理，applicationDefault() 自己會找。
 */
var DEFAULT_PROJECT_ID = 'flash-arbor-365706';

function getFirestore() {
  var admin = require('firebase-admin');
  if (admin.apps.length === 0) {
    var projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || DEFAULT_PROJECT_ID;
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: projectId
    });
    console.error('[firebase-init] 連線到專案：' + projectId);
  }
  return admin.firestore();
}

module.exports = { getFirestore: getFirestore, DEFAULT_PROJECT_ID: DEFAULT_PROJECT_ID };
