<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { doc, onSnapshot } from 'firebase/firestore';
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
        <code>factor_model_rank</code>／<code>hybrid</code> 需要先套用一版抗跌力
        因子迴歸模型才能跑，這個功能還沒遷移到 Firebase（見 README「策略研究」
        那節），目前這兩個策略會回報「需要先套用模型」的錯誤，請先用
        <code>rule_v17</code>。
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
  </section>
</template>
