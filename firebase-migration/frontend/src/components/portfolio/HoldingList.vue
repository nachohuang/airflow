<script setup>
import { ref, onMounted } from 'vue';
import { callFn } from '../../composables/useCallable';
import { strategyColor } from '../../utils/strategyColor';

const items = ref([]);
const loading = ref(false);
const error = ref('');

const formOpen = ref(false);
const saving = ref(false);
const form = ref(emptyForm());

const closeForm = ref(null); // { code, sellDate, sellPrice } 或 null

function emptyForm() {
  return { lotId: '', code: '', name: '', buyDate: '', cost: '', shares: '', note: '' };
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    items.value = await callFn('getPortfolio');
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

function openAddForm() {
  form.value = emptyForm();
  formOpen.value = true;
}

function openEditForm(card, lot) {
  form.value = {
    lotId: lot.id,
    code: card.code,
    name: card.name,
    buyDate: lot.buyDate || '',
    cost: lot.cost,
    shares: lot.shares,
    note: lot.note || ''
  };
  formOpen.value = true;
}

async function submitForm() {
  saving.value = true;
  error.value = '';
  try {
    items.value = await callFn('savePortfolioItem', {
      lotId: form.value.lotId || undefined,
      code: form.value.code,
      name: form.value.name,
      buyDate: form.value.buyDate,
      cost: Number(form.value.cost),
      shares: form.value.shares ? Number(form.value.shares) : undefined,
      note: form.value.note
    });
    formOpen.value = false;
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    saving.value = false;
  }
}

async function deleteLot(lotId) {
  if (!window.confirm('確定要刪除這筆買進紀錄嗎？')) return;
  error.value = '';
  try {
    items.value = await callFn('deletePortfolioLot', { lotId });
  } catch (e) {
    error.value = e.message || String(e);
  }
}

function openCloseForm(card) {
  closeForm.value = { code: card.code, sellDate: '', sellPrice: '' };
}

async function submitClose() {
  if (!closeForm.value) return;
  error.value = '';
  try {
    items.value = await callFn('closePortfolioPosition', {
      code: closeForm.value.code,
      sellDate: closeForm.value.sellDate,
      sellPrice: Number(closeForm.value.sellPrice)
    });
    closeForm.value = null;
  } catch (e) {
    error.value = e.message || String(e);
  }
}

onMounted(load);
</script>

<template>
  <section class="holding-list">
    <div class="toolbar">
      <button type="button" @click="openAddForm">＋ 新增持股</button>
      <button type="button" :disabled="loading" @click="load">⟳ 重新整理</button>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="loading" class="hint">載入中...</p>

    <form v-if="formOpen" class="form-card" @submit.prevent="submitForm">
      <h3>{{ form.lotId ? '編輯買進紀錄' : '新增持股' }}</h3>
      <label>股票代號
        <input v-model="form.code" required maxlength="6" :disabled="!!form.lotId" placeholder="例如 2330">
      </label>
      <label>名稱（選填）
        <input v-model="form.name" placeholder="例如 台積電">
      </label>
      <label>買進日期（選填）
        <input v-model="form.buyDate" type="date">
      </label>
      <label>買進價格（單位成本）
        <input v-model="form.cost" type="number" step="0.01" required>
      </label>
      <label>股數（選填，預設 1000）
        <input v-model="form.shares" type="number" step="1">
      </label>
      <label>備註（選填）
        <input v-model="form.note">
      </label>
      <div class="form-actions">
        <button type="submit" :disabled="saving">{{ saving ? '儲存中...' : '儲存' }}</button>
        <button type="button" @click="formOpen = false">取消</button>
      </div>
    </form>

    <form v-if="closeForm" class="form-card" @submit.prevent="submitClose">
      <h3>標示 {{ closeForm.code }} 已賣出</h3>
      <label>賣出日期
        <input v-model="closeForm.sellDate" type="date" required>
      </label>
      <label>賣出價格
        <input v-model="closeForm.sellPrice" type="number" step="0.01" required>
      </label>
      <div class="form-actions">
        <button type="submit">確認結案</button>
        <button type="button" @click="closeForm = null">取消</button>
      </div>
    </form>

    <div class="card-list">
      <article v-for="card in items" :key="card.code" class="card">
        <header>
          <strong>{{ card.code }} {{ card.name }}</strong>
          <span v-if="card.signal" class="signal-badge" :style="{ color: strategyColor(card.signal.strategy) }">{{ card.signal.strategy }}</span>
        </header>
        <div class="card-body">
          <div>加權平均成本：{{ card.cost }}</div>
          <div>總股數：{{ card.totalShares }}</div>
          <div>最早買進日：{{ card.buyDate }}</div>
          <div>最新收盤價：{{ card.latestClose ?? '-' }}</div>
          <div v-if="card.note">備註：{{ card.note }}</div>
          <div v-if="card.signal">建議動作：{{ card.signal.action }}（{{ card.signal.date }}）</div>
        </div>
        <details>
          <summary>買進紀錄（{{ card.lots.length }} 筆）</summary>
          <ul class="lot-list">
            <li v-for="lot in card.lots" :key="lot.id">
              <span>{{ lot.buyDate }}　{{ lot.cost }} 元 × {{ lot.shares }} 股<template v-if="lot.note">（{{ lot.note }}）</template></span>
              <span class="lot-actions">
                <button type="button" @click="openEditForm(card, lot)">編輯</button>
                <button type="button" @click="deleteLot(lot.id)">刪除</button>
              </span>
            </li>
          </ul>
        </details>
        <button type="button" class="close-btn" @click="openCloseForm(card)">💰 標示已賣出/結案</button>
      </article>
      <p v-if="!loading && items.length === 0" class="hint">目前沒有持股。</p>
    </div>
  </section>
</template>
