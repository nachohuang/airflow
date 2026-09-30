# Firebase 遷移工具（Phase 1 / Phase 2 spike）

對應〈選股引擎遷移藍圖〉的 Phase 1（Firestore schema 設計）跟 Phase 2（資料遷移
工具＋資料品質驗證），先拿 Watchlist（觀察個股清單）當練手對象——資料量最小、
邏輯最單純，跑完整套流程就能實際估出其餘 11 張表大概要花多久，再回頭校準時程。

**✅ Watchlist 這張表的 spike 已經跑完整套流程並驗證通過**（2026-09-30，透過
Cloud Shell）：Apps Script 匯出 → 傳進 Cloud Shell → dry-run → 正式寫入
Firestore → `validate.js` 核對 → `✅ 通過`。整條遷移路徑證明可行，下面留著
完整步驟給之後遷移其他張表（Portfolio 等）參考、複製。

**這次 spike 用的 Firebase 專案 ID：`flash-arbor-365706`**（已寫進
`.firebaserc`，`firebase deploy` 類指令不用再手動指定 `--project`）。

## 這裡有什麼

- `.firebaserc` / `firebase.json` — 指到上面那個專案 ID，讓 `firebase-tools`
  CLI 知道要部署去哪裡
- `firestore/schema.md` — 全部 12 張表的 Firestore collection/document 結構設計
  （不只 Watchlist，整個遷移藍圖的資料模型都定案在這裡，後續階段照這份繼續）
- `firestore/firestore.rules` — Security Rules 草案，單一授權使用者的存取模型
- `migration/` — Watchlist 的匯出／匯入／驗證工具（這次 spike 唯一會**實際執行**
  的部分）
  - `transform.js` / `checks.js` — 純邏輯，不需要雲端憑證，有完整單元測試
  - `firebase-init.js` — 共用的 Firestore 連線邏輯，本機服務帳戶金鑰／Cloud
    Shell 的 `gcloud` 使用者憑證兩種都支援
  - `export-sheets.gs` — 貼進既有 Apps Script 專案手動執行一次
  - `import-firestore.js` / `validate.js` — 需要憑證才能實際執行

## 你需要先做的事（Phase 0，只有你能做）

1. ~~到 Firebase Console 建立專案~~ ✅ 已完成（`flash-arbor-365706`）。
2. ~~啟用 Firestore Database~~ ✅ 已完成。
3. ~~啟用 Firebase Authentication~~ ✅ 已完成。
4. ~~產生服務帳戶金鑰~~ 不需要了——改用 Cloud Shell 的 `gcloud auth
   application-default login`，見下面「跑一次完整的 Watchlist 遷移 spike」。
   如果之後想在本機（不是 Cloud Shell）跑，還是可以到專案設定 → 服務帳戶 →
   產生新的私密金鑰，下載 `.json` 檔案，**不要放進 git、不要外流**。
5. ~~部署 `firestore/firestore.rules`~~ ✅ 已完成。

## 跑一次完整的 Watchlist 遷移 spike（Cloud Shell 版本，已驗證可行）

```bash
# 0. 開 Cloud Shell（console.cloud.google.com 右上角 >_ 圖示），確認專案正確
gcloud config set project flash-arbor-365706
gcloud auth application-default login   # 跳出授權視窗，同意即可

# 1. 抓程式碼（第一次要 clone；已經 clone 過的話改用 git pull 更新）
git clone -b claude/stock-data-apps-script-w1wsk1 https://github.com/nachohuang/airflow.git
cd airflow/firebase-migration
npm install
npm test   # 應該印出全部 passed，不需要任何雲端憑證

# 2. 匯出：到 Apps Script 編輯器，把 migration/export-sheets.gs 的內容貼進既有
#    專案（可以直接貼在 Watchlist.gs 檔案最後面，或另外新建一個腳本檔案），
#    存檔後在函式下拉選單選 exportWatchlistToJson、點「執行」。第一次會跳
#    授權視窗（要存取 Drive），允許即可。執行完在「執行紀錄」看到 Drive
#    連結，下載那個 watchlist-export-*.json 檔案。
#
#    ⚠️ 函式名稱不能用底線結尾（不是 exportWatchlistToJson_）——Apps Script
#    編輯器的執行下拉選單會把底線結尾的函式當內部函式直接隱藏，找不到不代表
#    存檔失敗，是這個命名慣例本身被 UI 特殊處理，見 export-sheets.gs 的說明。
#
#    用完記得把暫時貼進去的這段函式刪掉、存檔，恢復原狀。

# 3. 傳進 Cloud Shell：終端機右上角「⋮」選單 →「上傳」，選剛下載的檔案
#    （會傳到 $HOME 目錄）

# 4. 先 dry-run，看轉換結果對不對，還沒有真的寫入 Firestore
node migration/import-firestore.js --dry-run ~/watchlist-export-*.json

# 5. 確認 dry-run 輸出沒問題，才真的寫入
node migration/import-firestore.js ~/watchlist-export-*.json

# 6. 驗證：核對 Firestore 裡的資料跟來源是否完全一致
node migration/validate.js ~/watchlist-export-*.json
```

（本機也能跑，把步驟 0 換成設定 `GOOGLE_APPLICATION_CREDENTIALS` 指到服務
帳戶金鑰檔案，其餘步驟一樣——`firebase-init.js` 兩種憑證來源都支援。）

看到 `validate.js` 印出 `✅ 通過` 就代表這次 spike 成功，可以回頭校準
〈選股引擎遷移藍圖〉裡 Phase 2 對其餘 11 張表的時程估計。

## 這次 spike 踩過的坑（下次遷移其他表可以少走的路）

- **Watchlist 分頁一開始是空的**：匯出腳本本身沒問題，只是沒資料可匯——先到
  App 的「觀察個股」加 1-2 筆測試資料，才能真正驗證「內容逐筆比對」這段
  邏輯，不然永遠只會測到「0 筆對 0 筆」這個邊界情況。
- **函式名稱結尾底線會被 Apps Script 執行選單隱藏**：這支 App 的程式碼慣例
  用結尾底線代表「內部函式」，但 Apps Script 編輯器真的會拿這個慣例決定要
  不要顯示在「執行」下拉選單裡，跟檔案存不存得成功無關。`export-sheets.gs`
  現在已經改用不結尾底線的函式名稱。
- **Cloud Shell 的 `$HOME` 可能已經有舊的 clone**：如果之前 clone 過這個
  repo，`git clone` 會因為目錄已存在而失敗——改用 `git pull` 更新既有的
  clone，不用整個刪掉重來。

## 這次 spike 特意沒做的事

- **沒有寫 Cloud Functions**——這次只驗證「資料搬得動、搬完是乾淨的」，不是
  搬整套後端邏輯，那是 Phase 3 的範圍。
- **沒有改動 Apps Script 現有的 Watchlist 功能**——`export-sheets.gs` 只是讀
  資料，`apps-script/` 目錄完全沒有被動到，現有的觀察個股功能繼續正常運作。
- **沒有把 API 金鑰放進任何檔案**——這次 spike 用不到 Anthropic/Gemini 金鑰，
  等 Phase 3 真的要搬 AI 診斷邏輯時再處理 Secret Manager。
