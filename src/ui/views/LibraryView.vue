<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { Capacitor } from '@capacitor/core';
import type { Lang } from '@/format/types';
import { appName } from '@/appInfo';
import { getAppDb } from '@/storage/db';
import { createStory, listStories } from '@/storage/stories';
import { importStory, parseExport } from '@/storage/exportImport';
import { useLiveQuery } from '../composables/useLiveQuery';

const db = getAppDb();
const router = useRouter();
const { data: stories } = useLiveQuery(() => listStories(db));

const title = ref('');
const lang = ref<Lang>('en');
const creating = ref(false);
const isNative = Capacitor.isNativePlatform();

const importing = ref(false);
const importError = ref('');

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importing.value = true;
  importError.value = '';
  try {
    const parsed = parseExport(await file.text());
    if (!parsed.ok) {
      importError.value = parsed.reason;
      return;
    }
    const { story } = await importStory(db, parsed.data);
    await router.push({ name: 'story', params: { id: story.id } });
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e);
  } finally {
    importing.value = false;
    input.value = '';
  }
}

async function create() {
  creating.value = true;
  try {
    const story = await createStory(db, { title: title.value, lang: lang.value });
    title.value = '';
    await router.push({ name: 'story', params: { id: story.id } });
  } finally {
    creating.value = false;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
</script>

<template>
  <main class="page">
    <header class="top">
      <h1>{{ appName }}</h1>
      <RouterLink :to="{ name: 'settings' }" class="button">Settings</RouterLink>
    </header>

    <section aria-labelledby="stories-heading" class="stories">
      <h2 id="stories-heading" class="sr-only">Stories</h2>
      <p v-if="stories && stories.length === 0" class="muted">
        No stories yet. Create one below, then add its first chapter.
      </p>
      <ul v-else class="story-list">
        <li v-for="story in stories" :key="story.id">
          <RouterLink :to="{ name: 'story', params: { id: story.id } }" class="card story">
            <span class="story-title">{{ story.title }}</span>
            <span class="muted">
              {{ story.partIds.length }} {{ story.partIds.length === 1 ? 'part' : 'parts' }} ·
              {{ story.lang === 'es' ? 'Español' : 'English' }} · {{ formatDate(story.updatedAt) }}
            </span>
          </RouterLink>
        </li>
      </ul>
    </section>

    <form class="card create" @submit.prevent="create">
      <h2>New story</h2>
      <label>
        Title
        <input v-model="title" placeholder="e.g. Pride and Prejudice" autocomplete="off" />
      </label>
      <label>
        Language
        <select v-model="lang">
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </label>
      <button class="primary" type="submit" :disabled="creating">Create story</button>
    </form>

    <section class="card import" aria-labelledby="import-heading">
      <h2 id="import-heading">Import a story</h2>
      <p class="muted">Open a story exported from this app (a .story.json file).</p>
      <input
        type="file"
        accept=".json,application/json"
        aria-labelledby="import-heading"
        :disabled="importing"
        @change="importFile"
      />
      <p v-if="importing" class="muted" role="status">Importing…</p>
      <p v-if="importError" class="error" role="alert">{{ importError }}</p>
    </section>

    <p v-if="isNative" class="dev-link">
      <RouterLink :to="{ name: 'spike' }">Background playback test</RouterLink>
    </p>
  </main>
</template>

<style scoped>
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.story-list {
  list-style: none;
  padding: 0;
  margin: 0 0 24px;
  display: grid;
  gap: 8px;
}

.story {
  display: grid;
  gap: 2px;
  text-decoration: none;
  color: inherit;
}

.story-title {
  font-weight: 600;
}

.create {
  display: grid;
  gap: 12px;
}

.import {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}

.import h2,
.import p {
  margin: 0;
}

.error {
  color: var(--danger);
}

.dev-link {
  margin-top: 24px;
  font-size: 0.9rem;
}
</style>
