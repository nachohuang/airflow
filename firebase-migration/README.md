# Firebase 遷移工具（Phase 1 / Phase 2 / Phase 3 進行中）

對應〈選股引擎遷移藍圖〉的 Phase 1（Firestore schema 設計）跟 Phase 2（資料遷移
工具＋資料品質驗證）。第一張表（Watchlist）是拿來練手的 spike——資料量最小、
邏輯最單純，跑完整套流程證明可行之後，照同一套模式（`migration/<table>/` 底下
一組 `transform.js`/`checks.js`/`export-sheets.gs`/`import-firestore.js`/
`validate.js`）繼續遷移其他表。

**✅ 已完整跑過整套流程並驗證通過的表**（Apps Script 匯出 → 傳進 Cloud Shell →
dry-run → 正式寫入 Firestore → `validate.js` 核對 → `✅ 通過`）：

- Watchlist（2026-09-30，spike，證明整條路徑可行）

- Portfolio（2026-10-05，10 筆真實資料，`✅ 通過`）
- AiDiagnosis（2026-10-05，175 筆真實資料，去重後 174 筆，`✅ 通過`——來源
  Sheet 裡原本就有一筆重複的（代號+日期+診斷類型），Firestore 的 `set()`
  覆寫語意讓它自然收斂成 1 篇文件，不是遷移出錯，見下方「跟其他表不同的
  地方」）

- SkipDates（2026-10-05，1 筆真實資料，`✅ 通過`）

- IndustryMap（2026-10-05，1087 筆真實資料，`✅ 通過`）

- config/app + jobs/{jobKey}（2026-10-05，`✅ 通過`，見下方專屬章節）

**工具已就緒、尚未實際對真實資料跑過一次的表**：

- factor_model_history（`migration/factor_model_history/`，Phase 3 跟
  `Analysis.gs` 戰報邏輯一起遷移，不是 Phase 2 的範圍——`hybrid`/
  `factor_model_rank` 這兩種戰報篩選策略要靠這張表才能在 Firebase 版正常
  運作，見下方「Phase 3」章節）

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
- `migration/watchlist/`、`migration/portfolio/`、`migration/ai_diagnosis/`、
  `migration/skip_dates/`、`migration/industry_map/`、
  `migration/factor_model_history/` — 每張表各自一組遷移工具，結構完全
  一樣：
  - `transform.js` / `checks.js` — 純邏輯，不需要雲端憑證，`test/` 底下有完整
    單元測試
  - `export-sheets.gs` — 貼進既有 Apps Script 專案手動執行一次
  - `import-firestore.js` / `validate.js` — 需要憑證才能實際執行，用共用的
    `../lib/firebase-init.js` 連線
- `migration/config_and_jobs/` — 結構類似，但來源是 Script Properties 不是
  Sheets（`export-script-properties.gs` 取代 `export-sheets.gs`），同時產出
  `config/app`（單一文件）跟 `jobs/{jobKey}`（9 份文件）兩個 collection，
  見下方「跑一次 config/app + jobs 遷移」專屬章節

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
`ai_diagnosis`／`skip_dates`／`industry_map`／`factor_model_history`），
`<Table>` 代表對應的匯出函式名稱字首——例如 Watchlist 是
`migration/watchlist/...`、`exportWatchlistToJson`；Portfolio 是
`migration/portfolio/...`、`exportPortfolioToJson`；AiDiagnosis 是
`migration/ai_diagnosis/...`、`exportAiDiagnosisToJson`；SkipDates 是
`migration/skip_dates/...`、`exportSkipDatesToJson`；IndustryMap 是
`migration/industry_map/...`、`exportIndustryMapToJson`；
FactorModelHistory 是 `migration/factor_model_history/...`、
`exportFactorModelHistoryToJson`（匯出函式名稱沿用 Sheets 原本的駝峰式
名稱，不是目錄名的底線寫法）。

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

## 跑一次 config/app + jobs 遷移（來源是 Script Properties，流程跟其他表不一樣）

