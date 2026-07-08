#!/usr/bin/env bash
# 把 src/ 底下最新程式碼推上 Apps Script，並（選擇性）更新正式 /exec 網址的部署版本。
#
# 用法（在已經跑過 `clasp login` 的環境，例如 Cloud Shell）：
#   ./deploy.sh                                  只更新程式碼本體（/dev 測試網址會是最新版）
#   CLASP_DEPLOYMENT_ID=xxxx ./deploy.sh         同時更新正式 /exec 網址（手機在用的那個網址）
#
# CLASP_DEPLOYMENT_ID 用 `clasp deployments` 查，是「網頁應用程式」那個部署的 ID，不是 script ID。

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v clasp >/dev/null 2>&1; then
  echo "❌ 找不到 clasp。請先安裝： npm install -g @google/clasp"
  exit 1
fi

if [ ! -f .clasp.json ]; then
  echo "❌ 找不到 .clasp.json。第一次使用請先："
  echo "   1) clasp login"
  echo "   2) 還沒建立 Apps Script 專案的話： clasp create --type webapp --title \"TWSE 法人動能選股\" --rootDir src"
  echo "      已經在網頁上手動建立過的話： 複製 .clasp.json.example 成 .clasp.json 並填入你的 scriptId"
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
  echo "    CLASP_DEPLOYMENT_ID=你的deploymentId ./deploy.sh"
fi

echo "==> 完成"
