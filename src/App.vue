<script setup lang="ts">
import { Capacitor } from '@capacitor/core';
import { appName } from './appInfo';
import SpikePanel from './spike/SpikePanel.vue';

const isNative = Capacitor.isNativePlatform();
</script>

<template>
  <main class="app">
    <h1>{{ appName }}</h1>
    <SpikePanel v-if="isNative" />
    <p v-else>Scaffold is running.</p>
  </main>
</template>

<style>
:root {
  --bg: #fafafa;
  --fg: #1a1a1a;
  font-family: system-ui, sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121212;
    --fg: #ececec;
  }
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
}

.app {
  padding: 16px;
}
</style>
