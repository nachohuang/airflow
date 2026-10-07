# Firebase 遷移工具（Phase 1 / Phase 2 / Phase 3 完成，Phase 5 進行中）

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

- factor_model_history（2026-10-05，18 筆真實資料，`✅ 通過`——Phase 3 跟
  `Analysis.gs` 戰報邏輯一起遷移，不是 Phase 2 的範圍，其中剛好兩筆
  `applied: true`，對應目前生效的 `return1m`／`downsideResistance` 兩個
  版本，見下方「Phase 3」章節）

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
- **坑 3：切換篩選策略重跑後，Firestore 裡新舊策略的結果混在一起**：先用
  `rule_v17` 跑出 79 筆訊號，遷移完 `factor_model_history` 後切回 `hybrid`
  重跑只產生 8 筆——結果 Firestore `reports/{date}/signals` 底下還是有
  79 份文件，其中只有新的 8 筆有正確的 `predictedReturn1m`／
  `predictedDownsideResistance`，其餘 71 筆是 `rule_v17` 那次留下來、沒被
  清掉的舊資料，兩次不同策略、不同時間點的結果疊在一起，不是真正的「當天
  戰報」。原因是 `writeReportDocs_` 只對這次算出來的 `reportDocs` 做
  `set()`，從來沒有刪過「這次沒再出現」的舊文件。**修法**：寫入前先讀一次
  同一天既有的文件，把不在這次 `reportDocs` 清單裡的舊文件一併刪除，跟
  新文件的 `set()` 合併成同一輪批次寫入（操作數可能超過 Firestore 單批
  500 筆上限，用跟 AiDiagnosis／IndustryMap 一樣的分批寫入處理）。
  **已重新部署驗證**：修好之後同一天重跑 `hybrid`，Firestore 文件數
  （8）跟 `reportCount`（8）完全一致，8 筆的 `predictedReturn1m`／
  `predictedDownsideResistance` 都不是 `null`，沒有任何舊策略留下來的
  殘留文件。

跑全部測試（`functions/` 目錄底下）：

```bash
cd firebase-migration/functions
npm install
npm test
```

## Watchlist／Portfolio 讀寫邏輯（2026-10-05）

跟戰報計算（`generateDailyReport`）不同，這批是給之後的前端（Phase 5）直接
呼叫的使用者操作（加入觀察清單、記一筆買進、標示賣出……），所以用
`onCall`（Firebase Callable Function），不是 `onRequest`/`onSchedule`——
`onCall` 自帶 Firebase Auth 驗證跟結構化錯誤（`HttpsError`）回傳，不用自己
重新發明一套。

- `functions/lib/watchlist.js` — 從 `apps-script/src/Watchlist.gs` 拆出來的
  純邏輯：`buildWatchlistItems_`（依加入日期新到舊排序，補上最新收盤價／
  名稱／戰報燈號）、`assertNotHolding_`（跟持股庫存互斥檢查）、
  `mergeWatchlistDoc_`（`addToWatchlist` 的 upsert 合併規則）。
- `functions/lib/portfolioOps.js` — 從 `apps-script/src/Portfolio.gs` 拆出來
  的純邏輯：`buildPortfolioCards_`（依代號把持有中的買進紀錄聚合成卡片，
  共用 `lib/portfolio.js` 的 `aggregateLots_` 做加權平均成本的數學）、
  `buildClosedHistory_`（依代號+賣出日期+賣出價格分組算已實現損益）。跟
  `lib/portfolio.js` 的 `buildPortfolioMap_` 不是同一支——那支是給戰報計算
  用的精簡版 `{code: {cost, buyDate}}`，這支是給「持股庫存」頁面用、要保留
  每一筆個別買進紀錄跟卡片顯示用欄位的完整版。
- `functions/lib/bigquery.js` 新增 `buildHistoryRowsForCodesSql_`——從
  `apps-script/src/BigQuerySync.gs` 的 `buildHistoryRowsForStocksSql_` 複製，
  只查「指定幾檔代號」的原始列，跟戰報用的全市場查詢（`buildHistoryRangeSql_`）
  完全無關，資料量小，不會有 OOM 風險，所以不需要 `stocksOnly` 這種全市場
  專用的過濾條件。
- `functions/index.js` 新增：
  - `fetchBqInfoForCodes_`——Watchlist／Portfolio 卡片要顯示的「最新收盤價」
    跟名稱補救，統一用**同一次** BigQuery 查詢取得（查「這幾檔代號最近
    10 天的原始列」，同時拿到最新收盤價跟最新一筆的證券名稱）。跟
    apps-script 版 `getStockNameByCode`／`getLatestCloseByCode_` 兩支各自
    查一次不同，這裡只查一次，省一次 BigQuery 費用——這是蓄意的效率改進，
    不是照搬 apps-script 版的兩次查詢設計。
  - `fetchLatestSignalsByCode_`——查 Firestore `reports/{date}/signals`
    底下指定代號各自最新一筆戰報燈號。跟 apps-script 版掃整個 Reports
    分頁找每檔代號最大日期的那一筆不同：Firestore 版戰報依日期分
    subcollection 存，這裡改用 `collectionGroup('signals')` 查詢只查
    需要的這幾檔，不用掃全部歷史戰報。**需要 `signals` 這個 collection
    group 上 `(code ASC, date DESC)` 的複合索引**（見下方「需要的 Firestore
    複合索引」）。
  - 8 個 `onCall` function：`getWatchlist`／`addToWatchlist`／
    `removeFromWatchlist`／`getPortfolio`／`savePortfolioItem`／
    `deletePortfolioLot`／`closePortfolioPosition`／
    `getClosedPortfolioHistory`，直接對應 `Watchlist.gs`／`Portfolio.gs`
    的同名函式。**`deletePortfolioItem`（依代號刪光全部持有中紀錄）刻意
    沒搬**——apps-script 版自己的註解就說明那是「舊版前端相容用」，新版
    前端一律用 `deletePortfolioLot(lotId)` 刪除單一一筆，不需要這支。
- `functions/test/watchlist.test.js`／`portfolioOps.test.js`——分別驗證
  上面兩個 `lib/` 檔案的純邏輯，不需要雲端憑證；`test/bigquery.test.js`
  也補了 `buildHistoryRowsForCodesSql_` 的測試案例（IN 子句、選填的
  `startStr`、代號字串裡的單引號要被濾掉避免 SQL injection）。

**需要的 Firestore 複合索引**（`firestore/firestore.indexes.json`，已經接進
`firebase.json` 的 `firestore.indexes`，執行 `firebase deploy
--only firestore:indexes` 或完整的 `firebase deploy` 就會一起建立）：

- `signals`（collection group）：`(code ASC, date DESC)`——
  `fetchLatestSignalsByCode_` 需要。
- `portfolio_lots`：`(code ASC, status ASC)`——`closePortfolioPosition`
  查「某代號目前持有中的所有紀錄」需要，也是 `firestore/schema.md` §2
  一開始就寫好要建的索引。
- `signals`（collection group）的 `date` 欄位單欄索引（`fieldOverrides`
  裡的設定，不是 `indexes` 那個複合索引陣列）——`frontend/src/components/
  dashboard/DashboardView.vue` 單純查「`signals` 底下 `date` 最新的
  一筆」（`collectionGroup('signals').orderBy('date','desc').limit(1)`，
  沒有搭配其他欄位的等號條件）需要。**這個真的部署驗證過才發現**：
  Firestore 對「一般 collection」範圍的每個欄位本來就會自動建單欄索引
  （升冪＋降冪都有），但這個自動行為**不包含 collection group 範圍**，
  即使只是單欄位、不需要複合索引的查詢，只要是 collection group 範圍
  就一定要透過 `fieldOverrides` 手動開啟——沒開會在瀏覽器 console 看到
  `The query requires a COLLECTION_GROUP_DESC index for collection
  signals and field date` 這種錯誤，附的連結點進去可以手動建，但我們
  已經用 `firestore.indexes.json` 宣告過，用那個連結建的話下次 deploy
  可能會跟宣告檔衝突，一樣不建議用那條路（跟前面「需要的 Firestore
  複合索引」提過的原則一致）。

⚠️ 跟 `generateDailyReport` 一樣，這 8 個 `onCall` function 本身沒辦法在
這個開發環境驗證（沒有真正的雲端憑證）——`lib/` 的純邏輯已經靠單元測試
驗證過，實際部署後要驗證的只是「接線有沒有接對」跟「複合索引建好了沒」。
詳細的部署＋驗證步驟見下方「部署驗證：Watchlist／Portfolio」。

**🔒 擁有者驗證（`assertOwnerAuth_`）**：寫完第一版之後發現這 8 支
`onCall` function 都沒檢查 `request.auth`——`firestore.rules` 的
`isOwner()` 只保護前端「直接」讀寫 `watchlist`／`portfolio_lots` 這兩個
collection，Cloud Functions 用 Admin SDK 完全不受那份規則限制，等於
部署後任何人知道 function URL 就能呼叫 `savePortfolioItem`／
`closePortfolioPosition` 竄改資料，不需要登入。修法：每一支進入點第一行
都呼叫 `assertOwnerAuth_(request)`，跟 `firestore.rules` 用同一個擁有者
email 比對 `request.auth.token.email`，沒登入或帳號不對就丟
`HttpsError('permission-denied', ...)`。這是部署驗證時一定要測到的一條
路徑（見下方步驟 4）。

## 部署驗證：Watchlist／Portfolio（2026-10-05）

跟戰報計算不同，這 8 支是 `onCall`（Callable Function），不能像
`generateDailyReport` 那樣直接 `curl` 一個普通 HTTPS URL 就測完——
Callable Function 有自己的呼叫協定（body 要包成 `{"data": {...}}`，
回應包在 `{"result": ...}` 或 `{"error": ...}` 裡），而且**一定要帶擁有者
的 Firebase ID Token**（見上面「🔒 擁有者驗證」），不然全部會被
`assertOwnerAuth_` 擋掉。以下在 Cloud Shell 跑，延續 Phase 2/3 其他遷移
驗證時用的同一個專案（`flash-arbor-365706`，用你自己的專案 ID 替換）。

```bash
# 0. 更新程式碼、裝依賴、部署前先跑一次單元測試（純邏輯這層先確認沒壞）
cd ~/airflow   # 換成你 clone 的路徑
git pull origin claude/stock-data-apps-script-w1wsk1
cd firebase-migration/functions
npm install
npm test   # 全部要過，包含新的 watchlist.test.js／portfolioOps.test.js／bigquery.test.js

# 1. 部署 Cloud Functions + Firestore 複合索引（firestore.indexes.json 裡
#    宣告的兩個索引會在這次 deploy 一起建立）
cd ~/airflow/firebase-migration
firebase deploy --only functions,firestore:indexes

# 2. 索引建立是非同步的，deploy 指令跑完不代表已經 READY——
#    getWatchlist/getPortfolio（內部查 fetchLatestSignalsByCode_）跟
#    closePortfolioPosition 都要等索引就位才能正常運作，確認狀態：
PROJECT_ID=$(gcloud config get-value project)
gcloud firestore indexes composite list --project="$PROJECT_ID" --format="table(name,state)"
# 兩個索引都要是 READY 才繼續下一步（CREATING 通常幾分鐘內會完成，重跑這行刷新狀態）
```

**準備擁有者的 ID Token**（Callable Function 的呼叫協定需要真正登入過的
Firebase Auth 使用者，不是隨便一個 service account 的 token）：

