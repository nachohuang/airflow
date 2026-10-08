<script setup>
/**
 * FinancialsCoverageCard.vue
 * 2026-10-08 新增：余博法人選股邏輯延伸的基本面因子（四率四升＋月營收
 * 連續成長）資料來源檢查——使用者明確要求「順便加上資料的檢查區塊，
 * 例如以月曆呈現，還有資料 sanity check 要看得到」。
 *
 * 跟 HistoryCalendarCard.vue（股價資料，逐日）不同：財報資料是月頻
 * （月營收）／季頻（綜合損益表＋資產負債表算出的毛利率/營益率/淨利率/
 * ROE），用「一年 12 個月／4 季」的格狀呈現維持「月曆」的視覺精神，
 * 不是逐日格子——逐日對這份資料沒有意義（財報不會每天更新）。
 *
 * `fiscalPeriod`（季報所屬季度）在沒有偵測到 TWSE 官方「年度」／「季別」
 * 欄位時是用公告日反推估計出來的（見 functions/lib/financials.js
 * estimateFiscalQuarterFromReportDate_ 的說明），不是官方確切數字——
 * `fiscalPeriodIsEstimated` 這個旗標會在畫面上明確標出來，不要讓使用者
 * 誤以為季度分類是精確的。
 */
import { ref, computed, onMounted, watch } from 'vue';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase';
import { callFn } from '../../composables/useCallable';

const LOW_COUNT_THRESHOLD_ = 500; // 跟 HistoryCalendarCard.vue 同一個「明顯偏低」粗略門檻，不是精確值

const refreshStarting = ref(false);
const refreshStartError = ref('');
const refreshJob = ref(null);
let unsubscribeRefreshJob = null;

onMounted(function () {
  unsubscribeRefreshJob = onSnapshot(doc(db, 'jobs', 'financialsRefresh'), function (snap) {
    refreshJob.value = snap.exists() ? snap.data() : null;
  });
});

function refreshJobStatusColor(status) {
  if (status === 'succeeded') return 'var(--green)';
  if (status === 'failed') return 'var(--red)';
  return 'var(--amber)';
}
const refreshJobStatusLabel = computed(function () {
  if (!refreshJob.value) return '';
  const labels = { running: '執行中', succeeded: '成功', failed: '失敗' };
  return labels[refreshJob.value.status] || refreshJob.value.status;
});

async function runRefreshNow() {
  refreshStarting.value = true;
  refreshStartError.value = '';
  try {
    await callFn('runFinancialsRefresh', {});
    await Promise.all([loadCoverage(), loadSample()]);
  } catch (e) {
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      refreshStartError.value = e.message || String(e);
    }
  } finally {
    refreshStarting.value = false;
  }
}

// ---- 歷史回補（MOPS 靜態頁面，只有月營收）----
// 2026-10-08 新增：使用者發現 TWSE OpenAPI（上面「重新整理財報因子」在
// 用的那個）只有最新一期快照，没辦法回溯補齊更早的月份；研究後找到 MOPS
// （公開資訊觀測站）的舊版靜態報表頁面網址格式可以指定民國年／月查歷史
// （見 functions/lib/mopsRevenueHtml.js 開頭的完整說明），所以另外做這個
// 區塊手動觸發回補。只接月營收——季報財務比率（綜合損益表／資產負債表）
// 目前沒有找到對應的 MOPS 靜態歷史頁面格式，還是只能靠上面「重新整理」
// 往後逐月累積，見下方「已知限制」提示。
// 回補出來的資料跟「重新整理財報因子」寫進同一個 financials_monthly
// collection，所以下面的涵蓋率月曆／隨機抽樣不用另外做一份，兩種來源的
// 資料都會自動顯示在同一份月曆/抽樣表格裡。
function defaultBackfillStartPeriod() {
  return new Date().getFullYear() + '-01';
}
function defaultBackfillEndPeriod() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1); // 預設到「上個月」，當月通常還沒被 TWSE 官方歸檔
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

const backfillStartPeriod = ref(defaultBackfillStartPeriod());
const backfillEndPeriod = ref(defaultBackfillEndPeriod());
const backfillStarting = ref(false);
const backfillStartError = ref('');
const backfillJob = ref(null);
let unsubscribeBackfillJob = null;

onMounted(function () {
  unsubscribeBackfillJob = onSnapshot(doc(db, 'jobs', 'financialsBackfillMops'), function (snap) {
    backfillJob.value = snap.exists() ? snap.data() : null;
  });
});

