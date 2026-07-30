# TWSE 法人動能選股 App（Google Apps Script 版）

把原本在 Google Colab 跑的「v17.0 趨勢共鳴版」台股法人動能選股筆記本，移植成一個能在手機瀏覽器上使用的
Google Apps Script Web App。歷史資料以「每月一份 CSV」的形式存在你指定的 Google Drive 資料夾裡
（見下方「資料存放位置」），持股清單/戰報/執行紀錄等體積小的資料用 Google Sheets，
並提供一個後台管理頁面管理這些檔案與每日排程。

## 這個 App 有什麼

底部導覽列 6 個分頁：

1. **今日戰報**：對應 Colab Cell 2（v17.0）。每天自動（或手動）算出 `Armor_Score`，
   針對持股給「續抱/止盈止損」建議，針對觀察名單給「趨勢啟動/趨勢領航」買進建議。
   每檔訊號都有「🧠 AI 深度診斷」按鈕，呼叫 Claude API 做財報/籌碼/技術三流派辯證分析（見下方「AI 深度診斷」）。
   套用過因子回歸模型的話，卡片上還會多顯示一行「因子模型預測」分數供對照
   （見下方「套用因子模型後，今日戰報會多顯示什麼」）。
2. **持股管理**：對應原本寫死在程式碼裡的 `user_portfolio`，現在可以直接在手機上新增/編輯/刪除持股
   （代號、成本、買進日期），並即時顯示現價損益。
3. **個股分析**：搜尋任一股票代號，看收盤價 + MA5/MA20/MA60 走勢圖、法人買賣超柱狀圖，
   以及這檔股票過去每天的 Armor_Score / 操作策略歷史（「簡單分析個股數據序時變化」）。
4. **研究**：三個子分頁，都是回答「哪個因子有效」這個問題，深度跟花費不同：
   - **回測**：對應 Colab Cell 5（v16.10 Alpha Backtest），指定日期區間跑一次進出場模擬。
   - **因子相關性**：對應 Colab Cell 4，單一因子跟未來 5 日報酬率的 Pearson 相關係數，
     Apps Script 現場算，秒級出結果，不用 BigQuery。
   - **因子回歸模型（BigQuery，選用進階功能）**：多因子 LASSO 迴歸，同時考慮所有候選因子，
     找出最佳組合，還會記錄歷史、可以標記套用（見下方「因子回歸模型」章節）。
   三個工具結果都能一鍵存成 CSV。
5. **資料總覽**：目前資料來源模式下的歷史資料範圍摘要（external 模式下含股票數/總列數這些描述性統計，
   需要按「重新整理統計」才會真的查 BigQuery），以及「手動抓取 / 重新彙整區間」——選定日期區間重新向
   證交所抓取並覆蓋該區間資料（補救某幾天抓取失敗用，或手動補一段區間不用等排程），跟每日排程共用
   同一份「六日不執行 / 臨時停跑日」設定，該跳過的日期一樣會跳過。也有「BigQuery 用量與預估費用」，
   記錄每次呼叫 BigQuery 掃描的位元組數跟估算費用（見下方「因子回歸模型」章節的用量追蹤說明）。
6. **後台管理**：
   - 每日自動抓資料的**排程時間**可調（預設 20:30，證交所收盤資料公告時間如果變動可以自己改）
   - 可設定**六日不執行**、可新增**臨時停跑日**（颱風假之類）
   - **歷史資料夾**：可以切換成別的 Drive 資料夾，之後每日抓取/匯入/BigQuery 同步都會改用新資料夾
   - **匯入既有彙整表**：直接上傳 CSV，或貼 Drive 連結/檔案 ID，或讓系統自動挑資料夾裡「日期最新」
     的檔案匯入——會依日期自動拆進對應月份的檔案（見下方「資料存放位置」），不用重新從零開始抓
     （如果不想匯入，改用 BigQuery external 模式，見下方「因子回歸模型」章節）
   - **AI 深度診斷設定 / AI 使用量與預估費用**：見下方「AI 深度診斷」
   - **執行紀錄**：每次自動/手動執行的成功/失敗/略過都看得到
   - **檔案管理**：瀏覽/刪除 Drive 上「歷史資料」「每日戰報」「回測/研究」三個資料夾的檔案

## 資料存放位置

App 不會自己亂建資料夾，全部東西的位置都是固定的、寫在 `Config.gs` 裡：

**Spreadsheet「TWSE 法人動能選股 App 資料庫」**（`initializeProject()` 第一次執行時建立，
放在下面的「主資料夾」裡），裡面有這幾個分頁：

| 分頁 | 內容 |
|---|---|
| `Portfolio` | 持股清單（代號/成本/買進日期/備註） |
| `Reports` | 每日戰報精簡版（給手機 UI 用），依日期覆蓋 |
| `RunLog` | 執行紀錄（自動保留最近 500 筆） |
| `SkipDates` | 臨時停跑日清單 |
| `AiDiagnosis` | AI 深度診斷結果歷史 |
| `AiUsage` | AI 呼叫的 token 用量/預估費用紀錄 |

