<script setup lang="ts">
import { appName } from './appInfo';
</script>

<template>
  <main class="app">
    <h1>{{ appName }}</h1>
    <p>Scaffold is running.</p>
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