const backfillJobStatusLabel = computed(function () {
  if (!backfillJob.value) return '';
  const labels = { running: '執行中', succeeded: '成功', failed: '失敗' };
  return labels[backfillJob.value.status] || backfillJob.value.status;
});

// 2026-10-08 修正：使用者實際跑一次 9 個月的回補（逐月逐市場序列請求，
// 耗時數分鐘）遇到手機瀏覽器回報 fetch "Load failed"／callable 回
// `internal` 錯誤——但 jobs/financialsBackfillMops 監聽到的最終狀態其實
// 是成功（後端不受前端連線中斷影響，照樣跑完＋寫入＋同步 BigQuery）。
// 跟 AdminView.vue runBackfillNow（補抓股價區間）同一個教訓：連線層級的
// 錯誤（deadline-exceeded／unavailable／internal）不代表後端真的失敗，
// 在這裡顯示反而誤導使用者以為操作失敗了，只有「送出就失敗」的驗證類
// 錯誤才顯示。改成用下面的 watch 偵測 job 從 running 變成其他狀態時才
// 重新整理涵蓋率/抽樣，不依賴 callFn 本身回傳成功。
watch(backfillJob, function (newVal, oldVal) {
  if (newVal && newVal.status !== 'running' && oldVal && oldVal.status === 'running') {
    Promise.all([loadCoverage(), loadSample()]);
  }
});

async function runBackfillNow() {
  backfillStarting.value = true;
  backfillStartError.value = '';
  try {
    await callFn('runFinancialsBackfillMops', {
      startPeriod: backfillStartPeriod.value,
      endPeriod: backfillEndPeriod.value
    }, 600000); // 跟後端 FINANCIALS_BACKFILL_RUNTIME_OPTS_ 宣告的 timeoutSeconds: 600 對齊
    // 回傳值不需要處理——執行狀態一律透過上面的 jobs/financialsBackfillMops
    // 監聽顯示，重新整理交給上面的 watch 在工作真正完成時觸發。
  } catch (e) {
    // 「送出就失敗」（驗證錯誤／沒有登入）才在這裡顯示；deadline-exceeded／
    // unavailable／internal 這類連線層級的錯誤不代表後端真的失敗——後端
    // 通常還是會繼續跑完，真正的結果看上面即時監聽到的執行狀態。
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      backfillStartError.value = e.message || String(e);
    }
  } finally {
    backfillStarting.value = false;
  }
}

// ---- 涵蓋率月曆（月營收 12 格／季報 4 格，依年份切換）----
const viewYear = ref(new Date().getFullYear());
const coverageLoading = ref(true);
const coverageError = ref('');
const monthlyCoverage = ref([]); // [{period:'yyyy-MM', stockCount}]
const quarterlyCoverage = ref([]); // [{period:'yyyy-Qn', stockCount}]
const fiscalPeriodIsEstimated = ref(false);

async function loadCoverage() {
  coverageLoading.value = true;
  coverageError.value = '';
  try {
    const result = await callFn('getFinancialsCoverage', {});
    monthlyCoverage.value = result.monthly;
    quarterlyCoverage.value = result.quarterly;
    fiscalPeriodIsEstimated.value = result.fiscalPeriodIsEstimated;
  } catch (e) {
    coverageError.value = e.message || String(e);
  } finally {
    coverageLoading.value = false;
  }
}
onMounted(loadCoverage);

function cellStatus(stockCount) {
  if (stockCount === undefined || stockCount === 0) return 'missing';
  if (stockCount < LOW_COUNT_THRESHOLD_) return 'low';
  return 'ok';
}

const monthlyCells = computed(function () {
  const byPeriod = {};
  monthlyCoverage.value.forEach(function (r) { byPeriod[r.period] = r.stockCount; });
  const cells = [];
  for (let m = 1; m <= 12; m++) {
    const period = viewYear.value + '-' + String(m).padStart(2, '0');
    cells.push({ label: m + ' 月', period: period, stockCount: byPeriod[period] });
  }
  return cells;
});

const quarterlyCells = computed(function () {
  const byPeriod = {};
  quarterlyCoverage.value.forEach(function (r) { byPeriod[r.period] = r.stockCount; });
  const cells = [];
  for (let q = 1; q <= 4; q++) {
    const period = viewYear.value + '-Q' + q;
    cells.push({ label: 'Q' + q, period: period, stockCount: byPeriod[period] });
  }
  return cells;
});

function prevYear() { viewYear.value -= 1; }
function nextYear() { viewYear.value += 1; }

// ---- Sanity check：隨機抽樣 ----
const sampleLoading = ref(true);
const sampleError = ref('');
const sample = ref(null);

