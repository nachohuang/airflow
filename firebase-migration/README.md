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

## 執行紀錄：補上「最近執行狀態」總覽（2026-10-07）

使用者看了舊版「排程佇列」卡片的截圖後，反應「還是沒看到」——釐清後，
真正要的不是那一整套「背景 job 卡住可以重新啟動」的機制（上面已經說明
過，Firebase 版每個操作都是一次呼叫同步跑完，結構上沒有「卡住」這個
狀態需要處理），而是「不想逐筆看落落長的執行紀錄清單，想要一眼看出
每個項目（每日排程-補抓資料／AI診斷／補抓區間…）最近一次是成功還是
失敗」。

在「執行紀錄」卡片裡的完整清單上面，加了一個「最近執行狀態」卡片網格：
純前端計算（`runLogLatestByCategory`，`computed`），把 `runLogEntries`
（已經是依時間新到舊排序好的最近 50 筆）依 `category` 分組，每組只留
第一筆（也就是最新一筆），不用額外查 Firestore。注意這個總覽的資料
來源跟下面的完整清單同一份最近 50 筆，很少執行的項目（例如持股續抱
診斷）如果最近一次執行已經不在這 50 筆之內，這裡會顯示不出來——這個
限制直接寫在卡片下面的提示文字裡，不是要使用者自己發現。

## 補抓區間：用 jobs/{jobKey} 取代「等這次呼叫本身回應」（2026-10-07）

**症狀**：使用者實際按「開始補抓」之後把 App 切到背景，回來發現畫面上
完全看不到任何進度，也沒有錯誤訊息；另一次則是直接看到
`deadline-exceeded`（已經被上一節的 timeout 修正處理掉，但即使不逾時，
畫面本身的「進度看不見」是另一個獨立問題）。使用者明確要求：跟舊版
apps-script 一樣，AI 診斷／因子分析這類長時間操作，App 切到背景或在
SPA 內切頁再切回來，都不應該影響看得到目前執行狀況。

**根因**：`AdminView.vue` 原本的 `backfillRunning`／`backfillResult` 是
純前端本地 `ref`，狀態完全綁定在「這次 `callFn('runHistoryBackfill', ...)`
呼叫」身上，有兩層問題：(1) 手機瀏覽器切到背景很容易直接把這次呼叫的
底層連線中斷掉——但後端 Cloud Function 本身完全不受影響，還是會繼續
執行到完成，純粹是「這次呼叫的 HTTP 回應送不回一個已經斷線的瀏覽器」，
前端卻把這個連線層級的失敗誤認為「操作失敗」；(2) 如果使用者是在 App
內切頁籤（例如切到「戰報與個股」分頁再切回「系統與資料後台」），
`AdminView.vue` 會被整個砍掉重新掛載，存在元件內的 `ref`（包含「目前
正在執行中」這個狀態本身）也會跟著被清空重建，不管連線有沒有中斷都一樣
會「忘記」有工作正在跑。

這跟舊版 apps-script「排程佇列」能夠「不管哪個分頁、哪台裝置觸發的都
看得到目前狀態」的原因是同一件事——那邊的狀態存在 Script Properties
（伺服器端），不是存在瀏覽器分頁的記憶體裡，前端只是定期輪詢讀而已。

**修正**：`functions/index.js` 新增 `writeJobStatus_(jobKey, patch)`，
`merge: true` 寫進 `jobs/{jobKey}`（`firestore.rules` 已經開放
`owner` 讀取，Phase 2 就寫好了，只是一直沒有任何函式真的在用）。
`exports.runHistoryBackfill` 在開始執行前寫入
`{status:'running', startedAt, params}`，執行完成（成功/部分成功/失敗）
再寫入最終狀態跟結果，整段包進 try/catch 確保任何未預期的例外也會讓
狀態正確收斂成 `'failed'`，不會卡在 `'running'` 回不去。

前端 `AdminView.vue` 改用 `onSnapshot(doc(db,'jobs','historyBackfill'))`
即時監聽這份文件來畫狀態卡片，`runBackfillNow()` 呼叫 `callFn` 本身的
回傳值不再被拿來畫面——只有「送出就失敗」的錯誤（`invalid-argument`／
`failed-precondition`／`permission-denied`，代表後端根本沒開始執行）
才顯示在 `backfillStartError`；`deadline-exceeded`／`unavailable`
這類連線層級的錯誤完全忽略，因為它們不代表後端真的失敗，真正的狀態
一律看 `jobs/historyBackfill` 監聽到的內容。這樣不管是連線中斷還是
元件被砍掉重建，重新打開頁面／重新掛載都能立刻拿到當下真正的執行
狀態，不受瀏覽器分頁生命週期影響。

**刻意沒做**：沒有把同一套 `jobs/{jobKey}` 機制套用到
`runManualHistoryFetch`（單日抓取，實測數秒等級完成，風險低很多）——
AI 診斷三支 onCall 則已經在下一節擴大套用了（使用者確認要做）。

## 擴大套用：AI 診斷三支 onCall 也用 jobs/{jobKey}（2026-10-07）

上一節修完「補抓區間」之後，使用者明確表示要把同一套做法也套用到 AI
診斷（深度診斷／持股續抱診斷／Top3 推薦）——這三支 onCall 常態性會跑
30 秒到 1 分鐘以上（查 Goodinfo + 呼叫 LLM），風險跟補抓區間完全同一類。

**後端**（`functions/index.js`）：
- `runDeepDiagnosisForCode_`（`exports.runAiDiagnosis` 跟每日自動候選名單
  深度診斷共用的核心）跟 `exports.runPortfolioHoldDiagnosis` 都寫進同一把
  key：`jobs/aiDiagnosis_{code}`（不分深度/續抱診斷用同一把 key，因為
  前端目前兩顆按鈕共用同一組 loading 狀態，不會真的同時跑兩種診斷；
  `kind` 欄位記錄是哪一種，供以後要分開顯示時用）。開始執行寫
  `{status:'running', kind, startedAt}`，結束寫
  `{status:'succeeded'|'failed', finishedAt, error}`。
- `exports.runAiTopPicks` 寫進固定 key `jobs/aiTopPicks`（一次只會有一個
  Top3 掃描在跑，不需要像診斷那樣依代號分流）。

**前端**：
- `StockDetailView.vue` 新增 `diagnosisJob`（監聽
  `jobs/aiDiagnosis_{code}`，隨 `props.code` 改變重新訂閱）；
  `diagnosisBusy`（`computed`）合併本地 `diagnosing`（按下按鈕到 onCall
  第一次回應這一小段）跟 `diagnosisJob.value?.status === 'running'`
  （後端真正的執行狀態），兩顆診斷按鈕的 disabled／文字都改用
  `diagnosisBusy`。診斷從「執行中」變成別的狀態時自動呼叫 `load()`
  刷新（重新讀 `getStockDetail`，拿到剛寫入的診斷紀錄），不用使用者
  自己發現、自己重新整理。
- `Top3PicksCard.vue` 的推薦內容（`latest`）本來就是直接監聽
  `ai_diagnosis`，不需要額外處理；這次只補上「正在掃描中」這個過程
  狀態的可見度（新增 `topPicksJob` 監聽 `jobs/aiTopPicks`，`scanBusy`
  合併本地 `running` 跟它）。
- 兩邊的 `catch` 都比照「補抓區間」的做法：只有「送出就失敗」的錯誤
  （`invalid-argument`／`not-found`／`failed-precondition`／
  `permission-denied`，代表後端根本沒真的開始跑）才顯示給使用者看，
  `deadline-exceeded`／`unavailable` 這類連線層級的錯誤完全忽略——
  真正的狀態一律看 `jobs/{jobKey}` 監聽到的內容。

**驗證**：`npm test`（後端）、`npm run build`（前端）都通過。

## Bug 修正：DELETE+INSERT 不是 atomic，INSERT 失敗會把原本的資料也弄丟（2026-10-07）

**症狀**：使用者實際跑了一次「補抓區間」之後，`getHistoryOverview` 顯示的
`maxDate`／`tradingDays` 不是變多，是**倒退**了（從 `2026-10-02`／179 天
變成 `2026-09-30`／178 天）——不是「沒抓到新資料」這種無害的失敗，是
「原本已經存在的資料不見了」。

**根本原因**：`writeHistoryRowsToBigQuery_`（`functions/index.js`）原本是
兩次獨立的 `client.query()` 呼叫：先 `DELETE FROM history_raw WHERE
date_str IN (...)`，再 `INSERT INTO history_raw VALUES (...)`。這兩個
query 不是同一個 transaction，中間完全沒有保護——如果 INSERT 那一步失敗
（TWSE 那天的資料不完整、BigQuery 暫時性錯誤、網路中斷…），DELETE 已經
成功執行完了，那一天「原本已經存在」的資料就這樣被刪掉、沒有新資料補
回去。`fetchOneDayAndWrite_` 外層的 try/catch 把這整件事吞成一個普通的
`{kind:'failed'}`，呼叫端只會看到「這天補抓失敗」，完全不知道其實連
原本的舊資料都一起沒了。

補抓/手動抓取/每日排程補抓這三條路徑都共用同一個 `fetchOneDayAndWrite_`
→ `writeHistoryRowsToBigQuery_`，所以不管哪一條路徑觸發，只要 INSERT
那一步在 DELETE 之後失敗，都會踩到這個坑——這次是使用者手動補抓區間時
踩到，但理論上每日自動排程補抓一樣有風險。

**修正**：新增 `lib/bigquery.js` 的 `buildDeleteAndInsertTransactionSql_`，
把 DELETE 跟 INSERT 包成一個 BigQuery multi-statement script，當**一個**
query job 送出：
```sql
BEGIN
  BEGIN TRANSACTION;
  DELETE FROM `history_raw` WHERE date_str IN (...);
  INSERT INTO `history_raw` (...) VALUES (...);
  COMMIT TRANSACTION;
EXCEPTION WHEN ERROR THEN
  ROLLBACK TRANSACTION;
  RAISE USING MESSAGE = @@error.message;
END;
```
INSERT 失敗時會先 `ROLLBACK TRANSACTION`（撤銷 DELETE 的效果，那天原本
的資料完整保留），再用 `RAISE` 把錯誤往外丟，呼叫端原本的 try/catch
行為不變（照常把這天記成 `failed`）——差別只在「失敗的時候不會順便把
原本好好的資料也弄丟」。`writeHistoryRowsToBigQuery_` 從兩次 `query()`
呼叫改成一次。

**資料復原**：這個修正防止的是「以後」再發生同樣的事，**不會自動救回
已經被刪掉的那幾天**——這次遺失的日期需要重新跑一次「補抓區間」（涵蓋
受影響的日期範圍）才會補回來，TWSE 的端點對過去的交易日期一樣查得到
資料，重新抓一次就能恢復。

**驗證**：`test/bigquery.test.js` 新增測試確認組出來的 SQL 有
`BEGIN TRANSACTION`／`DELETE`／`INSERT`／`COMMIT`／`ROLLBACK`，而且
DELETE 排在 INSERT 之前；`npm test` 全部通過。多 statement script 在真的
BigQuery 環境下的 transaction/rollback 行為沒辦法在這個開發環境實際驗證
（跟這次遷移其他碰 BigQuery API 的程式碼一樣，見「每日股價資料抓取」
那節的驗證說明），這是 BigQuery 官方文件記載的標準 transaction 語法，
不是沒有依據的猜測。

## Bug 修正：一天的資料遠超過 1MB，INSERT 100% 失敗（2026-10-07）

**症狀**：上面的 transaction 修正部署後，使用者實際跑「補抓區間」
（2026-09-29 ~ 2026-10-07，7 天），**7 天全部失敗**，錯誤訊息是
`The query is too large (3171.32K characters, ... characters over the
limit). The maximum standard SQL query length is 1024.00K characters`
——每一天都落在 3.2MB~3.8MB，是 BigQuery 單一查詢文字 1MB 上限的
3 倍以上。

**根本原因**：`buildInsertRowsSql_` 當初的架構假設是「一天的資料量很小
（通常一千多列），組成一條 INSERT 敘述完全不會超過 1MB」——這個假設
沒有用真實 TWSE 資料驗證過（見「每日股價資料抓取」那節的驗證說明：
這個開發環境的網路政策不開放連到 twse.com.tw），實際跑起來才發現
嚴重低估了：TWSE 一天的 MI_INDEX／T86 涵蓋的證券數量遠不止「一千多
列」，組出來的 INSERT VALUES 子句直接整條被 BigQuery 拒絕，**不是
效能問題，是完全送不出去**，上一節剛修好的「不會弄丟資料」的 atomic
transaction 寫法在這個情況下反而讓問題更明顯——整個 transaction（含
DELETE）連同過大的 INSERT 一起被拒絕，7 天全軍覆沒。

**修正**：新增 `chunkRowsBySize_`，依組出來的 SQL 字面值實際長度（不是
猜測的列數）把一天的 rows 切成多個 chunk，每個 chunk 控制在 70 萬字元
以內（留將近 35 萬字元的安全邊界給 DELETE 敘述／transaction 包裝文字／
估算誤差）。`writeHistoryRowsToBigQuery_`（`index.js`）改成：第一個
chunk 連同 DELETE 包進上一節的 atomic transaction（失敗會 rollback，
不會重演資料遺失），其餘 chunk 各自用一般 INSERT 補上（DELETE 已經在
第一個 chunk 處理過，不會也不該重複刪除）。

**已知取捨**：如果第一個 chunk 的交易成功，但後面某個 chunk 失敗，這天
會停在「只寫入前幾個 chunk」的不完整狀態——比修正前「整天資料完全消失」
好很多，但不是 100% 無風險。這整條管線本來就是「先刪除這個日期的既有
資料、再整批寫入」的 idempotent 設計，使用者對失敗的日期重新補抓一次，
系統會先清掉這個不完整的殘留、重新寫一次完整的資料，自我修復，不需要
額外的復原工具——跟這次遷移其他地方「失敗了就照正常流程重試」的設計
原則一致，沒有為了處理這個低機率的邊界情況另外做一套復原機制。

**驗證**：`test/bigquery.test.js` 新增測試，確認切出來的 chunk 總列數
跟輸入一致（不多不少）、每個 chunk 組出來的 SQL 沒有大幅超過預算，
以及「單一一列本身就超過預算」這個邊界情況會自己佔一個 chunk，不會
被整個丟掉。`npm test` 全部通過。實際一天份 TWSE 資料在這個預算下會
切成幾個 chunk 沒辦法在這個開發環境驗證（同樣是網路政策限制），但
70 萬字元的預算本身已經是直接從使用者實測的 3.2MB~3.8MB 回推出來的
保守數字，不是憑空估計。

## 部署偶發 Cloud Run CPU quota 超額（2026-10-07）

