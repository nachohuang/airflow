/**
 * index.js
 * Cloud Functions 進入點：把 lib/ 底下已經驗證過的純運算（lib/analysis.js／
 * lib/reportPipeline.js 等）接上真正的 I/O——讀 BigQuery 的 History（不動，
 * Phase 2 的結論是這張表留在 BigQuery，見 README「每天累積的股價及市場資料
 * 在哪裡遷移」）、讀 Firestore 的 `portfolio_lots`／`config/app`（Phase 2
 * 已經遷移完成的資料）跟 `factor_model_history`（Phase 3 跟後端邏輯一起
 * 遷移，`hybrid`/`factor_model_rank` 策略需要），算完寫進 Firestore
 * `reports/{date}/signals/{code}`（對照 firestore/schema.md §3）。
 *
 * 設計選擇：History 改成抓「最近 ANALYSIS_LOOKBACK_DAYS 天、全市場」的原始
 * 列，在這裡用已經跟 Apps Script 版 parity 驗證過的 lib/analysis.js
 * computeFactors_ 算因子，不是把 apps-script/src/BigQuerySync.gs 的
 * buildLatestDayFactorsSql_（整套 rolling 因子邏輯另外重刻一次成 BigQuery
 * window function SQL）也搬過來。理由：那支 SQL 存在的原因是 Apps Script
 * 的 V8 執行環境記憶體上限扛不住「150 天 x 全市場」的原始資料量，但 Cloud
 * Functions 預設就有更高的記憶體/執行時間上限，不需要为了同一個限制再維護
 * 第二套獨立實作（SQL 版）的因子計算邏輯——兩套算法各自都要驗證正確性，
 * 徒增風險，不如只信任已經被 parity.test.js 驗證過的那一套。
 *
 * ⚠️ 這支檔案牽涉真正的 BigQuery／Firestore 連線，這個開發環境沒有對應的雲端
 * 憑證，沒辦法在這裡實際執行驗證——跟 Phase 2 遷移工具的驗證模式一樣，需要
 * 部署到真正的 Firebase 專案、用 Cloud Shell 或本機憑證跑一次才能確認可以
 * 正常運作。lib/ 底下的計算邏輯本身已經靠 test/ 的單元測試跟 parity 測試
 * 驗證過，這支檔案要驗證的只是「接線有沒有接對」，不是「算得對不對」。
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { BigQuery } = require('@google-cloud/bigquery');

const config = require('./lib/config');
const bigquery = require('./lib/bigquery');
const reportPipeline = require('./lib/reportPipeline');
const portfolio = require('./lib/portfolio');
const watchlistLib = require('./lib/watchlist');
const portfolioOpsLib = require('./lib/portfolioOps');
const utilsLib = require('./lib/utils');
const stockDetailLib = require('./lib/stockDetail');
const scheduleLib = require('./lib/schedule');
const aiDiagnosisLib = require('./lib/aiDiagnosis');
const aiUsageLib = require('./lib/aiUsage');

admin.initializeApp();

/** Firestore `config/app` 文件——screeningStrategy 跟 bigQuery 連線設定都從這裡讀，
 *  不在這支檔案裡另外猜測/硬寫任何一個值。文件不存在代表 Phase 2 的 config/app
 *  遷移還沒做，直接丟明確的錯誤，不要用猜的預設值悄悄跑下去。 */
async function fetchAppConfig_() {
  const snap = await admin.firestore().collection('config').doc('app').get();
  if (!snap.exists) {
    throw new Error('Firestore 裡找不到 config/app 文件，請先完成 Phase 2 的 config/app 遷移（見 firebase-migration/README.md）。');
  }
  return snap.data();
}

/** Firestore `portfolio_lots` collection 全部文件——buildPortfolioMap_ 自己會篩
 *  status === 'holding'，這裡不先篩選，交給純函式那一層處理（跟 lib/portfolio.js
 *  的職責劃分一致）。 */
async function fetchPortfolioLots_() {
  const snap = await admin.firestore().collection('portfolio_lots').get();
  return snap.docs.map(function (d) { return d.data(); });
}

/** 查 BigQuery 最近 ANALYSIS_LOOKBACK_DAYS 天、全市場的原始 History 列，轉成
 *  computeFactors_ 期待的中文欄名列。bigQueryConfig 是 config/app 文件的
 *  bigQuery 欄位（{projectId, dataset, sourceMode, pricePerTb}）。 */
async function fetchHistoryRows_(bigQueryConfig) {
  if (!bigQueryConfig || !bigQueryConfig.projectId) {
    throw new Error('config/app 的 bigQuery.projectId 是空的——請先在舊系統「因子回歸模型」設定頁填過 BigQuery 專案 ID，確認 Phase 2 的 config/app 遷移抓到了正確的值。');
  }
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const sourceRef = bigquery.sourceRefForRead_(bigQueryConfig);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.ANALYSIS_LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  // stocksOnly: true — 跟 apps-script 版 buildLatestDayFactorsSql_／computeFactors_
  // 的既有規則一致，這份戰報只算一般股票（LENGTH(stock_id) = 4），不含權證/ETF
  // （見 lib/bigquery.js buildHistoryRangeSql_ 的說明）。
  const sql = bigquery.buildHistoryRangeSql_(sourceRef, cutoffStr, null, { stocksOnly: true });
  const [rows] = await client.query({ query: sql });
  // mapBqRowToHistoryRow_ 回傳 null 代表 stock_id 清洗後不是合法代號，整列捨棄
  // （見 lib/bigquery.js 的說明——這是真實遇過的 OOM 事故的直接修正，不是預防性
  // 寫法）。
  return rows.map(bigquery.mapBqRowToHistoryRow_).filter(function (r) { return r !== null; });
}

/** Firestore `factor_model_history` collection 裡 `applied === true` 的文件
 *  （Phase 3 跟後端邏輯一起遷移，見 firebase-migration/migration/
 *  factor_model_history/），組成 reportPipeline.buildReport_ 需要的
 *  appliedFactorModels 形狀：{return1m: {timestamp, r2, weights},
 *  downsideResistance: {...}}，跟 apps-script/src/FactorRegression.gs 的
 *  getAppliedFactorModels() 回傳形狀一致。沒有任何套用中的模型時回傳 {}——
 *  rule_v17（預設策略）不需要這個，factor_model_rank／hybrid 需要。 */
async function fetchAppliedFactorModels_() {
  const snap = await admin.firestore().collection('factor_model_history').where('applied', '==', true).get();
  const applied = {};
  snap.docs.forEach(function (d) {
    const data = d.data();
    applied[data.labelKey] = { timestamp: data.timestamp, r2: data.r2, weights: data.weights };
  });
  return applied;
}

/**
 * Watchlist／Portfolio 卡片要顯示的「最新收盤價」跟名稱補救，統一用同一次
 * BigQuery 查詢取得——跟 apps-script/src/Portfolio.gs 的 getStockNameByCode／
 * getLatestCloseByCode_ 兩支各自查一次不同，這裡只查一次「這幾檔代號最近
 * 10 天的原始列」，同時拿到最新收盤價跟最新一筆的證券名稱，比兩次各自查詢
 * 省一次 BigQuery 費用（見這份檔案開頭／README 的設計決策說明）。
 * codes 是空陣列，或 config/app 還沒填 BigQuery 專案 ID 時，直接回傳 {}——
 * 跟 fetchHistoryRows_ 不同，這裡是卡片的「加分」資訊，查不到就顯示空白，
 * 不該讓整個 Watchlist/Portfolio 讀取因為 BigQuery 設定不完整而整個失敗。
 */
async function fetchBqInfoForCodes_(bigQueryConfig, codes) {
  if (!codes || codes.length === 0) return {};
  if (!bigQueryConfig || !bigQueryConfig.projectId) return {};
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const sourceRef = bigquery.sourceRefForRead_(bigQueryConfig);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 10);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const sql = bigquery.buildHistoryRowsForCodesSql_(sourceRef, codes, cutoffStr);
  const [rows] = await client.query({ query: sql });
  const mapped = rows.map(bigquery.mapBqRowToHistoryRow_).filter(function (r) { return r !== null; });
  const infoByCode = {};
  mapped.forEach(function (r) {
    const code = r['證券代號'];
    const d = r['日期'];
    if (!infoByCode[code] || d > infoByCode[code].date) {
      infoByCode[code] = { date: d, close: r['收盤價'], name: r['證券名稱'] };
    }
  });
  return infoByCode;
}

