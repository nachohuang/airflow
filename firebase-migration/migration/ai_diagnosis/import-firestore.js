#!/usr/bin/env node
/**
 * import-firestore.js
 * 讀 export-sheets.gs 匯出的 AiDiagnosis JSON，寫進 Firestore
 * ai_diagnosis/{code}_{date}_{diagnosisType}。需要先完成 Phase 0（見
 * README），跟 watchlist/portfolio 的 import-firestore.js 同一套流程。
 *
 * 用法（本機，服務帳戶金鑰）：
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     node import-firestore.js [--dry-run] <export.json 路徑>
 *
 * 用法（Cloud Shell，已經 gcloud auth application-default login 過）：
 *   node import-firestore.js [--dry-run] <export.json 路徑>
 *
 * --dry-run：只印出會寫入的內容，不實際呼叫 Firestore，先確認轉換結果對不對
 * 再真的跑——遷移真實資料前務必先跑過一次 dry-run。
 */
var fs = require('fs');
var path = require('path');
var transformAiDiagnosisRow = require('./transform').transformAiDiagnosisRow;

function main() {
  var args = process.argv.slice(2);
  var dryRun = args.indexOf('--dry-run') !== -1;
  var filePath = args.filter(function (a) { return a.indexOf('--') !== 0; })[0];
  if (!filePath) {
    console.error('用法：node import-firestore.js [--dry-run] <export.json 路徑>');
    process.exit(1);
    return;
  }

  var raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  var migratedAtIso = new Date().toISOString();
  var docs = [];
  var skipped = [];
  (raw.rows || []).forEach(function (row, i) {
    var doc = transformAiDiagnosisRow(row, migratedAtIso);
    if (!doc) { skipped.push({ index: i, row: row }); return; }
    docs.push(doc);
  });

  console.log('來源檔案：' + filePath);
  console.log('來源筆數：' + (raw.rows || []).length);
  console.log('轉換成功：' + docs.length + '　跳過（代號或日期空白）：' + skipped.length);
  if (skipped.length) {
    console.log('跳過的列（請人工檢查來源資料）：' + JSON.stringify(skipped, null, 2));
  }

  if (dryRun) {
    console.log('--dry-run，不寫入 Firestore。以下是會寫入的內容：');
    console.log(JSON.stringify(docs, null, 2));
    return;
  }

  if (docs.length === 0) {
    console.log('沒有任何一筆可以寫入，結束。');
    return;
  }

  var db = require('../lib/firebase-init').getFirestore();

  // AiDiagnosis 的筆數會隨時間累積（每天每檔股票都可能新增一筆），單批
  // commit() 上限是 500 筆操作——真實資料量大時分批寫入，避免超過上限。
  var BATCH_SIZE = 400;
  var batches = [];
  for (var i = 0; i < docs.length; i += BATCH_SIZE) {
    batches.push(docs.slice(i, i + BATCH_SIZE));
  }

  function writeBatch(batchIndex) {
    if (batchIndex >= batches.length) {
      console.log('已寫入 ' + docs.length + ' 筆到 Firestore ai_diagnosis collection。');
      console.log('接下來請跑 validate.js 做資料品質核對。');
      return;
    }
    var batch = db.batch();
    batches[batchIndex].forEach(function (doc) {
      var id = doc.id;
      var fields = {};
      Object.keys(doc).forEach(function (k) { if (k !== 'id') fields[k] = doc[k]; });
      batch.set(db.collection('ai_diagnosis').doc(id), fields);
    });
    batch.commit().then(function () {
      writeBatch(batchIndex + 1);
    }).catch(function (err) {
      console.error('寫入失敗（第 ' + (batchIndex + 1) + ' 批）：', err);
      process.exit(1);
    });
  }

  writeBatch(0);
}

main();
