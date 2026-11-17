<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { Character, Part, VoiceSettings } from '@/format/types';
import { voicesForLang, type DeviceVoice } from '@/playback/engine';
import { getAppDb } from '@/storage/db';
import { DEFAULT_LOCALE, getStory, updateStory } from '@/storage/stories';
import {
  matchVoicesInStory,
  mergeCharactersInStory,
  recordCastChange,
  undoCastChange,
  type CastUndo,
  repickVoiceInStory,
  setTraitsInStory,
  setVoiceInStory,
} from '@/storage/cast';
import { normaliseName } from '@/analysis/castMatch';
import {
  castUsage,
  filterCast,
  findNameClash,
  findTypedNameOwner,
  linesOf,
  type LineRef,
  partsToldByAll,
  renameCharacter,
  setAliases,
} from '@/cast/castOps';
import { clashesInVoice } from '@/cast/assignVoices';
import { resolveVoice } from '@/cast/resolveVoice';
import { cleanTraits, TRAIT_KEYS, withTraits } from '@/cast/traits';
import { voiceProfile } from '@/cast/voiceProfile';
import CastFilter from '../components/CastFilter.vue';
import VoiceSheet from '../components/VoiceSheet.vue';
import MergeSheet from '../components/MergeSheet.vue';
import ActionsMenu from '../components/ActionsMenu.vue';
import { pairKey, suggestMerges } from '@/cast/suggestMerges';
import { addNotSame, getNotSame, removeNotSame } from '@/storage/notSame';
import CharacterEditor from '../components/CharacterEditor.vue';
import CharacterTraits from '../components/CharacterTraits.vue';
import { useLiveQuery } from '../composables/useLiveQuery';
import { getEngine, usePlayer } from '../composables/usePlayer';
import { speakerColorIndex, speakerTint } from '../speakerColors';

const props = defineProps<{ id: string }>();
const db = getAppDb();
const { player } = usePlayer(props.id);

const { data: story, loaded: storyLoaded } = useLiveQuery(
  () => getStory(db, props.id),
  [() => props.id],
);
/**
 * The story's parts, as a key. The analyses and parts are read again when it changes, not on
 * every save of the story: its place is saved every few seconds while it plays.
 */
const partIdsKey = computed(() => story.value?.partIds.join('\n'));
const { data: analyses, error: analysesError } = useLiveQuery(async () => {
  const ids = story.value?.partIds;
  return ids && db.analyses.bulkGet(ids);
}, [partIdsKey]);
/**
 * The parts' text is only for an open card's lines and samples and for the merge sheet, so it is
 * read once the list is on screen (or as soon as one of those wants it), not before.
 */
const partsWanted = ref(false);
const { data: parts } = useLiveQuery(async () => {
  const ids = story.value?.partIds;
  if (!partsWanted.value || !ids) return undefined;
  return (await db.parts.bulkGet(ids)).filter((p): p is Part => p !== undefined);
}, [partIdsKey, partsWanted]);
const partsById = computed(() => new Map((parts.value ?? []).map((p) => [p.id, p])));
/** Asks for the parts' text now, for what is about to show or play it; resolves once it is read. */
function readParts(): Promise<void> {
  partsWanted.value = true;
  if (parts.value || !story.value) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(parts, (read) => {
      if (!read) return;
      stop();
      resolve();
    });
  });
}

/**
 * The cast, the same array for as long as it is unchanged, so what is worked out from it isn't
 * worked out again each time the story is saved for another reason.
 */
const cast = computed<Character[]>((previous) => {
  const next = story.value?.cast ?? [];
  return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
});
const narratorId = computed(() => story.value?.narratorId);
/** The page reads the story only through these, so a save that changes neither redraws nothing. */
const storyTitle = computed(() => story.value?.title ?? 'Story');
const storyMissing = computed(() => storyLoaded.value && !story.value);

/** Pairs the user said are not one person; kept on this device for the story. */
const notSame = ref(new Set<string>());
const notSameLoaded = ref(false);
onMounted(async () => {
  try {
    notSame.value = await getNotSame(props.id);
  } finally {
    notSameLoaded.value = true;
  }
});

/** Until the cast and its line counts are known, a placeholder list stands in for it. */
const loading = computed(
  () =>
    !storyLoaded.value ||
    (!!story.value && !analyses.value && !analysesError.value) ||
    !notSameLoaded.value,
);
// Once the list is on screen, the parts' text is read in the background.
watch(
  loading,
  (still) => {
    if (still || partsWanted.value) return;
    void nextTick(() => requestAnimationFrame(() => setTimeout(() => (partsWanted.value = true))));
  },
  { immediate: true },
);

/** Segment count per character across all analysed parts. */
const usage = computed(() => analyses.value && castUsage(analyses.value));
/** Parts each character tells, i.e. reads most of the narration of. */
const told = computed(() => {
  const narrator = narratorId.value;
  return narrator && analyses.value
    ? partsToldByAll(analyses.value, narrator)
    : new Map<string, number>();
});

/** Members whose "Lines" list is open: a list is only worked out while it is shown. */
const linesOpen = ref(new Set<string>());
/** How many of a member's lines are listed; "Show more" raises it. */
const linesShown = ref(new Map<string, number>());
const LINES_PAGE = 50;
/** A member with this many lines or fewer shows them open in its card: they decide a merge. */
const SHORT_LINES = 3;
function onLinesToggle(c: Character, event: Event) {
  const next = new Set(linesOpen.value);
  if ((event.target as HTMLDetailsElement).open) {
    next.add(c.id);
    void readParts();
  } else next.delete(c.id);
  linesOpen.value = next;
}
function showMoreLines(c: Character) {
  const next = new Map(linesShown.value);
  next.set(c.id, (next.get(c.id) ?? LINES_PAGE) + LINES_PAGE);
  linesShown.value = next;
}
/**
 * Each open member's lines with their part's title and text. Lines of a part whose analysis is
 * out of date are left out: the reader doesn't show them, so a link would lead nowhere.
 */
