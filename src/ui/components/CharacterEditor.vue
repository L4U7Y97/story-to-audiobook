<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Character } from '@/format/types';
import { isDefaultName } from '@/analysis/castMatch';
import { parseAliases } from '@/cast/castOps';

const props = defineProps<{ character: Character; cast: Character[]; nameError?: string }>();
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
/** Long casts get a filter so the target is found by typing instead of scrolling the list. */
const filterable = computed(() => others.value.length > 6);
const filter = ref('');
const selectId = computed(() => `merge-into-${props.character.id}`);
/** Characters whose name or other names contain the filter text. */
const found = computed(() => {
  const query = filter.value.trim().toLowerCase();
  if (!query) return others.value;
  return others.value.filter((c) =>
    [c.name, ...c.aliases].some((n) => n.toLowerCase().includes(query)),
  );
});
/** The list shown: the matches, keeping the chosen character so the select never goes blank. */
const options = computed(() =>
  target.value && !found.value.includes(target.value)
    ? [target.value, ...found.value]
    : found.value,
);

function onFilter() {
  // A filter down to one character picks it, saving a trip through the list.
  if (found.value.length === 1) mergeInto.value = found.value[0]!.id;
  confirming.value = false;
}
const removable = computed(() => props.character.role === 'character');
const narrator = computed(() => props.character.role === 'narrator');
/** A merge moves the names the narrator was given (see mergeCharacters). */
const namesMove = computed(
  () =>
    narrator.value &&
    (props.character.aliases.length > 0 || !isDefaultName(props.character.name, 'narrator')),
);
const hintId = computed(() => `names-hint-${props.character.id}`);
const mergeHintId = computed(() => `merge-hint-${props.character.id}`);

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
      <button type="submit">Save names</button>
    </form>

    <div class="merge">
      <label :for="selectId">
        {{
          removable
            ? 'Same person as…'
            : narrator
              ? 'Give all these lines, in every part, to…'
              : 'Give all these lines to…'
        }}
      </label>
      <div class="pick">
        <input
          v-if="filterable"
          v-model="filter"
          type="search"
          autocomplete="off"
          placeholder="Filter by name"
          aria-label="Filter characters by name"
          @input="onFilter"
        />
        <select :id="selectId" v-model="mergeInto" @change="confirming = false">
          <option value="">
            {{ found.length ? 'Choose a character' : 'No character matches' }}
          </option>
          <option v-for="c in options" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <p v-if="narrator && target?.role === 'character'" class="hint">
        If {{ target.name }} tells the whole story, open {{ target.name }}’s card and use “Same
        person as… {{ character.name }}” instead.
      </p>
      <p v-if="confirming && target" class="warning" role="status">
        <template v-if="removable">
          “{{ character.name }}” will be removed and all their lines read by “{{ target.name }}”.
        </template>
        <template v-else>All of these lines will be read by “{{ target.name }}”.</template>
        <template v-if="namesMove"> The narrator’s names move to “{{ target.name }}”.</template>
        Press again to confirm.
      </p>
      <button
        :disabled="!mergeInto"
        :class="{ danger: confirming }"
        :aria-describedby="mergeInto ? undefined : mergeHintId"
        @click="merge"
      >
        {{ confirming ? 'Confirm merge' : 'Merge' }}
      </button>
      <p v-if="!mergeInto" :id="mergeHintId" class="hint">Choose a character first.</p>
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
.merge,
.pick {
  display: grid;
  gap: 8px;
}

.fields button,
.merge button {
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

.danger {
  border-color: var(--danger);
  color: var(--danger);
}
</style>
