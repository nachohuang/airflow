# Firestore Schema — TWSE 選股引擎

Phase 1 產出。對照〈選股引擎遷移藍圖〉§04，把現有 12 張 Sheets 的欄位定義，翻成
Firestore collection／document 結構。欄位型別是 Firestore 原生型別（`string` /
`number` / `boolean` / `timestamp` / `map` / `array`），不是 Sheets 儲存格裡的字串。

現況欄位定義的權威來源：`apps-script/src/Config.gs`（本文件寫作時的欄位順序、
命名，都是照那份檔案抄的，改了 Config.gs 記得回來同步這份文件）。

---

## 資料庫分工（跟遷移藍圖 §02／§04 一致）

- **Firestore**：OLTP 型、需要即時讀寫的資料——持股、觀察清單、AI 診斷、設定、
  背景工作狀態。
- **BigQuery（不動）**：History 時序資料、RunLog／AiUsage／BigQueryUsage 這類
  append-only 記錄。
- **Secret Manager**：Anthropic／Gemini API 金鑰。

---

## 1. `watchlist/{code}` ← Sheet `Watchlist`

本次 Phase 2 spike 的遷移對象，欄位最少、邏輯最單純。

| 欄位 | 型別 | 對應 Sheets 欄位 | 備註 |
| :-- | :-- | :-- | :-- |
| `code` | `string` | 證券代號 | 4 碼，`zfill4` 補零；同時也是文件 ID |
| `name` | `string` | 證券名稱 | 可為空字串 |
| `addedDate` | `string` (`YYYY-MM-DD`) | 加入日期 | 沿用現有 `normalizeDateStr` 格式，不用 Firestore `timestamp`——現有程式碼全部用日期字串比較/排序，型別換了要動的呼叫端太多，先維持字串 |
| `note` | `string` | 備註 | 可為空字串 |
| `migratedAt` | `timestamp` | — | 遷移時間戳記，只在遷移時寫入，方便事後追查是哪一批匯入的 |
| `migratedFrom` | `string` | — | 固定值 `"sheets:Watchlist"` |

文件 ID：`code`（例如 `watchlist/0330`）。跟現行 `addToWatchlist()` 的「同一檔
股票重複加入就地更新，不新增第二列」邏輯天然一致——Firestore 的 `set()` 用同一
個文件 ID 呼叫本來就是覆蓋語意，不用像 Sheets 版那樣自己找列、判斷要不要新增。

**跟持股庫存互相檢查重複**（見 `AiDiagnosis.gs`/`Portfolio.gs` 現行邏輯）在
Firestore 版本一樣要在 Cloud Function 層做，Firestore Security Rules 沒辦法
表達「這個文件不能存在，如果另一個 collection 有對應文件」這種跨 collection
的條件，這條業務邏輯必須留在後端函式裡，不能只靠規則擋。

**索引**：目前只有依 `addedDate` 排序（新到舊）這個查詢模式，Firestore 對單一
欄位排序不需要額外建複合索引。

---

## 2. `portfolio_lots/{transactionId}` ← Sheet `Portfolio`

| 欄位 | 型別 | 對應 Sheets 欄位 |
| :-- | :-- | :-- |
| `transactionId` | `string` | 交易ID（沿用既有 UUID，當文件 ID） |
| `code` | `string` | 證券代號 |
| `name` | `string` | 證券名稱 |
| `buyDate` | `string` (`YYYY-MM-DD`) | 買進日期 |
| `buyPrice` | `number` | 買進價格 |
| `shares` | `number` | 股數 |
| `note` | `string` | 備註 |
| `status` | `string`（`"holding"` \| `"sold"`） | 狀態（原文字「持有中」/「已賣出」，遷移時翻成英文列舉，前端顯示層再轉回中文，避免字串比對散落在到處都是中文字面值） |
| `sellDate` | `string` \| `null` | 賣出日期 |
| `sellPrice` | `number` \| `null` | 賣出價格 |

文件 ID：`transactionId`。

**索引**：需要「依 `code` 分組、只看 `status == "holding"`」這個複合查詢
（`getPortfolioMap_()`／`getPortfolio()` 現行邏輯），要建 `(code, status)` 複合
索引。

---

## 3. `reports/{date}/signals/{code}` ← Sheet `Reports`

