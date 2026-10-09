<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { doc, onSnapshot, collection, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../../firebase';
import { callFn } from '../../composables/useCallable';
import { strategyColor } from '../../utils/strategyColor';

/** 跟 AdminView.vue 的 STRATEGIES 同一份清單（key／label），同樣對應
 *  functions/lib/analysis.js 的 SCREENING_STRATEGIES——那邊是純運算邏輯用的
 *  Node 模組，這裡是獨立的前端套件，不方便直接 import，手動保持同步；
 *  兩邊其中一邊新增/改名策略，記得回來同步這份清單（跟 AdminView.vue 共
 *  兩處）。 */
const STRATEGIES = [
  { key: 'rule_v17', label: 'v17.0 規則式門檻（現行）' },
  { key: 'factor_model_rank', label: '因子模型排名精選' },
  { key: 'hybrid', label: '規則式門檻＋模型排名混合' }
];

const form = ref({ strategyKey: 'rule_v17', startDate: '', endDate: '', targetProfit: 5 });
const starting = ref(false);
const startError = ref('');

// 2026-10-08：跟 AdminView.vue 的「補抓區間」「執行完整排程」同一套
// jobs/{jobKey} 監聽模式（見 functions/index.js writeJobStatus_ 的完整
// 說明）——不靠 callFn 這次呼叫本身的回應顯示結果，改成即時監聽
// jobs/backtest 這份文件：就算切頁籤、App 切到背景、連線中斷，回來都看得
// 到當下真正的執行狀態，不會「看起來什麼都沒發生」。runBacktest／
// runBacktestAllStrategies 共用同一個 jobs/backtest key，用 mode 欄位
// （'single'／'all'）區分是哪一種，畫面根據 mode 顯示對應的結果版面。
const job = ref(null);
let unsubscribeJob = null;

onMounted(function () {
  unsubscribeJob = onSnapshot(doc(db, 'jobs', 'backtest'), function (snap) {
    job.value = snap.exists() ? snap.data() : null;
  });
});
onUnmounted(function () {
  if (unsubscribeJob) unsubscribeJob();
});

const jobStatusLabel = computed(function () {
  if (!job.value) return '';
  const labels = { running: '執行中', succeeded: '成功', failed: '失敗' };
  return labels[job.value.status] || job.value.status;
});

function jobStatusColor(label) {
  if (label === '成功') return 'var(--green)';
  if (label === '失敗') return 'var(--red)';
  return 'var(--amber)';
}

function exitLabelColor(exitLabel) {
  if (exitLabel === '🎯 達標') return 'var(--green)';
  if (exitLabel === '🛑 止損') return 'var(--red)';
  return 'var(--amber)'; // ⏳ 未觸發出場
}

// 按鈕永遠可以按，不因為 job.status === 'running' 鎖住——跟 AdminView.vue
// 「補抓區間」同一個理由：Cloud Functions 平台逾時強制中止不會走到
// writeJobStatus_ 的失敗分支，jobs/backtest 可能永遠卡在 'running'，這是
// 單人工具，不需要防「自己跟自己搶」，新的呼叫一開始就會覆寫掉卡住的
// 舊狀態。
async function runSingle() {
  starting.value = true;
  startError.value = '';
  try {
    await callFn('runBacktest', {
      startDate: form.value.startDate,
      endDate: form.value.endDate,
      targetProfit: Number(form.value.targetProfit) || undefined,
      strategyKey: form.value.strategyKey
    }, 540000); // 跟後端 BACKTEST_RUNTIME_OPTS_ 宣告的 timeoutSeconds: 540 對齊
  } catch (e) {
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      startError.value = e.message || String(e);
    }
  } finally {
    starting.value = false;
  }
}

async function runAll() {
  starting.value = true;
  startError.value = '';
  try {
    await callFn('runBacktestAllStrategies', {
      startDate: form.value.startDate,
      endDate: form.value.endDate,
      targetProfit: Number(form.value.targetProfit) || undefined
    }, 540000);
  } catch (e) {
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      startError.value = e.message || String(e);
    }
  } finally {
    starting.value = false;
  }
}

// ---- 因子相關性掃描（functions/lib/factorScan.js）----
// 2026-10-08：跟上面的回測是完全獨立的研究工具，不需要先套用因子迴歸
// 模型——純粹算幾個候選因子跟「未來 5 日報酬率」的相關係數，拿來看哪個
// 因子比較有可能有效。跟回測同一套 jobs/{jobKey} 監聽模式，但用自己的
// jobs/factorScan key（不是共用 jobs/backtest，兩個是不同的操作）。
const scanForm = ref({ startDate: '', endDate: '' });
const scanStarting = ref(false);
const scanStartError = ref('');
const scanJob = ref(null);
let unsubscribeScanJob = null;