跟前五張表不同，這份資料本來就不是放在 Sheets，是 Apps Script 的
Script Properties（鍵值設定）——所以沒有「貼 `export-sheets.gs` 進某個
.gs 檔案」這一步，改成貼 `export-script-properties.gs`；而且一次會產出
`config/app`（單一文件）跟 `jobs/{jobKey}`（9 份文件）兩個 Firestore
collection，不是一張表對一個 collection。

```bash
# 0-1 跟其他表完全一樣（gcloud 登入、git pull、npm test）

# 2. 匯出：到 Apps Script 編輯器，任何一個既有 .gs 檔案都可以（這支腳本只呼叫
#    PropertiesService，不依賴任何特定檔案裡的函式），貼上
#    migration/config_and_jobs/export-script-properties.gs 的內容，存檔後
#    在函式下拉選單選 exportConfigAndJobsToJson、點「執行」。執行完在
#    「執行紀錄」看到 Drive 連結，下載那個 config_and_jobs-export-*.json 檔案。
#    用完記得刪掉、存檔，恢復原狀。

# 3. 傳進 Cloud Shell（跟其他表一樣，⋮ 選單 →「上傳」）

# 4. dry-run：會同時印出 config/app 跟全部 9 份 jobs/* 文件的內容
node migration/config_and_jobs/import-firestore.js --dry-run ~/config_and_jobs-export-*.json

# 5. 確認沒問題後正式寫入（一次 batch 同時寫 config/app + 9 份 jobs/*）
node migration/config_and_jobs/import-firestore.js ~/config_and_jobs-export-*.json

# 6. 驗證：會分別印出 config/app 跟 jobs/* 兩份報告
node migration/config_and_jobs/validate.js ~/config_and_jobs-export-*.json
```

兩份報告都要看到 `✅ 通過` 才算這次遷移成功。

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

### SkipDates

- **目前最單純的一張表**：只有 `date`（文件 ID）／`reason` 兩個欄位，沒有
  任何需要翻譯列舉值或補零的欄位，`transform.js`／`checks.js` 的邏輯直接
  照搬 Watchlist 那套模式即可。

### IndustryMap

- **靜態參考資料，結構跟 Watchlist 幾乎一樣**：代號→產業別／市場別，沒有
  列舉翻譯或數字欄位，差別只在筆數——這張是全市場上市櫃股票，可能上千筆
  （不像 Watchlist／Portfolio 筆數通常只有幾十筆），所以 `import-firestore.js`
  也跟 AiDiagnosis 一樣加了批次寫入（每 400 筆一批），dry-run 輸出也只印前
  20 筆，不然終端機會被整頁股票清單淹掉。
- **這次 Phase 2 只做一次性搬移，不是整批覆蓋式同步**：〈選股引擎遷移藍圖〉
  §04 提到現行 `ensureIndustryMapSyncedToBigQuery_()` 本來就是「整批重新
  整理」（來源異動就整份覆蓋，不是逐筆 diff），這次遷移工具只負責把目前的
  Sheets 內容搬進 Firestore 一次；之後要不要在 Firestore 版也做成「整批
  覆蓋式」的定期同步，是 Phase 3 跟後端邏輯一起搬的時候再決定，現在的
  `import-firestore.js` 只會新增/更新文件，不會刪除 Firestore 裡已經有、
  但這次來源沒有的舊代號。

### config/app + jobs/{jobKey}

- **來源是 Script Properties，不是 Sheets**：沒有「一列一列的資料」，是一組
  key-value 設定——所以 `export-script-properties.gs` 取代了
  `export-sheets.gs`，`transform.js` 也沒有「一筆 sheetRow 轉一筆 doc」，是
  「一份 configProps/jobProps 物件轉一份 config/app 文件 + 最多 9 份
  jobs/{jobKey} 文件」，匯出的 CLI 跟 dry-run 輸出格式也因此跟其他表不一樣。
- **故意不讀取 API 金鑰**：`export-script-properties.gs` 的 key 清單明確
  排除 `ANTHROPIC_API_KEY`／`GEMINI_API_KEY`——這兩個金鑰不該以任何形式出現
  在匯出的 JSON 檔案裡（那個檔案會先存在 Drive、下載到本機或 Cloud Shell，
  比留在 Script Properties 裡多了好幾個可能外流的環節）。之後 Phase 3 真的
  要讓 Cloud Functions 讀到金鑰時，走的是 Secret Manager，不是這套遷移工具。
