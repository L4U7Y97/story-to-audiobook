<script setup lang="ts">
/**
 * A member's other names. Its name, and merging it into someone else, are in the row's ⋯ menu.
 */
import { computed, ref, watch } from 'vue';
import type { Character } from '@/format/types';
import { parseAliases } from '@/cast/castOps';

const props = defineProps<{ character: Character; nameError?: string }>();
const emit = defineEmits<{
  save: [changes: { name: string; aliases: string[] }];
}>();

const aliases = ref(props.character.aliases.join(', '));
/*
 * The field follows the member's saved names (after a save, or names a merge brought) without the
 * editor being rebuilt, so focus stays where it was.
 */
watch(
  () => props.character.aliases.join(', '),
  (saved) => {
    aliases.value = saved;
  },
);

const narrator = computed(() => props.character.role === 'narrator');
const hintId = computed(() => `names-hint-${props.character.id}`);

function save() {
  const name = props.character.name;
  emit('save', { name, aliases: parseAliases(aliases.value, name) });
}
</script>

<template>
  <div class="editor">
    <form class="fields" @submit.prevent="save">
      <label>
        Other names (comma-separated)
        <input
          v-model="aliases"
          autocomplete="off"
          placeholder="e.g. Lizzy, Miss Bennet"
          :aria-describedby="narrator ? hintId : undefined"
        />
      </label>
      <p v-if="narrator" :id="hintId" class="hint">
        If one person tells the whole story, add the names others call them (e.g. Watson). If
        several characters take turns, leave the narrator unnamed (named “Narrator”, with no other
        names) and use “Told by” in the reader. Don’t use the author’s or reader’s name.
      </p>
      <p v-if="nameError" class="warning" role="alert">{{ nameError }}</p>
      <button type="submit">Save other names</button>
    </form>
  </div>
</template>

<style scoped>
.editor {
  padding-top: 8px;
}

.fields {
  display: grid;
  gap: 8px;
}

.fields button {
  justify-self: start;
}

.hint {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.warning {
  margin: 0;
  color: var(--warn);
  font-size: 0.9rem;
}
</style>
