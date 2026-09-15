# Firebase 遷移工具（Phase 1 / Phase 2 spike）

對應〈選股引擎遷移藍圖〉的 Phase 1（Firestore schema 設計）跟 Phase 2（資料遷移
工具＋資料品質驗證），先拿 Watchlist（觀察個股清單）當練手對象——資料量最小、
邏輯最單純，跑完整套流程就能實際估出其餘 11 張表大概要花多久，再回頭校準時程。

## 這裡有什麼

- `firestore/schema.md` — 全部 12 張表的 Firestore collection/document 結構設計
  （不只 Watchlist，整個遷移藍圖的資料模型都定案在這裡，後續階段照這份繼續）
- `firestore/firestore.rules` — Security Rules 草案，單一授權使用者的存取模型
- `migration/` — Watchlist 的匯出／匯入／驗證工具（這次 spike 唯一會**實際執行**
  的部分）
  - `transform.js` / `checks.js` — 純邏輯，不需要雲端憑證，有完整單元測試
  - `export-sheets.gs` — 貼進既有 Apps Script 專案手動執行一次
  - `import-firestore.js` / `validate.js` — 需要服務帳戶金鑰才能實際執行

## 你需要先做的事（Phase 0，只有你能做）

這邊沒有 Google/Firebase 帳號的登入憑證，以下步驟要你自己操作：

1. 到 [Firebase Console](https://console.firebase.google.com/) 建立一個新專案
   （或沿用現有跟 BigQuery 同一個 GCP 專案，見遷移藍圖 Phase 0 的建議，同一個
   計費帳戶比較好管理）。
2. 啟用 **Firestore Database**（Native mode，地區建議選 `asia-east1`，跟
   BigQuery 資料同一個亞洲區域，減少之後的跨區延遲/費用）。
3. 啟用 **Firebase Authentication**，開「Google 登入」，只需要能讓你自己的
   Google 帳號登入即可（單人工具，不用開放註冊）。
4. 產生一把**服務帳戶金鑰**（Project Settings → Service Accounts → Generate
   new private key），下載成一個 `.json` 檔案——這把金鑰能完全存取你的
   Firestore，**不要放進 git、不要外流**，本機隨便一個安全的路徑存著就好。
5. 把 `firestore/firestore.rules` 部署上去（Firebase Console 的 Firestore →
   規則分頁，直接貼上這份檔案的內容儲存；或裝 `firebase-tools` CLI 用
   `firebase deploy --only firestore:rules`）。

## 跑一次完整的 Watchlist 遷移 spike

```bash
cd firebase-migration
npm install          # 只有跑 import/validate 才需要 firebase-admin，純測試不用裝

# 1. 跑純邏輯測試，確認轉換/驗證邏輯本身沒問題（不需要任何雲端憑證）
npm test

# 2. 匯出：到 Apps Script 編輯器，把 migration/export-sheets.gs 的內容貼進既有
#    專案（隨便一個新檔案都可以，跟 Watchlist.gs 同一個專案），手動執行一次
#    exportWatchlistToJson_()，執行紀錄裡會印出 Drive 檔案連結，下載那個
#    watchlist-export-*.json 檔案到本機。

# 3. 先 dry-run，看轉換結果對不對，還沒有真的寫入 Firestore
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
node migration/import-firestore.js --dry-run ~/Downloads/watchlist-export-*.json

# 4. 確認 dry-run 輸出沒問題，才真的寫入
node migration/import-firestore.js ~/Downloads/watchlist-export-*.json

# 5. 驗證：核對 Firestore 裡的資料跟來源是否完全一致
node migration/validate.js ~/Downloads/watchlist-export-*.json
```

看到 `validate.js` 印出 `✅ 通過` 就代表這次 spike 成功，可以回頭校準
〈選股引擎遷移藍圖〉裡 Phase 2 對其餘 11 張表的時程估計。

## 這次 spike 特意沒做的事

- **沒有寫 Cloud Functions**——這次只驗證「資料搬得動、搬完是乾淨的」，不是
  搬整套後端邏輯，那是 Phase 3 的範圍。
- **沒有改動 Apps Script 現有的 Watchlist 功能**——`export-sheets.gs` 只是讀
  資料，`apps-script/` 目錄完全沒有被動到，現有的觀察個股功能繼續正常運作。
- **沒有把 API 金鑰放進任何檔案**——這次 spike 用不到 Anthropic/Gemini 金鑰，
  等 Phase 3 真的要搬 AI 診斷邏輯時再處理 Secret Manager。
