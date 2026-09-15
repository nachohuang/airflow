#!/usr/bin/env node
/**
 * validate.js
 * Phase 2 spike：讀來源 JSON + 查詢 Firestore，跑 checks.js 的驗證邏輯，印出報告。
 * 檢查邏輯本身（checks.js）不需要雲端憑證就能單元測試，這支只是負責「怎麼把
 * 兩份資料抓進記憶體再丟給檢查邏輯」的薄殼。
 *
 * 用法：
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     node validate.js <export.json 路徑>
 */
var fs = require('fs');
var path = require('path');
var validateWatchlistMigration = require('./checks').validateWatchlistMigration;

function main() {
  var filePath = process.argv[2];
  if (!filePath) {
    console.error('用法：node validate.js <export.json 路徑>');
    process.exit(1);
    return;
  }
  var raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));

  var admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  var db = admin.firestore();

  db.collection('watchlist').get().then(function (snapshot) {
    var firestoreDocs = snapshot.docs.map(function (d) {
      var data = d.data();
      data.id = d.id;
      return data;
    });
    var report = validateWatchlistMigration(raw.rows || [], firestoreDocs);

    console.log('來源不重複代號：' + report.sourceCount + '　Firestore 文件數：' + report.firestoreCount);
    console.log('結果：' + (report.ok ? '✅ 通過' : '❌ 有問題，見下方明細'));
    report.issues.forEach(function (issue) {
      console.log('[' + (issue.level === 'error' ? '錯誤' : '警告') + '] ' + issue.check + '：' + issue.detail);
    });
    process.exit(report.ok ? 0 : 1);
  }).catch(function (err) {
    console.error('查詢 Firestore 失敗：', err);
    process.exit(1);
  });
}

main();
