/**
 * index.js
 * Cloud Functions 進入點：把 lib/ 底下已經驗證過的純運算（lib/analysis.js／
 * lib/reportPipeline.js 等）接上真正的 I/O——讀 BigQuery 的 History（不動，
 * Phase 2 的結論是這張表留在 BigQuery，見 README「每天累積的股價及市場資料
 * 在哪裡遷移」）、讀 Firestore 的 `portfolio_lots`／`config/app`（Phase 2
 * 已經遷移完成的資料），算完寫進 Firestore `reports/{date}/signals/{code}`
 * （對照 firestore/schema.md §3）。
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
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { BigQuery } = require('@google-cloud/bigquery');

const config = require('./lib/config');
const bigquery = require('./lib/bigquery');
const reportPipeline = require('./lib/reportPipeline');

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
  const sql = bigquery.buildHistoryRangeSql_(sourceRef, cutoffStr, null);
  const [rows] = await client.query({ query: sql });
  // mapBqRowToHistoryRow_ 回傳 null 代表 stock_id 清洗後不是合法代號，整列捨棄
  // （見 lib/bigquery.js 的說明——這是真實遇過的 OOM 事故的直接修正，不是預防性
  // 寫法）。
  return rows.map(bigquery.mapBqRowToHistoryRow_).filter(function (r) { return r !== null; });
}

/** 把 reportPipeline.buildReport_ 算出來的 reportDocs 寫進 Firestore
 *  `reports/{date}/signals/{code}`。latestDate 是 null（完全查無 History 資料）
 *  時什麼都不寫——跟 apps-script 版 runAnalysisAndSave() 的「沒有可用資料就不寫」
 *  邏輯一致，不會用空值覆蓋掉昨天本來好好的戰報。 */
async function writeReportDocs_(result) {
  if (!result.latestDate) return;
  const db = admin.firestore();
  const batch = db.batch();
  result.reportDocs.forEach(function (doc) {
    var fields = Object.assign({}, doc);
    delete fields.id;
    batch.set(db.collection('reports').doc(result.latestDate).collection('signals').doc(doc.code), fields);
  });
  await batch.commit();
}

/** 真正做事的地方：排程跟手動觸發的 HTTPS endpoint 都呼叫這支，確保兩邊行為
 *  完全一致（跟 apps-script 版 runAnalysisAndSave() 被排程跟手動按鈕共用是
 *  同一個設計）。 */
async function runDailyAnalysis_() {
  const appConfig = await fetchAppConfig_();
  const [historyRows, lotDocs] = await Promise.all([
    fetchHistoryRows_(appConfig.bigQuery),
    fetchPortfolioLots_()
  ]);
  const result = reportPipeline.buildReport_(historyRows, lotDocs, appConfig.screeningStrategy, {});
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

/** 每個交易日台股收盤後觸發（15:00 UTC = 台北時間 23:00，History 當天資料應該
 *  已經更新完），取代 apps-script 版 scheduledDailyFetch 裡「算戰報」這一步
 *  （不含補抓 History/同步產業對照表等其他步驟，那些還沒遷移）。 */
exports.generateDailyReportScheduled = onSchedule(
  Object.assign({ schedule: '0 15 * * 1-5' }, RUNTIME_OPTS_),
  async function () {
    await runDailyAnalysis_();
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
