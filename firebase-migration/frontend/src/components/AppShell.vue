<script setup>
import { ref } from 'vue';
import { useAuth } from '../composables/useAuth';
import DashboardView from './dashboard/DashboardView.vue';
import PortfolioView from './portfolio/PortfolioView.vue';

const { currentUser, signOut } = useAuth();
/** 跟舊版 apps-script/src/Index.html 一致，預設停在戰報與個股（最常看的頁面），
 *  不是持股庫存。 */
const activeTab = ref('dashboard');

/** 跟舊版 apps-script/src/Index.html 的四個主 tab 對應（data-tab="dashboard"／
 *  "portfolio"／"research"／"admin"）。「戰報與個股」目前只做了讀取戰報清單
 *  （直接讀 Firestore，見 DashboardView.vue），AI 診斷/股票搜尋/走勢圖還沒做；
 *  「策略研究」「系統與資料後台」兩個 tab 完全還沒遷移，先放占位頁面。 */
const tabs = [
  { key: 'dashboard', label: '📊 戰報與個股', ready: true },
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
      <DashboardView v-if="activeTab === 'dashboard'" />
      <PortfolioView v-else-if="activeTab === 'portfolio'" />
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