/** The analyses that still fit their part's text: an edited part's old one is left out. */
const currentAnalyses = computed(() => {
  const byId = partsById.value;
  return (analyses.value ?? []).filter((a) => a && byId.get(a.partId)?.textHash === a.textHash);
});
/** Each open list's lines: how many there are, and the ones shown, with their text. */
const memberLines = computed(() => {
  const lists = new Map<string, { total: number; shown: ShownLine[] }>();
  // Until the parts' text is read, a list waits rather than say its lines need analysing again.
  if (!parts.value) return lists;
  const byId = partsById.value;
  const current = currentAnalyses.value;
  // A member with a few lines shows them open in its card, so they are worked out when it is.
  const ids = new Set(linesOpen.value);
  if (openId.value && (usage.value?.get(openId.value) ?? 0) <= SHORT_LINES) ids.add(openId.value);
  for (const id of ids) {
    const lines = linesOf(current, id);
    // Only the lines shown are cut out of their part: the narrator's can run to thousands.
    const shown = lines.slice(0, linesShown.value.get(id) ?? LINES_PAGE).map((l) => {
      const part = byId.get(l.partId)!;
      return {
        ...l,
        partTitle: part.title,
        text: excerpt(part.text.slice(l.segment.start, l.segment.end)),
      };
    });
    lists.set(id, { total: lines.length, shown });
  }
  return lists;
});
type ShownLine = LineRef & { partTitle: string; text: string };
function excerpt(text: string, max = 140): string {
  const t = text.replace(/\s+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** A short note where a change was made: in a member's card, or by the page's own buttons (PAGE). */
interface Note {
  text: string;
  error?: boolean;
}
const PAGE = 'page';
const notes = ref(new Map<string, Note>());
/** Says `text` at `at`, or clears what was said there. */
/** How long a note saying what was done stays; a failure stays until the next change there. */
const NOTE_MS = 4000;
const noteTimers = new Map<string, ReturnType<typeof setTimeout>>();
function note(at: string, text?: string, error = false) {
  // A change made from a row, the ⋯ menu or the duplicates panel: the card isn't open to say it.
  if (text && at !== PAGE && openId.value !== at) {
    note(at);
    return showSnack({ text });
  }
  const next = new Map(notes.value);
  if (text) next.set(at, { text, error });
  else next.delete(at);
  notes.value = next;
  clearTimeout(noteTimers.get(at));
  noteTimers.delete(at);
  if (text && !error)
    noteTimers.set(
      at,
      setTimeout(() => note(at), NOTE_MS),
    );
}
/** A name refused because another member already has it, shown in member `id`'s editor. */
const nameClash = ref<{ id: string; name: string }>();
/** Why, worded from the cast as it is now: it goes once no other member has the name. */
const clashText = computed(() => {
  const clash = nameClash.value;
  const s = story.value;
  if (!clash || !s) return undefined;
  const editing = s.cast.find((c) => c.id === clash.id);
  const owner = findTypedNameOwner(s.cast, clash.name, s.narratorId, clash.id);
  return editing && owner ? clashMessage(clash.name, editing, owner) : undefined;
});

/** The device's voices, asked for once: a change made before they are listed waits for them. */
const voicesReady = getEngine().listVoices();
const deviceVoices = ref<DeviceVoice[]>([]);
/** Until the voices are listed, a member's voice is shown as it is stored, not as "Default voice". */
const voicesLoaded = ref(false);
onMounted(async () => {
  deviceVoices.value = await voicesReady;
  voicesLoaded.value = true;
});
/** The voices the voice sheet offers: the device's for the story's language, else all of them. */
const offeredVoices = computed(() => {
  const forLang = voicesForLang(deviceVoices.value, DEFAULT_LOCALE);
  return forLang.length ? forLang : deviceVoices.value;
});
/** What a member's voice button says: "Zira · female · US", or the default, or a missing voice. */
function voiceTitle(c: Character): { title: string; tags: string[]; full: string } {
  const name = c.voice.voiceName;
  if (!name) return { title: 'Device default', tags: [c.voice.lang], full: '' };
  const device = deviceVoices.value.find((v) => v.name === name);
  if (!device) return { title: shortVoiceName(name), tags: ['not on this device'], full: name };
  const region = device.lang.split(/[-_]/u)[1]?.toUpperCase();
  const tags = [
    voiceProfile(device).gender,
    region === 'GB' ? 'UK' : region,
    device.network ? 'online' : undefined,
  ].filter((t): t is string => !!t);
  return { title: shortVoiceName(name), tags, full: name === shortVoiceName(name) ? '' : name };
}

const colors = computed(() => speakerColorIndex(cast.value));

/** How each character's voice plays on this device (a missing voice is substituted). */
const resolved = computed(
  () => new Map(cast.value.map((c) => [c.id, resolveVoice(c.voice, deviceVoices.value)])),
);

/**
 * Who each member can't be told from on this device: the same voice heard at a pitch within 0.05,
 * the combinations automatic picks never give (clashesWithNarrator). The narrator's card says
 * nothing; those near it say so on theirs. Each voice is resolved once (resolved) and only members
 * heard with the same voice are compared: comparing every pair afresh took seconds on a big cast.
 */
const soundAlikes = computed(() => {
  const members = cast.value;
  const spoken = (c: Character) => resolved.value.get(c.id)?.voiceName ?? c.voice.voiceName;
  const byVoice = new Map<string | undefined, Character[]>();
  for (const c of members) {
    const name = spoken(c);
    const same = byVoice.get(name);
    if (same) same.push(c);
    else byVoice.set(name, [c]);
  }
  return new Map(
    members.map((c) => {
      if (c.role === 'narrator') return [c.id, []];
      const name = spoken(c);
      const same = byVoice.get(name) ?? [];
      return [c.id, same.filter((o) => o.id !== c.id && clashesInVoice(c.voice, o.voice, name))];
    }),
  );
});

const linesOfMember = (c: Character) => usage.value?.get(c.id) ?? 0;

type SortMode = 'lines' | 'name' | 'first';
const SORTS: Array<{ value: SortMode; label: string }> = [
  { value: 'lines', label: 'Most lines' },
  { value: 'name', label: 'A–Z' },
  { value: 'first', label: 'First heard' },
];
const sortMode = ref<SortMode>('lines');
/** Where each member is first heard: its first line's place across the parts, in story order. */
const firstHeard = computed(() => {
  const at = new Map<string, number>();
  let place = 0;
  for (const a of analyses.value ?? []) {
    for (const s of a?.segments ?? []) if (!at.has(s.speakerId)) at.set(s.speakerId, place++);
  }
  return at;
});
const byName = new Intl.Collator('en', { sensitivity: 'base' });
function bySort(a: Character, b: Character): number {
  if (sortMode.value === 'name') return byName.compare(a.name, b.name);
  if (sortMode.value === 'first') {
    const never = Number.MAX_SAFE_INTEGER;
    return (firstHeard.value.get(a.id) ?? never) - (firstHeard.value.get(b.id) ?? never);
  }
  return linesOfMember(b) - linesOfMember(a);
}

const ROLE_ORDER = { narrator: 0, unknown: 2, character: 1 } as const;
/** A cast longer than this folds its minor characters (MINOR_LINES or fewer) behind one row. */
const FOLD_OVER = 6;
const MINOR_LINES = 2;
const isMinor = (c: Character) => c.role === 'character' && linesOfMember(c) <= MINOR_LINES;
/** The minor characters folded away, if the cast is long and has major ones to show. */
const folded = computed(() => {
  const characters = cast.value.filter((c) => c.role === 'character');
  const minor = characters.filter(isMinor);
  const fold =
    characters.length > FOLD_OVER && minor.length > 1 && minor.length < characters.length;
  return new Set(fold ? minor.map((c) => c.id) : []);
});
/** By role, then folded members after the rest, then by the chosen order. */
const sorted = computed(() =>
  [...cast.value].sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      Number(folded.value.has(a.id)) - Number(folded.value.has(b.id)) ||
      bySort(a, b),
  ),
);

type FilterKey = 'few' | 'substituted' | 'alike' | 'traits';
const FILTERS: Array<{ key: FilterKey; label: string; test: (c: Character) => boolean }> = [
  { key: 'few', label: `${MINOR_LINES} lines or fewer`, test: isMinor },
  {
    key: 'substituted',
    label: 'Substituted',
    test: (c) => !!resolved.value.get(c.id)?.substituted,
  },
  { key: 'alike', label: 'Sound alike', test: (c) => !!soundAlikes.value.get(c.id)?.length },
  {
    key: 'traits',
    label: 'No traits',
    test: (c) => c.role !== 'unknown' && TRAIT_KEYS.every((k) => cleanTraits(c)[k] === undefined),
  },
];
const filter = ref<FilterKey>();
/** The filters with someone to show, each with how many. */
const filterChips = computed(() =>
  FILTERS.map((f) => ({ ...f, count: sorted.value.filter(f.test).length })).filter(
    (f) => f.count > 0 || f.key === filter.value,
  ),
);
function toggleFilter(key: FilterKey) {
  filter.value = filter.value === key ? undefined : key;
}

/** The one member whose controls are open; the others show as a row. */
const openId = ref<string>();
/**
 * The members whose card has been opened. A card's controls are only built once it is first
 * opened, then kept, so what is typed in one outlives closing it or a search.
 */
const opened = ref(new Set<string>());
function open(id: string | undefined) {
  openId.value = id;
  // Its card shows one of the member's lines, so their text is wanted now.
  if (id) void readParts();
  if (id && !opened.value.has(id)) opened.value = new Set(opened.value).add(id);
}
function toggleOpen(c: Character) {
  open(openId.value === c.id ? undefined : c.id);
}
const minorOpen = ref(false);
/** Opens another member's card and brings it into view, unfolding it if need be. */
function goToMember(c: Character) {
  open(c.id);
  if (folded.value.has(c.id)) minorOpen.value = true;
  void nextTick(() => {
    const row = document.getElementById(`member-${c.id}`);
    row?.scrollIntoView({ block: 'nearest' });
    row?.querySelector<HTMLButtonElement>('.toggle')?.focus();
  });
}

/** "Microsoft Zira - English (United States)" → "Zira"; other names stay as they are. */
function shortVoiceName(name: string | undefined): string {
  if (!name) return 'Default voice';
  return name.replace(/^(Microsoft|Google|Apple)\s+/u, '').replace(/\s+[-(].*$/u, '') || name;
}
/** The page's sections, one per role, each saying what its members do. */
const GROUPS = [
  {
    role: 'narrator',
    title: 'Narrator',
    note: 'Reads the story, unless a part or passage is told by a character.',
  },
  { role: 'character', title: 'Characters', note: 'Each reads their own lines.' },
  {
    role: 'unknown',
    title: 'Unattributed',
    note: 'Reads the lines nobody was found to say. Fix them in the reader, or give them all to someone under “Edit names or merge”.',
  },
] as const;
/** Some part has been analysed, so an empty cast means none were found rather than not yet. */
const analysed = computed(() => (analyses.value ?? []).some(Boolean));

const query = ref('');
const filtering = computed(() => !!query.value.trim() || !!filter.value);
/** Hidden, not removed, so a card's open editor and what is typed in it outlive a search. */
const shown = computed(() => {
  const test = FILTERS.find((f) => f.key === filter.value)?.test ?? (() => true);
  return new Set(
    filterCast(sorted.value, query.value)
      .filter(test)
      .map((c) => c.id),
  );
});
/** A member's row is on the page: it matches, and isn't folded away (a search unfolds all). */
const visible = (c: Character) =>
  shown.value.has(c.id) && (filtering.value || minorOpen.value || !folded.value.has(c.id));
const groups = computed(() =>
  GROUPS.map((g) => {
    const members = sorted.value.filter((c) => c.role === g.role);
    const fold = members.filter((c) => folded.value.has(c.id));
    return {
      ...g,
      members,
      shown: members.filter((c) => shown.value.has(c.id)).length,
      /** The first folded member, before which the fold's row goes. */
      foldAt: fold[0]?.id,
      foldNames: fold.map((c) => c.name),
    };
  }),
);

/**
 * Saves a change to the cast and has the player take it up. A failure is said where the change
 * was made (`at`), and what was said there before goes. Tells whether it was saved.
 */
async function changeCast(change: () => Promise<void>, at: string): Promise<boolean> {
  try {
    await change();
    note(at);
    player.castChanged();
    return true;
  } catch (e) {
    note(at, e instanceof Error ? e.message : String(e), true);
    return false;
  }
}

/**
 * The last change that can be undone, and what the bar at the bottom says of it. Shallow: the
 * undo is written back to IndexedDB as it is, and a reactive proxy of it can't be stored.
 */
const snack = shallowRef<Snack>();
interface Snack {
  text: string;
  undo?: () => Promise<void>;
}
/**
 * A change that can be undone: saved as changeCast does, then offered in the bar with `text`.
 * Tells whether it was saved, and whether it changed anything.
 */
async function withUndo(
  text: string,
  at: string,
  change: () => Promise<void>,
): Promise<{ ok: boolean; changed: boolean }> {
  let undo: CastUndo | undefined;
  const ok = await changeCast(async () => {
    undo = await recordCastChange(db, props.id, change);
  }, at);
  const recorded = undo;
  if (ok && recorded) {
    showSnack({
      text,
      undo: async () => {
        await undoCastChange(db, recorded);
        nameClash.value = undefined;
        player.castChanged();
      },
    });
  }
  return { ok, changed: !!recorded };
}
/** How long the bar stays; pointing at it or focusing it holds it, so Undo can't slip away. */
const SNACK_MS = 5000;
let snackTimer: ReturnType<typeof setTimeout> | undefined;
let snackHeld = false;
function showSnack(next?: Snack) {
  snack.value = next;
  armSnack();
}
function armSnack() {
  clearTimeout(snackTimer);
  if (snack.value && !snackHeld) snackTimer = setTimeout(() => showSnack(), SNACK_MS);
}
function holdSnack(held: boolean) {
  snackHeld = held;
  armSnack();
}
onBeforeUnmount(() => {
  clearTimeout(snackTimer);
  clearTimeout(flashTimer);
  noteTimers.forEach((t) => clearTimeout(t));
});
async function undoLast() {
  const undo = snack.value?.undo;
  if (!undo) return;
  try {
    await undo();
    showSnack({ text: 'Undone.' });
  } catch (e) {
    showSnack({ text: e instanceof Error ? e.message : String(e) });
  }
}

/** A member just merged into, lit for a moment so the eye finds it. */
const flashId = ref<string>();
let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flash(id: string) {
  flashId.value = id;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flashId.value = undefined), 1600);
}

