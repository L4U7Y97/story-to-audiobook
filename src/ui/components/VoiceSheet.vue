<script setup lang="ts">
/**
 * Picks a member's voice from the device's voices: each can be heard in the member's own line
 * before it is used, and says who in the cast already speaks with it.
 */
import { computed, onMounted, ref } from 'vue';
import type { Character } from '@/format/types';
import type { DeviceVoice } from '@/playback/engine';
import { spokenVoiceName } from '@/cast/assignVoices';
import { voiceProfile } from '@/cast/voiceProfile';
import { speakerTint } from '../speakerColors';

const props = defineProps<{
  member: Character;
  cast: Character[];
  colors: Map<string, number>;
  /** The voices to offer: the device's for the story's language. */
  voices: DeviceVoice[];
  /** Every device voice, to tell which one each member really speaks with. */
  deviceVoices: DeviceVoice[];
  /** Plays the member's line in a voice ('' the device default) without saving it. */
  audition: (voiceName: string) => Promise<void>;
  stop: () => Promise<void>;
}>();
const emit = defineEmits<{ use: [voiceName: string]; close: [] }>();

const sheet = ref<HTMLElement>();
onMounted(() => sheet.value?.focus());

/** "Microsoft Zira - English (United States)" → "Zira"; other names stay as they are. */
function shortName(name: string): string {
  return name.replace(/^(Microsoft|Google|Apple)\s+/u, '').replace(/\s+[-(].*$/u, '') || name;
}
/** "en-GB" → "UK", "en-US" → "US". */
function accent(lang: string): string | undefined {
  const region = lang.split(/[-_]/u)[1]?.toUpperCase();
  return region === 'GB' ? 'UK' : region;
}

const DEFAULT = '';
/** Who speaks with each voice on this device, by voice name ('' for the device default). */
const users = computed(() => {
  const by = new Map<string, Character[]>();
  for (const c of props.cast) {
    const name = c.voice.voiceName ? (spokenVoiceName(c.voice, props.deviceVoices) ?? '') : DEFAULT;
    by.set(name, [...(by.get(name) ?? []), c]);
  }
  return by;
});
const rows = computed(() => [
  {
    name: DEFAULT,
    title: 'Device default',
    tags: [props.member.voice.lang],
    full: '',
  },
  ...props.voices.map((v) => ({
    name: v.name,
    title: shortName(v.name),
    tags: [voiceProfile(v).gender, accent(v.lang), v.network ? 'online' : undefined].filter(
      (t): t is string => !!t,
    ),
    full: v.name === shortName(v.name) ? '' : v.name,
  })),
]);
const chosen = computed(() => props.member.voice.voiceName ?? DEFAULT);
const others = (name: string) =>
  (users.value.get(name) ?? []).filter((c) => c.id !== props.member.id);

/** The voice being heard; its button stops it. */
const hearing = ref<string>();
let run = 0;
async function hear(name: string) {
  if (hearing.value === name) {
    run++;
    hearing.value = undefined;
    return props.stop();
  }
  const mine = ++run;
  hearing.value = name;
  try {
    await props.audition(name);
  } finally {
    if (mine === run) hearing.value = undefined;
  }
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <section
      ref="sheet"
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-sheet-title"
      tabindex="-1"
      @keydown.esc="emit('close')"
    >
      <h2 id="voice-sheet-title">Voice for {{ member.name }}</h2>
      <p class="note">Hear a voice in {{ member.name }}’s line before you use it.</p>

      <ul class="voices">
        <li
          v-for="r in rows"
          :key="r.name"
          :data-voice="r.name"
          :class="{ current: r.name === chosen }"
        >
          <div class="info">
            <span class="title">
              {{ r.title }}
              <span v-if="r.tags.length" class="tags">{{ r.tags.join(' · ') }}</span>
            </span>
            <span v-if="r.full" class="full">{{ r.full }}</span>
            <span v-if="others(r.name).length" class="users">
              Also
              <template v-for="(c, i) in others(r.name)" :key="c.id"
                ><template v-if="i">, </template
                ><span class="who" :style="{ '--tint': speakerTint(colors, c.id) }"
                  ><span class="swatch" aria-hidden="true" />{{ c.name }}</span
                ></template
              >
            </span>
          </div>
          <button
            type="button"
            class="hear"
            :aria-label="`Hear ${r.title}`"
            :aria-pressed="hearing === r.name"
            @click="hear(r.name)"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <rect
                v-if="hearing === r.name"
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
          <span v-if="r.name === chosen" class="in-use">In use</span>
          <button v-else type="button" class="use" @click="emit('use', r.name)">Use</button>
        </li>
      </ul>

      <button type="button" class="close" @click="emit('close')">Done</button>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 40%);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 20;
}

.sheet {
  background: var(--surface);
  width: 100%;
  max-width: 720px;
  max-height: 85vh;
  overflow-y: auto;
  border-radius: var(--radius) var(--radius) 0 0;
  padding: var(--gutter);
  padding-bottom: calc(var(--gutter) + env(safe-area-inset-bottom));
  display: grid;
  gap: 12px;
}

.sheet h2 {
  margin: 0;
}

.note {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.voices {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.voices li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px 64px;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.voices li.current {
  border-color: var(--accent);
}

.info {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.title {
  font-weight: 600;
}

.tags {
  margin-inline-start: 6px;
  font-weight: 400;
  font-size: 0.85rem;
  color: var(--muted);
}

.full,
.users {
  font-size: 0.8rem;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.who {
  white-space: nowrap;
}

.swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-inline-end: 4px;
  border-radius: 50%;
  background: var(--tint, var(--muted));
}

.hear {
  width: 44px;
  padding: 0;
  border-radius: 50%;
}

.hear[aria-pressed='true'] {
  border-color: var(--accent);
  color: var(--accent);
}

.use {
  padding: 0;
}

.in-use {
  text-align: center;
  font-size: 0.85rem;
  color: var(--accent);
  font-weight: 600;
}

.close {
  justify-self: end;
}
</style>
