/**
 * checks.js
 * 純函式：資料遷移品質檢查邏輯，跟 watchlist/checks.js 同樣的分工原則——只吃兩個
 * 陣列（來源 rows、Firestore 讀回來的 docs），回傳一份檢查報告，不需要任何雲端
 * 憑證就能單元測試。對照〈選股引擎遷移藍圖〉§05：列數核對、欄位型別檢查、唯一鍵
 * 完整性、交叉參照檢查、欄位內容比對，再加上 Portfolio 特有的「金額校驗」——
 * 用 apps-script/src/Portfolio.gs 既有的 aggregateLots_ 邏輯，各自對來源跟
 * Firestore 重新算一次加權平均成本，兩邊算出來的數字要一致，才能確定遷移沒有
 * 把股數/價格這種數字欄位悄悄轉壞。
 */
var transform = require('./transform');
var zfill4 = transform.zfill4;
var parseNumber = transform.parseNumber;
var translateStatus = transform.translateStatus;

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** 跟 apps-script/src/Portfolio.gs 的 aggregateLots_ 邏輯一致：只看「持有中」的
 *  lot，用股數加權平均成本。rows 是已經正規化過的物件陣列（number 型別的
 *  buyPrice/shares，不是原始 Sheets 字串）。 */
function aggregateHoldingLots_(rows) {
  var byCode = {};
  rows.forEach(function (r) {
    if (r.status !== 'holding') return;
    if (!byCode[r.code]) byCode[r.code] = { totalShares: 0, totalCost: 0 };
    var shares = r.shares || 0;
    var price = r.buyPrice || 0;
    byCode[r.code].totalShares += shares;
    byCode[r.code].totalCost += shares * price;
  });
  var result = {};
  Object.keys(byCode).forEach(function (code) {
    var agg = byCode[code];
    result[code] = {
      totalShares: agg.totalShares,
      avgCost: agg.totalShares > 0 ? round4(agg.totalCost / agg.totalShares) : 0
    };
  });
  return result;
}

/**
 * sourceRows：原始 Sheets 匯出的列（中文鍵名，跟 export-sheets.gs 的輸出一致）。
 * firestoreDocs：從 Firestore portfolio_lots collection 讀回來的文件，每筆要帶
 * `id`（文件 ID）跟展開後的欄位（transactionId/code/name/buyDate/buyPrice/
 * shares/note/status/sellDate/sellPrice）。
 */