/**
 * `reports/{date}/signals` 底下，指定這幾檔代號各自最新一筆戰報燈號——跟
 * apps-script 版掃整個 Reports 分頁找每檔代號最大日期的那一筆不同，Firestore
 * 版戰報是依日期分 subcollection 存的（見 firestore/schema.md §3），這裡改用
 * collectionGroup 查詢只查呼叫端需要的這幾檔，不用把所有歷史戰報全部掃一輪。
 * 需要 `signals` 這個 collection group 上 (code ASC, date DESC) 的複合索引
 * （見 firestore/firestore.indexes.json），沒有這個索引查詢會直接失敗並在
 * 錯誤訊息裡附上建立索引的連結。
 */
async function fetchLatestSignalsByCode_(codes) {
  if (!codes || codes.length === 0) return {};
  const db = admin.firestore();
  const pairs = await Promise.all(codes.map(async function (code) {
    const snap = await db.collectionGroup('signals')
      .where('code', '==', code)
      .orderBy('date', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return null;
    const d = snap.docs[0].data();
    return [code, { date: d.date, strategy: d.strategy, action: d.action }];
  }));
  const map = {};
  pairs.forEach(function (pair) { if (pair) map[pair[0]] = pair[1]; });
  return map;
}

/** getWatchlist／getPortfolio 共用：給一批代號，併發查 BigQuery 最新收盤價/名稱
 *  跟各自最新一筆戰報燈號。 */
async function enrichByCode_(appConfig, codes) {
  const [bqInfoByCode, signalByCode] = await Promise.all([
    fetchBqInfoForCodes_(appConfig.bigQuery, codes),
    fetchLatestSignalsByCode_(codes)
  ]);
  return { bqInfoByCode: bqInfoByCode, signalByCode: signalByCode };
}

/** Firestore `watchlist` collection 全部文件（對照 firestore/schema.md §1）。 */
async function fetchWatchlistDocs_() {
  const snap = await admin.firestore().collection('watchlist').get();
  return snap.docs.map(function (d) { return d.data(); });
}

/** getWatchlist／addToWatchlist／removeFromWatchlist 都回傳同一份「加完料的
 *  觀察清單」，跟 apps-script 版三支函式都在最後呼叫 getWatchlist() 回傳同一個
 *  形狀一致（前端不用區分呼叫哪支，拿到的都是完整的最新清單）。 */
async function buildWatchlistResult_() {
  const [appConfig, watchlistDocs] = await Promise.all([fetchAppConfig_(), fetchWatchlistDocs_()]);
  const codes = watchlistDocs.map(function (d) { return d.code; });
  const enriched = await enrichByCode_(appConfig, codes);
  return watchlistLib.buildWatchlistItems_(watchlistDocs, enriched.bqInfoByCode, enriched.signalByCode);
}

/** getPortfolio／savePortfolioItem／deletePortfolioLot／closePortfolioPosition
 *  都回傳同一份「加完料的持股卡片」，跟 apps-script 版同一套設計。 */
async function buildPortfolioResult_() {
  const [appConfig, lotDocs] = await Promise.all([fetchAppConfig_(), fetchPortfolioLots_()]);
  const holdingCodes = Array.from(new Set(
    lotDocs.filter(function (l) { return l.status === 'holding'; }).map(function (l) { return l.code; })
  ));
  const enriched = await enrichByCode_(appConfig, holdingCodes);
  return portfolioOpsLib.buildPortfolioCards_(lotDocs, enriched.bqInfoByCode, enriched.signalByCode);
}

/**
 * 把 reportPipeline.buildReport_ 算出來的 reportDocs 寫進 Firestore
 * `reports/{date}/signals/{code}`。latestDate 是 null（完全查無 History 資料）
 * 時什麼都不寫——跟 apps-script 版 runAnalysisAndSave() 的「沒有可用資料就不寫」
 * 邏輯一致，不會用空值覆蓋掉昨天本來好好的戰報。
 *
 * 寫入前先讀一次同一天既有的文件，把「這次沒有出現在新報告裡」的舊文件刪掉——
 * 不能只對新的 reportDocs 做 set()：實際遇過的真實案例，同一天先用 rule_v17
 * 跑出 79 筆，切換成 hybrid 重跑只產生 8 筆，如果不清掉舊文件，Firestore 裡
 * 會留著 71 筆上一次策略算出來的舊資料跟這次的 8 筆混在一起，看起來像「今天的
 * 戰報」，但其實是兩個不同策略、不同時間點算出來的結果疊在一起，不是真正的
 * 當天戰報。同一天的訊號數量上限是全市場股票數（1000 出頭），刪除+寫入合計
 * 操作數可能超過 Firestore 單批 500 筆上限，所以分批跟 AiDiagnosis／
 * IndustryMap 的 import-firestore.js 一樣处理。
 */
async function writeReportDocs_(result) {
  if (!result.latestDate) return;
  const db = admin.firestore();
  const signalsRef = db.collection('reports').doc(result.latestDate).collection('signals');

  const existingSnap = await signalsRef.get();
  const newCodes = new Set(result.reportDocs.map(function (doc) { return doc.code; }));
  const staleRefs = existingSnap.docs
    .filter(function (d) { return !newCodes.has(d.id); })
    .map(function (d) { return d.ref; });

  const setOps = result.reportDocs.map(function (doc) {
    var fields = Object.assign({}, doc);
    delete fields.id;
    return { ref: signalsRef.doc(doc.code), fields: fields };
  });

  var ops = staleRefs.map(function (ref) { return { type: 'delete', ref: ref }; })
    .concat(setOps.map(function (op) { return { type: 'set', ref: op.ref, fields: op.fields }; }));

  const BATCH_SIZE = 400;
  for (var i = 0; i < ops.length; i += BATCH_SIZE) {
    var batch = db.batch();
    ops.slice(i, i + BATCH_SIZE).forEach(function (op) {
      if (op.type === 'delete') batch.delete(op.ref); else batch.set(op.ref, op.fields);
    });
    await batch.commit();
  }
}

/** 真正做事的地方：排程跟手動觸發的 HTTPS endpoint 都呼叫這支，確保兩邊行為
 *  完全一致（跟 apps-script 版 runAnalysisAndSave() 被排程跟手動按鈕共用是
 *  同一個設計）。 */
async function runDailyAnalysis_() {
  const appConfig = await fetchAppConfig_();
  const [historyRows, lotDocs, appliedFactorModels] = await Promise.all([
    fetchHistoryRows_(appConfig.bigQuery),
    fetchPortfolioLots_(),
    fetchAppliedFactorModels_()
  ]);
  const result = reportPipeline.buildReport_(historyRows, lotDocs, appConfig.screeningStrategy, appliedFactorModels);
  await writeReportDocs_(result);
  return result;
}

/** 全市場 1000+ 檔股票 x ANALYSIS_LOOKBACK_DAYS(150)天的原始 History，實測需要
 *  的記憶體比 Cloud Functions 2nd gen 預設的 256 MiB 略高（部署後實測跑到
 *  256 MiB 就被 OOM 砍掉，見 firebase-migration/README.md 的部署驗證紀錄）——
 *  跟 apps-script 版当年因為 Apps Script V8 記憶體上限才把因子計算改寫成
 *  BigQuery SQL 是同一個量級的資料，但這裡純粹是部署設定沒給夠，不是架構問題，
 *  調大記憶體配置就解決，不需要像 apps-script 版那樣另外維護一套 SQL 實作。
 *  1GiB 大約是實測用量（267~291 MiB）的 3~4 倍，留足餘裕應付資料量隨股票數
 *  微幅成長。 */
var RUNTIME_OPTS_ = { memory: '1GiB', timeoutSeconds: 180 };

/** `skip_dates` collection 的文件 ID（就是日期字串 `yyyy-MM-dd`，見
 *  firestore/schema.md §5），組成 Set 給 `scheduleLib.shouldRunDailyReport_`
 *  用——collection 很小（偶爾才加一筆臨時停跑日），直接整個撈回來，不用查詢。 */
async function fetchSkipDates_() {
  const snap = await admin.firestore().collection('skip_dates').get();
  return new Set(snap.docs.map(function (d) { return d.id; }));
}

/**
 * 每 5 分鐘被 Cloud Scheduler 叫醒一次（不是「每個交易日固定時間」一次），叫醒
 * 之後用 `scheduleLib.shouldRunDailyReport_` 判斷現在的台北時間是不是落在
 * `config/app` 的 `triggerHour`/`triggerMinute` 設定的目標區間、有沒有跳過
 * 週末／`skip_dates` 裡的臨時停跑日，不是才直接 return，不做任何事。
 *
 * 跟 apps-script 版的設計差異（見 lib/schedule.js 開頭的完整說明）：Apps
 * Script 可以在執行階段動態新增/刪除真正的時間觸發器，使用者在畫面上改排程
 * 設定，下次觸發時間馬上跟著變；Cloud Scheduler 的 cron 是部署時寫死的設定，
 * 沒辦法用同樣的方式動態改，除非額外串 Cloud Scheduler Admin API（多一組
 * IAM 權限、多一個 GCP 依賴）。改成固定頻率 tick 換取「使用者在 Admin 頁面
 * 改設定，最多等 5 分鐘就生效，不用重新部署」，代價是觸發精準度降到 5 分鐘
 * 解析度——對「每天收盤後算一次戰報」這種用途完全足夠，不需要精準到那一分鐘。
 * 絕大多數的 tick 只做兩次 Firestore 讀取就直接 return，成本可以忽略（一天
 * 288 次 tick，遠低於 Cloud Functions 免費額度）。
 *
 * `timeoutSeconds: 540`（蓋掉 `RUNTIME_OPTS_` 的 180，見下面 `Object.assign`
 * 的參數順序——後面的物件屬性覆蓋前面的，所以客製化選項要放在 `RUNTIME_OPTS_`
 * 後面，不是像其他呼叫端那樣放前面）：真正算戰報那一次 tick，寫完戰報之後如果
 * `config/app.aiDailyEnabled` 開著，還要接著跑 Top3 橫向比較＋候選名單橫向
 * 比較＋逐檔深度診斷（見 `runDailyAiDiagnosisForTopPicks_`），候選數上限 10
 * 檔（`setAiDailySettings` 的驗證邏輯搬到 Admin 頁面的輸入框也一樣夾在
 * 3~10），180 秒不夠用；540 秒（9 分鐘）在這個上限下留了充足餘裕，不需要像
 * apps-script 版那樣另外維護一套 `budgetDeadline` 提早跳過剩餘代號的機制
 * ——那是 Apps Script 6 分鐘硬性執行上限逼出來的設計，Cloud Functions 的逾時
 * 是這支函式自己宣告的，直接給夠就不會撞到。需要 `secrets: ['GEMINI_API_KEY']`
 * ——這支函式現在也會直接呼叫 Gemini，不是只靠 `runDailyAiDiagnosisForTopPicks_`
 * 內部呼叫的其他函式各自宣告就會生效（每支 Cloud Function 的 `secrets` 要
 * 各自獨立宣告，見 `runAiDiagnosis`/`getAiKeyStatus` 的說明）。
 */
exports.generateDailyReportScheduled = onSchedule(
  Object.assign({}, RUNTIME_OPTS_, { schedule: '*/5 * * * *', timeoutSeconds: 540, secrets: ['GEMINI_API_KEY'] }),
  async function () {
    const appConfig = await fetchAppConfig_();
    const skipDates = await fetchSkipDates_();
    const should = scheduleLib.shouldRunDailyReport_(new Date(), {
      triggerHour: appConfig.triggerHour,
      triggerMinute: appConfig.triggerMinute,
      skipWeekends: appConfig.skipWeekends,
      skipDates: skipDates
    });
    if (!should) return;
    await runDailyAnalysis_();
    if (appConfig.aiDailyEnabled) {
      // runDailyAiDiagnosisForTopPicks_ 內部已經把 Top3／候選名單這兩段各自包了
      // try/catch，這裡再包一層純粹是防禦性的最後一道防線——AI 診斷失敗不該讓
      // 這次 tick 被記成失敗、也不該讓已經成功寫入的戰報被当成沒跑完。
      try {
        await runDailyAiDiagnosisForTopPicks_(appConfig);
      } catch (e) { /* 見上方說明：不該發生，失敗也不影響已經寫入的戰報 */ }
    }
  }
);

/** 手動觸發用（取代 apps-script 版「重新計算戰報」按鈕），回傳這次算出來的戰報
 *  摘要，方便部署後用 curl 或瀏覽器直接驗證有沒有接線成功。 */
exports.generateDailyReport = onRequest(RUNTIME_OPTS_, async function (req, res) {
  try {
    const result = await runDailyAnalysis_();
    res.json({
      ok: true,
      latestDate: result.latestDate,
      reportCount: result.reportDocs.length,
      screeningStrategy: result.screeningStrategy,
      strategyError: result.strategyError || null,
      diagnostics: result.diagnostics
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * 以下是 Watchlist／Portfolio 的讀寫邏輯（Phase 3，跟戰報計算一起遷移），從
 * apps-script/src/Watchlist.gs／apps-script/src/Portfolio.gs 搬過來。用
 * onCall（不是 onRequest／onSchedule）——這幾支是給之後的前端（Phase 5）直接
 * 呼叫用的使用者操作，不是排程或純測試用的 HTTP endpoint，onCall 自帶
 * Firebase Auth 驗證跟結構化錯誤回傳，不用自己重新發明一套。
 *
 * deletePortfolioItem_（依代號刪光全部持有中紀錄）刻意不搬——apps-script 版
 * 自己也說明那是「舊版前端相容用」，新版前端一律用 deletePortfolioLot(lotId)
 * 刪除單一一筆，不需要這支。
 */

/** 跟 firestore/firestore.rules 的 isOwner() 同一個擁有者 email，刻意重複寫一次：
 *  Cloud Functions 用 Admin SDK 讀寫 Firestore，完全不受 Security Rules 限制，
 *  isOwner() 只保護前端「直接」讀寫 watchlist／portfolio_lots 這兩個 collection，
 *  擋不住繞過前端直接打這幾支 onCall function 的呼叫——所以每一支都要在進入點
 *  自己檢查一次 request.auth，不能只靠 Security Rules 那一層。 */
var OWNER_EMAIL_ = 'nachohuang@gmail.com';

function assertOwnerAuth_(request) {
  if (!request.auth || request.auth.token.email !== OWNER_EMAIL_) {
    throw new HttpsError('permission-denied', '只有擁有者本人登入後才能呼叫這個功能。');
  }
}

exports.getWatchlist = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  return await buildWatchlistResult_();
});

/** data: {code, name?, note?}。code 必填；已經是持有中的股票會被擋掉（見
 *  lib/watchlist.js assertNotHolding_ 的說明）；同一檔股票重複加入視為更新。 */
exports.addToWatchlist = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const code = utilsLib.zfill4(String(data.code).trim());

  const [lotDocs, docRef] = [await fetchPortfolioLots_(), admin.firestore().collection('watchlist').doc(code)];
  const portfolioMap = portfolio.buildPortfolioMap_(lotDocs);
  try {
    watchlistLib.assertNotHolding_(code, portfolioMap);
  } catch (e) {
    throw new HttpsError('failed-precondition', e.message);
  }

  const existingSnap = await docRef.get();
  const todayStr = utilsLib.todayStrTaipei_();
  const fields = watchlistLib.mergeWatchlistDoc_(existingSnap.exists ? existingSnap.data() : null, code, data.name, data.note, todayStr);
  await docRef.set(fields);
  return await buildWatchlistResult_();
});

/** data: {code}。 */
exports.removeFromWatchlist = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const code = utilsLib.zfill4(String(data.code).trim());
  await admin.firestore().collection('watchlist').doc(code).delete();
  return await buildWatchlistResult_();
});