**Google Drive 資料夾**（都是 `Config.gs` 裡指定的既有資料夾 ID，不是自動建立的新資料夾）：

| 資料夾 | 對應 Config.gs | 內容 |
|---|---|---|
| 主資料夾（`DEFAULT_PARENT_FOLDER_ID`） | `getRootFolder_()` | 放上面那份 Spreadsheet，以及底下的 `Reports/`、`Regression/` 兩個自動建立的子資料夾 |
| 歷史資料資料夾（`DEFAULT_HISTORY_FILES_FOLDER_ID`） | `getArchiveFolder_()` | **每月一份** `YYYY-MM_ALL_COMBINED.csv`（例如 `2026-07_ALL_COMBINED.csv`），這是歷史資料真正的存放位置，見下一節 |
| 主資料夾/`Reports/` | `getReportsFolder_()` | 每日戰報 xlsx 快照（完整欄位版） |
| 主資料夾/`Regression/` | `getRegressionFolder_()` | 回測結果、因子相關性掃描結果 CSV |

要換掉這些資料夾，改 `Config.gs` 的 `DEFAULT_PARENT_FOLDER_ID` / `DEFAULT_HISTORY_FILES_FOLDER_ID`
兩個常數就好（資料夾一定要先存在，App 不會自動幫你在別的地方新建）。

### 歷史資料為什麼是「每月一份檔案」，不是一份 Sheets 分頁或一份大 CSV

早期版本把整份歷史資料放在 Google Sheets 的 `History` 分頁裡，後來發現兩個問題：
Google Sheets 單一試算表有 10,000,000 格上限（台股 1,700+ 檔股票，一天就吃掉約 4 萬格，
撐不了太久）；而且不管是 Sheets 還是單一大 CSV，只要資料檔案大到一個程度，
Apps Script 讀取檔案內容這個動作本身就會直接失敗（讀不進記憶體），跟存在哪裡無關。

改成「每月一份 CSV」之後：
- 每天自動抓資料，只需要讀寫「當月」那一份檔案，檔案大小永遠有界（最多一個月的量），
  不會有讀不進去的問題。
- 需要算 rolling 指標（例如 MA60）時，`readRecentHistory_(days)` 會自動算出需要讀哪幾個月的檔案，
  不會每次都把全部歷史掃過一遍。
- 「匯入既有彙整表」如果你丟一份橫跨很多個月的大檔案進去，一樣可能會撞到讀取上限——
  這種情況建議先把大檔案按月拆開（見下方「補歷史資料」），拆完的小檔案本來就是這個資料夾要的格式，
  甚至可以不透過 App，直接在 Google Drive 網頁介面把拆好的檔案丟進歷史資料資料夾就好，
  下次排程跑的時候會自動偵測到、疊加上去。

## 架構對照（原 Colab → 這個專案）

| 原本 Colab | 這裡 |
|---|---|
| Cell 0：掛載 Drive、設定路徑 | `Config.gs`（Script Properties + 兩個使用者指定的既有 Drive 資料夾 ID） |
| Cell 1：抓 T86/MI_INDEX/BWIBBU_d、合併存檔 | `DataFetch.gs` + `SheetUtils.upsertHistoryRows_`（實作在 `HistoryFiles.gs`） |
| Cell 2：v17.0 評分/診斷 | `Analysis.gs` |
| Cell 4：因子相關性掃描 | `FactorScan.gs` |
| Cell 5：v16.10 Alpha 回測 | `Backtest.gs` |
| pandas groupby/rolling/rank | `Utils.gs`（純 JS 重寫，見下方「為什麼要重寫」） |
| `google_drive_output_dir`（ALL_COMBINED.csv） | 歷史資料資料夾裡每月一份的 `YYYY-MM_ALL_COMBINED.csv`（`HistoryFiles.gs`） |
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

之後每次改完程式碼，用 `clasp push`（或直接跑 `./deploy-stock.sh`）上傳，不用再重複上面這串。

**方法 B：手動複製貼上**