**症狀**：這次遷移過程中，`部署 Firebase` 這個 GitHub Actions workflow
多次偶發性失敗，錯誤是
`Could not create or update Cloud Run service xxx, Container
Healthcheck failed. Quota exceeded for total allowable CPU per
project per region.`——通常重跑失敗的 job（`rerun_failed_jobs`）就會
成功，不是程式碼問題，是部署當下的資源競爭。使用者實際到 GCP Console
查詢（Cloud Run Admin API 的 `Total CPU allocation, in milli vCPU, per
project per region`，`us-central1`）確認目前上限卡在 **20,000 milli
vCPU（20 顆）**，而且畫面顯示「依據服務使用情形，您目前無法申請提高
配額」——自助式調高配額這條路暫時走不通。

**根本原因**：Cloud Functions (2nd gen) 預設給每支函式 `cpu: 1`（1 顆
完整 vCPU，`memory <= 2GiB` 都一樣，調低 `memory` 不會連帶調低這個
預設值）。這個 App 目前 20 幾支函式幾乎全部共用同一份
`RUNTIME_OPTS_`，包括單純讀寫一兩筆 Firestore 文件的 CRUD 函式（例如
`getWatchlist`）——這些函式跟真的需要算力的函式（算戰報、查
BigQuery、抓 TWSE、跑 AI 診斷）吃一樣的 1 vCPU。部署時 Cloud Run 的
rolling update 會讓舊／新 revision 短暫並存，疊加起來很容易在批次更新
一堆函式時撞到 20 vCPU 的硬上限——這不只是巧合的瞬間尖峰，是這個
App 的函式數量/資源設定組合本來就逼近這個上限。

**修正**：新增 `LIGHT_RUNTIME_OPTS_`（`Object.assign({}, RUNTIME_OPTS_,
{ memory: '512MiB', cpu: 0.25, concurrency: 1 })`），套用在純粹讀寫
Firestore、不碰 BigQuery／外部 API／LLM 的 10 支函式上：`getWatchlist`／
`addToWatchlist`／`removeFromWatchlist`／`getPortfolio`／
`savePortfolioItem`／`deletePortfolioLot`／`closePortfolioPosition`／
`getClosedPortfolioHistory`／`getAiKeyStatus`／`getAiUsageSummary`。
`concurrency: 1` 是 SDK 的硬性要求（`cpu < 1` 時 concurrency 只能是
1）——這個 App 全程只有擁有者一人使用，這些函式本來就不會有真正的
並發請求，這個限制不會造成任何實際影響。算戰報、BigQuery 查詢／寫入、
AI 診斷這些真的需要算力/逾時餘裕的函式維持用預設的 `RUNTIME_OPTS_`，
沒有動。

**這不是完全的根治**：降低這 10 支函式的 CPU 用量只是讓部署時的瞬間
總需求降低，減少撞到 20 vCPU 上限的機率，不代表以後完全不會再遇到。
如果之後函式數量繼續增加，或使用者的自助配額申請恢復可用，應該優先
考慮申請調高這個 quota（或減少 GitHub Actions 每次 push 都重新部署
「全部」函式的做法，改成只部署真的改過的——目前沒有這麼做，單人工具
部署頻率不高，這個改動的複雜度先不值得）。遇到這個錯誤的標準處理方式
維持不變：讀 job logs 確認是這個 quota 訊息，`rerun_failed_jobs` 重跑
即可，不是真正的程式碼錯誤。

**部署驗證抓到的第二個錯誤（第一版只改 `cpu`，沒動 `memory`）**：
Firebase CLI 直接拒絕部署，訊息是「The functions ... have too little
CPU for their memory allocation. A minimum of 0.5 CPU is needed to
set a memory limit greater than 512MiB」——Cloud Run 的 memory/CPU
組合是有硬性規則的，memory 超過 512MiB 就不能把 cpu 設在 0.5 以下。
這 10 支函式沿用 `RUNTIME_OPTS_` 的 `1GiB` 跟新設的 `cpu: 0.25` 互相
衝突。改成 `LIGHT_RUNTIME_OPTS_` 自己覆寫 `memory: '512MiB'`（沒有
進一步砍到更低的 `256MiB`——雖然這些函式本身單純讀寫一兩筆 Firestore
文件，不需要太多記憶體，但跟其他函式共用同一個 `index.js`，module
層級載入的重依賴（BigQuery client／cheerio 之類）每個函式冷啟動都要
付一次代價，不是只有真的用到那個依賴的函式才付；這個開發環境沒辦法
實際部署驗證冷啟動會不會 OOM，保守選一個比較安全的數字，不賭激進的
`256MiB`）。

## Bug 修正：補抓逾時被平台強制中止，job 狀態永遠卡在「執行中」（2026-10-07）

**症狀**：使用者補抓一個 13 個日曆天（約 9~10 個交易日）的區間，過了
一段時間「目前執行狀態」卡片一直顯示「執行中」不會變，「開始補抓」
按鈕也因為這樣被鎖住，沒辦法開始下一次嘗試；同時 `getHistoryOverview`
的數字沒有完全符合預期（有進展但不完整）。

**根本原因**：`runHistoryBackfill` 原本宣告 `timeoutSeconds: 540`
（9 分鐘），9~10 個交易日、每天 3 個 TWSE 端點依序抓、寫入時還要依
大小切成多個 chunk（見上面「一天的資料遠超過 1MB」那節），疊起來很
容易超過 9 分鐘。**關鍵問題不是「逾時」本身，而是逾時的處理方式**：
Cloud Functions 平台對逾時的處理是直接強制中止這次執行（類似外部
砍掉整個程序），**不會**讓函式自己的程式碼繼續跑、也不會走到
`try/catch` 的 `catch` 區塊——`writeJobStatus_('historyBackfill',
{status:'failed', ...})` 這段永遠沒有機會被執行到，`jobs/
historyBackfill` 文件就停在上一次寫入的 `'running'` 狀態，從此卡住。
前端原本看到 `status === 'running'` 就把「開始補抓」按鈕鎖死，兩個
問題疊在一起，變成使用者完全沒有辦法繼續操作，连重試都不行。

**修正（三部分）**：
1. **拿掉按鈕的 job 狀態硬鎖**——這是單人工具，不需要真的防「使用者
   自己跟自己搶」這種並發保護，「開始補抓」永遠可以按，不管上面顯示
   的狀態是什麼。按下去的新呼叫一開始就會把 `jobs/historyBackfill`
   覆寫成新的 `running`，等於直接覆蓋掉卡住的舊狀態，不需要像舊版
   apps-script「排程佇列」那樣另外做一顆「強制清除卡住工作」的按鈕。
2. **`timeoutSeconds` 從 540 調到 1800**（30 分鐘，callable function
   允許的上限是 3600 秒）——降低撞到逾時的機率，但不是保證不會發生；
   搭配第 1 點，就算真的撞到，使用者也不會被卡住。
3. **補上 Admin 頁面完全沒有的兩個手動觸發功能**（使用者在同一次回報
   裡一起提出）：
   - **「重新計算戰報」**：新增 `exports.runManualReportRecompute`
     （onCall），跟既有的 `generateDailyReport`（onRequest，只能用
     curl 打，前端原本沒有接線）共用同一份核心邏輯
     `runManualReportRecomputeCore_`——只重算戰報，不補抓資料、不跑
     AI 診斷，通常數秒內完成，不需要 `jobs/{jobKey}` 追蹤。
   - **「執行完整排程」**：新增 `exports.runFullScheduleNow`
     （onCall，`timeoutSeconds: 1800`），跟 `generateDailyReportScheduled`
     共用抽出來的 `runFullSchedulePipeline_`（補抓資料→重新計算戰報→
     如果開啟就跑 AI 診斷），差別只在跳過
     `scheduleLib.shouldRunDailyReport_` 的時間窗判斷（使用者明確按了
     按鈕，不需要再檢查現在是不是排定的執行時間）——對應 apps-script
     版「測試完整排程流程（5 步驟）」。一樣用 `jobs/fullSchedule`
     追蹤狀態、按鈕不被鎖死，跟補抓區間同一套模式。

**驗證**：`npm test`（後端）、`npm run build`（前端）都通過。這個開發
環境沒辦法實際跑一次真的會逾時的補抓來驗證「平台強制中止不會走到
catch」這個行為本身（需要真的連到 TWSE/BigQuery 且真的跑超過宣告的
逾時），這是 Cloud Functions／Cloud Run 平台文件記載的逾時行為，不是
猜測；拿掉按鈕硬鎖這個修正不依賴這個假設成不成立也會生效（不管逾時
處理方式到底是什麼，使用者都不會再被鎖住）。

## Bug 修正：TWSE 回應 307 沒有被跟隨，補抓 9 天全部失敗（2026-10-07）

**症狀**：補抓逾時修正部署後，使用者重新跑同一個區間，這次沒有卡在
「執行中」，但 9 天**全部失敗**，錯誤訊息是
`HTTP 307 - https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=...`
——`resp.status` 停在 307（重新導向本身的狀態碼），不是跟隨重新導向
之後最終目的地的狀態碼。

**根本原因**：`fetchTwseCsvText_` 原本只用 Node 原生 `fetch` 的預設行為
（`redirect: 'follow'`），理論上應該自動跟隨 307 重新導向，但實際測出來
沒有真的跟過去。最常見會導致這個現象的原因：TWSE 的 307 回應本身沒有
附 `Location` header，或 `Location` 是底層 fetch 實作判斷不出來的格式
（例如沒有協定/主機的純路徑在某些情況下解析有問題）——遇到這種情況，
`fetch` 不會噴錯，而是直接把這個 307 回應原封不動交回來，讓呼叫端自己
決定怎麼處理，呼叫端如果只檢查 `resp.ok` 就會得到一個狀態碼卡在 307
的失敗結果。

**修正**：`fetchTwseCsvText_` 改成 `redirect: 'manual'`，自己控制重新
導向的流程：收到 3xx 回應就自己讀 `Location` header、用
`new URL(location, currentUrl)` 解析成絕對網址（處理相對路徑的情況），
再對這個新網址重新發一次請求，最多跟 5 次避免無窮迴圈。同時把原本單純
的 `User-Agent: Mozilla/5.0` 換成更完整的瀏覽器 header 組合（完整版
Chrome UA 字串＋`Accept`／`Accept-Language`／`Referer: https://www.twse.com.tw/`），
降低被當成明顯的自動化流量處理的機率（雖然不確定這是不是真正的
原因——見下面「沒辦法完全確定根因」）。

**沒辦法完全確定根因，這裡誠實說明限制**：這個開發環境的網路政策不
開放連到 `twse.com.tw`（這次遷移反覆提到的限制），沒辦法直接重現/
驗證 TWSE 到底為什麼回 307、`Location` header 裡到底寫了什麼、改成
`redirect: 'manual'` 之後能不能真的解決問題。如果這個修正部署後
重新補抓還是失敗，新的錯誤訊息至少會帶有更多診斷資訊（例如「重新導向
但沒有 Location header」，或「重新導向次數過多，最後停在哪個 URL」），
如果最終停在的 URL 明顯是某種驗證/攔截頁面（不是正常的 CSV 端點），
就代表這是 TWSE 對這個 Cloud Functions 執行環境的 IP（GCP us-central1
的資料中心 IP）做了某種程度的阻擋/導向，這種情況程式碼層面可能沒辦法
完全解決，需要考慮別的解法（例如透過代理伺服器改走台灣的 IP）。

## Bug 修正：執行狀態卡片的長網址把卡片撐破（2026-10-07）

**症狀**：上面那個補抓失敗訊息裡帶了完整的 TWSE 網址，在手機畫面上
直接把「目前執行狀態」卡片的邊框撐破、超出螢幕寬度，使用者截圖直接
看得出來。

**根本原因**：`.run-log-status-card` 沒有設定 `overflow-wrap`，瀏覽器
預設不會主動在沒有空白字元的長字串（網址正是這種）中間斷行，整串網址
會被當成一個不可分割的詞，寬度超過卡片本身就直接溢出。

**修正**：`.run-log-status-card` 加上 `overflow-wrap: break-word` +
`word-break: break-word`，讓這種長字串在容器邊界強制換行，不再撐破
卡片。

**驗證**：`npm test`（後端）、`npm run build`（前端）都通過。

## 一致性修正：「重新計算戰報」也補上 jobs/{jobKey} 追蹤（2026-10-07）

**背景**：「手動測試工具」區塊新增的兩顆按鈕，一開始只有「執行完整
排程」套用了 `jobs/{jobKey}` 追蹤模式，「重新計算戰報」當時的理由是
「這支很快，通常數秒內完成，不碰 TWSE／AI，風險比補抓區間低很多」，
繼續用純本地 `ref` 狀態。使用者看了畫面後直接指出：這樣不一致——所有
手動操作都應該要「畫面切走也看得到執行進度」，不應該只有部分操作有
這個保護、其他的是例外。

**修正**：`runManualReportRecomputeCore_` 比照 `runHistoryBackfill`／
`runFullScheduleNow` 的模式，在開始/結束時寫入 `jobs/reportRecompute`；
前端新增對應的 `onSnapshot` 監聽跟狀態卡片，按鈕不再被鎖住（跟其他
兩顆同一個理由：單人工具不需要防並發）。這支本身風險雖然低，但一致的
使用者體驗本身就是值得做的理由，不需要等到「這支也真的卡住過」才補。

**驗證**：`npm test`（後端）、`npm run build`（前端）都通過。

## 新功能：資料完整性月曆（2026-10-08）

使用者明確提出的新功能，apps-script 版沒有對應功能可以照抄——要一個
地方能用月曆的方式，一眼看出哪幾天的股價資料有缺口/筆數異常，不用
一天一天手動核對「歷史股價資料」卡片的資料總覽。

**後端**：`lib/bigquery.js` 新增 `buildDailyCountsSql_(sourceRef,
fromDateStr, toDateStr)`——依 `date_str` `GROUP BY`，算出這個區間每
一天的四碼股票筆數（`LENGTH(stock_id) = 4`，排除權證/ETF，跟
`buildHistoryRangeSql_` 的 `stocksOnly` 同一個理由——權證代號是 6 碼，
流通中的數量遠超過一般股票，混進來會讓「筆數」這個數字失真）跟總列數
（含權證/ETF，當對照用）。`exports.getHistoryDailyCounts`（onCall，
data: `{month}`，格式 `'yyyy-MM'`）查的是 `sourceRefForRead_`（這個
App 實際在用的來源，跟 `getHistoryOverview` 同一個邏輯），不是固定查
`history_raw`，月曆上看到的缺口才會跟戰報實際讀到的資料一致。一次查
整個月，不是每天各查一次。

