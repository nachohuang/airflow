<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { collection, doc, onSnapshot, updateDoc, setDoc, deleteDoc, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../../firebase';
import { callFn } from '../../composables/useCallable';
import HistoryCalendarCard from './HistoryCalendarCard.vue';

/** 跟 functions/lib/analysis.js 的 SCREENING_STRATEGIES 是同一份清單（key／label）
 *  ——那邊是純運算邏輯用的 Node 模組，這裡是獨立的前端套件，不方便直接 import，
 *  手動保持同步；兩邊其中一邊新增/改名策略，記得回來同步這份清單。 */
const STRATEGIES = [
  { key: 'rule_v17', label: 'v17.0 規則式門檻（現行）' },
  { key: 'factor_model_rank', label: '因子模型排名精選' },
  { key: 'hybrid', label: '規則式門檻＋模型排名混合' }
];

/**
 * 2026-10-07：文字對照更新過——apps-script/src/Index.html 的 #bqSourceModeSelect
 * 選項文字是「native 需要先匯入成月份檔案」那個年代的描述，現在 Firebase 版
 * 的每日股價抓取（見下面「歷史股價資料」卡片）一律直接寫進 history_raw，
 * native 模式直接讀 history_raw、是三個模式裡最新鮮的，不再需要先匯入月份
 * 檔案這個前提。external 模式讀的是 Drive 外部資料表，新抓到的資料不會出現
 * 在那裡（見下面「歷史股價資料」卡片的架構說明），特別標註。
 */
const SOURCE_MODES = [
  { key: 'native', label: '直接讀最新寫入的資料（native，最新鮮，推薦）' },
  { key: 'materialized', label: '整理過的歷史基準 + 最新資料（materialized）' },
  { key: 'external', label: '即時讀 Drive 檔案（external，看不到新抓的資料，見下方說明）' }
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

// ---- AI 用量統計（最近 30 天）----
// 跟金鑰狀態同一個模式：頁面打開時查一次，不是即時監聽（用量歷史不需要
// 「秒級更新」，使用者按「重新整理」或重新打開頁面就夠了）。
const usageSummary = ref(null);
const usageError = ref('');
const usageLoading = ref(true);

async function loadUsageSummary() {
  usageLoading.value = true;
  usageError.value = '';
  try {
    usageSummary.value = await callFn('getAiUsageSummary', { days: 30 });
  } catch (e) {
    usageError.value = e.message || String(e);
  } finally {
    usageLoading.value = false;
  }
}
onMounted(loadUsageSummary);

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

// ---- 歷史股價資料（資料總覽／立即抓取／補抓區間） ----
// 跟 apps-script 版「資料總覽」頁面同一個用途，見 functions/index.js
// getHistoryOverview／runManualHistoryFetch／runHistoryBackfill 的說明。
const historyOverview = ref(null);
const historyOverviewError = ref('');
const historyOverviewLoading = ref(true);

async function loadHistoryOverview() {
  historyOverviewLoading.value = true;
  historyOverviewError.value = '';
  try {
    historyOverview.value = await callFn('getHistoryOverview', {});
  } catch (e) {
    historyOverviewError.value = e.message || String(e);
  } finally {
    historyOverviewLoading.value = false;
  }
}
onMounted(loadHistoryOverview);

const fetchTodayRunning = ref(false);
const fetchTodayResult = ref(null);
const fetchTodayError = ref('');

async function fetchTodayNow() {
  fetchTodayRunning.value = true;
  fetchTodayError.value = '';
  fetchTodayResult.value = null;
  try {
    fetchTodayResult.value = await callFn('runManualHistoryFetch', {});
    await loadHistoryOverview();
  } catch (e) {
    fetchTodayError.value = e.message || String(e);
  } finally {
    fetchTodayRunning.value = false;
  }
}

// 2026-10-07：原本 backfillRunning／backfillResult／backfillError 是純前端
// 本地狀態，跟著這次 callFn 呼叫本身走——使用者實際回報：按下「開始補抓」
// 後把 App 切到背景，回來看不到任何進度。根因有兩層：(1) 手機瀏覽器切到
// 背景常常直接把這次呼叫的連線中斷掉，但後端其實不受影響、還是會繼續跑
// 完，只是「回應送不回這個已經斷線的瀏覽器」；(2) 如果使用者是在 App 內
// 切頁籤（例如切到「戰報與個股」再切回「系統與資料後台」），這個元件會被
// 整個砍掉重建，`ref` 裡存的「目前在執行中」狀態也跟著消失。改成後端在
// 開始/完成時都把狀態寫進 `jobs/historyBackfill`（見 index.js
// writeJobStatus_ 的完整說明），前端改用 onSnapshot 即時監聽那份文件來
// 畫面——不管是不是同一次連線、同一個元件實例收到最終結果，重新打開頁面
// 都看得到當下真正的狀態，跟舊版 apps-script「排程佇列」的體驗一致。
const backfillForm = ref({ startDate: '', endDate: '', skipWeekends: true });
const backfillStarting = ref(false); // 只蓋「按下按鈕到 onCall 回應」這一小段
const backfillStartError = ref(''); // 只在「送出就失敗」（例如驗證錯誤）時顯示
const backfillJob = ref(null);
let unsubscribeBackfillJob = null;

onMounted(function () {
  unsubscribeBackfillJob = onSnapshot(doc(db, 'jobs', 'historyBackfill'), function (snap) {
    backfillJob.value = snap.exists() ? snap.data() : null;
  });
});
onUnmounted(function () {
  if (unsubscribeBackfillJob) unsubscribeBackfillJob();
});

// 工作完成（狀態從執行中變成別的）就順便刷新「資料總覽」——不管使用者這段
// 期間是不是真的一直盯著這個瀏覽器分頁，只要分頁現在是開著的就會自動更新。
watch(backfillJob, function (newVal, oldVal) {
  if (newVal && newVal.status !== 'running' && oldVal && oldVal.status === 'running') {
    loadHistoryOverview();
  }
});

const backfillJobStatusLabel = computed(function () {
  if (!backfillJob.value) return '';
  const labels = { running: '執行中', succeeded: '成功', partial: '部分成功', failed: '失敗' };
  return labels[backfillJob.value.status] || backfillJob.value.status;
});

// 2026-10-07 修正：原本只要 backfillJob.status === 'running' 就把按鈕鎖死，
// 使用者實際遇到的狀況——補抓一個 9~10 個交易日的區間，後端跑到被 Cloud
// Functions 平台自己的逾時強制中止（見 index.js runHistoryBackfill 的說明），
// 平台強制中止不會走到後端自己的 try/catch，jobs/historyBackfill 永遠不會
// 被改成 'failed'，卡在 'running' 回不去——使用者因此完全沒辦法按「開始
// 補抓」開始下一次。這是單人工具，不需要真的防「使用者自己跟自己搶」這種
// 並發保護：拿掉這個硬擋，按鈕永遠可以按，使用者想重試隨時能重試（新的
// 呼叫一開始就會把 jobs/historyBackfill 覆寫成新的 'running'，等於自動
// 覆蓋掉卡住的舊狀態，不需要額外的「清除卡住工作」按鈕）。上面的即時狀態
// 卡片維持顯示，純粹當作資訊參考，不再是「能不能按」的判斷依據。
async function runBackfillNow() {
  backfillStarting.value = true;
  backfillStartError.value = '';
  try {
    await callFn('runHistoryBackfill', {
      startDate: backfillForm.value.startDate,
      endDate: backfillForm.value.endDate,
      skipWeekends: !!backfillForm.value.skipWeekends
    }, 1800000); // 跟後端 exports.runHistoryBackfill 宣告的 timeoutSeconds: 1800 對齊
    // 回傳值不需要處理——執行狀態一律透過上面的 jobs/historyBackfill 監聽
    // 顯示，這裡呼叫送出後就結束，`loadHistoryOverview` 交給上面的 watch
    // 在工作真正完成時觸發。
  } catch (e) {
    // 「送出就失敗」（驗證錯誤／沒有 BigQuery 設定／沒有登入）才在這裡顯示；
    // deadline-exceeded／unavailable 這類連線層級的錯誤不代表後端真的失敗
    // ——後端通常還是會繼續跑完，真正的結果看上面即時監聽到的執行狀態，
    // 這裡顯示反而會誤導使用者以為操作失敗了。
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      backfillStartError.value = e.message || String(e);
    }
  } finally {
    backfillStarting.value = false;
  }
}

// ---- 手動重新計算戰報（只跑「重新計算戰報」這一步）----
// 2026-10-07：使用者發現 Admin 頁面完全沒有地方可以手動觸發這個動作——
// `generateDailyReport`（onRequest）原本只能用 curl 打，前端沒有接線。
// 第一版只用本地 ref 狀態（理由：這支很快，通常數秒到十幾秒，不碰
// TWSE／BigQuery 寫入，風險比補抓區間低很多）——使用者後續直接點名：
// 畫面切走一樣會「忘記」還在計算中，要求所有手動操作都要有一致的體驗，
// 不要只有這顆按鈕是例外。改成跟「補抓區間」「執行完整排程」同一套
// jobs/reportRecompute 監聽模式（見 index.js runManualReportRecomputeCore_
// 的說明），不再是特例。
const reportRecomputeStarting = ref(false);
const reportRecomputeStartError = ref('');
const reportRecomputeJob = ref(null);
let unsubscribeReportRecomputeJob = null;

onMounted(function () {
  unsubscribeReportRecomputeJob = onSnapshot(doc(db, 'jobs', 'reportRecompute'), function (snap) {
    reportRecomputeJob.value = snap.exists() ? snap.data() : null;
  });
});
onUnmounted(function () {
  if (unsubscribeReportRecomputeJob) unsubscribeReportRecomputeJob();
});

const reportRecomputeJobStatusLabel = computed(function () {
  if (!reportRecomputeJob.value) return '';
  const labels = { running: '執行中', succeeded: '成功', failed: '失敗' };
  return labels[reportRecomputeJob.value.status] || reportRecomputeJob.value.status;
});

async function runReportRecomputeNow() {
  reportRecomputeStarting.value = true;
  reportRecomputeStartError.value = '';
  try {
    await callFn('runManualReportRecompute', {});
  } catch (e) {
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      reportRecomputeStartError.value = e.message || String(e);
    }
  } finally {
    reportRecomputeStarting.value = false;
  }
}