```bash
# 3. 拿專案的 Web API Key——Console 路徑：專案設定（齒輪圖示）→ 一般 →
#    「Web API 金鑰」欄位；或在 Cloud Shell 用這行試著自動抓：
WEB_API_KEY=$(gcloud services api-keys list --project="$PROJECT_ID" \
  --filter="displayName:'Browser key (auto created by Firebase)'" --format="value(name)" \
  | xargs -I{} gcloud services api-keys get-key-string {} --format="value(keyString)")
echo "$WEB_API_KEY"   # 抓不到就手動去 Console 複製，貼進來 export WEB_API_KEY=...

# 4. 幫擁有者帳號（nachohuang@gmail.com）鑄一個 custom token，再跟 Identity
#    Toolkit 換成真正的 ID Token——這一步要求這個帳號已經在 Firebase Auth
#    留過登入紀錄（Phase 0 設定時應該已經用這個帳號登入過一次；如果
#    getUserByEmail 找不到，代表還沒登入過，先用任何一個開了 Google 登入
#    的 Firebase Auth 測試頁面登入一次這個帳號再重跑這步）。
#
#    ⚠️ 坑：admin.initializeApp() 不帶參數時，Cloud Shell 裡沒有真正的 ADC
#    json 檔案（是跟 gcloud 登入整合的 metadata-server 式憑證，不是檔案），
#    createCustomToken() 找不到私鑰可以本地簽章，會改打 IAM 的 signBlob API
#    遠端簽，而那次呼叫會因為「沒設 quota project」被 403 擋掉——
#    `gcloud auth application-default set-quota-project` 修不了，因為它要改
#    的 ADC 檔案本身就不存在。繞過去的辦法：改用一把真的帶私鑰的服務帳戶
#    金鑰（每個 Firebase 專案都會自動建一個 firebase-adminsdk 服務帳戶），
#    createCustomToken() 找到私鑰就本地簽章，完全不用打網路 API：
SA_EMAIL=$(gcloud iam service-accounts list --project="$PROJECT_ID" \
  --filter="email~firebase-adminsdk" --format="value(email)")
echo "SA_EMAIL=$SA_EMAIL"   # 應該看到 firebase-adminsdk-xxxxx@你的專案.iam.gserviceaccount.com

gcloud iam service-accounts keys create /tmp/sa-key.json \
  --iam-account="$SA_EMAIL" --project="$PROJECT_ID"
export GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa-key.json

cd ~/airflow/firebase-migration/functions   # 要在有 firebase-admin 的目錄跑
cat > mint-token.js <<'EOF'
const admin = require('firebase-admin');
admin.initializeApp();
(async () => {
  const user = await admin.auth().getUserByEmail('nachohuang@gmail.com');
  console.log(await admin.auth().createCustomToken(user.uid));
})().catch(e => { console.error(e); process.exit(1); });
EOF
# 注意：腳本要寫在目前目錄（functions/），不要寫到 /tmp——node 的 require 是依
# 腳本檔案自己的位置找 node_modules，寫到 /tmp 會因為那裡沒有 node_modules
# 直接 Cannot find module 'firebase-admin'。
CUSTOM_TOKEN=$(node mint-token.js)
echo "custom token length: ${#CUSTOM_TOKEN}"   # 要 > 0
rm mint-token.js

ID_TOKEN=$(curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"${CUSTOM_TOKEN}\", \"returnSecureToken\": true}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['idToken'])")
echo "${ID_TOKEN:0:24}...(已省略，拿到非空字串就對)"

REGION="us-central1"   # RUNTIME_OPTS_ 沒指定 region，v2 預設是 us-central1
FN_URL="https://${REGION}-${PROJECT_ID}.cloudfunctions.net"
```

⚠️ **整個驗證流程跑完之後一定要刪掉這把服務帳戶金鑰**——它是長期有效的
密鑰，留著是風險，不是驗證完就自動失效：

```bash
gcloud iam service-accounts keys list --iam-account="$SA_EMAIL" --project="$PROJECT_ID" \
  --format="table(name.basename(), validAfterTime)" --sort-by="~validAfterTime"
# ⚠️ 下面這行的 KEY_ID 是「要你換成上一行印出來、最上面那筆的 40 碼 ID」的
# 佔位字元，不是指令本身的一部分——照抄貼上去會是字面上的「KEY_ID」四個字，
# gcloud 會回報 INVALID_ARGUMENT。例如上一行印出 c072973b881611468a144cd89ee6d2b4fc2b4eff
# 就是把下面的 KEY_ID 換成那串 40 碼字串。
gcloud iam service-accounts keys delete KEY_ID --iam-account="$SA_EMAIL" --project="$PROJECT_ID" --quiet
rm -f /tmp/sa-key.json
unset GOOGLE_APPLICATION_CREDENTIALS
```

**驗證擁有者檢查真的擋得住（負向測試，先測這個再測正常流程）**：

```bash
# 5. 不帶 Authorization header 呼叫，應該被 assertOwnerAuth_ 擋下來
curl -s -X POST "${FN_URL}/getWatchlist" -H "Content-Type: application/json" -d '{"data": {}}' | python3 -m json.tool
# 預期：{"error": {"status": "PERMISSION_DENIED", "message": "只有擁有者本人登入後才能呼叫這個功能。"}}
```

**正常流程（帶 ID Token）**：

```bash
# 6. getWatchlist——先看現況（Phase 2 應該已經有從 Sheets 遷移過來的資料）
curl -s -X POST "${FN_URL}/getWatchlist" \
  -H "Authorization: Bearer ${ID_TOKEN}" -H "Content-Type: application/json" \
  -d '{"data": {}}' | python3 -m json.tool

# 7. addToWatchlist——加一檔測試用股票，確認 latestClose/name 有從 BigQuery 補上
curl -s -X POST "${FN_URL}/addToWatchlist" \
  -H "Authorization: Bearer ${ID_TOKEN}" -H "Content-Type: application/json" \
  -d '{"data": {"code": "2330", "name": "", "note": "部署驗證用"}}' | python3 -m json.tool
# 預期回傳陣列裡的 2330 項目：name 補成「台積電」、latestClose 是數字不是 null

# 8. 交叉比對 Firestore 裡的文件（不透過 callable function，直接讀）
node -e "
const admin = require('firebase-admin');
admin.initializeApp();
admin.firestore().collection('watchlist').doc('2330').get().then(s => console.log(s.data()));
"

# 9. 驗證「跟持股互斥」真的擋得住——先找一檔目前持有中的代號：
node -e "
const admin = require('firebase-admin');
admin.initializeApp();
admin.firestore().collection('portfolio_lots').where('status','==','holding').limit(1).get()
  .then(s => s.forEach(d => console.log('holding code:', d.data().code)));
"
# 把印出來的 code 換進下面這個呼叫，預期 error.status 是 FAILED_PRECONDITION
curl -s -X POST "${FN_URL}/addToWatchlist" \
  -H "Authorization: Bearer ${ID_TOKEN}" -H "Content-Type: application/json" \
  -d '{"data": {"code": "填入上面印出來的 code"}}' | python3 -m json.tool

# 10. removeFromWatchlist——清掉步驟 7 的測試資料
curl -s -X POST "${FN_URL}/removeFromWatchlist" \
  -H "Authorization: Bearer ${ID_TOKEN}" -H "Content-Type: application/json" \
  -d '{"data": {"code": "2330"}}' | python3 -m json.tool

# 11. getPortfolio——確認現有持股卡片（加權平均成本/latestClose/signal）跟
#     Firestore portfolio_lots 的實際內容對得起來
curl -s -X POST "${FN_URL}/getPortfolio" \
  -H "Authorization: Bearer ${ID_TOKEN}" -H "Content-Type: application/json" \
  -d '{"data": {}}' | python3 -m json.tool
```

**持股寫入類操作會動到真正的生產資料**，建議用一檔你自己也打算小量測試
的股票代號跑完整個「新增→改單→平倉→查歷史→刪除」迴圈，而不是隨便塞假
代號（`latestClose` 查不到真實資料、卡片會顯示 `null`，但不影響驗證邏輯
本身對不對）：

```bash
# 12. savePortfolioItem（新增）——記得改成你要測試的代號/價格/股數
curl -s -X POST "${FN_URL}/savePortfolioItem" \
  -H "Authorization: Bearer ${ID_TOKEN}" -H "Content-Type: application/json" \
  -d '{"data": {"code": "0050", "cost": 150, "buyDate": "2026-10-05", "shares": 100, "note": "部署驗證用，測完會刪除"}}' \
  | python3 -m json.tool
# 從回應的 lots 陣列裡記下這筆的 id（lotId），下面步驟要用

# 13. savePortfolioItem（編輯既有一筆）——帶 lotId 改備註，確認改到同一筆
curl -s -X POST "${FN_URL}/savePortfolioItem" \
  -H "Authorization: Bearer ${ID_TOKEN}" -H "Content-Type: application/json" \
  -d '{"data": {"lotId": "填入步驟12的lotId", "code": "0050", "cost": 150, "shares": 100, "note": "已編輯"}}' \
  | python3 -m json.tool

# 14. closePortfolioPosition（平倉）——把這筆標記已賣出
curl -s -X POST "${FN_URL}/closePortfolioPosition" \
  -H "Authorization: Bearer ${ID_TOKEN}" -H "Content-Type: application/json" \
  -d '{"data": {"code": "0050", "sellDate": "2026-10-05", "sellPrice": 155}}' \
  | python3 -m json.tool
# 預期回傳的持股卡片陣列裡已經看不到 0050（平倉後不再是 holding）

# 15. getClosedPortfolioHistory——確認剛平倉的這筆出現，realizedPct/realizedAmount 算對
curl -s -X POST "${FN_URL}/getClosedPortfolioHistory" \
  -H "Authorization: Bearer ${ID_TOKEN}" -H "Content-Type: application/json" \
  -d '{"data": {}}' | python3 -m json.tool
# (155-150)/150*100 = 3.33...，(155-150)*100 = 500，核對回應裡的數字

# 16. deletePortfolioLot——清掉這筆測試紀錄（用步驟12的lotId）
curl -s -X POST "${FN_URL}/deletePortfolioLot" \
  -H "Authorization: Bearer ${ID_TOKEN}" -H "Content-Type: application/json" \
  -d '{"data": {"lotId": "填入步驟12的lotId"}}' | python3 -m json.tool
```

全部跑完，`getWatchlist`／`getPortfolio`／`getClosedPortfolioHistory` 應該
都回到跑這輪驗證之前的狀態（測試用的 2330 觀察清單項目、0050 買賣紀錄都
清乾淨了），其他步驟的錯誤路徑（步驟 5 的無登入、步驟 9 的跟持股互斥）都
要回傳對應的 `error.status`，不是意外的 200/`result`。

**✅ 2026-10-06 已在 `flash-arbor-365706` 完整驗證成功**，照上面整套步驟
跑過一輪，全部符合預期：

- 無登入呼叫 `getWatchlist` → `error.status: PERMISSION_DENIED`。
- `getWatchlist` 讀到真實資料（既有的 `6491` 晶碩），`addToWatchlist`
  加入 `2330` 後 `name` 自動從 BigQuery 補成「台積電」、`latestClose`
  有實際數字、`addedDate` 是正確的台北時區今天日期（`todayStrTaipei_()`
  算對了），而且依加入日期新到舊排序正確。
- 對目前持有中的代號（`4104`）呼叫 `addToWatchlist` → `error.status:
  FAILED_PRECONDITION`，`assertNotHolding_` 擋住了。
- `removeFromWatchlist` 清除測試項目後只剩原本的 `6491`。
- `getPortfolio` 讀到 4 張真實持股卡片，其中 `9910`（5 筆分批買進的
  lot）手動核對加權平均成本 `(20×68.95+55×68.53+125×68.3+30×67.7+
  20×67.9)/250 = 68.2986`，跟回應裡的 `cost` 完全一致，`lots` 也正確
  依買進日期排序。
- `savePortfolioItem` 新增測試用 `0050` 一筆、再帶 `lotId` 編輯備註
  （確認是改同一筆、不是多出一張卡片）、`closePortfolioPosition`
  平倉後卡片消失、`getClosedPortfolioHistory` 裡 `realizedPct: 3.33`／
  `realizedAmount: 500` 跟手算的 `(155-150)/150*100`／`(155-150)*100`
  一致、`deletePortfolioLot` 刪除後完全恢復成驗證前的 4 張卡片。

部署驗證過程另外踩到兩個跟這台 Cloud Shell 環境本身有關的坑（跟
`lib/`／`index.js` 的程式碼邏輯無關，純粹是驗證工具鏈的問題，已經更新進
上面的步驟說明，這裡另外記一次方便之後查）：

- **鑄 custom token 時的 ADC quota project 403**：`admin.initializeApp()`
  不帶參數在 Cloud Shell 裡找不到本地私鑰，`createCustomToken()` 改打
  遠端 IAM API 簽章，撞到「沒設 quota project」，而 Cloud Shell 的 ADC
  又不是檔案形式，`gcloud auth application-default set-quota-project`
  修不了。改用 `firebase-adminsdk` 服務帳戶的真正金鑰（`GOOGLE_
  APPLICATION_CREDENTIALS` 指過去）解決——帶私鑰就能本地簽章，不用打
  那支 API。
- **`getUserByEmail` 找不到擁有者帳號**：`nachohuang@gmail.com` 在這個
  專案的 Firebase Auth 裡原來還沒有使用者紀錄（Phase 0 設定當時可能只
  開了 Google 登入方式，沒有真的登入過一次）。用 `admin.auth().
  createUser({email, emailVerified: true})` 手動建一筆解決，之後
  Phase 5 做真的前端、這個帳號真的走一次 Google 登入時，Firebase Auth
  預設的「每個 email 一個帳號」設定會自動併到這筆，不會變成兩個獨立
  帳號。

## 還沒做的事（下一步）