**前端**：新增 `HistoryCalendarCard.vue`，獨立元件（不是塞進
`AdminView.vue` 本來就已經很大的檔案），放在「歷史股價資料」卡片
下面。月曆格子純前端判斷顯示狀態（後端只回傳原始數字，不另外算好
狀態字串）：
- 未來日期：淡化顯示，不代表異常。
- 週六日沒有資料：中性灰色——TWSE 本來就不開盤，不是漏抓。
- **平日完全沒有資料**：紅色「缺」——真正需要注意的缺口。
- **平日有資料但四碼股票筆數低於 500**（`LOW_COUNT_THRESHOLD_`，正常
  交易日通常有八百到一千多檔，這個門檻是粗略估計不是精確值，純粹用來
  抓「明顯低到不正常」的情況）：橘色「少」。
- 其餘（平日且筆數正常）：綠色，正常。

**驗證**：`test/bigquery.test.js` 新增 `buildDailyCountsSql_` 的測試
（確認有 `GROUP BY`／`ORDER BY`／排除非四碼代號的條件）；`npm test`
（後端）、`npm run build`（前端）都通過。實際月曆畫面長什麼樣子、
BigQuery 查詢的真實回應沒辦法在這個開發環境驗證（跟這次遷移其他碰
BigQuery／TWSE 的程式碼一樣，見其他地方反覆提到的網路政策限制）。

**追加（同一天）：標出「不跑日」**——使用者看了月曆之後要求：如果那天
剛好是設定過的「不跑日」（`skip_dates`），也要標出來，不要讓使用者
誤以為那天的空白是漏抓。`HistoryCalendarCard.vue` 新增 `skipDates`
prop（型別 `[{date, reason}]`），由 `AdminView.vue` 傳入——那邊「不跑日」
卡片本來就已經用 `onSnapshot` 監聽 `skip_dates` collection，不需要
再另外訂閱一次同一份資料。月曆格子的狀態判斷新增一個優先權最高的
「跳」狀態（藍色，中性樣式，跟週六日同一個精神）：只要那天在
`skip_dates` 裡，不管有沒有資料都標成「跳」，不會被誤判成紅色的
「缺」。格子裡顯示「跳」字，滑鼠移上去（或長按，取決於裝置）會顯示
`title` 屬性裡的不跑日原因（如果有填的話）。

## 策略研究（回測／因子掃描）：開工前的比對分析（2026-10-08）

使用者提供了一份「余適安（余博，經濟學博士，曾任證券自營部經理人與
基金操盤手）法人選股邏輯」的完整筆記，要求在開始搬「策略研究（回測／
因子掃描）」這個 Phase 3 還沒做的功能之前，先比對這套邏輯跟現有系統
（`functions/lib/analysis.js` 的 Armor_Score 量化篩選、
`apps-script/src/FactorRegression.gs` 的 BigQuery ML 因子迴歸模型）有
沒有能互相補強的地方。這一節是純分析/研究，**還沒有動任何程式碼**，
目的是在真的開始搬 `apps-script/src/Backtest.gs`／`FactorRegression.gs`
（兩份合計約 1080 行，含 BigQuery ML 訓練、背景 job 機制，份量不小）
之前先確認好方向，不要搬完才發現設計要大改。

### 余博框架 vs 現有系統：逐項對照

| 余博的要件 | 現有系統對應的東西 | 比對結論 |
| :-- | :-- | :-- |
| 籌碼乾淨度與連續性（連續 3～5 天淨買超） | `IBF_20D`：20 天內「大盤下跌的那幾天，法人net淨買超的比例」 | **現有版本更細緻**，不是單純數連續天數，是「逢低接手率」這個比率型因子，概念上涵蓋了余博講的「連續性」，但不是逐字對應（余博講的是絕對天數，現有的是 20 天內的比率）|
| 投信買超佔股本比 0.2%～0.5% | 沒有——`history_raw` 沒有「發行股本」這個欄位 | **真正的缺口**，而且是資料層面的缺口，不是邏輯層面：要加這個因子，得先想辦法拿到股本資料（TWSE 公開資訊觀測站應該查得到，但目前的抓取管線沒有這一塊） |
| 技術面多頭排列 | `Trend_Score`（收盤價>MA20 且 MA20 斜率向上，0~2 分） | 現有版本是**簡化版**，余博講的「均線糾結後帶量突破」是更明確的型態辨識，`Trend_Score` 只看「現在是不是多頭排列」，沒有看「剛剛是不是從糾結狀態突破出來的」 |
| 終極 20MA 三部曲（站上→回測量縮不破→再出量上攻） | 沒有對應邏輯 | **真正的缺口**，而且是現有系統完全沒有的「進場時機精細度」——現有的 `classifyEntrySignal_` 只看當天的排名門檻（法人參與度/量能/IBF 排名），不看「現在是三部曲的哪一步」 |
| 量能爆量（5日/20日均量 1.5~2倍） | `Vol_Ratio`（當日量/20日均量），門檻是排名前 15%（`Vol_Ratio_Rank >= 0.85`） | **概念相同**，現有版本用橫斷面排名（跟全市場比）取代絕對倍數門檻，排名式的做法通常更穩健（不受大盤整體量能水位影響），算是現有版本更進一步 |
| 四率四升（毛利率/營益率/淨利率/ROE 連續上升） | **沒有任何量化因子涵蓋**——AI 深度診斷會查 Goodinfo／TWSE 官方財報，但那是**整頁文字丟給 LLM 做質化判斷**，不是結構化數字、不會影響 Armor_Score 或戰報篩選 | **最大的缺口**，見下面的「關鍵發現」——這不是邏輯沒想到，是現有的量化篩選（`computeFactors_`／`Armor_Score`）壓根沒有任何基本面因子，三大要件裡的「成長性」完全沒被量化系統涵蓋，只在使用者手動點「跑新的深度診斷」時才會被 AI 質化看一眼 |
| 月營收連續雙增（MoM>0 且 YoY>0） | 同上，沒有量化因子 | 同上，見「關鍵發現」 |
| P/E／PEG 合理區間 | `pe_ratio`／`pb_ratio`／`dividend_yield` 已經是 `FactorRegression.gs` 因子迴歸模型的候選因子（資料來自 TWSE 的 BWIBBU_d，`history_raw` 本來就有這三欄） | **已經涵蓋**，只是目前只進因子迴歸模型當候選特徵（LASSO 自己決定權重），沒有在 `rule_v17` 規則式門檻裡當成一個獨立的硬性篩選條件 |
| 季底結帳效應（法人作帳/結帳週期） | 沒有對應邏輯 | 小缺口，屬於「進階優化」等級，不是核心篩選邏輯的一部分 |
| 硬停損 5%～8%、移動停利沿 10MA/20MA | 現有的 `TRAILING_STOP_PERCENT = 0.025`（2.5%，從高點回落停損，只用在既有持股的 🛑/🛡️ 判斷） | **數值上差很多**，但不是直接可比——現有版本是「從進場後最高價回落 2.5%」的移動停損，余博講的是「從進場價虧損 5~8%」的硬停損，兩種機制基準點不同（峰值 vs 成本），2.5% 的移動停損本來就會比 5~8% 的成本停損更早觸發，這是刻意的風控設計差異，不是誰對誰錯，但值得使用者知道這個落差 |
| 分批建倉（試單 10~20%，只在獲利+趨勢確認時加碼） | 沒有對應邏輯——持股紀錄（`portfolio_lots`）是使用者手動輸入買賣紀錄，系統不會自動建議倉位大小 | 缺口，但屬於「下單輔助」而不是「選股邏輯」的範疇，優先度比上面幾項低 |

### 關鍵發現：「四率四升」要的原始資料，其實已經在抓了

這是這次比對最有價值的一個發現：`functions/index.js` 的
`TWSE_OFFICIAL_FINANCIALS_DATASETS_` 已經在串 TWSE 公開資訊觀測站的
官方 OpenAPI，**抓的是全市場、結構化 JSON 格式**的三份資料集：
- `t187ap05_L`：上市公司每月營業收入彙總表（月營收，含 YoY/MoM 可以
  算連續雙增）。
- `t187ap06_L_ci`：上市公司綜合損益表（一般業）——有營收/營業成本/
  營業利益/稅後純益這些算毛利率/營益率/淨利率要用的數字。
- `t187ap07_L_ci`：上市公司資產負債表（一般業）——有股東權益，算
  ROE 要用。

**但目前這三份資料只有一個用途**：`buildTwseOfficialFinancialsTextForCode_`
（`functions/lib/aiDiagnosis.js`）把「符合這個代號」的那幾列，每個
欄位原封不動轉成「欄位名：值」的純文字，塞進 AI 深度診斷的 prompt
給 LLM 自己判斷——**完全沒有解析成結構化數字、沒有算毛利率/營益率/
淨利率/ROE 的趨勢、沒有存進任何 collection、更不會影響 Armor_Score
或戰報篩選**。換句話說：要做余博的「四率四升」跟「月營收連續雙增」，
**不需要新增資料來源**，現有的抓取管線已經有原始資料了，缺的是「把
這三份 JSON 解析成結構化數字、算出逐季/逐月趨勢、轉成可以拿來排名/
篩選的量化因子」這一段邏輯。這比「從零開始接一個新的財報資料源」要
省工很多。

（這三份 OpenAPI 回應實際的欄位名稱要等真的動手實作時連線查一次才能
確認——這個開發環境的網路政策不開放連到 `openapi.twse.com.tw`，無法
現在就把確切欄位名稱列出來，這是实作階段要做的第一步，不是現在能
先確認的。）

### 具體建議（依優先度排序，還沒有任何一項真的動手做）

1. **最推薦**：把 `TWSE_OFFICIAL_FINANCIALS_DATASETS_` 的三份資料集
   解析成結構化的「毛利率／營益率／淨利率／ROE／月營收 YoY/MoM」時間
   序列，算出「連續 N 期上升」這種布林值因子，加進
   `FactorRegression.gs` 對應的 Firebase 版因子迴歸模型當候選特徵
   （權重讓 LASSO 自己決定是不是真的有效，不用先驗假設一定有用）。
   這組因子是目前系統唯一完全空白的「基本面」維度，補上去最有可能
   真正提升篩選品質，而且資料已經在手上，不需要新的資料來源。
2. **次推薦**：終極 20MA 三部曲——在 `computeFactors_` 多算一個
   「均線糾結後首次帶量突破」「回測 20MA 量縮不破」的布林值序列，
   當成 `Trend_Score` 之外的輔助時機因子，給使用者多一個「現在是不是
   在相對低風險的進場時機」的參考，不一定要馬上變成硬性篩選條件，
   可以先當成戰報頁面的額外標註。
3. **資料面前置工作**：投信買超佔股本比這個因子需要「發行股本」
   資料，要先確認 TWSE 有沒有現成的 OpenAPI 端點可以抓（比照
   `TWSE_OFFICIAL_FINANCIALS_DATASETS_` 的做法），有的話再評估要不要
   加這個因子。
4. **低優先度，先不用動**：季底結帳效應、分批建倉倉位建議——都是
   「選股邏輯」之外的輔助功能，等核心的因子掃描/回測先搬完、基本面
   因子補上去之後再考慮。

### 建議的下一步

開始搬 `Backtest.gs`／`FactorRegression.gs` 到 Firebase 時，**建議先
照原樣搬（忠實移植現有邏輯，不要一邊搬一邊改設計）**，上面「最推薦」
的基本面因子當成搬完之後的**獨立強化項目**，不要卡在同一個 PR/階段
裡——理由跟這次遷移其他地方的原則一致：先讓功能恢復、確認跟 apps-script
版算出來的結果一致（這份清單的回測/因子迴歸都有明確的數字可以比對，
照搬的時候比對起來比較有把握），基本面因子是全新邏輯，没有旧版本可以
比對正確性，應該獨立驗證，不要兩件事混在一次變更裡。

## 2026-10-08：策略研究（一）——Backtest.gs 回測功能遷移到 Firebase

照上面「建議的下一步」的順序，先搬 `Backtest.gs`（自成一體、預設的
`rule_v17` 策略不需要因子迴歸模型），`FactorRegression.gs` 留給下一階段。

### 架構對應

- `functions/lib/backtest.js`（新檔案）：純函式邏輯，從 `Backtest.gs`
  複製 `simulateTradeForward_`／`validateBacktestRange_`／
  `computeBacktestLoadEndStr_`／`simulateBacktestForStrategy_` 過來，不碰
  BigQuery／Firestore，`functions/test/backtest.test.js` 8 個測試不需要
  雲端憑證就能跑。刻意直接重用 `analysis.js` 的 `diagnoseRow_`／
  `SCREENING_STRATEGIES`——回測用的因子計算跟進場訊號判斷跟「戰報與個股」
  是同一套邏輯，不是另一套近似規則，回測結果才真的能反映「照這套策略
  下單，過去表現如何」。
- `functions/index.js` 新增 I/O glue：`fetchHistoryRangeRows_`（BigQuery
  讀取區間資料）、`loadBacktestFactorRows_`（往前多抓
  `ANALYSIS_LOOKBACK_DAYS` 天暖機、呼叫 `analysis.computeFactors_`）、
  `runBacktestCore_`／`runBacktestAllStrategiesCore_`（對應 apps-script 版
  `runBacktestV17_`／`runBacktestAllStrategies_` 的核心邏輯，不含
  auth／job 狀態）。因子模型套用狀態直接重用既有的
  `fetchAppliedFactorModels_()`（原本就有，`runDailyAnalysis_` 已經在用），
  不需要另外新建。
- `exports.runBacktest`（單一策略）／`exports.runBacktestAllStrategies`
  （一次跑全部策略比較，資料只抓一次，不會因為策略數而乘倍查詢費用）
  兩個新 onCall，跟「補抓區間」「執行完整排程」同一套 `jobs/{jobKey}`
  狀態追蹤模式（見上面「每日股價資料抓取」一節 `writeJobStatus_` 的完整
  說明）：兩個 function 共用 `jobs/backtest` 這個 key，用 `mode` 欄位
  （`'single'`／`'all'`）區分，前端用 `onSnapshot` 監聽同一份文件、根據
  `mode` 顯示對應的結果版面。
- 前端新增 `frontend/src/components/research/ResearchView.vue`，掛進
  `AppShell.vue` 原本的占位 tab（`{ key: 'research', ready: false }` 改
  成 `ready: true`）。按鈕永遠可以按、不因為 `status === 'running'` 鎖住
  （跟「補抓區間」同一個理由：平台逾時強制中止不會走到失敗分支，這是
  單人工具不需要防併發搶按鈕）。

### 設計決定

- **沒有搬 apps-script 版的背景 job 狀態機**（`startBacktestV17Job`／
  `getBacktestV17JobStatus`／`processBacktestV17JobTick_`／
  `clearBacktestV17Job_`，靠 Script Properties 存狀態、分批 tick 執行）
  ——那是 Apps Script 單次執行 6 分鐘上限逼出來的設計，Cloud Functions
  單次呼叫可以宣告自己的 `timeoutSeconds`，一次同步跑完就夠，不需要
  「背景分批」這層機制，也因此不需要「強制清除卡住 job」這顆按鈕
  （`jobs/backtest` 本來就不是硬鎖，新呼叫自動覆寫掉卡住的舊狀態）。
