<script setup lang="ts">
import { computed } from 'vue';
import type { Sortable } from '../composables/useSortable';

/**
 * One reorderable item of a list driven by `useSortable`: hold it still, then drag it (a swipe
 * that moves straight away scrolls the page instead), or press ArrowUp /
 * ArrowDown on its actions button (`summary`). A tap on a non-interactive part of it emits `open`.
 * Items can nest (parts inside a book); each item only reacts to presses that are its own.
 */
const props = withDefaults(
  defineProps<{
    sortable: Sortable;
    group: string;
    id: string;
    tag?: string;
    /** Only presses inside a `[data-sortable-handle]` element drag or open the item. */
    handle?: boolean;
    disabled?: boolean;
  }>(),
  { tag: 'div', handle: false, disabled: false },
);

const emit = defineEmits<{ open: [] }>();

const dragging = computed(
  () =>
    props.sortable.dragged.value?.group === props.group &&
    props.sortable.dragged.value.id === props.id,
);

const INTERACTIVE = 'a, button, summary, details, input, select, textarea, label';

/** The pressed element, when the event belongs to this item (not a nested one) and its handle. */
function ownTarget(event: Event): Element | undefined {
  if (props.disabled || !(event.target instanceof Element)) return undefined;
  const target = event.target;
  if (target.closest('[data-sortable-id]') !== event.currentTarget) return undefined;
  if (props.handle && !target.closest('[data-sortable-handle]')) return undefined;
  return target;
}

function onPointerDown(event: PointerEvent) {
  const target = ownTarget(event);
  if (!target) return;
  // Links and the actions button drag too (the click after a drag is swallowed); other controls
  // keep their own behaviour.
  if (!target.closest('summary, a') && target.closest(INTERACTIVE)) return;
  props.sortable.press(props.group, props.id, event, event.currentTarget as HTMLElement);
}

function onKeyDown(event: KeyboardEvent) {
  const target = ownTarget(event);
  if (target?.tagName !== 'SUMMARY') return;
  const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (!delta) return;
  event.preventDefault();
  props.sortable.step(props.group, props.id, delta);
}

function onClick(event: MouseEvent) {
  const target = ownTarget(event);
  if (target && !target.closest(INTERACTIVE)) emit('open');
}
</script>

<template>
  <component
    :is="tag"
    class="sortable"
    :class="{ dragging, 'whole-handle': !handle && !disabled }"
    :data-sortable-id="disabled ? undefined : id"
    :data-sortable-group="disabled ? undefined : group"
    @pointerdown.capture="onPointerDown"
    @touchmove="sortable.touchMove"
    @keydown="onKeyDown"
    @click="onClick"
    @dragstart.prevent
  >
    <slot />
  </component>
</template>

<style scoped>
.whole-handle,
.sortable[data-sortable-id] :deep([data-sortable-handle]) {
  cursor: grab;
}

.whole-handle:active,
.sortable[data-sortable-id] :deep([data-sortable-handle]:active) {
  cursor: grabbing;
}

/*
 * The dragged item is lifted: a little bigger, opaque, with a shadow, above its neighbours. It
 * follows the pointer through the `translate` that useSortable sets, so it never animates that,
 * nor `transform` (which the list's move animation uses), only its lift. `transform` stays in the
 * list at no duration: Vue's TransitionGroup checks the first item for a transform transition to
 * decide whether to animate the list at all, and the dragged item may be that first item.
 */
.sortable.dragging {
  position: relative;
  z-index: 2;
  scale: 1.03;
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: 0 10px 28px rgb(0 0 0 / 25%);
  /* The pointer finds the items under it, not this one. */
  pointer-events: none;
  transition:
    scale 120ms ease,
    box-shadow 120ms ease,
    transform 0s;
}

@media (prefers-reduced-motion: reduce) {
  .sortable.dragging {
    transition: none;
  }
}
</style>
