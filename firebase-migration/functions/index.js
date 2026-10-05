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

exports.getWatchlist = onCall(RUNTIME_OPTS_, async function () {
  return await buildWatchlistResult_();
});

/** data: {code, name?, note?}。code 必填；已經是持有中的股票會被擋掉（見
 *  lib/watchlist.js assertNotHolding_ 的說明）；同一檔股票重複加入視為更新。 */
exports.addToWatchlist = onCall(RUNTIME_OPTS_, async function (request) {
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
  const data = request.data || {};
  if (!data.code) throw new HttpsError('invalid-argument', '股票代號不可為空');
  const code = utilsLib.zfill4(String(data.code).trim());
  await admin.firestore().collection('watchlist').doc(code).delete();
  return await buildWatchlistResult_();
});

exports.getPortfolio = onCall(RUNTIME_OPTS_, async function () {
  return await buildPortfolioResult_();
});

/**
 * data: {lotId?, code, name?, cost, buyDate?, shares?, note?}。沒帶 lotId 代表
 * 新增一筆全新買進紀錄（isNewHolding），這檔股票既然已經真的買進，就自動把它
 * 從觀察清單移除（對應 apps-script 版 removeFromWatchlistSilently_，同步失敗
 * 不該擋住真正的買進紀錄，見 catch 區塊的說明）；帶 lotId 代表編輯既有的一筆。
 */
exports.savePortfolioItem = onCall(RUNTIME_OPTS_, async function (request) {
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
  const lotId = request.data && request.data.lotId;
  if (!lotId) throw new HttpsError('invalid-argument', '缺少交易ID');
  await admin.firestore().collection('portfolio_lots').doc(lotId).delete();
  return await buildPortfolioResult_();
});

/** data: {code, sellDate, sellPrice}。把某檔股票目前所有「持有中」的紀錄一次性
 *  標記為已賣出（用同一個賣出日期/價格），不支援部分賣出（對應 apps-script 版
 *  closePortfolioPosition 的說明）。 */
exports.closePortfolioPosition = onCall(RUNTIME_OPTS_, async function (request) {
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

exports.getClosedPortfolioHistory = onCall(RUNTIME_OPTS_, async function () {
  const lotDocs = await fetchPortfolioLots_();
  return portfolioOpsLib.buildClosedHistory_(lotDocs);
});