- **trades 欄位名稱改成英文**（`code`／`entryDate`／`finalReturnPct`...），
  不是 apps-script 版 Sheets 的中文欄名（`證券代號`／`進場日`）——這份
  結果直接回傳給前端／存進 `jobs/backtest`，跟 `reportPipeline.js` 的
  `reportDocs` 同一個「新系統直接用英文欄名」慣例。
- **沒有新建 `backtest_results` Firestore collection 存歷史回測結果**
  ——apps-script 版本身也沒有把回測結果持久化到 Sheet，只存在 Script
  Properties 的 job 狀態裡（跑完下一次就覆蓋），Firebase 版用
  `jobs/backtest`（每次覆蓋）維持跟原本行為一致，不是遷移時漏做。
  `schema.md` 原本把 `backtest_results` 標記「Phase 3，等背景 job 邏輯
  一起遷移」——現在確認不需要這份 collection。
- **`memory: '2GiB'`**（`BACKTEST_RUNTIME_OPTS_`，蓋掉 `RUNTIME_OPTS_`
  預設的 `1GiB`）：回測要讀的資料量比戰報本身大（戰報只抓
  `ANALYSIS_LOOKBACK_DAYS` 150 天暖機，回測區間另外還要加上進場區間
  本身（最多 `BACKTEST_MAX_RANGE_DAYS` 60 天）跟出場追蹤緩衝
  （`BACKTEST_MAX_HOLD_DAYS` 40 個交易日，換算日曆天數抓寬到約 64 天），
  總共可能讀到 270 天以上的全市場資料，保守抓到 2GiB——這個開發環境
  沒辦法實際跑一次量測真實記憶體用量，先用保守值，正式環境真的遇到
  OOM 再調整。
- **`errorToHttpsError_`**：`runBacktestCore_` 沿用 apps-script 版「驗證
  失敗回傳 `{error}` 物件、不拋例外」的設計，在 onCall 邊界統一轉成
  `HttpsError('failed-precondition', ...)`，跟這個 Firebase 版其他 onCall
  一致（前端 catch 認的是拋出來的例外）。但
  `runBacktestAllStrategiesCore_` 回傳的 `results[key].error`（某一個
  策略因為沒套用因子模型跑不了，其他策略正常）**不**轉換，維持原樣當
  正常資料的一部分——這是刻意的部分失敗設計，不是整批失敗。

### 還沒做的事

- `factor_model_rank`／`hybrid` 這兩個策略需要先套用一版抗跌力因子
  迴歸模型才能跑回測——`FactorRegression.gs` 還沒遷移，目前跑這兩個
  策略會回報「需要先套用模型，請先切換回 rule_v17」的錯誤（`rule_v17`
  正常可用）。下一階段：遷移 `FactorRegression.gs`（BigQuery ML LASSO
  迴歸，726 行，見上面「策略研究：開工前的比對分析」一節）。
- 因子掃描（`factor_scan_results` collection，掃描當前候選名單在各種
  因子組合下的表現分佈，不是回測歷史區間）還沒開始遷移，同樣留給
  `FactorRegression.gs` 那個階段一起處理。

## 2026-10-08：策略研究（二）——IndustryMap.gs 產業對照表遷移到 Firebase

搬 `FactorRegression.gs` 之前先確認的真實依賴缺口（見上面「策略研究：
開工前的比對分析」）：那 726 行裡有 36 個「產業資金流向」／「產業相對
大盤強度」候選因子，全部要 JOIN BigQuery 的 `industry_map` 表才有意義，
而 Phase 2 當時只把舊 Sheets 的歷史資料一次性遷進了 Firestore，`IndustryMap.gs`
真正「定期重抓 TWSE 產業分類 → 同步進 BigQuery」這條管線完全沒搬。沒有
這張表，那 36 個因子訓練時全部會拿到中性值 0.5，訓練預算近 8 成被浪費
——所以在動 `FactorRegression.gs` 本身之前，先把這個前置依賴獨立搬過來。

### 架構對應

- `functions/lib/industryMap.js`（新檔案）：純函式邏輯，從
  `IndustryMap.gs` 複製 `translateIndustryCode_`／`detectFieldKey_`／
  `validateIndustryMapRows_`／`findUntranslatedIndustryCodes_`／
  `pickRandomSample_` 過來，新增 `parseTwseIndustryMapRows_`（抽出
  `fetchTwseListedIndustryMap_` 裡「偵測欄位＋翻譯＋過濾」這段不需要
  `UrlFetchApp` 的邏輯，方便測試）。`computeIndustryMapCoverage_` 跟
  apps-script 版不同：純函式直接吃 `trackedCodes` 陣列，不自己去抓
  「目前追蹤的最新一天」，那段 I/O 交給呼叫端。
- `functions/lib/bigquery.js` 新增 `industryMapTableRef_`／
  `buildSyncIndustryMapSql_`：把產業對照表同步進 BigQuery
  `industry_map` 表，給還沒遷移的 `FactorRegression.gs` 因子特徵 view
  將來 JOIN 用。
- `functions/index.js` 新增 I/O glue：`fetchTrackedCodesForCoverage_`
  （查 BigQuery 最新一天的全市場股票代號，用來算涵蓋率）、
  `fetchTwseListedIndustryMap_`（呼叫 TWSE OpenAPI t187ap03_L）、
  `fetchTpexListedIndustryMap_`（上櫃資料源還沒確認正確端點，明確回傳
  「沒有資料＋警告」）、`writeIndustryMapToFirestore_`（整份覆蓋
  `industry_map/{code}`）、`syncIndustryMapToBigQuery_`、
  `doRefreshIndustryMap_`（串起以上步驟＋品質驗證）。
- `exports.runIndustryMapRefresh`（onCall）＋`exports.getIndustryMapSample`
  （onCall，純讀取隨機抽樣用，跟刷新是分開的兩個按鈕）：前者跟補抓區間/
  回測同一套 `jobs/industryMapRefresh` 狀態追蹤模式。
- 前端 `AdminView.vue` 新增「產業對照表」卡片（放在「資料完整性月曆」
  之後）：刷新按鈕＋即時執行狀態卡片＋隨機抽樣表格。

### 設計決定

- **沒有搬背景 job 狀態機**（`startIndustryMapRefreshJob`／
  `processIndustryMapJobTick_`／`clearIndustryMapRefreshJob_`）——跟這次
  遷移其他功能一致的理由：Cloud Functions 一次同步呼叫就能跑完，不需要
  Apps Script 6 分鐘執行上限逼出來的分批機制。
- **BigQuery 同步改成手刻 `CREATE OR REPLACE TABLE ... AS SELECT`，不是
  CSV load job**——apps-script 版用 `BigQuery.Jobs.insert` 的 CSV load
  job（Apps Script 進階服務的既有模式，要處理 CSV 跳脫跟輪詢 job 狀態），
  這裡改成跟其他表一致的手刻 SQL 字串（見 `buildSyncIndustryMapSql_`），
  一次查詢直接完成，不用另外等 load job。全市場上市櫃公司數量級（上千檔）
  遠低於 BigQuery 查詢 1MB 上限，不需要像 `history_raw` 補抓那樣切 chunk。
- **沒有改用「橫斷面計算」把產業資金流向因子搬進 `computeFactors_`**——
  這些因子是當天全市場 window function 算出來的（SQL 查詢階段的概念），
  跟 `computeFactors_`（JS，逐股票算技術因子）不是同一種計算模型。這批
  工作只負責把 `industry_map` 這張前置依賴表的資料管線接上，`FactorRegression.gs`
  本身的因子特徵 view（`buildFeatureViewSql_`）跟推論時的橫斷面因子計算
  架構問題，留給下一階段處理，不在這次範圍內。
- **TWSE OpenAPI 的 fetch 沒有套用 `fetchTwseCsvText_` 那套手動跟隨
  307 重新導向的邏輯**——`openapi.twse.com.tw`（JSON API）跟
  `www.twse.com.tw`（CSV 匯出，之前遇過 307 問題的那個）是不同主機、
  不同協定層的端點，目前沒有證據顯示這裡也有同樣的重新導向問題，先用
  一般 `fetch`，如果之後真的遇到類似錯誤再比照處理，不預防性套用增加
  複雜度。

### 還沒做的事

- 上櫃（TPEX）產業別資料源還沒確認正確的 API 路徑（跟 apps-script 版
  現狀一致），目前只有上市股票有產業別資料，涵蓋率會因此低於 100%。
- 這只是 `FactorRegression.gs` 的前置依賴，`factor_model_rank`／`hybrid`
  策略本身還是不能用，下一階段才是真正遷移因子迴歸模型訓練本身。
- 這個開發環境連不到 `openapi.twse.com.tw`／BigQuery，`fetchTwseListedIndustryMap_`
  的欄位偵測關鍵字、`buildSyncIndustryMapSql_` 組出來的 SQL 都只在純函式
  測試層級驗證過字串/邏輯本身，沒辦法在這裡實際跑一次確認 TWSE 回傳的
  真實欄位名稱跟預期一致，需要部署後在正式環境手動按一次「重新整理產業
  對照表」才能真正驗證。

## 2026-10-08：「標示已賣出」支援部分賣出（新增賣出股數欄位）

使用者看到「標示已賣出」表單只有賣出日期／賣出價格，回報少了可以輸入
「賣出單位數」的地方——原本 apps-script 版跟 Firebase 版都刻意不支援
部分賣出（舊版註解明講：想部分獲利了結要先手動刪除想保留的買進紀錄，
只結案剩下的那幾筆，算是進階用法），這次改成直接在表單上加一個選填的
「賣出股數」欄位，由後端處理部分賣出的邏輯，不用使用者自己先手動拆
買進紀錄。

### 設計

- **FIFO（先進先出）**：`lib/portfolioOps.js` 新增 `planPartialClose_`
  純函式，依買進日期由舊到新，依序把整筆 lot 標記賣出，直到剩下的賣出
  股數不夠賣掉下一筆完整的 lot，就把那一筆「就地切開」成「已賣出的
  部分」跟「繼續持有的部分」兩筆文件。不用使用者自己指定要賣哪一筆
  買進紀錄（維持這個表單原本「選一檔股票就好」的簡單操作），FIFO 也是
  股票庫存管理最常見的預設慣例。
- **留空＝整檔全部結案，行為跟改之前完全一樣**：`sellShares` 不帶、是
  空字串，或剛好等於目前總股數，都視為「全部賣出」，直接沿用原本
  `fullyClosedIds` 涵蓋所有 lot 的路徑，不會因為新增這個欄位讓最常見的
  「整檔賣掉」操作多一個步驟。
- **切開的 lot 用 Firestore 自動產生的新文件 ID**：`exports.closePortfolioPosition`
  把原本那筆 lot 的 `shares` 改成剩下的股數（繼續 `status: 'holding'`），
  另外用 `savePortfolioItem` 新增買進紀錄同一個「`db.collection('portfolio_lots').doc()`
  產生新 ID 當 `transactionId`」寫法，新增一筆 `status: 'sold'` 的文件。
  `buildClosedHistory_` 本來就是依 `code+sellDate+sellPrice` 分組算已
  實現損益，這筆新拆出來的「已賣出」文件會自然跟同一次結案動作分在
  同一組，不需要改 `buildClosedHistory_` 本身。
- **驗證失敗整批放棄，不會部分寫入**：賣出股數 `<=0` 或超過目前總股數，
  `planPartialClose_` 直接回傳 `error`，`exports.closePortfolioPosition`
  在送出任何 Firestore batch 寫入之前就先擋下來拋 `invalid-argument`，
  不會有「寫到一半」的中間狀態。
- 寫 `planPartialClose_` 的測試時抓到一個邊界案例：賣出股數剛好等於
  前面幾筆 lot 的加總（例如兩筆各 1000 股，賣 1000 股）時，迴圈最後一輪
  `remaining` 已經歸零，原本的寫法還是會走進「切 lot」那個分支，對下一筆
  lot 生出一個 `soldShares: 0` 的假 `partialLot`——加上 `remaining > 0`
  的迴圈條件後修正，測試案例已經涵蓋這個情境。

## 2026-10-08：策略研究（三）——FactorScan.gs 因子相關性掃描遷移到 Firebase

照「策略研究：開工前的比對分析」那節的建議，下一步是搬
`FactorRegression.gs`／`FactorScan.gs`。重新盤點後發現這兩支其實完全
獨立、規模差異很大：`FactorScan.gs` 只有 116 行、純 JS 運算（跟
BigQuery ML 無關），`FactorRegression.gs` 是 726 行的 BigQuery ML LASSO
訓練管線。照這個 session 一貫的順序（先搬小的、風險低的，建立信心跟
測試基礎，再碰大的），這裡先搬 `FactorScan.gs`，`FactorRegression.gs`
本身留給下一階段。

### 架構對應

- `functions/lib/factorScan.js`（新檔案）：純函式邏輯，從
  `FactorScan.gs` 複製 `computeStreak_`／`computeFactorScanFields_`
  過來，新增 `computeFactorCorrelations_`（抽出
  `runFactorCorrelationScan` 裡「過濾有效樣本＋算相關係數＋排序」這段
  不需要 I/O 的部分，方便測試）。意外發現：`computeFactorScanFields_`
  用到的 `pctChange`／`rollingSum`／`rollingMean`／`rollingMin`／
  `diffN`／`shiftN`／`pearsonCorrelation` 這些工具函式**全部已經存在**
  `lib/utils.js`（之前某個階段已經為了別的用途搬過），這支port幾乎只是
  把 `FactorScan.gs` 的運算邏輯接上既有工具函式，不需要重新刻一套。
- `functions/index.js` 新增 `runFactorScanCore_`（直接重用 backtest 那邊
  已經建好的 `fetchHistoryRangeRows_`，不需要新的 BigQuery 查詢邏輯）跟
  `exports.runFactorCorrelationScan`（onCall），跟回測同一套
  `jobs/{jobKey}` 狀態追蹤模式（這裡是獨立的 `jobs/factorScan`，不是
  共用 `jobs/backtest`）。
- 前端 `ResearchView.vue` 新增「📊 因子相關性掃描」卡片：日期區間輸入
  （留空＝全部 History 資料，跟 apps-script 版一致）、執行狀態卡片、
  相關係數表格（正相關綠色、負相關紅色）。

### 設計決定

- **沒有搬背景 job 狀態機**——跟這次遷移其他功能一致的理由：Cloud
  Functions 一次同步呼叫就能跑完，不需要 Apps Script 6 分鐘上限逼出來
  的分批機制。