exports.getPortfolio = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  return await buildPortfolioResult_();
});

/**
 * data: {lotId?, code, name?, cost, buyDate?, shares?, note?}。沒帶 lotId 代表
 * 新增一筆全新買進紀錄（isNewHolding），這檔股票既然已經真的買進，就自動把它
 * 從觀察清單移除（對應 apps-script 版 removeFromWatchlistSilently_，同步失敗
 * 不該擋住真正的買進紀錄，見 catch 區塊的說明）；帶 lotId 代表編輯既有的一筆。
 */
exports.savePortfolioItem = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const item = request.data || {};
  if (!item.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const code = utilsLib.zfill4(String(item.code).trim());
  const db = admin.firestore();
  const isNewHolding = !item.lotId;

  if (item.lotId) {
    const ref = db.collection('portfolio_lots').doc(item.lotId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', '找不到這筆買進紀錄，可能已被刪除，請重新整理後再試一次');
    const existing = snap.data();
    await ref.set({
      transactionId: item.lotId,
      code: code,
      name: item.name || existing.name || '',
      buyDate: item.buyDate || existing.buyDate || '',
      buyPrice: utilsLib.toNumber(item.cost),
      shares: utilsLib.toNumber(item.shares) || existing.shares || config.PORTFOLIO_DEFAULT_LOT_SHARES,
      note: item.note || '',
      status: existing.status || 'holding',
      sellDate: existing.sellDate || null,
      sellPrice: existing.sellPrice || null
    });
  } else {
    const ref = db.collection('portfolio_lots').doc();
    await ref.set({
      transactionId: ref.id,
      code: code,
      name: item.name || '',
      buyDate: item.buyDate || '',
      buyPrice: utilsLib.toNumber(item.cost),
      shares: utilsLib.toNumber(item.shares) || config.PORTFOLIO_DEFAULT_LOT_SHARES,
      note: item.note || '',
      status: 'holding',
      sellDate: null,
      sellPrice: null
    });
    try {
      await db.collection('watchlist').doc(code).delete();
    } catch (e) { /* 觀察清單同步失敗不該擋住真正的買進紀錄，見 apps-script 版說明 */ }
  }
  return await buildPortfolioResult_();
});

