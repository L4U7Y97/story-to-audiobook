<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { Character, VoiceSettings } from '@/format/types';
import { voicesForLang, type DeviceVoice } from '@/playback/engine';
import { getAppDb } from '@/storage/db';
import { DEFAULT_LOCALE, getStory, updateStory } from '@/storage/stories';
import { listParts } from '@/storage/parts';
import {
  matchVoicesInStory,
  mergeCharactersInStory,
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
  partsToldBy,
  renameCharacter,
  setAliases,
} from '@/cast/castOps';
import { clashesWithNarrator } from '@/cast/assignVoices';
import { resolveVoice } from '@/cast/resolveVoice';
import { cleanTraits, TRAIT_KEYS, withTraits } from '@/cast/traits';
import { voiceProfile } from '@/cast/voiceProfile';
import CastFilter from '../components/CastFilter.vue';
import VoiceSheet from '../components/VoiceSheet.vue';
import CharacterEditor from '../components/CharacterEditor.vue';
import CharacterTraits from '../components/CharacterTraits.vue';
import { useLiveQuery } from '../composables/useLiveQuery';
import { getEngine, usePlayer } from '../composables/usePlayer';
import { speakerColorIndex, speakerTint } from '../speakerColors';

const props = defineProps<{ id: string }>();
const db = getAppDb();
const { player } = usePlayer(props.id);

const { data: story } = useLiveQuery(() => getStory(db, props.id), [() => props.id]);
const { data: analyses } = useLiveQuery(async () => {
  const s = await getStory(db, props.id);
  return db.analyses.bulkGet(s?.partIds ?? []);
}, [() => props.id]);
const { data: parts } = useLiveQuery(() => listParts(db, props.id), [() => props.id]);
/** Segment count per character across all analysed parts. */
const usage = computed(() => analyses.value && castUsage(analyses.value));
/** Parts each character tells, i.e. reads most of the narration of. */
const told = computed(() => {
  const s = story.value;
  if (!s) return new Map<string, number>();
  return new Map(s.cast.map((c) => [c.id, partsToldBy(analyses.value ?? [], c.id, s.narratorId)]));
});