- **`config/app` 的每個欄位都套用跟現行 apps-script 讀取邏輯一致的預設值**：
  例如 `triggerHour`/`triggerMinute`/價格欄位允許 0（`isNaN` 判斷），但
  `aiDailyTopN` 是 0 時會退回預設值 5（照抄 `AiDiagnosis.gs` 原本
  `parseInt(...) || DEFAULT` 的既有怪癖，不是這支工具自己發明的不一致）。
- **`jobs/{jobKey}` 的每份文件形狀都不一樣**：9 種背景 job 各自的狀態 JSON
  結構不同（見 `apps-script/src/DataFetch.gs`／`Analysis.gs`／
  `BigQuerySync.gs`／`AiDiagnosis.gs` 各自的 saveXJobState_），`transform.js`
  不逐欄位重新定義，整份原樣存進 Firestore；`checks.js` 也因此只對
  `status` 這個共通欄位做型別檢查，其餘靠整份深度比較來抓問題。
- **固定遷移 9 份 jobs 文件，不包含 `watchdog`**：`firestore/schema.md` §9
  列的第 10 個 jobKey（`watchdog`）是 Firestore 版排程安全網自己第一次
  執行時才會產生的新文件，現在的 Script Properties 裡沒有對應資料，這次
  遷移工具不會（也沒辦法）提前生出它。

### factor_model_history

- **屬於 Phase 3，不是 Phase 2**：跟其他六組不一樣，這張表照〈遷移藍圖〉
  本來就排在 Phase 3 跟 `Analysis.gs` 戰報邏輯一起搬——`hybrid`／
  `factor_model_rank` 這兩種戰報篩選策略需要這張表的資料才能在 Firebase
  版正常運作，`functions/index.js` 的 `fetchAppliedFactorModels_()` 直接讀
  這個 collection（`applied === true` 的文件），見下方 Phase 3 章節。
- **文件 ID 是「執行時間+標的Label」的複合鍵**：`{timestamp}_{labelKey}`，
  跟 AiDiagnosis 的複合鍵手法一樣——同一次執行會對 `return1m`／
  `downsideResistance` 兩個 label 各留一筆，不能只用執行時間當鍵。
- **「執行時間」欄位本身是比對鍵，不能只正規化成日期、要連時間一起留著**：
  這點跟其他表的日期欄位不一樣——`apps-script/src/FactorRegression.gs` 的
  `applyFactorModel()` 用這個欄位的精確字串比對「是不是這個版本」，所以
  `migration/lib/normalize.js` 新增了 `normalizeDateTimeStr`，跟
  `normalizeDateStr` 不同的地方是保留時間、而且把 Sheets 自動轉型成 Date
  儲存格時 `JSON.stringify` 產生的 UTC ISO 字串**轉回台北時間**再重建成
  `YYYY-MM-DD HH:mm:ss`（直接照抄 UTC 數字會跟原始寫入值差 8 小時，兩邊
  字串就比對不起來）。
- **權重（`weights`）直接存成 Firestore 的 map，不是字串**：來源 Sheets 裡
  是 `JSON.stringify` 過的字串（`權重(JSON)` 欄位），遷移時 `JSON.parse`
  回物件存進 Firestore——解析失敗（理論上不該發生）降級成空物件，不讓一筆
  壞資料擋掉整批遷移。

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

---

# Phase 3：後端邏輯遷移（Cloud Functions）

對應〈選股引擎遷移藍圖〉的 Phase 3——把現在跑在 Apps Script 的後端業務邏輯，
改寫成讀寫 Firestore（而不是 Sheets）的 Cloud Functions。第一個目標：戰報
計算邏輯（`Analysis.gs`），因為這段是純函式、確定性運算，最適合用「跟
Apps Script 版逐欄位比對數字」的方式驗證正確性，不像 AiDiagnosis 呼叫 AI
API、本質上非確定性。