/** data: {lotId}。依交易ID刪除單一一筆買進紀錄（不是依股票代號——同一檔可能有好幾筆）。 */
exports.deletePortfolioLot = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const lotId = request.data && request.data.lotId;
  if (!lotId) throw new HttpsError('invalid-argument', '缺少交易ID');
  await admin.firestore().collection('portfolio_lots').doc(lotId).delete();
  return await buildPortfolioResult_();
});

/** data: {code, sellDate, sellPrice}。把某檔股票目前所有「持有中」的紀錄一次性
 *  標記為已賣出（用同一個賣出日期/價格），不支援部分賣出（對應 apps-script 版
 *  closePortfolioPosition 的說明）。 */
exports.closePortfolioPosition = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const code = utilsLib.zfill4(String(data.code || '').trim());
  if (!code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const sellPrice = utilsLib.toNumber(data.sellPrice);
  if (!sellPrice) throw new HttpsError('invalid-argument', '請輸入賣出價格');
  if (!data.sellDate) throw new HttpsError('invalid-argument', '請輸入賣出日期');

  const db = admin.firestore();
  const snap = await db.collection('portfolio_lots').where('code', '==', code).where('status', '==', 'holding').get();
  if (snap.empty) throw new HttpsError('not-found', '找不到 ' + code + ' 目前持有中的買進紀錄');
  const batch = db.batch();
  snap.docs.forEach(function (doc) {
    batch.update(doc.ref, { status: 'sold', sellDate: data.sellDate, sellPrice: sellPrice });
  });
  await batch.commit();
  return await buildPortfolioResult_();
});

exports.getClosedPortfolioHistory = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const lotDocs = await fetchPortfolioLots_();
  return portfolioOpsLib.buildClosedHistory_(lotDocs);
});

/**
 * 以下是股票詳情頁（戰報卡片點進去看的頁面）的讀取邏輯，從
 * apps-script/src/StockAnalysis.gs 搬過來。**刻意沒搬**的部分：
 * `getRealtimeQuote`（打 `mis.twse.com.tw` 這個非官方、沒文件、只在盤中
 * 開放、有流量限制的即時報價端點，跟這次遷移「BigQuery/Firestore 資料層」
 * 的範圍無關，而且那支端點本身就脆弱，之後要做可以直接對應複製邏輯，不影響
 * 這裡的其他部分）、`startAiDiagnosisJob`／`getAiDiagnosisJobStatus`（跑一次
 * 新的 AI 診斷需要 Secret Manager 存 API 金鑰，獨立列為下一步，見 README
 * 「還沒做的事」）——這裡只讀**已經存在的**快取診斷（`getAiDiagnosisHistoryForCode`
 * 同款，Phase 2 已經遷移進 Firestore `ai_diagnosis`），不會主動呼叫 AI。
 */

/** 查 BigQuery 某一檔股票最近 STOCK_DETAIL_LOOKBACK_DAYS 天的原始 History 列，
 *  轉成中文欄名列（跟 fetchHistoryRows_／fetchBqInfoForCodes_ 同一套轉換）。 */
async function fetchStockHistoryRows_(bigQueryConfig, code) {
  if (!bigQueryConfig || !bigQueryConfig.projectId) return [];
  const client = new BigQuery({ projectId: bigQueryConfig.projectId });
  const sourceRef = bigquery.sourceRefForRead_(bigQueryConfig);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.STOCK_DETAIL_LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const sql = bigquery.buildHistoryRowsForCodesSql_(sourceRef, [code], cutoffStr);
  const [rows] = await client.query({ query: sql });
  return rows.map(bigquery.mapBqRowToHistoryRow_).filter(function (r) { return r !== null; });
}

/** `reports/{date}/signals` 裡某一檔代號的全部文件（collectionGroup 查詢）。
 *  一定要帶 `.orderBy('date', 'desc')`——實際部署驗證過，只有
 *  `.where('code','==',code)` 不夠：Firestore 對 collection group 的要求比
 *  「composite index 可以當作其他查詢的前綴使用」想像中更嚴格，單純等號查詢
 *  被要求要另外一個 `COLLECTION_GROUP_ASC` 的 `code` 單欄索引。加這個
 *  `orderBy` 剛好完全對上既有的 `(code ASC, date DESC)` 複合索引（前面「需要
 *  的 Firestore 複合索引」那組，跟 fetchLatestSignalsByCode_ 共用），不用再
 *  多部署一個索引——而且「戰報燈號歷史新到舊排序」本來就是要的順序。 */
async function fetchSignalHistoryForCode_(code) {
  const db = admin.firestore();
  const snap = await db.collectionGroup('signals').where('code', '==', code).orderBy('date', 'desc').get();
  return snap.docs.map(function (d) { return d.data(); });
}

/** `ai_diagnosis` collection 裡某一檔代號的全部快取診斷（Phase 2 已遷移完成，
 *  見 firestore/schema.md §4）。只查 `code` 相等，不加 `orderBy`——單欄等號
 *  查詢不需要額外的複合索引，排序交給呼叫端在記憶體裡做（同一檔股票的診斷
 *  紀錄筆數不多，不值得為了省這幾筆排序多部署一個索引）。 */
async function fetchAiDiagnosisForCode_(code) {
  const db = admin.firestore();
  const snap = await db.collection('ai_diagnosis').where('code', '==', code).get();
  const docs = snap.docs.map(function (d) { return d.data(); });
  docs.sort(function (a, b) { return (a.timestamp || '') < (b.timestamp || '') ? 1 : -1; });
  return docs;
}

/** 從 portfolioMap 取出某代號的持股背景資訊（加權平均成本／最早買進日／持有天數／
 *  目前損益%）——getStockDetail（顯示用）跟 runPortfolioHoldDiagnosis（組 AI prompt
 *  用）共用同一份計算，不要兩個地方各自重複寫一次同一套日期/損益算法。沒有持有這一檔
 *  時回傳 null。daysHeld 的日期相減刻意都用 'T00:00:00Z'（UTC）解析，避免 Node 把
 *  'YYYY-MM-DD' 字串當成本機時區午夜解析，兩個時區不一致時算出差一天的天數。 */
function buildHoldingInfo_(portfolioMap, code, latestClose) {
  const info = portfolioMap[code];
  if (!info) return null;
  const todayStr = utilsLib.todayStrTaipei_();
  const daysHeld = info.buyDate
    ? Math.round((new Date(todayStr + 'T00:00:00Z') - new Date(info.buyDate + 'T00:00:00Z')) / 86400000)
    : null;
  const profitPct = (info.cost && latestClose !== null && latestClose !== undefined)
    ? utilsLib.round_((latestClose - info.cost) / info.cost * 100, 2)
    : null;
  return { cost: info.cost, buyDate: info.buyDate, daysHeld: daysHeld, profitPct: profitPct };
}