- **日期區間可以留空代表「全部歷史資料」，沿用 `BACKTEST_RUNTIME_OPTS_`
  （2GiB／540s）**：跟回測不同，這支沒有像 `BACKTEST_MAX_RANGE_DAYS`
  那樣的區間上限（apps-script 版本來就允許留空掃全部），理論上資料量
  可能比回測固定區間更大，這個開發環境沒辦法實際量測，先沿用已經在用
  的較高規格，正式環境真的遇到 OOM／逾時再調整或補上合理的區間上限。
- **這支因子跟 `computeFactors_`（戰報用）即使同名也不是同一套定義**
  ——例如 `Trend_Score` 這裡用 `diff(1)` 算均線斜率，`computeFactors_`
  用 `diff(3)`，apps-script 原始碼就特別註解這是刻意的差異，不是筆誤，
  照原樣保留，不要「順手」統一成同一個算法（這支是獨立的研究工具，
  目的是找出可能有效的因子方向，不是要跟正式戰報的判斷邏輯一致）。

### 還沒做的事

- `FactorRegression.gs`（BigQuery ML LASSO 迴歸，726 行）本身還沒遷移
  ——`factor_model_rank`／`hybrid` 這兩個策略仍然不能用，因子相關性
  掃描只是獨立的研究輔助工具，不會自動把結果接進正式的因子模型訓練。

## 2026-10-08：策略研究（四）——FactorRegression.gs 因子迴歸模型訓練遷移到 Firebase

這是「策略研究：開工前的比對分析」裡規模最大、風險最高的一塊（726 行，
BigQuery ML LASSO 訓練管線）。前三個階段（Backtest.gs／IndustryMap.gs／
FactorScan.gs）都已經搬完，這裡是最後一塊——搬完之後 `factor_model_rank`／
`hybrid` 這兩個戰報篩選策略（跟上面的回測）才真正有模型可以套用。

### 架構對應

- `functions/lib/factorRegression.js`（新檔案）：純函式邏輯，包含整段
  `buildFeatureViewSql_`（因子特徵 view，10 個基礎因子＋2 個動能時機因子
  ＋24 個產業資金流向因子＋12 個產業相對大盤強度因子，共 48 個候選因子）
  逐行對照 apps-script 版照搬，`buildFeatureSnapshotSql_`／
  `buildTrainModelSql_`／`buildEvaluateSql_`／`buildWeightsSql_`／
  `summarizeWeights_`／`topWeightedFeatures_`／`factorModelName_`／
  `buildIndustryCapitalFlowStatsSql_` 一併搬過來，新增
  `buildFactorModelDocId_`（Firestore 文件 ID 規則，跟 Phase 2 一次性
  遷移腳本的 `buildDocId_` 公式一致，新舊資料才能共用同一個
  collection）。**這批函式用 `test/parity.test.js` 的 vm 技巧逐一跟
  apps-script/src/FactorRegression.gs 的原始函式比對（Parity 6），SQL
  組字串是字串完全相等斷言，不是「看起來差不多」——這是目前整個遷移
  專案風險最高的一段 SQL（一大段多層 CTE 的 window function），字串
  完全相等是能做到的最強驗證，彌補這個環境連不到真正 BigQuery、無法
  實際執行驗證的缺口。**
- `functions/lib/config.js` 新增 `FACTOR_CANDIDATE_COLUMNS`（48 個，
  用跟 apps-script 版同一招「先宣告基礎清單，再用 forEach+push 動態
  生成產業因子欄位名稱」組出來，不是手動寫死整份 48 項清單）、
  `INDUSTRY_FLOW_INVESTOR_TYPES`／`INDUSTRY_FLOW_WINDOWS`／
  `INDUSTRY_REL_MARKET_TYPE_WINDOWS`／`industryFlowFactorName`／
  `industryRelMarketWindowsForType`／`industryRelMarketFactorName`／
  `FACTOR_LABELS`／`FACTOR_MODEL_L1_REG_DEFAULT`。`BQ_FEATURE_TO_ANALYSIS_FIELD`
  （推論時給 `computeWeightedFactorScore_` 查的對照表）**沒有擴充**
  ——這是刻意的，見下面「設計決定」。
- `functions/lib/bigquery.js` 新增 `featureViewRef_`／
  `featureSnapshotTableRef_` 兩個表格參照字串 helper，跟既有的
  `rawTableRef_`／`industryMapTableRef_` 同一個模式。
- `functions/lib/utils.js` 新增 `timestampSecondsTaipei_`（'yyyy-MM-dd
  HH:mm:ss' 格式，含秒）——因子迴歸結果的文件 ID 要跟 Phase 2 遷移過去
  的舊資料共用同一套格式，不能沿用給 run_log／AI 診斷用的
  `timestampLabelTaipei_`（那支不含秒、有中文前綴）。
- `functions/index.js` 新增 I/O glue：`ensureIndustryMapSyncedToBigQuery_`
  （訓練前自動檢核，見下面說明）、`ensureFeatureView_`（建立/更新因子
  特徵 view）、`trainFactorModel_`（對單一 label 跑訓練＋評估＋取權重）、
  `writeFactorModelHistory_`（寫進 Firestore `factor_model_history`）、
  `runFactorRegressionCore_`（主流程，對兩個 label 各跑一次）。新增兩個
  onCall：`exports.runFactorRegression`（訓練，沿用 `jobs/{jobKey}`
  狀態追蹤模式）、`exports.applyFactorModel`（套用某一版，整個版本一起
  套用／取消套用其他版本，不讓兩個 label 套用到不同版本）。
- 前端 `ResearchView.vue` 新增「🧮 因子迴歸模型」卡片：目前生效模型摘要
  （關鍵影響因子）、L1 正規化強度輸入＋訓練按鈕＋執行狀態、訓練歷史
  表格（依執行時間分組，每筆可以按「套用這一版」）。

### 設計決定

- **沒有搬背景 job 狀態機**——跟這次遷移其他功能一致的理由：Cloud
  Functions 一次同步呼叫就能跑完，不需要 Apps Script 6 分鐘上限逼出來
  的分批機制。
- **`ensureIndustryMapSyncedToBigQuery_` 檢查 Firestore `jobs/industryMapRefresh`
  的最近一次結果，不是 Script Properties**：訓練前自動檢核 BigQuery 的
  `industry_map` 表有沒有成功同步過，沒有就先自動刷新一次（見「策略
  研究（二）」那節），不用使用者自己記得要先手動點一次。已經成功同步
  過就跳過，失敗也不阻擋後續訓練（候選因子裡的產業因子當下只是拿不到
  真實資料，COALESCE 成中性值 0.5，不影響其他因子正常訓練）——跟
  apps-script 版的取捨完全一致。
- **`BQ_FEATURE_TO_ANALYSIS_FIELD` 刻意沒有擴充到 48 個候選因子**：
  產業資金流向／產業相對大盤強度／動能時機這 38 個因子是當天全市場
  橫斷面 window function 算出來的（SQL 查詢階段的概念），跟
  `computeFactors_`（JS，逐股票算技術因子）不是同一種計算模型——要讓
  「今日戰報/回測」的即時預測分數用上這些因子，需要在 `computeFactors_`
  另外補上對應的橫斷面計算邏輯，這是獨立於「訓練」之外的工作，風險
  也完全不同（牽涉到會不會改壞現有戰報/回測的既有計算），不在這次
  範圍內。這不是遺漏：`computeWeightedFactorScore_`（`lib/factorModel.js`，
  Phase 2 就已經搬好）原本就有「查不到對照就跳過那一項」的防呆邏輯
  （見該函式說明），這些因子就算被 LASSO 選中且權重不是 0，也只是
  「暫時不會真的貢獻進即時預測分數」，不會出錯、也不會讓預測分數變成
  null。apps-script 版原始碼的 Config.gs 註解明確記載了同一個範圍
  界線跟同一個理由，這裡不是這次遷移才發明的妥協，是照搬原作者已經
  做過的判斷。
- **`memory: '2GiB'`／`timeoutSeconds: 1800`**（`FACTOR_REGRESSION_RUNTIME_OPTS_`）
  ：BQML 訓練（`CREATE MODEL`＋`ML.EVALUATE`＋`ML.WEIGHTS`，對兩個 label
  各跑一輪，`max_iterations` 設到 BQML 允許的上限 49）是這整個 App 最重
  的 BigQuery 操作，這個開發環境沒辦法連上真正的 BigQuery 實際量測，
  沿用 `runHistoryBackfill` 用過的最高上限（1800s）保守估計，正式環境
  真的遇到逾時/OOM 再依實測調整。
- **沒有搬 `getIndustryFlowFactorOptions`／`getIndustryCapitalFlowFactorStats`
  這組診斷工具**（apps-script 版「檢查某個產業資金流向因子的資料分佈，
  判斷它權重是 0 到底是真的沒用還是資料本身有問題」）：這是訓練結果
  出來之後才會用到的進階除錯工具，不是訓練本身的必要路徑，先把訓練＋
  套用這個核心迴圈搬完、確認能跑，這組工具留給下一輪需要時再補。

### 還沒做的事

- `BQ_FEATURE_TO_ANALYSIS_FIELD` 的 38 個因子缺口（見上面「設計決定」）
  ——如果訓練結果顯示某個產業因子真的有效（R² 貢獻明顯、權重不是 0），
  下一步才值得投入去幫 `computeFactors_` 補上對應的橫斷面計算邏輯，
  讓即時預測分數也用得上。
- `getIndustryFlowFactorOptions`／`getIndustryCapitalFlowFactorStats`
  診斷工具（見上面「設計決定」）。
- 這個開發環境連不到真正的 BigQuery，`buildFeatureViewSql_` 等 SQL
  組字串只在「跟 apps-script 原始碼字串完全相等」這個層級驗證過（見
  `test/parity.test.js` Parity 6），沒辦法確認這段 SQL 在真實 BigQuery
  上執行會不會报錯/跑多久——需要部署後在正式環境手動按一次「開始訓練」
  才能真正驗證整條管線（抓資料→建 view→訓練→評估→取權重→寫入
  Firestore）跑得通。

## 2026-10-08：余博邏輯延伸的基本面因子（四率四升＋月營收連續成長）

照「開工前的比對分析」那節的「最推薦」項目：把
`TWSE_OFFICIAL_FINANCIALS_DATASETS_`（已經在抓、但只餵給 AI 診斷當文字
參考的官方財報資料）解析成結構化的毛利率／營益率／淨利率／ROE／月營收
趨勢因子，加進因子迴歸模型的候選特徵。這是全新邏輯，apps-script 版沒有
對應程式碼可以照搬，使用者同時要求「順便加上資料的檢查區塊，例如以
月曆呈現，還有資料 sanity check 要看得到」。

### 架構對應

- `functions/lib/financials.js`（新檔案）：解析 TWSE 三個「一般業」官方
  端點（月營收 `t187ap05_L`、綜合損益表 `t187ap06_L_ci`、資產負債表
  `t187ap07_L_ci`）的純函式邏輯——欄位名稱沒有官方逐欄位文件可查，用
  關鍵字動態偵測（跟 `industryMap.js` 同一套手法，各自獨立一份），偵測
  不到就直接拋出清楚的錯誤，列出實際拿到的欄位名稱，不會用錯欄位硬解析
  出垃圾數字。計算毛利率／營益率／淨利率（綜合損益表）、ROE（損益表
  淨利／資產負債表權益總計）、連續上升期數（`computeIncreaseStreak_`，
  任一期缺資料就歸零，不會被誤判成沒中斷）、月營收 YoY 連續成長期數。
- `functions/lib/bigquery.js` 新增：`buildSyncFinancialRatiosSql_`／
  `buildSyncFinancialRevenueSql_`（整份覆蓋同步進 BigQuery，用
  `chunkStructRowsBySize_`——這是通用化、吸取了 `history_raw` 那次「列數
  可能隨時間累積到不小，不能假設資料量小」教訓的 chunk 邏輯，不是重蹈
  覆轍）、`buildFundamentalFeatureViewSql_`（**刻意不修改**
  `buildFeatureViewSql_` 本身，另外疊一層新 view `factor_features_fundamental`
  在它之上，見下面「設計決定」）。
- `functions/lib/config.js` 新增 `FUNDAMENTAL_CANDIDATE_COLUMNS`（10 個：
  4 個比率的原始值＋連續上升期數各一組，加上月營收 YoY／連續成長期數），
  push 進 `FACTOR_CANDIDATE_COLUMNS`（48 → 58 個）。
- `functions/index.js` 新增：`doRefreshFinancials_`（抓取＋解析＋驗證＋
  累積寫入 Firestore＋讀回完整歷史重算連續上升期數＋同步進 BigQuery）、
  `ensureFinancialsSyncedToBigQuery_`（訓練前自動檢核，跟
  `ensureIndustryMapSyncedToBigQuery_` 同一個模式）、
  `ensureFundamentalFeatureView_`（建立/更新疊加後的 view）。新增三個
  onCall：`exports.runFinancialsRefresh`（刷新，`jobs/financialsRefresh`
  狀態追蹤）、`exports.getFinancialsCoverage`（涵蓋率月曆資料）、
  `exports.getFinancialsSample`（隨機抽樣 sanity check）。
  `runFactorRegressionCore_` 改成對疊加後的 `factor_features_fundamental`
  view 做 snapshot／訓練，不是原本的 `factor_features`。
- 前端 `AdminView.vue` 新增「財報基本面因子」卡片
  （`FinancialsCoverageCard.vue`）：刷新按鈕＋執行狀態、涵蓋率月曆
  （月營收 12 格、季報 4 格，依年份切換，跟 `HistoryCalendarCard.vue`
  同一個紅/橘/綠配色邏輯但格狀單位是月/季不是日）、隨機抽樣表格。

### 設計決定

- **TWSE 這幾個端點是目前快照，不是歷史歸檔**：這個開發環境沒辦法連線
  確認，但官方「opendata」端點普遍是這個行為模式，保守假設處理——
  Firestore `financials_monthly/{code}_{period}`／
  `financials_quarterly/{code}_{period}` 用 `merge: true` 累積寫入（不是
  像 `industry_map` 那樣整份覆蓋），每次刷新都讀回完整累積歷史重新計算
  連續上升期數（新進的一期可能延續或打斷既有紀錄，必須看完整歷史）。
  BigQuery 那一層才是整份覆蓋（`financial_ratios`／`financial_revenue`
  表）——Firestore 存「會一直累積變大的歷史」，BigQuery 存「目前累積
  到的完整結果快照」，兩層職責不同。
- **點對點（point-in-time）正確的 JOIN，避免未來函數**：財報資料用
  「出表日期」（官方公告日）當作「這筆資料實際公開可得」的時間點，不是
  季度期末日或財報所屬月份——`buildFundamentalFeatureViewSql_` 對每個
  (stock_id, date) LEFT JOIN「`report_date <= date` 裡最新一筆」的財務
  比率／月營收資料，不是直接對齊同一天。找不到「出表日期」欄位就直接
  拋錯，不會用季度期末日頂替（那樣會製造一個使用者察覺不到的系統性
  偏誤）。月營收沒有對應的公告日欄位，用「月底 + 10 個日曆天」估算
  （對齊 TWSE 月營收法定公告期限），同樣是保守估計，見
  `estimateMonthlyRevenueReportDate_` 的說明。
