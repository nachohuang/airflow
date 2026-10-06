<script setup>
import { ref } from 'vue';
import { useAuth } from '../composables/useAuth';

const { signIn } = useAuth();
const error = ref('');
const loading = ref(false);

async function handleSignIn() {
  error.value = '';
  loading.value = true;
  try {
    await signIn();
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-screen">
    <h1>法人動能選股</h1>
    <p>請用擁有者的 Google 帳號登入</p>
    <button :disabled="loading" @click="handleSignIn">
      {{ loading ? '登入中...' : '使用 Google 登入' }}
    </button>
    <p v-if="error" class="error-box">{{ error }}</p>
  </div>
</template>
