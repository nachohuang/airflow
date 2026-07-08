# TWSE 法人動能選股 App（Google Apps Script 版）

把原本在 Google Colab 跑的「v17.0 趨勢共鳴版」台股法人動能選股筆記本，移植成一個能在手機瀏覽器上使用的
Google Apps Script Web App。資料庫改用 Google Sheets，報表/回測結果仍然以檔案形式存進 Google Drive，
並提供一個後台管理頁面管理這些檔案與每日排程。

## 這個 App 有什麼

底部導覽列 5 個分頁：

1. **今日戰報**：對應 Colab Cell 2（v17.0）。每天自動（或手動）算出 `Armor_Score`，
   針對持股給「續抱/止盈止損」建議，針對觀察名單給「趨勢啟動/趨勢領航」買進建議。
2. **持股管理**：對應原本寫死在程式碼裡的 `user_portfolio`，現在可以直接在手機上新增/編輯/刪除持股
   （代號、成本、買進日期），並即時顯示現價損益。
3. **個股分析**：搜尋任一股票代號，看收盤價 + MA5/MA20/MA60 走勢圖、法人買賣超柱狀圖，
   以及這檔股票過去每天的 Armor_Score / 操作策略歷史（「簡單分析個股數據序時變化」）。
4. **回測研究**：對應 Colab Cell 5（v16.10 Alpha Backtest）與 Cell 4（因子相關性掃描），
   可以指定日期區間跑一次回測或因子相關性分析，結果也能一鍵存成 CSV。
5. **後台管理**：
   - 每日自動抓資料的**排程時間**可調（預設 20:30，證交所收盤資料公告時間如果變動可以自己改）
   - 可設定**六日不執行**、可新增**臨時停跑日**（颱風假之類）
   - **執行紀錄**：每次自動/手動執行的成功/失敗/略過都看得到
   - **檔案管理**：瀏覽/刪除 Drive 上「歷史封存」「每日戰報」「回測/研究」三個資料夾的檔案

## 架構對照（原 Colab → 這個專案）

| 原本 Colab | 這裡 |
|---|---|
| Cell 0：掛載 Drive、設定路徑 | `Config.gs`（Script Properties 存 Spreadsheet ID / 三個 Drive 資料夾 ID） |
| Cell 1：抓 T86/MI_INDEX/BWIBBU_d、合併存檔 | `DataFetch.gs` + `SheetUtils.upsertHistoryRows_` |
| Cell 2：v17.0 評分/診斷 | `Analysis.gs` |
| Cell 4：因子相關性掃描 | `FactorScan.gs` |
| Cell 5：v16.10 Alpha 回測 | `Backtest.gs` |
| pandas groupby/rolling/rank | `Utils.gs`（純 JS 重寫，見下方「為什麼要重寫」） |
| `google_drive_output_dir`（ALL_COMBINED.csv） | Sheets 的 `History` 分頁 + Drive `Consolidated_file` 資料夾（封存用） |
| `google_drive_folder_output_report_dir`（Reports） | Sheets 的 `Reports` 分頁 + Drive `Reports` 資料夾（xlsx 快照） |
| `google_drive_folder_output_report_dir2`（Regression） | Drive `Regression` 資料夾（回測/因子掃描 CSV） |
| Cell 6-14（v16 / v16.5 / v16.6 舊版持股清單迭代） | 沒有搬，v17.0 是目前邏輯最完整的版本；持股清單改成「持股管理」頁面可編輯 |

### 為什麼要重寫 pandas 邏輯

Apps Script 是純 V8 JavaScript，沒有 pandas。`Utils.gs` 用純 JS 重刻了
`groupby().rolling().mean()/.std()/.sum()`、`pct_change()`、`diff()`、`shift()`、
`expanding().max()`、`groupby().rank(pct=True)` 這些筆記本裡大量使用的運算，並且刻意不呼叫任何
Apps Script 專屬服務，所以可以直接用 Node.js 單元測試（見「測試」章節），不用部署上去才能驗證邏輯對不對。

## 部署步驟

### 1. 建立 Apps Script 專案

**方法 A：用 clasp（推薦，方便之後用 git 管理版本）**

#### Script ID 是什麼、要貼在哪

「Script ID」就是 Google 幫你這個 Apps Script 專案取的一串**專屬識別碼**（一長串英數字，
長得像 `1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcdefghijklmno`，通常 50-60 個字元），
之後 clasp 要知道「我要把程式碼推到*哪一個*雲端專案」，靠的就是這串 ID。它會被存在
`apps-script/.clasp.json` 這個檔案裡（就在 `README.md` 旁邊），內容長這樣：

```json
{
  "scriptId": "這裡放你的那一長串 ID",
  "rootDir": "src"
}
```

`rootDir: "src"` 這行不要改，這是告訴 clasp「程式碼都放在 `src/` 資料夾底下」，
跟這個 repo 的檔案結構是搭配好的。

#### 不用手動複製貼上，整段指令貼進 Cloud Shell 執行就好

