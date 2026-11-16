import { onUnmounted, ref, type Ref } from 'vue';

/** How long a press must last before it becomes a drag without moving. */
const HOLD_MS = 250;
/** How far a press must move before it becomes a drag without waiting. */
const MOVE_PX = 6;

type Session = {
  group: string;
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  originalOrder: string[];
  dragging: boolean;
  holdTimer: ReturnType<typeof setTimeout>;
};

export type Sortable = {
  /** The item being dragged, while a drag is active. */
  dragged: Ref<{ group: string; id: string } | undefined>;
  /** Starts a press that becomes a drag after a hold or a small move. */
  press(group: string, id: string, event: PointerEvent): void;
  /** Moves an item one place up (-1) or down (+1) and saves it. */
  step(group: string, id: string, delta: number): void;
  /** `items` in the order the drag currently previews (unchanged outside a drag of `group`). */
  arrange<T>(group: string, items: T[], idOf: (item: T) => string): T[];
};

/**
 * Hold-and-drag reordering for one kind of list (books, or the parts of each book). Items are
 * elements with `data-sortable-id` and `data-sortable-group` (see SortableItem.vue); a drag only
 * reorders inside its own group and saves once, when released.
 */
export function useSortable(options: {
  /** The saved order of a group's item ids. */
  order: (group: string) => string[];
  /** Saves `id` at `toIndex` within its group. */
  move: (group: string, id: string, toIndex: number) => Promise<unknown>;
}): Sortable {
  const dragged = ref<{ group: string; id: string }>();
  const preview = ref<{ group: string; ids: string[] }>();
  let session: Session | undefined;

  function press(group: string, id: string, event: PointerEvent) {
    if (session || event.button !== 0) return;
    const originalOrder = options.order(group);
    if (!originalOrder.includes(id)) return;
    const current: Session = {
      group,
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originalOrder,
      dragging: false,
      holdTimer: setTimeout(() => activate(current), HOLD_MS),
    };
    session = current;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    // A press on an item is a potential drag, so it must not start selecting text across rows.
    document.addEventListener('selectstart', preventDefault, true);
  }

  function activate(current: Session) {
    if (session !== current || current.dragging) return;
    clearTimeout(current.holdTimer);
    current.dragging = true;
    window.getSelection()?.removeAllRanges();
    document.documentElement.classList.add('sorting');
    dragged.value = { group: current.group, id: current.id };
    preview.value = { group: current.group, ids: [...current.originalOrder] };
  }

  function onMove(event: PointerEvent) {
    const current = session;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.dragging) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < MOVE_PX) {
        return;
      }
      activate(current);
    }
    event.preventDefault();

    const target = itemAt(event.clientX, event.clientY, current.group);
    const ids = preview.value?.ids;
    const targetId = target?.dataset.sortableId;
    if (!target || !ids || !targetId || targetId === current.id) return;
    const remaining = ids.filter((id) => id !== current.id);
    const targetIndex = remaining.indexOf(targetId);
    if (targetIndex < 0) return;
    const rect = target.getBoundingClientRect();
    remaining.splice(
      targetIndex + (event.clientY >= rect.top + rect.height / 2 ? 1 : 0),
      0,
      current.id,
    );
    if (remaining.some((id, index) => id !== ids[index])) {
      preview.value = { group: current.group, ids: remaining };
    }
  }

  async function onUp(event: PointerEvent) {
    const current = session;
    if (!current || current.pointerId !== event.pointerId) return;
    const toIndex = current.dragging ? (preview.value?.ids.indexOf(current.id) ?? -1) : -1;
    if (current.dragging) swallowNextClick();
    try {
      if (toIndex >= 0 && toIndex !== current.originalOrder.indexOf(current.id)) {
        await options.move(current.group, current.id, toIndex);
      }
    } finally {
      end();
    }
  }

  function onCancel(event: PointerEvent) {
    if (session?.pointerId === event.pointerId) end();
  }

  function end() {
    if (session) clearTimeout(session.holdTimer);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    document.removeEventListener('selectstart', preventDefault, true);
    if (session?.dragging) document.documentElement.classList.remove('sorting');
    session = undefined;
    dragged.value = undefined;
    preview.value = undefined;
  }

  function step(group: string, id: string, delta: number) {
    const index = options.order(group).indexOf(id);
    if (index >= 0) void options.move(group, id, index + delta);
  }

  function arrange<T>(group: string, items: T[], idOf: (item: T) => string): T[] {
    if (preview.value?.group !== group) return items;
    const byId = new Map(items.map((item) => [idOf(item), item]));
    return preview.value.ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }

  onUnmounted(end);
  return { dragged, press, step, arrange };
}

function preventDefault(event: Event) {
  event.preventDefault();
}

/** The item of `group` under a point, if any. */
function itemAt(x: number, y: number, group: string): HTMLElement | undefined {
  let element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-sortable-id]');
  while (element) {
    if (element.dataset.sortableGroup === group) return element;
    element = element.parentElement?.closest<HTMLElement>('[data-sortable-id]');
  }
  return undefined;
}

/** Releasing a drag also fires a click on whatever was under the pointer; keep it from acting. */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}
