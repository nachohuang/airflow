<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { collection, doc, onSnapshot, updateDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { callFn } from '../../composables/useCallable';

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

const AI_PROVIDERS = [
  { key: 'claude', label: 'Claude' },
  { key: 'gemini', label: 'Gemini' }
];

const config = ref(null);
const loading = ref(true);
const error = ref('');
const saving = ref(false);
const savedAt = ref('');
let unsubscribeConfig = null;

onMounted(function () {
  const configRef = doc(db, 'config', 'app');
  unsubscribeConfig = onSnapshot(
    configRef,
    function (snap) {
      config.value = snap.exists() ? snap.data() : null;
      loading.value = false;
      if (!scheduleFormTouched.value) resetScheduleForm();
      if (!pricingFormTouched.value) resetPricingForm();
      if (!dailyAiFormTouched.value) resetDailyAiForm();
    },
    function (e) {
      error.value = e.message || String(e);
      loading.value = false;
    }
  );
});

onUnmounted(function () {
  if (unsubscribeConfig) unsubscribeConfig();
  if (unsubscribeSkipDates) unsubscribeSkipDates();
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

// ---- 每日排程設定（triggerHour/triggerMinute/skipWeekends） ----
// 數字輸入框不適合像下拉選單那樣「一改就馬上存檔」（打字過程中每一個字元都會
// 觸發一次 @change），改用本機草稿 + 明確的「套用」按鈕；草稿初始值跟著
// Firestore 文件更新，但使用者開始編輯後（scheduleFormTouched）就不再被
// Firestore 的即時更新蓋掉，避免自己正在改的東西被遠端快照打斷。
const scheduleForm = ref({ triggerHour: 23, triggerMinute: 0, skipWeekends: true });
const scheduleFormTouched = ref(false);
const scheduleSaving = ref(false);
const scheduleSavedAt = ref('');

function resetScheduleForm() {
  if (!config.value) return;
  scheduleForm.value = {
    triggerHour: config.value.triggerHour != null ? config.value.triggerHour : 23,
    triggerMinute: config.value.triggerMinute != null ? config.value.triggerMinute : 0,
    skipWeekends: config.value.skipWeekends !== false
  };
}

async function saveSchedule() {
  scheduleSaving.value = true;
  error.value = '';
  try {
    const hour = Math.max(0, Math.min(23, Number(scheduleForm.value.triggerHour) || 0));
    const minute = Math.max(0, Math.min(59, Number(scheduleForm.value.triggerMinute) || 0));
    await updateDoc(doc(db, 'config', 'app'), {
      triggerHour: hour,
      triggerMinute: minute,
      skipWeekends: !!scheduleForm.value.skipWeekends
    });
    scheduleSavedAt.value = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    scheduleFormTouched.value = false;
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    scheduleSaving.value = false;
  }
}

// ---- 不跑日（skip_dates） ----
const skipDates = ref([]);
const newSkipDate = ref('');
const newSkipReason = ref('');
const skipDateSaving = ref(false);
let unsubscribeSkipDates = null;

onMounted(function () {
  unsubscribeSkipDates = onSnapshot(
    collection(db, 'skip_dates'),
    function (snap) {
      skipDates.value = snap.docs
        .map(function (d) { return d.data(); })
        .sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; });
    },
    function (e) {
      error.value = e.message || String(e);
    }
  );
});

async function addSkipDate() {
  if (!newSkipDate.value) return;
  skipDateSaving.value = true;
  error.value = '';
  try {
    await setDoc(doc(db, 'skip_dates', newSkipDate.value), {
      date: newSkipDate.value,
      reason: newSkipReason.value || ''
    });
    newSkipDate.value = '';
    newSkipReason.value = '';
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    skipDateSaving.value = false;
  }
}

async function removeSkipDate(date) {
  if (!window.confirm(`確定要移除 ${date} 這個不跑日嗎？`)) return;
  error.value = '';
  try {
    await deleteDoc(doc(db, 'skip_dates', date));
  } catch (e) {
    error.value = e.message || String(e);
  }
}

// ---- AI 設定（provider／金鑰狀態／價格單位） ----
// 金鑰狀態要打 getAiKeyStatus 這支 onCall 才能知道（絕不把金鑰本身放進
// Firestore，見 README「AI 診斷」那節）——跟 config.value 的其他欄位不同，
// 不是 onSnapshot 即時監聽來的，只在頁面打開時查一次。
const keyStatus = ref(null);
const keyStatusError = ref('');

onMounted(async function () {
  try {
    keyStatus.value = await callFn('getAiKeyStatus', {});
  } catch (e) {
    keyStatusError.value = e.message || String(e);
  }
});

// pricing 四個數字輸入框，跟「每日排程」的 scheduleForm 同一個理由用草稿 +
// 「套用」按鈕（打字過程每個字元都會觸發 @input，不適合像下拉選單那樣
// 一改就存）。
const pricingForm = ref({ claudeInputPerM: 3, claudeOutputPerM: 15, geminiInputPerM: 0.3, geminiOutputPerM: 2.5 });
const pricingFormTouched = ref(false);
const pricingSaving = ref(false);
const pricingSavedAt = ref('');

function resetPricingForm() {
  if (!config.value || !config.value.pricing) return;
  pricingForm.value = Object.assign({}, pricingForm.value, config.value.pricing);
}

async function savePricing() {
  pricingSaving.value = true;
  error.value = '';
  try {
    await updateDoc(doc(db, 'config', 'app'), {
      pricing: {
        claudeInputPerM: Math.max(0, Number(pricingForm.value.claudeInputPerM) || 0),
        claudeOutputPerM: Math.max(0, Number(pricingForm.value.claudeOutputPerM) || 0),
        geminiInputPerM: Math.max(0, Number(pricingForm.value.geminiInputPerM) || 0),
        geminiOutputPerM: Math.max(0, Number(pricingForm.value.geminiOutputPerM) || 0)
      }
    });
    pricingSavedAt.value = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    pricingFormTouched.value = false;
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    pricingSaving.value = false;
  }
}

// ---- 每日自動 AI 診斷（aiDailyEnabled／aiDailyTopN） ----
// 跟排程/價格單位同一個草稿 + 套用按鈕模式——topN 是數字輸入框，不適合一改就存。
// aiDailyEnabled 這顆 checkbox 理論上可以跟其他下拉選單一樣「一改就存」，但跟
// topN 放在同一張卡片、同一個「套用」按鈕一起送出，使用者比較容易理解這兩個
// 設定是綁在一起的（開關 + 開了之後要掃幾檔），不用分開套用兩次。
const dailyAiForm = ref({ aiDailyEnabled: false, aiDailyTopN: 5 });
const dailyAiFormTouched = ref(false);
const dailyAiSaving = ref(false);
const dailyAiSavedAt = ref('');

function resetDailyAiForm() {
  if (!config.value) return;
  dailyAiForm.value = {
    aiDailyEnabled: !!config.value.aiDailyEnabled,
    aiDailyTopN: config.value.aiDailyTopN != null ? config.value.aiDailyTopN : 5
  };
}

async function saveDailyAiSettings() {
  dailyAiSaving.value = true;
  error.value = '';
  try {
    // 跟 apps-script 版 setAiDailySettings 同一個夾限範圍（3~10）——候選名單
    // 太窄失去「先擴大候選、再讓基本面篩選」的意義，太寬則逐檔深度診斷的時間
    // /費用會線性增加。
    const topN = Math.max(3, Math.min(10, Number(dailyAiForm.value.aiDailyTopN) || 5));
    await updateDoc(doc(db, 'config', 'app'), {
      aiDailyEnabled: !!dailyAiForm.value.aiDailyEnabled,
      aiDailyTopN: topN
    });
    dailyAiSavedAt.value = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    dailyAiFormTouched.value = false;
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    dailyAiSaving.value = false;
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
        <h3>每日排程</h3>
        <label>執行時間（台北時間）
          <div class="schedule-time-inputs">
            <input
              v-model.number="scheduleForm.triggerHour" type="number" min="0" max="23"
              @input="scheduleFormTouched = true"
            >
            <span>時</span>
            <input
              v-model.number="scheduleForm.triggerMinute" type="number" min="0" max="59"
              @input="scheduleFormTouched = true"
            >
            <span>分</span>
          </div>
        </label>
        <label class="checkbox-label">
          <input
            v-model="scheduleForm.skipWeekends" type="checkbox"
            @change="scheduleFormTouched = true"
          >
          週末不執行
        </label>
        <div class="form-actions">
          <button type="button" :disabled="scheduleSaving" @click="saveSchedule">
            {{ scheduleSaving ? '套用中...' : '套用排程設定' }}
          </button>
        </div>
        <p v-if="scheduleSavedAt" class="hint">已套用（{{ scheduleSavedAt }}）</p>
        <p class="hint">
          改了之後最多等 5 分鐘生效（Cloud Scheduler 每 5 分鐘檢查一次是不是到了
          設定的執行時間，不是改了馬上觸發，也不是精準到那一分鐘，誤差在 5 分鐘內）。
        </p>
      </div>

      <div class="form-card">
        <h3>不跑日（暫停排程的特定日期）</h3>
        <form class="skip-date-form" @submit.prevent="addSkipDate">
          <input v-model="newSkipDate" type="date" required>
          <input v-model="newSkipReason" placeholder="原因（選填，例如國定假日）">
          <button type="submit" :disabled="skipDateSaving">
            {{ skipDateSaving ? '新增中...' : '新增' }}
          </button>
        </form>
        <ul v-if="skipDates.length" class="skip-date-list">
          <li v-for="d in skipDates" :key="d.date">
            <span>{{ d.date }}<template v-if="d.reason">（{{ d.reason }}）</template></span>
            <button type="button" @click="removeSkipDate(d.date)">移除</button>
          </li>
        </ul>
        <p v-else class="hint">目前沒有設定不跑日。</p>
      </div>

      <div class="form-card">
        <h3>AI 設定</h3>
        <label>深度診斷使用的供應商
          <select :value="config.aiProvider" :disabled="saving"
            @change="saveField('aiProvider', $event.target.value)">
            <option v-for="p in AI_PROVIDERS" :key="p.key" :value="p.key">{{ p.label }}</option>
          </select>
        </label>

        <p class="hint">
          API 金鑰狀態：
          <template v-if="keyStatusError">查詢失敗（{{ keyStatusError }}）</template>
          <template v-else-if="!keyStatus">查詢中...</template>
          <template v-else>
            Claude {{ keyStatus.hasClaudeKey ? '已設定 ✓' : '未設定' }}，
            Gemini {{ keyStatus.hasGeminiKey ? '已設定 ✓' : '未設定' }}
          </template>
        </p>
        <p class="hint">
          金鑰本身不會存在 Firestore 或任何前端看得到的地方，只能用終端機設定：
          <code>firebase functions:secrets:set ANTHROPIC_API_KEY</code> /
          <code>GEMINI_API_KEY</code>，設定後要重新部署一次才會生效。
        </p>

        <label>Claude 單價（USD／每百萬 tokens）</label>
        <div class="schedule-time-inputs">
          <input
            v-model.number="pricingForm.claudeInputPerM" type="number" min="0" step="0.01"
            @input="pricingFormTouched = true"
          >
          <span>輸入</span>
          <input
            v-model.number="pricingForm.claudeOutputPerM" type="number" min="0" step="0.01"
            @input="pricingFormTouched = true"
          >
          <span>輸出</span>
        </div>
        <label>Gemini 單價（USD／每百萬 tokens）</label>
        <div class="schedule-time-inputs">
          <input
            v-model.number="pricingForm.geminiInputPerM" type="number" min="0" step="0.01"
            @input="pricingFormTouched = true"
          >
          <span>輸入</span>
          <input
            v-model.number="pricingForm.geminiOutputPerM" type="number" min="0" step="0.01"
            @input="pricingFormTouched = true"
          >
          <span>輸出</span>
        </div>
        <div class="form-actions">
          <button type="button" :disabled="pricingSaving" @click="savePricing">
            {{ pricingSaving ? '套用中...' : '套用價格單位' }}
          </button>
        </div>
        <p v-if="pricingSavedAt" class="hint">已套用（{{ pricingSavedAt }}）</p>
        <p class="hint">
          只影響診斷結果顯示的「預估費用」計算，不是真正的計費依據——真實費用
          以 Anthropic／Google 帳單為準，單價抓錯這裡只會讓預估數字不準，不影響
          實際扣款。
        </p>
      </div>

      <div class="form-card">
        <h3>每日自動 AI 診斷</h3>
        <label class="checkbox-label">
          <input
            v-model="dailyAiForm.aiDailyEnabled" type="checkbox"
            @change="dailyAiFormTouched = true"
          >
          排程算完戰報後，自動跑 Top3 橫向推薦 + 候選名單橫向比較深度診斷
        </label>
        <label>候選名單大小（3~10 檔，橫向比較後全部送進深度診斷）
          <input
            v-model.number="dailyAiForm.aiDailyTopN" type="number" min="3" max="10"
            @input="dailyAiFormTouched = true"
          >
        </label>
        <div class="form-actions">
          <button type="button" :disabled="dailyAiSaving" @click="saveDailyAiSettings">
            {{ dailyAiSaving ? '套用中...' : '套用設定' }}
          </button>
        </div>
        <p v-if="dailyAiSavedAt" class="hint">已套用（{{ dailyAiSavedAt }}）</p>
        <p class="hint">
          開啟後，每天戰報算完（見上面「每日排程」）會多花一次 Top3 橫向推薦 +
          候選名單橫向比較的 LLM 呼叫（不查財報，成本低），橫向比較選出的候選
          名單會「全部」送進深度診斷（會查 Goodinfo／證交所財報，逐檔花費跟
          單檔手動跑「跑新的深度診斷」一樣）——候選名單愈大，當天的 AI 花費跟
          耗時愈高。手動重新掃描的按鈕在戰報頁面最上方的「AI Top3 推薦」卡片，
          不是這裡。
        </p>
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
      AI 用量統計歷史、History 補抓/整理工具還沒遷移到這裡，需要這些功能
      請先用舊版網頁應用程式。
    </p>
  </section>
</template>