- ~~因子模型資料遷移 + `hybrid`/`factor_model_rank` 接線驗證~~ ✅
  **2026-10-05 已完成**：`factor_model_history`（18 筆真實資料）已遷移、
  `functions/index.js` 的 `fetchAppliedFactorModels_()` 已接上、
  `screeningStrategy` 目前在正式環境裡是 `hybrid`，重新部署後驗證過
  `reportCount: 8`、Firestore 文件數跟 `reportCount` 一致、
  `predictedReturn1m`／`predictedDownsideResistance` 都有實際數值（見上方
  「坑 3」的完整記錄）。
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

# Phase 5：前端（2026-10-06 開始）

跟 Phase 3 的 `functions/lib/`（複製、decoupling，見上面「架構決定」）不同，
前端是**從零開始寫一份新的**，不是從 `apps-script/src/Index.html`／
`JavaScript.html`／`Stylesheet.html` 複製修改——舊版是純手寫 DOM 操作
全部塞在一支 3000 多行的 `JavaScript.html`，新版改用元件化的前端框架，
架構上沒有照搬的理由，只是功能要對齊。

## 技術選型：Vue 3 + Vite

跟純手寫 HTML/JS（舊版的路線）相比，選框架主要是為了：

1. **Firestore 有即時監聽（`onSnapshot`）**——之後如果要把現在「呼叫
   `onCall` function 才刷新一次」的作法升級成即時推送，響應式狀態管理
   跟 `onSnapshot`是天生一對，不用像舊版那樣自己寫輪詢（舊版
   `JavaScript.html` 裡 `getAnalysisJobStatus`/`getAiDiagnosisJobStatus`
   那堆輪詢邏輯，就是沒有即時推送機制逼出來的 workaround）。目前這版
   還沒用到 `onSnapshot`（還是呼叫完 `onCall` function 重新 `getXxx()`
   一次），先把架構搭好，之後要換不用重寫元件邏輯。
2. 舊版 `JavaScript.html` 已經長到 3000 多行全部塞在一支檔案——元件化
   可以把「一張持股卡片」「一個表單」拆成獨立、可重複使用的小塊，不會
   越改越亂。

Vue（相對 React）樣板程式碼少、學習曲線平；Vite 是搭配 Vue 的標準建置
工具，`npm create vite@latest frontend -- --template vue` 就是這份
`frontend/` 目錄的起點。

## 這裡有什麼

- `frontend/src/firebase.js` — Firebase 客戶端 SDK 初始化（跟
  `functions/` 用 `firebase-admin` 的伺服端初始化是兩套東西，權限等級
  差很多，真正的存取控制在 Cloud Functions 的 `assertOwnerAuth_` 跟
  Firestore Security Rules，不是這裡）。設定值從 `.env`（複製
  `.env.example`，不進版控）讀，不寫死在程式碼裡。
- `frontend/src/composables/useAuth.js` — 全域登入狀態（`onAuthStateChanged`
  只訂閱一次），`signIn()`/`signOut()` 包 Google 登入彈窗。
- `frontend/src/composables/useCallable.js` — 呼叫 `onCall` function 的
  統一入口 `callFn(name, data)`，跟舊版 `JavaScript.html` 的
  `callServer()` 同一個精神（但底層協定不同，這裡是 Firebase callable
  SDK，不是 `google.script.run`）。
- `frontend/src/components/LoginScreen.vue`／`AppShell.vue` — 登入畫面、
  App 整體骨架（頂部列＋底部四個主 tab）。四個主 tab 對照舊版
  `Index.html` 的 `data-tab="dashboard"/"portfolio"/"research"/"admin"`，
  **目前「📊 戰報與個股」「💼 持股庫存」「⚙️ 系統與資料後台」可以點**，
  「🧪 策略研究」還顯示「這個頁面還沒遷移」的占位訊息——不是漏做，回測
  跟因子掃描的後端邏輯還沒遷移完，先讓使用者清楚知道要去舊版用，不要讓
  畫面看起來像壞掉。預設停在「戰報與個股」，跟舊版 `Index.html` 的預設
  tab 一致（最常看的頁面）。
- `frontend/src/components/dashboard/DashboardView.vue` — 戰報清單，
  **直接用 Firestore client SDK 讀 `reports/{date}/signals`**，不是走
  `onCall` function：`firestore.rules` 本來就開放擁有者讀這個
  collection（見 `firestore/schema.md` §3），用 `onSnapshot` 即時監聽
  （不是读一次就結束），之後排程重算戰報時畫面會自動更新，不用使用者
  手動刷新。找「最新一天是哪天」用 `collectionGroup('signals')` 查
  `date` 欄位排序取第一筆——`reports/{date}` 這個父文件本身從來沒被
  寫過任何欄位（`writeReportDocs_` 只寫 `signals` 這個 subcollection），
  直接查 `reports` collection 找不到任何文件。股票搜尋跟點進去看走勢圖/AI
  診斷的詳情頁後來補上了，見下面「股票詳情（Stock Detail）」那節；即時
  報價、跑新的 AI 診斷還沒做（那些需要新的 Cloud Function／Secret
  Manager，刻意先跳過）。卡片欄位對照舊版 `apps-script/src/JavaScript.html`
  戰報卡片的 `fmtNum`／百分比慣例調整過：`Trend_Score`／`Inst_Part_Rank`／
  `IBF_20D_Rank` 這幾個原始排名欄位舊版卡片本身就沒有顯示（已經折算進
  `Armor_Score` 裡了），刻意不跟著顯示；`predictedReturn1m`／
  `predictedDownsideResistance` 格式化成帶正負號的百分比（部署驗證時
  第一版忘了格式化，顯示成一長串原始小數，跟舊版卡片的風格對不起來，
  照舊版補上）。
- `frontend/src/components/portfolio/` — 持股庫存頁面，對照舊版
  `Index.html` 持股庫存分頁底下的三個 sub-tab：
  - `PortfolioView.vue`：sub-tab 切換（持有中／👀 觀察個股／💰 歷史結案紀錄）。
  - `HoldingList.vue`：呼叫 `getPortfolio`／`savePortfolioItem`／
    `deletePortfolioLot`／`closePortfolioPosition`，卡片+新增/編輯表單+
    平倉表單。
  - `WatchlistList.vue`：呼叫 `getWatchlist`／`addToWatchlist`／
    `removeFromWatchlist`。
  - `ClosedHistoryList.vue`：呼叫 `getClosedPortfolioHistory`，純讀取表格。
- `frontend/src/components/admin/AdminView.vue` — 系統與資料後台，跟
  `DashboardView.vue` 一樣**直接用 Firestore client SDK 讀寫
  `config/app`／`skip_dates`**（`firestore.rules` 本來就開放擁有者直接
  讀寫這兩個 collection，見 `firestore/schema.md` §5／§8），不需要新的
  `onCall` function。做了四組設定：
  - `screeningStrategy`（下拉選單，對應 `functions/lib/analysis.js` 的
    `SCREENING_STRATEGIES`，跟手動用 Firestore 指令切換 `rule_v17`/
    `hybrid` 是同一個欄位，現在可以直接在畫面上切換，不用再開 Cloud
    Shell）。
  - `bigQuery.sourceMode`（下拉選單，對應 `functions/lib/bigquery.js`
    的 `sourceRefForRead_`）。
  - **每日排程**（`triggerHour`／`triggerMinute`／`skipWeekends`）跟
    **不跑日**（`skip_dates` collection）——這兩個一開始刻意沒做（舊版
    的 Cloud Scheduler cron 是寫死的，完全沒讀這幾個欄位，做了也是假
    按鈕），後來發現這不只是沒畫面，是後端邏輯真的缺了這塊（`skip_dates`
    Phase 2 就遷移好了，但排程從來沒檢查過），回頭補上，詳見下面
    「每日排程與不跑日」那節。

  `bigQuery.projectId`／`dataset`／`pricePerTb` 沒開放編輯（打錯字會讓
  戰報整個查不到資料，風險比效益高，要改先去 Firebase Console 的
  Firestore 頁面直接編輯文件）。AI 金鑰設定、AI 用量統計（在 BigQuery，
  不在 Firestore，見「資料庫分工」的說明）、History 補抓/整理工具都還
  沒做。
- `firebase.json` 加了 `hosting` 設定（`public: "frontend/dist"`，SPA
  rewrite 全部導回 `index.html`）。

## 部署前要確認的事（Console 手動步驟，沒辦法自動化）

1. **Firebase Console → Authentication → Sign-in method → 確認 Google
   登入方式是「啟用」狀態**。`firestore.rules` 的註解當時假設 Phase 0
   已經開了，但部署驗證 Watchlist/Portfolio 時發現擁有者帳號在這個專案
   裡其實還沒有 Auth 使用者紀錄（見上面「部署驗證」那節的坑記錄）——
   不確定的話去確認一次，不要假設。
2. **Firebase Console → 專案設定 → 一般 → 「你的應用程式」→ 註冊一個
   網頁應用程式**（如果還沒註冊過），拿到 `apiKey`／`authDomain`／
   `projectId`／`appId` 這幾個值。不用勾選「設定 Firebase Hosting」那個
   選項，我們是用 `firebase deploy` 部署，不需要它自動生成的那段流程。
3. 把這幾個值填進 `frontend/.env`（複製 `frontend/.env.example`）。

## 部署＋驗證步驟（Cloud Shell）

```bash
cd ~/airflow
git pull origin claude/stock-data-apps-script-w1wsk1
cd firebase-migration/frontend
npm install
# 確認 .env 已經照上面「部署前要確認的事」填好，沒填會在瀏覽器 console
# 看到 firebase.js 印出來的錯誤提示
npm run build

cd ~/airflow/firebase-migration
firebase deploy --only hosting
```

部署完指令會印出網址（`https://<project-id>.web.app`，也可能同時有
`https://<project-id>.firebaseapp.com`），**用你自己平常的瀏覽器打開**
（不是 Cloud Shell 的 Web Preview——Google 登入彈窗需要的 OAuth 授權網域
預設只包含 `localhost` 跟這兩個 Firebase 網域，Cloud Shell Web Preview
的網域不在裡面，彈窗登入會直接失敗）：

1. 打開網址，應該看到登入畫面，按「使用 Google 登入」，用擁有者帳號登入。
2. 登入後應該直接進入「💼 持股庫存」頁面（因為其他三個 tab 目前是
   disabled 狀態）。
3. 「持有中」子分頁應該看到目前真實的持股卡片（跟上面 curl 驗證時看到
   的那幾張卡片一致）。
4. 切到「👀 觀察個股」，確認看到既有的觀察清單項目；試著加一檔測試用
   代號，確認出現在列表裡，`latestClose`/名稱有補上；再移除掉。
5. 切到「💰 歷史結案紀錄」，確認看到過去的結案紀錄（如果有的話）。
6. 回「持有中」試著新增一筆測試用持股→編輯→標示已賣出→確認出現在
   歷史結案紀錄→刪除這筆測試紀錄，跟上面 curl 那輪驗證的邏輯一樣，只是
   這次是透過真正的網頁介面操作。

**✅ 2026-10-06 已在 `flash-arbor-365706` 用真實瀏覽器（手機）驗證登入
＋持股庫存卡片成功。** 過程中踩到三個坑，都是部署環境本身的問題，不是
前端程式碼邏輯有錯：

- **Browser key 的 referrer 限制清單是空的**：Firebase 自動建立的
  「Browser key (auto created by Firebase)」這把 API key，`apiTargets`
  已經正確包含 `identitytoolkit.googleapis.com`，但
  `browserKeyRestrictions.allowedReferrers` 是空清單——等於擋掉所有
  真正從瀏覽器送出的請求（`Referer` header 存在才會被這條規則檢查，
  Cloud Shell 用 curl 測試不會帶 `Referer`，所以一直測不出這個問題）。
  用 `gcloud services api-keys update KEY_NAME --allowed-referrers=
  "https://<project-id>.web.app/*,https://<project-id>.firebaseapp.com/*"`
  補上部署後的 Hosting 網域解決。
- **`.env` 裡的 apiKey 被意外存成遮罩過的佔位字元**：排查到最後發現
  `.env` 裡的 `VITE_FIREBASE_API_KEY` 實際上是一串 `•`（因為在對話中
  複製貼上遮罩過的版本，不小心貼進真正的設定檔），不是真正的金鑰字串
  ——瀏覽器送出的請求網址用 URL encode 後看得出 `%E2%80%A2`（就是
  「•」），才抓到這個問題。改用 `firebase apps:sdkconfig WEB <appId>`
  配 `jq` 直接用指令組出 `.env`，不手動複製貼上，避免重蹈覆轍。
- **手機沒有 DevTools 排查不了失敗的網路請求**：加了
  `src/composables/useDebugLog.js` + `src/components/DebugLogPanel.vue`
  ——攔截 `console.error`/`console.warn`、沒被 catch 的例外、以及打給
  `identitytoolkit.googleapis.com`／`cloudfunctions.net` 的 `fetch`
  請求（含失敗回應的完整內容），畫面最下方（後來改成最上方，見下一條）
  有個可收合的面板可以直接看、一鍵複製。上面兩個坑都是靠這個面板的紀錄
  才抓到的。
