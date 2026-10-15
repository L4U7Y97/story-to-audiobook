<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Character, Mode, Segment } from '@/format/types';
import { reassignSegment } from '@/analysis/reassign';
import { assignVoice } from '@/cast/assignVoices';
import { paragraphStarts } from '@/playback/utterances';
import { getAppDb } from '@/storage/db';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { newId } from '@/storage/ids';
import { defaultLocale } from '@/storage/stories';
import { listParts } from '@/storage/parts';
import { getStory } from '@/storage/stories';
import { useLiveQuery } from '../composables/useLiveQuery';
import { getEngine, usePlayer } from '../composables/usePlayer';
import { speakerColorIndex } from '../speakerColors';
import PlayerBar from '../components/PlayerBar.vue';
import SpeakerPicker from '../components/SpeakerPicker.vue';

const props = defineProps<{ id: string; partId?: string }>();
const db = getAppDb();
const router = useRouter();
const { player, snapshot } = usePlayer(props.id);

const { data: story } = useLiveQuery(() => getStory(db, props.id), [() => props.id]);
const { data: parts } = useLiveQuery(() => listParts(db, props.id), [() => props.id]);

/** The part shown: the route's, else the one being played, else the saved or first one. */
const partId = computed(
  () =>
    props.partId ??
    snapshot.value.position?.partId ??
    story.value?.position?.partId ??
    story.value?.partIds[0],
);
const part = computed(() => parts.value?.find((p) => p.id === partId.value));
const { data: analysis } = useLiveQuery(
  async () => (partId.value ? getAnalysis(db, partId.value) : undefined),
  [partId],
);
const colors = computed(() => speakerColorIndex(story.value?.cast ?? []));
const names = computed(() => new Map(story.value?.cast.map((c) => [c.id, c.name])));
const narratorId = computed(() => story.value?.narratorId);

interface Paragraph {
  segments: Array<{ index: number; segment: Segment; text: string }>;
}

const paragraphs = computed<Paragraph[]>(() => {
  const p = part.value;
  const a = analysis.value;
  if (!p || !a || a.textHash !== p.textHash) return [];
  const starts = paragraphStarts(p.text, a.segments);
  const out: Paragraph[] = [];
  a.segments.forEach((segment, index) => {
    if (starts[index]) out.push({ segments: [] });
    out.at(-1)!.segments.push({ index, segment, text: p.text.slice(segment.start, segment.end) });
  });
  return out;
});

const currentIndex = computed(() => {
  const position = snapshot.value.position;
  return position && position.partId === partId.value ? position.segmentIndex : -1;
});

