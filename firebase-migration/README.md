# Firebase 遷移工具（Phase 1 / Phase 2）

對應〈選股引擎遷移藍圖〉的 Phase 1（Firestore schema 設計）跟 Phase 2（資料遷移
工具＋資料品質驗證）。第一張表（Watchlist）是拿來練手的 spike——資料量最小、
邏輯最單純，跑完整套流程證明可行之後，照同一套模式（`migration/<table>/` 底下
一組 `transform.js`/`checks.js`/`export-sheets.gs`/`import-firestore.js`/
`validate.js`）繼續遷移其他表。

**✅ 已完整跑過整套流程並驗證通過的表**（Apps Script 匯出 → 傳進 Cloud Shell →
dry-run → 正式寫入 Firestore → `validate.js` 核對 → `✅ 通過`）：

- Watchlist（2026-09-30，spike，證明整條路徑可行）

- Portfolio（2026-10-05，10 筆真實資料，`✅ 通過`）

**工具已就緒、尚未實際對真實資料跑過一次的表**：

- AiDiagnosis（`migration/ai_diagnosis/`，見下方「跟其他表不同的地方」）

**這次用的 Firebase 專案 ID：`flash-arbor-365706`**（已寫進 `.firebaserc`，
`firebase deploy` 類指令不用再手動指定 `--project`）。

## 這裡有什麼

- `.firebaserc` / `firebase.json` — 指到上面那個專案 ID，讓 `firebase-tools`
  CLI 知道要部署去哪裡
- `firestore/schema.md` — 全部 12 張表的 Firestore collection/document 結構設計
  （整個遷移藍圖的資料模型都定案在這裡，後續階段照這份繼續）
- `firestore/firestore.rules` — Security Rules 草案，單一授權使用者的存取模型
- `migration/lib/` — 跨表共用的純邏輯，不需要任何雲端憑證
  - `normalize.js` — `zfill4`（股票代號補零成 4 碼）／`normalizeDateStr`
    （日期統一成 `YYYY-MM-DD`），每張表的 `transform.js` 都會用到，只有一份，
    不要每張表各自複製
  - `firebase-init.js` — 共用的 Firestore 連線邏輯，本機服務帳戶金鑰／Cloud
    Shell 的 `gcloud` 使用者憑證兩種都支援
- `migration/watchlist/`、`migration/portfolio/`、`migration/ai_diagnosis/` —
  每張表各自一組遷移工具，結構完全一樣：
  - `transform.js` / `checks.js` — 純邏輯，不需要雲端憑證，`test/` 底下有完整
    單元測試
  - `export-sheets.gs` — 貼進既有 Apps Script 專案手動執行一次
  - `import-firestore.js` / `validate.js` — 需要憑證才能實際執行，用共用的
    `../lib/firebase-init.js` 連線

遷移下一張表時，複製其中一個目錄結構最快——沿用同樣的檔名、同樣的 CLI 用法，
只需要照新表的欄位改 `transform.js`/`checks.js` 的內容。

## 你需要先做的事（Phase 0，只有你能做）

1. ~~到 Firebase Console 建立專案~~ ✅ 已完成（`flash-arbor-365706`）。
2. ~~啟用 Firestore Database~~ ✅ 已完成。
3. ~~啟用 Firebase Authentication~~ ✅ 已完成。
4. ~~產生服務帳戶金鑰~~ 不需要了——改用 Cloud Shell 的 `gcloud auth
   application-default login`，見下面「跑一次完整的 Watchlist 遷移 spike」。
   如果之後想在本機（不是 Cloud Shell）跑，還是可以到專案設定 → 服務帳戶 →
   產生新的私密金鑰，下載 `.json` 檔案，**不要放進 git、不要外流**。
5. ~~部署 `firestore/firestore.rules`~~ ✅ 已完成。

## 跑一次完整的表遷移流程（Cloud Shell 版本，Watchlist／Portfolio 已驗證可行）

下面用 `<table>` 代表 `migration/` 底下的目錄名（`watchlist`／`portfolio`／
`ai_diagnosis`），`<Table>` 代表對應的匯出函式名稱字首——例如 Watchlist 是
`migration/watchlist/...`、`exportWatchlistToJson`；Portfolio 是
`migration/portfolio/...`、`exportPortfolioToJson`；AiDiagnosis 是
`migration/ai_diagnosis/...`、`exportAiDiagnosisToJson`（匯出函式名稱沿用
Sheets 原本的駝峰式名稱 `AiDiagnosis`，不是目錄名的底線寫法）。

```bash
# 0. 開 Cloud Shell（console.cloud.google.com 右上角 >_ 圖示），確認專案正確
gcloud config set project flash-arbor-365706
gcloud auth application-default login   # 跳出授權視窗，同意即可

# 1. 抓程式碼（第一次要 clone；已經 clone 過的話改用 git pull 更新）
git clone -b claude/stock-data-apps-script-w1wsk1 https://github.com/nachohuang/airflow.git
cd airflow/firebase-migration
npm install
npm test   # 應該印出全部 passed，不需要任何雲端憑證

# 2. 匯出：到 Apps Script 編輯器，把 migration/<table>/export-sheets.gs 的內容
#    貼進既有專案（可以直接貼在對應的 <Table>.gs 檔案最後面，或另外新建一個
#    腳本檔案），存檔後在函式下拉選單選 export<Table>ToJson、點「執行」。第一次
#    會跳授權視窗（要存取 Drive），允許即可。執行完在「執行紀錄」看到 Drive
#    連結，下載那個 <table>-export-*.json 檔案。
#
#    ⚠️ 函式名稱不能用底線結尾（不是 export<Table>ToJson_）——Apps Script
#    編輯器的執行下拉選單會把底線結尾的函式當內部函式直接隱藏，找不到不代表
#    存檔失敗，是這個命名慣例本身被 UI 特殊處理，見 export-sheets.gs 的說明。
#
#    用完記得把暫時貼進去的這段函式刪掉、存檔，恢復原狀。

# 3. 傳進 Cloud Shell：終端機右上角「⋮」選單 →「上傳」，選剛下載的檔案
#    （會傳到 $HOME 目錄）

# 4. 先 dry-run，看轉換結果對不對，還沒有真的寫入 Firestore
node migration/<table>/import-firestore.js --dry-run ~/<table>-export-*.json

# 5. 確認 dry-run 輸出沒問題，才真的寫入
node migration/<table>/import-firestore.js ~/<table>-export-*.json

# 6. 驗證：核對 Firestore 裡的資料跟來源是否完全一致
node migration/<table>/validate.js ~/<table>-export-*.json
```

