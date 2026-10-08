<script setup>
import { ref } from 'vue';
import { useAuth } from '../composables/useAuth';
import DashboardView from './dashboard/DashboardView.vue';
import PortfolioView from './portfolio/PortfolioView.vue';
import AdminView from './admin/AdminView.vue';
import ResearchView from './research/ResearchView.vue';

const { currentUser, signOut } = useAuth();
/** 跟舊版 apps-script/src/Index.html 一致，預設停在戰報與個股（最常看的頁面），
 *  不是持股庫存。 */
const activeTab = ref('dashboard');

/** 跟舊版 apps-script/src/Index.html 的四個主 tab 對應（data-tab="dashboard"／
 *  "portfolio"／"research"／"admin"）。「戰報與個股」目前只做了讀取戰報清單
 *  （直接讀 Firestore，見 DashboardView.vue），AI 診斷/股票搜尋/走勢圖還沒做；
 *  「系統與資料後台」目前只做了篩選策略／BigQuery 來源模式這兩項最常改的設定
 *  （見 AdminView.vue），AI 金鑰／用量統計／History 補抓工具還沒做；
 *  「策略研究」2026-10-08 遷移了 Backtest.gs（回測，見 ResearchView.vue）——
 *  因子迴歸模型（FactorRegression.gs）還沒遷移，所以 factor_model_rank／
 *  hybrid 這兩個策略目前回測不了，詳見 README。 */
const tabs = [
  { key: 'dashboard', label: '📊 戰報與個股', ready: true },
  { key: 'portfolio', label: '💼 持股庫存', ready: true },
  { key: 'research', label: '🧪 策略研究', ready: true },
  { key: 'admin', label: '⚙️ 系統與資料後台', ready: true }
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
      <ResearchView v-else-if="activeTab === 'research'" />
      <AdminView v-else-if="activeTab === 'admin'" />
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