async function loadSample() {
  sampleLoading.value = true;
  sampleError.value = '';
  try {
    sample.value = await callFn('getFinancialsSample', {});
  } catch (e) {
    sampleError.value = e.message || String(e);
  } finally {
    sampleLoading.value = false;
  }
}
onMounted(loadSample);
</script>

<template>
  <div class="form-card">
    <h3>財報基本面因子（余博邏輯延伸）資料檢查</h3>
    <p class="hint">
      余適安（余博）法人選股邏輯裡「四率四升」（毛利率／營益率／淨利率／
      ROE 連續上升）跟「月營收連續成長」的資料來源——TWSE 這幾個官方端點
      是目前最新一期的快照，不是歷史歸檔，要靠重複執行「重新整理財報
      因子」累積歷史才能算出連續上升期數，見下方「重新整理」按鈕。欄位
      名稱是用關鍵字動態偵測（這個開發環境連不到 TWSE，沒辦法事先核對
      實際欄位），第一次執行如果偵測失敗，下面會看到清楚的錯誤訊息，
      請把錯誤內容回報修正。
    </p>

    <div class="form-actions">
      <button type="button" :disabled="refreshStarting" @click="runRefreshNow">
        {{ refreshStarting ? '送出中...' : '重新整理財報因子' }}
      </button>
    </div>
    <p v-if="refreshStartError" class="error-box">{{ refreshStartError }}</p>
    <div v-if="refreshJob" class="run-log-status-card" style="margin-top:8px;">
      <div class="run-log-status-card-top">
        <span>目前執行狀態</span>
        <span class="signal-badge" :style="{ color: refreshJobStatusColor(refreshJob.status) }">{{ refreshJobStatusLabel }}</span>
      </div>
      <div class="hint">
        <template v-if="refreshJob.status === 'running'">還在執行中，可以放心切走這個頁面，回來這裡會自動顯示最新狀態。</template>
        <template v-else-if="refreshJob.result">
          本次新抓 {{ refreshJob.result.monthlyCount }} 筆月營收、{{ refreshJob.result.quarterlyCount }} 筆季報
          （累積總筆數：月營收 {{ refreshJob.result.monthlyTotalAccumulated }}、季報 {{ refreshJob.result.quarterlyTotalAccumulated }}）
          <template v-if="refreshJob.result.bqSync?.attempted">，BigQuery 同步：{{ refreshJob.result.bqSync.ok ? '成功' : ('失敗（' + refreshJob.result.bqSync.error + '）') }}</template>
        </template>
        <template v-else-if="refreshJob.error">{{ refreshJob.error }}</template>
      </div>
    </div>

    <h3 style="margin-top:16px;">歷史回補（MOPS，僅月營收）</h3>
    <p class="hint">
      上面「重新整理財報因子」接的 TWSE OpenAPI 只有最新一期快照，沒辦法
      回溯補齊更早的月份。這裡改接「公開資訊觀測站 MOPS」的舊版靜態報表
      頁面，可以指定年月回補歷史月營收（一次最多 12 個月，會依序逐月
      逐市場抓取，不是瞬間完成，請耐心等待）。這個來源回補出來的公告日期
      一律是估算值（見下方抽樣表格的「來源」欄位），不會覆蓋已經有精確
      官方出表日期的既有資料。<strong>只支援月營收</strong>，季報財務比率
      （毛利率／營益率／淨利率／ROE）目前沒有找到對應的 MOPS 歷史頁面
      格式，還是只能靠上面「重新整理」往後逐月累積。
    </p>
    <div class="backfill-period-row">
      <label class="hint">起始年月</label>
      <input type="month" v-model="backfillStartPeriod" />
    </div>
    <div class="backfill-period-row">
      <label class="hint">結束年月</label>
      <input type="month" v-model="backfillEndPeriod" />
    </div>
    <div class="form-actions">
      <button type="button" :disabled="backfillStarting" @click="runBackfillNow">
        {{ backfillStarting ? '回補中...' : '開始回補' }}
      </button>
    </div>
    <p v-if="backfillStartError" class="error-box">{{ backfillStartError }}</p>
    <div v-if="backfillJob" class="run-log-status-card" style="margin-top:8px;">
      <div class="run-log-status-card-top">
        <span>回補執行狀態</span>
        <span class="signal-badge" :style="{ color: refreshJobStatusColor(backfillJob.status) }">{{ backfillJobStatusLabel }}</span>
      </div>
      <div class="hint">
        <template v-if="backfillJob.status === 'running'">
          還在執行中，可以放心切走這個頁面，回來這裡會自動顯示最新狀態。
          <template v-if="backfillJob.progress">目前進度：{{ backfillJob.progress.period }}／{{ backfillJob.progress.market === 'sii' ? '上市' : '上櫃' }}（{{ backfillJob.progress.rowCount }} 筆）</template>
        </template>
        <template v-else-if="backfillJob.result">
          這次回補抓到 {{ backfillJob.result.rowsFetched }} 筆，實際寫入 {{ backfillJob.result.rowsWritten }} 筆
          <template v-if="backfillJob.result.rowsSkippedPrecise">（{{ backfillJob.result.rowsSkippedPrecise }} 筆因為已有精確官方日期而略過）</template>
          （累積總筆數：月營收 {{ backfillJob.result.monthlyTotalAccumulated }}）
          <template v-if="backfillJob.result.bqSync?.attempted">，BigQuery 同步：{{ backfillJob.result.bqSync.ok ? '成功' : ('失敗（' + backfillJob.result.bqSync.error + '）') }}</template>
          <template v-if="backfillJob.result.httpErrors?.length">
            <br />{{ backfillJob.result.httpErrors.length }} 個月/市場組合失敗：{{ backfillJob.result.httpErrors.join('；') }}
          </template>
        </template>
        <template v-else-if="backfillJob.error">{{ backfillJob.error }}</template>
      </div>
    </div>

    <h3 style="margin-top:16px;">涵蓋率月曆</h3>
    <p class="hint">
      每個月／每一季涵蓋了多少檔股票——<span class="cal-legend-dot cal-missing"></span>紅色完全沒有資料、
      <span class="cal-legend-dot cal-low"></span>橘色明顯偏低（低於 {{ LOW_COUNT_THRESHOLD_ }} 檔，粗略門檻非精確值）、
      <span class="cal-legend-dot cal-ok"></span>綠色正常。
      <template v-if="fiscalPeriodIsEstimated">
        季報的所屬季度目前是用公告日反推估計出來的（沒有偵測到 TWSE 官方
        「年度」／「季別」欄位），分類可能有一兩天邊界誤差，不是官方
        精確數字。
      </template>
    </p>
    <div class="cal-toolbar">
      <button type="button" @click="prevYear">← 上一年</button>
      <strong>{{ viewYear }} 年</strong>
      <button type="button" @click="nextYear">下一年 →</button>
      <button type="button" :disabled="coverageLoading" @click="loadCoverage">⟳ 重新載入</button>
    </div>
    <p v-if="coverageError" class="error-box">{{ coverageError }}</p>
    <template v-else-if="!coverageLoading">
      <p class="hint" style="margin-bottom:4px;">月營收</p>
      <div class="fin-cal-grid fin-cal-grid-12">
        <div v-for="c in monthlyCells" :key="c.period" class="fin-cal-cell" :class="'cal-' + cellStatus(c.stockCount)" :title="c.period">
          <div class="fin-cal-cell-label">{{ c.label }}</div>
          <div class="fin-cal-cell-count">{{ c.stockCount ?? 0 }}</div>
        </div>
      </div>
      <p class="hint" style="margin:10px 0 4px;">季報財務比率</p>
      <div class="fin-cal-grid fin-cal-grid-4">
        <div v-for="c in quarterlyCells" :key="c.period" class="fin-cal-cell" :class="'cal-' + cellStatus(c.stockCount)" :title="c.period">
          <div class="fin-cal-cell-label">{{ c.label }}</div>
          <div class="fin-cal-cell-count">{{ c.stockCount ?? 0 }}</div>
        </div>
      </div>
    </template>
    <p v-else class="hint">載入中...</p>

    <h3 style="margin-top:16px;">隨機抽樣（人眼抽查用）</h3>
    <p v-if="sampleError" class="error-box">{{ sampleError }}</p>
    <template v-else-if="!sampleLoading && sample">
      <p class="hint">目前累積：月營收 {{ sample.monthlyTotalCount }} 筆、季報 {{ sample.quarterlyTotalCount }} 筆</p>
      <div v-if="sample.monthlySample.length" class="table-wrap">
        <table class="history-table">
          <thead><tr><th>代號</th><th>名稱</th><th>年月</th><th>營收</th><th>YoY%</th><th>連續成長月數</th><th>來源</th></tr></thead>
          <tbody>
            <tr v-for="r in sample.monthlySample" :key="r.code + '_' + r.period">
              <td>{{ r.code }}</td><td>{{ r.name }}</td><td>{{ r.period }}</td>
              <td>{{ r.revenue?.toLocaleString() ?? '-' }}</td>
              <td>{{ r.revenueYoyPct == null ? '-' : r.revenueYoyPct.toFixed(1) }}</td>
              <td>{{ r.revenueGrowthStreak ?? '-' }}</td>
              <td>{{ r.source === 'mopsBackfill' ? 'MOPS回補' : 'OpenAPI' }}<template v-if="r.reportDateIsEstimated">（估計公告日）</template></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="sample.quarterlySample.length" class="table-wrap" style="margin-top:8px;">
        <table class="history-table">
          <thead><tr><th>代號</th><th>公告日</th><th>所屬季度</th><th>毛利率%</th><th>營益率%</th><th>淨利率%</th><th>ROE%</th><th>連續上升（毛/營/淨/ROE）</th></tr></thead>
          <tbody>
            <tr v-for="r in sample.quarterlySample" :key="r.code + '_' + r.period">
              <td>{{ r.code }}</td><td>{{ r.period }}</td><td>{{ r.fiscalPeriod }}<template v-if="r.fiscalPeriodIsEstimated">（估計）</template></td>
              <td>{{ r.grossMarginPct == null ? '-' : r.grossMarginPct.toFixed(1) }}</td>
              <td>{{ r.operatingMarginPct == null ? '-' : r.operatingMarginPct.toFixed(1) }}</td>
              <td>{{ r.netMarginPct == null ? '-' : r.netMarginPct.toFixed(1) }}</td>
              <td>{{ r.roePct == null ? '-' : r.roePct.toFixed(1) }}</td>
              <td>{{ r.grossMarginStreak ?? '-' }}/{{ r.operatingMarginStreak ?? '-' }}/{{ r.netMarginStreak ?? '-' }}/{{ r.roeStreak ?? '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!sample.monthlySample.length && !sample.quarterlySample.length" class="hint">
        目前沒有任何資料，請先按上面「重新整理財報因子」。
      </p>
    </template>
    <div class="form-actions" style="margin-top:8px;">
      <button type="button" :disabled="sampleLoading" @click="loadSample">⟳ 重新抽樣</button>
    </div>

    <p class="hint">
      <strong>已知限制：</strong>目前只接了「一般業」財報端點，金融/證券/
      保險/金控等特殊產業別股票查無資料是預期行為；歷史回補只支援月營收，
      季報財務比率沒有找到對應的 MOPS 歷史頁面格式，只能往後逐月累積；
      這批基本面因子目前只用於訓練因子迴歸模型（見「策略研究」頁面），
      還沒接進「今日戰報/回測」的即時預測分數，詳見 README「余博邏輯
      延伸的基本面因子」一節。
    </p>
  </div>
</template>

<style scoped>
/* 2026-10-08 修正：原本用 flex-wrap 把「起始年月」「結束年月」兩個
 * label+input 跟「開始回補」按鈕塞在同一列，使用者手機實測畫面會
 * 出格（input type="month" 在 iOS Safari 的原生控制項寬度不固定，
 * flex-wrap 換行後跟按鈕疊在一起）。改成每個欄位各自獨立一整列、
 * input 固定滿版寬度，跟 HistoryCalendarCard.vue 等其他表單欄位的
 * 手機排版慣例一致，不依賴 flex-wrap 對原生表單控制項的換行行為。 */
.backfill-period-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}
.backfill-period-row input[type="month"] {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-card);
  color: inherit;
}

.cal-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.cal-toolbar strong {
  flex: 1;
  text-align: center;
  min-width: 80px;
}

.fin-cal-grid {
  display: grid;
  gap: 4px;
}
.fin-cal-grid-12 { grid-template-columns: repeat(6, 1fr); }
.fin-cal-grid-4 { grid-template-columns: repeat(4, 1fr); }

.fin-cal-cell {
  border-radius: 6px;
  border: 1px solid var(--border);
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.fin-cal-cell-label { font-weight: 600; }
.fin-cal-cell-count { font-size: 10px; opacity: 0.8; }

.cal-ok { border-color: var(--green); background: color-mix(in srgb, var(--green) 12%, var(--bg-card)); }
.cal-low { border-color: var(--amber); background: color-mix(in srgb, var(--amber) 16%, var(--bg-card)); }
.cal-missing { border-color: var(--red); background: color-mix(in srgb, var(--red) 16%, var(--bg-card)); }

.cal-legend-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  margin: 0 2px -1px 2px;
}
.cal-legend-dot.cal-missing { background: var(--red); }
.cal-legend-dot.cal-low { background: var(--amber); }
.cal-legend-dot.cal-ok { background: var(--green); }
</style>