- **除錯面板跟底部導覽列疊在一起**：兩個都用 `position: fixed;
  bottom: 0`，互相蓋住。改成除錯面板放在畫面最上方，`#app` 補
  `padding-top`、`.topbar` 的 `sticky top` 跟著調整，避免再疊到一起。
- **`DashboardView.vue` 的 `collectionGroup` 查詢被 Security Rules 擋
  （`Missing or insufficient permissions`）**：`firestore.rules` 原本
  對 `reports/{date}/signals/{code}` 的授權是巢狀 `match`（`match
  /reports/{date} { match /signals/{code} {...} } }`），這種寫法只授權
  走「已知完整路徑」的查詢（例如 `collection(db, 'reports', date,
  'signals')`）。`DashboardView.vue` 要找「不管哪一天、最新的那筆」，
  用的是 `collectionGroup(db, 'signals')` 跨路徑查詢——這種查詢一定要
  另外用 `{path=**}` 遞迴萬用字元明確授權（`match
  /{path=**}/signals/{code} { allow read: if isOwner(); }`），光靠巢狀
  `match` 不會自動涵蓋，是 Firestore Security Rules 的既有限制，不是
  規則寫漏了。**修法**：在 `firestore.rules` 加一條這樣的規則（保留
  原本的巢狀規則不動）。之後如果還有其他地方要對 Firestore 做
  `collectionGroup` 查詢，記得同一個坑要再補一次對應的 `{path=**}`
  規則，不會因為加過一次別的 collection 就全部自動涵蓋。
- **`firebase.json` 沒設定快取規則，手機瀏覽器部署完看到的還是舊版**：
  Dashboard／Admin 兩個 tab 都部署成功了，但手機重新整理後畫面還是只有
  「持股庫存」可以點的舊版本——`firebase.json` 原本沒有 `hosting.headers`
  設定，Firebase Hosting 預設會幫 `index.html` 也套用快取（不像很多人
  以為的「HTML 永遠不快取」），瀏覽器因此沿用舊的 `index.html`，連帶
  讀到裡面指向的舊版（已經被取代的）雜湊檔名 JS/CSS。**修法**：在
  `firebase.json` 的 `hosting` 加 `headers` 規則，`/index.html` 設
  `Cache-Control: no-cache`（每次都要跟伺服器確認是不是最新版）、
  `/assets/**` 設 `public, max-age=31536000, immutable`（Vite 打包的
  檔名本來就帶內容雜湊，內容變了檔名就變，可以放心快取一年）。這個改
  之前部署過的版本，手機上還是可能要手動清一次快取/用無痕分頁才能看到
  最新版本，改完之後的部署就不會再有這個問題。

## 自動部署（GitHub Actions，2026-10-06）

跟 `apps-script/` 那邊的 `.github/workflows/deploy-stock-app.yml`
（push 到 `claude/stock-data-apps-script-w1wsk1` 就自動 `clasp push`）
同一個精神，`.github/workflows/deploy-firebase.yml` 做同樣的事，但對象
是 `firebase-migration/**`：跑 `functions/lib` 跟 `migration/` 的純邏輯
單元測試（測試沒過就不會進到部署步驟）、build 前端、驗證到 GCP、最後
`firebase deploy`（不加 `--only`，`firebase.json` 裡設定的
Hosting／Functions／Firestore rules+indexes 一次全部部署）。改
`firebase-migration/` 底下任何檔案、push 上去，幾分鐘內就會自動部署，
不用再手動跑 Cloud Shell 那一串指令。

**設定步驟（Cloud Shell，只需要做一次）：**

```bash
# 1. 建立專門給這個 workflow 用的服務帳戶（跟你自己的帳號、跟之前驗證
#    用完就刪掉的那把臨時金鑰都是分開的，這把要長期留著給 CI 用）
PROJECT_ID=$(gcloud config get-value project)
gcloud iam service-accounts create github-deploy \
  --display-name="GitHub Actions Firebase Deploy" --project="$PROJECT_ID"
DEPLOY_SA="github-deploy@${PROJECT_ID}.iam.gserviceaccount.com"

# 2. 授權——Cloud Functions 2nd gen 底層是 Cloud Run + Cloud Build +
#    Artifact Registry，部署需要的角色比「只有 Firebase」想像的還多一點：
for ROLE in roles/firebase.admin roles/cloudfunctions.developer \
            roles/run.admin roles/iam.serviceAccountUser \
            roles/artifactregistry.admin roles/cloudbuild.builds.editor \
            roles/cloudscheduler.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" --role="$ROLE" --quiet
done

# 3. 生一把金鑰（這把不像之前驗證用的那把，這把要長期留著，不要跑完就刪）
gcloud iam service-accounts keys create /tmp/github-deploy-key.json \
  --iam-account="$DEPLOY_SA" --project="$PROJECT_ID"
cat /tmp/github-deploy-key.json
```

把 `cat` 印出來的**完整 JSON**複製起來，到 GitHub repo 頁面 → Settings
→ Secrets and variables → Actions → **Secrets** 分頁 → New repository
secret，名稱填 `FIREBASE_DEPLOY_SA_KEY`，貼上整份 JSON 存起來。存完在
Cloud Shell 把本機那份刪掉，不要留在磁碟上：

```bash
rm /tmp/github-deploy-key.json
```

接著到同一個頁面的 **Variables** 分頁（不是 Secrets——這幾個值本來就
不是機密，見上面「坑」的說明），新增 5 個 repository variable，值從
`frontend/.env` 複製：

```bash
cat ~/airflow/firebase-migration/frontend/.env
```

對應填：`VITE_FIREBASE_API_KEY`／`VITE_FIREBASE_AUTH_DOMAIN`／
`VITE_FIREBASE_PROJECT_ID`／`VITE_FIREBASE_APP_ID`／
`VITE_FIREBASE_FUNCTIONS_REGION`。

設定完，`git push` 任何 `firebase-migration/` 底下的改動到
`claude/stock-data-apps-script-w1wsk1`，GitHub repo 頁面的 Actions 分頁
就會看到這個 workflow 自動跑起來，跑完直接是最新版本上線，不用再手動
`firebase deploy`。

⚠️ **這把 `github-deploy` 服務帳戶金鑰是長期有效的密鑰**，只存在 GitHub
Secrets 裡（GitHub 不會把 Secret 內容顯示回來，連你自己之後也看不到，
只能整個換掉），如果懷疑外洩，到 GCP Console → IAM → 服務帳戶 →
`github-deploy` → 金鑰，把那把金鑰刪掉重建一把，再更新 GitHub Secret。
`roles/editor`（專案編輯者）是更簡單但範圍更廣的替代方案——如果上面那組
精細角色部署時卡在某個權限不足的錯誤，一直抓不出少了哪個角色，直接換成
`roles/editor` 是務實的退路，單人專案這樣做不算太誇張，只是範圍比精確
挑選的角色清單廣。

**2026-10-06：`FIREBASE_DEPLOY_SA_KEY` 跟五個 `VITE_FIREBASE_*`
repository variable 都設定完成**，這次 commit 就是設定完後的第一次
實際觸發測試——改到這個檔案（在 `firebase-migration/**` 路徑篩選範圍
內）push 上去，`.github/workflows/deploy-firebase.yml` 應該就會自動
跑起來。

**坑：2026-10-07，`github-deploy` 這組角色清單缺 Secret Manager 相關權限**。
`runAiDiagnosis`／`getAiKeyStatus` 這兩支函式加上
`secrets: ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY']` 之後，自動部署直接在
`firebase deploy` 這一步失敗：

```
Error: Permissions denied enabling secretmanager.googleapis.com.
Please ask a project owner to visit the following URL to enable this service:
https://console.cloud.google.com/apis/library/secretmanager.googleapis.com?project=...
```

上面「2. 授權」那組角色清單（`firebase.admin`／`cloudfunctions.developer`／
`run.admin`／`iam.serviceAccountUser`／`artifactregistry.admin`／
`cloudbuild.builds.editor`／`cloudscheduler.admin`）在設計時這個專案還沒有
任何函式用到 Secret Manager，自然沒包含相關角色——不是漏設，是這次才第一次
需要。需要用專案 owner 身份（不是 `github-deploy` 這個部署用服務帳戶，它
自己就是被授權的對象）在 Cloud Shell 補兩件事：

```bash
PROJECT_ID=$(gcloud config get-value project)
DEPLOY_SA="github-deploy@${PROJECT_ID}.iam.gserviceaccount.com"

# 1. 啟用 Secret Manager API（一次性，跟部署服務帳戶的權限無關，所以錯誤訊息
#    才會說「請專案 owner 去開」——github-deploy 沒有啟用 API 的權限，不代表
#    它事後也不能操作已經啟用的 API）
gcloud services enable secretmanager.googleapis.com --project="$PROJECT_ID"

# 2. 讓 github-deploy 能管理 Secret Manager 的 IAM 繫結——firebase deploy
#    遇到函式宣告 secrets 選項時，需要自動把該函式的執行身分加進對應密鑰的
#    accessor 清單，這一步需要 secretmanager.admin，原本那組角色都沒有
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA}" --role="roles/secretmanager.admin" --quiet
```

做完之後到 GitHub repo 的 Actions 分頁找失敗的 workflow run，點
「Re-run all jobs」即可，不用重新 push 一次 commit。

戰報卡片點進去看的頁面：走勢圖（收盤價 + MA5/20/60）、戰報燈號歷史、AI
診斷紀錄快取，從 `apps-script/src/StockAnalysis.gs` 搬過來。**刻意沒搬**
`getRealtimeQuote`（打 `mis.twse.com.tw` 這個非官方、沒文件、只在盤中開放、
有流量限制的即時報價端點，跟這次遷移的 BigQuery/Firestore 資料層無關）跟
`startAiDiagnosisJob`／`getAiDiagnosisJobStatus`（跑一次新的 AI 診斷需要
Secret Manager 存 API 金鑰，獨立列為下一步，見下面「還沒做的事」）——這裡
只讀**已經存在**的快取診斷，不會主動呼叫 AI。

**後端**（`functions/`）：
- `lib/stockDetail.js` — 純邏輯：`buildPriceSeries_`（History 列轉成英文
  欄名的時間序列，算 MA5/20/60，重用 `lib/utils.js` 的 `rollingMean`）、
  `buildScoreHistory_`（Firestore 戰報文件轉成燈號歷史表格形狀）。
  `test/stockDetail.test.js` 驗證過（排序正確、MA 視窗不足時是 `null`、
  空輸入不噴錯）。
- `lib/bigquery.js` 新增 `buildStockSearchSql_`——股票代號/名稱模糊搜尋，
  只選 `stock_id`／`stock_name`／`date_str` 3 欄（不是整組 24 欄，BigQuery
  照掃描位元組數計費，沒理由多付其他 21 欄的錢），`LENGTH(stock_id) = 4`
  排除權證/ETF（跟 `buildHistoryRangeSql_` 的 `stocksOnly` 同一條既有
  規則），搜尋字串的單引號跟 `%`／`_` 都濾掉。
- `index.js` 新增兩個 `onCall`：
  - `getStockDetail({code})`——一次打包回傳走勢圖+燈號歷史+AI 診斷三組
    資料（混了 BigQuery／Firestore collectionGroup／Firestore 一般
    collection 三種 I/O，所以用一支函式打包，不拆成三次 round trip）。
  - `searchStockCodes({query})`——給前端搜尋框用，查全市場（不限於今天
    有沒有訊號），依代號去重取最新名稱，最多回傳 20 筆。
  - `fetchSignalHistoryForCode_`（`reports/{date}/signals` collectionGroup
    查某代號）重用既有的 `(code ASC, date DESC)` 複合索引，沒有加新索引；
    `fetchAiDiagnosisForCode_`（`ai_diagnosis` collection 查 `code` 相等）
    刻意不加 `orderBy`，排序交給 Node 做——單欄等號查詢不需要額外索引，
    同一檔股票的診斷紀錄筆數不多，不值得為了省這幾筆排序多部署一個索引。

**前端**（`frontend/`）：
- 新增 `chart.js` 依賴（`import Chart from 'chart.js/auto'`，一次註冊全部
  元件，簡單但會讓打包體積變大——`npm run build` 後主要 bundle 從 630KB
  漲到 838KB，目前沒有做 code splitting，單人工具先不處理這個，之後如果
  要延伸更多頁面可以考慮）。
- `frontend/src/components/dashboard/StockDetailView.vue` — 呼叫
  `getStockDetail`，渲染 Chart.js 折線圖（收盤價/MA5/MA20/MA60）、戰報
  燈號歷史表格、AI 診斷紀錄（`<details>` 收合，沒有診斷紀錄時提示跑新
  診斷的功能還沒遷移）。