（本機也能跑，把步驟 0 換成設定 `GOOGLE_APPLICATION_CREDENTIALS` 指到服務
帳戶金鑰檔案，其餘步驟一樣——`lib/firebase-init.js` 兩種憑證來源都支援。）

看到 `validate.js` 印出 `✅ 通過` 就代表這張表遷移成功。

## 跟其他表不同的地方

### Portfolio

- **`status` 欄位翻譯**：原文字「持有中」/「已賣出」在 Firestore 版翻成英文
  列舉 `"holding"` / `"sold"`，避免中文字面值散落在後端到處要用字串比對；
  空白/未知值一律當 `holding`，跟現行 `Portfolio.gs` 的
  `r['狀態'] || '持有中'` 預設邏輯一致。
- **`sellDate`／`sellPrice` 允許是 `null`**：持有中的部位本來就還沒賣，
  `checks.js` 的型別檢查特別放寬這兩個欄位，`null` 不算型別錯誤；已賣出卻
  缺這兩個值只降級成警告（來源資料本身可能本來就不乾淨，不是遷移邏輯的錯）。
- **多一項「金額校驗」**：`checks.js` 額外依代號把持有中的 lot 分組，用跟
  `apps-script/src/Portfolio.gs` 的 `aggregateLots_` 同一套邏輯，各自對來源
  跟 Firestore 重新算一次加權平均成本跟總股數，兩邊要一致——這一項不是逐列
  比對，是用來抓「單列都對、但彙總邏輯用到的數字型別/精度悄悄跑掉」這種比較
  隱蔽的問題（對照〈選股引擎遷移藍圖〉§05 的金額校驗要求）。

### AiDiagnosis

- **文件 ID 是三個欄位組成的複合鍵**：`{code}_{date}_{diagnosisType}`，跟現行
  `aiDiagnosisRowKey_()` 的比對鍵邏輯一致。同一天同一檔股票可能跑了不只一種
  診斷類型（深度診斷／持股續抱診斷），各自算一筆，不是重複資料。
- **`診斷類型` 翻譯**：「深度診斷」/「持股續抱診斷」/「TOP3推薦」翻成
  `deep`/`hold`/`top3`；空白/未知值一律當 `deep`，跟
  `upsertAiDiagnosisRow_()` 的預設邏輯一致（改版前只有單一種診斷類型的舊
  資料就是沒有這欄）。
- **Top3 推薦的「證券代號」不是真正的股票代號**：固定存文字 `TOP3`（代表
  「全市場橫向比較」這個結果，不屬於任何一檔股票）。`zfill4('TOP3')` 剛好
  因為已經是 4 個字元會原樣回傳，`checks.js` 的代號格式檢查也特別把 `TOP3`
  列為例外，不會被誤判成「忘記補零」。
- **`armorScore` 允許是 `null`**：Top3 推薦這種診斷類型的 Armor_Score／操作
  策略／最終建議在來源就是空字串，不是壞資料。
- **筆數會隨時間持續累積**：不像 Watchlist／Portfolio 筆數穩定，AiDiagnosis
  每天每檔股票跑診斷都會新增一筆，`import-firestore.js` 已經加了批次寫入
  （每 400 筆一批），避免真實資料量大時超過 Firestore 單批 500 筆操作的上限。

## 已知的坑（下次遷移其他表可以少走的路）

- **來源分頁可能一開始是空的**：匯出腳本本身沒問題，只是沒資料可匯——先到
  App 對應的功能頁加 1-2 筆測試資料，才能真正驗證「內容逐筆比對」這段邏輯，
  不然永遠只會測到「0 筆對 0 筆」這個邊界情況。
- **函式名稱結尾底線會被 Apps Script 執行選單隱藏**：這支 App 的程式碼慣例
  用結尾底線代表「內部函式」，但 Apps Script 編輯器真的會拿這個慣例決定要
  不要顯示在「執行」下拉選單裡，跟檔案存不存得成功無關。每張表的
  `export-sheets.gs` 都已經用不結尾底線的函式名稱，複製去下一張表時記得
  保持這個慣例。
- **Cloud Shell 的 `$HOME` 可能已經有舊的 clone**：如果之前 clone 過這個
  repo，`git clone` 會因為目錄已存在而失敗——改用 `git pull` 更新既有的
  clone，不用整個刪掉重來。

## 目前特意沒做的事

- **沒有寫 Cloud Functions**——目前只驗證「資料搬得動、搬完是乾淨的」，不是
  搬整套後端邏輯，那是 Phase 3 的範圍。
- **沒有改動 Apps Script 現有功能**——`export-sheets.gs` 只是讀資料，
  `apps-script/` 目錄完全沒有被動到，現有功能繼續正常運作。
- **沒有把 API 金鑰放進任何檔案**——目前用不到 Anthropic/Gemini 金鑰，等
  Phase 3 真的要搬 AI 診斷邏輯時再處理 Secret Manager。