// ---- 執行完整排程（補抓資料→重新計算戰報→AI 診斷三步都跑）----
// 2026-10-07：對應 apps-script 版「測試完整排程流程（5 步驟）」按鈕，跟
// 「補抓區間」同一個理由用 jobs/fullSchedule 追蹤狀態（這條路徑同時包含
// 補抓資料跟 AI 診斷，一樣有跑很久、連線中斷、元件被切走的風險）。
const fullScheduleStarting = ref(false);
const fullScheduleStartError = ref('');
const fullScheduleJob = ref(null);
let unsubscribeFullScheduleJob = null;

onMounted(function () {
  unsubscribeFullScheduleJob = onSnapshot(doc(db, 'jobs', 'fullSchedule'), function (snap) {
    fullScheduleJob.value = snap.exists() ? snap.data() : null;
  });
});
onUnmounted(function () {
  if (unsubscribeFullScheduleJob) unsubscribeFullScheduleJob();
});

watch(fullScheduleJob, function (newVal, oldVal) {
  if (newVal && newVal.status !== 'running' && oldVal && oldVal.status === 'running') {
    loadHistoryOverview();
  }
});

const fullScheduleJobStatusLabel = computed(function () {
  if (!fullScheduleJob.value) return '';
  const labels = { running: '執行中', succeeded: '成功', failed: '失敗' };
  return labels[fullScheduleJob.value.status] || fullScheduleJob.value.status;
});