- **刻意不修改 `buildFeatureViewSql_` 本身，另外疊一層新 view**：那支
  函式逐行對照 apps-script 原始碼做過字串完全相等的驗證（Parity 6），
  直接在裡面插入新邏輯的風險是「改壞一段已經驗證過在正式環境可以跑的
  SQL」，報酬完全不值得冒這個險。`buildFundamentalFeatureViewSql_` 疊在
  既有的 `factor_features` view 之上，Parity 6 的斷言完全不受影響（仍然
  通過）。
- **財報所屬季度（`fiscalPeriod`）優先用官方「年度」／「季別」欄位，
  沒有才用公告日反推估計**（`estimateFiscalQuarterFromReportDate_`，
  公告日往前推 60 天所在的季度）：這個欄位只給「涵蓋率月曆」彙總呈現
  用，不影響訓練的時間對齊邏輯（那一塊只看 `period`／公告日本身）——
  `fiscalPeriodIsEstimated` 旗標會讓前端明確標出「這是估計值」。
- **缺值不特別 COALESCE 成中性值**：`fundamental_*` 這 10 個新候選因子
  跟原本的 `dividend_yield`／`pe_ratio`／`pb_ratio` 同一個處理方式——
  找不到資料就是 NULL，`buildTrainModelSql_` 的 `WHERE ... IS NOT NULL`
  本來就會把這些列排除在訓練之外，不是這次才出現的新行為，也不用發明
  一個「中性值」糊弄過去（毛利率沒有天然的中性值，不像排名因子的 0.5
  那樣有明確意義）。
- **候選因子清單跟 apps-script 原版的字串比對（Parity 6）只比對前 48
  個**：第 49 個之後是全新的 10 個基本面因子，apps-script 沒有對應內容
  可以比對，`test/parity.test.js` 另外單獨斷言這 10 個剛好等於
  `FUNDAMENTAL_CANDIDATE_COLUMNS`。

### 還沒做的事

- ~~還沒接進「今日戰報/回測」的即時預測分數~~——**2026-10-08 已接上**，
  見下方「月營收歷史回補」之後新增的「基本面因子接進即時預測分數」一節。
  產業資金流向因子（`industry_flow_*`／`industry_rel_mkt_*`，36 個）、
  `inst_accum_divergence_20d`／`days_since_new_low` 這 38 個因子**還是**
  跟原本一樣只用於訓練，`computeFactors_`（JS）沒有對應的計算邏輯，不在
  這次範圍內。
- **欄位名稱、民國年/西元年格式、「出表日期」是否真的存在這個欄位**
  都是依 TWSE 官方報表長年公開的標準格式整理出來的最佳猜測，這個開發
  環境完全沒辦法連線核對——部署後第一次執行「重新整理財報因子」如果
  欄位偵測失敗，Admin 頁面「財報基本面因子」卡片會顯示清楚的錯誤訊息
  （列出實際拿到的欄位名稱），照那個訊息回報就能一次修正。
- **目前只接了「一般業」財報端點**，金融/證券/保險/金控等特殊產業別
  查無資料是預期行為（跟 AI 診斷的 `TWSE_OFFICIAL_FINANCIALS_DATASETS_`
  現有限制一致）。
- 因為 TWSE 端點很可能只回傳「目前最新一期」，第一次執行只會累積到
  一期資料，連續上升期數全部會是 0——要看到真正有意義的「連續上升」
  訊號，需要在接下來幾週／幾季重複執行「重新整理財報因子」，累積出
  至少 2~3 期的歷史才看得出差異，這是資料本質的限制，不是程式邏輯
  的問題。

### 2026-10-08 追加：用 WebSearch 查到 data.gov.tw 鏡像站資料，修正兩個猜測

部署後使用者要求「看一下 API 文件，能否選擇要抓的資料時間；另外看看
BigQuery 中是否已有累積相關資料」。這個開發環境連不到
`openapi.twse.com.tw`（連 `WebFetch` 對任何網域都是 DNS 解析失敗，不是
只有 TWSE 被擋），但 `WebSearch` 查到 `data.gov.tw`（政府資料開放平臺，
跟 TWSE OpenAPI 同一份原始資料的官方鏡像）的資料集說明頁，間接確認了
幾件事：

1. **沒有日期區間查詢參數**：三個資料集（編號 18420「上市公司每月營業
   收入彙總表」、91998「上市公司綜合損益表(一般業)」及對應的資產負債表）
   的 API 說明都只是整份回傳，沒有列出可以指定日期/期間的查詢參數；
   TWSE 自己的說明也明講「如需歷史資料，請至公開資訊觀測站瀏覽」——
   證實這些 opendata 端點就是「目前最新一期」快照，不是歷史歸檔，
   之前的設計假設（累積寫入 Firestore，見上面「跟 industry_map 不同的
   資料累積方式」）方向是對的。
2. **BigQuery 裡沒有既有的累積資料**——用 Agent 搜過整個 repo（apps-script
   跟 Firebase 兩邊），`BigQuerySync.gs`／`lib/bigquery.js` 裡所有曾經
   建立過的 BigQuery 表只有 `history_raw`／`history_external`／
   `history_materialized`／`industry_map`／`factor_features_snapshot`，
   從來沒有任何財報/營收相關的表——`financial_ratios`／
   `financial_revenue` 是這個 session 才第一次建立，apps-script 版
   從未累積過這份資料。
3. **修正了兩個猜測**（之前因為連不上線只能照 TWSE 報表長年的標準格式
   猜測，這次用 `WebSearch` 查到鏡像站的範例資料核對到）：
   - 月營收資料集（t187ap05_L）其實**有**「出表日期」官方公告日欄位，
     不是像原本以為的只有「資料年月」——原本用「月底+10天」估算，現在
     改成優先偵測並使用官方欄位，估算只在真的抓不到這個欄位時當備援
     （`parseMonthlyRevenueRows_`／`estimateMonthlyRevenueReportDate_`
     的呼叫順序對調）。
   - 「出表日期」欄位的範例值格式是**無分隔符的民國年 7 碼字串**
     （例如 `"1150111"` 代表民國 115 年 01 月 11 日），不是原本只處理的
     `'yyy/MM/dd'` 這種有分隔符格式——`parseTwseDate_` 補上這個格式的
     解析（固定寬度 3+2+2 碼，不能用貪婪 regex 硬吃，跟 `normalizeYearMonth_`
     處理 5 碼民國年月同一個理由）。

**仍然要提醒的保留限制**：這些資訊來自 `data.gov.tw` 鏡像站的資料集
說明跟範例，不是直接連線 `openapi.twse.com.tw` 核對到的即時回應——
鏡像站的格式跟即時 API 的 JSON 回應有可能一致，也有可能有細節出入
（例如欄位名稱的全形/半形括號、是否補零），`parseTwseDate_`／
`detectFieldKey_` 都保留了原本的備援路徑（分隔符格式／關鍵字模糊比對），
不是只認新查到的這一種格式，但最終還是需要部署後實際執行一次「重新
整理財報因子」才能 100% 確認。

## 2026-10-08：月營收歷史回補（MOPS 靜態頁面）

使用者實測發現：財報因子月曆每格全部顯示紅色 0，但隨機抽樣看得到真實
資料（2026-08，累積 1085 筆）。原因不是 bug，是涵蓋率月曆只在頁面
`onMounted` 時載入一次，沒有自己的重新整理按鈕——補上「⟳ 重新載入」
按鈕後確認資料其實都在，只是全部集中在 8月（月營收）／Q2（季報），因為
這整套「財報基本面因子」功能是這個 session 當天才第一次做出來、第一次
執行，TWSE OpenAPI 只給「目前最新一期」快照，不是使用者記憶中「一月就
開始抓」的那份（那份其實是指股價歷史資料 `history_raw`，遷移自舊
apps-script，是完全不同的兩套資料，年資也完全不同）。

使用者接著問「能不能回溯補齊今年稍早的月份」。順著這個問題，用
`WebSearch` 查到第三方工具 jacksu.tw 的資料底層是接「公開資訊觀測站
MOPS」（`mops.twse.com.tw`），不是現在用的 `openapi.twse.com.tw`——這
是兩個不同系統，MOPS 本身是支援查歷史資料的（網頁查詢介面可以選「歷史
資料」＋輸入民國年／月）。

### 找到的歷史回補路徑

這個開發環境連不到任何 `*.twse.com.tw` 網域（含 `mopsov.twse.com.tw`），
没辦法直接連線核對確切格式，改用 `WebFetch` 挖開源 Python 套件 twmops
（github.com/whchien/twmops，目前仍在維護、最近才發過新版）的原始碼
逆推出實際網址格式與解析邏輯：

```
https://mopsov.twse.com.tw/nas/t21/{market}/t21sc03_{民國年}_{月}_{company_type}.html
```

（`market`：`sii`=上市／`otc`=上櫃，`company_type`：0=一般業）。回應是
Big5 編碼的純 HTML，逐產業別各自一個 `<table>`，欄位依**位置索引**（不是
標題文字）對應：`[0]`代號 `[1]`名稱 `[2]`當月營收 `[3]`上月營收 `[4]`去年
當月營收 `[5]`上月比較增減% `[6]`去年同月增減% `[7]`當月累計營收 `[8]`
去年累計營收 `[9]`前期比較增減% `[10]`備註。使用者 2026-10-08 用手機
瀏覽器實際打開 `t21sc03_115_7_0.html` 截圖確認畫面內容吻合這個格式。

### 架構對應

- `functions/lib/mopsRevenueHtml.js`（新檔，純函式）：`extractHtmlTables_`
  （正規表示式拆 `<table>/<tr>/<td>`，跟 `index.js fetchGoodinfoText_` 的
  去標籤手法同一個「夠用就好、不為單一資料源引入 cheerio 之類新依賴」
  風格——這個專案目前沒有引入任何 HTML parser 套件）、
  `isMopsRevenueDataRow_`（濾掉「合計」小計列／欄名列，規則從 twmops
  原始碼逆推）、`parseMopsRevenueTables_`（位置索引對應成跟
  `financials.js parseMonthlyRevenueRows_` 同一個輸出形狀，多一個
  `source:'mopsBackfill'` 欄位）、`buildMopsRevenueUrl_`、
  `enumeratePeriodsInclusive_`。
- `functions/index.js`：`fetchMopsRevenueHtml_`（I/O，跟 `fetchTwseCsvText_`
  同一套 Big5 解碼／手動重新導向／瀏覽器 header 組合，404 當「這個月
  還沒歸檔」處理不拋例外）、`runFinancialsBackfillMopsCore_`（逐
  期間×市場序列請求＋節流，刻意不用 `Promise.all` 平行發送——MOPS 有
  速率限制）、`exports.runFinancialsBackfillMops`（onCall，`jobs/
  financialsBackfillMops` 狀態追蹤，一次最多 12 個月）。
- 回補出來的資料寫進**同一個** `financials_monthly` collection（doc ID
  一樣是 `code_period`），所以既有的涵蓋率月曆／隨機抽樣 UI 不用另外
  做一份——兩種來源的資料都會自動出現在同一份月曆/抽樣表格裡，抽樣
  表格加了「來源」欄位（`OpenAPI`／`MOPS回補`）方便肉眼分辨。
- 前端 `FinancialsCoverageCard.vue` 新增「歷史回補（MOPS，僅月營收）」
  區塊：起始/結束年月輸入、「開始回補」按鈕、`jobs/financialsBackfillMops`
  狀態卡片（含逐期間/市場的即時進度）。

### 設計決定

- **點對點正確性**：這個靜態頁面只有整頁共用的「出表日期」（代表頁面
  產生/快照時間，不是每家公司逐筆的官方公告日），不能拿來當訓練要用的
  `reportDate`。回補出來的 `reportDate` 一律用現有的
  `estimateMonthlyRevenueReportDate_`（月底+10天法定公告期限）估算，並
  標記 `reportDateIsEstimated: true`。
- **不覆蓋更精確的既有資料**：如果同一個 `code_period` 已經有
  `reportDateIsEstimated === false` 的文件（來自 OpenAPI 來源，帶官方
  出表日期），回補時會跳過那一筆，不會讓精確值退化成這裡的粗略估計值
  （`runFinancialsBackfillMopsCore_` 裡先讀一次既有文件組出 Set 再過濾）。
- **只接月營收**：綜合損益表／資產負債表（四率四升用的那兩份）目前沒有
  找到對應的 MOPS 靜態歷史頁面格式，季報財務比率還是只能靠 OpenAPI
  往後逐月累積，這點在前端卡片跟「已知限制」都有明確標示。
- **序列請求＋節流**：twmops 套件預設限制「每秒 1 個請求」尊重 MOPS，
  這裡用迴圈＋`sleep_`（1.1 秒間隔）模仿同樣的節流，不用 `Promise.all`
  平行打；一次最多回補 12 個月（×2 市場＝最多 24 個序列請求），對應
  後端 `timeoutSeconds: 600` 的執行預算，超過要求使用者分批執行。

### 還沒做的事 / 保留限制

- **這個網址格式沒辦法在這個開發環境直接驗證**——是從 twmops 原始碼
  逆推出來的，不是直接連線 `mopsov.twse.com.tw` 核對到的即時回應，部署
  後第一次執行如果格式不符（例如欄位順序跟逆推出來的不一樣），錯誤
  訊息會帶 HTTP 狀態碼/網址方便診斷，但無法保證第一次就跑對。
- 季報財務比率（毛利率/營益率/淨利率/ROE）**不支援**歷史回補，見上方
  「只接月營收」。
- 回補出來的連續成長期數是用「全部已累積月份」重算（`computeRevenueGrowthStreaks_`
  對整批資料重跑），不是只對新回補的部分增量更新——這個函式本身就是
  這樣設計的（見 `doRefreshFinancials_` 的既有邏輯），這裡沿用同一套，
  不是這次新增的行為。

### 2026-10-08 追加：範圍修正（誤抓上櫃）、來源可見度、連線中斷誤報失敗

使用者實測回補 2026-01~09 之後回報三個問題：

1. **誤抓上櫃股票**：`MOPS_BACKFILL_MARKETS_` 原本是 `['sii', 'otc']`
   （上市＋上櫃），回補後 8月涵蓋檔數從 OpenAPI 來源原本的 1085 檔跳到
   1949 檔——跟這個 App 其他地方的既定範圍不一致：`industry_map`
   collection 明確只收上市股票（`fetchTpexListedIndustryMap_` 固定
   回傳空陣列＋警告「上櫃產業別資料源尚未確認」），股價歷史
   （T86／MI_INDEX／BWIBBU_d）也都是 TWSE（上市）端點，整個 App 沒有
   任何地方真的在處理上櫃股票。改成只抓 `sii`，已經誤寫入的上櫃資料
   靠新增的 `exports.cleanupFinancialsNonListedCodes`（比對
   `industry_map` 清單，刪除不在清單裡的 `mopsBackfill` 來源文件＋
   重新同步 BigQuery）清掉，Admin 頁面歷史回補區塊有對應按鈕。