/** data: {code}。回傳股票詳情頁要的四組資料：價格走勢（含 MA5/20/60）、
 *  戰報燈號歷史、AI 診斷快取歷史、持股背景資訊（沒有持有這一檔時是 null，
 *  前端用這個欄位決定要不要顯示「跑新的持股續抱診斷」按鈕）。BigQuery／
 *  Firestore／collectionGroup 三種 I/O 混在一起，所以用一支 onCall 一次
 *  打包回傳，不拆成多支個別呼叫——前端要顯示的是同一個頁面，沒有理由讓
 *  使用者等好幾次 round trip。 */
exports.getStockDetail = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const code = utilsLib.zfill4(String(data.code).trim());

  const appConfig = await fetchAppConfig_();
  const [historyRows, signalDocs, aiDiagnoses, lotDocs] = await Promise.all([
    fetchStockHistoryRows_(appConfig.bigQuery, code),
    fetchSignalHistoryForCode_(code),
    fetchAiDiagnosisForCode_(code),
    fetchPortfolioLots_()
  ]);

  if (historyRows.length === 0) {
    throw new HttpsError('not-found', '查無 ' + code + ' 的歷史資料，確認代號是否正確。');
  }

  const series = stockDetailLib.buildPriceSeries_(historyRows);
  const scoreHistory = stockDetailLib.buildScoreHistory_(signalDocs);
  const latest = series[series.length - 1];
  const latestClose = latest ? latest.close : null;
  const portfolioMap = portfolio.buildPortfolioMap_(lotDocs);

  return {
    code: code,
    name: historyRows[historyRows.length - 1]['證券名稱'] || '',
    latestClose: latestClose,
    series: series,
    scoreHistory: scoreHistory,
    aiDiagnoses: aiDiagnoses,
    holding: buildHoldingInfo_(portfolioMap, code, latestClose)
  };
});

/** data: {query}。股票代號/名稱模糊搜尋，給前端的搜尋框用——跟戰報清單的
 *  「只篩今天的訊號」不同，這支查的是全市場、不限於今天有沒有訊號，用來找
 *  任何一檔股票打開詳情頁。回傳最多 20 筆 {code, name}，依最新資料的代號
 *  去重（BigQuery 查回來的是原始列，同一檔代號會有很多天，這裡只取最新
 *  那筆的名稱）。 */
exports.searchStockCodes = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const q = String(data.query || '').trim();
  if (!q) return [];

  const appConfig = await fetchAppConfig_();
  if (!appConfig.bigQuery || !appConfig.bigQuery.projectId) return [];

  const client = new BigQuery({ projectId: appConfig.bigQuery.projectId });
  const sourceRef = bigquery.sourceRefForRead_(appConfig.bigQuery);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 10);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const sql = bigquery.buildStockSearchSql_(sourceRef, q, cutoffStr);
  const [rows] = await client.query({ query: sql });

  const seen = new Set();
  const results = [];
  for (const row of rows) {
    const code = utilsLib.sanitizeStockId_(row.stock_id);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    results.push({ code: code, name: row.stock_name || '' });
    if (results.length >= 20) break;
  }
  return results;
});

/**
 * 以下是 AI 深度診斷（新進場決策，diagnosisType='deep'）的 I/O，從
 * apps-script/src/AiDiagnosis.gs 搬過來（純邏輯部分見 lib/aiDiagnosis.js 開頭的
 * 範圍說明——這一版刻意只搬「深度診斷」，'hold'／'top3' 兩種診斷類型跟 AiUsage
 * 歷史費用記錄先不搬，見 README「AI 診斷」那節）。
 *
 * Goodinfo／TWSE OpenAPI／Claude／Gemini 都是打外部 HTTP 端點，跟這支檔案其餘
 * 的 BigQuery／Firestore I/O 同一個檔案管理，不獨立成 lib/ 底下的模組——這些
 * 函式本身就是「純 I/O」，沒有值得抽出來單元測試的運算邏輯（組 prompt／抽結論
 * 的運算邏輯已經在 lib/aiDiagnosis.js 測過）。Node 20 執行環境內建全域
 * `fetch`，不需要額外加 node-fetch 依賴。
 */

/** 跟 apps-script 版 fetchGoodinfoText_ 同一套抓取/去標籤邏輯——Goodinfo 沒有
 *  公開 API，只能抓網頁 HTML 用正規表示式去標籤，抓不到 JS 動態載入的內容，
 *  抓取失敗時回傳說明文字而不是拋例外，讓整個診斷流程可以繼續跑下去（AI 看到
 *  說明文字會依系統 prompt 規則 1 明確標註「此部分資料不足」）。 */
async function fetchGoodinfoText_(code) {
  const url = 'https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=' + code;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9'
      }
    });
    if (!resp.ok) {
      return '（無法取得 Goodinfo 頁面，HTTP ' + resp.status + '，這部分請依你既有的知識判斷，並在報告中註明缺乏即時資料）';
    }
    const html = await resp.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    const MAX_CHARS = 6000; // 避免整段塞爆 prompt，只取前面精華（頁首通常是股價/基本資訊區塊）
    return text.slice(0, MAX_CHARS);
  } catch (e) {
    return '（抓取 Goodinfo 頁面時發生錯誤：' + String(e.message || e) + '，這部分請依你既有的知識判斷，並在報告中註明缺乏即時資料）';
  }
}

/** 跟 apps-script 版 TWSE_OFFICIAL_FINANCIALS_DATASETS_ 同一份端點清單——只接了
 *  「一般業」的財報端點，金融/證券/保險/金控等特殊產業別查無資料是預期行為。 */
var TWSE_OFFICIAL_FINANCIALS_DATASETS_ = [
  { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L', label: '上市公司每月營業收入彙總表' },
  { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci', label: '上市公司綜合損益表（一般業）' },
  { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci', label: '上市公司資產負債表（一般業）' }
];

/** 抓 3 個 TWSE OpenAPI 全市場資料集（一次），單一資料集抓取失敗就讓那個資料集
 *  的 rows 是空陣列，不拋例外、不中斷整體流程——跟 apps-script 版同一個設計。 */
async function fetchTwseOfficialFinancialsDatasets_() {
  return Promise.all(TWSE_OFFICIAL_FINANCIALS_DATASETS_.map(async function (ds) {
    try {
      const resp = await fetch(ds.url);
      if (!resp.ok) return { label: ds.label, rows: [] };
      const rows = await resp.json();
      return { label: ds.label, rows: Array.isArray(rows) ? rows : [] };
    } catch (e) {
      return { label: ds.label, rows: [] };
    }
  }));
}

/** 跟 apps-script 版 callClaude_ 同一套呼叫方式（system prompt 帶
 *  `cache_control: {type: 'ephemeral'}` 做 prompt caching，省同一段系統規則文字
 *  重複呼叫的費用）。 */
async function callClaude_(systemPrompt, userPrompt, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: config.CLAUDE_MODEL,
      max_tokens: config.CLAUDE_MAX_TOKENS,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error('Claude API 呼叫失敗 HTTP ' + resp.status + '：' + body.slice(0, 300));
  }
  const json = JSON.parse(body);
  const text = (json.content || []).map(function (block) { return block.text || ''; }).join('\n');
  const usage = json.usage || {};
  return {
    text: text,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
    cacheReadInputTokens: usage.cache_read_input_tokens || 0,
    provider: 'claude',
    model: config.CLAUDE_MODEL
  };
}

/** 跟 apps-script 版 callGeminiOnce_ 同一套呼叫方式。 */
async function callGeminiOnce_(apiKey, systemPrompt, userPrompt, useGrounding) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + config.GEMINI_MODEL +
    ':generateContent?key=' + encodeURIComponent(apiKey);
  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: config.GEMINI_MAX_TOKENS }
  };
  if (useGrounding) payload.tools = [{ google_search: {} }];

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error('Gemini API 呼叫失敗 HTTP ' + resp.status + '：' + body.slice(0, 300));
  }
  const json = JSON.parse(body);
  const candidate = (json.candidates || [])[0];
  if (!candidate || !candidate.content || !candidate.content.parts) {
    const finishReason = candidate && candidate.finishReason;
    throw new Error('Gemini 回傳格式異常（finishReason：' + (finishReason || '未知') +
      '，grounding：' + (useGrounding ? '開啟' : '關閉') + '）：' + body.slice(0, 300));
  }
  const text = candidate.content.parts.map(function (p) { return p.text || ''; }).join('');
  const usage = json.usageMetadata || {};
  return {
    text: text,
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    provider: 'gemini',
    model: config.GEMINI_MODEL
  };
}