- `DashboardView.vue`：戰報卡片的 `header` 改成可點擊（`openDetail`），
  點了切換成 `StockDetailView`；搜尋框改成兩層——原本的 client-side 篩選
  （只篩「今天戰報清單」裡的項目）保留，另外加一層 debounce 400ms 呼叫
  `searchStockCodes` 的全市場搜尋結果（不限於今天有沒有訊號），點搜尋
  結果一樣能開詳情頁，對應舊版「輸入代號或名稱可以開啟任何一檔股票詳情」
  的行為，不是只能看今天有訊號的股票。

⚠️ 跟其他 Cloud Function 一樣，`getStockDetail`／`searchStockCodes`
本身沒辦法在這個開發環境驗證——`lib/stockDetail.js` 的純邏輯已經靠單元
測試驗證過，但「接線接得對不對」只能部署後才知道。

**實際部署驗證時，`fetchSignalHistoryForCode_` 確實踩到坑了**：原本的假設
「`(code ASC, date DESC)` 這組既有複合索引可以服務『只篩 code』的查詢」
是錯的——`getStockDetail` 第一次上線就在前端看到 `INTERNAL` 錯誤（Cloud
Functions 把真正的錯誤訊息藏起來不回傳給瀏覽器，要從 `gcloud functions
logs read getStockDetail --region=us-central1 --gen2` 或
`gcloud logging read` 才看得到），實際內容是 `FAILED_PRECONDITION: The
query requires a COLLECTION_GROUP_ASC index for collection signals and
field code`——跟 Dashboard 那次「只查 `date`」的坑是同一個模式：Firestore
對 collection group 的單欄查詢比想像中更嚴格，既有的複合索引不會自動當成
其他查詢形狀的前綴使用。**修法**：幫 `fetchSignalHistoryForCode_` 的查詢
加上 `.orderBy('date', 'desc')`，這樣查詢形狀就完全對上既有的 `(code ASC,
date DESC)` 索引，不用再多部署一個索引——而且「戰報燈號歷史新到舊排序」
本來就是想要的順序，一舉兩得。教訓：**Firestore collection group 查詢的
索引需求，與其每次都猜測既有索引夠不夠用，不如直接部署驗證一次**，這份
README 已經連續在好幾個地方踩過這個坑，之後新增任何 collection group
查詢都要抱持「先假設需要新索引，部署驗證過才算數」的心態。

## 每日排程與不跑日（2026-10-07）

使用者發現 Admin 頁面沒有每日排程設定，追問之下才發現**不只是沒畫面，是
後端邏輯真的缺了「不跑日」這塊**：`skip_dates` collection Phase 2 就已經
遷移進 Firestore、Security Rules 也開放讀寫了，但 `functions/index.js`
的 `generateDailyReportScheduled` 從來沒有檢查過它——就算使用者在
`skip_dates` 加一筆，排程還是會照跑，不會真的跳過。

**跟 Apps Script 版排程機制本質上的差異**：Apps Script 可以在執行階段
動態新增/刪除真正的時間觸發器（`ScriptApp.newTrigger().atHour(hour)
.nearMinute(minute)`），使用者在 Scheduler.gs 的 `setSchedule()` 存檔，
下一次實際觸發時間馬上跟著變。Cloud Scheduler 的 cron 是**部署時寫死**的
設定，沒辦法用同樣的方式動態改，除非額外串 Cloud Scheduler Admin API
（多一組 IAM 權限、多一個 GCP client library 依賴，只為了改一個 cron
字串，評估後覺得不划算）。

**採用的做法：固定頻率 tick + 應用層判斷**：
- `functions/lib/schedule.js` — 純邏輯：`shouldRunDailyReport_(now, opts)`
  判斷「現在的台北時間是不是落在使用者設定的目標時間區間、有沒有跳過
  週末、今天在不在 `skip_dates` 裡」，`test/schedule.test.js` 驗證過
  （tick 區間比對、週末判斷、三個條件的組合情境）。
- `functions/index.js` 的 `generateDailyReportScheduled` 的 Cloud
  Scheduler cron 從原本寫死的 `'0 15 * * 1-5'`（15:00 UTC = 台北 23:00，
  只有週一到週五）改成 `'*/5 * * * *'`（每 5 分鐘都被叫醒一次，週末/
  跳過日的判斷改成完全交給 `shouldRunDailyReport_` 在應用層處理，不是
  靠 cron 的 day-of-week 欄位）。每次被叫醒都讀一次 `config/app` 跟
  `skip_dates`，判斷結果不符合就直接 `return`，不做任何事。
- 使用者在 Admin 頁面改 `triggerHour`／`triggerMinute`／`skipWeekends`，
  或在「不跑日」加一筆，**最多等 5 分鐘生效**，不用重新部署——用「觸發
  精準度降到 5 分鐘解析度」換「改設定不用重新部署、不用多一組 Cloud
  Scheduler Admin API 的 IAM 權限」，對「每天收盤後算一次戰報」這種
  用途完全足夠。
- 成本：一天 288 次 tick，絕大多數只做兩次 Firestore 讀取就直接
  `return`（很快、很便宜），遠低於 Cloud Functions／Firestore 的免費
  額度，不是需要擔心的成本。

**前端**（`frontend/src/components/admin/AdminView.vue`）新增兩個
form-card，一樣直接讀寫 Firestore（不經過 `onCall`）：
- 「每日排程」：執行時間（時/分）+ 週末不執行的 checkbox。數字輸入框
  不像下拉選單那樣適合「一改就存」（打字過程每個字元都會觸發），改用
  本機草稿 + 明確的「套用排程設定」按鈕。
- 「不跑日」：列出 `skip_dates` 現有項目（新到舊排序）+ 新增表單（日期
  + 選填原因）+ 逐筆移除。

⚠️ 跟其他 Cloud Function 一樣，`generateDailyReportScheduled` 的新邏輯
本身沒辦法在這個開發環境驗證——`lib/schedule.js` 的純邏輯已經靠單元測試
驗證過，但「Cloud Scheduler 真的每 5 分鐘叫醒一次」「改了 Admin 頁面的
設定，等幾分鐘後排程真的照新設定跑」這兩件事要部署後才能確認。

## AI 診斷（2026-10-07）

從 `apps-script/src/AiDiagnosis.gs` 搬過來，股票詳情頁點「跑新的深度
診斷」按鈕觸發，呼叫 Claude 或 Gemini 針對單一股票做「第二層思考」診斷
（財報查核、籌碼/技術面辯證、CoVE 自我驗證、最終給出明確的買賣建議）。

**這一版（2026-10-07 當天）先搬「深度診斷」**（新進場決策，
`diagnosisType='deep'`）；同一天稍晚補上「持股續抱診斷」（`'hold'`，
決策基準改成體質變化而不是進場，見下面「持股續抱診斷」那節）。apps-
script 版同時還有的「TOP3橫向推薦」（`'top3'`，全候選名單比較，不查
財報）**仍刻意不搬**——之後要加的話，Goodinfo／TWSE 財報抓取、
Claude/Gemini 呼叫、費用估算這些 I/O 跟計算邏輯大部分都已經在
`functions/index.js`／`functions/lib/aiDiagnosis.js` 裡可以直接重用，
只差 system prompt 文字跟候選名單這一層的邏輯。

**AiUsage 歷史費用記錄**（apps-script 版把每次呼叫的 tokens/費用寫進
Sheets 的 `AiUsage` 分頁）——這一版（2026-10-07 稍早）一開始刻意只計算
並回傳單次呼叫的費用，不持久化歷史；同一天稍晚補上了持久化，見下面
「AI 用量統計」那節。

**檔案**：
- `functions/lib/aiDiagnosis.js`（純邏輯，`test/aiDiagnosis.test.js`
  驗證過）：system prompt 文字逐字照搬；
  `buildTwseOfficialFinancialsTextForCode_`／`buildDiagnosisPrompt_`／
  `extractVerdict_`／`extractCoreReason_`／`calcCost_` 純函式邏輯照搬，
  欄位存取從 Sheets 版的中文欄名改成 Firestore 版的英文欄名
  （`reports/{date}/signals/{code}` 已經是英文欄名，見 schema.md §3）。
- `functions/index.js` 的 `exports.runAiDiagnosis`（`onCall`）+ 幾支
  I/O helper：`fetchGoodinfoText_`（抓 Goodinfo 網頁、正規表示式去
  HTML 標籤，抓不到就回說明文字不拋例外）、
  `fetchTwseOfficialFinancialsDatasets_`（抓 3 個 TWSE OpenAPI 全市場
  資料集）、`callClaude_`／`callGeminiOnce_`／`callGemini_`（Gemini
  帶跟 apps-script 版一樣的「grounding 空內容重試，最後一次關掉
  grounding」機制）、`callLlm_`（依 `config/app.aiProvider` 分派）。
  這幾支是純 I/O，沒有獨立寫測試——組 prompt/抽結論的運算邏輯已經在
  `lib/aiDiagnosis.js` 測過，這裡只是把資料接上外部端點。

**Secret Manager**：`runAiDiagnosis` 用 Cloud Functions v2 的
`secrets: ['GEMINI_API_KEY']` 選項——部署時 Firebase CLI 會自動把這個
密鑰的值注入成 `process.env.GEMINI_API_KEY`，並自動只授權這支函式的
執行身分讀取這個密鑰，不需要手動設定 IAM。密鑰本身要先建立（這個開發
環境沒辦法代勞）：

```bash
firebase functions:secrets:set GEMINI_API_KEY
# 會提示貼上金鑰值，按 Enter 確認即可，不會印在終端機畫面上。金鑰去
# Google AI Studio（https://aistudio.google.com/apikey）申請，用 Google
# 帳號登入就能直接產生，免費額度內可以先用。
```

建立後要重新部署一次（`firebase deploy --only functions:runAiDiagnosis`
或讓 GitHub Actions 自動部署跑一次）才會生效。沒設定金鑰時呼叫會收到
`failed-precondition`：「尚未設定 Gemini API 金鑰」，不是模糊的
`INTERNAL`。部署前記得到 Admin 頁面「AI 設定」把供應商切成 Gemini
（Firestore 遷移過來的預設值是 `claude`，沒切的話 `runAiDiagnosis` 會
繼續分派到 Claude，但 Claude 的密鑰根本沒建立）。

**2026-10-07：刻意只接 Gemini，沒有宣告 `ANTHROPIC_API_KEY`**——
`firebase deploy` 會驗證 `secrets` 陣列裡列出的每一個密鑰在 Secret
Manager 真的存在、至少有一個版本，缺一個就整個部署失敗（不是只有用到
Claude 才失敗，是部署當下就卡住，而且這支 workflow 沒加 `--only`，
Hosting／Firestore 會被一起擋住）。使用者目前只打算用 Gemini，為了不
逼自己生一把根本不會用到的 Claude 金鑰，`runAiDiagnosis`／
`getAiKeyStatus` 的 `secrets` 陣列都只列 `GEMINI_API_KEY`，
`getAiKeyStatus` 的 `hasClaudeKey` 固定回傳 `false`（不是查過沒設定，
是這支函式根本沒有權限讀那個密鑰）。`callLlm_` 的 Claude 分支程式碼還
留著，之後真的要用 Claude，把 `'ANTHROPIC_API_KEY'` 加回兩支函式的
`secrets` 陣列、建好密鑰、重新部署即可，不用改其他程式碼。

**前端**：`StockDetailView.vue` 的 AI 診斷紀錄區塊上面加了「跑新的深度
診斷」按鈕，呼叫 `runAiDiagnosis({code})`，成功後整頁重新 `getStockDetail`
刷新（不是把這次結果插進陣列開頭——同一天同一檔的舊紀錄是同一個 Firestore
文件 ID，會被直接覆蓋，整頁刷新才能正確反映覆蓋後的結果，不會顯示成
重複的兩筆）。呼叫中按鈕顯示「診斷中（約需 30 秒~1 分鐘）...」並停用，
失敗時在按鈕下方顯示錯誤訊息。

⚠️ 沒辦法在這個開發環境實際呼叫 Claude／Gemini API 驗證——純邏輯單元
測試驗證過組 prompt/抽結論的正確性，但「真的打 API 拿到診斷結果、寫進
`ai_diagnosis` collection、前端正確顯示」需要部署後、建立好 Secret
Manager 密鑰才能驗證。

## AI 設定 UI（2026-10-07）

Admin 頁面新增「AI 設定」卡片，把 AI 診斷相關、而且**後端真的有在讀**的
`config/app` 欄位開放編輯——跟「每日排程」那節的教訓一樣，這裡刻意只開放
後端已經接線的欄位，不是把 schema 裡能看到的欄位全部開放：

