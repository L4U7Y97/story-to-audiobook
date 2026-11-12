<script setup lang="ts">
import { ref } from 'vue';
import type { Book } from '@/format/types';

const props = defineProps<{ book: Book; first: boolean; last: boolean; partCount: number }>();
const emit = defineEmits<{ rename: [title: string]; move: [delta: number]; remove: [] }>();

const renaming = ref(false);
const title = ref(props.book.title);
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
    <summary :aria-label="`Actions for ${book.title}`">⋯</summary>
    <div class="menu" role="menu">
      <form v-if="renaming" class="rename" @submit.prevent="saveTitle">
        <input v-model="title" aria-label="Book title" />
        <button type="submit">Save</button>
      </form>
      <button v-else role="menuitem" @click="renaming = true">Rename</button>
      <button role="menuitem" :disabled="first" @click="act(() => emit('move', -1))">
        Move book up
      </button>
      <button role="menuitem" :disabled="last" @click="act(() => emit('move', 1))">
        Move book down
      </button>
      <button role="menuitem" :class="{ danger: confirmDelete }" @click="remove">
        {{
          confirmDelete
            ? partCount
              ? `Tap again to delete the book and its ${partCount} ${partCount === 1 ? 'part' : 'parts'}`
              : 'Tap again to delete'
            : 'Delete book'
        }}
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
  z-index: 6;
  min-width: 220px;
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
