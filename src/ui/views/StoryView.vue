<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AnalysisStatus, Part } from '@/format/types';
import { analyzePart } from '@/analysis/analyzer';
import { listWebVoices } from '@/playback/webVoices';
import { getAppDb } from '@/storage/db';
import { getStory } from '@/storage/stories';
import { listParts } from '@/storage/parts';
import { useLiveQuery } from '../composables/useLiveQuery';
import AddPartForm from '../components/AddPartForm.vue';

const props = defineProps<{ id: string }>();
const db = getAppDb();

const { data: story } = useLiveQuery(() => getStory(db, props.id), [() => props.id]);
const { data: parts } = useLiveQuery(() => listParts(db, props.id), [() => props.id]);
const adding = ref(false);
const errors = ref<Record<string, string>>({});
const characterCount = computed(
  () => story.value?.cast.filter((c) => c.role === 'character').length ?? 0,
);

async function analyse(part: Pick<Part, 'id'>) {
  delete errors.value[part.id];
  try {
    await analyzePart(db, part.id, { voices: await listWebVoices() });
  } catch (e) {
    errors.value[part.id] = e instanceof Error ? e.message : String(e);
  }
}

function onAdded(part: Part) {
  adding.value = false;
  void analyse(part);
}

const STATUS_LABEL: Record<AnalysisStatus, string> = {
  pending: 'Waiting for analysis',
  running: 'Analysing…',
  done: 'Ready',
  failed: 'Analysis failed',
};

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
</script>

<template>
  <main class="page">
    <RouterLink :to="{ name: 'library' }" class="back">← Library</RouterLink>

    <template v-if="story">
      <h1>{{ story.title }}</h1>
      <p class="muted">
        {{ story.lang === 'es' ? 'Español' : 'English' }} · {{ characterCount }}
        {{ characterCount === 1 ? 'character' : 'characters' }}
      </p>
      <div v-if="parts?.length" class="story-actions">
        <RouterLink class="button primary" :to="{ name: 'reader', params: { id: story.id } }">
          {{ story.position ? 'Continue listening' : 'Read &amp; listen' }}
        </RouterLink>
        <RouterLink class="button" :to="{ name: 'cast', params: { id: story.id } }"
          >Cast</RouterLink
        >
      </div>

      <ol v-if="parts?.length" class="parts">
        <li v-for="part in parts" :key="part.id" class="card part">
          <RouterLink
            class="part-title"
            :to="{ name: 'reader', params: { id: story.id, partId: part.id } }"
            >{{ part.title }}</RouterLink
          >
          <span class="muted">{{ wordCount(part.text).toLocaleString() }} words</span>
          <span class="status" :data-status="part.analysisStatus">
            {{ STATUS_LABEL[part.analysisStatus] }}
            <button
              v-if="part.analysisStatus === 'pending' || part.analysisStatus === 'failed'"
              class="analyse"
              @click="analyse(part)"
            >
              {{ part.analysisStatus === 'failed' ? 'Retry' : 'Analyse' }}
            </button>
          </span>
          <p v-if="errors[part.id]" class="error" role="alert">{{ errors[part.id] }}</p>
        </li>
      </ol>
      <p v-else-if="parts" class="muted">No parts yet. Add the first chapter or a few pages.</p>

      <AddPartForm
        v-if="adding"
        :story-id="story.id"
        :parts="parts ?? []"
        @added="onAdded"
        @cancel="adding = false"
      />
      <button v-else class="primary add" @click="adding = true">Add a part</button>
    </template>

    <p v-else-if="story === undefined" class="muted">Loading…</p>
  </main>
</template>

<style scoped>
.back {
  display: inline-block;
  margin-bottom: 12px;
}

.parts {
  list-style: none;
  padding: 0;
  margin: 16px 0;
  display: grid;
  gap: 8px;
  counter-reset: part;
}

.part {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 12px;
  counter-increment: part;
}

.part-title {
  font-weight: 600;
  color: inherit;
  text-decoration: none;
}

.story-actions {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}

.story-actions .button {
  flex: 1;
}

.part-title::before {
  content: counter(part) '. ';
  color: var(--muted);
}

.status {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  font-size: 0.85rem;
  color: var(--muted);
}

.status[data-status='done'] {
  color: var(--ok);
}

.status[data-status='failed'] {
  color: var(--danger);
}

.add {
  width: 100%;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.analyse {
  min-height: 36px;
  padding: 0 12px;
}

.error {
  grid-column: 1 / -1;
  margin: 4px 0 0;
  color: var(--danger);
  font-size: 0.85rem;
}
</style>
