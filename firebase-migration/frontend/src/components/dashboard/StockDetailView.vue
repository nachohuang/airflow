<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import Chart from 'chart.js/auto';
import { callFn } from '../../composables/useCallable';

const props = defineProps({ code: { type: String, required: true } });
const emit = defineEmits(['close']);

const loading = ref(true);
const error = ref('');
const detail = ref(null);
const chartCanvas = ref(null);
let chartInstance = null;

const diagnosing = ref(false);
const diagnosisError = ref('');

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
  try {
    detail.value = await callFn('getStockDetail', { code: props.code });
    await nextTick();
    renderChart(detail.value.series);
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

/** 觸發一次新的 AI 深度診斷（會真正呼叫 Claude／Gemini API，消耗額度）——成功後
 *  整頁重新呼叫 getStockDetail 刷新，不只是把這次結果插進陣列開頭，避免跟既有
 *  同一天同一檔的舊紀錄（同一個文件 ID 被覆蓋）顯示成重複的兩筆。 */
async function runDiagnosis() {
  diagnosing.value = true;
  diagnosisError.value = '';
  try {
    await callFn('runAiDiagnosis', { code: props.code });
    await load();
  } catch (e) {
    diagnosisError.value = e.message || String(e);
  } finally {
    diagnosing.value = false;
  }
}

watch(function () { return props.code; }, load);
onMounted(load);
onBeforeUnmount(function () {
  if (chartInstance) chartInstance.destroy();
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

      <div class="chart-wrap">
        <canvas ref="chartCanvas"></canvas>
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
              <td>{{ s.strategy }}</td>
              <td>{{ s.action }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="hint">這檔股票還沒有戰報燈號紀錄。</p>

      <h3>AI 診斷紀錄</h3>
      <div class="toolbar">
        <button type="button" :disabled="diagnosing" @click="runDiagnosis">
          {{ diagnosing ? '診斷中（約需 30 秒~1 分鐘）...' : '跑新的深度診斷' }}
        </button>
      </div>
      <p v-if="diagnosisError" class="error-box">{{ diagnosisError }}</p>
      <div v-if="detail.aiDiagnoses.length" class="card-list">
        <details v-for="d in detail.aiDiagnoses" :key="d.timestamp" class="form-card">
          <summary>
            {{ d.date }}　{{ DIAGNOSIS_TYPE_LABEL[d.diagnosisType] || d.diagnosisType }}　{{ d.verdict }}
          </summary>
          <p class="ai-diagnosis-content">{{ d.content }}</p>
        </details>
      </div>
      <p v-else class="hint">這檔股票還沒有 AI 診斷紀錄。</p>
    </template>
  </section>
</template>
