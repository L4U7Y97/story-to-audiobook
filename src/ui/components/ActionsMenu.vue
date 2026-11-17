<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import type { VNode } from 'vue';

/**
 * The ⋮ menu of a list item: Rename, any item-specific actions (default slot), then Delete with a
 * second tap to confirm. Its button is also the item's keyboard and drag handle when reorderable.
 */
const props = withDefaults(
  defineProps<{
    /** The item's current title. */
    title: string;
    /** What the item is, in lower case ("book", "part"). */
    noun: string;
    /** The rename field's label, when it is not "<Noun> title". */
    fieldLabel?: string;
    /** The delete action's label, when it is not "Delete <noun>". */
    deleteLabel?: string;
    /** The second-tap delete label, when deleting removes more than the item. */
    confirmDeleteLabel?: string;
    reorderable?: boolean;
    /** Whether the item can be deleted; when not, the menu has no Delete. */
    removable?: boolean;
  }>(),
  {
    fieldLabel: '',
    deleteLabel: '',
    confirmDeleteLabel: 'Tap again to delete',
    reorderable: true,
    removable: true,
  },
);

const emit = defineEmits<{
  rename: [title: string];
  remove: [];
}>();

defineSlots<{
  default?(props: { act: (fn: () => void) => void }): VNode[];
}>();

const renaming = ref(false);
const draft = ref('');
const confirmDelete = ref(false);
const menu = ref<HTMLDetailsElement>();

const label = computed(
  () =>
    `Actions for ${props.title}` +
    (props.reorderable ? '; use arrow keys or hold and drag to reorder' : ''),
);
const titleLabel = computed(
  () => props.fieldLabel || `${props.noun[0]!.toUpperCase()}${props.noun.slice(1)} title`,
);

function onToggle() {
  confirmDelete.value = false;
  renaming.value = false;
  if (menu.value?.open) {
    document.addEventListener('pointerdown', onOutsidePress, true);
    document.addEventListener('keydown', onEscape, true);
  } else {
    stopListening();
  }
}

function stopListening() {
  document.removeEventListener('pointerdown', onOutsidePress, true);
  document.removeEventListener('keydown', onEscape, true);
}

/** A press anywhere outside the open menu closes it (including on another item's menu). */
function onOutsidePress(event: PointerEvent) {
  if (event.target instanceof Node && menu.value?.contains(event.target)) return;
  close();
}

function onEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  close();
  menu.value?.querySelector('summary')?.focus();
}

onUnmounted(stopListening);

function close() {
  if (menu.value) menu.value.open = false;
  confirmDelete.value = false;
  renaming.value = false;
  stopListening();
}

/** Runs a menu action, then closes the menu. */
function act(fn: () => void) {
  fn();
  close();
}

function startRename() {
  draft.value = props.title;
  renaming.value = true;
}

function saveTitle() {
  const value = draft.value.trim();
  if (value && value !== props.title) emit('rename', value);
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
  <details ref="menu" class="actions" @toggle="onToggle">
    <summary :class="{ reorderable }" :aria-label="label">⋮</summary>
    <div class="menu" role="menu">
      <form v-if="renaming" class="rename" @submit.prevent="saveTitle">
        <input v-model="draft" :aria-label="titleLabel" />
        <button type="submit">Save</button>
      </form>
      <button v-else role="menuitem" @click="startRename">Rename</button>
      <slot :act="act" />
      <button v-if="removable" role="menuitem" :class="{ danger: confirmDelete }" @click="remove">
        {{ confirmDelete ? confirmDeleteLabel : deleteLabel || `Delete ${noun}` }}
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

summary.reorderable {
  cursor: grab;
}

summary.reorderable:active {
  cursor: grabbing;
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

.menu button,
.menu :slotted(button) {
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
