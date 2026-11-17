<script setup lang="ts">
/**
 * "Same person as…" for a character: pick who it really is, compare a line of each, and choose
 * whose name and whose voice the one left keeps. For the narrator or the unknown speaker, which
 * always stay, "Give all these lines to…": pick who reads them. Either can be undone on the page.
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { Character } from '@/format/types';
import { isDefaultName } from '@/analysis/castMatch';
import { filterCast } from '@/cast/castOps';
import { speakerTint } from '../speakerColors';
import CastFilter from './CastFilter.vue';

const props = defineProps<{
  member: Character;
  cast: Character[];
  colors: Map<string, number>;
  /** Lines per member. */
  lines: ReadonlyMap<string, number>;
  /** A member's first line, as text, or '' when it has none. */
  firstLine: (c: Character) => string;
  /** A member's voice, in words ("Zira · female · US"). */
  voiceOf: (c: Character) => string;
}>();
const emit = defineEmits<{
  merge: [choice: { fromId: string; intoId: string; voiceOf: string }];
  close: [];
}>();

const sheet = ref<HTMLElement>();
onMounted(() => sheet.value?.focus());

const query = ref('');
const others = computed(() => props.cast.filter((c) => c.id !== props.member.id));
const shown = computed(() => filterCast(others.value, query.value));
const targetId = ref<string>();
const target = computed(() => others.value.find((c) => c.id === targetId.value));

/** Whose name the one left has, and whose voice: the target's unless chosen otherwise. */
const keepName = ref<'member' | 'target'>('target');
const keepVoice = ref<'member' | 'target'>('target');
/** Only two characters can go either way: the narrator and the unknown speaker always stay. */
/** The narrator's or the unknown speaker's lines are given away; they stay in the cast. */
const give = computed(() => props.member.role !== 'character');
const eitherWay = computed(() => !give.value && target.value?.role === 'character');
/** A narrator's names go with its lines (see mergeCharacters). */
const namesMove = computed(
  () =>
    props.member.role === 'narrator' &&
    (props.member.aliases.length > 0 || !isDefaultName(props.member.name, 'narrator')),
);
watch(targetId, () => {
  keepName.value = 'target';
  keepVoice.value = 'target';
});
// The voice follows the name kept, until chosen otherwise.
watch(keepName, (name) => (keepVoice.value = name));

const plan = computed(() => {
  const t = target.value;
  if (!t) return undefined;
  const [from, into] = keepName.value === 'target' ? [props.member, t] : [t, props.member];
  const voice = keepVoice.value === 'target' ? t : props.member;
  return { from, into, voice };
});
const count = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;

