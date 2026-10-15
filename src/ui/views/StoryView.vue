<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AnalysisStatus, Part } from '@/format/types';
import { formatUsd } from '@/analysis/llm/cost';
import { exportFileName, exportStory } from '@/storage/exportImport';
import { saveTextFile } from '../files';
import { getAppDb } from '@/storage/db';
import { getStory } from '@/storage/stories';
import { deletePart, listParts, movePart, renamePart } from '@/storage/parts';
import { useLiveQuery } from '../composables/useLiveQuery';
import { existingPlayer } from '../composables/usePlayer';
import { modelLabel, useAnalysis, type Method } from '../composables/useAnalysis';
import AddPartForm from '../components/AddPartForm.vue';
import PartActions from '../components/PartActions.vue';

const props = defineProps<{ id: string }>();
const db = getAppDb();

const { data: story } = useLiveQuery(() => getStory(db, props.id), [() => props.id]);
const { data: parts } = useLiveQuery(() => listParts(db, props.id), [() => props.id]);
const adding = ref(false);
const replacing = ref<Part | undefined>();
const { settings, progress, errors, notes, loadSettings, hasKey, estimate, run } = useAnalysis(db);
/** Parts waiting for the user to accept the cost of analysing them with Claude. */
const confirming = ref<Part[]>([]);
const confirmEstimate = computed(() =>
  story.value && confirming.value.length ? estimate(story.value, confirming.value) : undefined,
);

onMounted(loadSettings);

const exporting = ref(false);
const exportError = ref('');