- **深度診斷使用的供應商**（`aiProvider`：Claude／Gemini）——下拉選單，
  跟其他下拉選單（篩選策略／BigQuery 來源模式）同一個「一改就存」模式，
  `runAiDiagnosis` 已經會讀這個欄位分派 provider。
- **API 金鑰狀態**——新增 `exports.getAiKeyStatus`（`onCall`，宣告
  `secrets: ['GEMINI_API_KEY']` 才能讀到 `process.env`）只回傳「有沒有
  設定」，絕不回傳金鑰本身，頁面打開時查一次。金鑰要設定／更新都只能用
  終端機 `firebase functions:secrets:set GEMINI_API_KEY`，這裡只顯示
  狀態，不提供輸入框——輸入框會把金鑰明文留在瀏覽器表單狀態／network log
  裡，沒有必要承擔這個風險換取一點點方便。`hasClaudeKey` 目前固定顯示
  「未設定」，見上面「AI 診斷」那節「刻意只接 Gemini」的說明，不是真的
  查過。
- **Claude／Gemini 價格單位**（`pricing.*`）——`calcCost_` 算「預估費用」
  真的會讀這幾個數字，跟「每日排程」的數字輸入框同一個「本機草稿 + 套用
  按鈕」模式（避免打字過程每個字元都存一次）。

**刻意不開放的欄位**：`aiDailyEnabled`／`aiDailyTopN`——這兩個是「每日
自動 AI 診斷」（排程算完戰報後，自動對候選名單跑 AI 診斷）用的設定，但
`generateDailyReportScheduled` 目前完全沒有這段邏輯（AI 診斷只有股票
詳情頁手動觸發這一條路徑），開放這兩個欄位編輯會變成跟 `skip_dates` 一樣
的「畫面上看起來能調、後端完全不理」的陷阱，所以先不開放，等「每日自動 AI
診斷」這個功能真的要做的時候再一起加 UI。

## 評分結果 UI 優化（2026-10-07）

使用者實際用過「跑新的深度診斷」之後回饋：新版把 AI 回應的 Markdown 原文
整段當純文字 dump 出來，比舊版（apps-script/src/JavaScript.html）讀起來
差很多——舊版有把 Markdown 解析成真正的 HTML（結論橫幅、可收合小節、表格
轉成卡片），新版完全沒做這件事。另外戰報卡片本身（Armor Score／操作策略）
的視覺層級也不如舊版清楚。這次對照舊版的做法做一次整體優化：

- **新增 `frontend/src/utils/markdownLite.js`**（純函式，不碰 DOM）——
  跟舊版 `renderMarkdownLite`／`splitMarkdownSections_`／
  `pickSectionIcon_` 同一個精神重新寫一份（不是逐字搬運，因為舊版是
  dependency-free 的 vanilla JS，這版用 ES module 寫，但轉換規則/涵蓋
  範圍保持一致）：
  - `splitMarkdownSections`／`sectionsExcludingFinalDecision`：把
    AI 回應依標題切成 intro（含風險評級的引言段）+ 各小節，「最終操作
    決策」那一節被排除（已經在結論橫幅顯示過一次）。
  - `renderMarkdownLite`：標題/引用/清單/`**粗體**`轉成真正的 HTML
    標籤；表格**刻意不轉成 `<table>`**（手機螢幕窄，欄位一多會被壓縮
    到看不清楚，這正是舊版改用卡片呈現的理由）——改成每一列資料變成
    一張 `.md-table-card`，欄位名稱＋值變成 `.kv-row`。
  - 所有文字內容都先用 `escapeHtml` 跳脫過，只有這支檔案自己產生的
    標籤會被當成真正的 HTML 插入，`v-html` 可以放心使用。
  - `verdictDirection`／`extractCoreReason`：結論上色（買=綠／賣=紅／
    觀望=黃）跟核心理由抽取，跟 `functions/lib/aiDiagnosis.js` 的
    `extractCoreReason_` 同一條正規表示式，前端重複一份而不是跨前後端
    共用（單一正規表示式，不值得為了共用建一個套件）。
- **新增 `frontend/src/utils/strategyColor.js`**——跟舊版
  `STRATEGY_HINT` 同一份「操作策略文字 → 顏色」對照表（紅＝止盈/止損、
  綠＝持股守護、藍＝趨勢啟動、黃＝趨勢領航），套用在戰報卡片／持股卡片／
  觀察清單卡片／戰報燈號歷史表格的策略文字上，讓人掃過一排卡片就能用
  顏色分辨「這是止損警示還是加碼訊號」。
- **`DashboardView.vue` 戰報卡片重排版**：代號＋名稱放左邊、Armor Score
  放右邊同一行（夠大夠粗），策略＋建議動作合併一行用上面的顏色對照表
  上色，對齊舊版 `.stock-card` 的視覺層級。
- **`StockDetailView.vue` 的 AI 診斷結果重做**：拿掉整段純文字 dump，
  改成「結論橫幅（買/賣/觀望上色 + 核心理由）＋ intro（風險評級引言）＋
  各小節收合清單（每節一個 emoji，表格變成卡片）」，第一筆（最新一筆）
  診斷預設展開，其餘預設收合。
- **`style.css` 新增** `--green`／`--red`／`--amber` 三個顏色 token
  （`--green`/`--red` 直接沿用既有的 `--positive`/`--negative`，
  `--amber` 是新增的第三種），以及 `.stock-card-*`／`.ai-report`／
  `.ai-verdict-banner(.up/.down/.neutral)`／`.md-table-cards`／
  `.kv-row` 這組新的 class。`.signal-badge` 的底色改成
  `color-mix(in srgb, currentColor 12%, transparent)`，套用
  `strategyColor()` 時只需要覆寫 `color`，底色會自動跟著換，不用
  額外算第二個顏色值。

⚠️ Markdown 解析邏輯用一支手寫腳本（`/tmp/.../scratchpad/test-md.mjs`，
不在 repo 裡）對照 `AI_DIAGNOSIS_SYSTEM_PROMPT` 的輸出格式範本手動測過一次
（intro／表格轉卡片／排除最終決策小節／核心理由抽取／結論上色都符合預期），
沒有寫進 `npm test`——跟 `functions/lib/` 的慣例不同，這是純前端展示邏輯，
目前這個專案沒有前端單元測試基礎設施，之後如果要加，這支是第一個值得補
測試的候選。

## 持股續抱診斷（2026-10-07）

從 `apps-script/src/AiDiagnosis.gs` 的 `runPortfolioHoldDiagnosis` 搬過來
（`diagnosisType='hold'`）——跟「深度診斷」是同一套 Goodinfo／TWSE 財報
查核流程，差別在決策基準：深度診斷回答「要不要進場」，續抱診斷回答「我
已經持有這一筆，體質撐不撐得住我繼續抱」，刻意**不是損益管理視角**（見
`AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT` 的角色設定——使用者明確表示可以長期
持有、能承受短期價格波動，判斷基準是基本面有沒有實質變化，不是帳面賺賠
多少）。最終結論也換成四個體質導向的選項：【體質轉強，加碼】／
【體質穩健，續抱】／【體質轉弱，減碼】／【體質惡化，出場】，跟深度診斷
的四個選項合併成同一份 `AI_VERDICT_OPTIONS_`（`extractVerdict_` 不用知道
現在是哪一種診斷，兩套文案完全不重疊，直接合併搜尋）。

**實作上跟深度診斷唯一的差異**：
- `lib/aiDiagnosis.js` 的 `buildDiagnosisPrompt_` 多一個選填的 `holding`
  參數（`{cost, buyDate, daysHeld, profitPct}`），帶了的話會在 prompt
  裡插入一段「我目前實際持有這檔股票的部位資訊——僅供背景參考」，並把
  結尾的任務說明換成「針對我目前持有的這筆部位進行完整的續抱評估」。
  沒帶這個參數時（深度診斷呼叫端）行為跟原來完全一樣。
- `functions/index.js` 的 `exports.runPortfolioHoldDiagnosis`（`onCall`，
  跟 `runAiDiagnosis` 一樣宣告 `secrets: ['GEMINI_API_KEY']`）多驗證一步：
  `code` 必須是 `portfolio_lots` 裡目前「持有中」的股票，不是就直接拋
  `failed-precondition`——沒有持股就沒有成本/損益可以注入 prompt。新增
  `buildHoldingInfo_(portfolioMap, code, latestClose)` 這支小 helper 算
  加權平均成本／持有天數／目前損益%，`getStockDetail`（顯示用）跟這支
  診斷函式共用，不用兩邊各自重複寫一次同一套日期/損益算法。
- `getStockDetail` 回應多一個 `holding` 欄位（沒有持有這一檔時是
  `null`），前端用這個欄位決定要不要顯示「跑新的持股續抱診斷」按鈕，
  並在頁面標頭下方顯示「持有中：成本 ... 已持有 ... 天，未實現損益
  ...%」這行背景資訊。

**前端**：`StockDetailView.vue` 的 `runDiagnosis()` 改成接受函式名稱
參數，深度診斷／續抱診斷共用同一組 loading/error 狀態（使用者不會同時
點兩個按鈕）；`markdownLite.js` 的 `verdictDirection` 分組也補上續抱診斷
的四個結論（「加碼」「續抱」算正向、「減碼」「出場」算負向），結論橫幅
上色邏輯不用為續抱診斷另外寫一套。

⚠️ 跟深度診斷一樣，沒辦法在這個開發環境實際驗證——`lib/aiDiagnosis.js`
的純邏輯（`holding` 參數渲染、8 選 1 的 `extractVerdict_`）已經靠單元
測試驗證過，但「真的對一筆持股跑出完整續抱評估、寫進 Firestore、前端
正確顯示」需要部署後實際測試。

## 每日自動 AI 診斷 + TOP3 橫向推薦（2026-10-07）

從 `apps-script/src/AiDiagnosis.gs` 的
`runDailyAiDiagnosisForTopPicks`／`runAiTopPicks`／`runAiShortlist_`
搬過來。跟深度診斷／續抱診斷是不同量級的任務——這兩個**都不查
Goodinfo／TWSE 財報**，只用戰報本身已經算好的量化欄位（Armor_Score／
操作策略／Trend_Score／法人參與密度排名／下跌接手率排名／實相解讀）
讓 AI 做橫向比較，維持低成本：

- **Top3 橫向推薦**（`diagnosisType='top3'`）：對最新一次戰報全部候選
  做一次橫向比較，選出最值得優先投入的前三檔並說明取捨（含「分數亮眼
  但暫不推薦」跟「這只是初篩、沒查財報」的提醒）。`code` 固定存常數
  `'TOP3'`，文件 ID 是 `TOP3_{date}_top3`，同一天重跑會覆蓋同一筆。
- **候選名單橫向比較 + 逐檔深度診斷**：先用 AI 橫向比較（不查財報）從
  當天全部候選裡篩出一份大小為 `aiDailyTopN`（3~10，`setAiDailySettings`
  的驗證邏輯搬到 Admin 頁面的輸入框）的候選名單，再把這份名單「全部」
  送進深度診斷（會另外抓 Goodinfo／證交所財報做完整查核）。刻意不做
  「橫向比較選幾檔、深度診斷再驗證同一批」這種兩階段都各自拍板的
  設計——橫向比較分數再高的候選，基本面查核仍有可能不合格，「值不值得
  投入」完全交給深度診斷的最終建議決定。

**實作**：
- `lib/aiDiagnosis.js` 新增 `AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE`／
  `AI_TOP_PICKS_SYSTEM_PROMPT`（system prompt 逐字照搬）、
  `buildShortlistPrompt_`／`buildTopPicksPrompt_`（候選列逐檔列出來，
  欄位存取改成 Firestore 英文欄名）、`extractShortlistCodes_`（從
  「N. 代號 名稱 - 理由」的編號清單抓代號，容忍 LLM 偶爾不聽話的格式
  落差——Markdown 強調符號、全形句點、括號——逐字照搬 apps-script 版的
  正規表示式）。
- `functions/index.js`：
  - `runDeepDiagnosisForCode_`——把原本塞在 `exports.runAiDiagnosis`
    裡的單檔深度診斷邏輯抽成共用核心，股票詳情頁的互動式按鈕跟每日自動
    診斷的候選名單批次處理共用同一份實作，不重複寫「查戰報列→抓財報→
    組 prompt→呼叫 LLM→算費用→寫入 Firestore」這一整段。
  - `fetchLatestReportCandidates_`——讀「最新一次戰報全部候選，依
    Armor_Score 高到低排序」，Top3／候選名單橫向比較共用同一次讀取。
  - `exports.runAiTopPicks`（`onCall`）——手動「重新掃描 Top3」按鈕。
  - `runShortlistAndDeepDiagnosis_`／`runDailyAiDiagnosisForTopPicks_`
    ——每日排程用，Top3／候選名單橫向比較兩件事各自包 try/catch、互不
    影響（跟 apps-script 版同一個設計：Top3 只有一次 LLM 呼叫、耗時固定
    且短，優先跑完；候選名單橫向比較+逐檔深度診斷耗時隨 `aiDailyTopN`
    增加，放在後面）。
  - `exports.generateDailyReportScheduled` 寫完戰報之後，如果
    `config/app.aiDailyEnabled` 開著就接著跑這兩件事；`timeoutSeconds`
    從 180 調高到 540（9 分鐘）——候選數上限 10 檔的情況下這個逾時留了
    充足餘裕，**不需要像 apps-script 版那樣另外維護一套 `budgetDeadline`
    提早跳過剩餘代號的機制**，那是 Apps Script 6 分鐘硬性執行上限逼出來
    的設計，Cloud Functions 的逾時是這支函式自己宣告的，直接給夠就好。
