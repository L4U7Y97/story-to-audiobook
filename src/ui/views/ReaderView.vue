<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Character, Mode, Segment } from '@/format/types';
import { modeForAnyone, reassignSegments, tellerOf, type ReassignScope } from '@/analysis/reassign';
import { assignVoice } from '@/cast/assignVoices';
import { findTypedNameOwner } from '@/cast/castOps';
import { inferTraits } from '@/cast/traits';
import type { PlayerPosition } from '@/playback/player';
import { paragraphStarts } from '@/playback/utterances';
import { getAppDb } from '@/storage/db';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { mergeCharactersInStory } from '@/storage/cast';
import { newId } from '@/storage/ids';
import { DEFAULT_LOCALE } from '@/storage/stories';
import { listParts } from '@/storage/parts';
import { groupParts } from '@/storage/books';
import { getStory, updateStory } from '@/storage/stories';
import { useLiveQuery } from '../composables/useLiveQuery';
import { getEngine, usePlayer } from '../composables/usePlayer';
import { speakerColorIndex, speakerTint } from '../speakerColors';
import PlayerBar from '../components/PlayerBar.vue';
import SpeakerPicker, { type PickScope } from '../components/SpeakerPicker.vue';

/** `line`: a line of the route's part to scroll to and mark, as a cast card's links ask. */
const props = defineProps<{ id: string; partId?: string; line?: number }>();
const db = getAppDb();
const router = useRouter();
const { player, snapshot, listening } = usePlayer(props.id);

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

/** Back goes to the shown part's book when the story has books, else to the story. */
const book = computed(() =>
  part.value?.bookId ? story.value?.books?.find((b) => b.id === part.value!.bookId) : undefined,
);
const backTo = computed(() =>
  book.value
    ? { name: 'book', params: { id: props.id, bookId: book.value.id } }
    : { name: 'story', params: { id: props.id } },
);
const backTitle = computed(() => book.value?.title ?? story.value?.title ?? 'Story');
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

const textEl = ref<HTMLElement>();

/**
 * Scrolls a line to the middle of the screen: at once with `jump` (the page has just shown its
 * part) or when the reader asked for less motion, smoothly otherwise.
 */
function scrollToLine(index: number, jump = false) {
  const still = jump || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  textEl.value
    ?.querySelector(`[data-index="${index}"]`)
    ?.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
}

/**
 * Whether the page keeps the spoken line in view. Scrolling away to read stops that, so the page
 * is not pulled back at every line; "Back to the playing line" starts it again. A line linked
 * from the cast is read where it is.
 */
const following = ref(props.line === undefined);

/** Stops following playback: the page, and the part it shows, stay where the reader went. */
function stopFollowing() {
  if (!following.value) return;
  following.value = false;
  // A way back still on its way to another part gives no line the focus.
  focusOnLanding = false;
  // A part shown because it plays stays shown when the player moves on to the next one.
  if (!props.partId && partId.value) {
    void router.replace({ name: 'reader', params: { id: props.id, partId: partId.value } });
  }
}

/** A wheel or a finger scrolls the page, unless it scrolls the speaker picker. */
function onScrollGesture(event: Event) {
  if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
  stopFollowing();
}

/**
 * A press on the page's scrollbar, or with the middle button (which scrolls what is under it on
 * Windows), scrolls the page too: not in the speaker picker, which scrolls itself, nor the middle
 * button on a link, which opens it elsewhere. Find in page, and a screen reader's own scrolling,
 * are not seen.
 */
