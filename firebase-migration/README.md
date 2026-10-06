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
  **目前只有「💼 持股庫存」是可以點的**，其他三個顯示「這個頁面還沒遷移」
  的占位訊息——不是漏做，後端邏輯（戰報的 AI 診斷/job 輪詢、策略研究、
  系統後台那些）還沒遷移完，先讓使用者清楚知道要去舊版用，不要讓畫面
  看起來像壞掉。
- `frontend/src/components/portfolio/` — 持股庫存頁面，對照舊版
  `Index.html` 持股庫存分頁底下的三個 sub-tab：
  - `PortfolioView.vue`：sub-tab 切換（持有中／👀 觀察個股／💰 歷史結案紀錄）。
  - `HoldingList.vue`：呼叫 `getPortfolio`／`savePortfolioItem`／
    `deletePortfolioLot`／`closePortfolioPosition`，卡片+新增/編輯表單+
    平倉表單。
  - `WatchlistList.vue`：呼叫 `getWatchlist`／`addToWatchlist`／
    `removeFromWatchlist`。
  - `ClosedHistoryList.vue`：呼叫 `getClosedPortfolioHistory`，純讀取表格。
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

⚠️ 這幾步都還沒有在這個開發環境實際跑過（沒有真正的 Firebase 專案、
瀏覽器環境），只做到 `npm run build` 編譯成功（`vite build` 過，33 個
模組、無錯誤）——跟 `functions/` 的 `index.js` 一樣，真正「接線接得對
不對」要部署後用真實瀏覽器驗證才能確認。