onMounted(function () {
  unsubscribeScanJob = onSnapshot(doc(db, 'jobs', 'factorScan'), function (snap) {
    scanJob.value = snap.exists() ? snap.data() : null;
  });
});
onUnmounted(function () {
  if (unsubscribeScanJob) unsubscribeScanJob();
});

const scanJobStatusLabel = computed(function () {
  if (!scanJob.value) return '';
  const labels = { running: '執行中', succeeded: '成功', failed: '失敗' };
  return labels[scanJob.value.status] || scanJob.value.status;
});

function correlationColor(correlation) {
  if (correlation === null || correlation === undefined) return 'var(--text-h)';
  return correlation >= 0 ? 'var(--green)' : 'var(--red)';
}

async function runFactorScan() {
  scanStarting.value = true;
  scanStartError.value = '';
  try {
    await callFn('runFactorCorrelationScan', {
      startDate: scanForm.value.startDate || undefined,
      endDate: scanForm.value.endDate || undefined
    }, 540000); // 跟後端 BACKTEST_RUNTIME_OPTS_ 宣告的 timeoutSeconds: 540 對齊（這支共用同一組 runtime 設定）
  } catch (e) {
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      scanStartError.value = e.message || String(e);
    }
  } finally {
    scanStarting.value = false;
  }
}

// ---- 因子迴歸模型（functions/lib/factorRegression.js）----
// 2026-10-08：搬完這塊，factor_model_rank／hybrid 這兩個策略（上面的
// 回測、戰報頁面）才真正有辦法訓練出一版模型可以套用。跟因子掃描一樣是
// 獨立的研究工具，但這支會真的寫入 BigQuery ML 模型＋Firestore
// factor_model_history，不是只讀不寫。
const FACTOR_LABEL_NAMES = { return1m: '後續1個月報酬率', downsideResistance: '相對大盤抗跌力' };

function topWeightedFeatures(weights, count) {
  if (!weights) return [];
  return Object.keys(weights).sort(function (a, b) { return Math.abs(weights[b]) - Math.abs(weights[a]); }).slice(0, count || 5);
}

// factor_model_history 直接用 Firestore client SDK 讀（規則已經開放
// owner 讀取，見 firestore.rules），跟 AdminView.vue 的 run_log／
// skip_dates 同一個模式，不需要另外寫一個 onCall 包一層。
const factorModelHistory = ref([]);
const factorModelHistoryError = ref('');
let unsubscribeFactorModelHistory = null;

onMounted(function () {
  unsubscribeFactorModelHistory = onSnapshot(
    query(collection(db, 'factor_model_history'), orderBy('timestamp', 'desc'), limit(50)),
    function (snap) { factorModelHistory.value = snap.docs.map(function (d) { return d.data(); }); },
    function (e) { factorModelHistoryError.value = e.message || String(e); }
  );
});
onUnmounted(function () {
  if (unsubscribeFactorModelHistory) unsubscribeFactorModelHistory();
});

// 同一次「執行因子迴歸」會對兩個 label 各留一筆文件，依 timestamp 分組
// 成一次次「訓練批次」顯示，「套用」是整批一起套用（見後端
// exports.applyFactorModel 的說明：不讓兩個 label 套用到不同版本）。
// factorModelHistory 本身已經依 timestamp 新到舊排序好，分組時依遇到的
// 順序 push 進 order 陣列即可維持排序，不用另外排序一次。
const factorModelRuns = computed(function () {
  const byTs = {};
  const order = [];
  factorModelHistory.value.forEach(function (d) {
    if (!byTs[d.timestamp]) { byTs[d.timestamp] = { timestamp: d.timestamp, labels: [] }; order.push(d.timestamp); }
    byTs[d.timestamp].labels.push(d);
  });
  return order.map(function (ts) { return byTs[ts]; });
});

// 「🌟 目前生效模型」：對應 apps-script 版 getActiveFactorModelSummary，
// 這裡不另外開一個 onCall，直接在前端用 factorModelHistory 篩 applied
// 的文件算出來即可（weights 本來就已經在 onSnapshot 讀到的資料裡）。
const activeModelSummary = computed(function () {
  const applied = factorModelHistory.value.filter(function (d) { return d.applied; });
  if (applied.length === 0) return [];
  return applied.map(function (d) {
    return {
      labelKey: d.labelKey,
      labelName: FACTOR_LABEL_NAMES[d.labelKey] || d.labelKey,
      timestamp: d.timestamp,
      r2: d.r2,
      topFeatures: topWeightedFeatures(d.weights, 5)
    };
  });
});

