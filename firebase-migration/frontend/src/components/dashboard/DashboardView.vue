<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { collectionGroup, collection, query, orderBy, limit, getDocs, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase';
import { callFn } from '../../composables/useCallable';
import { strategyColor } from '../../utils/strategyColor';
import StockDetailView from './StockDetailView.vue';
import Top3PicksCard from './Top3PicksCard.vue';

const loading = ref(true);
const error = ref('');
const latestDate = ref(null);
const signals = ref([]);
const searchText = ref('');
const selectedCode = ref(null);
let unsubscribe = null;

async function load() {
  loading.value = true;
  error.value = '';
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  try {
    // `reports/{date}` 這個父文件本身從來沒被寫過任何欄位（functions/index.js 的
    // writeReportDocs_ 只寫 signals 這個 subcollection），直接查 reports collection
    // 找不到任何文件——改用 collectionGroup 查 signals 底下最新的 date 欄位，找出
    // 「最新一天」是哪一天。
    const latestQ = query(collectionGroup(db, 'signals'), orderBy('date', 'desc'), limit(1));
    const latestSnap = await getDocs(latestQ);
    if (latestSnap.empty) {
      latestDate.value = null;
      signals.value = [];
      loading.value = false;
      return;
    }
    latestDate.value = latestSnap.docs[0].data().date;

    // 即時監聽當天的訊號——戰報是後端排程算完直接寫進 Firestore 的唯讀資料，
    // onSnapshot 可以在之後重新計算、資料變動時自動更新畫面，不用使用者手動刷新。
    const signalsQ = query(
      collection(db, 'reports', latestDate.value, 'signals'),
      orderBy('armorScore', 'desc')
    );
    unsubscribe = onSnapshot(
      signalsQ,
      function (snap) {
        signals.value = snap.docs.map(function (d) { return d.data(); });
        loading.value = false;
      },
      function (e) {
        error.value = e.message || String(e);
        loading.value = false;
      }
    );
  } catch (e) {
    error.value = e.message || String(e);
    loading.value = false;
  }
}

/** 對應舊版 apps-script/src/JavaScript.html 的 fmtNum(v*100, digits) + '%' 慣例
 *  （簽名加正負號）——Inst_Part_Rank／IBF_20D_Rank／Trend_Score 這幾個原始排名
 *  欄位舊版卡片本來就沒有顯示（已經折算進 Armor Score 裡了），這裡刻意不跟著
 *  顯示，只保留舊版卡片原本就有秀出來的欄位。 */
function fmtPct(v, digits) {
  if (v === null || v === undefined || isNaN(v)) return '';
  const pct = v * 100;
  return (pct >= 0 ? '+' : '') + pct.toFixed(digits) + '%';
}

const filteredSignals = computed(function () {
  const q = searchText.value.trim();
  if (!q) return signals.value;
  return signals.value.filter(function (s) {
    return s.code.includes(q) || (s.name && s.name.includes(q));
  });
});

// ---- 搜尋全部股票（不限於今天有沒有訊號），用來開啟任何一檔股票的詳情頁 ----
const searchResults = ref([]);
const searching = ref(false);
let searchDebounceTimer = null;

function scheduleStockSearch() {
  const q = searchText.value.trim();
  clearTimeout(searchDebounceTimer);
  if (!q) {
    searchResults.value = [];
    return;
  }
  searchDebounceTimer = setTimeout(async function () {
    searching.value = true;
    try {
      searchResults.value = await callFn('searchStockCodes', { query: q });
    } catch (e) {
      // 搜尋失敗不影響主要的戰報清單（那邊是 onSnapshot 即時監聽，跟這裡的
      // 搜尋完全獨立），靜默失敗即可，不用額外跳錯誤訊息擋住整個頁面。
      searchResults.value = [];
    } finally {
      searching.value = false;
    }
  }, 400);
}

function openDetail(code) {
  selectedCode.value = code;
}

onMounted(load);
onUnmounted(function () {
  if (unsubscribe) unsubscribe();
  clearTimeout(searchDebounceTimer);
});
</script>

<template>
  <StockDetailView v-if="selectedCode" :code="selectedCode" @close="selectedCode = null" />

  <section v-else class="dashboard-view">
    <Top3PicksCard />

    <div class="search-bar">
      <input v-model="searchText" placeholder="輸入股票代號或名稱搜尋（例如 2330 或 台積電）" @input="scheduleStockSearch">
    </div>

    <div v-if="searchText && searchResults.length" class="card-list search-results-list">
      <button
        v-for="r in searchResults"
        :key="r.code"
        type="button"
        class="search-result-item"
        @click="openDetail(r.code)"
      >
        {{ r.code }} {{ r.name }}
      </button>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="loading" class="hint">載入中...</p>

    <div v-if="!loading && latestDate" class="meta-bar">
      {{ latestDate }} 戰報，共 {{ signals.length }} 筆訊號<template v-if="searchText">（篩選後 {{ filteredSignals.length }} 筆）</template>
    </div>

    <div class="card-list">
      <article v-for="s in filteredSignals" :key="s.code" class="card card-open" @click="openDetail(s.code)">
        <div class="stock-card-head">
          <span>
            <span class="stock-card-code">{{ s.code }}</span>
            <span class="stock-card-name">{{ s.name }}</span>
          </span>
          <span class="stock-card-score">{{ s.armorScore != null ? s.armorScore.toFixed(1) : '-' }}</span>
        </div>
        <div class="stock-card-strategy" :style="{ color: strategyColor(s.strategy) }">
          {{ s.strategy }}　{{ s.action }}
        </div>
        <div v-if="s.interpretation" class="stock-card-note">{{ s.interpretation }}</div>
        <div v-if="s.predictedReturn1m != null || s.predictedDownsideResistance != null" class="stock-card-note dim">
          因子模型預測：
          <template v-if="s.predictedReturn1m != null">1個月 {{ fmtPct(s.predictedReturn1m, 1) }}</template>
          <template v-if="s.predictedDownsideResistance != null">　抗跌力 {{ fmtPct(s.predictedDownsideResistance, 2) }}</template>
        </div>
        <div v-if="s.monitorUrl" class="stock-card-note">
          <a :href="s.monitorUrl" target="_blank" rel="noopener" @click.stop>監控連結 ↗</a>
        </div>
      </article>
      <p v-if="!loading && latestDate && filteredSignals.length === 0" class="hint">
        {{ searchText ? '今天的戰報裡沒有符合搜尋的股票，上面「搜尋結果」可以找任何股票看詳情。' : '今天沒有訊號。' }}
      </p>
      <p v-if="!loading && !error && !latestDate" class="hint">
        還沒有任何戰報資料——請先手動觸發一次 generateDailyReport，或等排程執行。
      </p>
    </div>

    <p class="hint dashboard-note">
      點卡片可以看股票詳情（走勢圖、戰報燈號歷史、AI 診斷紀錄，也可以在
      那裡跑新的深度診斷）。即時報價還沒遷移，需要這個功能請先用舊版網頁
      應用程式。
    </p>
  </section>
</template>
