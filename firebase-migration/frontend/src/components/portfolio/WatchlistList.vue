<script setup>
import { ref, onMounted } from 'vue';
import { callFn } from '../../composables/useCallable';
import { strategyColor } from '../../utils/strategyColor';

const items = ref([]);
const loading = ref(false);
const error = ref('');
const saving = ref(false);
const form = ref({ code: '', name: '', note: '' });

async function load() {
  loading.value = true;
  error.value = '';
  try {
    items.value = await callFn('getWatchlist');
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function addItem() {
  saving.value = true;
  error.value = '';
  try {
    items.value = await callFn('addToWatchlist', {
      code: form.value.code,
      name: form.value.name,
      note: form.value.note
    });
    form.value = { code: '', name: '', note: '' };
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    saving.value = false;
  }
}

async function remove(code) {
  if (!window.confirm(`確定要從觀察清單移除 ${code} 嗎？`)) return;
  error.value = '';
  try {
    items.value = await callFn('removeFromWatchlist', { code });
  } catch (e) {
    error.value = e.message || String(e);
  }
}

onMounted(load);
</script>

<template>
  <section class="watchlist-list">
    <form class="form-card" @submit.prevent="addItem">
      <h3>加入觀察清單</h3>
      <label>股票代號
        <input v-model="form.code" required maxlength="6" placeholder="例如 2330">
      </label>
      <label>名稱（選填）
        <input v-model="form.name" placeholder="例如 台積電">
      </label>
      <label>備註（選填）
        <input v-model="form.note">
      </label>
      <button type="submit" :disabled="saving">{{ saving ? '加入中...' : '加入' }}</button>
    </form>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="loading" class="hint">載入中...</p>

    <div class="card-list">
      <article v-for="item in items" :key="item.code" class="card">
        <header>
          <strong>{{ item.code }} {{ item.name }}</strong>
          <span v-if="item.signal" class="signal-badge" :style="{ color: strategyColor(item.signal.strategy) }">{{ item.signal.strategy }}</span>
        </header>
        <div class="card-body">
          <div>加入日期：{{ item.addedDate }}</div>
          <div>最新收盤價：{{ item.latestClose ?? '-' }}</div>
          <div v-if="item.note">備註：{{ item.note }}</div>
          <div v-if="item.signal">建議動作：{{ item.signal.action }}（{{ item.signal.date }}）</div>
        </div>
        <button type="button" @click="remove(item.code)">移除</button>
      </article>
      <p v-if="!loading && items.length === 0" class="hint">觀察清單是空的。</p>
    </div>
  </section>
</template>
