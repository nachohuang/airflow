<script setup>
/**
 * HistoryCalendarCard.vue
 * 2026-10-08 新增：使用者要一個地方能用月曆的方式，一眼看出哪幾天的
 * 股價資料有缺口/筆數異常，不用一天一天手動查「歷史股價資料」卡片的
 * 資料總覽。apps-script 版沒有對應功能可以照抄，這是全新設計。
 *
 * 顯示邏輯（純前端判斷，不是後端算好才回傳）：
 * - 未來日期：淡化顯示，不代表任何異常。
 * - 設定過的「不跑日」（`config/app` 旁邊的 `skip_dates` collection，
 *   2026-10-08 使用者要求補上）：不管那天有沒有資料，一律標成「跳」，
 *   藍色中性樣式，跟週六日同一個精神——這是使用者自己設定要跳過排程的
 *   日子，沒有資料是預期中的事，不該被當成缺口警示；優先權比「平日沒
 *   資料」高（同一天不會又是缺口又是跳過）。`skipDates` 這個 prop 由
 *   `AdminView.vue` 的「不跑日」卡片傳進來（那邊已經有 `onSnapshot`
 *   監聽 `skip_dates`），這裡不再另外訂閱一次同一個 collection。
 * - 週六日：沒有資料是正常現象（TWSE 不開盤），用中性樣式顯示，不要讓
 *   使用者誤以為是漏抓。
 * - 平日沒有任何資料（stockCount === 0）：標成「缺」，紅色警示——這是
 *   真正需要注意的缺口。
 * - 平日有資料但四碼股票筆數低於 500（`LOW_COUNT_THRESHOLD_`，正常
 *   交易日通常有八百到一千多檔，這個門檻只是「明顯低到不正常」的粗略
 *   判斷，不是精確值，使用者可以自行用這個數字當參考）：標成「少」，
 *   橘色警示。
 * - 其餘（平日且筆數正常）：綠色，正常。
 */
import { ref, computed, onMounted } from 'vue';
import { callFn } from '../../composables/useCallable';

const props = defineProps({
  skipDates: { type: Array, default: function () { return []; } } // [{date, reason}]
});

const LOW_COUNT_THRESHOLD_ = 500;

const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
const viewYear = ref(today.getFullYear());
const viewMonth = ref(today.getMonth() + 1); // 1-based

const loading = ref(true);
const error = ref('');
const dailyCounts = ref({}); // { 'yyyy-MM-dd': {stockCount, rowCount} }

const monthLabel = computed(function () {
  return viewYear.value + ' 年 ' + viewMonth.value + ' 月';
});