戰報是每天重算的衍生資料，用子集合依日期分組，查「今天戰報」就是
`reports/{today}/signals` 整個 collection，不用像現在 Sheets 版本掃全表再篩日期。

| 欄位 | 型別 | 對應 Sheets 欄位 |
| :-- | :-- | :-- |
| `date` | `string` | 日期（跟父文件 ID 重複存一份，方便 collectionGroup 查詢） |
| `code` | `string` | 證券代號 |
| `name` | `string` | 證券名稱 |
| `armorScore` | `number` | Armor_Score |
| `strategy` | `string` | 操作策略 |
| `action` | `string` | 建議動作 |
| `interpretation` | `string` | 實相解讀 |
| `trendScore` | `number` | Trend_Score |
| `instPartRank` | `number` | Inst_Part_Rank |
| `ibf20dRank` | `number` | IBF_20D_Rank |
| `monitorUrl` | `string` | 監控連結 |
| `referenceHigh` | `number` \| `null` | 參考最高價 |
| `predictedReturn1m` | `number` \| `null` | 因子模型_預測1月報酬 |
| `predictedDownsideResistance` | `number` \| `null` | 因子模型_預測抗跌力 |

**不強求遷移歷史列**：Reports 是可重算的衍生資料，遷移當天用新管線重跑一次
`runAnalysisAndSave()` 即可產生最新一份，舊歷史留在 Sheets 存檔查閱，不用逐筆
搬過去。

---

## 4. `ai_diagnosis/{code}_{date}_{diagnosisType}` ← Sheet `AiDiagnosis`

| 欄位 | 型別 | 對應 Sheets 欄位 |
| :-- | :-- | :-- |
| `date` | `string` | 日期 |
| `code` | `string` | 證券代號 |
| `name` | `string` | 證券名稱 |
| `armorScore` | `number` \| `null` | Armor_Score |
| `strategy` | `string` | 操作策略 |
| `verdict` | `string` | 最終建議 |
| `diagnosisType` | `string`（`"deep"` \| `"hold"` \| `"top3"`） | 診斷類型（原文字「深度診斷」/「持股續抱診斷」/「TOP3推薦」，同 Portfolio 的 status 欄位，遷移時翻成英文列舉） |
| `content` | `string` | 診斷內容（含 Markdown，直接整段存） |
| `timestamp` | `string` | 時間戳記（沿用現有「台股監控 yyyy-MM-dd HH:mm」格式的顯示字串，不拆成 timestamp 型別——這欄本來就是給人看的展示字串，不是用來排序比對的） |

文件 ID：`{code}_{date}_{diagnosisType}`（直接沿用現行 `aiDiagnosisRowKey_()` 的
比對鍵組成，用底線串接），upsert 語意完全對應現行「代號+日期+診斷類型撞鍵就整份
重寫」的邏輯——Firestore 版本變成單純的 `set()`，不用再判斷要 append 還是整份
重寫（`createAiDiagnosisBatchUpserter_` 這整支的複雜度在 Firestore 版本會直接
消失）。

**索引**：依 `code` 查全部歷史診斷（`getAiDiagnosisHistoryForCode`）需要
`code` 單欄索引（Firestore 自動建立），依 `code` + `diagnosisType` 篩選需要
複合索引。

---

## 5. `skip_dates/{date}` ← Sheet `SkipDates`

| 欄位 | 型別 |
| :-- | :-- |
| `date` | `string` |
| `reason` | `string` |

文件 ID：`date`。

---

## 6. `industry_map/{code}` ← Sheet `IndustryMap`

| 欄位 | 型別 |
| :-- | :-- |
| `code` | `string` |
| `name` | `string` |
| `industry` | `string` |
| `market` | `string` |
| `updatedAt` | `number`（epoch ms） |

文件 ID：`code`。靜態參考資料，很少變動，可以整批覆蓋式匯入
（`ensureIndustryMapSyncedToBigQuery_` 現行邏輯本來就是整批重新整理，直接照搬）。

