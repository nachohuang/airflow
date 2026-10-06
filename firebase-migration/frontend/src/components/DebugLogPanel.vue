<script setup>
import { ref, computed } from 'vue';
import { useDebugLog } from '../composables/useDebugLog';

const { entries, clear } = useDebugLog();
const open = ref(false);

const text = computed(function () {
  return entries.value.map(function (e) {
    return `[${e.time}] ${e.level.toUpperCase()} ${e.message}`;
  }).join('\n');
});

const copyState = ref('idle'); // idle | copied | failed

async function copyAll() {
  try {
    await navigator.clipboard.writeText(text.value);
    copyState.value = 'copied';
  } catch {
    copyState.value = 'failed';
  }
  setTimeout(function () { copyState.value = 'idle'; }, 2000);
}
</script>

<template>
  <div class="debug-log-panel">
    <button type="button" class="debug-log-toggle" @click="open = !open">
      🐞 除錯日誌（{{ entries.length }}） {{ open ? '收起 ▼' : '展開 ▲' }}
    </button>
    <div v-if="open" class="debug-log-body">
      <div class="debug-log-actions">
        <button type="button" @click="copyAll">
          {{ copyState === 'copied' ? '已複製' : copyState === 'failed' ? '複製失敗' : '複製全部' }}
        </button>
        <button type="button" @click="clear">清空</button>
      </div>
      <div class="debug-log-list">
        <div v-for="(e, i) in entries" :key="i" :class="'log-entry log-' + e.level">
          <span class="log-time">{{ e.time }}</span>
          <pre class="log-message">{{ e.message }}</pre>
        </div>
        <p v-if="entries.length === 0" class="hint">目前沒有記錄。</p>
      </div>
    </div>
  </div>
</template>
