#!/usr/bin/env bash
# 【TWSE 法人動能選股 App】把 src/ 底下最新程式碼推上 Apps Script，
# 並（選擇性）更新正式 /exec 網址的部署版本。
#
# 檔名特地取 deploy-stock.sh（不是通用的 deploy.sh），避免跟你其他專案的 deploy 指令搞混。
#
# 用法（在已經跑過 `clasp login` 的環境，例如 Cloud Shell）：
#   ./deploy-stock.sh                              只更新程式碼本體（/dev 測試網址會是最新版）
#   CLASP_DEPLOYMENT_ID=xxxx ./deploy-stock.sh     同時更新正式 /exec 網址（手機在用的那個網址）
#
# CLASP_DEPLOYMENT_ID 用 `clasp deployments` 查，是「網頁應用程式」那個部署的 ID，不是 script ID。

set -euo pipefail
cd "$(dirname "$0")"

echo "==> 【TWSE 法人動能選股 App】部署開始（目錄：$(pwd)）"

if ! command -v clasp >/dev/null 2>&1; then
  echo "❌ 找不到 clasp。請先安裝： npm install -g @google/clasp"
  exit 1
fi

if [ ! -f .clasp.json ]; then
  echo "❌ 找不到 .clasp.json。第一次使用請先看 README.md 的「建立 Apps Script 專案」章節："
  echo "   1) clasp login"
  echo "   2) 在跟這個 repo 無關的暫存資料夾跑 clasp create 拿到 scriptId（避免污染 src/）"
  echo "   3) 複製 .clasp.json.example 成 .clasp.json，貼上 scriptId，rootDir 保持 \"src\""
  exit 1
fi

echo "==> clasp push（更新程式碼本體 / HEAD 版本，/dev 測試網址會立刻反映最新版）"
clasp push -f

if [ -n "${CLASP_DEPLOYMENT_ID:-}" ]; then
  echo "==> 更新既有部署 ${CLASP_DEPLOYMENT_ID}，讓正式 /exec 網址也套用最新版本"
  clasp deploy -i "$CLASP_DEPLOYMENT_ID" -d "auto deploy $(date '+%Y-%m-%d %H:%M:%S')"
else
  echo "ℹ️  沒有設定 CLASP_DEPLOYMENT_ID，正式 /exec 網址還是舊版本。"
  echo "    用 'clasp deployments' 查 deploymentId，之後可以："
  echo "    CLASP_DEPLOYMENT_ID=你的deploymentId ./deploy-stock.sh"
fi

echo "==> 完成"