const factorRegForm = ref({ l1Reg: 0.05 });
const factorRegStarting = ref(false);
const factorRegStartError = ref('');
const factorRegJob = ref(null);
let unsubscribeFactorRegJob = null;

onMounted(function () {
  unsubscribeFactorRegJob = onSnapshot(doc(db, 'jobs', 'factorRegression'), function (snap) {
    factorRegJob.value = snap.exists() ? snap.data() : null;
  });
});
onUnmounted(function () {
  if (unsubscribeFactorRegJob) unsubscribeFactorRegJob();
});

// job 的 status 只有 running／succeeded／failed（二元，完全失敗才會是
// failed——某一個 label 訓練失敗但另一個成功，仍然算 succeeded，哪個
// label 失敗看下面的訓練歷史表格，跟 run_log 裡「部分失敗」的文字紀錄
// 是分開的兩件事，不是同一個狀態欄位）。
const factorRegJobStatusLabel = computed(function () {
  if (!factorRegJob.value) return '';
  const labels = { running: '執行中', succeeded: '成功', failed: '失敗' };
  return labels[factorRegJob.value.status] || factorRegJob.value.status;
});

// 2026-10-08 修正：使用者實測按「開始訓練」後畫面立刻顯示執行狀態
// 「done」、完全沒有任何歷史紀錄——除錯日誌顯示 callable 呼叫本身
//「Load failed」（連線層級錯誤，請求可能根本沒送達後端）。這支跟
// FinancialsCoverageCard.vue runBackfillNow 遇到的情況看似相同、其實
// 不一樣：那邊已經證實後端不受前端斷線影響、照樣跑完，所以「連線錯誤
// 不顯示」是對的；這裡「立刻」顯示舊狀態（不是先變成「執行中」再卡住）
// 代表後端很可能完全沒收到這次請求（不是收到了但前端斷線看不到後續），
// 照搬同一套「連線錯誤一律不顯示」的邏輯反而會讓使用者以為有送出、
// 其實什麼都沒發生。改成送出失敗時先記下點擊時間，幾秒後檢查
// jobs/factorRegression 的 startedAt 有沒有真的更新成這次點擊之後的
// 時間——沒有才顯示錯誤，真的送達後端（startedAt 變新）就不顯示，
// 兩種情況都顧到。
let factorRegClickedAt = 0;

async function runFactorRegressionNow() {
  factorRegStarting.value = true;
  factorRegStartError.value = '';
  factorRegClickedAt = Date.now();
  try {
    await callFn('runFactorRegression', {
      l1Reg: Number(factorRegForm.value.l1Reg) || undefined
    }, 1800000); // 跟後端 FACTOR_REGRESSION_RUNTIME_OPTS_ 宣告的 timeoutSeconds: 1800 對齊
  } catch (e) {
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      factorRegStartError.value = e.message || String(e);
    } else {
      const clickedAt = factorRegClickedAt;
      setTimeout(function () {
        const job = factorRegJob.value;
        const reachedBackend = job && job.startedAt && job.startedAt >= clickedAt;
        if (!reachedBackend) {
          factorRegStartError.value = '送出失敗，請求可能沒有送達後端（連線中斷），下面的執行狀態如果不是「執行中」就代表真的沒送出，請重新點一次「開始訓練」。';
        }
      }, 6000);
    }
  } finally {
    factorRegStarting.value = false;
  }
}

const applyingTimestamp = ref('');
const applyError = ref('');

async function applyModel(timestamp) {
  applyingTimestamp.value = timestamp;
  applyError.value = '';
  try {
    await callFn('applyFactorModel', { timestamp: timestamp });
  } catch (e) {
    applyError.value = e.message || String(e);
  } finally {
    applyingTimestamp.value = '';
  }
}

// ---- 因子檢視器（functions/index.js getStockFactorDetail）----
// 2026-10-08：這次因子迴歸訓練一路踩到好幾個跟資料覆蓋率有關的 bug
//（Input data doesn't contain any rows／mean imputation 對全 NULL 欄位
// 報錯），每次都只能靠猜測＋翻 deploy log 定位原因。這張卡片讓使用者
// 自己選一檔股票、一段區間，直接看 BigQuery 算出來的逐日因子值，以及
// 背後的原始財報/股價資料，不用每次都重新部署一次診斷用的 SQL——跟上面
// 三個工具一樣是獨立的研究工具，但這支是唯讀查詢，不寫入任何資料，不用
// jobs/{jobKey} 監聽模式，一次 callFn 直接拿結果即可。
const inspectorSearchText = ref('');
const inspectorSearchResults = ref([]);
let inspectorSearchDebounceTimer = null;