- **Admin 頁面**「每日自動 AI 診斷」卡片：開關 + 候選名單大小（3~10）
  輸入框，跟「每日排程」同一個草稿+套用按鈕模式——這兩個欄位
  （`aiDailyEnabled`／`aiDailyTopN`）Phase 2 遷移時就存在 Firestore，
  但後端一直沒有消費它們，先前的「AI 設定 UI」那節刻意沒開放編輯
  （怕變成跟 `skip_dates` 一樣「畫面能調、後端不理」的陷阱），現在後端
  真的接線了，才把 UI 補上。
- **Dashboard 頁面**新增 `Top3PicksCard.vue`，戰報清單最上方一個可收合
  卡片，直接用 Firestore client SDK 的 `onSnapshot` 監聽
  `ai_diagnosis` 的 `code == 'TOP3'` 文件（跟 `StockDetailView` 讀某
  檔股票 AI 診斷歷史同一個理由，只用單欄等號查詢、不加 `orderBy`，不
  需要額外的複合索引，排序交給前端在記憶體裡做），裡面有「重新掃描
  Top3」按鈕（呼叫 `runAiTopPicks`，成功後不用自己刷新顯示——
  `onSnapshot` 本來就在監聽，寫入 Firestore 後自動收到新文件）。

⚠️ 沒辦法在這個開發環境實際驗證——`lib/aiDiagnosis.js` 的純邏輯（prompt
組裝、`extractShortlistCodes_` 的格式容忍度）已經靠單元測試驗證過，但
「排程真的在戰報算完後接著跑 Top3／候選名單橫向比較」「540 秒的逾時
在 `aiDailyTopN=10` 時夠不夠用」這兩件事需要部署後、開啟「每日自動 AI
診斷」實際跑過一次排程才能確認。

## AI 用量統計（2026-10-07）

從 `apps-script/src/AiDiagnosis.gs` 的 `logAiUsage_`／`getAiUsageSummary`
搬過來——每次呼叫 LLM（深度診斷／續抱診斷／候選名單橫向比較／Top3 推薦）
都順便記一筆 tokens／預估費用，Admin 頁面可以看最近 30 天的每日花費。
apps-script 版寫進 Sheets 的 `AiUsage` 分頁，這版改寫進 Firestore 的
`ai_usage` collection（文件 ID 用 Firestore 自動產生的 ID，不需要
`code+date` 這種可預測的 ID——用量記錄只會累加，不會被同一筆覆蓋更新，
跟 `ai_diagnosis` 的 upsert 語意不同）。

**欄位**（對應 `AI_USAGE_COLUMNS`，英文化）：`date`／`timestamp`／
`provider`／`model`／`code`（股票代號，或候選名單橫向比較／Top3 推薦
各自的常數 `'SHORTLIST_SCAN'`／`'TOP3_SCAN'`，跟 apps-script 版一致）／
`inputTokens`／`outputTokens`／`costUsd`。

**實作**：
- `functions/lib/aiUsage.js`（純邏輯，`test/aiUsage.test.js` 驗證過）：
  `buildAiUsageSummary_(records, days, nowDateStr)`——依 `date` 分組加總
  `calls`／`inputTokens`／`outputTokens`／`cost`，另外算 `totalCost`／
  `totalCalls`／`todayCost`，回傳形狀跟 apps-script 版 `getAiUsageSummary`
  一致。`nowDateStr` 由呼叫端傳入（不在這支純函式裡讀 `new Date()`），
  方便測試。
- `functions/index.js` 的 `logAiUsage_`（I/O，寫一筆到 `ai_usage`，刻意
  吞掉寫入失敗的錯誤——用量記錄是「順便記一筆」的旁支資訊，寫失敗不該
  讓已經成功的診斷流程整個報錯給使用者看）在四個 LLM 呼叫點各呼叫一次：
  `runDeepDiagnosisForCode_`（深度診斷，也是每日候選名單展開後逐檔呼叫
  的同一份核心邏輯）、`runPortfolioHoldDiagnosis`、`runTopPicksCore_`、
  `runShortlistAndDeepDiagnosis_` 的候選名單橫向比較那一次呼叫（跟逐檔
  深度診斷的呼叫是分開記的兩類）。
- `exports.getAiUsageSummary`（`onCall`，data: `{days?}` 預設 30）：
  只用 `.where('date', '>=', cutoffStr)` 單一不等式查詢（COLLECTION
  scope，不需要額外索引，不加 `orderBy`，排序交給 `buildAiUsageSummary_`
  在記憶體裡做）。
- **Admin 頁面**新增「AI 用量統計（最近 30 天）」卡片：累計花費／今天
  花費／每日明細表格，頁面打開時查一次（不是 `onSnapshot` 即時監聽——
  用量歷史不需要秒級更新），附「重新整理」按鈕。

⚠️ 沒辦法在這個開發環境實際驗證——純邏輯的分組/加總已經靠單元測試驗證
過，但「真的打 LLM 之後 `ai_usage` 有沒有正確寫入一筆、Admin 頁面的
每日明細表格算得對不對」需要部署後、實際跑過幾次 AI 診斷才能確認。

## 每日股價資料抓取（2026-10-07）

**背景**：使用者發現戰報卡在某一天不再更新。追查後發現這是這次遷移從一
開始就留下的一個缺口——**Firebase 版從來沒有接手「每天向證交所（TWSE）
抓最新股價資料」這件事**。`generateDailyReportScheduled` 一直以來只做
「用 BigQuery 裡已經有的資料算戰報」，真正負責把新資料抓進 BigQuery 的，
從頭到尾都還是舊版 Apps Script 的 `scheduledDailyFetch()`
（`apps-script/src/DataFetch.gs`）——這支函式一直都還留著在跑，Firebase
版只是從來沒有自己的對應實作，完全仰賴舊系統這條管線繼續運作。

這一節把這條管線整套搬過來（對應 `apps-script/src/DataFetch.gs` 的
`scheduledDailyFetch()`／`fetchT86_`／`fetchMiIndex_`／`fetchBwibbu_`／
`fetchAndMergeOneDay_`／`runScheduleStep1_`／`runScheduleStep2_`／
`startBackfillJob` 這一組），Firebase 版現在自己就能抓最新資料，不再
單方面依賴舊系統繼續運作（兩邊可以安全並存，見下面的說明）。

### 附帶修正：`sourceRefForRead_` 的 native 模式讀錯來源表

**這是這次追查順便挖出來的一個真實存在的 bug**，獨立於上面「沒有抓資料
管線」這件事。`functions/lib/bigquery.js` 的 `sourceRefForRead_`
（Phase 3 複製時寫的）原本把 `native` 模式也當成跟 `external` 一樣讀
`history_deduped`，但對照 `apps-script/src/BigQuerySync.gs` 的
`bqActiveSourceTableRef_`，`native` 模式應該直接讀 `history_raw`（每天
直接寫入的原生表）。

`history_deduped` 是 `history_external`（讀 Google Drive 檔案的 BigQuery
外部資料表）去重後的 view——只有「真的有在寫 Drive」才會更新，而
apps-script 版只要設定了 BigQuery 專案，新資料一律只寫 `history_raw`，
不再寫 Drive（見 `apps-script/src/SheetUtils.gs` `upsertHistoryRows_`
的說明）。如果正式環境的 `config/app.bigQuery.sourceMode` 當時設的是
`native`，Firebase 版讀到的就會是「開始用 BigQuery 之前最後一次寫
Drive」那個時間點就凍結住的舊資料——不管 `history_raw` 裡新資料寫得再
怎麼勤快，`native` 模式下的戰報都看不到，這完全可以是「卡住不動」這個
症狀的根本原因，獨立於排程本身跑不跑得動。已經修正，見
`functions/lib/bigquery.js` 該函式的完整說明與 `test/bigquery.test.js`
的對應測試。

### 架構決定：跟 apps-script 版的差異

1. **不重建 Drive 月份 CSV 這一層**——apps-script 版「沒設定 BigQuery
   專案的使用者改寫 Drive 月份 CSV 檔案」這個 fallback 路徑，Firebase
   版用不到（這個 App 的 `config/app.bigQuery.projectId` 一定有設定，
   不然整個戰報計算都動不了），新抓到的資料一律直接寫
   `history_raw`（跟 apps-script 版「設定了 BigQuery 之後就不再寫
   Drive」的既有行為完全一致，不是新發明的簡化）。
2. **寫入用 DML INSERT，不是 CSV blob + load job**——apps-script 版把
   整天的資料轉成 CSV blob 餵給 BigQuery load job
   （`upsertHistoryRowsToBigQuery_`）。Node 版改用一般的
   `INSERT ... VALUES (...), (...)` DML 敘述：一天的資料量小（通常一千
   多列），組成一條 INSERT 完全不會超過 BigQuery 查詢文字 1MB 的上限；
   而且 DML INSERT 寫入的列可以立刻被後續的 DELETE 刪除，BigQuery 的
   streaming insert（`tabledata.insertAll`）寫入的列會先進「串流緩衝
   區」，緩衝區裡的資料短時間內（官方說法最多到 90 分鐘）無法被 DML
   刪除或更新——如果改用 streaming insert，補抓/重新抓某一天時「先刪除
   當天舊資料再寫入」這個 idempotent 寫法會在緩衝區未清空前失敗。見
   `functions/lib/bigquery.js` `buildInsertRowsSql_` 的完整說明。
3. **不重建補抓 job 的「跨次執行續跑」機制**——apps-script 版
   `startBackfillJob`／`processBackfillJobTick_` 那一整套在 Script
   Properties 存游標、排下一次觸發器繼續跑的機制，是 Apps Script 6
   分鐘硬性執行上限逼出來的設計。Cloud Functions 的逾時是函式自己宣告
   的（`exports.runHistoryBackfill` 宣告 540 秒），不需要那套複雜度，
   跟 AI 診斷那邊拿掉 `budgetDeadline` 機制是同一個理由——改成「單次呼叫
   同步跑完，區間太大就分批呼叫」，每次呼叫都是獨立、idempotent 的。
4. **每日自動補抓的天數上限從 5 調大到 10**
   （`config.HISTORY_FETCH_MAX_CATCHUP_DAYS`）——apps-script 版的
   `MAX_CATCHUP_DAYS = 5` 一樣是 Apps Script 執行上限逼出來的保守值；
   Cloud Functions 這裡的逾時是 `generateDailyReportScheduled` 自己
   宣告的 600 秒，一天的抓取（3 個 TWSE 端點 + 2 次 BigQuery 查詢）實測
   數秒等級，10 天缺口遠遠不會撞到逾時。更大的缺口交給 Admin 頁面的
   「補抓區間」工具（單次上限 60 天，不受這個常數限制）。
5. **可以跟舊版 Apps Script 的 `scheduledDailyFetch()` 安全並存**——兩邊
   寫入同一張 `history_raw` 都是「先刪除這些日期既有資料、再寫入」的
   idempotent 寫法，誰先跑完某一天的資料就是誰的結果，不會重複或衝突。
   **這次遷移沒有停用舊系統的觸發器**，純粹是新增一條獨立的資料來源
   路徑——即使 Firebase 版這條管線有問題，舊系統仍然繼續運作當備援，
   反之亦然。要不要正式停用舊版 Apps Script，是後續獨立的決定。

### 實作

- **`functions/lib/twseFetch.js`**（純邏輯，`test/twseFetch.test.js`
  驗證過）：`parseT86Rows_`／`parseMiIndexRows_`／`parseBwibbuRows_`
  （從 Big5 解碼後的 CSV 文字解析成列，TWSE 回應格式的怪癖——跳過頁尾
  註記列、`="..."` 包裝的代號、先找區塊標題再找標題列——都是照抄
  apps-script 版已經實測對過的規則，不是重新設計）、`mergeDayRows_`
  （T86 inner join MI_INDEX、BWIBBU left join，缺值補預設值）、
  `parseCsvLine_`（取代 `Utilities.parseCsv`）。跟 apps-script 版的
  差異：不維護 `yyyy/MM/dd`（給 Drive CSV 用）跟 `yyyy-MM-dd`（給
  BigQuery 用）兩種日期格式，合併出來的「日期」欄位直接就是
  `yyyy-MM-dd`（見檔案開頭的架構差異說明）。
