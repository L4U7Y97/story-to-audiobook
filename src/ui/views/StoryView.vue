<script setup lang="ts">
import { ref } from 'vue';
import type { AnalysisStatus } from '@/format/types';
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
        {{ story.lang === 'es' ? 'Español' : 'English' }} · {{ story.cast.length - 2 }} characters
      </p>

      <ol v-if="parts?.length" class="parts">
        <li v-for="part in parts" :key="part.id" class="card part">
          <span class="part-title">{{ part.title }}</span>
          <span class="muted">{{ wordCount(part.text).toLocaleString() }} words</span>
          <span class="status" :data-status="part.analysisStatus">
            {{ STATUS_LABEL[part.analysisStatus] }}
          </span>
        </li>
      </ol>
      <p v-else-if="parts" class="muted">No parts yet. Add the first chapter or a few pages.</p>

      <AddPartForm
        v-if="adding"
        :story-id="story.id"
        :parts="parts ?? []"
        @added="adding = false"
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
</style>
