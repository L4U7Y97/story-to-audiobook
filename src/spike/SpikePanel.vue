<script setup lang="ts">
// Throwaway UI for the Android background-playback spike (Task 2). Removed in Task 13.
import { computed, onMounted, ref } from 'vue';
import { Narrator, type NarratorState } from '@/playback/nativeBridge';
import { buildSpikeQueue, gapStats } from './spikeQueue';

const COUNT = 400;
const state = ref<NarratorState | 'idle'>('idle');
const current = ref(-1);
const startedAt = ref<number | null>(null);
const lastEventAt = ref<number | null>(null);
const events = ref<Array<{ kind: 'start' | 'done'; at: number }>>([]);
const errors = ref<string[]>([]);
const voiceCount = ref<number | null>(null);

const stats = computed(() => gapStats(events.value));
const elapsed = computed(() =>
  startedAt.value && lastEventAt.value
    ? Math.round((lastEventAt.value - startedAt.value) / 1000)
    : 0,
);

onMounted(async () => {
  await Narrator.addListener('utteranceStart', (e) => {
    current.value = e.index;
    startedAt.value ??= e.at;
    lastEventAt.value = e.at;
    events.value.push({ kind: 'start', at: e.at });
  });
  await Narrator.addListener('utteranceDone', (e) => {
    lastEventAt.value = e.at;
    events.value.push({ kind: 'done', at: e.at });
  });
  await Narrator.addListener('state', (e) => (state.value = e.state));
  await Narrator.addListener('error', (e) => errors.value.push(e.message));
});

async function start() {
  await Narrator.requestPermissions();
  events.value = [];
  errors.value = [];
  startedAt.value = null;
  await Narrator.play({ queue: buildSpikeQueue(COUNT) });
}

async function loadVoices() {
  const { voices } = await Narrator.getVoices();
  voiceCount.value = voices.length;
}
</script>

<template>
  <section class="spike">
    <h2>Background playback spike</h2>
    <p>Start, lock the screen, wait 30 minutes, then unlock and read the numbers.</p>
    <div class="buttons">
      <button @click="start">Start {{ COUNT }} utterances</button>
      <button @click="Narrator.pause()">Pause</button>
      <button @click="Narrator.resume()">Resume</button>
      <button @click="Narrator.stop()">Stop</button>
      <button @click="loadVoices">Count voices</button>
    </div>
    <dl>
      <dt>State</dt>
      <dd>{{ state }}</dd>
      <dt>Current utterance</dt>
      <dd>{{ current + 1 }} / {{ COUNT }}</dd>
      <dt>Elapsed (native clock)</dt>
      <dd>{{ Math.floor(elapsed / 60) }} min {{ elapsed % 60 }} s</dd>
      <dt>Completed</dt>
      <dd>{{ stats.done }}</dd>
      <dt>Largest gap between utterances</dt>
      <dd>{{ stats.maxGapMs }} ms (over 3 s: {{ stats.gapsOver3s }})</dd>
      <dt>Device voices</dt>
      <dd>{{ voiceCount ?? '—' }}</dd>
    </dl>
    <ul v-if="errors.length" class="errors">
      <li v-for="(e, i) in errors" :key="i">{{ e }}</li>
    </ul>
  </section>
</template>

<style scoped>
.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
button {
  min-height: 44px;
  padding: 0 12px;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
}
dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.errors {
  color: #d33;
}
</style>
