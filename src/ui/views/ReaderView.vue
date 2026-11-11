<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Character, Mode, Segment } from '@/format/types';
import { modeForAnyone, reassignSegments, tellerOf, type ReassignScope } from '@/analysis/reassign';
import { assignVoice } from '@/cast/assignVoices';
import { findTypedNameOwner } from '@/cast/castOps';
import { paragraphStarts } from '@/playback/utterances';
import { getAppDb } from '@/storage/db';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { newId } from '@/storage/ids';
import { defaultLocale } from '@/storage/stories';
import { listParts } from '@/storage/parts';
import { getStory } from '@/storage/stories';
import { useLiveQuery } from '../composables/useLiveQuery';
import { getEngine, usePlayer } from '../composables/usePlayer';
import { speakerColorIndex, speakerTint } from '../speakerColors';
import PlayerBar from '../components/PlayerBar.vue';
import SpeakerPicker, { type PickScope } from '../components/SpeakerPicker.vue';

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

/**
 * A line's colour: its speaker's. The narrator's own narration has none, so it keeps the text
 * colour and is highlighted with the accent while it plays.
 */
function lineTint(segment: Segment) {
  return segment.mode === 'narration' && segment.speakerId === narratorId.value
    ? undefined
    : { '--tint': speakerTint(colors.value, segment.speakerId) };
}

interface Paragraph {
  /** Someone other than the narrator who reads narration in this paragraph. */
  teller?: string;
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
    const paragraph = out.at(-1)!;
    paragraph.segments.push({ index, segment, text: p.text.slice(segment.start, segment.end) });
    if (segment.mode === 'narration' && segment.speakerId !== narratorId.value) {
      paragraph.teller ??= segment.speakerId;
    }
  });
  return out;
});

