<script setup lang="ts">
import type { Book } from '@/format/types';
import ActionsMenu from './ActionsMenu.vue';

withDefaults(defineProps<{ book: Book; partCount: number; reorderable?: boolean }>(), {
  reorderable: true,
});
defineEmits<{ rename: [title: string]; remove: [] }>();
</script>

<template>
  <ActionsMenu
    :title="book.title"
    noun="book"
    :reorderable="reorderable"
    :confirm-delete-label="
      partCount
        ? `Tap again to delete the book and its ${partCount} ${partCount === 1 ? 'part' : 'parts'}`
        : undefined
    "
    @rename="$emit('rename', $event)"
    @remove="$emit('remove')"
  />
</template>