## 架構決定：複製，不共用（2026-10-05）

一開始考慮過讓 Cloud Function 執行時直接用 `vm` 載入
`apps-script/src/*.gs` 現有檔案來跑（零轉譯風險，但代表以後邏輯調整還是要
回 `apps-script/src/` 改，而且 Apps Script／Cloud Functions 是兩個獨立部署
目標，改完兩邊都要重新部署）。討論後改成：**把純函式複製一份到
`functions/lib/`，從今天起這份是正本，以後邏輯調整直接在這裡改，不回頭
改 `apps-script/src/`**。`apps-script/src/` 那份維持原樣，讓舊系統在
Phase 7（雙邊並行驗證）結束前繼續正常運作。

這個決定的代價是：複製那一刻要花功夫證明「兩邊算出來的數字完全一致」
（見下面 `test/parity.test.js`），之後兩份程式碼不再自動同步，各自獨立
維護。換來的好處是從今天起只有一個地方要改，不會有「Firebase 改了邏輯、
忘記也要去 Apps Script 部署一次」的認知負擔。

## 這裡有什麼

- `functions/lib/utils.js` — 從 `apps-script/src/Utils.gs` 複製的純運算
  工具（`rollingMean`/`percentRank`/`normalizeDateStr` 等）。沒有複製
  `sanitizeRowForRpc_`/`formatDateForRpc_`——那是修正 `google.script.run`
  跨 RPC 傳輸 Date 物件序列化失敗的邏輯，Cloud Functions 用 JSON 回應，
  沒有這個問題。
- `functions/lib/config.js` — 戰報計算需要的設定常數（`STRATEGY`、
  `ANALYSIS_LOOKBACK_DAYS`、`HISTORY_NUMERIC_COLUMNS`、`REPORT_COLUMNS`、
  `FULL_REPORT_COLUMNS`、`BQ_FEATURE_TO_ANALYSIS_FIELD`），從
  `apps-script/src/Config.gs` 只挑這幾項複製過來，不是整份 CONFIG。
- `functions/lib/factorModel.js` — 從 `apps-script/src/FactorRegression.gs`
  複製的 `computeWeightedFactorScore_`/`computePredictedFactorScores_`
  兩支純函式（只複製這兩支，實際呼叫 BigQuery 訓練模型的 I/O 邏輯不在
  這次遷移範圍）。
- `functions/lib/analysis.js` — 從 `apps-script/src/Analysis.gs` 複製的
  戰報核心計算：`computeFactors_`（rolling 因子 + Armor_Score）、
  `diagnoseRow_`/`classifyEntrySignal_`（三種可切換的篩選策略）、
  `computeScreeningStats_`/`screeningFunnelStages_`（篩選漏斗統計）、
  `buildFullReportRow_`、`computeLookbackStartStr_`。**不包含**
  `runAnalysis()`/`runAnalysisAndSave()` 這類 I/O orchestration（讀
  History/Portfolio、寫 Reports、背景 job 狀態機、Drive xlsx 匯出）——
  那段要改寫成讀 BigQuery（History 不動）、讀寫 Firestore，還沒開始做。
- `functions/test/analysis.test.js` — 12 個測試，直接 require
  `lib/analysis.js` 驗證這份新正本的行為（跟
  `apps-script/test/analysis.test.js` 幾乎同一套案例，但不碰
  `apps-script/src/`）。
- `functions/test/parity.test.js` — **只在複製當下有意義的一次性比對**：
  用跟 `apps-script/test/analysis.test.js` 一樣的 `vm` 技巧，把
  `apps-script/src/` 現有檔案讀進 Node 當作「原始正本」，拿同一批輸入
  （40 天穩定上漲、零成交量/剛上市等刁鑽情境、三種篩選策略、抗跌力模型
  排名）分別餵給原始函式跟 `lib/analysis.js`，逐欄位斷言完全一致。跑一次
  `npm test` 就會看到：