/** Members whose last change of traits left a voice set by hand as it was. */
const voiceKept = ref(new Set<string>());
function noteVoiceKept(id: string, kept: boolean) {
  if (voiceKept.value.has(id) === kept) return;
  const next = new Set(voiceKept.value);
  if (kept) next.add(id);
  else next.delete(id);
  voiceKept.value = next;
}

/** A voice, pitch or speed chosen by hand: automatic re-picks leave it alone from now on. */
async function setVoice(
  character: Character,
  changes: Partial<Pick<VoiceSettings, 'voiceName' | 'lang' | 'pitch' | 'rate'>>,
): Promise<boolean> {
  const ok = await changeCast(async () => {
    await setVoiceInStory(db, props.id, character.id, changes);
    // The voice is now the one the user wants for the traits as they are.
    noteVoiceKept(character.id, false);
  }, character.id);
  if (ok) await replay(character.id);
  return ok;
}

type Dial = 'pitch' | 'rate';
/** A pitch or speed being dragged, shown in its label before it is saved on release. */
const drafts = ref(new Map<string, number>());
const draftKey = (c: Character, dial: Dial) => `${c.id}:${dial}`;
function dialValue(c: Character, dial: Dial): number {
  return drafts.value.get(draftKey(c, dial)) ?? c.voice[dial];
}
function onDialInput(c: Character, dial: Dial, event: Event) {
  const next = new Map(drafts.value);
  next.set(draftKey(c, dial), Number((event.target as HTMLInputElement).value));
  drafts.value = next;
}
async function onDialChange(c: Character, dial: Dial, event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  // A refused save leaves the stored value, which the label then shows again.
  if (!(await setVoice(c, { [dial]: value }))) dropDraft(c.id, dial);
}
function dropDraft(id: string, dial: Dial) {
  const next = new Map(drafts.value);
  next.delete(`${id}:${dial}`);
  drafts.value = next;
}
// A draft goes once the cast holds what it shows, so the label never jumps back while saving.
watch(
  () => story.value?.cast,
  (members) => {
    for (const c of members ?? []) {
      for (const dial of ['pitch', 'rate'] as const) {
        if (drafts.value.get(draftKey(c, dial)) === c.voice[dial]) dropDraft(c.id, dial);
      }
    }
  },
);
/** "Normal" at 1, else the factor: "1.10×". */
function dialText(value: number): string {
  return Math.abs(value - 1) < 0.001 ? 'Normal' : `${value.toFixed(2)}×`;
}

type TraitChanges = Parameters<typeof setTraitsInStory>[3];

/** Sets or clears traits; the member's voice follows them unless it was set by hand. */
async function changeTraits(character: Character, changes: TraitChanges) {
  // Choosing the value a trait already has changes nothing, so there is nothing to say then.
  const [before, after] = [cleanTraits(character), cleanTraits(withTraits(character, changes))];
  const changed = TRAIT_KEYS.some((key) => before[key] !== after[key]);
  let voiceChanged = false;
  await changeCast(async () => {
    const voices = await voicesReady;
    const { repicked } = await setTraitsInStory(db, props.id, character.id, changes, voices);
    if (changed) noteVoiceKept(character.id, !repicked);
    voiceChanged = repicked;
  }, character.id);
  // A new voice for the new traits is played; a kept one sounds as before.
  if (voiceChanged) await replay(character.id);
}

/** Picks a member's voice again from its traits, also when it was set by hand. */
async function repickVoice(character: Character) {
  const { ok } = await withUndo(
    `${character.name}’s voice picked again.`,
    character.id,
    async () => {
      await repickVoiceInStory(db, props.id, character.id, await voicesReady);
      noteVoiceKept(character.id, false);
    },
  );
  if (ok) await replay(character.id);
}

const hasCharacters = computed(() => cast.value.some((c) => c.role === 'character'));
/** What "Match voices to traits" does, counted from the cast as it is before it. */
const matchText = computed(() => {
  const characters = cast.value.filter((c) => c.role === 'character');
  const kept = characters.filter((c) => c.voice.manual).length;
  const repicked = characters.length - kept;
  if (repicked === 0)
    return 'Missing traits guessed from names. Every voice was set by hand, so none changed.';
  const stay =
    kept === 0 ? '' : ` The ${count(kept, 'voice')} set by hand ${kept === 1 ? 'stays' : 'stay'}.`;
  return `${count(repicked, 'voice')} picked again to suit traits guessed from names.${stay}`;
});
async function matchVoices() {
  const { ok, changed } = await withUndo(matchText.value, PAGE, async () =>
    matchVoicesInStory(db, props.id, await voicesReady),
  );
  if (ok && !changed) note(PAGE, 'Every voice already suits its traits.');
}

