<script setup>
import { ref, onMounted } from 'vue';
import { callFn } from '../../composables/useCallable';

const groups = ref([]);
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    groups.value = await callFn('getClosedPortfolioHistory');
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="closed-history-list">
    <div class="toolbar">
      <button type="button" :disabled="loading" @click="load">⟳ 重新整理</button>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="loading" class="hint">載入中...</p>

    <div v-if="groups.length" class="table-wrap">
      <table class="history-table">
        <thead>
          <tr>
            <th>代號</th><th>名稱</th><th>賣出日期</th><th>賣出價</th>
            <th>平均成本</th><th>股數</th><th>買進日期</th><th>損益%</th><th>損益金額</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in groups" :key="g.code + g.sellDate + g.sellPrice">
            <td>{{ g.code }}</td>
            <td>{{ g.name }}</td>
            <td>{{ g.sellDate }}</td>
            <td>{{ g.sellPrice }}</td>
            <td>{{ g.avgCost }}</td>
            <td>{{ g.totalShares }}</td>
            <td>{{ g.buyDate }}</td>
            <td :class="{ pos: g.realizedPct > 0, neg: g.realizedPct < 0 }">{{ g.realizedPct }}%</td>
            <td :class="{ pos: g.realizedAmount > 0, neg: g.realizedAmount < 0 }">{{ g.realizedAmount }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="!loading" class="hint">還沒有結案紀錄。</p>
  </section>
</template>
