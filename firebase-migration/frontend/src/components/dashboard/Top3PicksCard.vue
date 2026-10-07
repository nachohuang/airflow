<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { collection, doc, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase';
import { callFn } from '../../composables/useCallable';
import { renderMarkdownLite } from '../../utils/markdownLite';

const latest = ref(null);
const loading = ref(true);
const error = ref('');
const running = ref(false);
const runError = ref('');
let unsubscribe = null;

// 2026-10-07：跟 StockDetailView.vue 的 AI 診斷同一個理由（見 README
// 「補抓區間：用 jobs/{jobKey} 取代等這次呼叫本身回應」）——這張卡片顯示
// 的 `latest` 本來就是直接監聽 `ai_diagnosis`，掃描完成會自動更新，已經
// 不受元件重新掛載影響；但「正在掃描中」這個過程狀態本來是純本地的
// `running`，App 切到背景或切頁再切回來一樣會被重置成「可以按」，看不出
// 其實後端可能還在跑。改成額外監聽 `jobs/aiTopPicks` 補上這段過程可見度。
const topPicksJob = ref(null);
let unsubscribeJob = null;
const scanBusy = computed(function () {
  return running.value || (topPicksJob.value && topPicksJob.value.status === 'running');
});

/**
 * `ai_diagnosis` 的 TOP3 推薦文件 ID 是 `TOP3_{date}_top3`（每天一筆，見
 * functions/index.js 的 runTopPicksCore_），這裡只用 `.where('code','==','TOP3')`
 * 單欄等號查詢（不加 `orderBy`）——跟 StockDetailView 讀某檔股票 AI 診斷歷史
 * 同一個理由：單欄等號查詢不需要額外的複合索引，排序交給前端在記憶體裡做
 * （同一個 code 的歷史文件數很少，不值得為了省這幾筆排序多部署一個索引，
 * 這個教訓這個專案已經撞過三次，見 README「每天累積的股價...」那節的「坑」）。
 */
onMounted(function () {
  unsubscribe = onSnapshot(
    query(collection(db, 'ai_diagnosis'), where('code', '==', 'TOP3')),
    function (snap) {
      const docs = snap.docs.map(function (d) { return d.data(); });
      docs.sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; });
      latest.value = docs[0] || null;
      loading.value = false;
    },
    function (e) {
      error.value = e.message || String(e);
      loading.value = false;
    }
  );
});
onMounted(function () {
  unsubscribeJob = onSnapshot(doc(db, 'jobs', 'aiTopPicks'), function (snap) {
    topPicksJob.value = snap.exists() ? snap.data() : null;
  });
});
onUnmounted(function () {
  if (unsubscribe) unsubscribe();
  if (unsubscribeJob) unsubscribeJob();
});

/** 跟 StockDetailView 的「跑新的深度診斷」按鈕同一個模式：呼叫 onCall，成功後
 *  不用自己刷新顯示——上面的 onSnapshot 本來就在即時監聽，寫入 Firestore 後
 *  會自動收到新文件。 */
async function runNow() {
  running.value = true;
  runError.value = '';
  try {
    await callFn('runAiTopPicks', {});
  } catch (e) {
    // 「送出就失敗」才顯示（例如沒有戰報資料可以比較）；deadline-exceeded／
    // unavailable 這類連線層級的錯誤不代表後端真的失敗，真正狀態看
    // topPicksJob／latest 即時監聽到的內容，見 StockDetailView.vue 同一個
    // 理由的說明。
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      runError.value = e.message || String(e);
    }
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <details class="form-card top3-picks-card">
    <summary>
      🏆 AI Top3 推薦
      <template v-if="latest">（{{ latest.date }}，{{ latest.candidateCount }} 檔候選）</template>
    </summary>

    <div class="toolbar">
      <button type="button" :disabled="scanBusy" @click.prevent="runNow">
        {{ scanBusy ? '掃描中（約需 30 秒~1 分鐘）...' : '重新掃描 Top3' }}
      </button>
    </div>
    <p v-if="runError" class="error-box">{{ runError }}</p>
    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="loading" class="hint">載入中...</p>
    <div v-else-if="latest" class="ai-report" v-html="renderMarkdownLite(latest.content)"></div>
    <p v-else class="hint">
      還沒有 Top3 推薦紀錄——按上面「重新掃描 Top3」手動跑一次，或到 Admin
      頁面開啟「每日自動 AI 診斷」讓排程每天自動跑。
    </p>
  </details>
</template>
