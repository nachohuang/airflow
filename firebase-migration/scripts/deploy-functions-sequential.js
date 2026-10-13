#!/usr/bin/env node
/**
 * 2026-10-13：`firebase deploy --only functions` 原本一次對全部函式平行發新
 * revision。這個專案只有一個 codebase（firebase.json 的 functions.source
 * 是單一目錄，沒有拆成多個 codebases），所以 Firebase CLI 算的是「整個
 * functions/ 目錄」的來源雜湊——哪怕只改一行跟某支函式完全無關的註解，
 * 全部 37 支函式的雜湊都會跟著變，CLI 判斷成「全部都變了」，一次全部重新
 * 部署（這點已經用這天兩次部署的 log 驗證過：兩次都沒有任何一行
 * "Skipped (No changes detected)"）。
 *
 * 而這 37 支函式裡有 13 支沒有覆寫 cpu（預設 cpu:1），其他都用
 * LIGHT_RUNTIME_OPTS_（cpu:0.25）——光是穩態同時跑滿全部函式，理論用量
 * 就有 13*1 + 24*0.25 = 19 vCPU，已經逼近 us-central1 這個專案 20 vCPU
 * 的硬上限。一次全部平行發新 revision 時，新舊 revision 短暫重疊的瞬間用量
 * 經常超過上限，導致「這次換一批函式撞到 Quota exceeded」的隨機失敗
 * （2026-10-13 同一天兩次部署，失敗的函式名單完全不同，就是這個瞬間用量
 * 隨部署順序變動的證據）。
 *
 * 解法：不改成「只部署有改的函式」（上面已經說明這在單一 codebase 下沒辦法
 * 可靠偵測，只能靠人工猜，風險更高），而是不管改了什麼，一律把全部函式
 * 拆成小批、依序（不是平行）部署——每批跑完、等舊 revision 的 CPU 釋放掉
 * 之後才部署下一批，把瞬間用量壓低到遠低於 20 vCPU。
 *
 * 函式清單直接從 functions/index.js 掃 `exports.xxx =` 宣告產生，不手動
 * 維護清單，之後加減函式不用記得改這支腳本。
 *
 * BATCH_SIZE/PAUSE_BETWEEN_BATCHES_MS 是第一版的保守值，如果之後部署仍然
 * 撞配額，調小 BATCH_SIZE 或拉長 PAUSE；如果每次都很順、想縮短部署時間，
 * 可以調大 BATCH_SIZE——這兩個值本來就是用來換「部署時間」跟「撞配額風險」
 * 的旋鈕，不是算出來的精確值。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BATCH_SIZE = 3;
const PAUSE_BETWEEN_BATCHES_SECONDS = 15;

function extractFunctionNames(indexJsSource) {
  const matches = indexJsSource.matchAll(/^exports\.(\w+)\s*=/gm);
  return Array.from(matches).map(function (m) { return m[1]; });
}

function main() {
  const indexPath = path.join(__dirname, '..', 'functions', 'index.js');
  const src = fs.readFileSync(indexPath, 'utf8');
  const names = extractFunctionNames(src);

  if (names.length === 0) {
    throw new Error('在 functions/index.js 找不到任何 exports.xxx = 宣告，無法算出要部署哪些函式');
  }

  const totalBatches = Math.ceil(names.length / BATCH_SIZE);
  console.log('找到 ' + names.length + ' 支 Cloud Functions，分成 ' + totalBatches + ' 批依序部署：');
  console.log(names.join(', '));

  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE);
    const batchNo = Math.floor(i / BATCH_SIZE) + 1;
    const only = batch.map(function (n) { return 'functions:' + n; }).join(',');

    console.log('\n=== 第 ' + batchNo + '/' + totalBatches + ' 批：' + batch.join(', ') + ' ===');
    execSync('firebase deploy --only ' + only + ' --non-interactive --force', { stdio: 'inherit' });

    if (i + BATCH_SIZE < names.length) {
      console.log('等待 ' + PAUSE_BETWEEN_BATCHES_SECONDS + ' 秒讓舊 revision 釋放 CPU 配額...');
      execSync('sleep ' + PAUSE_BETWEEN_BATCHES_SECONDS);
    }
  }

  console.log('\n全部 ' + names.length + ' 支函式分批部署完成。');
}

if (require.main === module) {
  main();
}

module.exports = { extractFunctionNames: extractFunctionNames };
