<script setup lang="ts">
import { ref } from 'vue';
import type { Book, Part } from '@/format/types';

/** `books`: the story's books, when it has more than one (offers moving the part between them). */
const props = defineProps<{
  part: Part;
  first: boolean;
  last: boolean;
  hasKey: boolean;
  books?: Book[];
}>();
const emit = defineEmits<{
  rename: [title: string];
  move: [delta: number];
  moveToBook: [bookId: string];
  replace: [];
  /** No method: Claude when a key is set (after a cost estimate), otherwise the free method. */
  reanalyse: [method?: 'heuristic'];
  remove: [];
}>();

const renaming = ref(false);
const title = ref(props.part.title);
const confirmDelete = ref(false);
const menu = ref<HTMLDetailsElement>();

function close() {
  if (menu.value) menu.value.open = false;
  confirmDelete.value = false;
}

function act(fn: () => void) {
  fn();
  close();
}

function saveTitle() {
  const t = title.value.trim();
  if (t) emit('rename', t);
  renaming.value = false;
  close();
}

function remove() {
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    return;
  }
  act(() => emit('remove'));
}
</script>

<template>
  <details ref="menu" class="actions" @toggle="confirmDelete = false">
    <summary :aria-label="`Actions for ${part.title}`">⋯</summary>
    <div class="menu" role="menu">
      <form v-if="renaming" class="rename" @submit.prevent="saveTitle">
        <input v-model="title" aria-label="Part title" />
        <button type="submit">Save</button>
      </form>
      <button v-else role="menuitem" @click="renaming = true">Rename</button>
      <button role="menuitem" :disabled="first" @click="act(() => emit('move', -1))">
        Move up
      </button>
      <button role="menuitem" :disabled="last" @click="act(() => emit('move', 1))">
        Move down
      </button>
      <template v-for="b in books ?? []" :key="b.id">
        <button
          v-if="b.id !== part.bookId"
          role="menuitem"
          @click="act(() => emit('moveToBook', b.id))"
        >
          Move to “{{ b.title }}”
        </button>
      </template>
      <button role="menuitem" @click="act(() => emit('replace'))">Replace text…</button>
      <template v-if="part.analysisStatus === 'done'">
        <button role="menuitem" @click="act(() => emit('reanalyse'))">
          {{ hasKey ? 'Analyse again with Claude…' : 'Analyse again' }}
        </button>
        <button v-if="hasKey" role="menuitem" @click="act(() => emit('reanalyse', 'heuristic'))">
          Analyse again (free method)
        </button>
      </template>
      <button role="menuitem" :class="{ danger: confirmDelete }" @click="remove">
        {{ confirmDelete ? 'Tap again to delete' : 'Delete' }}
      </button>
    </div>
  </details>
</template>

<style scoped>
.actions {
  position: relative;
}

summary {
  list-style: none;
  cursor: pointer;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.3rem;
  border-radius: var(--radius);
}

summary::-webkit-details-marker {
  display: none;
}

.menu {
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 5;
  min-width: 200px;
  display: grid;
  gap: 4px;
  padding: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
}

.menu button {
  justify-content: flex-start;
  border-color: transparent;
}

.rename {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px;
}

.danger {
  color: var(--danger);
  border-color: var(--danger) !important;
}
</style>