/** A preview's line is one of the member's own, long enough to hear the voice, short enough to wait for. */
const SAMPLE_MIN = 40;
const SAMPLE_MAX = 140;
const SAMPLES_KEPT = 20;
/** A line as it is read aloud: no quote marks or dangling comma, cut after a sentence if long. */
function speakable(raw: string): string {
  let t = raw.replace(/\s+/gu, ' ').trim();
  t = t.replace(/^[“”"‘’'—–-]+\s*/u, '').replace(/[\s“”"‘’'—–,;:-]+$/u, '');
  if (t.length <= SAMPLE_MAX) return t;
  const head = t.slice(0, SAMPLE_MAX);
  const sentence = head.search(/[.!?…](?=[^.!?…]*$)/u);
  if (sentence >= SAMPLE_MIN - 1) return head.slice(0, sentence + 1);
  return head.slice(0, head.lastIndexOf(' ')).replace(/[,;:]$/u, '');
}
/** The lines a preview of `c` can play, in story order: those of a good length, else the longest. */
function samplesOf(c: Character): string[] {
  const fit: string[] = [];
  /** The first of the longest lines of 3 words or more, for when none is long enough. */
  let longest = '';
  // Stops at SAMPLES_KEPT: the narrator alone can have tens of thousands of lines.
  outer: for (const a of currentAnalyses.value) {
    const part = a && partsById.value.get(a.partId);
    if (!a || !part) continue;
    for (const segment of a.segments) {
      if (segment.speakerId !== c.id) continue;
      const text = speakable(part.text.slice(segment.start, segment.end));
      if (text.length >= SAMPLE_MIN) {
        fit.push(text);
        if (fit.length === SAMPLES_KEPT) break outer;
      } else if (text.length > longest.length && text.split(' ').length >= 3) {
        longest = text;
      }
    }
  }
  return fit.length ? fit : longest ? [longest] : [];
}
/** Which of its samples each member plays; "Next line" moves it on. */
const sampleAt = ref(new Map<string, number>());
function sampleOf(c: Character, samples = samplesOf(c)): string {
  if (!samples.length) return `Hello, I am ${c.name}.`;
  return samples[(sampleAt.value.get(c.id) ?? 0) % samples.length]!;
}
/** The open member's samples, worked out once per change rather than once per use. */
const openSamples = computed(() => {
  const c = cast.value.find((m) => m.id === openId.value);
  return c ? samplesOf(c) : [];
});

/** The member whose preview is being spoken. */
const speaking = ref<string>();
let previewRun = 0;
async function preview(character: Character, voice: VoiceSettings = character.voice) {
  const run = ++previewRun;
  speaking.value = character.id;
  try {
    // One of the member's own lines, not "Hello, I am …" because the text isn't read yet.
    await readParts();
    if (run !== previewRun) return;
    await player.preview(sampleOf(character), voice);
  } finally {
    // A later preview, or Stop, has taken over: what it shows stays.
    if (run === previewRun) speaking.value = undefined;
  }
}
async function togglePreview(character: Character) {
  if (speaking.value !== character.id) return preview(character);
  previewRun++;
  speaking.value = undefined;
  await player.stop();
}

/** The member whose voice sheet is open. */
const sheetFor = ref<string>();
const sheetMember = computed(() => cast.value.find((c) => c.id === sheetFor.value));
function closeSheet() {
  const id = sheetFor.value;
  sheetFor.value = undefined;
  // Back to the button that opened it, as a dialog does.
  if (id) void nextTick(() => document.getElementById(`voice-${id}`)?.focus());
}
/** A voice chosen by hand in the voice sheet; it can be undone. */
async function useVoice(name: string) {
  const member = sheetMember.value;
  closeSheet();
  if (!member) return;
  const voice = deviceVoices.value.find((v) => v.name === name);
  const changes = voice ? { voiceName: voice.name, lang: voice.lang } : { voiceName: undefined };
  const title = voice ? shortVoiceName(voice.name) : 'the device default';
  const { ok } = await withUndo(`${member.name} now speaks with ${title}.`, member.id, async () => {
    await setVoiceInStory(db, props.id, member.id, changes);
    noteVoiceKept(member.id, false);
  });
  if (ok) await replay(member.id);
}
/** Plays the sheet's member in another voice, keeping its pitch and speed, without saving it. */
async function audition(name: string) {
  const member = sheetMember.value;
  if (!member) return;
  const device = deviceVoices.value.find((v) => v.name === name);
  const voice = {
    ...member.voice,
    voiceName: device?.name,
    lang: device?.lang ?? member.voice.lang,
  };
  if (!device) delete voice.voiceName;
  await preview(member, voice);
}
const stopPreview = async () => {
  previewRun++;
  speaking.value = undefined;
  await player.stop();
};
function nextSample(character: Character) {
  const next = new Map(sampleAt.value);
  next.set(character.id, (next.get(character.id) ?? 0) + 1);
  sampleAt.value = next;
  void preview(character);
}
/** Each change to a voice plays it, so it is heard without reaching for the preview button. */
const playOnChange = ref(true);
async function replay(id: string) {
  if (!playOnChange.value) return;
  const member = (await getStory(db, props.id))?.cast.find((c) => c.id === id);
  if (member) await preview(member);
}

/** Saves a member's names; tells whether they were saved (or had nothing to save). */
async function saveNames(
  character: Character,
  changes: { name: string; aliases: string[] },
): Promise<boolean> {
  const s = story.value;
  if (!s) return false;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (changes.name.trim() === character.name && same(changes.aliases, character.aliases)) {
    nameClash.value = undefined;
    note(character.id, 'No changes to save.');
    return true;
  }
  // A name, or one of the other names, that someone else already has is refused.
  const clash = findNameClash(s.cast, character.id, changes, s.narratorId);
  if (clash) {
    nameClash.value = { id: character.id, name: clash.name };
    return false;
  }
  nameClash.value = undefined;
  const renamed = renameCharacter(s.cast, character.id, changes.name);
  if (!renamed.ok) {
    note(character.id, renamed.reason, true);
    return false;
  }
  // Keep the alias renameCharacter adds for the old name alongside the edited list.
  const added = renamed.value
    .find((c) => c.id === character.id)!
    .aliases.filter((a) => !character.aliases.includes(a));
  const aliases = [...new Set([...changes.aliases, ...added])];
  const result = setAliases(renamed.value, character.id, aliases);
  if (!result.ok) {
    note(character.id, result.reason, true);
    return false;
  }
  const saved = await changeCast(() => updateStory(db, s.id, { cast: result.value }), character.id);
  if (saved) note(character.id, 'Names saved.');
  return saved;
}

/** "Rename" in a member's ⋯ menu; a refused name opens its card, where the editor says why. */
async function renameFromMenu(character: Character, name: string) {
  const saved = await saveNames(character, { name, aliases: character.aliases });
  // A refused name is explained in the bar: the card, where the editor would say it, is closed.
  if (!saved && nameClash.value?.id === character.id) {
    const why = clashText.value;
    nameClash.value = undefined;
    if (why) showSnack({ text: why });
  }
  await nextTick();
  document.querySelector<HTMLElement>(`#member-${character.id} .member-menu summary`)?.focus();
}

/**
 * Merges `character` into `intoId`. With `voiceOf` its own id, the one left speaks with the
 * voice of the one removed (chosen in the merge sheet); both are undone together.
 */
async function merge(character: Character, intoId: string, voiceOf = intoId) {
  const into = story.value?.cast.find((c) => c.id === intoId);
  if (!into) return;
  const lines = linesOfMember(character);
  const moved = lines ? ` · ${count(lines, 'line')} moved` : '';
  const keepsVoice = voiceOf === character.id;
  const withVoice = keepsVoice ? `, with ${character.name}’s voice` : '';
  const text =
    character.role === 'character'
      ? `${character.name} merged into ${into.name}${withVoice}${moved}.`
      : `${character.name}’s lines given to ${into.name}${moved}.`;
  const { voiceName, lang, pitch, rate } = character.voice;
  const voice: VoiceSettings = { lang, pitch, rate, ...(voiceName ? { voiceName } : {}) };
  const { ok } = await withUndo(text, character.id, () =>
    mergeCharactersInStory(db, props.id, character.id, intoId, keepsVoice ? { voice } : {}),
  );
  if (!ok) return;
  // A refused name's message described the cast before this merge, often the merge it suggested.
  nameClash.value = undefined;
  flash(into.id);
  goToMember(into);
}

/** "Not a character" (⋯ menu): its lines go to the unknown speaker, its names to nobody. */
async function notACharacter(character: Character) {
  const unknown = story.value?.cast.find((c) => c.role === 'unknown');
  if (!unknown) return;
  const lines = linesOfMember(character);
  const moved = lines ? ` · ${count(lines, 'line')} now read by ${unknown.name}` : '';
  // Its row goes: focus moves to the row after it, or before it.
  const rows = [...document.querySelectorAll<HTMLElement>('li.card.character')].filter(
    (r) => r.offsetParent !== null || r.id === `member-${character.id}`,
  );
  const at = rows.findIndex((r) => r.id === `member-${character.id}`);
  const neighbour = rows[at + 1] ?? rows[at - 1];
  const { ok } = await withUndo(
    `${character.name} taken out of the cast${moved}.`,
    character.id,
    () => mergeCharactersInStory(db, props.id, character.id, unknown.id, { notACharacter: true }),
  );
  if (ok) void nextTick(() => neighbour?.querySelector<HTMLElement>('.toggle')?.focus());
}
const unknownName = computed(
  () => cast.value.find((c) => c.role === 'unknown')?.name ?? 'the unknown speaker',
);

/** The merge sheet ("Same person as…") and the character it is for. */
const mergeSheetFor = ref<string>();
const mergeMember = computed(() => cast.value.find((c) => c.id === mergeSheetFor.value));
/** What had focus when the sheet opened, to give it back on close. */
let mergeOpener: HTMLElement | undefined;
function openMergeSheet(c: Character) {
  void readParts();
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  // A menu item is hidden once its menu closes: its menu's ⋯ button takes the focus back.
  mergeOpener =
    active?.closest('.member-menu')?.querySelector<HTMLElement>('summary') ?? active ?? undefined;
  mergeSheetFor.value = c.id;
}
function closeMergeSheet() {
  const id = mergeSheetFor.value;
  mergeSheetFor.value = undefined;
  // Back to what opened it; from the ⋯ menu, which has closed, to the menu's button.
  void nextTick(() => {
    const shown =
      mergeOpener?.isConnected &&
      !mergeOpener.closest('details:not([open]) > :not(summary)') &&
      mergeOpener.offsetParent !== null;
    const target = shown
      ? mergeOpener
      : document.querySelector<HTMLElement>(`#member-${id} .member-menu summary`);
    target?.focus();
  });
}
function onSheetMerge(choice: { fromId: string; intoId: string; voiceOf: string }) {
  const from = story.value?.cast.find((c) => c.id === choice.fromId);
  mergeSheetFor.value = undefined;
  if (from) void merge(from, choice.intoId, choice.voiceOf);
}
/** Each member's first line, found in one pass while the merge sheet is open. */
const firstLines = computed(() => {
  const first = new Map<string, string>();
  if (!mergeSheetFor.value) return first;
  for (const a of currentAnalyses.value) {
    const part = a && partsById.value.get(a.partId);
    if (!a || !part) continue;
    for (const s of a.segments) {
      if (!first.has(s.speakerId)) first.set(s.speakerId, part.text.slice(s.start, s.end));
    }
  }
  return first;
});
/** A member's first line, as read aloud (no quote marks), for comparing two in the merge sheet. */
function firstLineOf(c: Character): string {
  const line = firstLines.value.get(c.id);
  return line ? speakable(line) : '';
}
function voiceWords(c: Character): string {
  const t = voiceTitle(c);
  return [t.title, ...t.tags].join(' · ');
}

/** The way round chosen with "Swap", by pair: who merges (its id). */
const chosenFrom = ref(new Map<string, string>());
const SUGGESTIONS_SHOWN = 5;
const allSuggestions = ref(false);
/** Characters that may be one person (suggestMerges), each the way round it would merge. */
const suggestions = computed(() => {
  // Worked out once all it depends on is in, rather than again as each part of it arrives.
  if (loading.value || !usage.value) return [];
  const byId = new Map(cast.value.map((c) => [c.id, c]));
  return suggestMerges(cast.value, usage.value, notSame.value).flatMap((s) => {
    const key = pairKey(s.fromId, s.intoId);
    const turned = chosenFrom.value.get(key) === s.intoId;
    const [fromId, intoId] = turned ? [s.intoId, s.fromId] : [s.fromId, s.intoId];
    const [from, into] = [byId.get(fromId), byId.get(intoId)];
    return from && into ? [{ key, from, into, reason: s.reason }] : [];
  });
});
type Suggestion = (typeof suggestions.value)[number];
function swap(s: Suggestion) {
  const next = new Map(chosenFrom.value);
  next.set(s.key, s.into.id);
  chosenFrom.value = next;
}
/** "Not the same": not suggested again (Undo takes it back); focus moves to the next one. */
async function notTheSame(s: Suggestion, index: number) {
  notSame.value = await addNotSame(props.id, s.key);
  showSnack({
    text: `${s.from.name} and ${s.into.name} won’t be suggested again.`,
    undo: async () => {
      notSame.value = await removeNotSame(props.id, s.key);
    },
  });
  await nextTick();
  const rows = document.querySelectorAll<HTMLElement>('.dupes .dupe');
  const next = rows[index] ?? rows[index - 1];
  (
    next?.querySelector<HTMLElement>('button') ?? document.getElementById('group-character')
  )?.focus();
}

/**
 * Why a name can't be used (someone has it, as their name or as one of their other names), and
 * the merge to use instead from the editor the user is in: only a character's editor has "Same
 * person as…". Nobody is the same person as the unknown speaker, so a name the user gave it (a
 * new name, or a name merged into it or typed under its other names) is taken off it first.
 */
function clashMessage(name: string, editing: Character, owner: Character): string {
  const ownName = normaliseName(owner.name) === normaliseName(name);
  const who = ownName ? '' : ` as “${owner.name}”`;
  const taken = `“${name.trim()}” is already in the cast${who}.`;
  if (owner.role === 'unknown') {
    const free = ownName
      ? `rename ${owner.name} (⋯ menu)`
      : `remove it from ${owner.name}’s other names`;
    return `${taken} To give it to ${editing.name}, first ${free}.`;
  }
  if (editing.role === 'character') {
    return `${taken} Use “Same person as…” in the ⋯ menu to merge them.`;
  }
  if (editing.role === 'unknown') {
    return `${taken} To have ${owner.name} read these lines, use “Give all these lines to…” in the ⋯ menu.`;
  }
  if (owner.role !== 'character') return taken;
  return (
    `${taken} If ${owner.name} tells the whole story, use “Same person as…” in ` +
    `${owner.name}’s ⋯ menu and choose ${editing.name}.`
  );
}

/** "1 line", "4 lines". */
function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function toldLabel(c: Character): string {
  const parts = c.role === 'narrator' ? 0 : (told.value.get(c.id) ?? 0);
  return parts === 0 ? '' : `tells ${count(parts, 'part')}`;
}
</script>

<template>
  <main class="page">
    <nav class="top">
      <RouterLink :to="{ name: 'story', params: { id } }">← {{ storyTitle }}</RouterLink>
      <RouterLink :to="{ name: 'reader', params: { id } }">Read &amp; listen</RouterLink>
    </nav>
    <h1>Cast</h1>
    <p class="muted">Voices apply from the next line that is read.</p>
    <details class="tips">
      <summary class="chevron">How voices work</summary>
      <ul>
        <li>
          Each voice is picked to suit its member’s traits (gender, age, species, size), which you
          can set under “Traits”.
        </li>
        <li>
          Choosing a voice, pitch or speed yourself marks it <strong>Set by hand</strong>: trait
          changes and “Match voices to traits” then leave it alone. “Back to automatic” picks one
          from the traits again.
        </li>
        <li>
          The same person listed twice, like “Bob” and “Robert”? Merge them under “Edit names or
          merge”.
        </li>
      </ul>
    </details>

    <div v-if="loading" class="loading" role="status">
      <span class="sr-only">Loading the cast…</span>
      <div v-for="n in 5" :key="n" class="card skeleton" aria-hidden="true">
        <span class="swatch" />
        <span class="bars"><span /><span /></span>
        <span class="ghost" />
      </div>
    </div>
    <p v-else-if="storyMissing" class="empty card">
      This story is no longer in your library.
      <RouterLink :to="{ name: 'library' }">Go to your stories</RouterLink>
    </p>
    <template v-else>
      <div v-if="sorted.length" class="toolbar">
        <div class="find">
          <CastFilter v-model="query" />
          <label class="sort">
            <select v-model="sortMode" aria-label="Sort by">
              <option v-for="s in SORTS" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </label>
        </div>
        <div v-if="filterChips.length" class="chips" role="group" aria-label="Show only">
          <button
            v-for="f in filterChips"
            :key="f.key"
            type="button"
            class="filter-chip"
            :aria-pressed="filter === f.key"
            @click="toggleFilter(f.key)"
          >
            {{ f.label }} <span class="n">{{ f.count }}</span>
          </button>
        </div>
        <p v-if="filtering && shown.size" class="muted small" aria-live="polite">
          Showing {{ shown.size }} of {{ sorted.length }}
        </p>
      </div>
      <p v-if="filtering && !shown.size" class="muted" role="status">
        <template v-if="query.trim()">Nobody in the cast is called “{{ query.trim() }}”.</template>
        <template v-else>Nobody in the cast matches this filter.</template>
      </p>

      <section
        v-for="g in groups"
        v-show="!filtering || g.shown"
        :key="g.role"
        class="group"
        :aria-labelledby="`group-${g.role}`"
      >
        <h2 :id="`group-${g.role}`" tabindex="-1">
          {{ g.title }}
          <span v-if="g.role === 'character' && g.members.length" class="count">
            {{ g.members.length }}
          </span>
        </h2>
        <p class="muted small">{{ g.note }}</p>

        <template v-if="g.role === 'character'">
          <div v-if="hasCharacters" class="match">
            <button type="button" @click="matchVoices">Match voices to traits</button>
            <p
              v-if="notes.get(PAGE)"
              class="card-note small"
              :class="{ error: notes.get(PAGE)!.error }"
              :role="notes.get(PAGE)!.error ? 'alert' : 'status'"
            >
              {{ notes.get(PAGE)!.text }}
            </p>
          </div>
          <!-- Closed at first: a long book can have many, and they wait until wanted. -->
          <details v-if="suggestions.length && !filtering" class="dupes">
            <summary class="chevron">
              Possible duplicates <span class="count">{{ suggestions.length }}</span>
            </summary>
            <ul>
              <li
                v-for="(s, i) in allSuggestions
                  ? suggestions
                  : suggestions.slice(0, SUGGESTIONS_SHOWN)"
                :key="s.key"
                class="dupe"
              >
                <p class="pair">
                  <span class="who" :style="{ '--tint': speakerTint(colors, s.from.id) }"
                    ><span class="dot" aria-hidden="true" />{{ s.from.name }}</span
                  >
                  <span aria-hidden="true">&nbsp;→&nbsp;</span>
                  <span class="sr-only">&nbsp;into&nbsp;</span>
                  <span class="who" :style="{ '--tint': speakerTint(colors, s.into.id) }"
                    ><span class="dot" aria-hidden="true" />{{ s.into.name }}</span
                  >
                </p>
                <p class="muted small reason">
                  {{ s.reason }} · {{ count(linesOfMember(s.from), 'line') }} and
                  {{ count(linesOfMember(s.into), 'line') }}
                </p>
                <div class="dupe-actions">
                  <button
                    type="button"
                    :aria-label="`Merge ${s.from.name} into ${s.into.name}`"
                    @click="merge(s.from, s.into.id)"
                  >
                    Merge
                  </button>
                  <button
                    type="button"
                    :aria-label="`Swap: merge ${s.into.name} into ${s.from.name} instead`"
                    @click="swap(s)"
                  >
                    Swap
                  </button>
                  <button
                    type="button"
                    class="link"
                    :aria-label="`${s.from.name} and ${s.into.name} are not the same person`"
                    @click="notTheSame(s, i)"
                  >
                    Not the same
                  </button>
                </div>
              </li>
            </ul>
            <button
              v-if="suggestions.length > SUGGESTIONS_SHOWN"
              type="button"
              class="link"
              @click="allSuggestions = !allSuggestions"
            >
              {{ allSuggestions ? 'Show fewer' : `Show all ${suggestions.length}` }}
            </button>
          </details>
          <p v-else-if="!hasCharacters" class="empty card">
            <template v-if="analysed">No characters were found in the analysed parts.</template>
            <template v-else>Characters appear here once a part has been analysed.</template>
            <RouterLink :to="{ name: 'story', params: { id } }">Go to the parts</RouterLink>
          </p>
        </template>

        <ul class="cast">
          <template v-for="c in g.members" :key="c.id">
            <li v-if="c.id === g.foldAt" v-show="!filtering" class="fold">
              <button
                type="button"
                class="fold-toggle"
                :aria-expanded="minorOpen"
                @click="minorOpen = !minorOpen"
              >
                <span class="fold-title">
                  Minor characters <span class="n">{{ g.foldNames.length }}</span
                  ><span class="sr-only">: </span>
                </span>
                <span class="muted small fold-names">
                  {{ g.foldNames.slice(0, 3).join(', ')
                  }}<template v-if="g.foldNames.length > 3"
                    >, +{{ g.foldNames.length - 3 }}</template
                  >
                </span>
              </button>
            </li>
            <!-- A folded or filtered-out row is left out until shown, unless its card was opened. -->
            <li
              v-if="visible(c) || opened.has(c.id)"
              v-show="visible(c)"
              :id="`member-${c.id}`"
              class="card character"
              :class="{ open: openId === c.id, flash: flashId === c.id }"
              :style="{ '--tint': speakerTint(colors, c.id) }"
            >
              <div class="head">
                <span class="swatch" aria-hidden="true" />
                <div class="who">
                  <h3>
                    <button
                      type="button"
                      class="toggle"
                      :aria-expanded="openId === c.id"
                      :aria-controls="opened.has(c.id) ? `member-${c.id}-body` : undefined"
                      :aria-describedby="`member-${c.id}-meta`"
                      @click="toggleOpen(c)"
                    >
                      {{ c.name }}
                      <span class="chev" aria-hidden="true" />
                    </button>
                  </h3>
                  <div :id="`member-${c.id}-meta`">
                    <p class="muted small meta">
                      <template v-if="usage && !usage.get(c.id)">not in any part yet</template>
                      <template v-else>{{ count(usage?.get(c.id) ?? 0, 'line') }}</template>
                      <template v-if="toldLabel(c)"> · {{ toldLabel(c) }}</template>
                      <template v-if="c.aliases.length">
                        · also “{{ c.aliases.join('”, “') }}”</template
                      >
                    </p>
                    <p class="muted small meta voice-sum">
                      {{
                        shortVoiceName(
                          voicesLoaded ? resolved.get(c.id)?.voiceName : c.voice.voiceName,
                        )
                      }}
                      <span v-if="c.voice.manual" class="flag">· set by hand</span>
                      <span v-if="soundAlikes.get(c.id)?.length" class="flag warn">
                        · sounds alike</span
                      >
                      <span v-if="resolved.get(c.id)?.substituted" class="flag warn">
                        · substituted</span
                      >
                    </p>
                  </div>
                </div>
                <ActionsMenu
                  class="member-menu"
                  :title="c.name"
                  noun="character"
                  :reorderable="false"
                  :removable="c.role === 'character'"
                  delete-label="Not a character"
                  :confirm-delete-label="`Tap again: their lines go to ${unknownName}`"
                  field-label="Name"
                  @rename="renameFromMenu(c, $event)"
                  @remove="notACharacter(c)"
                >
                  <template #default="{ act }">
                    <button role="menuitem" @click="act(() => openMergeSheet(c))">
                      {{
                        c.role === 'character'
                          ? 'Same person as…'
                          : c.role === 'narrator'
                            ? 'Give all these lines, in every part, to…'
                            : 'Give all these lines to…'
                      }}
                    </button>
                  </template>
                </ActionsMenu>
                <button
                  class="preview"
                  :class="{ speaking: speaking === c.id }"
                  :aria-label="`Preview ${c.name}’s voice`"
                  :aria-pressed="speaking === c.id"
                  :title="speaking === c.id ? 'Stop' : 'Preview'"
                  @click="togglePreview(c)"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <rect
                      v-if="speaking === c.id"
                      x="6"
                      y="6"
                      width="12"
                      height="12"
                      rx="1.5"
                      fill="currentColor"
                    />
                    <path v-else d="M8 5v14l11-7z" fill="currentColor" />
                  </svg>
                </button>
              </div>

              <div
                v-if="opened.has(c.id)"
                v-show="openId === c.id"
                :id="`member-${c.id}-body`"
                class="body"
              >
                <p
                  v-if="notes.get(c.id)"
                  class="card-note small"
                  :class="{ error: notes.get(c.id)!.error }"
                  :role="notes.get(c.id)!.error ? 'alert' : 'status'"
                >
                  {{ notes.get(c.id)!.text }}
                </p>
                <div v-if="openId === c.id" class="sample" :class="{ speaking: speaking === c.id }">
                  <p v-if="parts" class="sample-text">“{{ sampleOf(c, openSamples) }}”</p>
                  <p v-else class="sample-text muted">Finding one of their lines…</p>
                  <div class="sample-actions">
                    <button
                      v-if="openSamples.length > 1"
                      type="button"
                      class="link"
                      @click="nextSample(c)"
                    >
                      Next line
                    </button>
                    <label class="auto">
                      <input v-model="playOnChange" type="checkbox" />
                      Play after each change
                    </label>
                  </div>
                </div>
                <div class="voice">
                  <div class="voice-head">
                    <span class="voice-label">Voice</span>
                    <span
                      :id="`voice-mode-${c.id}`"
                      class="chip"
                      :class="{ manual: c.voice.manual }"
                    >
                      {{ c.voice.manual ? 'Set by hand' : 'Automatic' }}
                    </span>
                    <button
                      v-if="c.voice.manual"
                      type="button"
                      class="link back"
                      :aria-label="`Back to an automatic voice for ${c.name}`"
                      @click="repickVoice(c)"
                    >
                      Back to automatic
                    </button>
                  </div>
                  <button
                    :id="`voice-${c.id}`"
                    type="button"
                    class="voice-button"
                    :data-voice="c.voice.voiceName ?? ''"
                    aria-haspopup="dialog"
                    :aria-label="`${c.name}’s voice: ${voiceTitle(c).title}. Change`"
                    :aria-describedby="`voice-mode-${c.id}`"
                    @click="sheetFor = c.id"
                  >
                    <span class="voice-title">
                      {{ voiceTitle(c).title }}
                      <span v-if="voiceTitle(c).tags.length" class="voice-tags">
                        · {{ voiceTitle(c).tags.join(' · ') }}
                      </span>
                    </span>
                    <span v-if="voiceTitle(c).full" class="voice-full">{{
                      voiceTitle(c).full
                    }}</span>
                    <span class="voice-change" aria-hidden="true">Change</span>
                  </button>
                </div>
                <p v-if="resolved.get(c.id)?.substituted" class="substituted small">
                  <span class="badge">Substituted</span>
                  This voice isn't installed here, so
                  {{ resolved.get(c.id)!.voiceName ?? `the default ${c.voice.lang} voice` }} reads
                  instead, with the same pitch and speed.
                </p>
                <p v-if="soundAlikes.get(c.id)?.length" class="alike small">
                  <template v-if="soundAlikes.get(c.id)!.some((o) => o.role === 'narrator')">
                    Sounds like the narrator.
                  </template>
                  <template v-else>
                    Sounds close to
                    <template v-for="(o, i) in soundAlikes.get(c.id)!" :key="o.id"
                      ><template v-if="i">, </template
                      ><button
                        type="button"
                        class="link who"
                        :style="{ '--tint': speakerTint(colors, o.id) }"
                        @click="goToMember(o)"
                      >
                        <span class="dot" aria-hidden="true" />{{ o.name }}
                      </button></template
                    >.
                  </template>
                  <button type="button" class="link" @click="repickVoice(c)">
                    Pick another voice
                  </button>
                </p>
                <div class="sliders">
                  <label v-for="dial in ['pitch', 'rate'] as const" :key="dial">
                    <span class="dial-label">
                      {{ dial === 'pitch' ? 'Pitch' : 'Speed' }}
                      <span class="dial-value">{{ dialText(dialValue(c, dial)) }}</span>
                    </span>
                    <input
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.05"
                      :value="dialValue(c, dial)"
                      :aria-valuetext="dialText(dialValue(c, dial))"
                      @input="onDialInput(c, dial, $event)"
                      @change="onDialChange(c, dial, $event)"
                    />
                  </label>
                </div>

                <details class="names">
                  <summary class="chevron">Other names</summary>
                  <CharacterEditor
                    :character="c"
                    :name-error="nameClash?.id === c.id ? clashText : undefined"
                    @save="saveNames(c, $event)"
                  />
                </details>

                <CharacterTraits
                  v-if="c.role !== 'unknown'"
                  :character="c"
                  :voice-kept="voiceKept.has(c.id)"
                  @change="changeTraits(c, $event)"
                  @repick="repickVoice(c)"
                />

                <details
                  v-if="usage?.get(c.id)"
                  class="lines"
                  :open="openId === c.id && linesOfMember(c) <= SHORT_LINES"
                  @toggle="onLinesToggle(c, $event)"
                >
                  <summary class="chevron">See {{ c.name }}’s lines</summary>
                  <p v-if="!parts" class="muted small">Finding their lines…</p>
                  <template v-else-if="memberLines.get(c.id)">
                    <p v-if="!memberLines.get(c.id)!.total" class="muted small">
                      Their lines are in parts that need analysing again.
                    </p>
                    <ol>
                      <li v-for="l in memberLines.get(c.id)!.shown" :key="l.partId + ':' + l.index">
                        <RouterLink
                          :to="{
                            name: 'reader',
                            params: { id, partId: l.partId },
                            query: { line: String(l.index) },
                          }"
                        >
                          <span class="line-part muted small">{{ l.partTitle }}</span>
                          <span class="line-text" :data-mode="l.segment.mode">{{ l.text }}</span>
                        </RouterLink>
                      </li>
                    </ol>
                    <button
                      v-if="memberLines.get(c.id)!.total > memberLines.get(c.id)!.shown.length"
                      type="button"
                      class="link"
                      @click="showMoreLines(c)"
                    >
                      Show more ({{
                        memberLines.get(c.id)!.total - memberLines.get(c.id)!.shown.length
                      }}
                      left)
                    </button>
                  </template>
                </details>
              </div>
            </li>
          </template>
        </ul>
      </section>
    </template>

    <!-- Always there, so what appears in it is announced. -->
    <div class="snack-region" aria-live="polite">
      <div
        v-if="snack"
        class="snackbar"
        @mouseenter="holdSnack(true)"
        @mouseleave="holdSnack(false)"
        @focusin="holdSnack(true)"
        @focusout="holdSnack(false)"
      >
        <span class="snack-text">{{ snack.text }}</span>
        <button v-if="snack.undo" type="button" class="snack-undo" @click="undoLast">Undo</button>
        <button type="button" class="snack-close" aria-label="Dismiss" @click="showSnack()">
          ×
        </button>
      </div>
    </div>

    <MergeSheet
      v-if="mergeMember"
      :member="mergeMember"
      :cast="cast"
      :colors="colors"
      :lines="usage ?? new Map()"
      :first-line="firstLineOf"
      :voice-of="voiceWords"
      @merge="onSheetMerge"
      @close="closeMergeSheet"
    />

    <VoiceSheet
      v-if="sheetMember"
      :member="sheetMember"
      :cast="cast"
      :colors="colors"
      :voices="offeredVoices"
      :device-voices="deviceVoices"
      :audition="audition"
      :stop="stopPreview"
      @use="useVoice"
      @close="closeSheet"
    />
  </main>
</template>

<style scoped>
.substituted {
  margin: 0;
  color: var(--muted);
}

.badge {
  display: inline-block;
  margin-right: 6px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--warn);
  color: var(--warn);
  font-weight: 600;
}