2026-10-08：Phase 2 當時只是把舊 Sheets 的歷史資料一次性遷進來，`updatedAt`
欄位（跟 `migratedAt`／`migratedFrom` 不同）是之後才加的——現在
`functions/index.js exports.runIndustryMapRefresh` 已經接手這張表的
刷新（整份覆蓋，刪掉這次沒出現的舊文件），見
`firebase-migration/README.md`「策略研究（二）——IndustryMap.gs 產業對照表
遷移到 Firebase」一節。這張表同時也會同步一份到 BigQuery 的
`industry_map` 表（`stock_id`／`industry` 兩欄），給還沒遷移的
`FactorRegression.gs` 因子特徵 view JOIN 用——Firestore 版跟 BigQuery
版是兩份獨立的資料（前者給 Admin 頁面顯示，後者給 BigQuery 查詢用），
刷新時一起更新。

---

## 7. `factor_model_history/{docId}`

結構對應 apps-script 版 `FACTOR_MODEL_COLUMNS`（英文化欄名，見下表），
文件 ID 用 `timestamp`＋`labelKey` 組出來（`lib/factorRegression.js
buildFactorModelDocId_`，Phase 2 一次性遷移腳本跟 2026-10-08 之後新訓練
出來的資料共用同一套公式）。

| 欄位 | 型別 |
| :-- | :-- |
| `timestamp` | `string`（`'YYYY-MM-DD HH:mm:ss'`，台北時間） |
| `labelKey` | `string`（`'return1m'` \| `'downsideResistance'`） |
| `l1Reg` | `number` |
| `featureColumns` | `string[]`（候選因子欄位名稱清單） |
| `trainRows` | `number` \| `null`（apps-script 版本身也沒有真的填這欄，照原樣保留） |
| `r2` | `number` \| `null` |
| `weights` | `{[bqFeatureName]: number}` |
| `status` | `string`（`'完成'` 或 `'失敗：...'`） |
| `applied` | `boolean` |

2026-10-08：寫入端（`exports.runFactorRegression`／`exports.applyFactorModel`，
見 `firebase-migration/README.md`「策略研究（四）——FactorRegression.gs
因子迴歸模型訓練遷移到 Firebase」一節）已經遷移完成，這張表現在是
「讀寫都在 Firebase」的正式表，不再只是 Phase 2 一次性遷移過去的唯讀
歷史資料。

原本列在這裡的 `factor_scan_results/{runId}`／`backtest_results/{runId}`
**都不需要建立**——apps-script 版的 `FactorScan.gs`／`Backtest.gs` 本身
都沒有把結果持久化到 Sheet（回測結果存在 Script Properties 的背景 job
狀態，跑完下一次就覆蓋；因子掃描更單純，直接把結果回傳給前端，從來沒有
寫過任何 Sheet），Firebase 版分別用 `jobs/backtest`／`jobs/factorScan`
（同樣每次覆蓋，不是歷史紀錄）維持跟原本行為一致，見
`firebase-migration/README.md`「策略研究（一）——Backtest.gs 回測功能
遷移到 Firebase」一節。

---

## 8. `config/app`（單一文件）← PropertiesService 裡跟排程/AI 有關的設定

| 欄位 | 型別 | 對應 PROP_KEYS |
| :-- | :-- | :-- |
| `triggerHour` / `triggerMinute` | `number` | TRIGGER_HOUR / TRIGGER_MINUTE |
| `skipWeekends` | `boolean` | SKIP_WEEKENDS |
| `aiProvider` | `string` | AI_PROVIDER |
| `aiDailyEnabled` | `boolean` | AI_DAILY_ENABLED |
| `aiDailyTopN` | `number` | AI_DAILY_TOP_N |
| `pricing` | `map` | CLAUDE_PRICE_INPUT/OUTPUT、GEMINI_PRICE_INPUT/OUTPUT |
| `bigQuery` | `map` | BIGQUERY_PROJECT_ID / DATASET / SOURCE_MODE / PRICE_PER_TB |
| `screeningStrategy` | `string` | SCREENING_STRATEGY |

**API 金鑰（ANTHROPIC_API_KEY／GEMINI_API_KEY）不放在這裡**——進 Secret
Manager，Cloud Functions 執行時用 IAM 權限讀取，永遠不進 Firestore、不進任何
client 端看得到的地方。

---

## 9. `jobs/{jobKey}`（10 個固定文件，取代 10 種背景工作各自的 PROP_KEYS）

