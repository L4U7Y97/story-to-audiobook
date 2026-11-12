<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Character, Mode, Segment } from '@/format/types';
import { filterCast } from '@/cast/castOps';
import { speakerTint } from '../speakerColors';
import CastFilter from './CastFilter.vue';

/** Which lines a choice covers (see ReassignScope); 'range' ends at a line tapped next. */
export type PickScope = 'line' | 'following' | 'part' | 'range';

const props = withDefaults(
  defineProps<{
    segment: Segment;
    text: string;
    cast: Character[];
    colors: Map<string, number>;
    /** Lines by this line's speaker from this one to the end of the part, and in all of it. */
    counts: { following: number; part: number };
    initialScope?: PickScope;
    /** The mode preselected; none when how the line reads depends on who is picked. */
    defaultMode?: Mode;
    title?: string;
  }>(),
  { initialScope: 'line', defaultMode: undefined, title: 'Who reads this?' },
);
const emit = defineEmits<{
  pick: [choice: { speakerId: string; mode?: Mode; scope: PickScope }];
  create: [choice: { name: string; mode?: Mode; scope: PickScope }];
  close: [];
}>();

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'speech', label: 'Says' },
  { value: 'thought', label: 'Thinks' },
  { value: 'narration', label: 'Narrates' },
  { value: 'written', label: 'Reads out' },
];
/** Undefined = the app chooses: defaultMode (reassign.ts) for the person picked. */
const mode = ref<Mode | undefined>(props.defaultMode);
const scope = ref<PickScope>(props.initialScope);
const newName = ref('');
const query = ref('');
const shown = computed(() => filterCast(props.cast, query.value));
const sheet = ref<HTMLElement>();

const speaker = computed(
  () => props.cast.find((c) => c.id === props.segment.speakerId)?.name ?? '',
);
const scopes = computed((): Array<{ value: PickScope; label: string }> => [
  { value: 'line', label: 'Only this line' },
  {
    value: 'following',
    label: `This and the following lines by ${speaker.value} (${props.counts.following})`,
  },
  { value: 'part', label: `Every line by ${speaker.value} in this part (${props.counts.part})` },
  { value: 'range', label: 'From this line to one I tap next…' },
]);
/** A mode is chosen for one line; wider scopes keep how each line is read. */
const oneLine = computed(() => scope.value === 'line');

onMounted(() => sheet.value?.focus());

function choice(): { mode?: Mode; scope: PickScope } {
  return { mode: oneLine.value ? mode.value : undefined, scope: scope.value };
}

function create(name = newName.value.trim()) {
  if (name) emit('create', { name, ...choice() });
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <section
      ref="sheet"
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="picker-title"
      tabindex="-1"
      @keydown.esc="emit('close')"
    >
      <h2 id="picker-title">{{ title }}</h2>
      <blockquote>{{ text.trim() }}</blockquote>

      <fieldset v-if="counts.part > 1" class="scopes">
        <legend>Which lines?</legend>
        <label v-for="s in scopes" :key="s.value">
          <input v-model="scope" type="radio" name="scope" :value="s.value" />
          {{ s.label }}
        </label>
      </fieldset>

      <div class="modes" role="radiogroup" aria-label="How it is read">
        <button
          v-for="m in MODES"
          :key="m.value"
          type="button"
          role="radio"
          :aria-checked="oneLine && mode === m.value"
          :class="{ active: oneLine && mode === m.value }"
          :disabled="!oneLine"
          @click="mode = mode === m.value ? undefined : m.value"
        >
          {{ m.label }}
        </button>
      </div>
      <p v-if="!oneLine" class="note">Each line keeps how it is read.</p>
      <p v-else-if="!mode && !defaultMode" class="note">
        Not chosen: the narrator, or someone who already narrates in this part, narrates it; anyone
        else says it.
      </p>

      <CastFilter v-model="query" label="Find someone" />
      <p v-if="query.trim() && !shown.length" class="note" role="status">
        Nobody in the cast is called “{{ query.trim() }}”.
        <button type="button" class="add-typed" @click="create(query.trim())">
          Add “{{ query.trim() }}”
        </button>
      </p>

      <ul class="people">
        <li v-for="c in shown" :key="c.id">
          <button
            type="button"
            :class="{ current: c.id === segment.speakerId }"
            :style="{ '--tint': speakerTint(colors, c.id) }"
            @click="emit('pick', { speakerId: c.id, ...choice() })"
          >
            <span class="swatch" aria-hidden="true" />{{ c.name }}
          </button>
        </li>
      </ul>

      <form class="new" @submit.prevent="create()">
        <label>
          New character
          <input v-model="newName" autocomplete="off" placeholder="Name" />
        </label>
        <button type="submit" :disabled="!newName.trim()">Add</button>
      </form>

      <button type="button" class="cancel" @click="emit('close')">Cancel</button>
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

blockquote {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--border);
  color: var(--muted);
  max-height: 6em;
  overflow: hidden;
}

.scopes {
  border: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 2px;
}

.scopes legend {
  padding: 0;
  margin-bottom: 4px;
}

.scopes label {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 44px;
}

.scopes input {
  flex: none;
}

.modes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.modes .active {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.note {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.add-typed {
  margin-left: 6px;
}

.people {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 6px;
}

.people button {
  width: 100%;
  justify-content: flex-start;
  gap: 8px;
}

.people .current {
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

.new {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: end;
}

.cancel {
  justify-self: end;
}
</style>