```
Parity 1 (computeFactors_, 40d uptrend) passed.
Parity 2 (computeFactors_, multi-stock edge cases) passed.
Parity 3 (diagnoseRow_ / classifyEntrySignal_) passed.
Parity 4 (computePredictedResistanceRanks_) passed.
Parity 5 (computeScreeningStats_ / screeningFunnelStages_ / computeLookbackStartStr_) passed.
All parity checks passed — lib/analysis.js matches apps-script/src/Analysis.gs at copy time (2026-10-05).
```

這證明這次複製沒有抄錯。之後 `apps-script/src/Analysis.gs` 或
`functions/lib/analysis.js` 任何一邊單獨改了邏輯，這支測試就會（也應該）
失敗——它不是「兩邊永遠要一致」的迴歸測試，只是留著當作複製時刻的歷史
記錄；日常的迴歸測試看 `test/analysis.test.js` 就好。

## I/O orchestration 層（2026-10-05）

- `functions/lib/portfolio.js` — 從 Firestore `portfolio_lots`（Phase 2
  已遷移完成）組出 `computeFactors_` 需要的 `portfolioMap`。跟
  `apps-script/src/Portfolio.gs` 的 `aggregateLots_`/`getPortfolioMap_`
  同一套加權平均成本／最早買進日邏輯，但針對 Firestore 文件的英文欄名
  （`buyPrice`/`shares`/`buyDate`/`status`）重新寫一次，不是直接複製
  （Sheets 版操作的是中文欄名的原始儲存格字串，型別處理方式不一樣）。
- `functions/lib/bigquery.js` — 從 `apps-script/src/BigQuerySync.gs` 複製
  的純函式：組查詢 History 的 SQL（`buildHistoryRangeSql_`）、BigQuery
  ascii 欄名列轉回 `computeFactors_` 期待的中文欄名列
  （`mapBqRowToHistoryRow_`）、依 `config/app` 的 `bigQuery.sourceMode`
  決定要讀哪個 view（`sourceRefForRead_`）。不含實際呼叫 BigQuery API 的
  部分。
- `functions/lib/reportPipeline.js` — 戰報計算的 orchestration 核心，但
  本身仍是純函式：吃「已經讀進記憶體的 History 列 + 持股 lot 文件」，组出
  戰報（`buildReport_`）。跟 `apps-script/src/Analysis.gs` 的
  `runAnalysis()` 職責相同，差別是刻意把「讀資料」留給呼叫端
  （`index.js` 才需要真的連 BigQuery／Firestore），這支只管「資料到手之後
  怎麼算」，所以可以在沒有雲端憑證的情況下完整單元測試。輸出的文件形狀
  直接對照 `firestore/schema.md` §3（英文欄名），不是 Sheets 版中文欄名。
- `functions/index.js` — 真正接上 I/O 的 Cloud Functions 進入點：讀
  `config/app` 取得 `screeningStrategy`/`bigQuery` 設定、查 BigQuery 最近
  `ANALYSIS_LOOKBACK_DAYS` 天的原始 History、讀 `portfolio_lots`、讀
  `factor_model_history` 裡 `applied === true` 的文件（`fetchAppliedFactorModels_()`，
  組成跟 `getAppliedFactorModels()` 同樣的 `{return1m, downsideResistance}`
  形狀）、呼叫 `reportPipeline.buildReport_`、寫進 Firestore
  `reports/{date}/signals/{code}`。匯出兩個 function：
  `generateDailyReportScheduled`（每個交易日台北時間 23:00 觸發，取代
  `scheduledDailyFetch` 裡「算戰報」這一步）跟 `generateDailyReport`
  （HTTPS endpoint，手動觸發，取代「重新計算戰報」按鈕，回傳戰報摘要
  方便部署後直接 curl 驗證）。

**設計選擇：History 改成抓原始列在 Node 算，不搬
`buildLatestDayFactorsSql_`（SQL window function 版的因子計算）過來。**
那支 SQL 存在的原因是 Apps Script 的 V8 執行環境記憶體上限扛不住
「150 天 x 全市場」的原始資料量（實測會「記憶體不足」），但 Cloud
Functions 預設就有更高的記憶體/執行時間上限，不需要為了同一個限制再維護
第二套獨立實作（SQL 版）的因子計算邏輯——兩套算法都要各自驗證正確性，
徒增風險，不如只信任已經被 `parity.test.js` 驗證過的 `computeFactors_`。

