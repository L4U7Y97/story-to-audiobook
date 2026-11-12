<script setup lang="ts">
/** A search box that narrows a cast list by name or other names (filterCast). */
import { ref } from 'vue';

withDefaults(defineProps<{ label?: string }>(), { label: 'Find in cast' });
const query = defineModel<string>({ required: true });
const input = ref<HTMLInputElement>();

function onInput(event: Event) {
  if (event.target instanceof HTMLInputElement) query.value = event.target.value;
}

/** The clear button goes with the text, so focus moves back to the box rather than the page. */
function clear() {
  query.value = '';
  input.value?.focus();
}

/** Esc clears the search first; on an empty box it does what Esc does around it (closes a sheet). */
function onEscape(event: KeyboardEvent) {
  if (!query.value) return;
  event.stopPropagation();
  query.value = '';
}
</script>

<template>
  <div class="cast-filter" role="search">
    <input
      ref="input"
      :value="query"
      type="search"
      :aria-label="label"
      :placeholder="label"
      autocomplete="off"
      enterkeyhint="search"
      @input="onInput"
      @keydown.esc="onEscape"
    />
    <button v-if="query" type="button" class="clear" aria-label="Clear search" @click="clear">
      ×
    </button>
  </div>
</template>

<style scoped>
.cast-filter {
  position: relative;
}

.cast-filter input {
  padding-right: 44px;
}

/* The browser's own clear button would sit next to ours. */
.cast-filter input::-webkit-search-cancel-button {
  appearance: none;
}

.clear {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 44px;
  padding: 0;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 1.3rem;
  justify-content: center;
}
</style>