// Keep the spoken segment in view.
const textEl = ref<HTMLElement>();
watch(currentIndex, async (index) => {
  if (index < 0) return;
  await nextTick();
  textEl.value
    ?.querySelector(`[data-index="${index}"]`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

// Follow playback into the next part.
watch(
  () => snapshot.value.position?.partId,
  (playingPart) => {
    if (playingPart && props.partId && playingPart !== props.partId) {
      void router.replace({ name: 'reader', params: { id: props.id, partId: playingPart } });
    }
  },
);

function playFrom(index: number) {
  if (!partId.value) return;
  void player.play({ partId: partId.value, segmentIndex: index });
}

// "Fix speakers" mode: tapping a line opens the speaker picker instead of playing it.
const editing = ref(false);
const picking = ref<number | null>(null);
const editError = ref('');
const pickedSegment = computed(() =>
  picking.value === null ? undefined : analysis.value?.segments[picking.value],
);

async function toggleEditing() {
  editing.value = !editing.value;
  // Segment indices can shift while editing, so playback pauses.
  if (editing.value) await player.pause();
}

function onSegmentClick(index: number) {
  if (editing.value) picking.value = index;
  else playFrom(index);
}

async function applySpeaker(speakerId: string, mode?: Mode, added: Character[] = []) {
  const a = analysis.value;
  const p = part.value;
  const s = story.value;
  if (!a || !p || !s || picking.value === null) return;
  const segments = reassignSegment(
    p.text,
    a.segments,
    picking.value,
    speakerId,
    s.narratorId,
    mode,
  );
  try {
    await saveAnalysis(db, { ...a, segments }, { added, aliasAdditions: [] });
    editError.value = '';
    picking.value = null;
  } catch (e) {
    editError.value = e instanceof Error ? e.message : String(e);
  }
}

async function createSpeaker(name: string, mode?: Mode) {
  const s = story.value;
  if (!s) return;
  const base = { id: newId(), role: 'character' as const, name, aliases: [] };
  const voice = assignVoice(base, s.cast, await getEngine().listVoices(), defaultLocale(s.lang));
  await applySpeaker(base.id, mode, [{ ...base, voice }]);
}

function selectPart(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  void player.jump({ partId: id, segmentIndex: 0 });
  void router.replace({ name: 'reader', params: { id: props.id, partId: id } });
}
</script>

<template>
  <main class="page reader">
    <nav class="top">
      <RouterLink :to="{ name: 'story', params: { id } }"
        >← {{ story?.title ?? 'Story' }}</RouterLink
      >
      <span class="top-actions">
        <button
          v-if="paragraphs.length"
          class="link"
          :aria-pressed="editing"
          @click="toggleEditing"
        >
          {{ editing ? 'Done' : 'Fix speakers' }}
        </button>
        <RouterLink :to="{ name: 'cast', params: { id } }">Cast</RouterLink>
      </span>
    </nav>
    <p v-if="editing" class="hint">Tap a line to choose who reads it.</p>
    <p v-if="editError" class="error" role="alert">{{ editError }}</p>

    <label v-if="parts?.length" class="part-picker">
      <span class="sr-only">Part</span>
      <select :value="partId" @change="selectPart">
        <option v-for="p in parts" :key="p.id" :value="p.id">{{ p.title }}</option>
      </select>
    </label>

    <p v-if="part && !paragraphs.length" class="muted">
      This part has not been analysed yet. Analyse it from the story page to hear it.
    </p>

    <article ref="textEl" :class="['text', { editing }]" :lang="story?.lang">
      <p v-for="(paragraph, i) in paragraphs" :key="i">
        <span
          v-for="s in paragraph.segments"
          :key="s.index"
          :data-index="s.index"
          :data-mode="s.segment.mode"
          :class="[
            'segment',
            {
              current: s.index === currentIndex,
              voiced: s.segment.speakerId !== narratorId,
            },
          ]"
          :style="
            colors.has(s.segment.speakerId)
              ? { '--tint': `var(--speaker-${colors.get(s.segment.speakerId)})` }
              : undefined
          "
          :title="names.get(s.segment.speakerId)"
          @click="onSegmentClick(s.index)"
          >{{ s.text }}</span
        >
      </p>
    </article>

    <PlayerBar v-if="!editing" :player="player" :snapshot="snapshot" />
    <SpeakerPicker
      v-if="pickedSegment && part && story"
      :segment="pickedSegment"
      :text="part.text.slice(pickedSegment.start, pickedSegment.end)"
      :cast="story.cast"
      :colors="colors"
      @pick="applySpeaker($event.speakerId, $event.mode)"
      @create="createSpeaker($event.name, $event.mode)"
      @close="picking = null"
    />
  </main>
</template>

<style scoped>
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.top-actions {
  display: flex;
  gap: 16px;
  align-items: center;
}

.link {
  min-height: 44px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  text-decoration: underline;
}

.hint {
  color: var(--muted);
  font-size: 0.9rem;
}

.error {
  color: var(--danger);
}

.text.editing .segment {
  text-decoration: underline dotted;
  text-underline-offset: 4px;
}

.part-picker {
  margin-bottom: 16px;
}

.text {
  font-size: 1.1rem;
  line-height: 1.7;
}

.text p {
  margin: 0 0 1em;
}

.segment {
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.segment.voiced {
  color: var(--tint, var(--fg));
}

.segment[data-mode='thought'] {
  font-style: italic;
}

.segment.current {
  background: color-mix(in srgb, var(--tint, var(--accent)) 22%, transparent);
  outline: 2px solid color-mix(in srgb, var(--tint, var(--accent)) 40%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .segment {
    transition: none;
  }
}
</style>
