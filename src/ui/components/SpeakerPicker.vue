<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { Character, Mode, Segment } from '@/format/types';

defineProps<{
  segment: Segment;
  text: string;
  cast: Character[];
  colors: Map<string, number>;
}>();
const emit = defineEmits<{
  pick: [choice: { speakerId: string; mode?: Mode }];
  create: [choice: { name: string; mode?: Mode }];
  close: [];
}>();

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'speech', label: 'Says' },
  { value: 'thought', label: 'Thinks' },
  { value: 'narration', label: 'Narrates' },
  { value: 'written', label: 'Reads out' },
];
/** Undefined = let the app choose (narrator narrates, characters speak). */
const mode = ref<Mode | undefined>();
const newName = ref('');
const sheet = ref<HTMLElement>();

onMounted(() => sheet.value?.focus());

function create() {
  const name = newName.value.trim();
  if (name) emit('create', { name, mode: mode.value });
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
      <h2 id="picker-title">Who reads this?</h2>
      <blockquote>{{ text.trim() }}</blockquote>

      <div class="modes" role="radiogroup" aria-label="How it is read">
        <button
          v-for="m in MODES"
          :key="m.value"
          type="button"
          role="radio"
          :aria-checked="mode === m.value"
          :class="{ active: mode === m.value }"
          @click="mode = mode === m.value ? undefined : m.value"
        >
          {{ m.label }}
        </button>
      </div>

      <ul class="people">
        <li v-for="c in cast" :key="c.id">
          <button
            type="button"
            :class="{ current: c.id === segment.speakerId }"
            :style="
              colors.has(c.id) ? { '--tint': `var(--speaker-${colors.get(c.id)})` } : undefined
            "
            @click="emit('pick', { speakerId: c.id, mode })"
          >
            <span class="swatch" aria-hidden="true" />{{ c.name }}
          </button>
        </li>
      </ul>

      <form class="new" @submit.prevent="create">
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
