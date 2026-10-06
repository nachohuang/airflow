<script setup>
import { ref } from 'vue';
import HoldingList from './HoldingList.vue';
import WatchlistList from './WatchlistList.vue';
import ClosedHistoryList from './ClosedHistoryList.vue';

/** 跟舊版 apps-script/src/Index.html 持股庫存分頁底下的三個 sub-tab
 *  （data-target="pftab-holding"／"pftab-watchlist"／"pftab-history"）對應。 */
const activeSubTab = ref('holding');
</script>

<template>
  <div class="portfolio-view">
    <div class="sub-tabs">
      <button
        type="button"
        class="sub-tab-btn"
        :class="{ active: activeSubTab === 'holding' }"
        @click="activeSubTab = 'holding'"
      >
        持有中
      </button>
      <button
        type="button"
        class="sub-tab-btn"
        :class="{ active: activeSubTab === 'watchlist' }"
        @click="activeSubTab = 'watchlist'"
      >
        👀 觀察個股
      </button>
      <button
        type="button"
        class="sub-tab-btn"
        :class="{ active: activeSubTab === 'history' }"
        @click="activeSubTab = 'history'"
      >
        💰 歷史結案紀錄
      </button>
    </div>

    <HoldingList v-if="activeSubTab === 'holding'" />
    <WatchlistList v-else-if="activeSubTab === 'watchlist'" />
    <ClosedHistoryList v-else-if="activeSubTab === 'history'" />
  </div>
</template>