function scheduleInspectorSearch() {
  const q = inspectorSearchText.value.trim();
  clearTimeout(inspectorSearchDebounceTimer);
  if (!q) {
    inspectorSearchResults.value = [];
    return;
  }
  inspectorSearchDebounceTimer = setTimeout(async function () {
    try {
      inspectorSearchResults.value = await callFn('searchStockCodes', { query: q });
    } catch (e) {
      inspectorSearchResults.value = [];
    }
  }, 400);
}

const inspectorForm = ref({ code: '', name: '', startDate: '', endDate: '' });

function selectInspectorStock(r) {
  inspectorForm.value.code = r.code;
  inspectorForm.value.name = r.name;
  inspectorSearchText.value = '';
  inspectorSearchResults.value = [];
}

const inspectorLoading = ref(false);
const inspectorError = ref('');
const inspectorResult = ref(null);

async function runInspector() {
  inspectorLoading.value = true;
  inspectorError.value = '';
  inspectorResult.value = null;
  try {
    inspectorResult.value = await callFn('getStockFactorDetail', {
      code: inspectorForm.value.code,
      startDate: inspectorForm.value.startDate,
      endDate: inspectorForm.value.endDate
    }, 180000);
  } catch (e) {
    inspectorError.value = e.message || String(e);
  } finally {
    inspectorLoading.value = false;
  }
}

// 因子欄位名稱不在前端另外手刻一份清單（跟後端 config.js
// FACTOR_CANDIDATE_COLUMNS 共用同一份定義，兩邊維護會跟著訓練/計算邏輯
// 變動而逐漸對不齊）——直接從回傳的第一列自己的欄位順序推出要顯示哪些
// 欄（排除已經有自己固定欄位的 stock_id／stock_name／date）。
const inspectorFactorColumns = computed(function () {
  const rows = inspectorResult.value && inspectorResult.value.factorRows;
  if (!rows || !rows.length) return [];
  return Object.keys(rows[0]).filter(function (k) { return k !== 'stock_id' && k !== 'stock_name' && k !== 'date'; });
});

/** 因子數值顯示用：四捨五入到 4 位小數，避免浮點數誤差印出一長串，
 *  null/undefined 顯示為 '-'（跟「這欄缺資料」區分開，不是真的是 0）。 */
function formatFactorValue(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v !== 'number') return v;
  return Number(v.toFixed(4));
}
</script>

