#!/usr/bin/env node
/**
 * import-firestore.js
 * Phase 2 spike：讀 export-sheets.gs 匯出的 Watchlist JSON，寫進 Firestore
 * watchlist/{code}。需要先完成 Phase 0（建立 Firebase 專案、下載服務帳戶金鑰）
 * 才能實際執行——這支腳本本身沒有內建憑證，讀環境變數
 * GOOGLE_APPLICATION_CREDENTIALS 指到服務帳戶 JSON 金鑰檔案路徑。
 *
 * 用法：
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     node import-firestore.js [--dry-run] <export.json 路徑>
 *
 * --dry-run：只印出會寫入的內容，不實際呼叫 Firestore，先確認轉換結果對不對
 * 再真的跑——遷移真實資料前務必先跑過一次 dry-run。
 */
var fs = require('fs');
var path = require('path');
var transformWatchlistRow = require('./transform').transformWatchlistRow;

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
    var doc = transformWatchlistRow(row, migratedAtIso);
    if (!doc) { skipped.push({ index: i, row: row }); return; }
    docs.push(doc);
  });

  console.log('來源檔案：' + filePath);
  console.log('來源筆數：' + (raw.rows || []).length);
  console.log('轉換成功：' + docs.length + '　跳過（代號空白）：' + skipped.length);
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

  var admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  var db = admin.firestore();

  var batch = db.batch();
  docs.forEach(function (doc) {
    var id = doc.id;
    var fields = {};
    Object.keys(doc).forEach(function (k) { if (k !== 'id') fields[k] = doc[k]; });
    batch.set(db.collection('watchlist').doc(id), fields);
  });

  batch.commit().then(function () {
    console.log('已寫入 ' + docs.length + ' 筆到 Firestore watchlist collection。');
    console.log('接下來請跑 validate.js 做資料品質核對。');
  }).catch(function (err) {
    console.error('寫入失敗：', err);
    process.exit(1);
  });
}

main();