2. **資料來源不可見**：使用者看著涵蓋率月曆問「這個月的資料是哪裡來
   的」——`getFinancialsCoverage` 現在每個月額外回傳 `bySource`
   （`{openapi: N, mopsBackfill: M}`），月曆每格直接顯示
   「OpenAPI X / MOPS Y」，不用再靠下面的隨機抽樣反推猜測。
3. **連線中斷誤報失敗**：回補 9 個月耗時數分鐘（逐月序列請求），使用者
   手機連線中斷，前端把這個連線層級錯誤當「操作失敗」顯示，但後端其實
   有跑完（`jobs/financialsBackfillMops` 照樣被寫成 `succeeded`）。跟
   `AdminView.vue runBackfillNow`（補抓股價區間）已經踩過的同一個坑：
   `FinancialsCoverageCard.vue` 原本把 `internal` 也當「送出就失敗」
   顯示，改成只有驗證類錯誤才顯示，改用 `watch(backfillJob, ...)` 偵測
   job 從 `running` 變成其他狀態時才重新整理涵蓋率/抽樣。
   順便修正手機排版：起訖年月輸入框跟按鈕原本用 `flex-wrap` 擠在同一
   列，iOS Safari 的 `input type="month"` 原生控制項寬度不固定，換行後
   跟按鈕重疊，改成每個欄位各自一整列。

## 2026-10-08：基本面因子接進「今日戰報/回測」即時預測分數

使用者問「可以做啊，因為還是要看回歸跟回測的效果，我再用比較好的」
——回應上面「還沒做的事」那個延遲已久的項目：10 個基本面因子（四率
四升＋月營收連續成長）之前只進了 BigQuery 端的訓練，`computeFactors_`
（JS，即時戰報/回測在用的那支）沒有對應的計算邏輯，套用中的模型如果
LASSO 選中這批因子，權重會被 `computeWeightedFactorScore_` 既有的防呆
邏輯（`config.BQ_FEATURE_TO_ANALYSIS_FIELD` 找不到對應欄位就跳過）悄悄
吃掉，不會出錯但也不會真的貢獻分數。

### 研究先行

先用 Explore agent 盤點現狀，確認三件事：
1. 「BQ 訓練出來的權重 → JS 算分數」這個模式其實已經存在
   （`computeWeightedFactorScore_`／`BQ_FEATURE_TO_ANALYSIS_FIELD`），
   只是只接了原本 10 個基礎因子，不是要從零做。
2. 模型分數目前只影響 `factor_model_rank`／`hybrid` 這兩個策略的進場
   訊號篩選，**不影響預設策略 `rule_v17` 的排序**（那個只看寫死權重
   45/30/15/10 的 `Armor_Score`）——接上這批因子之後，如果使用者平常
   用預設策略，戰報排序不會變，只有另外兩個策略的篩選結果會變。
3. 缺的那塊是「point-in-time 查詢」：BigQuery 那邊用 SQL 相關子查詢
   算「公告日 <= 這一天的最後一期」（見 `buildFundamentalFeatureViewSql_`
   的說明），`computeFactors_` 從來沒拿到過 `financials_quarterly`／
   `financials_monthly` 資料，streak 計算本身已經是純 JS、可以重用
   （`lib/financials.js`），缺的是這段 as-of 查詢邏輯的 JS 版本。

### 架構對應

- `lib/financials.js`（新增純函式）：`buildAsOfIndex_(rows, getDateStr)`
  把一批列依代號分組＋依日期排序，`lookupAsOf_(byCode, code, dateStr)`
  對單一（代號、日期）二分搜尋「日期 <= dateStr 的最後一筆」——跟
  BigQuery 那段 `WHERE report_date <= base.date` 的相關子查詢同一個
  point-in-time 語意，只是換成在記憶體裡對已排序陣列做，不是 SQL。
  查不到（代號不存在、或這檔股票還沒公告過任何財報）回傳 `null`，不會
  退而求其次抓最早一筆——那樣等於用未來的資料回答過去的問題。
- `lib/analysis.js computeFactors_`：新增第三個選填參數
  `financialsIndex`（`{quarterlyByCode, monthlyByCode}`）。帶了這個
  參數，對每一列用 `lookupAsOf_` 查出當下最新一期的毛利率/營益率/
  淨利率/ROE（+ 四個 streak）跟月營收 YoY/連續成長期數，補上
  `Fundamental_*` 這 10 個欄位；不帶（既有呼叫端，例如 parity 測試用
  apps-script 原版比對）完全不補，行為跟加這個參數之前一模一樣——
  刻意不改動既有 38 個因子欄位的計算邏輯，parity 測試原封不動通過。
- `lib/config.js BQ_FEATURE_TO_ANALYSIS_FIELD`：補上這 10 個欄位的
  `fundamental_xxx` → `Fundamental_Xxx` 對照，`computeWeightedFactorScore_`
  從今天起真的會把這批因子的權重算進預測分數。
- `index.js`：新增 `fetchFinancialsAsOfIndex_()`（讀
  `financials_quarterly`／`financials_monthly`，建好 as-of 索引），接進
  `runDailyAnalysis_`（跟 `fetchHistoryRows_`／`fetchPortfolioLots_`／
  `fetchAppliedFactorModels_` 一起平行抓）跟 `loadBacktestFactorRows_`
  （回測也要抓，不然回測結果會因為少算這 10 個因子而跟正式戰報對不
  上）。`lib/reportPipeline.js buildReport_` 多一個選填的
  `financialsIndex` 參數直接轉傳給 `computeFactors_`。

### 已知限制

- **財報資料目前還很稀疏**：季報財務比率只有 Q2 這一期（見「月營收
  歷史回補」那節——季報沒有找到對應的 MOPS 歷史頁面格式，沒辦法像
  月營收一樣回補），大多數股票在大多數交易日查到的
  `Fundamental_*` 欄位會是 `null`（還沒到那期財報的公告日，或那檔
  股票從來沒有過財報資料）。`computeWeightedFactorScore_` 是嚴格
  null 傳播（任一因子缺值，整個預測分數就是 `null`，不是跳過那一項
  繼續加總），所以如果套用中的模型對基本面因子給了不小的權重，現階段
  可能會讓大多數股票的預測分數直接變成 `null`，在 `factor_model_rank`／
  `hybrid` 篩選裡被排除——這是資料本質的限制，不是這次接線邏輯的
  問題，會隨季報資料逐季累積而改善。
- 還是只接了 10 個基本面因子，另外 38 個因子（產業資金流向／動能時機）
  不在這次範圍內，見上方「還沒做的事」。

### 2026-10-08 追加：buildFundamentalFeatureViewSql_ 的 BigQuery SQL 錯誤

使用者實際按「開始訓練」才第一次讓這段 SQL 真正連上 BigQuery 執行
（這個開發環境連不到 BigQuery，部署流程這幾個小時也一直卡在 Cloud Run
配額／IAM 權限問題，見下面兩節，到這之前這段 SQL 從寫出來就沒機會真的
跑過）——結果被 BigQuery 拒絕：

```
Unsupported subquery with table in join predicate.
```

原因：`buildFundamentalFeatureViewSql_`（見「余博邏輯延伸的基本面因子」
一節）原本在 `LEFT JOIN ... ON` 子句裡用相關子查詢直接參照外層 `base`
的欄位（`fr.report_date = (SELECT MAX(...) WHERE fr2.stock_id =
base.stock_id AND fr2.report_date <= base.date)`）——這是 BigQuery
Standard SQL 的已知限制，JOIN 的 ON 子句不支援參照外層資料表的相關
子查詢，在這個開發環境裡沒辦法連線測試，寫的時候沒發現。

修正：改用 `ARRAY_AGG(... ORDER BY report_date DESC LIMIT 1)[OFFSET(0)]`
在獨立的 CTE 裡算「point-in-time 最後一期財報」，JOIN 的 ON 子句只剩
一般的不等式／等值條件，不再有參照外層資料表的相關子查詢——
point-in-time 正確性的語意完全不變（條件還是 `report_date <=
base.date`），只是換一種 BigQuery 支援的寫法表達。

### 2026-10-08 再追加：訓練變成「Input data doesn't contain any rows」

上面那個 SQL 語法錯誤修好、部署上線之後，使用者重新點「開始訓練」，
兩個 label（後續 1 個月報酬率／相對大盤抗跌力）都回報：

```
Input data doesn't contain any rows.
```

原因：`lib/factorRegression.js buildTrainModelSql_` 原本的訓練用
`WHERE` 條件是「`featureColumns` 裡每一欄都要 `IS NOT NULL`」，而
`trainFactorModel_`（index.js）呼叫時傳的 `featureColumns` 是
`config.FACTOR_CANDIDATE_COLUMNS`——這份清單在「余博邏輯延伸的基本面
因子」那次已經把 10 個 `fundamental_*` 欄位 push 進去了。因為財報資料
目前還很稀疏（見上方「已知限制」），絕大多數 `(stock_id, date)` 的
`fundamental_*` 欄位都是 `NULL`，AND 起來的結果幾乎沒有一列能同時滿足
「原本 48 個候選因子都不是 NULL」＋「10 個 fundamental_* 也都不是
NULL」，訓練用的快照表篩完變成 0 筆。

這跟 `ensureFinancialsSyncedToBigQuery_` 註解原本講好的設計矛盾——
那段註解明確說「基本面因子缺資料不影響其他既有候選因子正常訓練」，
但實作上因為用同一個 AND 條件綁死，缺資料反而把全部訓練都擋住，是
實作沒跟上設計意圖的 bug，不是刻意的取捨。

修正：`buildTrainModelSql_` 的 `WHERE` 條件改成排除
`config.FUNDAMENTAL_CANDIDATE_COLUMNS` 裡的欄位，只要求「非基本面
因子」＋label 不是 NULL；`fundamental_*` 欄位繼續留在 `SELECT`
裡當特徵用，但不會因為它是 NULL 就把整列排除掉。BigQuery ML 在
`CREATE MODEL` 沒有 `TRANSFORM` 子句時，數值特徵欄位的 NULL 預設會
自動用該欄位的平均值插補（mean imputation，訓練/預測用同一個訓練時
算出的平均值），不需要自己在 SQL 裡 COALESCE 成某個值——這樣原本 48
個因子的訓練列數不受影響（只排除掉那些原本就會因為
`dividend_yield`／`pe_ratio`／`pb_ratio` 缺值而被排除的少數列，跟
修正前一致），`fundamental_*` 稀疏的部分則讓 BQML 自己處理，不會再
把訓練整批擋光。

已知取捨：現階段 `fundamental_*` 幾乎全部都是用「平均值插補」出來的
常數，LASSO 大概率會給這幾個因子很接近 0 的權重（因為插補值本身沒有
區分度）——這是預期中的過渡狀態，不是 bug，會隨季報資料逐季累積、
真實覆蓋率提高而改善（覆蓋率提高後，插補的比例下降，這幾個因子才有
機會顯示出真正的預測力）。

### 2026-10-08 再追加：mean imputation 本身也失敗——覆蓋率是真的 0

上面那個修正部署上線後，使用者重新點「開始訓練」，兩個 label 都
從「0 筆資料」進展到一個新錯誤：

```
Failed to calculate mean since the entries in corresponding column
'fundamental_gross_margin_pct' are all NULLs.
```

原因：上一個修正假設的是「`fundamental_*` 覆蓋率低，但不是 0」，讓
BigQuery ML 的 mean imputation 處理那些少數缺值的列。但實測發現現在
`financial_ratios` 這張表的資料跟 `factor_features` 的歷史日期範圍
幾乎完全沒有重疊（覆蓋率是真的 0 筆，不是「低」），`fundamental_
gross_margin_pct` 這一整欄在快照表裡沒有任何一筆非 NULL 值——
mean imputation 需要先算出欄位的平均值才能拿去填補 NULL，一整欄全是
NULL 時平均值這個概念根本不存在，BigQuery ML 直接報錯，不是「優雅
退化」成某個預設值。

修正：不再依賴 BigQuery ML 的自動插補，改在 `buildFundamentalFeatureViewSql_`
（`lib/bigquery.js`）的 SELECT 階段直接把 10 個 `fundamental_*` 欄位
COALESCE 成 `0`——跟這支 view 的「上游」`buildFeatureViewSql_`
（`lib/factorRegression.js`）本身既有的慣例一致（`inst_accum_divergence_20d`
缺值 COALESCE 成 0、`days_since_new_low` 缺值 COALESCE 成 0.5），
不管覆蓋率是 0 還是部分覆蓋，這個欄位永遠有具體數值，不會再依賴
BigQuery ML 內部能不能算出平均值。`lib/factorRegression.js
buildTrainModelSql_` 上一次的修正（排除 `fundamental_*` 的 NOT NULL
要求）繼續保留——COALESCE 之後這些欄位本來就不會是 NULL，兩個修正
疊在一起沒有衝突，只是現在 NOT NULL 的排除條件變成不會被真正觸發的
保險，不影響正確性。

已知取捨：COALESCE 成 `0` 對毛利率／營益率／淨利率／ROE 這幾個百分比
欄位來說不是統計意義上的「中性值」（不像其他因子拿 0.5 代表 percentile
rank 的中位數那樣真正中立）——在覆蓋率還是 0 或接近 0 的現階段，這個
選擇基本上等於讓 LASSO 看到「這些因子幾乎是常數 0」，迴歸權重會趨近
於 0，等於暫時學不到這幾個因子的預測力。這跟上一次修正預期的「過渡
狀態」是同一個結論，只是現在的覆蓋率比原本估計的更糟（原本以為至少
有 Q2 那一期能跟近期的 `date` 重疊，實際上沒有）——會隨財報資料
實際累積、`financial_ratios`／`financial_revenue` 跟 `factor_features`
的日期範圍開始重疊而自然改善，不需要再改程式碼。

## 2026-10-08：因子檢視器（排查因子覆蓋率問題用的診斷工具）

上面三次修正都是靠使用者實測回報的錯誤訊息＋我這邊猜測原因、翻 deploy
log 才定位出來的——使用者提出一個合理的疑問：「月營收是月頻、股價是
日頻，兩者到底是怎麼整合的」，點出「覆蓋率是 0」這個結論本身也只是
推測，沒有直接證據。既然沒辦法從這個開發環境連線查 BigQuery／Firestore
確認，不如直接做一個工具讓使用者自己查：選一檔股票、一段區間，一次看
三組資料：

