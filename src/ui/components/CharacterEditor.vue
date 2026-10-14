<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Character } from '@/format/types';
import { parseAliases } from '@/cast/castOps';

const props = defineProps<{ character: Character; cast: Character[] }>();
const emit = defineEmits<{
  save: [changes: { name: string; aliases: string[] }];
  merge: [intoId: string];
}>();

const name = ref(props.character.name);
const aliases = ref(props.character.aliases.join(', '));
const mergeInto = ref('');
const confirming = ref(false);

const others = computed(() => props.cast.filter((c) => c.id !== props.character.id));
const target = computed(() => others.value.find((c) => c.id === mergeInto.value));
const removable = computed(() => props.character.role === 'character');

function save() {
  emit('save', { name: name.value, aliases: parseAliases(aliases.value, name.value) });
}

function merge() {
  if (!confirming.value) {
    confirming.value = true;
    return;
  }
  emit('merge', mergeInto.value);
  confirming.value = false;
}
</script>

<template>
  <div class="editor">
    <form class="fields" @submit.prevent="save">
      <label>
        Name
        <input v-model="name" autocomplete="off" />
      </label>
      <label>
        Other names (comma-separated)
        <input v-model="aliases" autocomplete="off" placeholder="e.g. Lizzy, Miss Bennet" />
      </label>
      <button type="submit">Save names</button>
    </form>

    <div class="merge">
      <label>
        {{ removable ? 'Same person as…' : 'Give all these lines to…' }}
        <select v-model="mergeInto" @change="confirming = false">
          <option value="">Choose a character</option>
          <option v-for="c in others" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </label>
      <p v-if="confirming && target" class="warning" role="alert">
        <template v-if="removable">
          “{{ character.name }}” will be removed and all their lines read by “{{ target.name }}”.
        </template>
        <template v-else>All of these lines will be read by “{{ target.name }}”.</template>
        Press again to confirm.
      </p>
      <button :disabled="!mergeInto" :class="{ danger: confirming }" @click="merge">
        {{ confirming ? 'Confirm merge' : 'Merge' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.editor {
  display: grid;
  gap: 16px;
  padding-top: 8px;
}

.fields,
.merge {
  display: grid;
  gap: 8px;
}

.fields button,
.merge button {
  justify-self: start;
}

.warning {
  margin: 0;
  color: var(--warn);
  font-size: 0.9rem;
}

.danger {
  border-color: var(--danger);
  color: var(--danger);
}
</style>