- **`functions/lib/schedule.js`** 新增 `buildCatchupDateList_`：從
  「目前最新資料日期的下一天」列到「今天」，跳過週末／`skip_dates`，
  有 `maxDays` 上限——純函式化 apps-script 版 `runScheduleStep2_` 的
  「該抓哪幾天」這一步。
- **`functions/lib/bigquery.js`** 新增 `rawTableRef_`／
  `buildDeleteDatesSql_`／`buildInsertRowsSql_`／`buildMaxDateSql_`／
  `buildDateBoundsSql_`，並修正 `sourceRefForRead_`（見上面的 bug 說明）。
- **`functions/index.js`**：
  - `fetchTwseCsvText_`——TWSE 的 CSV 端點用 `Big5` 編碼回應（不是
    UTF-8），Node 原生 `fetch`／`Response.text()` 只會用 UTF-8 解碼，
    改用 `iconv-lite`（新增的 npm 依賴）手動解碼，對應 apps-script 版
    `fetchCsvText_` 的 `resp.getContentText('Big5')`。
  - `fetchAndMergeOneDay_`／`writeHistoryRowsToBigQuery_`／
    `fetchHistoryMaxDate_`／`fetchOneDayAndWrite_`——單日抓取/寫入的
    完整流程，單日失敗不拋例外（回傳 `{kind:'failed', error}`），跟
    apps-script 版「一天抓完就立刻寫入、單日失敗不影響其他日期」同一個
    設計。
  - `runDailyCatchupFetch_`——每日排程呼叫，找出目前最新資料日期、補抓
    到今天為止；整個補抓失敗（例如 TWSE 暫時連不上）不拋例外，不會讓
    後面「重新計算戰報」的步驟也跟著不跑——沒抓到新資料，戰報就照舊用
    BigQuery 裡既有的最新資料算一次。
  - `exports.generateDailyReportScheduled` 現在在算戰報之前先呼叫
    `runDailyCatchupFetch_`；`timeoutSeconds` 從 540 調到 600，多留一點
    餘裕給抓取這一步。
  - `exports.runManualHistoryFetch`（`onCall`，data: `{date?}`）——手動
    抓取單一天，對應 apps-script 版「立即更新今日資料」按鈕。
  - `exports.runHistoryBackfill`（`onCall`，data:
    `{startDate, endDate, skipWeekends?}`）——手動補抓一段區間，單次
    上限 60 天，同步跑完才回傳（不像 apps-script 版排一個背景 job 輪詢
    進度，見上面架構決定 #3）。刻意不套用 `skip_dates`——那是給每日
    自動排程用的，手動補抓區間時使用者已經明確指定了日期，不該被悄悄
    跳過。
  - `exports.getHistoryOverview`（`onCall`）——日期範圍／交易日數／
    股票數／總列數，查的是 `sourceRefForRead_` 算出來的「這個 App 實際
    在用的來源」，不是固定查 `history_raw`，對應 apps-script 版
    `getHistoryOverview`。
- **Admin 頁面**新增「歷史股價資料」卡片：資料總覽、「立即抓取今天」
  按鈕、「補抓區間」表單（起訖日期＋跳過週末 checkbox），並更新
  「BigQuery 設定」卡片的來源模式說明文字（舊文字是「native 需要先
  匯入成月份檔案」那個年代的描述，現在 native 模式直接讀最新寫入的
  `history_raw`，不再需要先匯入月份檔案；external 模式新增警語——
  新抓到的資料不會出現在那裡）。

⚠️ 沒辦法在這個開發環境實際驗證——`lib/twseFetch.js`／`lib/schedule.js`／
`lib/bigquery.js` 的純邏輯都靠單元測試驗證過（CSV 解析用手寫的仿真
fixture，不是真的 TWSE 回應；這個開發環境的網路政策也不開放連到
twse.com.tw，沒辦法直接測試真實端點），但「真的連得上 TWSE 三個端點、
Big5 解碼正不正確、BigQuery DML 寫入能不能成功」都需要部署後才能確認。
部署後的驗證順序建議：先用 Admin 頁面的「立即抓取今天」測試單日抓取
（最容易看出端點格式/編碼有沒有問題），確認沒問題後再用「補抓區間」
補回缺的那幾天，最後看「每日排程」是不是接上了（下一次排程 tick 的戰報
日期有沒有跟著動）。

## 執行紀錄（run_log，2026-10-07）

**背景**：使用者在確認上面「每日股價資料抓取」這個缺口時，順便問了一個
更根本的問題——舊版 apps-script 的「後台管理」頁面有一個「執行紀錄」區塊
可以看排程/手動操作的 job 總覽及執行狀況，**這次遷移到目前為止完全沒有
搬這個功能**。這是真正的缺口，不是「做了但沒測過」——補上。

舊版機制（`apps-script/src/SheetUtils.gs` `logRun_`）：每次排程/手動
操作各自呼叫 `logRun_(type, status, message, durationSec)`，寫一列進
`RunLog` 這個 Sheet 分頁，超過 500 列自動裁掉最舊的；後台管理頁面用
`getRecentRunLogs(limit, category)` 讀最近 N 筆，`type` 欄位用「第一個
`-` 前的文字」分組（例如「每日排程-補抓資料」歸進「每日排程」），供
一個分類篩選下拉選單用。

### 實作

- **`functions/index.js` `logRun_(category, status, message, durationMs)`**
  ——對應 apps-script 版的 `logRun_`，寫進新的 Firestore collection
  `run_log`，欄位 `{timestampMs, timestamp, category, status, message,
  durationMs}`（`timestampMs` 是數字，給 `orderBy` 排序用；`timestamp`
  是台北時間的可讀字串，給畫面直接顯示，跟 `utilsLib.timestampLabelTaipei_`
  其他地方的用法一致）。刻意寫成 fire-and-forget（吞掉自己的寫入失敗，
  不往外拋例外）——記錄這次執行有沒有成功，本身絕對不能變成「讓這次執行
  失敗」的原因，跟 apps-script 版「寫 log 只是旁支，不該影響主流程」是
  同一個設計前提。
- **接線的呼叫點**（涵蓋這個 App 目前所有背景/手動操作，對應 apps-script
  版到處撒的 `logRun_` 呼叫）：
  - `generateDailyReportScheduled`（每日排程 tick）：分三段各記一筆——
    `每日排程-補抓資料`／`每日排程-重新計算戰報`／`每日排程-每日自動AI診斷`
    （只在 `aiDailyEnabled` 開啟時才有這第三筆）。
  - `generateDailyReport`（手動重新計算戰報的 HTTP 端點）→
    `手動重新計算戰報`。
  - `runManualHistoryFetch`（手動抓取單日）→ `手動抓取`。
  - `runHistoryBackfill`（手動補抓區間）→ `補抓區間`。
  - `runDeepDiagnosisForCode_`（單檔深度診斷，不管是使用者手動點「跑新的
    深度診斷」還是每日自動候選名單逐檔跑）→ `AI診斷`。
  - `runPortfolioHoldDiagnosis`（持股續抱診斷）→ `持股續抱診斷`。
  - `runTopPicksCore_`／`runAiTopPicks`（Top3 橫向推薦，手動或每日自動都
    會經過這裡）→ `AI Top3 推薦`。
  - `runShortlistAndDeepDiagnosis_`（每日自動候選名單橫向比較這一步，跟
    上面逐檔深度診斷是兩筆分開的紀錄）→ `AI每日候選名單`。
  - 狀態文字目前用到的有 `成功`／`失敗`／`略過`（例如補抓資料發現沒有
    缺口可補）／`部分成功`（例如補抓 5 天裡 3 天成功 2 天失敗，或 Top3
    跟候選名單兩段只有一段成功）。
- **`firestore/firestore.rules`** 新增 `run_log/{entryId}` 規則，只開
  `isOwner()` 讀取（跟 `ai_diagnosis`／`backtest_results` 等其他後端寫入
  的衍生資料同一組規則，前端不能直接寫，寫入只能透過 Cloud Functions 的
  Admin SDK）。
- **Admin 頁面**新增「執行紀錄」卡片：直接用 Firestore client SDK 的
  `onSnapshot`（`query(collection(db,'run_log'), orderBy('timestampMs',
  'desc'), limit(50))`）即時監聽最近 50 筆，不經過 `onCall`——跟
  `watchlist`／`skip_dates` 這些「規則已經開放讀取、不需要額外聚合計算」
  的 collection 走同一個模式，不是每個新 collection 都需要一支專門的
  `onCall` 函式。狀態文字用 `runLogStatusColor()` 對應到
  `var(--green)`／`var(--red)`／`var(--amber)`，套在既有的 `.signal-badge`
  class 上（背景色用 `color-mix` 自動跟著 `color` 換，不用額外定義新的
  CSS class），跟 `utils/strategyColor.js` 替操作策略上色是同一個手法。
  耗時欄位把 `durationMs` 換成秒數顯示（`(durationMs/1000).toFixed(1)`），
  對應 apps-script 版的「耗時(秒)」欄位。

### 跟 apps-script 版的差異（刻意簡化）

1. **沒有自動裁剪舊紀錄**——apps-script 版 500 列的上限是 Google Sheets
   「列數太多會拖慢整份表格的讀寫」這個效能考量逼出來的；Firestore 是
   per-document 儲存，單純「紀錄愈積愈多」本身不會拖慢查詢效能（查詢
   一律 `limit(50)`，走 `timestampMs` 索引），只有儲存成本會隨時間緩慢
   增加（一筆紀錄不到 1KB，一天撐滿寫個十幾筆，一年也只是幾 MB，
   Firestore 儲存費率是這個等級完全不會感覺到的錢）。先不做，等真的
   變成問題（例如之後想在這裡保留更久的歷史趨勢統計）再處理。
2. **沒有分類篩選下拉選單**——apps-script 版 `getRunLogCategories` 讓
   使用者在後台管理頁面只看某一大類（例如只看「每日排程」）。Firebase
   版目前就是單純顯示最近 50 筆全部類型，筆數不多（每天正常情況下個位數
   到十幾筆），用「項目」欄位用眼睛掃一下也看得出來，先不做額外的篩選
   UI；如果之後紀錄密度變高（例如 AI 診斷量很大）再考慮加。

## Bug 修正：callFn 的 client 端逾時寫死 30 秒（2026-10-07）

**症狀**：部署完「每日股價資料抓取」跟「執行紀錄」之後，使用者實際在
Admin 頁面測試「補抓區間」，按下「開始補抓」後畫面直接顯示
`deadline-exceeded` 錯誤。

**根本原因**：`frontend/src/composables/useCallable.js` 的 `callFn`
呼叫 Firebase callable SDK 時，`timeout` 選項寫死 `30000`（30 秒）——
這是「client 端等後端回應等多久就放棄」的設定，跟後端 Cloud Function
自己宣告的 `timeoutSeconds`（`functions/index.js` 的 `RUNTIME_OPTS_`）
是兩個完全獨立的數字。`exports.runHistoryBackfill` 後端宣告
`timeoutSeconds: 540`（540 秒），其餘大多數 onCall function（包含
`runAiDiagnosis`／`runPortfolioHoldDiagnosis`／`runAiTopPicks` 這些要
查 Goodinfo／呼叫 LLM、經常跑超過 30 秒的函式）也是 `RUNTIME_OPTS_`
預設的 180 秒。client 端 30 秒的逾時比這些後端預算短了 6~18 倍——
後端可能根本還在正常執行、甚至已經成功寫完資料，前端卻早就自己放棄、
顯示逾時錯誤，讓使用者誤以為操作失敗。

**修正**：`callFn(name, data, timeoutMs)` 新增第三個參數，預設值從
`30000` 改成 `180000`（對齊 `RUNTIME_OPTS_` 的 180 秒），呼叫
`runHistoryBackfill` 的地方（`AdminView.vue` 的 `runBackfillNow`）
額外傳入 `540000` 對齊後端 540 秒的宣告。這個預設值調整同時也修正了
AI 診斷（`StockDetailView.vue` 的 `runDiagnosis`）原本可能受同一個
30 秒 client 逾時影響、只是還沒被使用者回報出來的潛在問題——Goodinfo
爬蟲加上 LLM 呼叫很容易超過 30 秒。

**驗證**：`npm run build` 通過；這是純 client 端設定值調整，沒有新增
依賴或改變後端行為，沒有對應的單元測試可以寫（`httpsCallable` 的
`timeout` 選項是 SDK 內部行為，純邏輯層的 `functions/lib/*.js` 完全
沒碰到）。