- `functions/test/portfolio.test.js`／`bigquery.test.js`／
  `reportPipeline.test.js` — 分別驗證上面三個 `lib/` 檔案，`reportPipeline`
  的測試特別包含「持股止損一定出現、流動性不足的非持股股票被篩掉、多股票
  依 Armor_Score 排序」這幾個貼近真實情境的案例。

⚠️ **`index.js` 本身沒辦法在這個開發環境驗證**——這裡沒有真正的 BigQuery／
Firestore 雲端憑證，`npm install` 跟 `node --check`/`require()` 確認過
語法跟模組路徑都正確，但「接線接得對不對」（SQL 真的查得到資料、Firestore
真的寫得進去）要等部署到真正的 Firebase 專案才能驗證，跟 Phase 2 遷移
工具的驗證模式一樣（先 dry-run/語法檢查，再上 Cloud Shell 用真實憑證跑一次）。
`lib/` 底下的計算邏輯本身已經靠單元測試跟 parity 測試驗證過，`index.js`
要驗證的只是「接線有沒有接對」，不是「算得對不對」。

**✅ 2026-10-05 已部署到 `flash-arbor-365706` 並完整驗證成功。**
`generateDailyReport` 手動觸發後：BigQuery 查到 1088 檔一般股票（排除權證
後的正常量級）、Firestore `config/app`／`portfolio_lots` 讀取正確、算出
79 筆訊號、全部正確寫進 `reports/2026-10-05/signals/{code}`，欄位內容
（`armorScore`/`strategy`/`interpretation`/`monitorUrl`，`predictedReturn1m`
等因子模型欄位正確是 `null`）跟 `firestore/schema.md` §3 的設計完全一致。
部署過程踩到兩個真實的坑，都已經修好並記錄在這裡給之後部署其他 Cloud
Function 參考：

- **Cloud Functions 2nd gen 需要 Blaze（用量付費）方案**，Spark 免費方案
  部署會直接失敗，部署前要先在 Firebase Console 升級。
- **第一次部署會自動要求啟用好幾個 API**（`cloudfunctions`／`cloudbuild`／
  `artifactregistry`／`eventarc`／`cloudscheduler`／`run`／`pubsub`／
  `storage`），`firebase deploy` 自己會檢查並啟用，不用事先手動一一啟用。
- **坑 1：預設記憶體 256 MiB 不夠用**：第一次手動觸發
  `generateDailyReport` 時直接被 OOM 砍掉（`Memory limit of 256 MiB
  exceeded with 267~291 MiB used`）。`index.js` 的兩個 function 現在都
  明確指定 `memory: '1GiB'`、`timeoutSeconds: 180`。
