#!/usr/bin/env node
/**
 * validate.js
 * 讀來源 JSON + 查詢 Firestore，跑 checks.js 的兩套驗證邏輯（config/app 跟
 * jobs/{jobKey} 分開驗證），印出報告。檢查邏輯本身（checks.js）不需要雲端
 * 憑證就能單元測試，這支只是負責「怎麼把兩份資料抓進記憶體再丟給檢查邏輯」
 * 的薄殼。
 *
 * 用法（本機，服務帳戶金鑰）：
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     node validate.js <export.json 路徑>
 *
 * 用法（Cloud Shell，已經 gcloud auth application-default login 過）：
 *   node validate.js <export.json 路徑>
 */
var fs = require('fs');
var path = require('path');
var checks = require('./checks');
var validateConfigAppMigration = checks.validateConfigAppMigration;
var validateJobsMigration = checks.validateJobsMigration;

function printReport(label, report) {
  console.log(label + '：' + (report.ok ? '✅ 通過' : '❌ 有問題，見下方明細'));
  report.issues.forEach(function (issue) {
    console.log('[' + (issue.level === 'error' ? '錯誤' : '警告') + '] ' + issue.check + '：' + issue.detail);
  });
}

function main() {
  var filePath = process.argv[2];
  if (!filePath) {
    console.error('用法：node validate.js <export.json 路徑>');
    process.exit(1);
    return;
  }
  var raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));

  var db = require('../lib/firebase-init').getFirestore();

  Promise.all([
    db.collection('config').doc('app').get(),
    db.collection('jobs').get()
  ]).then(function (results) {
    var configSnap = results[0];
    var jobsSnap = results[1];

    var firestoreConfigDoc = configSnap.exists ? configSnap.data() : null;
    var firestoreJobDocs = jobsSnap.docs.map(function (d) {
      var data = d.data();
      data.id = d.id;
      return data;
    });

    var configReport = validateConfigAppMigration(raw.configProps || {}, firestoreConfigDoc);
    var jobsReport = validateJobsMigration(raw.jobProps || {}, firestoreJobDocs);

    printReport('config/app', configReport);
    printReport('jobs/*（' + firestoreJobDocs.length + ' 份文件）', jobsReport);

    process.exit(configReport.ok && jobsReport.ok ? 0 : 1);
  }).catch(function (err) {
    console.error('查詢 Firestore 失敗：', err);
    process.exit(1);
  });
}

main();