/** 跟 apps-script 版 callGemini_ 同一套重試/降級機制：gemini-2.5-flash 開
 *  google_search grounding 時，Google API 端偶爾回傳「空內容」（見
 *  lib/aiDiagnosis.js 之外、這支函式本身的這段說明在 apps-script 版原文有完整
 *  描述）——最多重試 3 次，連續兩次空內容失敗就在第 3 次關掉 grounding 再試。 */
async function callGemini_(systemPrompt, userPrompt, apiKey) {
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const useGrounding = attempt < maxAttempts;
    try {
      const result = await callGeminiOnce_(apiKey, systemPrompt, userPrompt, useGrounding);
      result.groundingDisabled = !useGrounding;
      return result;
    } catch (e) {
      lastError = e;
      if (!/回傳格式異常/.test(String(e.message || e))) throw e;
      if (attempt < maxAttempts) await new Promise(function (r) { setTimeout(r, 1500); });
    }
  }
  throw lastError;
}

/** 依 provider 分派到 Claude 或 Gemini，apiKeys 是 {claude, gemini}（從
 *  process.env 讀出來的 Secret Manager 密鑰，見 exports.runAiDiagnosis）。 */
async function callLlm_(systemPrompt, userPrompt, provider, apiKeys) {
  if (provider === 'gemini') {
    if (!apiKeys.gemini) throw new HttpsError('failed-precondition', '尚未設定 Gemini API 金鑰（Secret Manager 的 GEMINI_API_KEY）。');
    return callGemini_(systemPrompt, userPrompt, apiKeys.gemini);
  }
  if (!apiKeys.claude) throw new HttpsError('failed-precondition', '尚未設定 Anthropic API 金鑰（Secret Manager 的 ANTHROPIC_API_KEY）。');
  return callClaude_(systemPrompt, userPrompt, apiKeys.claude);
}

/**
 * 寫一筆 AI 呼叫的用量／費用記錄——跟 apps-script 版 logAiUsage_（寫進 Sheets
 * 的 AiUsage 分頁）同一個用途，這版寫進 Firestore `ai_usage` collection（見
 * README「AI 用量統計」那節）。`code` 對單檔診斷是股票代號，對候選名單橫向
 * 比較／Top3 推薦是常數 `'SHORTLIST_SCAN'`／`'TOP3_SCAN'`，跟 apps-script 版
 * 一致。刻意吞掉寫入失敗的錯誤——用量記錄是「順便記一筆」的旁支資訊，寫失敗
 * 不該讓已經成功的診斷流程整個報錯給使用者看。 */
async function logAiUsage_(code, llmResult, costUsd, timestampLabel) {
  try {
    await admin.firestore().collection('ai_usage').add({
      date: utilsLib.todayStrTaipei_(),
      timestamp: timestampLabel,
      provider: llmResult.provider,
      model: llmResult.model,
      code: code,
      inputTokens: llmResult.inputTokens || 0,
      outputTokens: llmResult.outputTokens || 0,
      costUsd: utilsLib.round_(costUsd, 6)
    });
  } catch (e) { /* 見上方說明：用量記錄寫失敗不影響呼叫端 */ }
}

/**
 * 單一股票代號跑一次 AI 深度診斷的核心邏輯，不含 onCall 的 auth／參數驗證——
 * `exports.runAiDiagnosis`（股票詳情頁單檔觸發）跟
 * `runShortlistAndDeepDiagnosis_`（每日自動診斷，對候選名單裡每一檔各呼叫一次）
 * 共用同一份實作，不要兩個呼叫路徑各自重複寫一次「查戰報列→抓財報→組
 * prompt→呼叫 LLM→算費用→寫入 Firestore」。appConfig 由呼叫端傳入（兩條路徑
 * 都已經在外層讀過一次，不用每檔股票各自重讀一次 `config/app`）。
 */
async function runDeepDiagnosisForCode_(appConfig, code) {
  const signalDocs = await fetchSignalHistoryForCode_(code);
  const row = signalDocs[0];
  if (!row) {
    throw new HttpsError('not-found', '在戰報裡找不到 ' + code + ' 的資料，請先確認它出現在某一天的戰報中。');
  }

  const timestampLabel = utilsLib.timestampLabelTaipei_();
  const [goodinfoText, twseDatasets] = await Promise.all([
    fetchGoodinfoText_(code),
    fetchTwseOfficialFinancialsDatasets_()
  ]);
  const twseOfficialText = aiDiagnosisLib.buildTwseOfficialFinancialsTextForCode_(code, twseDatasets);
  const userPrompt = aiDiagnosisLib.buildDiagnosisPrompt_(row, goodinfoText, twseOfficialText, timestampLabel);

  const provider = appConfig.aiProvider === 'gemini' ? 'gemini' : 'claude';
  const llmResult = await callLlm_(aiDiagnosisLib.AI_DIAGNOSIS_SYSTEM_PROMPT, userPrompt, provider, {
    claude: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY
  });

  const diagnosisText = llmResult.text;
  const verdict = aiDiagnosisLib.extractVerdict_(diagnosisText);
  const cost = aiDiagnosisLib.calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens, {
    cacheCreationInputTokens: llmResult.cacheCreationInputTokens,
    cacheReadInputTokens: llmResult.cacheReadInputTokens
  }, appConfig.pricing);

  const record = {
    date: row.date,
    code: code,
    name: row.name || '',
    armorScore: row.armorScore,
    strategy: row.strategy,
    verdict: verdict,
    diagnosisType: 'deep',
    content: diagnosisText,
    timestamp: timestampLabel
  };
  await admin.firestore().collection('ai_diagnosis').doc(code + '_' + row.date + '_deep').set(record);
  await logAiUsage_(code, llmResult, cost, timestampLabel);

  return Object.assign({}, record, { cost: utilsLib.round_(cost, 4), groundingDisabled: !!llmResult.groundingDisabled });
}

/**
 * data: {code}。對單一股票代號跑一次 AI 深度診斷（會真正呼叫 Claude／Gemini
 * API，消耗額度）——跟 apps-script 版 runAiDiagnosis 一次對一批代號跑的設計不同，
 * 這裡是前端「股票詳情頁」單檔觸發用的互動式按鈕，一次只診斷使用者正在看的這
 * 一檔，不需要批次省 TWSE 資料集重複抓取的成本。
 *
 * 需要 `secrets: ['GEMINI_API_KEY']`——Firebase CLI 部署時會自動把這個 Secret
 * Manager 的密鑰值注入成這支函式執行環境的 `process.env.GEMINI_API_KEY`，並
 * 自動只授權這支函式的執行身分讀取這個密鑰（不用手動設定 IAM）。密鑰本身要靠
 * 使用者自己跑 `firebase functions:secrets:set GEMINI_API_KEY` 建立，這裡沒
 * 辦法（也不應該）用程式自動建立。
 *
 * **刻意不宣告 `ANTHROPIC_API_KEY`**——`firebase deploy` 會驗證 `secrets`
 * 陣列裡列出的每一個密鑰在 Secret Manager 裡真的存在、至少有一個版本，缺一個
 * 就整個部署失敗（不是只有用到 Claude 才失敗，是部署當下就失敗，Hosting／
 * Firestore 都會被一起卡住，因為這支 workflow 沒加 `--only`）。使用者目前只用
 * Gemini，沒有 Anthropic 金鑰，為了不逼使用者去生一個根本不會用到的 Claude
 * 金鑰只為了湊齊這個陣列，這裡只宣告真正會用到的這一個。`callLlm_` 的 Claude
 * 分支程式碼還留著（`config/app.aiProvider` 還是可以設回 `'claude'`），只是
 * 這種狀態下 `process.env.ANTHROPIC_API_KEY` 會是 `undefined`，`callLlm_`
 * 會拋出跟原來一樣清楚的 `failed-precondition`「尚未設定 Anthropic API 金鑰」
 * ——之後真的要用 Claude，把 `'ANTHROPIC_API_KEY'` 加回這個陣列、建好密鑰、
 * 重新部署即可，不用改其他程式碼。
 */