async function exportFile() {
  if (!story.value) return;
  exporting.value = true;
  exportError.value = '';
  try {
    const data = await exportStory(db, story.value.id);
    await saveTextFile(exportFileName(story.value), JSON.stringify(data));
  } catch (e) {
    exportError.value = `Export failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    exporting.value = false;
  }
}
const characterCount = computed(
  () => story.value?.cast.filter((c) => c.role === 'character').length ?? 0,
);

/**
 * Analyses parts in reading order (analyses run one at a time, so later parts reuse earlier
 * characters). With an API key, Claude is used only after the user has seen the cost estimate.
 */
async function analyse(parts: Part[], method?: Method) {
  await loadSettings();
  if (!method && hasKey()) {
    confirming.value = parts;
    return;
  }
  confirming.value = [];
  for (const part of parts) await run(part, method ?? 'heuristic');
}

async function onAdded(added: Part[]) {
  adding.value = false;
  replacing.value = undefined;
  await analyse(added);
}

function startReplace(part: Part) {
  adding.value = false;
  replacing.value = part;
}

async function move(part: Part, delta: number) {
  const index = parts.value?.findIndex((p) => p.id === part.id) ?? -1;
  if (index >= 0) await movePart(db, props.id, part.id, index + delta);
}

async function remove(part: Part) {
  // Stop playback if it is reading the part being deleted.
  const playing = existingPlayer(props.id);
  if (playing?.snapshot.value.position?.partId === part.id) await playing.player.stop();
  await deletePart(db, props.id, part.id);
}

const STATUS_LABEL: Record<AnalysisStatus, string> = {
  pending: 'Waiting for analysis',
  running: 'Analysing…',
  done: 'Ready',
  failed: 'Analysis failed',
};

function statusLabel(part: Part): string {
  const p = progress.value[part.id];
  if (part.analysisStatus === 'running' && p?.total) return `Analysing… ${p.done}/${p.total}`;
  return STATUS_LABEL[part.analysisStatus];
}

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
        <li v-for="(part, i) in parts" :key="part.id" class="card part">
          <RouterLink
            class="part-title"
            :to="{ name: 'reader', params: { id: story.id, partId: part.id } }"
            >{{ part.title }}</RouterLink
          >
          <span class="muted">{{ wordCount(part.text).toLocaleString() }} words</span>
          <span class="status" :data-status="part.analysisStatus">
            {{ statusLabel(part) }}
            <button
              v-if="
                (part.analysisStatus === 'pending' && !confirming.some((p) => p.id === part.id)) ||
                (part.analysisStatus === 'failed' && !errors[part.id])
              "
              class="analyse"
              @click="analyse([part])"
            >
              {{ part.analysisStatus === 'failed' ? 'Retry' : 'Analyse' }}
            </button>
          </span>
          <PartActions
            class="part-menu"
            :part="part"
            :first="i === 0"
            :last="i === parts.length - 1"
            :has-key="Boolean(settings?.apiKey)"
            @rename="renamePart(db, part.id, $event)"
            @move="move(part, $event)"
            @replace="startReplace(part)"
            @reanalyse="analyse([part], $event)"
            @remove="remove(part)"
          />
          <div v-if="errors[part.id]" class="error" role="alert">
            <span>{{ errors[part.id]!.message }}</span>
            <span class="error-actions">
              <button class="analyse" @click="analyse([part], errors[part.id]!.method)">
                Retry
              </button>
              <button
                v-if="errors[part.id]!.method === 'llm'"
                class="analyse"
                @click="analyse([part], 'heuristic')"
              >
                Analyse without Claude
              </button>
              <RouterLink
                v-if="errors[part.id]!.message === 'API key rejected'"
                :to="{ name: 'settings' }"
                >Settings</RouterLink
              >
            </span>
          </div>
          <p v-else-if="notes[part.id]" class="note muted">{{ notes[part.id] }}</p>
        </li>
      </ol>
      <p v-else-if="parts" class="muted">No parts yet. Add the first chapter or a few pages.</p>

      <section
        v-if="confirming.length && confirmEstimate"
        class="card confirm"
        aria-labelledby="confirm-heading"
      >
        <h2 id="confirm-heading">
          Analyse
          {{ confirming.length === 1 ? `“${confirming[0]!.title}”` : `${confirming.length} parts` }}
          with Claude?
        </h2>
        <p class="muted">
          {{ modelLabel(settings?.model ?? '') }} · {{ confirmEstimate.requests }}
          {{ confirmEstimate.requests === 1 ? 'request' : 'requests' }} · about
          {{ Math.round((confirmEstimate.inputTokens + confirmEstimate.outputTokens) / 1000) }}k
          tokens
        </p>
        <p>
          Estimated cost:
          <strong>{{
            confirmEstimate.usd === undefined
              ? 'unknown for this model'
              : formatUsd(confirmEstimate.usd)
          }}</strong>
        </p>
        <div class="confirm-actions">
          <button class="primary" @click="analyse(confirming, 'llm')">Analyse with Claude</button>
          <button @click="analyse(confirming, 'heuristic')">Use the free method</button>
          <button class="link" @click="confirming = []">Not now</button>
        </div>
      </section>

      <AddPartForm
        v-if="adding || replacing"
        :key="replacing?.id ?? 'new'"
        :story-id="story.id"
        :parts="parts ?? []"
        :replacing="replacing"
        @added="onAdded"
        @cancel="((adding = false), (replacing = undefined))"
      />
      <button v-else class="primary add" @click="adding = true">Add a part</button>

      <section v-if="parts?.length" class="backup" aria-labelledby="backup-heading">
        <h2 id="backup-heading">Backup</h2>
        <p class="muted">
          Stories live only on this device. Export one to a file to keep a copy or open it on
          another device (Library → Import a story). The file has the text, analysis and voices,
          never your API key.
        </p>
        <button :disabled="exporting" @click="exportFile">
          {{ exporting ? 'Exporting…' : 'Export story' }}
        </button>
        <p v-if="exportError" class="error" role="alert">{{ exportError }}</p>
      </section>
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
  grid-template-columns: 1fr auto auto;
  gap: 2px 12px;
  counter-increment: part;
}

.part-title {
  font-weight: 600;
  color: inherit;
  text-decoration: none;
}

.backup {
  margin-top: 32px;
  display: grid;
  gap: 8px;
  justify-items: start;
}

.backup h2 {
  margin: 0;
  font-size: 1.05rem;
}

.backup p {
  margin: 0;
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

.part-menu {
  grid-column: 3;
  grid-row: 1 / span 2;
  align-self: center;
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

.error,
.note {
  grid-column: 1 / -1;
  margin: 4px 0 0;
  font-size: 0.85rem;
}

.error {
  color: var(--danger);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.error-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.confirm {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}

.confirm h2 {
  margin: 0;
  font-size: 1.05rem;
}

.confirm p {
  margin: 0;
}

.confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.link {
  border: none;
  background: none;
  color: var(--accent);
}
</style>