1. **計算後因子值**：BigQuery `factor_features_fundamental` view 裡這檔
   股票在區間內逐日算出來的全部因子值（48 個既有候選因子＋10 個財報
   基本面因子）——直接回答「這天這個因子到底是不是 NULL、算出來是
   多少」，不用自己回算或猜測。
2. **原始財報資料**：Firestore `financials_quarterly`／
   `financials_monthly` 裡這檔股票全部累積的原始列（不限查詢區間，筆數
   本身不多，直接給全部）——讓使用者自己對照「最近一期財報的公告日」
   是不是真的落在查詢區間附近，不然光看區間內的因子值看不出「到底是
   沒資料，還是查詢區間剛好沒蓋到」。顯示的「連續上升期數」
   （`grossMarginStreak`／`roeStreak`／`revenueGrowthStreak`）是即時用
   `lib/financials.js computeFundamentalStreaks_`／
   `computeRevenueGrowthStreaks_` 對這檔股票重算一次，不是 Firestore
   原始公告列本來就有的欄位（那兩支函式算完只同步進 BigQuery
   `financial_ratios`／`financial_revenue`，沒有寫回 Firestore，見
   `doRefreshFinancials_` 的說明）——這裡顯示的數字跟訓練/因子計算
   實際用到的是同一份，不是只有原始公告值。
3. **原始股價/籌碼資料**：區間內原始 History 列（收盤價／外資／投信／
   自營商／成交股數／殖利率／本益比／股價淨值比），對照「算出來的
   因子」跟「背後真正的原始資料」。

**實作**：
- 後端新增 `lib/factorInspector.js`（純函式：`validateFactorInspectorRange_`
  驗證查詢區間上限 365 天、`sortFinancialDocsByDate_` 把財報列依日期
  排序）＋ `lib/bigquery.js buildFactorDetailSql_`（查單一股票＋區間的
  因子值，`SELECT * FROM factor_features_fundamental WHERE stock_id = ?
  AND date BETWEEN ? AND ?`）＋ `buildHistoryRowsForCodesSql_` 補一個
  選填的 `endStr` 上界（原本只能「從某天開始」查到今天，因子檢視器需要
  限制在使用者指定的區間內）＋新的 `exports.getStockFactorDetail`
  callable function（跟訓練前一樣先 `ensureFeatureView_`／
  `ensureFundamentalFeatureView_` 確保 view 是最新定義）。
- 前端在 Research 頁面新增「🔍 因子檢視器」卡片：股票搜尋（重用既有的
  `searchStockCodes`）＋起訖日期，查詢後顯示上述三組表格。因子欄位名稱
  不在前端另外手刻一份清單（避免跟後端 `config.js
  FACTOR_CANDIDATE_COLUMNS` 兩邊維護逐漸對不齊），直接從回傳的第一列
  自己的欄位順序推出要顯示哪些欄。

**實作細節**：BigQuery 的 `date` 欄位是真正的 DATE 型態（這支 App 其他
地方查的 `date_str` 都是 STRING，這是唯一例外），`@google-cloud/bigquery`
client 讀回來是 `BigQueryDate` 物件（`{ value: 'yyyy-MM-dd' }`，實測
`JSON.stringify` 印出來不是乾淨的字串），直接回傳給前端不保證序列化
正確，後端明確取出 `.value` 再回傳。

唯讀查詢，不寫入或改動任何資料，不用 `jobs/{jobKey}` 監聽模式，一次
`callFn` 直接拿結果即可。

## 2026-10-08：擴大 LIGHT_RUNTIME_OPTS_ 適用範圍（依實際用量重新分級）

今天的部署反覆撞上「Quota exceeded for total allowable CPU per project
per region」——這個專案在 `us-central1` 的 Cloud Run CPU 配額硬上限是
20,000 milli vCPU（20 顆），申請提高被 GCP 拒絕。`LIGHT_RUNTIME_OPTS_`
原本的適用規則是「只套用在真的單純讀寫 Firestore、不碰 BigQuery／外部
API／LLM 的函式上」——這是「碰不碰 BigQuery」的粗略二分法，不是真的
照每支函式實際查詢的資料量判斷。用這條規則重新部署全部函式時，一次
部署會「修好一批、同時撞壞另一批」（像打地鼠），因為大多數函式（含
一堆單純讀寫一兩筆 Firestore 文件的 CRUD）預設都吃滿 1 vCPU，20 幾支
函式疊起來遠超過 20 vCPU 的上限。

使用者要求「依據實際用量給予最適配置」，重新檢查每一支還在用
`RUNTIME_OPTS_`（1 vCPU）的函式實際查詢/處理的資料量，把其中 9 支改成
`LIGHT_RUNTIME_OPTS_`（0.25 vCPU）——這 9 支雖然會查 BigQuery 或打 TWSE
OpenAPI，但資料量都是有界的小量，跟「算戰報」（150 天 × 全市場
150~290 萬列）或「回測/因子掃描」（可能讀全部歷史）完全不是同一個
量級：

- `getHistoryOverview`／`getHistoryDailyCounts`：BigQuery 聚合查詢，
  Node 端只收到幾十列彙總結果。
- `getStockDetail`／`getStockFactorDetail`：只查單一檔股票（240／365
  天上限）。
- `searchStockCodes`：只查最近 10 天、3 欄、`LIMIT 500`。
- `runIndustryMapRefresh`：全市場公司基本資料（一千多~兩千列）＋只讀
  「最新一天」的 History 比對涵蓋率。
- `runFinancialsRefresh`：TWSE OpenAPI 三個「最新一期」全市場快照＋讀回
  目前累積的 `financials_monthly`／`financials_quarterly`（實測約
  8700／1000 筆）。
- `runManualHistoryFetch`：單一天的 TWSE 三端點合併。
- `cleanupFinancialsNonListedCodes`：掃過 `financials_monthly`（同上）
  篩選＋批次刪除。

9 支從 1 vCPU 降到 0.25 vCPU，加總讓出約 6.75 vCPU 的配額餘裕。其他真的
會把大量資料整批拉進 Node 記憶體、或要重算 rolling window 的函式
（`generateDailyReport` 系列、`runBacktest` 系列、`runFactorRegression`、
`runFactorCorrelationScan`、`runHistoryBackfill`、
`runFinancialsBackfillMops`、三支 AI 診斷）維持不動——這個開發環境沒辦法
實際部署驗證冷啟動／尖峰用量，沒把握的情況下不賭更激進的數字。

## 2026-10-08：因子迴歸訓練成功後，套用模型跑回測卻完全沒有訊號

訓練終於成功、套用其中一版模型後，使用者跑「一次跑全部策略比較」，
`rule_v17` 正常跑出 2556 筆訊號，但 `factor_model_rank`／`hybrid` 兩個
用到因子迴歸模型的策略都回報「這段區間內沒有符合...進場條件的訊號」
——不是報錯，是整個區間、整個市場一筆訊號都沒有。

根因在 `lib/factorModel.js computeWeightedFactorScore_`：這支函式（從
apps-script/src/FactorRegression.gs 原樣複製，apps-script 版從沒出過
事）的既有設計是「權重清單裡任何一個因子的值是 null，整個預測分數就是
null」——避免「悄悄把缺值當成 0 貢獻」讓分數看起來比實際更可信。這個
設計本身沒錯，但有一個沒想到的邊界情況：`lib/factorRegression.js
buildWeightsSql_` 用的 `ML.WEIGHTS` 會把**權重剛好是 0** 的因子也列進
結果（LASSO 只是把係數壓到 0，不會把那一列從輸出拿掉），所以套用中的
`weights` 物件裡還是會有這些 key。今天新加的 10 個 `fundamental_*`
財報因子目前覆蓋率近乎 0（見上面好幾節的說明），LASSO 訓練出來幾乎
必然是精確的 0 權重——但 `computeWeightedFactorScore_` 原本不管權重是
多少，只要值是 null 就整個否決，於是幾乎每一列都因為這幾個「權重是 0
但值是 null」的新因子被否決掉，不是模型真的判斷每一檔股票都不該進場。

修正：`computeWeightedFactorScore_` 改成只在 `weights[bqName] === 0`
時才跳過 null 檢查——這不是放寬「悄悄假設缺值貢獻為 0」的風險（那段
風險的前提是權重不是 0，缺值被當成 0 貢獻才會把分數算得比實際更可信），
權重真的是 0 時，這個因子不管值是多少（包括缺值）對加總的貢獻本來就
一定是 0，「跳過它」跟「用它的真實值去乘」在數學上是同一個結果，沒有
被低估的問題。其他權重不是 0 的因子維持原本「缺值就整個否決」的保守
邏輯完全不變。新增 `test/factorModel.test.js`（這支函式之前只在
`analysis.test.js` 裡間接測過一次，沒有獨立的測試檔案）覆蓋這個邊界
情況＋原有的保守行為，確認沒有被這次修正削弱。

## 2026-10-08 再追加：套用模型後還是零訊號——權重不是精確的 0

上面那個修正部署上線、使用者套用新模型重新跑回測後，`factor_model_rank`／
`hybrid` 仍然整個區間零訊號，完全沒有改善。

用因子檢視器查台積電（2330）才先確認了一件事（使用者直接問「四率四升
是用公告日還是所屬月份/季度串」）：季報 `period`（公告日）是
`2026-10-08`，回測區間（8/19~10/08）裡只有最後一天 `fundamental_*`
欄位是真實數值，前面全部是 `0`——用的確實是公告日 `<=` 查詢日，不是
拿季度/月份本身對齊，符合設計；但也直接證實了覆蓋率比原本想的更集中
在資料區間的尾端，幾乎整個回測窗口都是常數 `0`。

重新檢查上一個修正才發現問題：`buildTrainModelSql_` 指定的
`optimize_strategy='BATCH_GRADIENT_DESCENT'`——這是梯度下降法，不是
封閉解的座標下降法／ISTA，L1 正規化把「零資訊」因子的係數壓到接近 0
通常不會是精確的 `0.0`，而是一個很小但不是 0 的浮點數（例如
`0.0000003`）。上一個修正的判斷條件是 `weights[bqName] === 0`（精確
相等），抓不到這種「很小但不是 0」的浮點數，於是跟修正前一樣，這幾個
因子的 null 值還是把整個分數否決掉。

修正：改成 `Math.abs(w) < NEGLIGIBLE_WEIGHT_EPSILON_`（門檻定為
`1e-6`）就跳過 null 檢查，順便一起把 `isNaN(w)` 也視為可忽略（零變異
欄位在某些數值流程下可能產生 `NaN` 權重，不管乘上什麼值都只會污染
`sum` 變成 `NaN`，跟「這個因子沒有可用資訊」是同一個結論）。`1e-6`
這個門檻取得比其他有實際訊號的因子（`bias60`／`inst_part_ma5` 等，
R² 看得出模型確實從它們學到東西，量級明顯更大）小很多，不會不小心
把真的有一點訊號的因子也放寬過去。`test/factorModel.test.js` 補上
「權重極小但不是精確 0」「NaN 權重」「權重大於門檻仍要否決」三組案例。

## 2026-10-09 再追加：真正的根因——訓練候選因子跟即時計算支援範圍沒對齊

上面兩次修正（`=== 0` 精確比對、`Math.abs(w) < epsilon`）部署上線後，
使用者套用新模型重新跑回測，`factor_model_rank`／`hybrid` 仍然整個
區間零訊號，完全沒有改善——這代表問題從一開始就不是「缺值 null 否決」
這個方向，兩次修正都在修一個不是真正根因的症狀。

請使用者用 Cloud Shell 直接查 Firestore REST API 看目前套用中模型的
實際權重數值（`curl` + `gcloud auth print-access-token` + `jq`，不用
在 Console UI 裡找）才挖到真正的根因：`lib/config.js` 的
`BQ_FEATURE_TO_ANALYSIS_FIELD`（因子迴歸權重 → 即時計算欄位的對照表）
只有 20 個因子（10 個基礎因子＋10 個財報因子），完全不包含「36 個
產業資金流向/相對大盤強度因子」跟 `inst_accum_divergence_20d`／
`days_since_new_low`——這是「余博邏輯延伸的基本面因子」那次我自己
寫的註解就承認的已知限制（"這兩個因子的算法...不是 computeFactors_
目前會算的量...獨立於訓練之外的下一步工作"），但當時低估了這個限制
的後果有多嚴重。

`lib/factorModel.js computeWeightedFactorScore_` 遇到沒有對照表的
因子會直接 `continue`（跳過，不管權重多大）。使用者套用的
`downsideResistance` 模型，「關鍵影響因子」裡 5 個有 4 個
（`industry_rel_mkt_dealer_20d`／`industry_flow_all_30d`／
`industry_flow_all_60d`／`industry_rel_mkt_foreign_20d`）正好都屬於
這個被跳過的群組——模型真正學到的預測力，大部分在即時計算這一端被
整個忽略，只剩少數剛好落在這 20 個裡的因子還有效，預測分數在全市場
幾乎擠在一起，排名永遠衝不到 `factor_model_rank` 要求的前 10%。這不是
財報因子那次才出現的問題，是 `factor_model_rank`／`hybrid` 這兩個
策略從加進 Firebase 版以來，從沒真的被一個「權重大部分落在產業因子上」
的模型完整驗證過——R² 看起來正常（訓練/評估本身沒問題），只有套用
後在回測/戰報才會暴露這個落差。

**選擇：小範圍修正（已採用），不是完整把 38 個因子接進
`computeFactors_`**（那個工作量大，要先把橫斷面百分位排名、依產業
分組的資金流向等邏輯對照 BigQuery `buildFeatureViewSql_` 在 JS 端
重新實作一次，風險跟工時都不小，今天不適合一次做完）。改成訓練時
把候選因子限制在 `config.js` 新增的 `LIVE_SCORED_FACTOR_CANDIDATE_COLUMNS`
（直接用 `Object.keys(BQ_FEATURE_TO_ANALYSIS_FIELD)` 算出來，不是另外
手刻一份清單，兩邊永遠自動同步，之後 `BQ_FEATURE_TO_ANALYSIS_FIELD`
加新因子這份清單自動跟著變）——`lib/factorRegression.js
buildTrainModelSql_` 收到的候選因子從 58 個降到 20 個，LASSO 不會再
把權重放到即時計算端用不到的因子上。已知取捨：訓練出來的模型喪失
產業資金流向這塊的預測力（之前「關鍵影響因子」裡那些 `industry_*`
因子以後不會再出現），換來訓練出來的每一個因子權重，回測/戰報都保證
用得上，不會再有「訓練分數看起來不錯、套用後卻完全沒有訊號」的落差。
`test/parity.test.js` 補上斷言確認這份清單等於
`BQ_FEATURE_TO_ANALYSIS_FIELD` 的 key、長度剛好 20、且都是完整候選
清單的子集。

要把產業資金流向因子重新納入訓練範圍，必須先完成「完整修正」那個
選項（把這 36+2 個因子接進 `computeFactors_`），不是這次範圍內的
工作，記錄在這裡供之後規劃。