下面這段會：① 建立一個新的 Apps Script 專案並自動記住它的 scriptId、② 自動把這個
scriptId 寫進 `apps-script/.clasp.json`（不用你自己開檔案編輯、不用手動複製貼上那串 ID）：

```bash
npm install -g @google/clasp
clasp login                      # 跳出瀏覽器授權畫面，用你的 Google 帳號登入即可

# 1) 在一個跟這個 repo 無關的暫存資料夾建立新的 Apps Script 專案
#    （只是為了跟 Google 要一個新的 scriptId，clasp create 會順便在這個暫存資料夾
#     生一些預設檔案，跟這個 repo 沒有關係，用完可以整個資料夾刪掉）
mkdir -p ~/twse-clasp-init && cd ~/twse-clasp-init
clasp create --type webapp --title "TWSE 法人動能選股"

# 2) 從剛剛產生的 .clasp.json 裡把 scriptId 讀出來存成一個變數
SCRIPT_ID=$(node -e "console.log(require('./.clasp.json').scriptId)")
echo "你的 Script ID 是：$SCRIPT_ID"

# 3) 回到這個 repo 的 apps-script/ 資料夾，自動寫出正確的 .clasp.json
cd ~/airflow/apps-script          # 如果你 clone 的路徑不是這個，改成你實際的路徑
cat > .clasp.json <<EOF
{
  "scriptId": "$SCRIPT_ID",
  "rootDir": "src"
}
EOF

# 4) 確認寫進去的內容正確（scriptId 那欄不該是空的或還是範例文字）
cat .clasp.json

# 5) 第一次把 src/ 底下所有程式碼推上去
clasp push -f
```

第 2 步的 `SCRIPT_ID` 變數只要不關掉這個終端機視窗，接下來的指令都還讀得到，
所以整段可以一路貼下去執行，中間不用手動複製任何東西。如果中途關掉終端機重開，
從第 3 步開始重新做就好（`SCRIPT_ID` 變數會消失，但 `~/twse-clasp-init/.clasp.json`
裡的 scriptId 還在，用 `cat ~/twse-clasp-init/.clasp.json` 就能再看到）。

之後每次改完程式碼，用 `clasp push`（或直接跑 `./deploy.sh`）上傳，不用再重複上面這串。

**方法 B：手動複製貼上**