到 [script.google.com](https://script.google.com) 建立新專案，把 `src/` 底下每個 `.gs` / `.html` 檔案
內容依檔名複製貼上（記得在專案設定裡把 `appsscript.json` 也換成 `src/appsscript.json` 的內容，
在編輯器左側「專案設定」勾選「顯示 appsscript.json」後才看得到）。

### 2. 第一次授權

在 Apps Script 編輯器選一個函式（例如 `initializeProject`）直接執行一次，Google 會跳出授權畫面，
同意存取 Google Sheets / Google Drive。這個步驟會建立「資料存放位置」那節列出的 Spreadsheet
分頁，並確認/建立 `Reports`、`Regression` 兩個子資料夾——**前提是 `Config.gs` 裡
`DEFAULT_PARENT_FOLDER_ID` / `DEFAULT_HISTORY_FILES_FOLDER_ID` 這兩個資料夾 ID 已經是你自己
Drive 上真實存在、這個 Google 帳號有權限的資料夾**（不會自動幫你建立新資料夾，找不到會直接報錯）。

（其實不用手動做這步也可以，Web App 開啟時 `bootstrap()` 會自動呼叫 `initializeProject()`；
先手動跑一次純粹是為了在部署前就把授權跳窗處理掉。）

### 3. 部署成 Web App（手機用這個網址）

Apps Script 編輯器右上角「部署」→「新增部署作業」→ 類型選「網頁應用程式」：

- 執行身分：**我**（`executeAs: USER_DEPLOYING`，已在 `appsscript.json` 設定）
- 存取權限：預設是「僅限我自己」，如果想跟家人共用可以改成「知道連結的使用者」

部署後會拿到一個 `https://script.google.com/macros/s/xxxx/exec` 網址，這就是手機瀏覽器要開的網址。
在手機瀏覽器（尤其是 iOS Safari / Android Chrome）打開後，可以用「加入主畫面」把它變成看起來像 App 的圖示。

### 4. 補歷史資料（選擇性）

**要不要換一個歷史資料夾：** 預設用的是 `Config.gs` 的 `DEFAULT_HISTORY_FILES_FOLDER_ID`，
但這只是「第一次沒設定時」的預設值——一旦執行過一次，實際用的資料夾 ID 會存進 Script Properties，
之後改 `Config.gs` 的預設值也不會生效。要換資料夾，到 App →「後台管理」→「歷史資料夾」貼上新的
Drive 資料夾連結或 ID →「設為歷史資料夾」，之後每日抓取、匯入、BigQuery 同步都會自動改用新資料夾
（不影響舊資料夾裡原本的檔案，只是不會再讀寫它）。

如果你原本在 Colab 已經有一份 `ALL_COMBINED.csv`，有幾種方式讓它成為起始資料：

- **App 裡匯入**：打開 App →「後台管理」→「匯入既有彙整表」，直接上傳檔案或貼 Drive 連結/檔案 ID →
  按「開始匯入」，資料會依日期自動拆進歷史資料資料夾對應月份的檔案。支援 CSV 或 Google 試算表，
  資料量大的話會自動分批處理並持續顯示進度，不支援 `.xlsx`（Apps Script 沒有原生解析器）。
- **自動挑資料夾裡日期最新的檔案**：如果歷史資料夾裡已經有好幾個候選檔案（例如不同時間點匯出的
  版本），不想自己一個一個確認，按「列出歷史資料夾裡的檔案」，系統會依檔名裡的日期（例如
  `2026-07-30`、`20260730`，抓不到才退而求其次比對 Drive 最後修改時間）由新到舊排序列出來，
  最上面那筆會標記「匯入（最新）」，按下去就是拿它當基礎匯入；清單裡其他檔案也可以個別選擇匯入。
- **直接丟進資料夾**：如果檔案橫跨的月份很多、一次匯入容易撞到 Apps Script 讀取大檔案的上限，
  先自己按月拆開（例如用 pandas 依 `日期` 欄位 `groupby` 月份存成多個 CSV），檔名取
  `YYYY-MM_ALL_COMBINED.csv`（例如 `2026-01_ALL_COMBINED.csv`），直接在 Google Drive
  網頁介面把拆好的檔案丟進「歷史資料資料夾」，完全不用透過 App——下次讀取歷史資料時就會自動抓到。

如果沒有舊資料，就到「後台管理」按「立即測試執行」抓當天的資料；之後想針對某個區間重新抓取
（例如補救某幾天抓取失敗），用「資料範圍重新彙整」選定日期區間即可，一樣支援分批處理與進度顯示，
也會套用你設定的「六日不執行 / 臨時停跑日」規則。

### 5. 設定每日排程

打開 App →「後台管理」→ 設定啟動時間（預設 20:30，配合證交所收盤後資料公告時間）、
是否六日不執行 → 按「儲存排程」。之後每天到時間就會自動執行 `scheduledDailyFetch()`：
抓當天資料、重跑分析、寫執行紀錄。如果那天證交所延後公布資料導致抓取失敗，
「執行紀錄」會看到失敗訊息，可以回來調整時間或改天手動補跑。

## 之後改完程式碼要怎麼自動推上去（例如在 Cloud Shell）

`deploy-stock.sh` 把「推程式碼」跟「讓正式網址生效」這兩步包起來了。跟你現有那個專案的部署方式一樣，
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
CLASP_DEPLOYMENT_ID=你查到的deploymentId ./deploy-stock.sh
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

## AI 深度診斷

對「今日戰報」裡的個股（或個股分析頁面查到的任一股票），可以呼叫 AI 做一次財報/籌碼/技術面的
「第二層思考」深度診斷——這是把你原本會不定期手動貼給 AI 分析的 prompt 直接做進 App 裡，
輸出格式（5年+TTM財務健檢表、三大流派辯證、CoVE 自我驗證、最終決策）完全比照你提供的原始 prompt。
Claude 跟 Gemini 都支援，兩邊金鑰都設定的話可以在後台管理隨時切換／比較輸出品質：

- **Claude**：沒有原生瀏覽能力，所以由 Apps Script 自己抓 Goodinfo 頁面文字
  （`fetchGoodinfoText_`，粗略的 HTML 去標籤，抓不到 Goodinfo 動態載入的部分）當作參考資料餵給模型
  （這也是原始 prompt 第 1 條規則的調整之處，原版假設模型自己能上網查）。
- **Gemini**：呼叫時開啟了 Google 原生的 `google_search` grounding 工具，模型自己也能查即時資訊，
  不完全依賴我們餵的 Goodinfo 摘要（兩者會一起送給模型參考）。

**設定步驟：**
1. Claude：到 [console.anthropic.com](https://console.anthropic.com) 申請一組 API 金鑰；
   Gemini：到 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 申請（通常有免費額度）。
2. 打開 App →「後台管理」→「AI 深度診斷設定」→ 選要用哪個 AI → 貼上對應的金鑰 →「儲存」
   （金鑰存在 Script Properties，前端拿不到、也不會進 git）。
3. 「今日戰報」每張卡片、「個股分析」頁面都有「🧠 AI 深度診斷」按鈕，按下去即時呼叫一次。
4. 如果想要每天排程自動對 Armor_Score 前幾名的訊號跑一次，勾選「每日排程自動產生 AI 診斷」並設定要跑前幾名，
   會在 `scheduledDailyFetch()` 抓完資料、跑完分析之後自動接著跑（用的是當下設定的那個 AI 供應商）。

**成本提醒：** 每次診斷都是一次真實的 API 呼叫。Claude 沒有免費額度（單次落在幾分錢等級）；
Gemini 透過 AI Studio 申請的 key 通常有免費額度，一天呼叫幾次的用量大概率整個月都在額度內。
開啟「每日自動」前建議先手動試個幾次，確認輸出品質跟費用可以接受。

**Goodinfo 抓取的限制（Claude 路徑）：** 用的是最陽春的「抓 HTML 後用正則去標籤」，Goodinfo 頁面有一部分內容
是前端 JS 動態載入的，這部分抓不到；抓不到或抓取失敗時模型還是會產出診斷，只是那部分會註明
「缺乏即時資料」，不會讓整個流程中斷或編造數字。

**Gemini 模型名稱會過期：** `Config.gs` 的 `GEMINI_MODEL` 是寫死的模型名稱字串，Google 三不五時會
淘汰舊模型、推出新版。如果 Gemini 呼叫失敗且錯誤是 HTTP 404，去
[ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models) 查目前可用的模型名稱，
改掉 `GEMINI_MODEL` 這個常數就好。

**每日用量與預估費用：** 每次 AI 診斷（不管是手動按按鈕還是每日排程自動跑）都會記錄輸入/輸出
token 數，並用「後台管理 → AI 使用量與預估費用」裡設定的參考單價概算一次費用，存進 `AiUsage` 分頁。
那個區塊會顯示今天的預估費用、近 30 天每天的呼叫次數/tokens/費用。**參考單價是概略預設值**
（`Config.gs` 的 `*_PRICE_*_PER_M_DEFAULT`），不是即時同步的官方價格，第一次用之前建議先去
[Anthropic 定價頁](https://www.anthropic.com/pricing#api)、[Gemini 定價頁](https://ai.google.dev/gemini-api/docs/pricing)
核對一次，在「參考單價」表單填入正確數字——這樣估算出來的費用才會貼近實際帳單，正確金額還是
以你各自帳號後台的用量頁面為準。

## 因子回歸模型（BigQuery，選用進階功能）

這個功能回答的是「每天針對篩選因子的有效性做回歸測試，跟隨市場更新」：以歷史大表所有欄位為基礎，
用 BigQuery ML 的 LASSO 線性迴歸（`linear_reg` + `l1_reg`）找出目前最能預測「後續1個月報酬率」跟
「相對大盤抗跌力」的因子組合，每次執行的結果（R²、每個因子的權重）都記一筆到 `FactorModelHistory`
分頁，方便觀察因子有效性有沒有隨著市場改變而漂移，也可以手動把某一版標記為「目前套用版本」。

**目前的範圍**：這是研究/監控工具，`FactorModelHistory` 只負責記錄跟顯示，**不會**自動回頭改變
`Analysis.gs` 每天算 `Armor_Score` 用的權重（45/30/15/10 那組固定係數）。要把這裡找到的最佳權重
接回每日選股邏輯，是之後可以再做的一步，先確定迴歸結果穩定、可信賴之後再接會比較安全。

### 三種資料來源模式：native / external / materialized（推薦）

「研究 → 因子回歸模型」子分頁裡有個「資料來源模式」下拉選單，**這個設定影響的不只是因子回歸**，
選了 external 或 materialized 之後，今日戰報／個股分析／回測研究／因子相關性掃描全部都會改用 BigQuery：

- **native（預設）**：先用「同步歷史資料到 BigQuery」把歷史資料夾裡「每月一份」的
  `YYYY-MM_ALL_COMBINED.csv` 逐月載入 BigQuery 原生資料表 `history_raw`，這個模式**只影響因子
  回歸模型**，其他功能（今日戰報／個股分析／回測研究）維持原本直接讀 Drive 月份檔案的做法，
  不需要 GCP 也能正常運作。前提是資料要先變成月份檔案（daily 排程抓的資料本來就是；外部匯入的
  舊資料要先透過「匯入既有彙整表」轉成月份檔案）。
- **external（不想匯入、可以接受查詢慢一點）**：完全不匯入。BigQuery 建一個指向 Google Drive
  檔案的**外部資料表**（`history_external`），一次涵蓋歷史資料夾裡**所有** CSV 檔案（一次性大
  彙整檔＋每日排程持續累加的月份檔案），用 `history_deduped` view 依 (股票代號, 日期) 去重。
  查詢時 BigQuery 直接讀 Drive 檔案內容（不會存副本），Apps Script 完全不會經手檔案，
  所以再大／再多的檔案都不會撞到 Apps Script 讀取 Drive 大檔案的上限，**但每次查詢都要重新讀一次
  Drive 檔案**，比較慢，而且 schema 是**位置對應**（照 `Config.gs` 的 `HISTORY_COLUMNS` 順序逐欄位
  對應，不是比對 CSV 標題列文字）——如果來源檔案實際欄位順序不一樣，資料會整個對錯欄位卻不會報錯。
- **materialized（推薦，一般情況應該選這個）**：一樣完全不匯入，但解決了 external 模式的兩個缺點：
  1. **用「欄位名稱」對應，不是位置**：先建一個 `autodetect: true` 的外部資料表
     （`history_external_autodetect`），讓 BigQuery 直接拿 CSV 標題列文字當欄名，
     再用一段 SQL（`FactorRegression` 用的同一套 `BQ_COLUMN_MAP`）依「欄名」把資料複製進一份
     BigQuery 原生表 `history_materialized`（`buildMaterializeSql_`）。不管來源檔案欄位順序
     跟系統預期的一不一樣，都能正確對應；如果標題列文字對不上（打字不同、缺欄位），
     複製這一步會直接報錯，而不是像 external 模式那樣靜默把資料塞錯欄位。
     BigQuery autodetect 出來的欄名不一定跟預期的中文字串一模一樣——最常見的是第一欄
     （通常是「日期」）前面黏著檔案本身的 UTF-8 BOM（我們自己存檔、或使用者從別處匯出的
     CSV 常常都有這個隱藏字元），變成一個外觀一樣但實際不同的字串。`resolveActualColumnNames_`
     會先問 BigQuery 實際偵測到的欄名清單，比對時忽略開頭的 BOM／前後空白，再拿「實際偵測到的
     名稱」去組 SQL，而不是硬用我們假設的乾淨字串——不然會撞到
     `Unrecognized name: \`日期\`` 這種因為欄名多了看不見字元而找不到欄位的錯誤。
  2. **查詢快**：`history_materialized` 是真正的 BigQuery 原生表（有優化過的儲存），不是每次都
     重新讀 Drive。查詢前只有「超過 `CONFIG.BIGQUERY_MATERIALIZED_MAX_AGE_MINUTES`（預設 360 分鐘）
     沒重新整理過」才會真的重新整理一次；其餘時候直接沿用既有的原生表，速度接近 native 模式。
     `scheduledDailyFetch()` 每天排程跑完抓資料之後，也會自動強制重新整理一次
     （`materializeHistoryTableIfStale_(0)`），確保戰報看到的一定包含當天最新資料，正常情況下
     完全不用手動按任何按鈕；也可以在「研究 → 因子回歸模型」按「立即重新整理」隨時手動觸發。

**共通行為（external 跟 materialized 都適用）：**
- `SheetUtils.gs` 的 `readRecentHistory_` / `readHistoryRange_`（今日戰報、個股分析、回測研究、
  因子相關性掃描全部靠這兩個函式拿歷史資料）會自動改成查 BigQuery，下游計算邏輯完全不用改，
  拿到的資料格式跟原本讀 Drive CSV 一模一樣。
- 開機畫面（`bootstrap()`）刻意**不會**自動問 BigQuery 資料範圍（避免每次開 App 都多一次查詢），
  想看目前實際的資料涵蓋範圍、列數、股票數，去「資料總覽」頁籤按「重新整理統計」。
- 切換模式後，`FactorRegression.gs` 的 `buildFeatureViewSql_` 不用改，它是照參數吃來源表名稱，
  `ensureFeatureView_` 會自動依目前的資料來源模式決定要讀哪一個。

### 套用因子模型後，今日戰報會多顯示什麼

在「研究 → 因子回歸模型」子分頁把某一版迴歸結果標記「套用」之後，**不會**改變 `Analysis.gs`
算 `Armor_Score` 的邏輯（那組 45/30/15/10 的固定係數完全不受影響），而是**多算一組並列的分數**：

- 每天算戰報時，`Analysis.gs` 的 `runAnalysis()` 會讀一次目前套用中的因子模型權重
  （`getAppliedFactorModels()`，只讀 `FactorModelHistory` 分頁，不會呼叫 BigQuery，不影響速度），
  對當天每檔訊號用 `computeWeightedFactorScore_()` 算 `Σ(套用中的權重 × 當天的因子值)`，
  存成「因子模型_預測1月報酬」「因子模型_預測抗跌力」兩個欄位，跟 Armor_Score 一起寫進 Reports
  分頁、一起顯示在戰報卡片上（卡片上會多一行「因子模型預測：1個月 +3.2% 抗跌力 +0.8%」）。
  如果某檔股票缺任一項權重對應的因子值（例如剛上市不滿 60 天，`BIAS_60` 還是 `null`），
  就不會顯示這行，不給可能誤導的部分預測值。
- 這組分數純粹是「多一個參考」，讓你自己比對迴歸模型跟原本 v17.0 邏輯的判斷有沒有落差；
  覺得因子模型的預測力經得起驗證了，要讓它反過來影響選股門檻，需要自己再改
  `Analysis.gs` 的 `diagnoseRow_` / `computeFactors_`，這一步目前刻意不自動做。

### 「相對大盤的抗跌力」怎麼算

不是股票自己的絕對回檔幅度，而是「大盤下跌的時候，這檔股票有沒有跌得比大盤少」：

1. 市場當日報酬 `mkt_return(日期)` = 當天所有股票 `daily_return` 的橫斷面平均（等權重的市場代理指標，
   因為大表裡沒有現成的加權指數欄位，用全市場股票當天報酬的平均數頂替）。
2. 對每一檔股票、每一天 t，往後看 20 個交易日，只挑「大盤那天是下跌的」（`mkt_return < 0`）那幾天，
   算這檔股票在那些天的 `(個股報酬 − 大盤報酬)` 平均值。
3. 這個數字（`label_downside_resistance`）越大，代表大盤跌的時候這檔股票跌得比大盤少（甚至逆勢上漲）；
   越小（負數）代表大盤跌的時候它跌得比大盤還兇——真正「抗跌」的相對意義。
4. 往後 20 個交易日裡如果剛好大盤都沒跌，這個值會是 `NULL`，訓練時會被排除，不會硬塞一個假數字。

對照的 SQL（`FactorRegression.gs` 的 `buildFeatureViewSql_`）：

```sql
AVG(CASE WHEN mkt_return < 0 THEN daily_return - mkt_return END)
  OVER (PARTITION BY stock_id ORDER BY dt ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING)
```

另一個預測目標「後續1個月報酬率」則單純是 20 個交易日後的收盤價相對現在的漲跌幅（`label_return_1m`）。

候選因子（`CONFIG.FACTOR_CANDIDATE_COLUMNS`）目前包含：法人參與度（`inst_participation`／
`inst_part_ma5`）、法人逢低承接比率（`ibf_20d`）、趨勢分數（`trend_score`）、均線斜率
（`ma20_slope`）、量能比（`vol_ratio`）、乖離率（`bias60`）、殖利率、本益比、股價淨值比——
都是大表裡（或由大表算出來的）數值型欄位，排除掉價格水準本身跟識別碼類欄位（這些不是有意義的
獨立預測變數）。要增減候選因子，改 `Config.gs` 的 `FACTOR_CANDIDATE_COLUMNS` 跟
`FactorRegression.gs` 的 `buildFeatureViewSql_` 就好。

### 設定步驟（一次性，跟 clasp login 一樣只能你自己做，這個沙盒環境不能代勞）

1. **準備一個標準 GCP 專案**：可以是新建的，也可以用你既有的（跟 Apps Script 自動配的那個
   隱藏專案不一樣，那個不能用）。到 [console.cloud.google.com](https://console.cloud.google.com)
   建立專案，記下 Project ID。
2. **啟用 BigQuery API**：該專案的 API 程式庫搜尋「BigQuery API」，啟用。
3. **綁定帳單帳戶**：BigQuery API 需要專案掛一個有效的帳單帳戶（信用卡）才能啟用，即使你完全用在
   免費額度內也一樣要掛，這是 Google 的規定，不是這個 App 的限制。這個資料量幾乎不會產生實際費用
   （見下面定價說明），但请自行留意。
4. **把 Apps Script 專案換成這個 GCP 專案**：打開 Apps Script 編輯器 → 左側「專案設定」（齒輪圖示）
   → 「Google Cloud Platform (GCP) 專案」→「變更專案」→ 貼上步驟 1 的 Project ID → 確認。
5. **確認 BigQuery 進階服務有開**：Apps Script 編輯器左側「服務」旁邊的 `+`，如果清單裡沒有
   `BigQuery`，加進去（`appsscript.json` 已經預先宣告 `enabledAdvancedServices`，`clasp push` 之後
   通常會自動顯示，這步是保險確認）。
6. **重新走一次授權**（跟部署步驟裡「第一次授權」一樣的畫面，只是這次會多跳出 BigQuery 權限的
   同意項目）：Apps Script 編輯器執行任一函式（例如 `initializeProject`），照畫面同意新增的權限。
7. 回到 App「後台管理」→「因子回歸模型」→ 貼上 Project ID（Dataset 名稱留預設 `twse_factor_model`
   即可）→ 儲存。
8. 按「同步歷史資料到 BigQuery」（第一次會把 Drive 上每個月的檔案都同步過去，資料量大的話可能要
   分幾次按——沒同步完會顯示剩下哪些月份，再按一次繼續，已同步的月份不會重複處理）。
9. 按「執行因子迴歸」，等一到兩分鐘，下面「執行紀錄」就會出現兩筆結果（兩個 label 各一筆），
   可以點「套用」標記你現在採信的那一版。
10. 之後資料持續累積，建議每週手動按一次「執行因子迴歸」（也可以之後自己加一個
    `ScriptApp.newTrigger('runFactorRegression').timeBased().everyWeeks(1)...` 的排程，
    目前這個進階功能還是先設計成手動觸發，避免資料量還小的階段自動燒錢）。

### BigQuery 定價（這個資料規模下的估算）

以下是 BigQuery on-demand（隨用隨付，預設方案，不用另外訂閱）的計費項目，**請以
[cloud.google.com/bigquery/pricing](https://cloud.google.com/bigquery/pricing) 官方頁面公告的即時費率為準**，
這裡只是列出計費項目跟這個 App 資料規模下大概會落在哪個量級：

| 項目 | 官方定價（約） | 免費額度（每月） | 這個 App 的用量 | 估算費用 |
|---|---|---|---|---|
| **儲存空間（Active storage）** | 約 $0.02 / GB / 月 | 前 10 GB 免費 | 歷史資料一年約幾百 MB～1-2 GB（純文字 CSV 量級，遠小於股價等級的大型資料集） | 幾乎必落在免費額度內，$0 |
| **儲存空間（Long-term storage，90 天未異動的資料）** | 約 $0.01 / GB / 月（比 active 便宜一半） | 同上 10 GB 額度共用 | 每月都會重新 DELETE+APPEND 當月資料，只有更舊的月份會變成 long-term | 同上，$0 |
| **查詢（On-demand query，依掃描資料量計費）** | 約 $6.25 / TB 掃描 | 每月前 1 TB 免費 | 每次「執行因子迴歸」掃描的是 factor_features view（幾百 MB～低 GB 等級），一次掃描量遠低於 1 TB | 幾乎必落在免費額度內，$0 |
| **BigQuery ML 訓練（`CREATE MODEL ... model_type='linear_reg'`）** | 計費方式等同一般查詢（依訓練查詢掃描的資料量計費，用的還是上面查詢的免費額度/費率），**不是** AutoML/DNN/Boosted Tree 那種另計費的模型類型 | 同查詢的 1 TB 免費額度 | 訓練資料是 factor_features 篩過 NOT NULL 之後的列，量級跟查詢差不多 | 幾乎必落在免費額度內，$0 |
| **Load Job（把 CSV 灌進 BigQuery，native 模式）** | 免費 | 不適用（本身就不計費） | 每次同步兩個 job：一個 DELETE query（算查詢）+ 一個 load job（免費） | Load job 本身 $0，DELETE query 併入上面查詢額度 |
| **外部資料表查詢（external 模式，讀 Drive 檔案）** | 計費方式等同一般查詢（依掃描量計費，用同一個查詢免費額度） | 同查詢的 1 TB 免費額度 | 每次查詢都要即時讀 Drive 檔案內容，通常比讀原生儲存慢，但計費一樣算「掃描量」，量級跟 native 模式差不多 | 幾乎必落在免費額度內，$0（但速度會慢，不是免費模式比較貴，只是比較慢） |
| **重新整理原生表（materialized 模式，`CREATE TABLE ... AS SELECT`）** | 計費方式等同一般查詢（依掃描量計費） | 同查詢的 1 TB 免費額度 | 只有超過設定的重新整理間隔（預設 6 小時）才會真的重新整理一次，不是每次查詢都做，量級也跟 native 模式差不多 | 幾乎必落在免費額度內，$0 |
| **Streaming Insert** | 約 $0.01 / 200 MB | 無免費額度 | 這個 App **沒有用**streaming insert（用的是 load job，故意避開這個計費項目） | 不適用，$0 |

**白話結論**：以你目前（幾個月、每天新增一批）的資料規模，正常使用（每週跑一次迴歸、每天同步一次）
幾乎肯定整個月都在免費額度內，帳單會是 $0。真正會花錢的情況通常是：資料量成長到幾十 GB 以上、
或查詢寫得很浪費一直全表掃描不篩選條件、或誤用了 AutoML/DNN/Boosted Tree 這幾種模型類型
（`Config.gs`／`FactorRegression.gs` 目前只用 `linear_reg`，不會踩到這個坑）。建議設一個
[BigQuery 預算警示](https://cloud.google.com/billing/docs/how-to/budgets)（例如 $1 就通知你），
純粹當保險，不是預期真的會花到錢。

### 用量追蹤：實際掃描了多少、估算費用多少

「資料總覽」頁籤有個「BigQuery 用量與預估費用」區塊：每次 `runBqQuery_()` 執行完一段 SQL，
都會從 BigQuery 回應裡讀 `totalBytesProcessed`（這次查詢實際掃描的位元組數），乘上「參考單價」
（USD / TB，預設 $6.25，可以在同一個區塊改）算成本，記一筆到新的 `BigQueryUsage` 分頁，
依「類型」分類（`feature_view`／`train_model`／`evaluate`／`weights`／`history_range`／
`dedup_view`／`delete_month`／`date_bounds`），方便看哪個操作掃得比較多。

**這個估算沒有扣掉每月前 1TB 的免費額度**，所以正常使用量下，這裡顯示的「預估費用」通常會比
你實際的 Google Cloud 帳單（$0）高，純粹用來看「掃描量的趨勢/量級」，不是準確的帳單金額，
正確費用一律以 Google Cloud 帳單為準。

## 測試

`Utils.gs` / `Analysis.gs` / `FactorScan.gs` / `Backtest.gs` 裡的核心運算都是純函式（不呼叫任何
Apps Script 服務），用 Node.js 就能直接測試，不用部署：

```bash
cd apps-script
npm test
```

## 已知限制

- **單一檔案不能太大**：歷史資料按月分檔後，正常情況下每個月的檔案都夠小、讀寫沒問題；
  但如果用「匯入既有彙整表」一次塞一份橫跨很多個月的巨大檔案，還是可能撞到 Apps Script
  讀取檔案內容的上限（這是平台限制，不是儲存位置的問題）。碰到這種情況請先按月拆開再匯入，
  見「補歷史資料」那節。
- **Apps Script 單次執行 6 分鐘上限**：`scheduledDailyFetch()` 一天只抓一天資料，沒有這個問題；
  但 `backfillHistory()` 補多天歷史、或 `runFactorCorrelationScan()` 在資料量很大時，
  有內部時間預算保護，超時會提前結束並告訴你進度。
- **TWSE 網頁格式很脆弱**：`DataFetch.gs` 的 CSV 解析是照 TWSE 目前的回傳格式寫的，
  如果證交所改版面格式，抓取會開始失敗（執行紀錄看得到），需要照新格式調整
  `fetchT86_` / `fetchMiIndex_` / `fetchBwibbu_`。
- **xlsx 匯出**：每日戰報要輸出成 `.xlsx`（欄位跟原本 Colab `to_excel()` 的完整欄位一致，
  見 `Config.gs` 的 `FULL_REPORT_COLUMNS`，不是手機 UI 用的精簡版），用的是把暫存 Google Sheet
  透過 `/export?format=xlsx` 網址轉存的做法（Apps Script 沒有原生的 xlsx 產生 API）。
  這個網址不是 Google 正式公開文件的一部分，理論上未來有變動風險；如果哪天匯出失敗，
  改存 CSV（`saveBacktestToDrive` 用的做法）是更穩的備案。
- **為什麼歷史資料用 CSV 不用 Excel**：這也是沿用原本 Colab 的教訓——資料量大了以後 Excel
  讀寫會變很慢。歷史資料（每月一份）跟匯入既有彙整表都是 CSV，不會有 Excel 資料量一大就變慢的問題；
  只有每日戰報快照跟原本 Colab 一樣輸出成 xlsx（單一天的資料量很小，沒有這個顧慮）。
- **因子回歸模型需要你自己的 GCP 專案**：這個沙盒環境沒有、也不能取得任何 Google 帳號的 OAuth
  憑證，「因子回歸模型」章節的 GCP 專案建立/API 啟用/帳單綁定/專案切換這幾步都只能你自己在
  Google Cloud Console 跟 Apps Script 編輯器操作，跟 `clasp login` 的道理一樣。這是選用功能，
  不影響其他頁面（今日戰報／持股管理／個股分析／回測研究／AI 深度診斷）的正常使用。
- **因子迴歸結果不會自動套用**：目前「套用」按鈕只是在 `FactorModelHistory` 分頁做標記，
  方便你自己追蹤/比較，選股用的 `Armor_Score` 權重還是 `Analysis.gs` 裡寫死的 45/30/15/10，
  不會因為跑了迴歸就自動改變——這是刻意的，先讓迴歸結果穩定一段時間、你評估過可信賴之後，
  要接回選股邏輯再手動改 `Analysis.gs`。