function validatePortfolioMigration(sourceRows, firestoreDocs) {
  var issues = [];

  // 1. 列數核對：來源交易ID是空的列不算數（跟 transformPortfolioRow 的跳過邏輯一致）。
  var validSourceIds = sourceRows
    .map(function (r) { return String(r['交易ID'] || '').trim(); })
    .filter(function (id) { return id; });
  var uniqueSourceIds = {};
  validSourceIds.forEach(function (id) { uniqueSourceIds[id] = true; });
  var sourceCount = Object.keys(uniqueSourceIds).length;
  if (sourceCount !== firestoreDocs.length) {
    issues.push({
      level: 'error', check: '列數核對',
      detail: '來源不重複交易ID ' + sourceCount + ' 筆，Firestore 文件 ' + firestoreDocs.length + ' 筆，不一致'
    });
  }

  // 2. 唯一鍵完整性：文件 ID 本身就是 transactionId，防禦性檢查文件內容的
  //    transactionId 欄位是否跟文件 ID 一致。
  firestoreDocs.forEach(function (doc) {
    if (doc.id !== doc.transactionId) {
      issues.push({
        level: 'error', check: '文件ID與transactionId欄位一致性',
        detail: '文件 ID「' + doc.id + '」與 transactionId 欄位「' + doc.transactionId + '」不一致'
      });
    }
  });

  // 3. 型別檢查：字串欄位跟數字欄位分開檢查。buyPrice/shares 是必填（每筆持股一定
  //    要有買進價格跟股數），sellDate/sellPrice 只有已賣出的部位才會有值，未賣出
  //    時允許是 null。
  firestoreDocs.forEach(function (doc) {
    ['transactionId', 'code', 'name', 'buyDate', 'note', 'status'].forEach(function (field) {
      if (typeof doc[field] !== 'string') {
        issues.push({
          level: 'error', check: '欄位型別',
          detail: '文件 ' + doc.id + ' 的 ' + field + ' 欄位型別是 ' + typeof doc[field] + '，應該是 string'
        });
      }
    });
    ['buyPrice', 'shares'].forEach(function (field) {
      if (typeof doc[field] !== 'number' || isNaN(doc[field])) {
        issues.push({
          level: 'error', check: '欄位型別',
          detail: '文件 ' + doc.id + ' 的 ' + field + ' 欄位不是有效數字（' + JSON.stringify(doc[field]) + '）'
        });
      }
    });
    ['sellDate', 'sellPrice'].forEach(function (field) {
      var v = doc[field];
      var expected = field === 'sellDate' ? 'string' : 'number';
      if (v !== null && typeof v !== expected) {
        issues.push({
          level: 'error', check: '欄位型別',
          detail: '文件 ' + doc.id + ' 的 ' + field + ' 欄位型別是 ' + typeof v + '，應該是 ' + expected + ' 或 null'
        });
      }
    });
  });

  // 4. 代號格式：一律 4 碼補零，跟 App 其餘部分保持一致。
  firestoreDocs.forEach(function (doc) {
    if (!/^\d{4}$/.test(doc.code)) {
      issues.push({
        level: 'error', check: '代號格式',
        detail: '文件 ' + doc.id + ' 的 code「' + doc.code + '」不是 4 碼數字'
      });
    }
  });

  // 5. 狀態列舉：只能是 holding 或 sold，翻譯邏輯本身若有漏網會在這裡被抓到。
  firestoreDocs.forEach(function (doc) {
    if (doc.status !== 'holding' && doc.status !== 'sold') {
      issues.push({
        level: 'error', check: '狀態列舉',
        detail: '文件 ' + doc.id + ' 的 status「' + doc.status + '」不是 holding 或 sold'
      });
    }
  });

  // 6. 已賣出的部位該有 sellDate/sellPrice，持有中的部位不該有——降級成警告，
  //    因為這是「資料本身可能本來就不乾淨」而不是遷移邏輯的錯。
  firestoreDocs.forEach(function (doc) {
    if (doc.status === 'sold' && (doc.sellDate == null || doc.sellPrice == null)) {
      issues.push({
        level: 'warning', check: '已賣出部位缺賣出資訊',
        detail: '文件 ' + doc.id + ' 狀態是已賣出，但 sellDate/sellPrice 有缺'
      });
    }
  });

  // 7. 交叉比對：來源每個交易ID都該在 Firestore 找得到、內容逐筆一致。
  var bySourceId = {};
  sourceRows.forEach(function (r) {
    var id = String(r['交易ID'] || '').trim();
    if (id) bySourceId[id] = r;
  });
  firestoreDocs.forEach(function (doc) {
    var src = bySourceId[doc.transactionId];
    if (!src) {
      issues.push({ level: 'error', check: '來源比對', detail: 'Firestore 文件 ' + doc.id + ' 在來源資料裡找不到對應列' });
      return;
    }
    if (zfill4(src['證券代號']) !== doc.code) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的代號不一致：來源「' + src['證券代號'] + '」vs Firestore「' + doc.code + '」' });
    }
    if (String(src['證券名稱'] || '') !== doc.name) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的名稱不一致：來源「' + src['證券名稱'] + '」vs Firestore「' + doc.name + '」' });
    }
    if (String(src['備註'] || '') !== doc.note) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的備註不一致：來源「' + src['備註'] + '」vs Firestore「' + doc.note + '」' });
    }
    if (translateStatus(src['狀態']) !== doc.status) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的狀態不一致：來源「' + src['狀態'] + '」vs Firestore「' + doc.status + '」' });
    }
    var srcBuyPrice = parseNumber(src['買進價格']);
    if (srcBuyPrice !== doc.buyPrice) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的買進價格不一致：來源「' + srcBuyPrice + '」vs Firestore「' + doc.buyPrice + '」' });
    }
    var srcShares = parseNumber(src['股數']);
    if (srcShares !== doc.shares) {
      issues.push({ level: 'error', check: '欄位內容比對', detail: doc.id + ' 的股數不一致：來源「' + srcShares + '」vs Firestore「' + doc.shares + '」' });
    }
  });

  // 8. 金額校驗：持有中部位依代號分組，重算加權平均成本（跟 Portfolio.gs 的
  //    aggregateLots_ 同一套邏輯），來源跟 Firestore 兩邊算出來的數字要一致——
  //    這一項不是逐列比對，是用來抓「單列都對、但彙總邏輯用到的數字型別/精度
  //    悄悄跑掉」這種比較隱蔽的問題。
  var sourceNormalized = sourceRows.map(function (r) {
    return {
      code: zfill4(r['證券代號']),
      status: translateStatus(r['狀態']),
      buyPrice: parseNumber(r['買進價格']) || 0,
      shares: parseNumber(r['股數']) || 0
    };
  });
  var sourceAgg = aggregateHoldingLots_(sourceNormalized);
  var firestoreAgg = aggregateHoldingLots_(firestoreDocs);
  var allCodes = {};
  Object.keys(sourceAgg).forEach(function (c) { allCodes[c] = true; });
  Object.keys(firestoreAgg).forEach(function (c) { allCodes[c] = true; });
  Object.keys(allCodes).forEach(function (code) {
    var src = sourceAgg[code] || { totalShares: 0, avgCost: 0 };
    var fs = firestoreAgg[code] || { totalShares: 0, avgCost: 0 };
    if (src.totalShares !== fs.totalShares) {
      issues.push({
        level: 'error', check: '金額校驗（總股數）',
        detail: code + ' 持有中總股數不一致：來源 ' + src.totalShares + ' vs Firestore ' + fs.totalShares
      });
    }
    if (src.avgCost !== fs.avgCost) {
      issues.push({
        level: 'error', check: '金額校驗（加權平均成本）',
        detail: code + ' 加權平均成本不一致：來源 ' + src.avgCost + ' vs Firestore ' + fs.avgCost
      });
    }
  });

  return {
    ok: issues.filter(function (i) { return i.level === 'error'; }).length === 0,
    sourceCount: sourceCount,
    firestoreCount: firestoreDocs.length,
    issues: issues
  };
}

module.exports = { validatePortfolioMigration: validatePortfolioMigration, aggregateHoldingLots_: aggregateHoldingLots_ };
