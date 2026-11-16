<script setup lang="ts">
import type { Book, Part } from '@/format/types';
import ActionsMenu from './ActionsMenu.vue';

/** `books`: the story's books, when it has more than one (offers moving the part between them). */
defineProps<{
  part: Part;
  hasKey: boolean;
  books?: Book[];
}>();
const emit = defineEmits<{
  rename: [title: string];
  moveToBook: [bookId: string];
  replace: [];
  /** No method: Claude when a key is set (after a cost estimate), otherwise the free method. */
  reanalyse: [method?: 'heuristic'];
  remove: [];
}>();
</script>

<template>
  <ActionsMenu
    :title="part.title"
    noun="part"
    @rename="emit('rename', $event)"
    @remove="emit('remove')"
  >
    <template #default="{ act }">
      <template v-for="book in books ?? []" :key="book.id">
        <button
          v-if="book.id !== part.bookId"
          role="menuitem"
          @click="act(() => emit('moveToBook', book.id))"
        >
          Move to “{{ book.title }}”
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
    </template>
  </ActionsMenu>
</template>
