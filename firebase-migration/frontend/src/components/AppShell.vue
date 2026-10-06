<script setup>
import { ref } from 'vue';
import { useAuth } from '../composables/useAuth';
import PortfolioView from './portfolio/PortfolioView.vue';

const { currentUser, signOut } = useAuth();
const activeTab = ref('portfolio');

/** 跟舊版 apps-script/src/Index.html 的四個主 tab 對應（data-tab="dashboard"／
 *  "portfolio"／"research"／"admin"）。目前只有「持股庫存」後端邏輯遷移完成，
 *  其他三個先放占位頁面，不是漏做，是 Phase 5 還沒排到。 */
const tabs = [
  { key: 'dashboard', label: '📊 戰報與個股', ready: false },
  { key: 'portfolio', label: '💼 持股庫存', ready: true },
  { key: 'research', label: '🧪 策略研究', ready: false },
  { key: 'admin', label: '⚙️ 系統與資料後台', ready: false }
];
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="topbar-title">法人動能選股</div>
      <div class="topbar-user">
        <span class="user-email">{{ currentUser?.email }}</span>
        <button class="icon-btn" @click="signOut">登出</button>
      </div>
    </header>

    <main class="content">
      <PortfolioView v-if="activeTab === 'portfolio'" />
      <div v-else class="placeholder-box">
        這個頁面還沒遷移到新系統，請先用舊版的 Apps Script 網頁應用程式。
      </div>
    </main>

    <nav class="bottom-nav">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="nav-btn"
        :class="{ active: activeTab === tab.key }"
        :disabled="!tab.ready"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>
  </div>
</template>
