<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';

/** 跟 functions/lib/analysis.js 的 SCREENING_STRATEGIES 是同一份清單（key／label）
 *  ——那邊是純運算邏輯用的 Node 模組，這裡是獨立的前端套件，不方便直接 import，
 *  手動保持同步；兩邊其中一邊新增/改名策略，記得回來同步這份清單。 */
const STRATEGIES = [
  { key: 'rule_v17', label: 'v17.0 規則式門檻（現行）' },
  { key: 'factor_model_rank', label: '因子模型排名精選' },
  { key: 'hybrid', label: '規則式門檻＋模型排名混合' }
];

/** 跟 apps-script/src/Index.html 的 #bqSourceModeSelect 選項文字一致。 */
const SOURCE_MODES = [
  { key: 'native', label: '同步進 BigQuery（native，查詢快，需要先匯入成月份檔案）' },
  { key: 'external', label: '直接讀 Drive 檔案（external，免匯入，查詢較慢）' },
  { key: 'materialized', label: '自動整理進 BigQuery（materialized，推薦）' }
];

const config = ref(null);
const loading = ref(true);
const error = ref('');
const saving = ref(false);
const savedAt = ref('');
let unsubscribe = null;

onMounted(function () {
  const configRef = doc(db, 'config', 'app');
  unsubscribe = onSnapshot(
    configRef,
    function (snap) {
      config.value = snap.exists() ? snap.data() : null;
      loading.value = false;
    },
    function (e) {
      error.value = e.message || String(e);
      loading.value = false;
    }
  );
});

onUnmounted(function () {
  if (unsubscribe) unsubscribe();
});

/** field 可以是巢狀欄位的點記法（例如 'bigQuery.sourceMode'）——Firestore 的
 *  updateDoc 看到點記法的 key 只會更新那一個巢狀欄位，不會把整個 bigQuery map
 *  覆蓋掉，所以不用先讀出整份 map 再拼回去。 */
async function saveField(field, value) {
  saving.value = true;
  error.value = '';
  try {
    await updateDoc(doc(db, 'config', 'app'), { [field]: value });
    savedAt.value = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="admin-view">
    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="loading" class="hint">載入中...</p>
    <p v-if="!loading && !config" class="hint">
      Firestore 裡找不到 config/app 文件——請先完成 Phase 2 的 config/app 遷移。
    </p>

    <template v-if="config">
      <div class="form-card">
        <h3>篩選策略</h3>
        <label>目前使用的篩選邏輯
          <select :value="config.screeningStrategy" :disabled="saving"
            @change="saveField('screeningStrategy', $event.target.value)">
            <option v-for="s in STRATEGIES" :key="s.key" :value="s.key">{{ s.label }}</option>
          </select>
        </label>
        <p class="hint">改了之後，下次 generateDailyReport 執行（排程或手動觸發）就會套用新策略。</p>
      </div>

      <div class="form-card">
        <h3>BigQuery 設定</h3>
        <label>資料來源模式
          <select :value="config.bigQuery?.sourceMode" :disabled="saving"
            @change="saveField('bigQuery.sourceMode', $event.target.value)">
            <option v-for="m in SOURCE_MODES" :key="m.key" :value="m.key">{{ m.label }}</option>
          </select>
        </label>
        <p class="hint">
          專案 ID：{{ config.bigQuery?.projectId || '（未設定）' }}
          資料集：{{ config.bigQuery?.dataset || '（未設定）' }}<br>
          這兩項跟每 TB 查詢費率需要改的話，目前還是要去 Firebase Console 的
          Firestore 資料庫頁面直接編輯 config/app 文件——打錯字會讓戰報查不到資料，
          先不開放在這裡直接改。
        </p>
      </div>

      <p v-if="savedAt" class="hint">已儲存（{{ savedAt }}）</p>
    </template>

    <p class="hint dashboard-note">
      AI 診斷設定（API 金鑰）、用量統計、History 補抓/整理工具還沒遷移到這裡，
      需要這些功能請先用舊版網頁應用程式。
    </p>
  </section>
</template>