exports.runAiDiagnosis = onCall(
  Object.assign({ secrets: ['GEMINI_API_KEY'] }, RUNTIME_OPTS_),
  async function (request) {
    assertOwnerAuth_(request);
    const data = request.data || {};
    if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
    const code = utilsLib.zfill4(String(data.code).trim());
    const appConfig = await fetchAppConfig_();
    return runDeepDiagnosisForCode_(appConfig, code);
  }
);

/**
 * 以下是「每日自動 AI 診斷」（Top3 橫向推薦 + 候選名單橫向比較後逐檔深度診斷）
 * 的 I/O，從 apps-script/src/AiDiagnosis.gs 的
 * `getLatestReportCandidates_`／`runAiTopPicks`／`runAiShortlist_`／
 * `runDailyAiDiagnosisForTopPicks` 搬過來。跟上面單檔深度診斷／續抱診斷不同，
 * 這兩個都不查 Goodinfo／TWSE 財報，只用戰報本身已經算好的量化欄位做橫向比較
 * （見 lib/aiDiagnosis.js 的 `buildShortlistPrompt_`／`buildTopPicksPrompt_`
 * 開頭說明），維持低成本。
 */

/** `runAiTopPicks`／每日候選名單橫向比較都需要「最新一次戰報全部候選，依
 *  Armor_Score 高到低排序」這份清單——跟 apps-script 版 getLatestReportCandidates_
 *  同一個邏輯，先用 collectionGroup 查詢找出「最新是哪一天」（跟
 *  fetchLatestSignalsByCode_／Dashboard 共用同一組 collectionGroup 索引），
 *  再用一般的 collection 查詢（不是 collectionGroup）把那一天的全部訊號依
 *  armorScore 排序讀出來——COLLECTION（不是 COLLECTION_GROUP）scope 的單欄
 *  orderBy 是 Firestore 自動索引涵蓋的範圍，不需要額外部署索引。 */
async function fetchLatestReportCandidates_() {
  const db = admin.firestore();
  const latestSnap = await db.collectionGroup('signals').orderBy('date', 'desc').limit(1).get();
  if (latestSnap.empty) {
    throw new HttpsError('failed-precondition', '目前沒有任何戰報資料，請先產生一次戰報。');
  }
  const latestDate = latestSnap.docs[0].data().date;
  const snap = await db.collection('reports').doc(latestDate).collection('signals').orderBy('armorScore', 'desc').get();
  const candidates = snap.docs.map(function (d) { return d.data(); });
  if (candidates.length === 0) {
    throw new HttpsError('failed-precondition', '最新一次戰報沒有任何候選股票可以比較。');
  }
  return { latestDate: latestDate, candidates: candidates };
}

/** Top3 橫向推薦的核心邏輯（不含 onCall 的 auth 驗證）——`exports.runAiTopPicks`
 *  （手動「重新掃描 Top3」按鈕）跟 `runDailyAiDiagnosisForTopPicks_`（每日排程）
 *  共用。跟單檔深度診斷不同，`diagnosisType: 'top3'` 這筆文件的
 *  `armorScore`/`strategy`/`verdict` 都是空值——這是「全市場橫向比較」的單一
 *  結論，不是某一檔股票的診斷，`code` 固定存常數 `'TOP3'`，文件 ID 用日期
 *  區分（同一天重跑會覆蓋同一筆，不同天各自留一筆歷史）。 */
async function runTopPicksCore_(appConfig, candidatesResult) {
  const timestampLabel = utilsLib.timestampLabelTaipei_();
  const userPrompt = aiDiagnosisLib.buildTopPicksPrompt_(candidatesResult.candidates, timestampLabel);
  const provider = appConfig.aiProvider === 'gemini' ? 'gemini' : 'claude';
  const llmResult = await callLlm_(aiDiagnosisLib.AI_TOP_PICKS_SYSTEM_PROMPT, userPrompt, provider, {
    claude: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY
  });
  const cost = aiDiagnosisLib.calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens, {
    cacheCreationInputTokens: llmResult.cacheCreationInputTokens,
    cacheReadInputTokens: llmResult.cacheReadInputTokens
  }, appConfig.pricing);

  const record = {
    date: candidatesResult.latestDate,
    code: 'TOP3',
    name: '（全市場橫向比較）',
    armorScore: null,
    strategy: '',
    verdict: '',
    diagnosisType: 'top3',
    content: llmResult.text,
    timestamp: timestampLabel
  };
  await admin.firestore().collection('ai_diagnosis').doc('TOP3_' + candidatesResult.latestDate + '_top3').set(record);
  await logAiUsage_('TOP3_SCAN', llmResult, cost, timestampLabel);

  return Object.assign({}, record, {
    cost: utilsLib.round_(cost, 4),
    candidateCount: candidatesResult.candidates.length,
    groundingDisabled: !!llmResult.groundingDisabled
  });
}

/** 前端「重新掃描 Top3」按鈕：對最新一次戰報的全部候選做一次橫向比較，回傳
 *  結果（前端也可以直接用 Firestore client SDK 讀 `ai_diagnosis` 的快取結果，
 *  不用每次打開頁面就呼叫這支——見 Dashboard 的 Top3PicksCard.vue）。 */
exports.runAiTopPicks = onCall(
  Object.assign({ secrets: ['GEMINI_API_KEY'] }, RUNTIME_OPTS_),
  async function (request) {
    assertOwnerAuth_(request);
    const appConfig = await fetchAppConfig_();
    const candidatesResult = await fetchLatestReportCandidates_();
    return runTopPicksCore_(appConfig, candidatesResult);
  }
);

/** 每日排程用：先用 AI 橫向比較（不查財報）從候選清單篩出一份大小為 topN 的
 *  名單，取出代號後，把這份名單「全部」送進 `runDeepDiagnosisForCode_` 做完整
 *  深度診斷——跟 apps-script 版 runAiShortlist_ + extractShortlistCodes_ +
 *  runAiDiagnosis(codes) 同一套三段邏輯。單一股票深度診斷失敗（例如 Goodinfo
 *  抓取逾時）不影響名單裡其他股票，逐檔包 try/catch，跟 apps-script 版
 *  runAiDiagnosis 內部迴圈的錯誤隔離粒度一致。 */
async function runShortlistAndDeepDiagnosis_(appConfig, candidatesResult, topN) {
  const timestampLabel = utilsLib.timestampLabelTaipei_();
  const systemPrompt = aiDiagnosisLib.AI_SHORTLIST_SYSTEM_PROMPT_TEMPLATE.replace(/__COUNT__/g, String(topN));
  const userPrompt = aiDiagnosisLib.buildShortlistPrompt_(candidatesResult.candidates, timestampLabel, topN);
  const provider = appConfig.aiProvider === 'gemini' ? 'gemini' : 'claude';
  const llmResult = await callLlm_(systemPrompt, userPrompt, provider, {
    claude: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY
  });

  const codes = aiDiagnosisLib.extractShortlistCodes_(llmResult.text, topN);
  if (codes.length === 0) {
    throw new Error('無法從 AI 候選名單中取出股票代號，原始回應開頭：「' +
      String(llmResult.text || '').slice(0, 150).replace(/\n/g, ' ') + '」');
  }

  const shortlistCost = aiDiagnosisLib.calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens, {
    cacheCreationInputTokens: llmResult.cacheCreationInputTokens,
    cacheReadInputTokens: llmResult.cacheReadInputTokens
  }, appConfig.pricing);
  await logAiUsage_('SHORTLIST_SCAN', llmResult, shortlistCost, timestampLabel);

  const results = [];
  for (const code of codes) {
    try {
      results.push(await runDeepDiagnosisForCode_(appConfig, code));
    } catch (e) {
      results.push({ ok: false, code: code, error: String(e.message || e) });
    }
  }
  return { shortlistText: llmResult.text, codes: codes, results: results };
}

/**
 * 每日排程呼叫（`generateDailyReportScheduled` 寫完戰報之後，如果
 * `config/app.aiDailyEnabled` 開著）：Top3 橫向推薦跟候選名單橫向比較+逐檔深度
 * 診斷是兩件各自獨立、互不影響的事，各自包 try/catch，一邊失敗不影響另一邊——
 * 跟 apps-script 版 runDailyAiDiagnosisForTopPicks 同一個設計。Top3 只有一次
 * LLM 呼叫、耗時固定且短，優先跑完；候選名單橫向比較+逐檔深度診斷耗時隨
 * `aiDailyTopN` 增加，放在後面。兩邊共用同一次 `fetchLatestReportCandidates_`
 * 讀取結果，不用各自重讀重排一次 Reports。
 *
 * 跟 apps-script 版的差異：不帶 `budgetDeadline` 到處檢查提早跳過剩餘代號——
 * 那是 Apps Script 6 分鐘硬性執行上限逼出來的設計，這裡的逾時上限是
 * `generateDailyReportScheduled` 自己宣告的 540 秒，topN 夾在 3~10 的情況下
 * 不會真的撞到，不需要那套複雜度。
 */