function onPointerDown(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target : undefined;
  if (target?.closest('[role="dialog"]')) return;
  const page = document.documentElement;
  const onScrollbar = target === page && event.clientX >= page.clientWidth;
  const autoscroll = event.button === 1 && !target?.closest('a');
  if (onScrollbar || autoscroll) stopFollowing();
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** What keeps every scroll key: a field, and the speaker picker, which scrolls itself. */
const KEEPS_KEYS = 'input, select, textarea, [role="dialog"]';
/**
 * Keys that scroll the page. A button or a summary keeps Space, which presses it, and lets the
 * other keys scroll; a link lets them all scroll.
 */
function onKeyDown(event: KeyboardEvent) {
  if (!SCROLL_KEYS.has(event.key)) return;
  const target = event.target instanceof Element ? event.target : undefined;
  if (target?.closest(event.key === ' ' ? `${KEEPS_KEYS}, button, summary` : KEEPS_KEYS)) return;
  stopFollowing();
}

/** The line a link asked for, marked while the route asks for it (changing part drops it). */
const targetIndex = computed(() =>
  props.line !== undefined && Number.isInteger(props.line) && props.partId === partId.value
    ? props.line
    : -1,
);
// Scroll to it once its part's lines are shown. Playback is left alone: tapping it plays it.
watch(
  [targetIndex, () => paragraphs.value.length],
  async ([index, shown]) => {
    if (index < 0 || !shown) return;
    await nextTick();
    scrollToLine(index);
  },
  { immediate: true },
);

// Follow playback into the next part when the page was on the part it left, reading along. A
// part opened while another one plays stays: "Back to the playing line" goes to the other.
watch(
  () => snapshot.value.position?.partId,
  (playingPart, left) => {
    if (!playingPart || !left || playingPart === left) return;
    if (props.partId === left && following.value) {
      void router.replace({ name: 'reader', params: { id: props.id, partId: playingPart } });
    }
  },
);

/** Plays from a tapped line, on the screen: the page follows playback again. */
function playFrom(index: number) {
  if (!partId.value) return;
  following.value = true;
  // The page is on the part already: the line tapped is scrolled to smoothly.
  landedIn = partId.value;
  void player.play({ partId: partId.value, segmentIndex: index });
}

// "Fix speakers" mode: tapping a line opens the speaker picker instead of playing it.
const editing = ref(false);

/** The part the page has been on with a line being read in it (gone to, or tapped). */
let landedIn: string | undefined;
// While following, keep the spoken line in view from the moment its part's lines show (the reader
// often opens on a part already playing), the first time at once. Not while fixing speakers: a
// fix can renumber the lines, and the page must not move away from the line being fixed; Done
// goes to the line only in a part gone to while fixing. An analysis saved again with other lines
// does not move the page.
watch(
  [currentIndex, () => paragraphs.value.length > 0, editing],
  async ([index, shown, fixing], before) => {
    if (index < 0 || !shown || fixing || !following.value) return;
    const first = landedIn !== partId.value;
    if (before?.[2] && !first) return;
    landedIn = partId.value;
    await nextTick();
    scrollToLine(index, first);
    if (focusOnLanding) {
      focusOnLanding = false;
      focusLine(index);
    }
  },
  { immediate: true },
);

/** The line the way back went to: it has the focus the button had (tabindex -1). */
const focusedLine = ref(-1);
/** Set while the way back goes to another part: its line takes the focus once it shows. */
let focusOnLanding = false;
function focusLine(index: number) {
  focusedLine.value = index;
  void nextTick(() =>
    textEl.value
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.focus({ preventScroll: true }),
  );
}

const mainEl = ref<HTMLElement>();
const headEl = ref<HTMLElement>();
/**
 * Where the line being read (or paused on) is when the page does not show it: in another part,
 * or off the screen while the page does not follow it. Only a place being listened to (the
 * player's `listening`), which going to another part's start ends at once, before the player has
 * moved there.
 */
const lineAway = ref<'above' | 'below'>();
/** How far "Back to the playing line" sits from the bottom: just above the player. */
const awayBottom = ref(0);
function measure() {
  const at = snapshot.value.position;
  if (!at || !listening.value || editing.value || (following.value && at.partId === partId.value)) {
    lineAway.value = undefined;
    return;
  }
  const bar = mainEl.value?.querySelector('.player-bar')?.getBoundingClientRect();
  const floor = bar?.height ? bar.top : window.innerHeight;
  awayBottom.value = window.innerHeight - floor + 12;
  if (at.partId !== partId.value) {
    const playing = orderedParts.value.findIndex((p) => p.id === at.partId);
    lineAway.value = playing < 0 ? undefined : playing < partPosition.value ? 'above' : 'below';
    return;
  }
  const line = textEl.value?.querySelector(`[data-index="${at.segmentIndex}"]`);
  if (!line) {
    lineAway.value = undefined;
    return;
  }
  const { top, bottom } = line.getBoundingClientRect();
  const ceiling = headEl.value?.getBoundingClientRect().bottom ?? 0;
  lineAway.value = bottom <= ceiling ? 'above' : top >= floor ? 'below' : undefined;
}
let measuring = 0;
function measureSoon() {
  measuring ||= requestAnimationFrame(() => {
    measuring = 0;
    measure();
  });
}
watch(
  [following, editing, snapshot, partId, () => paragraphs.value.length > 0],
  () => nextTick(measure),
  { immediate: true },
);

onMounted(() => {
  window.addEventListener('wheel', onScrollGesture, { passive: true });
  window.addEventListener('touchmove', onScrollGesture, { passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('scroll', measureSoon, { passive: true });
  window.addEventListener('resize', measureSoon, { passive: true });
});
onBeforeUnmount(() => {
  window.removeEventListener('wheel', onScrollGesture);
  window.removeEventListener('touchmove', onScrollGesture);
  window.removeEventListener('pointerdown', onPointerDown);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('scroll', measureSoon);
  window.removeEventListener('resize', measureSoon);
  cancelAnimationFrame(measuring);
});

/** When "Back to the playing line" was last tapped (performance.now()). */
let backTappedAt = -Infinity;
/** How soon after it a tap is the second of a double tap. */
const DOUBLE_TAP_MS = 500;

/** Back to the spoken line, in its part: the page follows playback again. */
function backToLine() {
  backTappedAt = performance.now();
  const at = snapshot.value.position;
  following.value = true;
  if (!at) return;
  // Another part's lines show first; the page goes to the line once they do.
  if (at.partId !== partId.value) {
    focusOnLanding = true;
    void router.replace({ name: 'reader', params: { id: props.id, partId: at.partId } });
  } else {
    landedIn = partId.value;
    scrollToLine(at.segmentIndex);
    focusLine(at.segmentIndex);
  }
}
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

/**
 * Where Done carries on listening: the place "Fix speakers" paused, which fixes keep on the same
 * words (keepPlace). Anything else that moves playback meanwhile (another part, the media
 * controls) leaves it behind, and Done then leaves playback alone.
 */
let carryOn: PlayerPosition | undefined;
/** Settles once every fix started so far is saved and its place kept. */
let fixesSaved: Promise<unknown> = Promise.resolve();

async function toggleEditing() {
  editing.value = !editing.value;
  range.value = null;
  if (editing.value) {
    // Segment indices can shift while editing, so playback pauses.
    carryOn = snapshot.value.state === 'playing' ? snapshot.value.position : undefined;
    await player.pause();
    return;
  }
  // A fix still being saved moves the place: wait for it.
  await fixesSaved;
  const at = carryOn;
  carryOn = undefined;
  if (editing.value || !at || snapshot.value.position !== at) return;
  if (snapshot.value.state === 'paused') await player.resume();
  // A fix dropped the old queue (keepPlace): play again from the same words, in the new voices.
  else if (snapshot.value.state === 'idle') await player.play(at);
}

/** A part's lines as they were before a fix changed them. */
interface ChangedLines {
  partId: string;
  lines: readonly Segment[];
}

/**
 * Saves a fix, then keeps the place (keepPlace). `changed`: the part whose lines the fix may
 * join, with its lines before the fix.
 */
function saveFix(save: () => Promise<unknown>, changed?: ChangedLines): Promise<void> {
  const work = (async () => {
    try {
      await save();
      editError.value = '';
      picking.value = null;
      await keepPlace(changed);
    } catch (e) {
      editError.value = e instanceof Error ? e.message : String(e);
    }
  })();
  fixesSaved = Promise.all([fixesSaved, work]);
  return work;
}

/**
 * After a fix: the place, where the player is or else the saved place, stays on the same words,
 * since a fix can join lines and so renumber the lines after them. The player jumps there, which
 * drops the queue it built before the fix (its voices and line numbers are out of date), so
 * playback goes on with the new voices: at once if it is playing, at the next Play if not.
 */
async function keepPlace(changed?: ChangedLines) {
  const after = changed && (await getAnalysis(db, changed.partId))?.segments;
  // Read once the fix is saved: playback may have moved meanwhile.
  const live = snapshot.value.position;
  const at = live ?? story.value?.position;
  if (!at) return;
  const offset = at.partId === changed?.partId ? changed.lines[at.segmentIndex]?.start : undefined;
  const found = offset === undefined ? -1 : (after?.findIndex((s) => s.end > offset) ?? -1);
  const moved = { partId: at.partId, segmentIndex: found < 0 ? at.segmentIndex : found };
  if (!live) {
    if (moved.segmentIndex !== at.segmentIndex)
      await updateStory(db, props.id, { position: moved });
    return;
  }
  const carried = live === carryOn;
  await player.jump(moved);
  if (carried) carryOn = moved;
}

// A passage ends in the part it starts in.
watch(partId, () => (range.value = null));

/** Opens the picker on line `index` as it is shown now. */
function openPicker(index: number, teller: boolean) {
  const line = lineAt(index);
  picking.value = line ? { ...line, teller } : null;
}

function onSegmentClick(index: number) {
  // The second tap of a double tap on "Back to the playing line" lands on the line it uncovers.
  if (performance.now() - backTappedAt < DOUBLE_TAP_MS) return;
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
  await saveFix(
    () =>
      saveAnalysis(
        db,
        { ...a, segments },
        { added, aliasAdditions: [], pruneUnusedCharacters: true },
      ),
    { partId: p.id, lines: a.segments },
  );
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
  // What the name gives away ("the old man") goes in first: the voice is picked from it.
  const traits = inferTraits([name]);
  const base = { id: newId(), role: 'character' as const, name, aliases: [], ...traits };
  const voice = assignVoice(base, s.cast, await getEngine().listVoices(), DEFAULT_LOCALE);
  await choose(base.id, how, [{ ...base, voice }]);
}

/** The picked line's speaker is `intoId` under another name: they are merged in every part. */
async function mergeSpeaker(intoId: string) {
  const fromId = pickedSegment.value?.speakerId;
  if (!fromId) return;
  range.value = null;
  // A merge renames speakers in every part but never joins lines (castOps mergeCharacters).
  await saveFix(() => mergeCharactersInStory(db, props.id, fromId, intoId));
}

/** Parts in the order the picker lists them. */
const orderedParts = computed(() => {
  const list = parts.value ?? [];
  return story.value?.books?.length
    ? groupParts(story.value.books, list).flatMap((g) => g.parts)
    : list;
});
const partPosition = computed(() => orderedParts.value.findIndex((p) => p.id === partId.value));
const previousPart = computed(() =>
  partPosition.value > 0 ? orderedParts.value[partPosition.value - 1] : undefined,
);
const nextPart = computed(() =>
  partPosition.value >= 0 ? orderedParts.value[partPosition.value + 1] : undefined,
);

/** Shows part `id`. The part being listened to keeps its place; another starts at its first line. */
function goToPart(id: string) {
  following.value = true;
  focusOnLanding = false;
  if (!listening.value || snapshot.value.position?.partId !== id) {
    // The place moves: Done no longer carries on where Fix speakers paused.
    carryOn = undefined;
    listening.value = false;
    void player.jump({ partId: id, segmentIndex: 0 });
  }
  void router.replace({ name: 'reader', params: { id: props.id, partId: id } });
  window.scrollTo({ top: 0 });
}

function selectPart(event: Event) {
  goToPart((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <main ref="mainEl" class="page reader">
    <header ref="headEl" class="reader-head">
      <nav class="top">
        <!-- On a phone only the arrow shows; the title is still read out. -->
        <RouterLink :to="backTo" class="back" :title="backTitle"
          >←<span class="phone-hidden">{{ ` ${backTitle}` }}</span></RouterLink
        >
        <div v-if="parts?.length" class="part-nav">
          <button
            type="button"
            class="part-step"
            aria-label="Previous part"
            :title="previousPart?.title"
            :disabled="!previousPart"
            @click="previousPart && goToPart(previousPart.id)"
          >
            ‹
          </button>
          <label class="part-picker">
            <span class="sr-only">Part</span>
            <select :value="partId" @change="selectPart">
              <template v-if="story?.books?.length">
                <optgroup
                  v-for="group in groupParts(story.books, parts)"
                  :key="group.book!.id"
                  :label="group.book!.title"
                >
                  <option v-for="p in group.parts" :key="p.id" :value="p.id">{{ p.title }}</option>
                </optgroup>
              </template>
              <template v-else>
                <option v-for="p in parts" :key="p.id" :value="p.id">{{ p.title }}</option>
              </template>
            </select>
          </label>
          <button
            type="button"
            class="part-step"
            aria-label="Next part"
            :title="nextPart?.title"
            :disabled="!nextPart"
            @click="nextPart && goToPart(nextPart.id)"
          >
            ›
          </button>
        </div>
        <span class="top-actions">
          <button
            v-if="paragraphs.length"
            class="link"
            :aria-pressed="editing"
            @click="toggleEditing"
          >
            <template v-if="editing">Done</template>
            <template v-else
              >Fix<span class="phone-hidden">{{ ' speakers' }}</span></template
            >
          </button>
          <RouterLink :to="{ name: 'cast', params: { id } }">Cast</RouterLink>
        </span>
      </nav>
      <p v-if="range" class="banner" role="status">
        Tap the last line {{ range.name }} reads ·
        <button type="button" class="link" @click="range = null">Cancel</button>
      </p>
    </header>

    <p v-if="editing && !range" class="hint">
      Tap a line to choose who reads it. If a character tells this part, use “Told by”. For a letter
      or a tale, tap its first line, choose “From this line to one I tap next…” and who tells it,
      then tap its last line.
    </p>
    <p v-if="editError" class="error" role="alert">{{ editError }}</p>

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
              target: s.index === targetIndex,
              voiced: s.segment.mode !== 'narration',
            },
          ]"
          :style="lineTint(s.segment)"
          :title="names.get(s.segment.speakerId)"
          :tabindex="s.index === focusedLine ? -1 : undefined"
          @click="onSegmentClick(s.index)"
          >{{ s.text }}</span
        >
      </p>
    </article>

    <button
      v-if="lineAway"
      type="button"
      class="back-to-line"
      :style="{ bottom: `${awayBottom}px` }"
      @click="backToLine"
    >
      <span aria-hidden="true">{{ lineAway === 'above' ? '↑' : '↓' }}</span>
      Back to the playing line
    </button>
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
      :mergeable="!picking.teller"
      @pick="choose($event.speakerId, $event)"
      @merge="mergeSpeaker"
      @create="createSpeaker($event.name, $event)"
      @close="picking = null"
    />
  </main>
</template>

<style scoped>
/* Nav, passage banner and part picker stay at the top while the text scrolls under them. */
.reader-head {
  position: sticky;
  top: 0;
  z-index: 10;
  margin: calc(-1 * var(--gutter)) calc(-1 * var(--gutter)) 16px;
  padding: var(--gutter) var(--gutter) 12px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.part-nav {
  display: flex;
  gap: 8px;
  align-items: center;
}

.part-step {
  flex: none;
  width: 44px;
  padding: 0;
  font-size: 1.4rem;
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

/* In the sticky header, so it stays in view while the user scrolls to the passage's last line. */
.banner {
  margin: 0 0 8px;
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
  flex: 1;
  min-width: 0;
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

/* The line a cast card linked to: underlined in its speaker's colour, under the playing mark. */
.segment.target {
  text-decoration: underline 2px var(--tint, var(--accent));
  text-underline-offset: 4px;
  background: color-mix(in srgb, var(--tint, var(--accent)) 10%, transparent);
}

.segment.current {
  background: color-mix(in srgb, var(--tint, var(--accent)) 22%, transparent);
  outline: 2px solid color-mix(in srgb, var(--tint, var(--accent)) 40%, transparent);
}

/* Over the text, just above the player, while the reader reads away from the playing line. */
.back-to-line {
  position: fixed;
  left: 50%;
  z-index: 11;
  transform: translateX(-50%);
  gap: 6px;
  border-radius: 999px;
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
  white-space: nowrap;
  box-shadow: 0 4px 16px rgb(0 0 0 / 25%);
}

@media (prefers-reduced-motion: reduce) {
  .segment {
    transition: none;
  }
}

/*
 * Phones: one short row, however long the title. The back link is its arrow and "Fix speakers"
 * is "Fix", their full words kept for screen readers, so the part's name has room.
 */
@media (max-width: 480px) {
  .reader-head {
    padding-block: 8px;
  }

  .top {
    gap: 8px;
    margin-bottom: 0;
  }

  .back {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    min-height: 44px;
    font-size: 1.25rem;
    text-decoration: none;
  }

  .phone-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .part-nav {
    flex: 1;
    min-width: 0;
    gap: 4px;
  }

  .part-step {
    width: 36px;
  }

  .top-actions {
    flex: none;
    gap: 12px;
  }

  .banner {
    margin: 8px 0 0;
  }
}
</style>
