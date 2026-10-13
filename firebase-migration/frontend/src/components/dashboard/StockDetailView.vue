<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import Chart from 'chart.js/auto';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase';
import { callFn } from '../../composables/useCallable';
import { strategyColor } from '../../utils/strategyColor';
import {
  renderMarkdownLite,
  splitMarkdownSections,
  sectionsExcludingFinalDecision,
  pickSectionIcon,
  extractCoreReason,
  verdictDirection
} from '../../utils/markdownLite';

const props = defineProps({ code: { type: String, required: true } });
const emit = defineEmits(['close']);

const loading = ref(true);
const error = ref('');
const detail = ref(null);
const chartCanvas = ref(null);
let chartInstance = null;

// 2026-10-13：法人買賣超長條圖——舊版 apps-script 的個股詳情本來就有
// （紅買超/綠賣超），getStockDetail 回傳的 series 其實早就含
// instNet/foreign/trust/dealer 每天的數值（見 functions/lib/stockDetail.js
// buildPriceSeries_），只是 Vue 版一直沒把它畫出來——純前端補齊，不用
// 動後端。跟上面的價格走勢圖共用同一組 Chart.js，分開存實例避免互相
// destroy 到對方。
const instChartCanvas = ref(null);
let instChartInstance = null;

function renderInstChart(series) {
  if (instChartInstance) {
    instChartInstance.destroy();
    instChartInstance = null;
  }
  if (!instChartCanvas.value || !series || series.length === 0) return;
  instChartInstance = new Chart(instChartCanvas.value, {
    type: 'bar',
    data: {
      labels: series.map(function (s) { return s.date; }),
      datasets: [{
        label: '法人買賣超',
        data: series.map(function (s) { return s.instNet; }),
        backgroundColor: series.map(function (s) { return s.instNet >= 0 ? '#dc2626' : '#16a34a'; })
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { maxTicksLimit: 6 } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

// 2026-10-13：即時內外盤（委買委賣五檔＋買賣力道評估）——舊版 apps-script
// 有、Vue 版沒接。只在使用者按下按鈕才呼叫（不隨這個元件掛載就自動打），
// 因為 mis.twse.com.tw 這支非正式端點限速「每 5 秒 3 個請求」，不能像
// 走勢圖那樣自動載入——跟 lib/realtime.js／exports.getRealtimeQuote 的
// 說明一致，純粹輔助參考，不是操作建議，只有交易時間內查得到資料。
const rtQuote = ref(null);
const rtLoading = ref(false);
const rtError = ref('');

async function loadRealtimeQuote() {
  rtLoading.value = true;
  rtError.value = '';
  try {
    rtQuote.value = await callFn('getRealtimeQuote', { code: props.code });
  } catch (e) {
    rtError.value = e.message || String(e);
  } finally {
    rtLoading.value = false;
  }
}

function verdictColor(score) {
  if (score === null || score === undefined) return 'var(--text-h)';
  if (score >= 65) return 'var(--red)';
  if (score <= 35) return 'var(--green)';
  return 'var(--text-h)';
}

/** 五檔掛單表格要的列：賣檔由賣五到賣一（由高到低），接著買一到買五
 *  （由高到低）——跟真實看盤軟體的五檔排列順序一致，不是後端回傳的
 *  原始順序（bidLevels/askLevels 都是由最佳價位往外排）。 */
function orderBookRows(quote) {
  if (!quote || !quote.ok) return [];
  const askRows = (quote.askLevels || []).map(function (l, i) {
    return { label: '賣' + (i + 1), price: l.price, volume: l.volume };
  }).reverse();
  const bidRows = (quote.bidLevels || []).map(function (l, i) {
    return { label: '買' + (i + 1), price: l.price, volume: l.volume };
  });
  return askRows.concat(bidRows);
}

const diagnosing = ref(false);
const diagnosisError = ref('');

// 2026-10-07：跟 AdminView.vue 的「補抓區間」同一個理由（見 README「補抓
// 區間：用 jobs/{jobKey} 取代等這次呼叫本身回應」那節）——AI 診斷常常跑
// 30 秒到 1 分鐘（要查 Goodinfo + 呼叫 LLM），手機切到背景很容易把連線
// 中斷掉，或是使用者切到別的股票/分頁再切回來，這個元件會被整個砍掉
// 重建，原本存在元件內的 `diagnosing` 也會跟著消失。後端在
// `runDeepDiagnosisForCode_`／`runPortfolioHoldDiagnosis` 開始執行跟結束
// 時都會把狀態寫進 `jobs/aiDiagnosis_{code}`，這裡改成即時監聽那份文件，
// 不管連線有沒有中斷、元件有沒有被重新掛載，都能看到當下真正的執行狀態。
const diagnosisJob = ref(null);
let unsubscribeDiagnosisJob = null;

function subscribeDiagnosisJob(code) {
  if (unsubscribeDiagnosisJob) unsubscribeDiagnosisJob();
  diagnosisJob.value = null;
  unsubscribeDiagnosisJob = onSnapshot(doc(db, 'jobs', 'aiDiagnosis_' + code), function (snap) {
    diagnosisJob.value = snap.exists() ? snap.data() : null;
  });
}

// diagnosing：按下按鈕到 onCall 第一次回應（或失敗）這一小段；
// diagnosisJob：後端真正的執行狀態，透過 jobs/aiDiagnosis_{code} 監聽，
// 不受這次呼叫本身的連線狀態或元件有沒有被重新掛載影響。兩個合起來才是
// 完整的「現在是不是在跑」——即使這個元件剛掛載（diagnosing 一定是
// false），只要 diagnosisJob 顯示 'running'，也要照樣顯示「診斷中」。
const diagnosisBusy = computed(function () {
  return diagnosing.value || (diagnosisJob.value && diagnosisJob.value.status === 'running');
});

/** 對應 firestore/schema.md §4 的 diagnosisType 列舉，翻回中文顯示用。 */
const DIAGNOSIS_TYPE_LABEL = { deep: '深度診斷', hold: '持股續抱診斷', top3: 'TOP3推薦' };

function renderChart(series) {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  if (!chartCanvas.value || !series || series.length === 0) return;
  chartInstance = new Chart(chartCanvas.value, {
    type: 'line',
    data: {
      labels: series.map(function (s) { return s.date; }),
      datasets: [
        { label: '收盤價', data: series.map(function (s) { return s.close; }), borderColor: '#2563eb', pointRadius: 0, borderWidth: 2 },
        { label: 'MA5', data: series.map(function (s) { return s.ma5; }), borderColor: '#f59e0b', pointRadius: 0, borderWidth: 1 },
        { label: 'MA20', data: series.map(function (s) { return s.ma20; }), borderColor: '#10b981', pointRadius: 0, borderWidth: 1 },
        { label: 'MA60', data: series.map(function (s) { return s.ma60; }), borderColor: '#a855f7', pointRadius: 0, borderWidth: 1 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 6 } },
        y: { ticks: { maxTicksLimit: 6 } }
      },
      plugins: { legend: { labels: { boxWidth: 12 } } }
    }
  });
}

async function load() {
  loading.value = true;
  error.value = '';
  // 切到別檔股票：即時內外盤是「使用者主動查詢」的結果，不是跟著
  // getStockDetail 一起刷新的資料，換一檔股票時要清掉，不然會暫時顯示
  // 上一檔股票的舊報價。
  rtQuote.value = null;
  rtError.value = '';
  try {
    detail.value = await callFn('getStockDetail', { code: props.code });
    await nextTick();
    renderChart(detail.value.series);
    renderInstChart(detail.value.series);
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

/** 觸發一次新的 AI 診斷（會真正呼叫 Gemini API，消耗額度）——成功後整頁重新呼叫
 *  getStockDetail 刷新，不只是把這次結果插進陣列開頭，避免跟既有同一天同一檔的
 *  舊紀錄（同一個文件 ID 被覆蓋）顯示成重複的兩筆。fnName 是 'runAiDiagnosis'
 *  （深度診斷，任何股票都能跑）或 'runPortfolioHoldDiagnosis'（持股續抱診斷，
 *  只有 detail.holding 不是 null 時才會顯示對應按鈕）——兩者共用同一組
 *  loading/error 狀態，使用者不會同時點兩個按鈕。 */
async function runDiagnosis(fnName) {
  diagnosing.value = true;
  diagnosisError.value = '';
  try {
    await callFn(fnName, { code: props.code });
    await load();
  } catch (e) {
    // 「送出就失敗」（驗證錯誤／not-found／failed-precondition，代表後端
    // 根本沒真的開始跑）才顯示在這裡；deadline-exceeded／unavailable 這類
    // 連線層級的錯誤不代表後端真的失敗了（後端通常還是會繼續跑完），真正
    // 的執行狀態一律看上面 diagnosisJob 即時監聽到的內容，這裡顯示反而會
    // 誤導使用者以為診斷失敗了——跟 AdminView.vue「補抓區間」同一個理由。
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('not-found') >= 0 ||
        code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      diagnosisError.value = e.message || String(e);
    }
  } finally {
    diagnosing.value = false;
  }
}

/** AI 診斷卡片要用到的三段衍生內容（結論橫幅文字、intro HTML、各小節
 *  HTML），都是對 d.content 這段固定文字做的純運算，直接在 template 裡
 *  呼叫這幾支小函式即可，不需要為每一筆診斷另外存一份衍生狀態。 */
function introHtml(content) {
  return renderMarkdownLite(splitMarkdownSections(content).intro);
}
function sectionsOf(content) {
  return sectionsExcludingFinalDecision(content).map(function (s) {
    return { title: s.title, icon: pickSectionIcon(s.title), html: renderMarkdownLite(s.body) };
  });
}

watch(function () { return props.code; }, load);
watch(function () { return props.code; }, subscribeDiagnosisJob, { immediate: true });

// 診斷從「執行中」變成別的狀態就自動刷新（重新呼叫 getStockDetail，拿到
// 剛寫入的診斷紀錄）——不管使用者這段期間是不是一直盯著這個瀏覽器分頁。
watch(diagnosisJob, function (newVal, oldVal) {
  if (newVal && newVal.status !== 'running' && oldVal && oldVal.status === 'running') {
    load();
  }
});

onMounted(load);
onBeforeUnmount(function () {
  if (chartInstance) chartInstance.destroy();
  if (instChartInstance) instChartInstance.destroy();
  if (unsubscribeDiagnosisJob) unsubscribeDiagnosisJob();
});
</script>

<template>
  <section class="stock-detail-view">
    <div class="toolbar">
      <button type="button" @click="emit('close')">← 返回戰報清單</button>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="loading" class="hint">載入中...</p>

    <template v-if="detail">
      <header class="stock-detail-header">
        <strong>{{ detail.code }} {{ detail.name }}</strong>
        <span v-if="detail.latestClose != null" class="stock-detail-price">{{ detail.latestClose }}</span>
      </header>
      <p v-if="detail.holding" class="hint">
        持有中：成本 {{ detail.holding.cost }}，已持有 {{ detail.holding.daysHeld }} 天
        <template v-if="detail.holding.profitPct != null">
          ，未實現損益
          <span :class="detail.holding.profitPct >= 0 ? 'pos' : 'neg'">
            {{ detail.holding.profitPct >= 0 ? '+' : '' }}{{ detail.holding.profitPct }}%
          </span>
        </template>
      </p>

      <div class="chart-wrap">
        <canvas ref="chartCanvas"></canvas>
      </div>

      <h3>🎯 買賣力道評估（即時內外盤）</h3>
      <p class="hint">
        回答「當下這個價位，買賣盤偏多還是偏空」——只看當下的掛單與價位，
        不看公司體質，跟下面的「AI 診斷」是分開的兩件事。只在交易時間內
        查得到資料，僅供輔助參考，不是操作建議，資料來源是證交所看盤
        系統的即時報價端點，非正式文件化的公開 API。
      </p>
      <div class="toolbar">
        <button type="button" :disabled="rtLoading" @click="loadRealtimeQuote">
          {{ rtLoading ? '查詢中...' : (rtQuote ? '🔄 重新查詢' : '🔄 查詢即時內外盤') }}
        </button>
      </div>
      <p v-if="rtError" class="error-box">{{ rtError }}</p>
      <template v-if="rtQuote">
        <p v-if="!rtQuote.ok" class="hint">{{ rtQuote.message }}</p>
        <template v-else>
          <p :style="{ fontSize: '20px', fontWeight: 700, color: verdictColor(rtQuote.verdict.score) }">
            {{ rtQuote.verdict.label }}
            <template v-if="rtQuote.verdict.score != null">　{{ rtQuote.verdict.score.toFixed(1) }} 分</template>
          </p>
          <p class="hint">
            {{ rtQuote.verdict.detail }}
            <template v-if="rtQuote.buyRatio != null">　委買力道 {{ (rtQuote.buyRatio * 100).toFixed(1) }}%</template>
          </p>
          <p class="hint">
            成交價
            <template v-if="rtQuote.latestPrice != null">{{ rtQuote.latestPrice.toFixed(2) }}</template>
            <template v-else-if="rtQuote.priceEstimate != null">
              {{ rtQuote.priceEstimate.toFixed(2) }}（估算，取買一/賣一均價，非官方成交價）
            </template>
            <template v-else>-</template>
            　累積成交量 {{ rtQuote.accumulatedVolume }}
            <template v-if="rtQuote.timestamp">　{{ new Date(rtQuote.timestamp).toLocaleTimeString('zh-TW') }}</template>
          </p>
          <p v-if="rtQuote.openPrice != null || rtQuote.highPrice != null || rtQuote.lowPrice != null" class="hint">
            今日開 {{ rtQuote.openPrice }}　高 {{ rtQuote.highPrice }}　低 {{ rtQuote.lowPrice }}
          </p>
          <p class="hint">
            價差 {{ rtQuote.spread != null ? rtQuote.spread.toFixed(2) : '-' }}
            　五檔合計　買 {{ rtQuote.buyPressure }}　賣 {{ rtQuote.sellPressure }}
          </p>
          <div class="table-wrap">
            <table class="history-table">
              <thead><tr><th>檔位</th><th>價格</th><th>量</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in orderBookRows(rtQuote)" :key="r.label + '-' + i">
                  <td>{{ r.label }}</td><td>{{ r.price }}</td><td>{{ r.volume }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </template>

      <h3>法人買賣超（投信+外資+自營商合計，股數）</h3>
      <div class="chart-wrap">
        <canvas ref="instChartCanvas"></canvas>
      </div>

      <h3>戰報燈號歷史</h3>
      <div v-if="detail.scoreHistory.length" class="table-wrap">
        <table class="history-table">
          <thead>
            <tr><th>日期</th><th>Armor Score</th><th>策略</th><th>建議</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in detail.scoreHistory" :key="s.date">
              <td>{{ s.date }}</td>
              <td>{{ s.armorScore != null ? s.armorScore.toFixed(1) : '-' }}</td>
              <td :style="{ color: strategyColor(s.strategy) }">{{ s.strategy }}</td>
              <td>{{ s.action }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="hint">這檔股票還沒有戰報燈號紀錄。</p>

      <h3>AI 診斷紀錄</h3>
      <div class="toolbar">
        <button type="button" :disabled="diagnosisBusy" @click="runDiagnosis('runAiDiagnosis')">
          {{ diagnosisBusy ? '診斷中（約需 30 秒~1 分鐘）...' : '跑新的深度診斷' }}
        </button>
        <button v-if="detail.holding" type="button" :disabled="diagnosisBusy" @click="runDiagnosis('runPortfolioHoldDiagnosis')">
          {{ diagnosisBusy ? '診斷中（約需 30 秒~1 分鐘）...' : '跑新的持股續抱診斷' }}
        </button>
      </div>
      <p v-if="diagnosisBusy" class="hint">
        執行狀態即時連到伺服器端，放心切到別的股票、切到背景或關掉再打開，
        回來這裡都看得到當下真正的進度。
      </p>
      <p v-if="diagnosisError" class="error-box">{{ diagnosisError }}</p>
      <div v-if="detail.aiDiagnoses.length" class="card-list">
        <details v-for="(d, idx) in detail.aiDiagnoses" :key="d.timestamp" class="form-card" :open="idx === 0">
          <summary>
            {{ d.date }}　{{ DIAGNOSIS_TYPE_LABEL[d.diagnosisType] || d.diagnosisType }}　{{ d.verdict }}
          </summary>
          <div class="ai-report">
            <div class="ai-verdict-banner" :class="verdictDirection(d.verdict)">
              <div class="ai-verdict-banner-label">最終操作決策</div>
              <div class="ai-verdict-banner-value">{{ d.verdict }}</div>
              <div v-if="extractCoreReason(d.content)" class="ai-verdict-banner-reason">
                {{ extractCoreReason(d.content) }}
              </div>
            </div>
            <div v-html="introHtml(d.content)"></div>
            <details v-for="(sec, secIdx) in sectionsOf(d.content)" :key="secIdx" class="ai-section">
              <summary>{{ sec.icon }} {{ sec.title }}</summary>
              <div class="info-body" v-html="sec.html"></div>
            </details>
          </div>
        </details>
      </div>
      <p v-else class="hint">這檔股票還沒有 AI 診斷紀錄。</p>
    </template>
  </section>
</template>
