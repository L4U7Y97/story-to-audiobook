<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { MODELS, testApiKey } from '@/analysis/llm/client';
import { DEFAULT_SETTINGS, getAllSettings, setSetting, type Settings } from '@/storage/settings';
import { SPEEDS } from '../speeds';
import { applyTheme } from '../theme';

const settings = ref<Settings>({ ...DEFAULT_SETTINGS });
const keyDraft = ref('');
const editingKey = ref(false);
const showKey = ref(false);
const keyStatus = ref<{ kind: 'ok' | 'error' | 'busy'; text: string }>();
const storage = ref<{ used: number; quota: number; persisted: boolean }>();

onMounted(async () => {
  settings.value = await getAllSettings();
  editingKey.value = !settings.value.apiKey;
  if (navigator.storage?.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const persisted = (await navigator.storage.persisted?.()) ?? false;
    storage.value = { used: usage, quota, persisted };
  }
});

/** Shows only the last four characters of a saved key. */
function masked(key: string): string {
  return key.length > 8 ? `••••••••${key.slice(-4)}` : '••••••••';
}

async function save<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings.value = { ...settings.value, [key]: value };
  await setSetting(key, value);
}

async function saveKey() {
  const key = keyDraft.value.trim();
  await save('apiKey', key);
  keyDraft.value = '';
  showKey.value = false;
  editingKey.value = !key;
  keyStatus.value = undefined;
  if (key) await testKey();
}

async function removeKey() {
  await save('apiKey', '');
  editingKey.value = true;
  keyStatus.value = undefined;
}

async function testKey() {
  keyStatus.value = { kind: 'busy', text: 'Checking…' };
  const result = await testApiKey(settings.value.apiKey, settings.value.model);
  keyStatus.value = result.ok
    ? { kind: 'ok', text: 'Key works with this model' }
    : { kind: 'error', text: result.message };
}

async function setModel(model: string) {
  await save('model', model);
  if (settings.value.apiKey) await testKey();
}

async function setTheme(theme: Settings['theme']) {
  await save('theme', theme);
  applyTheme(theme);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}
</script>

<template>
  <main class="page">
    <RouterLink :to="{ name: 'library' }" class="back">← Library</RouterLink>
    <h1>Settings</h1>

    <section class="card group" aria-labelledby="llm-heading">
      <h2 id="llm-heading">Analysis with Claude</h2>
      <p class="muted">
        With an Anthropic API key, new parts are analysed by Claude, which is usually much better
        than the built-in method at telling who is speaking. Without a key, analysis is free and
        stays on this device. The key is stored only on this device and sent only to
        api.anthropic.com.
      </p>

      <form v-if="editingKey" class="key-form" @submit.prevent="saveKey">
        <label for="api-key">API key</label>
        <div class="row">
          <input
            id="api-key"
            v-model="keyDraft"
            :type="showKey ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            placeholder="sk-ant-…"
          />
          <button type="button" @click="showKey = !showKey">{{ showKey ? 'Hide' : 'Show' }}</button>
        </div>
        <div class="row">
          <button type="submit" class="primary" :disabled="!keyDraft.trim()">Save key</button>
          <button v-if="settings.apiKey" type="button" @click="editingKey = false">Cancel</button>
        </div>
      </form>
      <div v-else class="row key-saved">
        <span class="key-mask" aria-label="Saved API key">{{ masked(settings.apiKey) }}</span>
        <button type="button" @click="testKey">Test key</button>
        <button type="button" @click="editingKey = true">Change</button>
        <button type="button" class="danger" @click="removeKey">Remove</button>
      </div>
      <p
        v-if="keyStatus"
        class="key-status"
        :data-kind="keyStatus.kind"
        :role="keyStatus.kind === 'error' ? 'alert' : 'status'"
      >
        {{ keyStatus.text }}
      </p>

      <label for="model">Model</label>
      <select
        id="model"
        :value="settings.model"
        @change="setModel(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>

      <label for="effort">Effort</label>
      <select
        id="effort"
        :value="settings.effort"
        @change="save('effort', ($event.target as HTMLSelectElement).value as Settings['effort'])"
      >
        <option value="low">Low (fastest, cheapest — enough for most books)</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
    </section>

    <section class="card group" aria-labelledby="playback-heading">
      <h2 id="playback-heading">Listening</h2>
      <label for="speed">Default speed</label>
      <select
        id="speed"
        :value="settings.speed"
        @change="save('speed', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="s in SPEEDS" :key="s" :value="s">{{ s }}×</option>
      </select>

      <fieldset class="theme">
        <legend>Theme</legend>
        <label v-for="t in ['system', 'light', 'dark'] as const" :key="t">
          <input
            type="radio"
            name="theme"
            :value="t"
            :checked="settings.theme === t"
            @change="setTheme(t)"
          />
          {{ t === 'system' ? 'Follow the system' : t === 'light' ? 'Light' : 'Dark' }}
        </label>
      </fieldset>
    </section>

    <section v-if="storage" class="card group" aria-labelledby="storage-heading">
      <h2 id="storage-heading">Storage</h2>
      <p>
        {{ megabytes(storage.used) }} used
        <span v-if="storage.quota" class="muted">of {{ megabytes(storage.quota) }} available</span>
      </p>
      <p class="muted">
        {{
          storage.persisted
            ? 'Stories are kept even when the device runs low on space.'
            : 'The browser may clear stories when the device runs low on space. Export the ones you want to keep.'
        }}
      </p>
    </section>
  </main>
</template>

<style scoped>
.back {
  display: inline-block;
  margin-bottom: 12px;
}

.group {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}

.group h2 {
  margin: 0;
  font-size: 1.1rem;
}

.group p {
  margin: 0;
}

.key-form {
  display: grid;
  gap: 8px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.row input {
  flex: 1;
  min-width: 0;
}

.key-mask {
  font-family: ui-monospace, monospace;
  flex: 1;
}

.key-status[data-kind='ok'] {
  color: var(--ok);
}

.key-status[data-kind='error'] {
  color: var(--danger);
}

.key-status[data-kind='busy'] {
  color: var(--muted);
}

.danger {
  color: var(--danger);
}

.theme {
  border: none;
  padding: 0;
  margin: 8px 0 0;
  display: grid;
  gap: 4px;
}

.theme legend {
  padding: 0;
  margin-bottom: 4px;
}

.theme label {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 40px;
}
</style>
