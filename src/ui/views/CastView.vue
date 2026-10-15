<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Character, VoiceSettings } from '@/format/types';
import { voicesForLang, type DeviceVoice } from '@/playback/engine';
import { getAppDb } from '@/storage/db';
import { defaultLocale, getStory, updateStory } from '@/storage/stories';
import { mergeCharactersInStory } from '@/storage/cast';
import { castUsage, renameCharacter, setAliases } from '@/cast/castOps';
import { resolveVoice } from '@/cast/resolveVoice';
import CharacterEditor from '../components/CharacterEditor.vue';
import { useLiveQuery } from '../composables/useLiveQuery';
import { getEngine, usePlayer } from '../composables/usePlayer';
import { speakerColorIndex } from '../speakerColors';

const props = defineProps<{ id: string }>();
const db = getAppDb();
const { player } = usePlayer(props.id);

const { data: story } = useLiveQuery(() => getStory(db, props.id), [() => props.id]);
/** Segment count per character across all analysed parts. */
const { data: usage } = useLiveQuery(async () => {
  const s = await getStory(db, props.id);
  return castUsage(await db.analyses.bulkGet(s?.partIds ?? []));
}, [() => props.id]);
const error = ref('');

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
    player.castChanged();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function roleLabel(c: Character): string {
  return c.role === 'narrator' ? 'Narrator' : c.role === 'unknown' ? 'Unattributed lines' : '';
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

    <ul class="cast">
      <li
        v-for="c in sorted"
        :key="c.id"
        class="card character"
        :style="colors.has(c.id) ? { '--tint': `var(--speaker-${colors.get(c.id)})` } : undefined"
      >
        <div class="head">
          <span class="swatch" aria-hidden="true" />
          <div>
            <h2>{{ c.name }}</h2>
            <p class="muted small">
              <template v-if="roleLabel(c)">{{ roleLabel(c) }} · </template>
              <template v-if="usage && !usage.get(c.id)">not in any part yet</template>
              <template v-else>{{ usage?.get(c.id) ?? 0 }} lines</template>
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
            @save="saveNames(c, $event)"
            @merge="merge(c, $event)"
          />
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

.sliders input {
  padding: 0;
  border: 0;
  background: none;
}
</style>
