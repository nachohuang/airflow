<script setup>
import { useAuth } from './composables/useAuth';
import LoginScreen from './components/LoginScreen.vue';
import AppShell from './components/AppShell.vue';

const { currentUser, authReady } = useAuth();
</script>

<template>
  <div v-if="!authReady" class="loading-screen">載入中...</div>
  <LoginScreen v-else-if="!currentUser" />
  <AppShell v-else />
</template>