async function runDailyAiDiagnosisForTopPicks_(appConfig) {
  let candidatesResult = null;
  try {
    candidatesResult = await fetchLatestReportCandidates_();
  } catch (e) { /* 留給下面兩段各自重讀一次、各自記錄自己的錯誤訊息 */ }

  const topPicks = { ok: false, error: null };
  try {
    const cr = candidatesResult || await fetchLatestReportCandidates_();
    topPicks.ok = true;
    topPicks.result = await runTopPicksCore_(appConfig, cr);
  } catch (e) {
    topPicks.error = String(e.message || e);
  }

  const shortlist = { ok: false, error: null };
  try {
    const cr = candidatesResult || await fetchLatestReportCandidates_();
    const topN = Math.max(3, Math.min(10, appConfig.aiDailyTopN || 5));
    shortlist.ok = true;
    shortlist.result = await runShortlistAndDeepDiagnosis_(appConfig, cr, topN);
  } catch (e) {
    shortlist.error = String(e.message || e);
  }

  return { topPicks: topPicks, shortlist: shortlist };
}

/**
 * data: {code}。對「目前持有中」的一檔股票跑一次持股續抱診斷（diagnosisType='hold'）
 * ——跟 runAiDiagnosis 共用同一套 Goodinfo／TWSE 財報抓取、Claude/Gemini 呼叫、費用
 * 估算邏輯，差別只在：(1) system prompt 換成 AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT
 * （決策基準是體質變化，不是損益），(2) `buildDiagnosisPrompt_` 多帶一個 `holding`
 * 參數（加權平均成本／持有天數／目前損益%，僅供背景參考），(3) 寫入 Firestore 的文件
 * ID 後綴是 `_hold` 不是 `_deep`（同一天同一檔可以同時有深度診斷跟續抱診斷兩筆紀錄，
 * 互不覆蓋，見 firestore/schema.md §4）。
 *
 * code 必須是目前「持有中」的股票——沒有持股就沒有成本/損益可以注入，拋
 * `failed-precondition`，不是模糊的 `INTERNAL`。
 */
exports.runPortfolioHoldDiagnosis = onCall(
  Object.assign({ secrets: ['GEMINI_API_KEY'] }, RUNTIME_OPTS_),
  async function (request) {
    assertOwnerAuth_(request);
    const data = request.data || {};
    if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
    const code = utilsLib.zfill4(String(data.code).trim());

    const [appConfig, lotDocs] = await Promise.all([fetchAppConfig_(), fetchPortfolioLots_()]);
    const portfolioMap = portfolio.buildPortfolioMap_(lotDocs);
    if (!portfolioMap[code]) {
      throw new HttpsError('failed-precondition', '目前沒有持有 ' + code + '，請確認「持股庫存」裡有這一筆持有中的紀錄。');
    }

    const [signalDocs, bqInfo] = await Promise.all([
      fetchSignalHistoryForCode_(code),
      fetchBqInfoForCodes_(appConfig.bigQuery, [code])
    ]);
    const row = signalDocs[0];
    if (!row) {
      throw new HttpsError('not-found', '在戰報裡找不到 ' + code + ' 的資料，請先確認它出現在某一天的戰報中。');
    }
    const latestClose = bqInfo[code] ? bqInfo[code].close : null;
    const holding = buildHoldingInfo_(portfolioMap, code, latestClose);

    const timestampLabel = utilsLib.timestampLabelTaipei_();
    const [goodinfoText, twseDatasets] = await Promise.all([
      fetchGoodinfoText_(code),
      fetchTwseOfficialFinancialsDatasets_()
    ]);
    const twseOfficialText = aiDiagnosisLib.buildTwseOfficialFinancialsTextForCode_(code, twseDatasets);
    const userPrompt = aiDiagnosisLib.buildDiagnosisPrompt_(row, goodinfoText, twseOfficialText, timestampLabel, holding);

    const provider = appConfig.aiProvider === 'gemini' ? 'gemini' : 'claude';
    const llmResult = await callLlm_(aiDiagnosisLib.AI_HOLDING_DIAGNOSIS_SYSTEM_PROMPT, userPrompt, provider, {
      claude: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY
    });

    const diagnosisText = llmResult.text;
    const verdict = aiDiagnosisLib.extractVerdict_(diagnosisText);
    const cost = aiDiagnosisLib.calcCost_(llmResult.provider, llmResult.inputTokens, llmResult.outputTokens, {
      cacheCreationInputTokens: llmResult.cacheCreationInputTokens,
      cacheReadInputTokens: llmResult.cacheReadInputTokens
    }, appConfig.pricing);

    const record = {
      date: row.date,
      code: code,
      name: row.name || '',
      armorScore: row.armorScore,
      strategy: row.strategy,
      verdict: verdict,
      diagnosisType: 'hold',
      content: diagnosisText,
      timestamp: timestampLabel
    };
    await admin.firestore().collection('ai_diagnosis').doc(code + '_' + row.date + '_hold').set(record);
    await logAiUsage_(code, llmResult, cost, timestampLabel);

    return Object.assign({}, record, { cost: utilsLib.round_(cost, 4), groundingDisabled: !!llmResult.groundingDisabled });
  }
);

/**
 * 給 Admin 頁面「AI 設定」卡片顯示用：只回傳「有沒有設定」，絕不回傳金鑰本身
 * ——跟 apps-script 版 getAiSettings() 的 hasClaudeKey/hasGeminiKey 同一個
 * 設計。要檢查 `process.env.GEMINI_API_KEY` 有沒有值，一樣要宣告 `secrets`
 * 選項，不然 Secret Manager 的值不會被注入這支函式的執行環境（跟
 * runAiDiagnosis 是分開的兩支函式，各自獨立宣告）。
 *
 * 刻意不宣告 `ANTHROPIC_API_KEY`（理由跟 runAiDiagnosis 同一段說明一致——
 * 目前只用 Gemini，沒必要逼自己建一個不會用到的密鑰只為了讓部署通過），
 * `hasClaudeKey` 固定回傳 `false`，不是因為查過沒設定，是這支函式沒有權限
 * 讀取那個密鑰的值（即使之後真的設定了也一樣會回傳 false，直到把
 * `'ANTHROPIC_API_KEY'` 加回兩支函式的 `secrets` 陣列重新部署）。
 */
exports.getAiKeyStatus = onCall(
  Object.assign({ secrets: ['GEMINI_API_KEY'] }, RUNTIME_OPTS_),
  async function (request) {
    assertOwnerAuth_(request);
    return {
      hasClaudeKey: false,
      hasGeminiKey: !!process.env.GEMINI_API_KEY
    };
  }
);

/**
 * data: {days?}（預設 30）。給 Admin 頁面顯示最近 N 天的 AI 呼叫次數/tokens/
 * 預估費用——跟 apps-script 版 getAiUsageSummary 同一個用途，資料來源換成
 * Firestore 的 `ai_usage` collection（見 `logAiUsage_` 的說明）。只用
 * `.where('date', '>=', cutoffStr)` 單一不等式查詢（不加 orderBy，排序交給
 * `aiUsageLib.buildAiUsageSummary_` 在記憶體裡做）——COLLECTION scope 的
 * 單欄不等式查詢是 Firestore 自動索引涵蓋的範圍，不需要額外部署索引。
 */
exports.getAiUsageSummary = onCall(RUNTIME_OPTS_, async function (request) {
  assertOwnerAuth_(request);
  const data = request.data || {};
  const days = data.days || 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const snap = await admin.firestore().collection('ai_usage').where('date', '>=', cutoffStr).get();
  const records = snap.docs.map(function (d) { return d.data(); });
  const nowDateStr = utilsLib.todayStrTaipei_();
  return aiUsageLib.buildAiUsageSummary_(records, days, nowDateStr);
});