/** Members whose "Lines" list is open: a list is only worked out while it is shown. */
const linesOpen = ref(new Set<string>());
/** How many of a member's lines are listed; "Show more" raises it. */
const linesShown = ref(new Map<string, number>());
const LINES_PAGE = 50;
function onLinesToggle(c: Character, event: Event) {
  const next = new Set(linesOpen.value);
  if ((event.target as HTMLDetailsElement).open) next.add(c.id);
  else next.delete(c.id);
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
const memberLines = computed(() => {
  const byId = new Map((parts.value ?? []).map((p) => [p.id, p]));
  const current = (analyses.value ?? []).filter(
    (a) => a && byId.get(a.partId)?.textHash === a.textHash,
  );
  return new Map(
    [...linesOpen.value].map((id) => [
      id,
      linesOf(current, id).map((l) => {
        const part = byId.get(l.partId)!;
        return {
          ...l,
          partTitle: part.title,
          text: excerpt(part.text.slice(l.segment.start, l.segment.end)),
        };
      }),
    ]),
  );
});
function excerpt(text: string, max = 140): string {
  const t = text.replace(/\s+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const error = ref('');
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
onMounted(async () => {
  deviceVoices.value = await voicesReady;
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

const colors = computed(() => speakerColorIndex(story.value?.cast ?? []));

/** How each character's voice plays on this device (a missing voice is substituted). */
const resolved = computed(
  () =>
    new Map(
      (story.value?.cast ?? []).map((c) => [c.id, resolveVoice(c.voice, deviceVoices.value)]),
    ),
);

/**
 * Who each member can't be told from on this device: the same voice heard at a pitch within 0.05,
 * the combinations automatic picks never give (clashesWithNarrator). The narrator's card says
 * nothing; those near it say so on theirs.
 */
const soundAlikes = computed(() => {
  const cast = story.value?.cast ?? [];
  return new Map(
    cast.map((c) => [
      c.id,
      c.role === 'narrator'
        ? []
        : cast.filter(
            (o) => o.id !== c.id && clashesWithNarrator(c.voice, o.voice, deviceVoices.value),
          ),
    ]),
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
function bySort(a: Character, b: Character): number {
  if (sortMode.value === 'name') return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
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
  const characters = (story.value?.cast ?? []).filter((c) => c.role === 'character');
  const minor = characters.filter(isMinor);
  const fold =
    characters.length > FOLD_OVER && minor.length > 1 && minor.length < characters.length;
  return new Set(fold ? minor.map((c) => c.id) : []);
});
/** By role, then folded members after the rest, then by the chosen order. */
const sorted = computed(() =>
  [...(story.value?.cast ?? [])].sort(
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
function toggleOpen(c: Character) {
  openId.value = openId.value === c.id ? undefined : c.id;
}
const minorOpen = ref(false);
/** Opens another member's card and brings it into view, unfolding it if need be. */
function goToMember(c: Character) {
  openId.value = c.id;
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

/** Saves a change to the cast and has the player take it up; a failure is shown on the page. */
async function changeCast(change: () => Promise<void>) {
  try {
    await change();
    error.value = '';
    player.castChanged();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
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
) {
  await changeCast(async () => {
    await setVoiceInStory(db, props.id, character.id, changes);
    // The voice is now the one the user wants for the traits as they are.
    noteVoiceKept(character.id, false);
  });
  await replay(character.id);
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
  await setVoice(c, { [dial]: value });
  // A refused save leaves the stored value, which the label then shows again.
  if (error.value) dropDraft(c.id, dial);
}
function dropDraft(id: string, dial: Dial) {
  const next = new Map(drafts.value);
  next.delete(`${id}:${dial}`);
  drafts.value = next;
}
// A draft goes once the cast holds what it shows, so the label never jumps back while saving.
watch(
  () => story.value?.cast,
  (cast) => {
    for (const c of cast ?? []) {
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

function onVoicePicked(character: Character, name: string) {
  const voice = deviceVoices.value.find((v) => v.name === name);
  void setVoice(
    character,
    voice ? { voiceName: voice.name, lang: voice.lang } : { voiceName: undefined },
  );
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
  });
  // A new voice for the new traits is played; a kept one sounds as before.
  if (voiceChanged) await replay(character.id);
}

/** Picks a member's voice again from its traits, also when it was set by hand. */
async function repickVoice(character: Character) {
  await changeCast(async () => {
    await repickVoiceInStory(db, props.id, character.id, await voicesReady);
    noteVoiceKept(character.id, false);
  });
  await replay(character.id);
}

const hasCharacters = computed(() => story.value?.cast.some((c) => c.role === 'character'));
/** What "Match voices to traits" would do, counted from the cast as it is now. */
const matchText = computed(() => {
  const characters = (story.value?.cast ?? []).filter((c) => c.role === 'character');
  const kept = characters.filter((c) => c.voice.manual).length;
  const repicked = characters.length - kept;
  const stay =
    kept === 0
      ? ''
      : `; the ${count(kept, 'voice')} you set by hand ${kept === 1 ? 'stays' : 'stay'}`;
  const pick =
    repicked === 0
      ? 'Guesses missing traits from names; every voice was set by hand, so none changes'
      : `Picks ${count(repicked, 'voice')} again to suit traits guessed from names${stay}`;
  return `${pick}. Press again to confirm.`;
});
/** "Match voices to traits" was pressed once: the next press does it. */
const matching = ref(false);
const matched = ref(false);
async function matchVoices() {
  matched.value = false;
  if (!matching.value) return void (matching.value = true);
  matching.value = false;
  await changeCast(async () => {
    await matchVoicesInStory(db, props.id, await voicesReady);
    matched.value = true;
  });
}
function leaveMatch() {
  matching.value = false;
  matched.value = false;
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
  const byId = new Map((parts.value ?? []).map((p) => [p.id, p]));
  const texts = linesOf(analyses.value ?? [], c.id).flatMap((l) => {
    const part = byId.get(l.partId);
    return part ? [speakable(part.text.slice(l.segment.start, l.segment.end))] : [];
  });
  const fit = texts.filter((t) => t.length >= SAMPLE_MIN);
  if (fit.length) return fit.slice(0, SAMPLES_KEPT);
  const words = (t: string) => t.split(' ').length;
  return texts
    .filter((t) => words(t) >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 1);
}
/** Which of its samples each member plays; "Next line" moves it on. */
const sampleAt = ref(new Map<string, number>());
function sampleOf(c: Character, samples = samplesOf(c)): string {
  if (!samples.length) return `Hello, I am ${c.name}.`;
  return samples[(sampleAt.value.get(c.id) ?? 0) % samples.length]!;
}
/** The open member's samples, worked out once per change rather than once per use. */
const openSamples = computed(() => {
  const c = story.value?.cast.find((m) => m.id === openId.value);
  return c ? samplesOf(c) : [];
});

/** The member whose preview is being spoken. */
const speaking = ref<string>();
let previewRun = 0;
async function preview(character: Character, voice: VoiceSettings = character.voice) {
  const run = ++previewRun;
  speaking.value = character.id;
  try {
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
const sheetMember = computed(() => story.value?.cast.find((c) => c.id === sheetFor.value));
function closeSheet() {
  const id = sheetFor.value;
  sheetFor.value = undefined;
  // Back to the button that opened it, as a dialog does.
  if (id) void nextTick(() => document.getElementById(`voice-${id}`)?.focus());
}
function useVoice(name: string) {
  const member = sheetMember.value;
  if (member) onVoicePicked(member, name);
  closeSheet();
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
  if (!playOnChange.value || error.value) return;
  const member = (await getStory(db, props.id))?.cast.find((c) => c.id === id);
  if (member) await preview(member);
}

async function saveNames(character: Character, changes: { name: string; aliases: string[] }) {
  const s = story.value;
  if (!s) return;
  // A name, or one of the other names, that someone else already has is refused.
  const clash = findNameClash(s.cast, character.id, changes, s.narratorId);
  if (clash) return void (nameClash.value = { id: character.id, name: clash.name });
  nameClash.value = undefined;
  const renamed = renameCharacter(s.cast, character.id, changes.name);
  if (!renamed.ok) return void (error.value = renamed.reason);
  // Keep the alias renameCharacter adds for the old name alongside the edited list.
  const added = renamed.value
    .find((c) => c.id === character.id)!
    .aliases.filter((a) => !character.aliases.includes(a));
  const aliases = [...new Set([...changes.aliases, ...added])];
  const result = setAliases(renamed.value, character.id, aliases);
  if (!result.ok) return void (error.value = result.reason);
  error.value = '';
  await updateStory(db, s.id, { cast: result.value });
}

async function merge(character: Character, intoId: string) {
  try {
    await mergeCharactersInStory(db, props.id, character.id, intoId);
    error.value = '';
    // A refused name's message described the cast before this merge, often the merge it suggested.
    nameClash.value = undefined;
    player.castChanged();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
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
    const free = ownName ? 'change its name' : 'remove it from “Other names”';
    return `${taken} To give it to ${editing.name}, open ${owner.name}’s card and ${free} first.`;
  }
  if (editing.role === 'character') return `${taken} Use “Same person as…” to merge them.`;
  if (editing.role === 'unknown') {
    return `${taken} To have ${owner.name} read these lines, use “Give all these lines to…”.`;
  }
  if (owner.role !== 'character') return taken;
  return (
    `${taken} If ${owner.name} tells the whole story, open ${owner.name}’s card and use ` +
    `“Same person as… ${editing.name}” to merge them.`
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
      <RouterLink :to="{ name: 'story', params: { id } }"
        >← {{ story?.title ?? 'Story' }}</RouterLink
      >
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
    <p v-if="error" class="error" role="alert">{{ error }}</p>

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
      <h2 :id="`group-${g.role}`">
        {{ g.title }}
        <span v-if="g.role === 'character' && g.members.length" class="count">
          {{ g.members.length }}
        </span>
      </h2>
      <p class="muted small">{{ g.note }}</p>

      <template v-if="g.role === 'character'">
        <div v-if="hasCharacters" class="match">
          <button
            type="button"
            :class="{ danger: matching }"
            @click="matchVoices"
            @blur="leaveMatch"
          >
            {{ matching ? 'Confirm match' : 'Match voices to traits' }}
          </button>
          <p v-if="matching" class="warning" role="status">{{ matchText }}</p>
          <p v-if="matched" class="muted small done" role="status">Voices matched to traits.</p>
        </div>
        <p v-else-if="story" class="empty card">
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
                }}<template v-if="g.foldNames.length > 3">, +{{ g.foldNames.length - 3 }}</template>
              </span>
            </button>
          </li>
          <li
            v-show="visible(c)"
            :id="`member-${c.id}`"
            class="card character"
            :class="{ open: openId === c.id }"
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
                    :aria-controls="`member-${c.id}-body`"
                    :aria-describedby="`member-${c.id}-meta`"
                    @click="toggleOpen(c)"
                  >
                    {{ c.name }}
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
                    {{ shortVoiceName(resolved.get(c.id)?.voiceName) }}
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
              <span class="chev" aria-hidden="true" />
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

            <div v-show="openId === c.id" :id="`member-${c.id}-body`" class="body">
              <div v-if="openId === c.id" class="sample" :class="{ speaking: speaking === c.id }">
                <p class="sample-text">“{{ sampleOf(c, openSamples) }}”</p>
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
                  <span :id="`voice-mode-${c.id}`" class="chip" :class="{ manual: c.voice.manual }">
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
                  <span v-if="voiceTitle(c).full" class="voice-full">{{ voiceTitle(c).full }}</span>
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
                <summary class="chevron">Edit names or merge</summary>
                <CharacterEditor
                  :key="c.name + c.aliases.join()"
                  :character="c"
                  :cast="story?.cast ?? []"
                  :name-error="nameClash?.id === c.id ? clashText : undefined"
                  @save="saveNames(c, $event)"
                  @merge="merge(c, $event)"
                />
              </details>

              <CharacterTraits
                v-if="c.role !== 'unknown'"
                :character="c"
                :voice-kept="voiceKept.has(c.id)"
                @change="changeTraits(c, $event)"
                @repick="repickVoice(c)"
              />

              <details v-if="usage?.get(c.id)" class="lines" @toggle="onLinesToggle(c, $event)">
                <summary class="chevron">See {{ c.name }}’s lines</summary>
                <template v-if="memberLines.get(c.id)">
                  <p v-if="!memberLines.get(c.id)!.length" class="muted small">
                    Their lines are in parts that need analysing again.
                  </p>
                  <ol>
                    <li
                      v-for="l in memberLines
                        .get(c.id)!
                        .slice(0, linesShown.get(c.id) ?? LINES_PAGE)"
                      :key="l.partId + ':' + l.index"
                    >
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
                    v-if="memberLines.get(c.id)!.length > (linesShown.get(c.id) ?? LINES_PAGE)"
                    type="button"
                    class="link"
                    @click="showMoreLines(c)"
                  >
                    Show more ({{
                      memberLines.get(c.id)!.length - (linesShown.get(c.id) ?? LINES_PAGE)
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

    <VoiceSheet
      v-if="sheetMember"
      :member="sheetMember"
      :cast="story?.cast ?? []"
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

.warning {
  margin: 0;
  color: var(--warn);
  font-size: 0.9rem;
}

.danger {
  border-color: var(--danger);
  color: var(--danger);
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

/* Turned, so painted above the row's button: taps pass through it to the button. */
.chev {
  width: 8px;
  height: 8px;
  margin-inline: 4px;
  border-right: 2px solid var(--muted);
  border-bottom: 2px solid var(--muted);
  transform: rotate(45deg);
  transition: transform 0.15s;
  pointer-events: none;
}

.open .chev {
  transform: rotate(-135deg);
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

.error {
  color: var(--danger);
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
</style>