function merge() {
  const p = plan.value;
  if (p) emit('merge', { fromId: p.from.id, intoId: p.into.id, voiceOf: p.voice.id });
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <section
      ref="sheet"
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="merge-sheet-title"
      tabindex="-1"
      @keydown.esc="emit('close')"
    >
      <h2 id="merge-sheet-title">
        <template v-if="!give">{{ member.name }} is the same person as…</template>
        <template v-else-if="member.role === 'narrator'">
          Give all of {{ member.name }}’s lines, in every part, to…
        </template>
        <template v-else>Give all of {{ member.name }}’s lines to…</template>
      </h2>

      <CastFilter v-model="query" label="Find someone" />
      <p v-if="query.trim() && !shown.length" class="note" role="status">
        Nobody else in the cast is called “{{ query.trim() }}”.
      </p>
      <ul class="people">
        <li v-for="c in shown" :key="c.id">
          <button
            type="button"
            :aria-pressed="c.id === targetId"
            :style="{ '--tint': speakerTint(colors, c.id) }"
            @click="targetId = c.id"
          >
            <span class="swatch" aria-hidden="true" />{{ c.name }}
          </button>
        </li>
      </ul>

      <template v-if="target && plan">
        <div class="compare">
          <div
            v-for="c in [member, target]"
            :key="c.id"
            class="side"
            :style="{ '--tint': speakerTint(colors, c.id) }"
          >
            <span class="who">{{ c.name }}</span>
            <span class="note">{{ count(lines.get(c.id) ?? 0) }} · {{ voiceOf(c) }}</span>
            <q v-if="firstLine(c)">{{ firstLine(c) }}</q>
          </div>
        </div>

        <fieldset v-if="eitherWay" class="keep">
          <legend>Keep the name</legend>
          <label>
            <input
              v-model="keepName"
              type="radio"
              :name="`keep-name-${member.id}`"
              value="target"
            />
            {{ target.name }}
          </label>
          <label>
            <input
              v-model="keepName"
              type="radio"
              :name="`keep-name-${member.id}`"
              value="member"
            />
            {{ member.name }}
          </label>
        </fieldset>
        <!-- The narrator and the unknown speaker keep their own voice: it reads far more. -->
        <fieldset v-if="eitherWay" class="keep">
          <legend>Keep the voice</legend>
          <label>
            <input
              v-model="keepVoice"
              type="radio"
              :name="`keep-voice-${member.id}`"
              value="target"
            />
            {{ target.name }}’s: {{ voiceOf(target) }}
          </label>
          <label>
            <input
              v-model="keepVoice"
              type="radio"
              :name="`keep-voice-${member.id}`"
              value="member"
            />
            {{ member.name }}’s: {{ voiceOf(member) }}
          </label>
        </fieldset>

        <p v-if="give" class="note">
          All of these lines will be read by “{{ target.name }}”.
          <template v-if="namesMove"> The narrator’s names move to “{{ target.name }}”.</template>
          <template v-if="member.role === 'narrator' && target.role === 'character'">
            If {{ target.name }} tells the whole story, use “Same person as…” in {{ target.name }}’s
            ⋯ menu and choose {{ member.name }} instead.
          </template>
          You can undo this.
        </p>
        <p v-else class="note">
          “{{ plan.from.name }}” will be removed, and all their lines read by “{{ plan.into.name }}”
          with {{ plan.voice.id === plan.into.id ? 'their own' : `${plan.voice.name}’s` }} voice.
          The other names move with them. You can undo this.
        </p>
      </template>

      <div class="row">
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="button" class="primary" :disabled="!plan" @click="merge">Merge</button>
      </div>
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
  max-height: 92vh;
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

.people {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 6px;
  max-height: 30vh;
  overflow-y: auto;
}

.people button {
  width: 100%;
  justify-content: flex-start;
  gap: 8px;
}

.people [aria-pressed='true'] {
  border-color: var(--tint, var(--accent));
  font-weight: 600;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--tint, var(--muted));
  flex: none;
}

/* The two side by side, each with a line of theirs, so it shows whether they are one person. */
.compare {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.side {
  display: grid;
  align-content: start;
  gap: 4px;
  padding: 8px 10px;
  border-inline-start: 3px solid var(--tint, var(--muted));
  border-radius: 8px;
  background: color-mix(in srgb, var(--tint, var(--accent)) 8%, transparent);
}

.who {
  font-weight: 600;
}

.side q {
  font-size: 0.9rem;
}

.keep {
  margin: 0;
  padding: 0;
  border: none;
  display: grid;
  gap: 2px;
}

.keep legend {
  padding: 0;
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 0.9rem;
}

.keep label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  color: var(--fg);
}

.keep input {
  flex: none;
  width: 18px;
  height: 18px;
  margin: 0;
}

/* Cancel and Merge stay in view at the bottom while the sheet scrolls. */
.row {
  position: sticky;
  bottom: calc(-1 * (var(--gutter) + env(safe-area-inset-bottom)));
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 0 calc(-1 * var(--gutter)) calc(-1 * (var(--gutter) + env(safe-area-inset-bottom)));
  padding: 8px var(--gutter) calc(var(--gutter) + env(safe-area-inset-bottom));
  background: var(--surface);
  border-top: 1px solid var(--border);
}
</style>
