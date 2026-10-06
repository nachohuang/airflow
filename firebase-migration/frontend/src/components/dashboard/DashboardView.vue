<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { collectionGroup, collection, query, orderBy, limit, getDocs, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase';

const loading = ref(true);
const error = ref('');
const latestDate = ref(null);
const signals = ref([]);
const searchText = ref('');
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

onMounted(load);
onUnmounted(function () {
  if (unsubscribe) unsubscribe();
});
</script>

<template>
  <section class="dashboard-view">
    <div class="search-bar">
      <input v-model="searchText" placeholder="輸入股票代號或名稱搜尋（例如 2330 或 台積電）">
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="loading" class="hint">載入中...</p>

    <div v-if="!loading && latestDate" class="meta-bar">
      {{ latestDate }} 戰報，共 {{ signals.length }} 筆訊號<template v-if="searchText">（篩選後 {{ filteredSignals.length }} 筆）</template>
    </div>

    <div class="card-list">
      <article v-for="s in filteredSignals" :key="s.code" class="card">
        <header>
          <strong>{{ s.code }} {{ s.name }}</strong>
          <span class="signal-badge">{{ s.strategy }}</span>
        </header>
        <div class="card-body">
          <div>Armor Score：{{ s.armorScore != null ? s.armorScore.toFixed(1) : '-' }}</div>
          <div>{{ s.action }}</div>
          <div v-if="s.interpretation">{{ s.interpretation }}</div>
          <div v-if="s.predictedReturn1m != null || s.predictedDownsideResistance != null">
            因子模型預測：
            <template v-if="s.predictedReturn1m != null">1個月 {{ fmtPct(s.predictedReturn1m, 1) }}</template>
            <template v-if="s.predictedDownsideResistance != null">　抗跌力 {{ fmtPct(s.predictedDownsideResistance, 2) }}</template>
          </div>
          <div v-if="s.monitorUrl">
            <a :href="s.monitorUrl" target="_blank" rel="noopener">監控連結 ↗</a>
          </div>
        </div>
      </article>
      <p v-if="!loading && latestDate && filteredSignals.length === 0" class="hint">
        {{ searchText ? '沒有符合搜尋的股票。' : '今天沒有訊號。' }}
      </p>
      <p v-if="!loading && !error && !latestDate" class="hint">
        還沒有任何戰報資料——請先手動觸發一次 generateDailyReport，或等排程執行。
      </p>
    </div>

    <p class="hint dashboard-note">
      這個頁面目前只顯示戰報清單，股票搜尋（點進去看詳情）、AI 診斷、個股走勢圖還沒遷移，
      需要這些功能請先用舊版網頁應用程式。
    </p>
  </section>
</template>