- **坑 2：調大記憶體後換成 V8 heap OOM，第一次診斷錯了，第二次用具體查詢
  驗證才找到真正原因**：調到 1GiB 還是在跑了快 3 分鐘後整個爆掉
  （`JavaScript heap out of memory`）。查了一下 `history_unified` 這個 view
  查回來的「相異代號數」高達 **4.9 萬**，但台股上市櫃全部加起來也就一千多
  到兩千檔——**第一次診斷猜是 `stock_id` 格式不一致**（同一檔股票被拆成
  好幾種格式變體），依這個猜測把 `apps-script/src/Utils.gs` 的
  `sanitizeStockId_` 補進 `lib/utils.js` 清洗代號。**這個診斷後來被查證
  推翻**：實際用 `GROUP BY stock_name HAVING COUNT(DISTINCT stock_id) > 1`
  查，結果是空的——沒有任何一檔股票對到超過一個代號，台積電也確實只對到
  `2330` 這一個。再查那些「筆數很少」的代號实際內容，看到的是「正新國票
  58購01」這種合法的 **6 碼權證代號**（券商發行、到期就換發新代號的衍生
  商品，台股市場流通中的權證有上萬張，遠超過一般股票數量）——不是髒資料，
  是這次查詢把全市場「含全部權證」都撈了進來。回頭查 Apps Script 既有
  程式碼才確認：`buildLatestDayFactorsSql_`／`computeFactors_` 本來就有
  `LENGTH(stock_id) = 4` 這條篩選，**刻意只計算一般股票、排除權證/ETF**
  （法人動能/量能這套篩選邏輯本來就不是設計給權證用的），只是我們的 Cloud
  Function 查詢沒有在 SQL 階段套用同一條規則，所以 150 萬筆（140 萬筆是
  權證）全部被撈進記憶體、逐欄位轉型一輪，才在 `computeFactors_` 內部的
  同一條篩選生效之前就把記憶體耗盡——篩選邏輯本身一直都在，只是套用的時間
  點太晚。**正確的修法**：`lib/bigquery.js` 的 `buildHistoryRangeSql_` 加
  了 `opts.stocksOnly` 選項，在 SQL 查詢階段就套用
  `LENGTH(stock_id) = 4`，跟 Apps Script production 版用同一條既有規則，
  從源頭就不把權證資料查回來，不是等資料到了 Node 才濾掉。
  `sanitizeStockId_` 那次的修正並沒有錯（代號格式清洗本身是合理的防禦性
  措施，繼續留著當第二層保護），但它並不是這次 OOM 真正的原因，記錄在這裡
  提醒自己：**先查證據，再下修法**，不要靠猜測就動手改程式碼。

跑全部測試（`functions/` 目錄底下）：

```bash
cd firebase-migration/functions
npm install
npm test
```

## 還沒做的事（下一步）

- **因子模型資料的遷移工具已經就緒、`functions/index.js` 也已經接上，
  但還沒對真實的 FactorModelHistory 資料跑過一次**：`migration/
  factor_model_history/`（`transform.js`/`checks.js`/`export-sheets.gs`/
  `import-firestore.js`/`validate.js`，跟其他六組同一套流程，見上方「跟
  其他表不同的地方」）負責把 Sheets 資料搬進 Firestore；
  `functions/index.js` 的 `fetchAppliedFactorModels_()` 已經會讀
  `factor_model_history` 裡 `applied === true` 的文件餵給
  `reportPipeline.buildReport_`（有對應的單元測試驗證這條路徑，見
  `functions/test/reportPipeline.test.js` Test 7）。下一步是照 Phase 2
  的驗證模式（Cloud Shell 匯出 → dry-run → 正式寫入 → `validate.js`）
  把這張表真的搬過去，再重新部署一次 `generateDailyReport`，確認
  `hybrid`/`factor_model_rank` 真的能產生訊號、`predictedReturn1m`／
  `predictedDownsideResistance` 兩個欄位不再是 `null`。
  **`config/app` 的 `screeningStrategy` 目前在正式環境裡是 `rule_v17`**
  （部署驗證時從原本遷移過來的 `hybrid` 手動切過去的——`hybrid` 在因子
  模型資料遷移完成前，`generateDailyReportScheduled` 每天都會是
  `reportCount: 0`，不是壞掉，只是正確地因為缺資料而不產生訊號。因子模型
  資料遷移完成後，可以隨時切回 `hybrid`）。
- **背景 job 狀態機**：`startAnalysisJob`/`processAnalysisJobTick_` 這類
  機制在 Cloud Functions 世界不需要照搬——Cloud Functions 本身沒有 Apps
  Script 的 6 分鐘執行上限跟一次性觸發器不可靠的問題，這段「背景 job 繞過
  瀏覽器分頁中斷」的設計是 Apps Script 平台限制逼出來的，`index.js` 已經
  用一個同步執行的 HTTPS Function + Cloud Scheduler 排程取代，不需要整套
  狀態機搬過去。
- **xlsx 完整快照匯出**：`apps-script/src/Analysis.gs` 的
  `exportReportToDrive_()`（存一份完整欄位的 xlsx 到 Drive）還沒有 Firebase
  版對應，如果這個功能還需要保留，大概會改成寫進 Cloud Storage，目前還沒
  決定要不要做。
