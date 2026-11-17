<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
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
import { isDefaultName, normaliseName } from '@/analysis/castMatch';
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
import { resolveVoice } from '@/cast/resolveVoice';
import { cleanTraits, TRAIT_KEYS, withTraits } from '@/cast/traits';
import { voiceProfile } from '@/cast/voiceProfile';
import CastFilter from '../components/CastFilter.vue';
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
/** The voices a picker lists, each with what is known of it: "en-us-x-tpc-local (female)". */
const voiceChoices = computed(() => {
  const forLang = voicesForLang(deviceVoices.value, DEFAULT_LOCALE);
  return (forLang.length ? forLang : deviceVoices.value).map((v) => {
    const notes = [voiceProfile(v).gender, v.network ? 'online' : undefined].filter(Boolean);
    return { name: v.name, label: notes.length ? `${v.name} (${notes.join(', ')})` : v.name };
  });
});
const colors = computed(() => speakerColorIndex(story.value?.cast ?? []));

const ROLE_ORDER = { narrator: 0, unknown: 2, character: 1 } as const;
const sorted = computed(() =>
  [...(story.value?.cast ?? [])].sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      (usage.value?.get(b.id) ?? 0) - (usage.value?.get(a.id) ?? 0),
  ),
);
const query = ref('');
/** Hidden, not removed, so a card's open editor and what is typed in it outlive a search. */
const shown = computed(() => new Set(filterCast(sorted.value, query.value).map((c) => c.id)));

/** How each character's voice plays on this device (a missing voice is substituted). */
const resolved = computed(
  () =>
    new Map(
      (story.value?.cast ?? []).map((c) => [c.id, resolveVoice(c.voice, deviceVoices.value)]),
    ),
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
  await changeCast(async () => {
    const voices = await voicesReady;
    const { repicked } = await setTraitsInStory(db, props.id, character.id, changes, voices);
    if (changed) noteVoiceKept(character.id, !repicked);
  });
}

/** Picks a member's voice again from its traits, also when it was set by hand. */
async function repickVoice(character: Character) {
  await changeCast(async () => {
    await repickVoiceInStory(db, props.id, character.id, await voicesReady);
    noteVoiceKept(character.id, false);
  });
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

async function preview(character: Character) {
  const sample = `Hello, I am ${character.name}.`;
  await player.preview(sample, character.voice);
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

/** The role, said only when the name doesn't already say it ("Watson · Narrator"). */
function roleLabel(c: Character): string {
  if (c.role === 'narrator') return isDefaultName(c.name, 'narrator') ? '' : 'Narrator';
  return c.role === 'unknown' ? 'Unattributed lines' : '';
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
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <CastFilter v-if="sorted.length" v-model="query" />
    <p v-if="query.trim() && !shown.size" class="muted" role="status">
      Nobody in the cast is called “{{ query.trim() }}”.
    </p>

    <div v-if="hasCharacters" class="match">
      <button type="button" :class="{ danger: matching }" @click="matchVoices" @blur="leaveMatch">
        {{ matching ? 'Confirm match' : 'Match voices to traits' }}
      </button>
      <p v-if="matching" class="warning" role="status">{{ matchText }}</p>
      <p v-if="matched" class="muted small done" role="status">Voices matched to traits.</p>
    </div>

    <ul class="cast">
      <li
        v-for="c in sorted"
        v-show="shown.has(c.id)"
        :key="c.id"
        class="card character"
        :style="{ '--tint': speakerTint(colors, c.id) }"
      >
        <div class="head">
          <span class="swatch" aria-hidden="true" />
          <div>
            <h2>{{ c.name }}</h2>
            <p class="muted small">
              <template v-if="roleLabel(c)">{{ roleLabel(c) }} · </template>
              <template v-if="usage && !usage.get(c.id)">not in any part yet</template>
              <template v-else>{{ count(usage?.get(c.id) ?? 0, 'line') }}</template>
              <template v-if="toldLabel(c)"> · {{ toldLabel(c) }}</template>
              <template v-if="c.aliases.length"> · also “{{ c.aliases.join('”, “') }}”</template>
            </p>
          </div>
          <button class="preview" :aria-label="`Preview ${c.name}’s voice`" @click="preview(c)">
            Preview
          </button>
        </div>

        <label>
          Voice
          <select
            :value="c.voice.voiceName ?? ''"
            @change="onVoicePicked(c, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">Device default ({{ c.voice.lang }})</option>
            <option v-if="resolved.get(c.id)?.substituted" :value="c.voice.voiceName">
              {{ c.voice.voiceName }} (not on this device)
            </option>
            <option v-for="v in voiceChoices" :key="v.name" :value="v.name">
              {{ v.label }}
            </option>
          </select>
        </label>
        <p v-if="resolved.get(c.id)?.substituted" class="substituted small">
          <span class="badge">Substituted</span>
          This voice isn't installed here, so
          {{ resolved.get(c.id)!.voiceName ?? `the default ${c.voice.lang} voice` }} reads instead,
          with the same pitch and speed.
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

        <details>
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
                v-for="l in memberLines.get(c.id)!.slice(0, linesShown.get(c.id) ?? LINES_PAGE)"
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
              Show more ({{ memberLines.get(c.id)!.length - (linesShown.get(c.id) ?? LINES_PAGE) }}
              left)
            </button>
          </template>
        </details>
      </li>
    </ul>
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

.character {
  display: grid;
  gap: 10px;
}

.head {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 12px;
  align-items: center;
}

.head h2 {
  font-size: 1.05rem;
  margin: 0;
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
