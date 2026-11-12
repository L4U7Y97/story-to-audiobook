<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Character, VoiceSettings } from '@/format/types';
import { voicesForLang, type DeviceVoice } from '@/playback/engine';
import { getAppDb } from '@/storage/db';
import { defaultLocale, getStory, updateStory } from '@/storage/stories';
import { listParts } from '@/storage/parts';
import { mergeCharactersInStory } from '@/storage/cast';
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
import { resolveVoice } from '@/cast/resolveVoice';
import CastFilter from '../components/CastFilter.vue';
import CharacterEditor from '../components/CharacterEditor.vue';
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

const deviceVoices = ref<DeviceVoice[]>([]);
onMounted(async () => {
  deviceVoices.value = await getEngine().listVoices();
});
const locale = computed(() => (story.value ? defaultLocale(story.value.lang) : 'en-US'));
const voiceChoices = computed(() => {
  const forLang = voicesForLang(deviceVoices.value, locale.value);
  return forLang.length ? forLang : deviceVoices.value;
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

async function setVoice(character: Character, changes: Partial<VoiceSettings>) {
  const s = story.value;
  if (!s) return;
  const cast = s.cast.map((c) =>
    c.id === character.id ? { ...c, voice: { ...c.voice, ...changes } } : c,
  );
  await updateStory(db, s.id, { cast });
  player.castChanged();
}

function onVoicePicked(character: Character, name: string) {
  const voice = deviceVoices.value.find((v) => v.name === name);
  void setVoice(
    character,
    voice ? { voiceName: voice.name, lang: voice.lang } : { voiceName: undefined },
  );
}

async function preview(character: Character) {
  const sample =
    story.value?.lang === 'es' ? `Hola, soy ${character.name}.` : `Hello, I am ${character.name}.`;
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

function roleLabel(c: Character): string {
  return c.role === 'narrator'
    ? 'Narrator · reads the story unless a part or passage is told by a character'
    : c.role === 'unknown'
      ? 'Unattributed lines'
      : '';
}

function toldLabel(c: Character): string {
  const parts = c.role === 'narrator' ? 0 : (told.value.get(c.id) ?? 0);
  return parts === 0 ? '' : `tells ${parts} ${parts === 1 ? 'part' : 'parts'}`;
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
              <template v-else>{{ usage?.get(c.id) ?? 0 }} lines</template>
              <template v-if="toldLabel(c)"> · {{ toldLabel(c) }}</template>
              <template v-if="c.aliases.length"> · also “{{ c.aliases.join('”, “') }}”</template>
            </p>
          </div>
          <button class="preview" @click="preview(c)">Preview</button>
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
              {{ v.name }}{{ v.network ? ' (online)' : '' }}
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
          <label>
            Pitch {{ c.voice.pitch.toFixed(2) }}
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.05"
              :value="c.voice.pitch"
              @change="setVoice(c, { pitch: Number(($event.target as HTMLInputElement).value) })"
            />
          </label>
          <label>
            Speed {{ c.voice.rate.toFixed(2) }}
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.05"
              :value="c.voice.rate"
              @change="setVoice(c, { rate: Number(($event.target as HTMLInputElement).value) })"
            />
          </label>
        </div>

        <details>
          <summary>Edit names or merge</summary>
          <CharacterEditor
            :key="c.name + c.aliases.join()"
            :character="c"
            :cast="story?.cast ?? []"
            :name-error="nameClash?.id === c.id ? clashText : undefined"
            @save="saveNames(c, $event)"
            @merge="merge(c, $event)"
          />
        </details>

        <details v-if="usage?.get(c.id)" class="lines" @toggle="onLinesToggle(c, $event)">
          <summary>See {{ c.name }}’s lines</summary>
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

.sliders {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 0.9rem;
  min-height: 32px;
  display: flex;
  align-items: center;
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

.sliders input {
  padding: 0;
  border: 0;
  background: none;
}
</style>