async function loadMonth() {
  loading.value = true;
  error.value = '';
  try {
    const monthStr = viewYear.value + '-' + String(viewMonth.value).padStart(2, '0');
    const rows = await callFn('getHistoryDailyCounts', { month: monthStr });
    const map = {};
    rows.forEach(function (r) { map[r.date] = r; });
    dailyCounts.value = map;
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

function prevMonth() {
  viewMonth.value -= 1;
  if (viewMonth.value < 1) { viewMonth.value = 12; viewYear.value -= 1; }
  loadMonth();
}
function nextMonth() {
  viewMonth.value += 1;
  if (viewMonth.value > 12) { viewMonth.value = 1; viewYear.value += 1; }
  loadMonth();
}
function goToday() {
  viewYear.value = today.getFullYear();
  viewMonth.value = today.getMonth() + 1;
  loadMonth();
}

onMounted(loadMonth);

const WEEKDAY_LABELS_ = ['日', '一', '二', '三', '四', '五', '六'];

// skip_dates 是 {date, reason} 陣列，查詢用 Map 比每格都 .find() 一次快，
// 月曆最多 42 格不算多，但這樣寫起來也比較直覺。
const skipDateMap = computed(function () {
  const map = {};
  props.skipDates.forEach(function (s) { if (s && s.date) map[s.date] = s.reason || ''; });
  return map;
});

// 組出含前導空白格的月曆格子陣列——第一天是星期幾就補幾個 null 在前面，
// 讓「一」欄永遠對齊星期一，跟一般月曆的視覺慣例一致。
const calendarCells = computed(function () {
  const firstDow = new Date(Date.UTC(viewYear.value, viewMonth.value - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(viewYear.value, viewMonth.value, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = viewYear.value + '-' + String(viewMonth.value).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
    const skipReason = skipDateMap.value[dateStr];
    cells.push({
      day: d,
      dateStr: dateStr,
      isWeekend: dow === 0 || dow === 6,
      isFuture: dateStr > todayStr,
      isSkip: skipReason !== undefined,
      skipReason: skipReason || '',
      info: dailyCounts.value[dateStr] || null
    });
  }
  return cells;
});

function cellStatus(cell) {
  if (cell.isFuture) return 'future';
  if (cell.isSkip) return 'skip';
  if (!cell.info || cell.info.stockCount === 0) return cell.isWeekend ? 'weekend' : 'missing';
  if (cell.info.stockCount < LOW_COUNT_THRESHOLD_) return 'low';
  return 'ok';
}
</script>

<template>
  <div class="form-card">
    <h3>資料完整性月曆</h3>
    <p class="hint">
      每一天的四碼股票筆數（排除權證/ETF），用來一眼看出哪幾天的資料有
      缺口或筆數異常——<span class="cal-legend-dot cal-missing"></span>紅色是平日卻完全沒有資料（真正的缺口）、
      <span class="cal-legend-dot cal-skip"></span>藍色是設定過的不跑日（本來就不會有資料，不是異常）、
      <span class="cal-legend-dot cal-low"></span>橘色是平日有資料但筆數明顯偏低（低於 {{ LOW_COUNT_THRESHOLD_ }} 檔，
      門檻是粗略估計，不是精確值）、<span class="cal-legend-dot cal-ok"></span>綠色是正常、灰色是週六日或未來日期（本來就不會有資料，不是異常）。
    </p>

    <div class="cal-toolbar">
      <button type="button" @click="prevMonth">← 上個月</button>
      <strong>{{ monthLabel }}</strong>
      <button type="button" @click="nextMonth">下個月 →</button>
      <button type="button" @click="goToday">回到本月</button>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="loading" class="hint">載入中...</p>
    <template v-else>
      <div class="cal-grid cal-grid-header">
        <div v-for="w in WEEKDAY_LABELS_" :key="w" class="cal-weekday">{{ w }}</div>
      </div>
      <div class="cal-grid">
        <div
          v-for="(cell, idx) in calendarCells" :key="idx"
          class="cal-cell"
          :class="cell ? 'cal-' + cellStatus(cell) : 'cal-cell-empty'"
          :title="cell && cell.isSkip ? ('不跑日' + (cell.skipReason ? '：' + cell.skipReason : '')) : null"
        >
          <template v-if="cell">
            <div class="cal-cell-day">{{ cell.day }}</div>
            <div v-if="cell.isSkip" class="cal-cell-count">跳</div>
            <div v-else-if="cell.info && cell.info.stockCount" class="cal-cell-count">{{ cell.info.stockCount }}</div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cal-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.cal-toolbar strong {
  flex: 1;
  text-align: center;
  min-width: 80px;
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.cal-grid-header {
  margin-bottom: 4px;
}

.cal-weekday {
  text-align: center;
  font-size: 12px;
  opacity: 0.6;
  padding: 2px 0;
}

.cal-cell {
  aspect-ratio: 1;
  border-radius: 6px;
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.cal-cell-empty {
  border: none;
}

.cal-cell-day {
  font-weight: 600;
}

.cal-cell-count {
  font-size: 10px;
  opacity: 0.8;
}

.cal-future {
  opacity: 0.35;
}

.cal-weekend {
  background: color-mix(in srgb, var(--border) 35%, transparent);
}

.cal-skip {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--bg-card));
}

.cal-ok {
  border-color: var(--green);
  background: color-mix(in srgb, var(--green) 12%, var(--bg-card));
}

.cal-low {
  border-color: var(--amber);
  background: color-mix(in srgb, var(--amber) 16%, var(--bg-card));
}

.cal-missing {
  border-color: var(--red);
  background: color-mix(in srgb, var(--red) 16%, var(--bg-card));
}

.cal-legend-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  margin: 0 2px -1px 2px;
}

.cal-legend-dot.cal-missing { background: var(--red); }
.cal-legend-dot.cal-low { background: var(--amber); }
.cal-legend-dot.cal-skip { background: var(--accent); }
.cal-legend-dot.cal-ok { background: var(--green); }
</style>