/** Who tells the part (tellerOf) and the first line they narrate, for the "Told by" chip. */
const teller = computed(() => {
  const segments = analysis.value?.segments ?? [];
  if (!paragraphs.value.length || !narratorId.value) return undefined;
  const id = tellerOf(segments, narratorId.value);
  const index = segments.findIndex((s) => s.speakerId === id && s.mode === 'narration');
  return index < 0 ? undefined : { id, index };
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
/**
 * A line as it was tapped. An analysis saved again meanwhile (one finishing in the background)
 * can put another line at its index, so the line is found again by its offsets and speaker.
 */
interface Line {
  start: number;
  end: number;
  speakerId: string;
}
/** The line the picker is open on; `teller` when it was opened from the "Told by" chip. */
const picking = ref<(Line & { teller: boolean }) | null>(null);
/**
 * A passage being given to someone: its first line, until its last is tapped.
 * Shallow, so a new character waiting in `added` stays a plain object IndexedDB can store.
 */
const range = shallowRef<{
  first: Line;
  speakerId: string;
  name: string;
  added: Character[];
} | null>(null);
const editError = ref('');

/** The line at `index` as it is shown now. */
function lineAt(index: number): Line | undefined {
  const s = analysis.value?.segments[index];
  return s && { start: s.start, end: s.end, speakerId: s.speakerId };
}

/** Where a tapped line is now; -1 once it was cut differently or given to someone else. */
function lineIndex(line: Line): number {
  return (
    analysis.value?.segments.findIndex(
      (s) => s.start === line.start && s.end === line.end && s.speakerId === line.speakerId,
    ) ?? -1
  );
}

const pickedIndex = computed(() => (picking.value ? lineIndex(picking.value) : -1));
// A re-saved analysis redid the picked line: the sheet closes rather than apply the choice to
// a line the user did not tap.
watch(pickedIndex, (index) => {
  if (index < 0) picking.value = null;
});
const pickedSegment = computed(() =>
  pickedIndex.value < 0 ? undefined : analysis.value?.segments[pickedIndex.value],
);
/** Lines by the picked line's speaker from it to the end of the part, and in all of it. */
const pickedCounts = computed(() => {
  const segments = analysis.value?.segments ?? [];
  const theirs = (from: number) =>
    segments.slice(from).filter((s) => s.speakerId === pickedSegment.value?.speakerId).length;
  return { following: theirs(Math.max(pickedIndex.value, 0)), part: theirs(0) };
});
/**
 * The mode the picker preselects: how the line reads whoever reads it (modeForAnyone), and
 * narration in the "Who tells this part?" sheet. How plain narration reads depends on who is
 * picked, so nothing is preselected and reassignSegments applies defaultMode for them.
 */
const pickedMode = computed((): Mode | undefined => {
  const segments = analysis.value?.segments;
  const p = part.value;
  if (!segments || !p || !picking.value) return undefined;
  return picking.value.teller ? 'narration' : modeForAnyone(p.text, segments, pickedIndex.value);
});

async function toggleEditing() {
  editing.value = !editing.value;
  range.value = null;
  // Segment indices can shift while editing, so playback pauses.
  if (editing.value) await player.pause();
}

// A passage ends in the part it starts in.
watch(partId, () => (range.value = null));

/** Opens the picker on line `index` as it is shown now. */
function openPicker(index: number, teller: boolean) {
  const line = lineAt(index);
  picking.value = line ? { ...line, teller } : null;
}

function onSegmentClick(index: number) {
  if (range.value) void endRange(index);
  else if (editing.value) openPicker(index, false);
  else playFrom(index);
}

function openTeller() {
  range.value = null;
  if (teller.value) openPicker(teller.value.index, true);
}

/** Gives line `index`, and with a wider scope more lines of its speaker, to `speakerId`. */
async function applySpeaker(
  index: number,
  speakerId: string,
  options: { mode?: Mode; scope: ReassignScope },
  added: Character[] = [],
) {
  const a = analysis.value;
  const p = part.value;
  const s = story.value;
  if (!a || !p || !s) return;
  const segments = reassignSegments(p.text, a.segments, index, speakerId, {
    narratorId: s.narratorId,
    ...options,
  });
  try {
    await saveAnalysis(db, { ...a, segments }, { added, aliasAdditions: [] });
    editError.value = '';
    picking.value = null;
  } catch (e) {
    editError.value = e instanceof Error ? e.message : String(e);
  }
}

/** Applies a choice from the picker. A range waits for a tap on its last line. */
async function choose(
  speakerId: string,
  { mode, scope }: { mode?: Mode; scope: PickScope },
  added: Character[] = [],
) {
  const index = pickedIndex.value;
  const segment = pickedSegment.value;
  if (index < 0 || !segment) return;
  // Giving a speaker's lines back to them would only pin those lines as corrections.
  if (scope !== 'line' && speakerId === segment.speakerId) return void (picking.value = null);
  if (scope !== 'range') return applySpeaker(index, speakerId, { mode, scope }, added);
  const name = added[0]?.name ?? names.value.get(speakerId) ?? '';
  const first = { start: segment.start, end: segment.end, speakerId: segment.speakerId };
  range.value = { first, speakerId, name, added };
  picking.value = null;
}

/** Ends a passage at the tapped line: its first line's speaker's lines up to there move. */
async function endRange(through: number) {
  const r = range.value;
  if (!r) return;
  range.value = null;
  // Nothing moves if a re-saved analysis redid the first line meanwhile.
  const from = lineIndex(r.first);
  if (from >= 0) await applySpeaker(from, r.speakerId, { scope: { through } }, r.added);
}

async function createSpeaker(name: string, how: { mode?: Mode; scope: PickScope }) {
  const s = story.value;
  if (!s) return;
  // Someone the cast already knows by that name ("Narrator" included) reads it, not a duplicate.
  const owner = findTypedNameOwner(s.cast, name, s.narratorId);
  if (owner) return choose(owner.id, how);
  const base = { id: newId(), role: 'character' as const, name, aliases: [] };
  const voice = assignVoice(base, s.cast, await getEngine().listVoices(), defaultLocale(s.lang));
  await choose(base.id, how, [{ ...base, voice }]);
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
    <p v-if="range" class="banner" role="status">
      Tap the last line {{ range.name }} reads ·
      <button type="button" class="link" @click="range = null">Cancel</button>
    </p>
    <p v-else-if="editing" class="hint">
      Tap a line to choose who reads it. If a character tells this part, use “Told by”. For a letter
      or a tale, tap its first line, choose “From this line to one I tap next…” and who tells it,
      then tap its last line.
    </p>
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

    <button
      v-if="editing && teller"
      type="button"
      class="told-by"
      aria-haspopup="dialog"
      :style="{ '--tint': speakerTint(colors, teller.id) }"
      @click="openTeller"
    >
      <span class="swatch" aria-hidden="true" />Told by: {{ names.get(teller.id) }}
      <span aria-hidden="true">▾</span>
    </button>

    <article ref="textEl" :class="['text', { editing }]" :lang="story?.lang">
      <p
        v-for="(paragraph, i) in paragraphs"
        :key="i"
        :data-teller="paragraph.teller"
        :style="
          paragraph.teller ? { '--teller': speakerTint(colors, paragraph.teller) } : undefined
        "
      >
        <span
          v-for="s in paragraph.segments"
          :key="s.index"
          :data-index="s.index"
          :data-mode="s.segment.mode"
          :class="[
            'segment',
            {
              current: s.index === currentIndex,
              voiced: s.segment.mode !== 'narration',
            },
          ]"
          :style="lineTint(s.segment)"
          :title="names.get(s.segment.speakerId)"
          @click="onSegmentClick(s.index)"
          >{{ s.text }}</span
        >
      </p>
    </article>

    <PlayerBar v-if="!editing" :player="player" :snapshot="snapshot" />
    <SpeakerPicker
      v-if="picking && pickedSegment && part && story"
      :segment="pickedSegment"
      :text="part.text.slice(pickedSegment.start, pickedSegment.end)"
      :cast="story.cast"
      :colors="colors"
      :counts="pickedCounts"
      :initial-scope="picking.teller ? 'part' : 'line'"
      :default-mode="pickedMode"
      :title="picking.teller ? 'Who tells this part?' : undefined"
      @pick="choose($event.speakerId, $event)"
      @create="createSpeaker($event.name, $event)"
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

/* Stays in view while the user scrolls to the passage's last line. */
.banner {
  position: sticky;
  top: 0;
  z-index: 10;
  margin: 0 0 12px;
  padding: 0 12px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--surface);
}

.told-by {
  gap: 8px;
  margin-bottom: 12px;
  border-radius: 999px;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--tint);
  flex: none;
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

/* A paragraph whose narration a character reads; the narration keeps the text colour. */
.text p[data-teller] {
  border-inline-start: 3px solid var(--teller);
  padding-inline-start: 12px;
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