| jobKey | 對應現行 PROP_KEYS |
| :-- | :-- |
| `backfill` | BACKFILL_JOB_STATE |
| `analysis` | ANALYSIS_JOB_STATE |
| `factorRegression` | FACTOR_REGRESSION_JOB_STATE |
| `materialize` | MATERIALIZE_JOB_STATE |
| `backtest` | BACKTEST_JOB_STATE |
| `aiTask` | AI_DIAGNOSIS_JOB_STATE |
| `industryMap` | INDUSTRY_MAP_JOB_STATE |
| `dailySchedule` | DAILY_SCHEDULE_JOB_STATE |
| `scheduleResume` | SCHEDULE_RESUME_JOB_STATE |
| `watchdog`（新增，記錄安全網自己最近一次執行結果，方便除錯） | — |

欄位結構跟現行 job state 的 JSON 形狀（`status` / `stepIndex` /
`overallStartedAt` / `updatedAt` / `errorMessage` …）幾乎可以照搬，差別是
Firestore 版本前端改用 `onSnapshot` 監聽這個 collection，不用再 4 秒輪詢一次
`getJobQueueOverview()`。

---

## 10. `financials_monthly/{code}_{period}`、`financials_quarterly/{code}_{period}`

2026-10-08 新增——余博邏輯延伸的基本面因子（四率四升＋月營收連續成長）
資料來源，apps-script 版沒有對應的 Sheet，完全是這次 Firebase 版新增的
collection，見 `firebase-migration/README.md`「余博邏輯延伸的基本面
因子」一節的完整架構說明。

`financials_monthly/{code}_{period}`（`period` 是 `'yyyy-MM'`）：

| 欄位 | 型別 |
| :-- | :-- |
| `code` | `string` |
| `name` | `string` |
| `period` | `string`（`'yyyy-MM'`） |
| `reportDate` | `string`（`'yyyy-MM-dd'`，公開可得日期） |
| `reportDateIsEstimated` | `boolean`（`true`＝沒偵測到官方「出表日期」欄位或是 MOPS 回補來源，`reportDate` 是估算值） |
| `revenue` | `number` \| `null` |
| `revenueYoyPct` | `number` \| `null` |
| `revenueGrowthStreak` | `number` \| `null` |
| `source` | `string`（`'openapi'` \| `'mopsBackfill'`，2026-10-08 新增，見 README「月營收歷史回補」一節） |
| `updatedAt` | `number`（epoch ms） |

`financials_quarterly/{code}_{period}`（`period` 是 `'yyyy-MM-dd'`，
官方公告日，不是季度期末日或所屬季度——詳見 README 的「點對點正確的
JOIN」說明）：

| 欄位 | 型別 |
| :-- | :-- |
| `code` | `string` |
| `name` | `string` |
| `period` | `string`（`'yyyy-MM-dd'`，公告日） |
| `fiscalPeriod` | `string`（`'yyyy-Qn'`，財報所屬季度，可能是估計值） |
| `fiscalPeriodIsEstimated` | `boolean` |
| `revenue`／`grossProfit`／`operatingIncome`／`netIncome` | `number` \| `null` |
| `grossMarginPct`／`operatingMarginPct`／`netMarginPct`／`roePct` | `number` \| `null` |
| `grossMarginStreak`／`operatingMarginStreak`／`netMarginStreak`／`roeStreak` | `number` \| `null` |
| `updatedAt` | `number`（epoch ms） |

兩張表都是**累積寫入**（`merge: true`，不是整份覆蓋）——跟這份文件其他
「靜態參考資料／整份覆蓋」的表不同，因為 TWSE 來源端點很可能只回傳
「目前最新一期」，要算連續上升期數就必須跨多次「重新整理財報因子」
累積歷史，見 README 的完整說明。同步到 BigQuery 的 `financial_ratios`／
`financial_revenue` 表才是「目前累積到的完整結果」整份覆蓋快照，兩層
職責不同，不要搞混。

---

## 尚未涵蓋

`Reports`／`AiDiagnosis` 的**歷史**資料遷移策略（只遷移最新一天還是連歷史都搬）
留給 Phase 3 跟後端邏輯一起決定，因為要看 Cloud Functions 版的
`runAnalysisAndSave()` 重寫完之後，重算歷史戰報的成本高不高，再決定要不要
花力氣把舊資料也搬過去，或者乾脆讓 Sheets 版留著當歷史檔案查閱就好。