.top {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
}

.match {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.match button {
  justify-self: start;
}

.cast {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 12px;
}

/* The search, sort and filters stay in reach while a long cast scrolls under them. */
.toolbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  gap: 8px;
  margin: 0 calc(-1 * var(--gutter));
  padding: 8px var(--gutter);
  background: var(--bg);
}

.toolbar .small {
  margin: 0;
}

.find {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.sort select {
  width: auto;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.filter-chip {
  min-height: 36px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 0.85rem;
  gap: 6px;
}

.filter-chip[aria-pressed='true'] {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
}

.n {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}

.character {
  padding-block: 8px;
}

.body {
  display: grid;
  gap: 10px;
  padding-top: 10px;
}

/* A row: the name's button covers it all, bar the preview button, so a tap anywhere opens it. */
.head {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: 4px 12px;
  align-items: center;
}

.who {
  min-width: 0;
}

.head h3 {
  font-size: 1.05rem;
  margin: 0;
}

.toggle {
  min-height: 0;
  padding: 0;
  border: 0;
  background: none;
  font-weight: 600;
  text-align: start;
  justify-content: flex-start;
}

.toggle::after {
  content: '';
  position: absolute;
  inset: -8px calc(-1 * var(--gutter));
  border-radius: var(--radius);
}

.toggle:focus-visible {
  outline: none;
}

.toggle:focus-visible::after {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.meta {
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.flag.warn {
  color: var(--warn);
}

/* Right after the name, inside its button, so it costs the row no column of its own. */
.chev {
  flex: none;
  width: 8px;
  height: 8px;
  margin-inline: 8px 2px;
  border-right: 2px solid var(--muted);
  border-bottom: 2px solid var(--muted);
  transform: translateY(-2px) rotate(45deg);
  transition: transform 0.15s;
  pointer-events: none;
}

.open .chev {
  transform: translateY(2px) rotate(-135deg);
}

@media (prefers-reduced-motion: reduce) {
  .chev {
    transition: none;
  }
}

.preview {
  position: relative;
  z-index: 1;
  width: 44px;
  padding: 0;
  border-radius: 50%;
}

.preview.speaking {
  border-color: var(--tint, var(--accent));
  color: var(--tint, var(--accent));
}

/* The line a preview plays, in the member's colour, lit while it is spoken. */
.sample {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  border-inline-start: 3px solid var(--tint, var(--muted));
  border-radius: 8px;
}

.sample.speaking {
  background: color-mix(in srgb, var(--tint, var(--accent)) 14%, transparent);
}

.sample-text {
  margin: 0;
  font-size: 0.95rem;
}

.sample-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 16px;
}

.auto {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  font-size: 0.85rem;
}

.auto input {
  width: 18px;
  height: 18px;
  margin: 0;
}

.fold-toggle {
  width: 100%;
  min-height: 56px;
  display: grid;
  justify-items: start;
  gap: 2px;
  padding: 8px var(--gutter);
  border-style: dashed;
  text-align: start;
}

.fold-title {
  font-weight: 600;
}

.fold-names {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tips {
  margin: 8px 0 12px;
}

.tips ul {
  margin: 0;
  padding-inline-start: 20px;
  display: grid;
  gap: 6px;
  font-size: 0.9rem;
  color: var(--muted);
}

.group {
  margin-top: 24px;
}

.group > h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1.15rem;
  margin: 0;
}

.group > .small {
  margin: 2px 0 0;
}

.count {
  padding: 0 8px;
  border-radius: 999px;
  background: var(--border);
  font-size: 0.8rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.empty {
  display: grid;
  gap: 4px;
  margin: 12px 0 0;
}

.voice {
  display: grid;
  gap: 4px;
}

.voice-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.chip {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 0.8rem;
}

.chip.manual {
  border-color: var(--accent);
  color: var(--accent);
}

.voice-label {
  font-size: 0.9rem;
  color: var(--muted);
}

/* The voice in use; a tap opens the voice sheet. */
.voice-button {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  justify-items: start;
  align-items: center;
  gap: 0 12px;
  width: 100%;
  padding: 8px 12px;
  text-align: start;
}

.voice-title {
  font-weight: 600;
}

.voice-tags {
  font-weight: 400;
  color: var(--muted);
  font-size: 0.85rem;
}

.voice-full {
  grid-column: 1;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: 0.8rem;
}

.voice-change {
  grid-column: 2;
  grid-row: 1 / span 2;
  color: var(--accent);
  font-size: 0.85rem;
}

.alike {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 6px;
  margin: 0;
  color: var(--warn);
}

.who {
  gap: 4px;
  color: var(--fg);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--tint, var(--muted));
}

.link.back {
  margin-inline-start: auto;
  font-size: 0.85rem;
}

.small {
  font-size: 0.85rem;
  margin: 0;
}

.swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--tint, var(--muted));
}

/* Side by side when the card has room for two sliders a thumb can still be set on, else stacked. */
.sliders {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 4px 16px;
}

.dial-label {
  display: flex;
  justify-content: space-between;
}

.dial-value {
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

/* A range input's thumb is small: a taller box gives the finger more to land on. */
.sliders input {
  min-height: 30px;
  padding: 0;
  border: 0;
  background: none;
}

/* Above the row's button, which covers the rest of the row; open, above the rows after it. */
.member-menu {
  z-index: 1;
}

.member-menu[open] {
  z-index: 5;
}

.dupes {
  margin-top: 12px;
  padding: 0 var(--gutter);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}

.dupes[open] {
  padding-bottom: 12px;
}

.dupes > summary {
  color: var(--fg);
  font-size: 1rem;
  font-weight: 600;
}

.dupes > ul {
  margin-bottom: 8px;
}

.dupes ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}

.dupe {
  display: grid;
  gap: 4px;
}

.pair {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-weight: 600;
}

.pair .who {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.reason {
  margin: 0;
}

.dupe-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.card-note {
  margin: 0;
  color: var(--muted);
}

.card-note.error {
  color: var(--danger);
}

/* Lit for a moment after a merge into it, so the eye finds it. */
.card.flash {
  animation: flash 1.6s ease-out;
}

@keyframes flash {
  from {
    box-shadow: 0 0 0 3px var(--tint, var(--accent));
  }
  to {
    box-shadow: 0 0 0 3px transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .card.flash {
    animation: none;
    box-shadow: 0 0 0 3px var(--tint, var(--accent));
  }
}

/* The last change and its Undo, above everything at the bottom of the screen. */
.snack-region {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  display: flex;
  justify-content: center;
  padding: 0 var(--gutter) calc(var(--gutter) + env(safe-area-inset-bottom));
  pointer-events: none;
}

.snackbar {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 688px;
  padding: 4px 4px 4px 16px;
  border-radius: var(--radius);
  background: var(--fg);
  color: var(--bg);
  box-shadow: 0 4px 16px rgb(0 0 0 / 30%);
}

.snack-text {
  flex: 1;
  font-size: 0.9rem;
}

.snack-undo,
.snack-close {
  border: 0;
  background: none;
  color: inherit;
}

.snack-undo {
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.snack-close {
  width: 44px;
  padding: 0;
  font-size: 1.3rem;
}

.lines ol {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: grid;
  gap: 2px;
  max-height: 360px;
  overflow-y: auto;
}

.lines a {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  border-inline-start: 3px solid var(--tint, var(--muted));
  color: var(--fg);
  text-decoration: none;
}

.lines a:hover,
.lines a:focus-visible {
  background: color-mix(in srgb, var(--tint, var(--accent)) 12%, transparent);
}

.link {
  min-height: 44px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  text-decoration: underline;
}

.line-text[data-mode='thought'] {
  font-style: italic;
}

/* Stands in for the list while the cast and its line counts are read: rows the shape of a member's. */
.loading {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}

.skeleton {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  min-height: 80px;
}

.skeleton .swatch,
.skeleton .bars > span,
.skeleton .ghost {
  background: var(--border);
  animation: pulse 1.2s ease-in-out infinite alternate;
}

.skeleton .bars {
  display: grid;
  gap: 8px;
}

.skeleton .bars > span {
  height: 12px;
  width: 60%;
  border-radius: 6px;
}

.skeleton .bars > span + span {
  width: 40%;
}

.skeleton .ghost {
  width: 40px;
  height: 40px;
  border-radius: 50%;
}

@keyframes pulse {
  from {
    opacity: 1;
  }
  to {
    opacity: 0.45;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton .swatch,
  .skeleton .bars > span,
  .skeleton .ghost {
    animation: none;
  }
}

/*
 * Phones: the row's controls leave the name more room. The ⋮ and play look the same; only their
 * empty margins shrink, and each keeps a target at least 36px wide and 40px tall.
 */
@media (max-width: 480px) {
  /* The card's side padding and the row button's overlay both follow it. */
  .character {
    --gutter: 12px;
  }

  .head {
    column-gap: 8px;
  }

  .member-menu :deep(summary) {
    min-width: 36px;
  }

  .preview {
    width: 40px;
    min-height: 40px;
  }

  /* One row of filters that scrolls sideways, so the sticky toolbar stays short. */
  .toolbar {
    gap: 6px;
    padding-block: 6px;
  }

  .chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    margin-inline: calc(-1 * var(--gutter));
    padding-inline: var(--gutter);
    scrollbar-width: none;
    overscroll-behavior-x: contain;
  }

  .chips::-webkit-scrollbar {
    display: none;
  }

  .filter-chip {
    flex: none;
    min-height: 32px;
    padding: 0 10px;
    white-space: nowrap;
  }
}
</style>