到 [script.google.com](https://script.google.com) 建立新專案，把 `src/` 底下每個 `.gs` / `.html` 檔案
內容依檔名複製貼上（記得在專案設定裡把 `appsscript.json` 也換成 `src/appsscript.json` 的內容，
在編輯器左側「專案設定」勾選「顯示 appsscript.json」後才看得到）。

### 2. 第一次授權

在 Apps Script 編輯器選一個函式（例如 `initializeProject`）直接執行一次，Google 會跳出授權畫面，
同意存取 Google Sheets / Google Drive。這個步驟會自動建立：

- 一份新的 Google Sheets（名稱「TWSE 法人動能選股 App 資料庫」），內含 `History` / `Portfolio` /
  `Reports` / `RunLog` / `SkipDates` 分頁
- Google Drive 裡的 `TWSE_App` 資料夾，底下有 `Consolidated_file` / `Reports` / `Regression` 三個子資料夾

（其實不用手動做這步也可以，Web App 開啟時 `bootstrap()` 會自動呼叫 `initializeProject()`；
先手動跑一次純粹是為了在部署前就把授權跳窗處理掉。）

### 3. 部署成 Web App（手機用這個網址）

Apps Script 編輯器右上角「部署」→「新增部署作業」→ 類型選「網頁應用程式」：

- 執行身分：**我**（`executeAs: USER_DEPLOYING`，已在 `appsscript.json` 設定）
- 存取權限：預設是「僅限我自己」，如果想跟家人共用可以改成「知道連結的使用者」

部署後會拿到一個 `https://script.google.com/macros/s/xxxx/exec` 網址，這就是手機瀏覽器要開的網址。
在手機瀏覽器（尤其是 iOS Safari / Android Chrome）打開後，可以用「加入主畫面」把它變成看起來像 App 的圖示。

### 4. 補歷史資料（選擇性）

如果你原本在 Colab 已經有一份 `ALL_COMBINED.csv`，可以先手動把裡面的資料貼進新 Spreadsheet 的
`History` 分頁（欄位順序要跟 `Config.gs` 的 `HISTORY_COLUMNS` 一致），這樣一開始就有歷史資料可以算
MA60 / IBF20 / 回測，不用重新一天一天補抓。

如果沒有舊資料，就到「後台管理」按「立即測試執行」，或是在 Apps Script 編輯器直接呼叫
`backfillHistory('2026-01-01', '2026-07-07')`（日期改成你要的區間）分批補歷史，
單次呼叫有 4.5 分鐘的內部時間預算，沒抓完會回傳 `nextStart`，用那個日期再呼叫一次繼續抓。

### 5. 設定每日排程

打開 App →「後台管理」→ 設定啟動時間（預設 20:30，配合證交所收盤後資料公告時間）、
是否六日不執行 → 按「儲存排程」。之後每天到時間就會自動執行 `scheduledDailyFetch()`：
抓當天資料、重跑分析、寫執行紀錄。如果那天證交所延後公布資料導致抓取失敗，
「執行紀錄」會看到失敗訊息，可以回來調整時間或改天手動補跑。

## 之後改完程式碼要怎麼自動推上去（例如在 Cloud Shell）

`deploy.sh` 把「推程式碼」跟「讓正式網址生效」這兩步包起來了。跟你現有那個專案的部署方式一樣，
**用同一個 Cloud Shell 就可以，不需要開別的 shell**——Cloud Shell 是綁在你 Google 帳號底下的一台持久化
小型機器，同時放好幾個專案的 repo 完全沒問題，各自一個資料夾、各自一份 `.clasp.json`，
`cd` 進哪個資料夾就是在對哪個專案操作，彼此不會互相影響。唯一要注意的是**不要**把兩個專案的
`.clasp.json`（裡面是 scriptId）搞混。

**第一次設定（只需要做一次）：**

```bash
# 在 Cloud Shell 裡
git clone <這個 repo 的網址>
cd airflow/apps-script
npm install -g @google/clasp     # 如果 Cloud Shell 裡還沒裝過
clasp login                      # 跳出瀏覽器授權（Cloud Shell 內建瀏覽器登入沒問題）

# 還沒有 .clasp.json 的話，照上面「1. 建立 Apps Script 專案 → 方法 A」那五個步驟做一次
# （整段指令貼上去執行，scriptId 會自動寫進 .clasp.json，不用手動複製貼上）

# 想讓正式 /exec 網址也能被腳本更新的話，先查一次 deploymentId：
clasp deployments
```

**之後每次要推新版本：**

```bash
cd airflow/apps-script
git pull                                          # 拉最新程式碼（如果我有再幫你改）
CLASP_DEPLOYMENT_ID=你查到的deploymentId ./deploy.sh
```

不加 `CLASP_DEPLOYMENT_ID` 也可以執行，只是那樣只會更新「HEAD/`/dev` 測試網址」，
手機在用的正式 `/exec` 網址不會變——這是 Apps Script 部署機制本身的行為（`clasp push`
只更新程式碼本體，要 `clasp deploy -i <deploymentId>` 才會把新版本套用到已發佈的 `/exec` 網址上），
不是這個腳本的限制。

**我這邊需要什麼資訊嗎？** 不需要你把任何密碼、OAuth token 貼給我——`clasp login` 這個授權動作
一定要在你自己能完成 Google 登入畫面的環境做（Cloud Shell 正合適），我這個 remote sandbox
沒有瀏覽器，沒辦法也不應該幫你完成登入。我只需要知道：
1. 你是要新建一個 Apps Script 專案，還是已經有一個現成的 scriptId 要沿用？
2. 如果之後想要「每次 git push 這個 repo 就自動部署」（不用手動進 Cloud Shell 跑），
   我可以另外幫你寫一份 GitHub Actions workflow，但那需要你自己把 `clasp login` 產生的
   `~/.clasprc.json` 內容存成 GitHub repo 的 Secret（一樣不透過我，直接在 GitHub 網頁設定），
   要不要做這個我可以再幫你評估。

## 測試

`Utils.gs` / `Analysis.gs` / `FactorScan.gs` / `Backtest.gs` 裡的核心運算都是純函式（不呼叫任何
Apps Script 服務），用 Node.js 就能直接測試，不用部署：

```bash
cd apps-script
npm test
```

## 已知限制

- **Google Sheets 上限**：單一試算表最多 10,000,000 格。台股上市櫃合計約 1,700+ 檔，
  `History` 一天就會增加約 4 萬格。為了不要撞到這個上限，`History` 分頁只會保留最近
  `Config.gs` 裡 `HISTORY_RETENTION_DAYS`（預設 270 天）的資料，超過的會自動封存成 CSV
  放進 Drive 的「歷史封存」資料夾（後台管理可以看到），再從 Sheets 移除。需要更長的歷史資料
  做研究時，去那個資料夾把舊檔案下載回來就有。
- **Apps Script 單次執行 6 分鐘上限**：`scheduledDailyFetch()` 一天只抓一天資料，沒有這個問題；
  但 `backfillHistory()` 補多天歷史、或 `runFactorCorrelationScan()` 在資料量很大時，
  有內部時間預算保護，超時會提前結束並告訴你進度。
- **TWSE 網頁格式很脆弱**：`DataFetch.gs` 的 CSV 解析是照 TWSE 目前的回傳格式寫的，
  如果證交所改版面格式，抓取會開始失敗（執行紀錄看得到），需要照新格式調整
  `fetchT86_` / `fetchMiIndex_` / `fetchBwibbu_`。
- **xlsx 匯出**：每日戰報要輸出成 `.xlsx`（比照原本 Colab 行為），用的是把暫存 Google Sheet
  透過 `/export?format=xlsx` 網址轉存的做法（Apps Script 沒有原生的 xlsx 產生 API）。
  這個網址不是 Google 正式公開文件的一部分，理論上未來有變動風險；如果哪天匯出失敗，
  改存 CSV（`saveBacktestToDrive` 用的做法）是更穩的備案。