async function runFullScheduleNow() {
  fullScheduleStarting.value = true;
  fullScheduleStartError.value = '';
  try {
    await callFn('runFullScheduleNow', {}, 1800000); // 跟後端宣告的 timeoutSeconds: 1800 對齊
  } catch (e) {
    const code = e.code || '';
    if (code.indexOf('invalid-argument') >= 0 || code.indexOf('failed-precondition') >= 0 || code.indexOf('permission-denied') >= 0) {
      fullScheduleStartError.value = e.message || String(e);
    }
  } finally {
    fullScheduleStarting.value = false;
  }
}

// ---- 執行紀錄（run_log）----
// 跟 apps-script 版「後台管理」頁面的「執行紀錄」同一個用途，見
// functions/index.js logRun_ 的說明——每日排程、手動抓取/補抓、AI 診斷等
// 操作都會各自記一筆成功/失敗。直接用 Firestore client SDK 查詢（規則已經
// 開放 owner 讀取，見 firestore.rules），不經過 onCall：這裡只是單純依
// 時間新到舊排序取最近 N 筆，沒有需要額外聚合計算。即時監聽（onSnapshot）
// ——排程/手動操作寫入新紀錄時，畫面不用手動重新整理就會自動更新。
const runLogEntries = ref([]);
const runLogError = ref('');
const runLogLoading = ref(true);
let unsubscribeRunLog = null;