<template>
  <section class="research-view">
    <div class="form-card">
      <h3>🧪 策略回測（v17.0）</h3>
      <p class="hint">
        模擬「如果這段區間每天照著指定的篩選策略進場，會發生什麼事」——用的是
        跟「戰報與個股」完全同一套因子計算／進場訊號判斷邏輯（見
        functions/lib/analysis.js），不是另一套近似規則，回測結果才真的能反映
        實際策略表現。出場規則固定是「達到目標報酬」或「從進場後最高點回落
        {{ ' ' }}2.5%」兩者先到者，跟持股續抱的移動停損同一個門檻。
      </p>
      <label>篩選策略（只影響「開始回測」，「一次跑全部策略比較」固定跑三種都比一次）
        <select v-model="form.strategyKey">
          <option v-for="s in STRATEGIES" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
      </label>
      <div class="schedule-time-inputs">
        <input v-model="form.startDate" type="date" required>
        <span>~</span>
        <input v-model="form.endDate" type="date" required>
      </div>
      <label>目標報酬（%，達到就算 🎯 達標出場）
        <input v-model.number="form.targetProfit" type="number" min="1" step="0.5" style="max-width:120px;">
      </label>
      <div class="form-actions">
        <button type="button" :disabled="starting" @click="runSingle">
          {{ starting ? '送出中...' : '開始回測' }}
        </button>
        <button type="button" :disabled="starting" @click="runAll">
          {{ starting ? '送出中...' : '一次跑全部策略比較' }}
        </button>
      </div>
      <p v-if="startError" class="error-box">{{ startError }}</p>
      <p class="hint">
        進場區間最多 60 天（資料量太大單次跑不完，請分批）；
        <code>factor_model_rank</code>／<code>hybrid</code> 需要先在下面的
        「因子迴歸模型」訓練並套用一版抗跌力模型才能跑，沒套用的話這兩個
        策略會回報「需要先套用模型」的錯誤，請先用 <code>rule_v17</code>。
      </p>
    </div>

    <div v-if="job" class="form-card">
      <div class="run-log-status-card-top">
        <span>執行狀態（{{ job.mode === 'all' ? '全部策略比較' : '單一策略' }}）</span>
        <span class="signal-badge" :style="{ color: jobStatusColor(jobStatusLabel) }">{{ jobStatusLabel }}</span>
      </div>
      <p class="hint">
        區間 {{ job.params?.startDate }} ~ {{ job.params?.endDate }}
        <template v-if="job.status === 'running'">，還在執行中，可以放心切走這個頁面，回來這裡會自動顯示最新狀態。</template>
      </p>
      <p v-if="job.status === 'failed' && job.error" class="error-box">{{ job.error }}</p>

      <!-- 單一策略結果 -->
      <template v-if="job.status === 'succeeded' && job.mode === 'single' && job.result">
        <h3>{{ job.result.strategyLabel }}</h3>
        <p v-if="job.result.warning" class="hint">{{ job.result.warning }}</p>
        <template v-else-if="job.result.summary">
          <div class="card-body">
            <div>訊號數：{{ job.result.summary.signalCount }}　勝率：{{ job.result.summary.winRate }}%　達標率：{{ job.result.summary.targetHitRate }}%</div>
            <div>平均報酬：{{ job.result.summary.avgReturn }}%　平均持有：{{ job.result.summary.avgDaysHeld }} 天　最大回落：{{ job.result.summary.maxDrawdown }}%</div>
          </div>
          <div class="table-wrap">
            <table class="history-table">
              <thead>
                <tr>
                  <th>代號</th><th>名稱</th><th>進場日</th><th>訊號</th><th>出場日</th>
                  <th>出場</th><th>持有天數</th><th>最終報酬</th><th>最高報酬</th><th>最大回落</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(t, i) in job.result.trades" :key="t.code + '-' + t.entryDate + '-' + i">
                  <td>{{ t.code }}</td>
                  <td>{{ t.name }}</td>
                  <td>{{ t.entryDate }}</td>
                  <td><span class="signal-badge" :style="{ color: strategyColor(t.entryStrategy) }">{{ t.entryStrategy }}</span></td>
                  <td>{{ t.exitDate }}</td>
                  <td><span class="signal-badge" :style="{ color: exitLabelColor(t.exitLabel) }">{{ t.exitLabel }}</span></td>
                  <td>{{ t.daysHeld }}</td>
                  <td>{{ t.finalReturnPct }}%</td>
                  <td>{{ t.peakReturnPct }}%</td>
                  <td>{{ t.worstDrawdownPct }}%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </template>

      <!-- 全部策略比較結果 -->
      <template v-if="job.status === 'succeeded' && job.mode === 'all' && job.result">
        <div v-for="key in Object.keys(job.result.results || {})" :key="key" class="form-card" style="margin-top:12px;">
          <h3>{{ job.result.results[key].strategyLabel }}</h3>
          <p v-if="job.result.results[key].error" class="error-box">{{ job.result.results[key].error }}</p>
          <p v-else-if="job.result.results[key].warning" class="hint">{{ job.result.results[key].warning }}</p>
          <div v-else-if="job.result.results[key].summary" class="card-body">
            <div>
              訊號數：{{ job.result.results[key].summary.signalCount }}
              勝率：{{ job.result.results[key].summary.winRate }}%
              達標率：{{ job.result.results[key].summary.targetHitRate }}%
            </div>
            <div>
              平均報酬：{{ job.result.results[key].summary.avgReturn }}%
              平均持有：{{ job.result.results[key].summary.avgDaysHeld }} 天
              最大回落：{{ job.result.results[key].summary.maxDrawdown }}%
            </div>
          </div>
        </div>
      </template>
    </div>

    <div class="form-card">
      <h3>📊 因子相關性掃描</h3>
      <p class="hint">
        跟上面的回測是獨立的研究工具，不需要先套用因子迴歸模型——算幾個候選
        因子（法人連續買超天數、法人參與度、趨勢分數、逢低接手率、安全邊際
        分數）跟「未來 5 日報酬率」的 Pearson 相關係數，看哪個因子比較有可能
        有效。日期區間都可以留空，代表讀全部 History 資料。
      </p>
      <div class="schedule-time-inputs">
        <input v-model="scanForm.startDate" type="date" placeholder="開始日期（留空＝全部）">
        <span>~</span>
        <input v-model="scanForm.endDate" type="date" placeholder="結束日期（留空＝全部）">
      </div>
      <div class="form-actions">
        <button type="button" :disabled="scanStarting" @click="runFactorScan">
          {{ scanStarting ? '送出中...' : '開始掃描' }}
        </button>
      </div>
      <p v-if="scanStartError" class="error-box">{{ scanStartError }}</p>

      <div v-if="scanJob" style="margin-top:8px;">
        <div class="run-log-status-card-top">
          <span>執行狀態</span>
          <span class="signal-badge" :style="{ color: jobStatusColor(scanJobStatusLabel) }">{{ scanJobStatusLabel }}</span>
        </div>
        <p class="hint">
          <template v-if="scanJob.status === 'running'">還在執行中，可以放心切走這個頁面，回來這裡會自動顯示最新狀態。</template>
        </p>
        <p v-if="scanJob.status === 'failed' && scanJob.error" class="error-box">{{ scanJob.error }}</p>

        <template v-if="scanJob.status === 'succeeded' && scanJob.result">
          <p v-if="scanJob.result.warning" class="hint">{{ scanJob.result.warning }}</p>
          <template v-else>
            <p class="hint">樣本數：{{ scanJob.result.sampleSize }}</p>
            <div class="table-wrap">
              <table class="history-table">
                <thead><tr><th>因子</th><th>相關係數</th></tr></thead>
                <tbody>
                  <tr v-for="c in scanJob.result.correlations" :key="c.factor">
                    <td>{{ c.factor }}</td>
                    <td>
                      <span class="signal-badge" :style="{ color: correlationColor(c.correlation) }">
                        {{ c.correlation === null ? 'N/A' : c.correlation.toFixed(4) }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </template>
      </div>
    </div>

    <div class="form-card">
      <h3>🧮 因子迴歸模型</h3>
      <p class="hint">
        用 BigQuery ML 的 LASSO 線性迴歸，從候選因子（法人參與度／趨勢
        分數／逢低接手率等 10 個基礎因子＋10 個余博邏輯延伸的基本面因子
        「四率四升」／月營收連續成長，見下面 Admin 頁面「財報基本面因子」
        卡片）裡找出目前最能預測「後續 1 個月報酬率」跟「相對大盤抗跌力」
        的組合。訓練出來的某一版套用後，上面的回測（以及正式戰報）的
        <code>factor_model_rank</code>／<code>hybrid</code> 策略才會真的
        有模型可以用。建議每週跑一次就夠——因子有效性不會一天一天大幅變動。
      </p>
      <p class="hint">
        2026-10-09 修正：候選因子刻意限制在這 20 個「即時計算（戰報/回測）
        真的支援」的因子（<code>config.js LIVE_SCORED_FACTOR_CANDIDATE_COLUMNS</code>），
        不包含產業資金流向／相對大盤強度那 36 個因子（跟
        <code>inst_accum_divergence_20d</code>／<code>days_since_new_low</code>）
        ——那批因子目前只有訓練用的 BigQuery view 有對應計算，即時計算端
        還沒接上，實測發現如果讓它們也進候選清單，LASSO 常常把權重放在
        這批因子上，訓練出來的模型套用後卻完全沒有訊號（這批因子的權重
        在即時計算裡被整個忽略）。限制在這 20 個換來的是訓練出來的模型
        保證能在回測/戰報正常運作，代價是喪失產業資金流向這塊的預測力。
      </p>

      <template v-if="activeModelSummary.length">
        <h3 style="margin-top:0;">🌟 目前生效模型</h3>
        <div v-for="m in activeModelSummary" :key="m.labelKey" class="card-body">
          <div>
            <strong>{{ m.labelName }}</strong>　執行時間 {{ m.timestamp }}　R²={{ m.r2 == null ? 'N/A' : Number(m.r2).toFixed(4) }}
          </div>
          <div>關鍵影響因子：{{ m.topFeatures.join('、') }}</div>
        </div>
      </template>
      <p v-else class="hint">目前沒有套用任何一版因子迴歸模型。</p>

      <h3 style="margin-top:16px;">執行本週因子迴歸</h3>
      <label>L1 正規化強度（數字愈大，愈多因子的權重會被壓到 0）
        <input v-model.number="factorRegForm.l1Reg" type="number" min="0" step="0.01" style="max-width:120px;">
      </label>
      <div class="form-actions">
        <button type="button" :disabled="factorRegStarting" @click="runFactorRegressionNow">
          {{ factorRegStarting ? '送出中...' : '開始訓練' }}
        </button>
      </div>
      <p v-if="factorRegStartError" class="error-box">{{ factorRegStartError }}</p>
      <div v-if="factorRegJob" class="run-log-status-card" style="margin-top:8px;">
        <div class="run-log-status-card-top">
          <span>執行狀態</span>
          <span class="signal-badge" :style="{ color: jobStatusColor(factorRegJobStatusLabel) }">{{ factorRegJobStatusLabel }}</span>
        </div>
        <div class="hint">
          <template v-if="factorRegJob.status === 'running'">還在訓練中，可以放心切走這個頁面，回來這裡會自動顯示最新狀態（BigQuery ML 訓練通常要數分鐘）。</template>
          <template v-else-if="factorRegJob.error">{{ factorRegJob.error }}</template>
          <template v-else-if="factorRegJob.result">
            {{ factorRegJob.result.timestamp }}：{{ factorRegJob.result.results.map(r => r.labelName + (r.error ? '失敗' : ('R²=' + (r.r2 == null ? 'N/A' : Number(r.r2).toFixed(4))))).join('、') }}
          </template>
        </div>
      </div>
      <p class="hint">
        第一次訓練（或 BigQuery 的 <code>industry_map</code> 表從沒成功同步過）
        會先自動刷新一次產業對照表，可能讓這次執行時間拉長；之後已經同步過
        就不會每次都重抓（公司產業分類幾乎不會變動）。
      </p>

      <h3 style="margin-top:16px;">訓練歷史</h3>
      <p v-if="factorModelHistoryError" class="error-box">{{ factorModelHistoryError }}</p>
      <p v-else-if="applyError" class="error-box">{{ applyError }}</p>
      <div v-if="factorModelRuns.length" class="table-wrap">
        <table class="history-table">
          <thead><tr><th>執行時間</th><th>結果</th><th>目前套用</th><th></th></tr></thead>
          <tbody>
            <tr v-for="run in factorModelRuns" :key="run.timestamp">
              <td>{{ run.timestamp }}</td>
              <td class="run-log-message">
                <div v-for="l in run.labels" :key="l.labelKey">
                  {{ FACTOR_LABEL_NAMES[l.labelKey] || l.labelKey }}：
                  <template v-if="l.status && l.status.indexOf('失敗') !== -1">{{ l.status }}</template>
                  <template v-else>
                    R²={{ l.r2 == null ? 'N/A' : Number(l.r2).toFixed(4) }}
                    （候選因子 {{ (l.featureColumns || []).length }} 個，關鍵影響因子：{{ topWeightedFeatures(l.weights, 5).join('、') || '無' }}）
                  </template>
                </div>
              </td>
              <td>
                <span v-if="run.labels.some(l => l.applied)" class="signal-badge" :style="{ color: 'var(--green)' }">✓ 套用中</span>
              </td>
              <td>
                <button type="button" :disabled="applyingTimestamp === run.timestamp" @click="applyModel(run.timestamp)">
                  {{ applyingTimestamp === run.timestamp ? '套用中...' : '套用這一版' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="hint">目前沒有任何訓練紀錄。</p>
      <p class="hint">
        候選因子清單（目前固定 20 個，不是每次訓練可以自己選的參數）定義在
        <code>functions/lib/config.js</code> 的
        <code>LIVE_SCORED_FACTOR_CANDIDATE_COLUMNS</code>——每次訓練都是
        同一份候選清單，差別在 LASSO 最後選中哪些、權重多少（見上面每一列
        的「關鍵影響因子」），不是這次訓練用了不同的因子組合。要新增因子，
        要先改這份清單＋在 <code>computeFactors_</code>（即時計算端）加對應
        的計算邏輯，不是前端能調的設定——只改 BigQuery view 不夠，還要讓
        <code>computeWeightedFactorScore_</code> 實際算得出這個因子的值，
        不然訓練出來的權重套用後一樣會被忽略（訓練歷史最舊那幾筆「58 個
        候選因子」的紀錄就是改這個限制之前留下的，不是資料錯誤）。
      </p>
    </div>

    <div class="form-card">
      <h3>🔍 因子檢視器</h3>
      <p class="hint">
        選一檔股票、一段區間，直接看 BigQuery 算出來的逐日因子值（含 10 個
        財報基本面因子），再往下對照背後的原始財報資料（Firestore
        <code>financials_quarterly</code>／<code>financials_monthly</code>）
        跟原始股價/籌碼資料——排查「這天這個因子到底是不是 NULL、算出來是
        多少」用，唯讀查詢，不會寫入或改動任何資料。
      </p>
      <div class="search-bar">
        <input v-model="inspectorSearchText" placeholder="輸入股票代號或名稱搜尋" @input="scheduleInspectorSearch">
      </div>
      <div v-if="inspectorSearchText && inspectorSearchResults.length" class="card-list search-results-list">
        <button
          v-for="r in inspectorSearchResults"
          :key="r.code"
          type="button"
          class="search-result-item"
          @click="selectInspectorStock(r)"
        >
          {{ r.code }} {{ r.name }}
        </button>
      </div>
      <p v-if="inspectorForm.code" class="hint">已選擇：{{ inspectorForm.code }} {{ inspectorForm.name }}</p>
      <div class="schedule-time-inputs">
        <input v-model="inspectorForm.startDate" type="date" required>
        <span>~</span>
        <input v-model="inspectorForm.endDate" type="date" required>
      </div>
      <div class="form-actions">
        <button type="button" :disabled="inspectorLoading || !inspectorForm.code" @click="runInspector">
          {{ inspectorLoading ? '查詢中...' : '查詢' }}
        </button>
      </div>
      <p v-if="inspectorError" class="error-box">{{ inspectorError }}</p>

      <template v-if="inspectorResult">
        <h3 style="margin-top:16px;">計算後因子值（{{ inspectorResult.factorRows.length }} 筆）</h3>
        <p v-if="!inspectorResult.factorRows.length" class="hint">
          這段區間在 <code>factor_features_fundamental</code> view 裡查不到任何列——可能是這段區間還沒有股價資料，或這檔代號是權證/ETF（排除在因子計算範圍外）。
        </p>
        <div v-else class="table-wrap">
          <table class="history-table">
            <thead>
              <tr>
                <th>日期</th>
                <th v-for="f in inspectorFactorColumns" :key="f">{{ f }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in inspectorResult.factorRows" :key="row.date">
                <td>{{ row.date }}</td>
                <td v-for="f in inspectorFactorColumns" :key="f">{{ formatFactorValue(row[f]) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 style="margin-top:16px;">原始財報資料——季報財務比率（{{ inspectorResult.rawFinancials.quarterly.length }} 筆，不限查詢區間，這檔股票全部累積紀錄）</h3>
        <p v-if="!inspectorResult.rawFinancials.quarterly.length" class="hint">Firestore <code>financials_quarterly</code> 裡完全沒有這檔股票的資料。</p>
        <div v-else class="table-wrap">
          <table class="history-table">
            <thead>
              <tr>
                <th>公告日</th><th>所屬季度</th><th>毛利率%</th><th>營益率%</th><th>淨利率%</th><th>ROE%</th>
                <th>毛利率連增</th><th>營益率連增</th><th>淨利率連增</th><th>ROE連增</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in inspectorResult.rawFinancials.quarterly" :key="d.code + '_' + d.period">
                <td>{{ d.period }}</td>
                <td>{{ d.fiscalPeriod }}</td>
                <td>{{ d.grossMarginPct }}</td>
                <td>{{ d.operatingMarginPct }}</td>
                <td>{{ d.netMarginPct }}</td>
                <td>{{ d.roePct }}</td>
                <td>{{ d.grossMarginStreak }}</td>
                <td>{{ d.operatingMarginStreak }}</td>
                <td>{{ d.netMarginStreak }}</td>
                <td>{{ d.roeStreak }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 style="margin-top:16px;">原始財報資料——月營收（{{ inspectorResult.rawFinancials.monthly.length }} 筆，不限查詢區間，這檔股票全部累積紀錄）</h3>
        <p v-if="!inspectorResult.rawFinancials.monthly.length" class="hint">Firestore <code>financials_monthly</code> 裡完全沒有這檔股票的資料。</p>
        <div v-else class="table-wrap">
          <table class="history-table">
            <thead><tr><th>所屬月份</th><th>公開可得日(估算)</th><th>營收YoY%</th><th>連續成長月數</th><th>來源</th></tr></thead>
            <tbody>
              <tr v-for="d in inspectorResult.rawFinancials.monthly" :key="d.code + '_' + d.reportDate">
                <td>{{ d.period }}</td>
                <td>{{ d.reportDate }}</td>
                <td>{{ d.revenueYoyPct }}</td>
                <td>{{ d.revenueGrowthStreak }}</td>
                <td>{{ d.source || '未知' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 style="margin-top:16px;">原始股價/籌碼資料（{{ inspectorResult.rawHistory.length }} 筆，查詢區間內）</h3>
        <p v-if="!inspectorResult.rawHistory.length" class="hint">BigQuery History 裡這段區間查不到這檔股票的原始資料。</p>
        <div v-else class="table-wrap">
          <table class="history-table">
            <thead>
              <tr><th>日期</th><th>收盤價</th><th>外資</th><th>投信</th><th>自營商</th><th>成交股數</th><th>殖利率%</th><th>本益比</th><th>股價淨值比</th></tr>
            </thead>
            <tbody>
              <tr v-for="h in inspectorResult.rawHistory" :key="h['日期']">
                <td>{{ h['日期'] }}</td>
                <td>{{ h['收盤價'] }}</td>
                <td>{{ h['外資'] }}</td>
                <td>{{ h['投信'] }}</td>
                <td>{{ h['自營商'] }}</td>
                <td>{{ h['成交股數'] }}</td>
                <td>{{ h['殖利率(%)'] }}</td>
                <td>{{ h['本益比'] }}</td>
                <td>{{ h['股價淨值比'] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </section>
</template>