onMounted(function () {
  unsubscribeRunLog = onSnapshot(
    query(collection(db, 'run_log'), orderBy('timestampMs', 'desc'), limit(50)),
    function (snap) {
      runLogEntries.value = snap.docs.map(function (d) { return d.data(); });
      runLogLoading.value = false;
    },
    function (e) {
      runLogError.value = e.message || String(e);
      runLogLoading.value = false;
    }
  );
});
onUnmounted(function () {
  if (unsubscribeRunLog) unsubscribeRunLog();
});

// 狀態文字 -> 顏色，跟 utils/strategyColor.js 同一個「只覆寫 color，背景
// 用 .signal-badge 的 color-mix 自動跟著換」用法，不用額外新增 CSS class。
function runLogStatusColor(status) {
  if (status === '成功') return 'var(--green)';
  if (status === '失敗') return 'var(--red)';
  return 'var(--amber)'; // 略過／部分成功等中間狀態
}

// ---- 最近執行狀態（按項目分組，各自取最新一筆）----
// 2026-10-07：使用者看了舊版 apps-script 的「排程佇列」卡片之後，想要的其實
// 不是那一整套「背景 job 卡住可以重新啟動」的機制（那是 Apps Script 6 分鐘
// 執行上限逼出來的設計，Firebase 版每個操作都是一次呼叫同步跑完，沒有
// 「執行中卡住」這個狀態需要處理，見 README「每日股價資料抓取」架構決定
// #3 的說明），而是「一眼看出每個項目最近一次有沒有成功」。這個不需要
// 另外查 Firestore——runLogEntries 已經是依時間新到舊排序好的最近 50 筆，
// 純前端分組、取每個 category 第一次出現（也就是最新一筆）即可。
// 注意：如果某個項目很少跑（例如持股續抱診斷），它最近一次執行有可能
// 已經不在這最近 50 筆之內，這裡只會顯示「尚無最近紀錄」，不代表它
// 從來沒有成功過。
const runLogLatestByCategory = computed(function () {
  const seen = {};
  const result = [];
  runLogEntries.value.forEach(function (entry) {
    if (seen[entry.category]) return;
    seen[entry.category] = true;
    result.push(entry);
  });
  result.sort(function (a, b) { return a.category < b.category ? -1 : 1; });
  return result;
});
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
        <h3>AI 用量統計（最近 30 天）</h3>
        <p v-if="usageError" class="error-box">{{ usageError }}</p>
        <p v-if="usageLoading" class="hint">載入中...</p>
        <template v-else-if="usageSummary">
          <div class="card-body">
            <div>累計花費：約 ${{ usageSummary.totalCost }}（共 {{ usageSummary.totalCalls }} 次呼叫）</div>
            <div>今天花費：約 ${{ usageSummary.todayCost }}</div>
          </div>
          <div v-if="usageSummary.daily.length" class="table-wrap">
            <table class="history-table">
              <thead>
                <tr><th>日期</th><th>次數</th><th>輸入 Tokens</th><th>輸出 Tokens</th><th>花費</th></tr>
              </thead>
              <tbody>
                <tr v-for="d in usageSummary.daily" :key="d.date">
                  <td>{{ d.date }}</td>
                  <td>{{ d.calls }}</td>
                  <td>{{ d.inputTokens }}</td>
                  <td>{{ d.outputTokens }}</td>
                  <td>${{ d.cost.toFixed(4) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="hint">最近 30 天沒有任何 AI 呼叫記錄。</p>
        </template>
        <div class="form-actions">
          <button type="button" :disabled="usageLoading" @click="loadUsageSummary">⟳ 重新整理</button>
        </div>
        <p class="hint">
          單價可能抓錯（見上面「Claude／Gemini 單價」），這裡的花費只是預估，
          不是 Anthropic／Google 帳單的實際金額。
        </p>
      </div>

      <div class="form-card">
        <h3>歷史股價資料</h3>
        <p v-if="historyOverviewError" class="error-box">{{ historyOverviewError }}</p>
        <p v-if="historyOverviewLoading" class="hint">載入中...</p>
        <div v-else-if="historyOverview" class="card-body">
          <div>目前來源模式：{{ historyOverview.sourceMode }}</div>
          <div>日期範圍：{{ historyOverview.minDate || '-' }} ~ {{ historyOverview.maxDate || '-' }}</div>
          <div>交易日數：{{ historyOverview.tradingDays }}　股票數：{{ historyOverview.stockCount }}　總列數：{{ historyOverview.rowCount }}</div>
        </div>
        <div class="form-actions">
          <button type="button" :disabled="historyOverviewLoading" @click="loadHistoryOverview">⟳ 重新整理</button>
        </div>

        <h3 style="margin-top:16px;">立即抓取今天的資料</h3>
        <div class="form-actions">
          <button type="button" :disabled="fetchTodayRunning" @click="fetchTodayNow">
            {{ fetchTodayRunning ? '抓取中...' : '立即抓取今天' }}
          </button>
        </div>
        <p v-if="fetchTodayError" class="error-box">{{ fetchTodayError }}</p>
        <p v-if="fetchTodayResult" class="hint">
          {{ fetchTodayResult.date }}：成功寫入 {{ fetchTodayResult.rowCount }} 檔股票。
        </p>
        <p class="hint">
          太早按（例如收盤後不久，證交所三大法人資料還沒公布）會抓到「資料過少」
          的錯誤，這是正常現象，晚一點再試即可。
        </p>

        <h3 style="margin-top:16px;">補抓區間</h3>
        <form class="skip-date-form" @submit.prevent="runBackfillNow">
          <input v-model="backfillForm.startDate" type="date" required placeholder="開始日期">
          <input v-model="backfillForm.endDate" type="date" required placeholder="結束日期">
          <label class="checkbox-label">
            <input v-model="backfillForm.skipWeekends" type="checkbox">
            跳過週六日
          </label>
          <button type="submit" :disabled="backfillStarting">
            {{ backfillStarting ? '送出中...' : '開始補抓' }}
          </button>
        </form>
        <p v-if="backfillStartError" class="error-box">{{ backfillStartError }}</p>
        <div v-if="backfillJob" class="run-log-status-card" style="margin-top:8px;">
          <div class="run-log-status-card-top">
            <span>目前執行狀態</span>
            <span class="signal-badge" :style="{ color: runLogStatusColor(backfillJobStatusLabel) }">{{ backfillJobStatusLabel }}</span>
          </div>
          <div class="hint">
            區間 {{ backfillJob.params?.startDate }} ~ {{ backfillJob.params?.endDate }}
            <template v-if="backfillJob.status === 'running'">，還在執行中，可以放心切走這個頁面，回來這裡會自動顯示最新狀態。</template>
            <template v-else-if="backfillJob.result">
              ：嘗試 {{ backfillJob.result.attempted.length }} 天，成功 {{ backfillJob.result.succeeded.length }} 天
              <template v-if="backfillJob.result.failed.length">
                、失敗 {{ backfillJob.result.failed.length }} 天：
                {{ backfillJob.result.failed.map(f => f.date + '（' + f.error + '）').join('、') }}
              </template>
              <template v-if="backfillJob.result.truncated">（區間超過單次上限，請分批補抓剩下的部分）</template>
            </template>
            <template v-else-if="backfillJob.error">：{{ backfillJob.error }}</template>
          </div>
        </div>
        <p class="hint">
          單次最多補 60 天，區間更大請分幾次呼叫。這裡刻意不套用「不跑日」
          （`skip_dates`）設定——那是給每日自動排程用的，手動補抓區間時你明確
          指定了日期，不應該被悄悄跳過。上面的執行狀態是看
          <code>jobs/historyBackfill</code> 即時更新的，跟這次按鈕點擊本身有沒有
          收到回應無關——把 App 切到背景或切到別的分頁再回來，都看得到當下真正
          的狀態。「開始補抓」這顆按鈕不會因為上面顯示「執行中」就被鎖住，隨時
          可以按下去重新開始一次（例如上一次因為逾時卡住、確定已經沒在跑了）——
          這是單人工具，不需要防「自己跟自己搶」。</p>

        <h3 style="margin-top:16px;">手動測試工具</h3>
        <p class="hint">
          對應舊版 apps-script「系統與資料後台」頁面的「手動測試工具」——
          「重新計算戰報」只重算戰報本身（不補抓新資料、不跑 AI 診斷，通常
          數秒內完成）；「執行完整排程」把補抓資料／重新計算戰報／（如果有
          開啟）每日自動 AI 診斷三步驟都跑一次，跟每日排程真正執行時是同一套
          邏輯，差別只在不管現在是不是排定的執行時間，按下去就跑。
        </p>
        <div class="form-actions">
          <button type="button" :disabled="reportRecomputeStarting" @click="runReportRecomputeNow">
            {{ reportRecomputeStarting ? '送出中...' : '重新計算戰報' }}
          </button>
          <button type="button" :disabled="fullScheduleStarting" @click="runFullScheduleNow">
            {{ fullScheduleStarting ? '送出中...' : '執行完整排程' }}
          </button>
        </div>
        <p v-if="reportRecomputeStartError" class="error-box">{{ reportRecomputeStartError }}</p>
        <div v-if="reportRecomputeJob" class="run-log-status-card" style="margin-top:8px;">
          <div class="run-log-status-card-top">
            <span>重新計算戰報執行狀態</span>
            <span class="signal-badge" :style="{ color: runLogStatusColor(reportRecomputeJobStatusLabel) }">{{ reportRecomputeJobStatusLabel }}</span>
          </div>
          <div class="hint">
            <template v-if="reportRecomputeJob.status === 'running'">還在執行中，可以放心切走這個頁面，回來這裡會自動顯示最新狀態。</template>
            <template v-else-if="reportRecomputeJob.result">
              戰報日期 {{ reportRecomputeJob.result.latestDate || '-' }}，{{ reportRecomputeJob.result.reportCount }} 檔訊號
            </template>
            <template v-else-if="reportRecomputeJob.error">{{ reportRecomputeJob.error }}</template>
          </div>
        </div>
        <p v-if="fullScheduleStartError" class="error-box">{{ fullScheduleStartError }}</p>
        <div v-if="fullScheduleJob" class="run-log-status-card" style="margin-top:8px;">
          <div class="run-log-status-card-top">
            <span>完整排程執行狀態</span>
            <span class="signal-badge" :style="{ color: runLogStatusColor(fullScheduleJobStatusLabel) }">{{ fullScheduleJobStatusLabel }}</span>
          </div>
          <div class="hint">
            <template v-if="fullScheduleJob.status === 'running'">還在執行中，可以放心切走這個頁面，回來這裡會自動顯示最新狀態。</template>
            <template v-else-if="fullScheduleJob.result">
              戰報日期 {{ fullScheduleJob.result.latestDate || '-' }}，{{ fullScheduleJob.result.reportCount }} 檔訊號
              <template v-if="fullScheduleJob.result.strategyError">（{{ fullScheduleJob.result.strategyError }}）</template>
            </template>
            <template v-else-if="fullScheduleJob.error">{{ fullScheduleJob.error }}</template>
          </div>
        </div>

        <p class="hint">
          <strong>架構說明：</strong>每日排程（見上面「每日排程」卡片）跟這裡的
          手動按鈕抓到的新資料，一律直接寫進 BigQuery 的 <code>history_raw</code>
          表，不會寫回 Google Drive——如果資料來源模式選的是 external（讀 Drive
          外部資料表），不會看到新抓到的資料，想看到最新資料請選 native 或
          materialized。
        </p>
      </div>

      <HistoryCalendarCard :skip-dates="skipDates" />

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

      <div class="form-card">
        <h3>執行紀錄</h3>
        <p v-if="runLogError" class="error-box">{{ runLogError }}</p>
        <p v-if="runLogLoading" class="hint">載入中...</p>
        <template v-else-if="runLogLatestByCategory.length">
          <h3 style="margin-top:0;">最近執行狀態</h3>
          <div class="run-log-status-grid">
            <div v-for="entry in runLogLatestByCategory" :key="entry.category" class="run-log-status-card">
              <div class="run-log-status-card-top">
                <span>{{ entry.category }}</span>
                <span class="signal-badge" :style="{ color: runLogStatusColor(entry.status) }">{{ entry.status }}</span>
              </div>
              <div class="hint">{{ entry.timestamp }}</div>
            </div>
          </div>
          <p class="hint">
            每個項目只取最近 50 筆紀錄裡最新的一筆，很少執行的項目（例如持股
            續抱診斷）如果最近一次已經超出 50 筆範圍，這裡會看不到，不代表
            從來沒成功過，往下捲完整清單可以找更久以前的紀錄。
          </p>
          <h3>完整紀錄（最近 50 筆）</h3>
          <div class="table-wrap">
            <table class="history-table run-log-table">
              <thead>
                <tr><th>時間</th><th>項目</th><th>狀態</th><th>說明</th><th>耗時</th></tr>
              </thead>
              <tbody>
                <tr v-for="(entry, i) in runLogEntries" :key="entry.timestampMs + '-' + i">
                  <td>{{ entry.timestamp }}</td>
                  <td>{{ entry.category }}</td>
                  <td>
                    <span class="signal-badge" :style="{ color: runLogStatusColor(entry.status) }">{{ entry.status }}</span>
                  </td>
                  <td class="run-log-message">{{ entry.message }}</td>
                  <td>{{ (entry.durationMs / 1000).toFixed(1) }}s</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <p v-else class="hint">目前沒有任何執行紀錄。</p>
        <p class="hint">
          每日排程、手動抓取/補抓、AI 診斷等背景工作執行後都會各自記一筆成功/
          失敗紀錄在這裡，跟舊版 apps-script 後台管理頁面的「執行紀錄」同一個
          用途——排程半夜跑完、人不在電腦前，用這裡確認昨晚有沒有順利跑完，
          不用等戰報頁面「資料看起來怪」才回頭去查雲端後台的 log。最近 50 筆，
          即時更新（排程/手動操作一寫入新紀錄，這裡不用重新整理就會自動更新）。
        </p>
      </div>

      <p v-if="savedAt" class="hint">已儲存（{{ savedAt }}）</p>
    </template>

    <p class="hint dashboard-note">
      格式錯誤日期列的檢查/清理工具還沒遷移到這裡，需要這個功能請先用舊版
      網頁應用程式（一般情況下用不到，資料格式一直都是這個 App 自己寫入的
      乾淨格式）。
    </p>
  </section>
</template>

<style scoped>
/* .history-table 的 th/td 預設 white-space: nowrap（配合數字欄位右對齊），
   執行紀錄的「說明」欄位是不定長度的中文句子，要能換行才不會把表格撐到
   很寬、在手機上要左右滑一大段才看得完一則紀錄。 */
.run-log-table .run-log-message {
  white-space: normal;
  text-align: left;
  min-width: 220px;
}

/* 「最近執行狀態」卡片網格——手機上一欄，螢幕夠寬時自動多欄，跟舊版
   apps-script「排程佇列」一排卡片的呈現方式類似，但這裡純粹是顯示用，
   沒有重新啟動/刪除按鈕（見 script 區塊的說明：Firebase 版每個操作都是
   一次呼叫同步跑完，沒有「卡住的背景 job」這個狀態）。 */
.run-log-status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}

.run-log-status-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  /* 2026-10-07：補抓失敗訊息裡常常帶原始 TWSE 網址（整串沒有空白可以
     斷行的字），不設 overflow-wrap 的話這種長字串會直接撐破卡片邊框、
     超出手機螢幕寬度，使用者實際遇到過。 */
  overflow-wrap: break-word;
  word-break: break-word;
}

.run-log-status-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
</style>
