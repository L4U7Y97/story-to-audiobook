import { nextTick, onUnmounted, ref, watchEffect, type Ref } from 'vue';

/** How long a press must stay still before it becomes a drag. */
const HOLD_MS = 300;
/** Moving further than this before the hold ends gives up the press (it is a scroll, or a swipe). */
const MOVE_PX = 8;
/** How long a dropped item takes to settle into its place. */
const SETTLE_MS = 180;
/** How near the screen's top or bottom edge a drag starts scrolling the page. */
const EDGE_PX = 64;
/** The fastest that scrolling goes (with the pointer at or past the edge), in px per frame. */
const SCROLL_PX = 16;
/** Longest a dropped order is shown while waiting for the list to report it. */
const DROPPED_MS = 2000;

type Session = {
  group: string;
  id: string;
  /** The item's element, which follows the pointer while dragged. */
  element: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  /** The latest pointer height. */
  y: number;
  /** Where the item was grabbed: pointer y minus the item's centre when the drag started. */
  grab: number;
  /** How far the item is shifted from its place in the list, in px. */
  offset: number;
  /** The pending auto-scroll frame, while dragging. */
  scrollFrame: number;
  originalOrder: string[];
  dragging: boolean;
  /** Let go and being saved: the item no longer follows the pointer. */
  released: boolean;
  holdTimer: ReturnType<typeof setTimeout>;
};

export type Sortable = {
  /** The item being dragged, while a drag is active. */
  dragged: Ref<{ group: string; id: string } | undefined>;
  /** Starts a press on `element` that becomes a drag once held still for a moment. */
  press(group: string, id: string, event: PointerEvent, element: HTMLElement): void;
  /**
   * Keeps a dragging finger from scrolling the page. Only a touchmove listener that is not passive
   * can stop a scroll, and the browser only honours one that was already on the element when the
   * touch began, so items call this from their own listener.
   */
  touchMove(event: TouchEvent): void;
  /** Moves an item one place up (-1) or down (+1) and saves it. */
  step(group: string, id: string, delta: number): void;
  /** `items` in the order the drag currently previews (unchanged outside a drag of `group`). */
  arrange<T>(group: string, items: T[], idOf: (item: T) => string): T[];
};

/**
 * Hold-and-drag reordering for one kind of list (books, or the parts of each book). Items are
 * elements with `data-sortable-id` and `data-sortable-group` (see SortableItem.vue); a drag only
 * reorders inside its own group and saves once, when released. The dragged item follows the
 * pointer up and down, kept inside its list (its parent element).
 */
export function useSortable(options: {
  /** The saved order of a group's item ids. */
  order: (group: string) => string[];
  /** Saves `id` at `toIndex` within its group. */
  move: (group: string, id: string, toIndex: number) => Promise<unknown>;
}): Sortable {
  const dragged = ref<{ group: string; id: string }>();
  const preview = ref<{ group: string; ids: string[] }>();
  /**
   * The order just dropped and saved, shown until the list's own data has it (the save resolves
   * before the list hears of it, and the list must not flash back to the old order meanwhile).
   */
  const dropped = ref<{ group: string; ids: string[] }>();
  let session: Session | undefined;

  watchEffect(() => {
    const shown = dropped.value;
    if (shown && options.order(shown.group).join('\n') === shown.ids.join('\n')) {
      dropped.value = undefined;
    }
  });

  function press(group: string, id: string, event: PointerEvent, element: HTMLElement) {
    if (session || event.button !== 0) return;
    const originalOrder = options.order(group);
    if (!originalOrder.includes(id)) return;
    const current: Session = {
      group,
      id,
      element,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      y: event.clientY,
      grab: 0,
      offset: 0,
      scrollFrame: 0,
      originalOrder,
      dragging: false,
      released: false,
      holdTimer: setTimeout(() => activate(current), HOLD_MS),
    };
    session = current;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    // A press on an item is a potential drag, so it must not start selecting text across rows.
    document.addEventListener('selectstart', preventDefault, true);
  }

  function activate(current: Session) {
    if (session !== current || current.dragging) return;
    clearTimeout(current.holdTimer);
    current.dragging = true;
    // Grabbed again while still settling from the last drop: it is dragged from where it is drawn.
    settling.get(current.element)?.cancel();
    dropped.value = undefined;
    current.grab = current.startY - centreOf(current.element);
    window.getSelection()?.removeAllRanges();
    document.documentElement.classList.add('sorting');
    navigator.vibrate?.(10);
    dragged.value = { group: current.group, id: current.id };
    preview.value = { group: current.group, ids: [...current.originalOrder] };
    follow(current);
    const tick = () => {
      if (session !== current || current.released) return;
      autoScroll(current);
      current.scrollFrame = requestAnimationFrame(tick);
    };
    current.scrollFrame = requestAnimationFrame(tick);
  }

  /**
   * Near the top or bottom edge of the screen (or of the list's scrolling box), scrolls towards
   * that edge, faster the closer the pointer gets, while the list goes on past it. The item stays
   * under the pointer and keeps finding its place as the list moves.
   */
  function autoScroll(current: Session) {
    const list = current.element.parentElement?.getBoundingClientRect();
    if (!list) return;
    const box = scrollingBoxOf(current.element);
    const scroller = box ?? document.scrollingElement ?? document.documentElement;
    const view = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const zone = Math.min(EDGE_PX, (view.bottom - view.top) / 4);
    if (zone <= 0) return;
    let speed = 0;
    if (current.y < view.top + zone && list.top < view.top) {
      speed = -SCROLL_PX * Math.min(1, (view.top + zone - current.y) / zone);
      speed = Math.max(speed, list.top - view.top);
    } else if (current.y > view.bottom - zone && list.bottom > view.bottom) {
      speed = SCROLL_PX * Math.min(1, (current.y - (view.bottom - zone)) / zone);
      speed = Math.min(speed, list.bottom - view.bottom);
    }
    if (!speed) return;
    const scrolled = scroller.scrollTop;
    scroller.scrollTop = scrolled + speed;
    if (scroller.scrollTop === scrolled) return;
    follow(current);
    reorder(current);
  }

  function onMove(event: PointerEvent) {
    const current = session;
    if (!current || current.pointerId !== event.pointerId || current.released) return;
    current.y = event.clientY;
    if (!current.dragging) {
      // Moving before the hold ends is a scroll (or a mouse swipe), not a drag.
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= MOVE_PX) {
        end();
      }
      return;
    }
    event.preventDefault();
    follow(current);
    reorder(current);
  }

  /** Scrolling (a mouse wheel during a drag) moves the list under a still pointer. */
  function onScroll() {
    const current = session;
    if (!current?.dragging || current.released) return;
    follow(current);
    reorder(current);
  }

  /**
   * Shifts the dragged item so it stays where it was grabbed under the pointer, moving only up and
   * down and never past the ends of its list.
   */
  function follow(current: Session) {
    const element = current.element;
    // The item's centre in its place in the list: its drawn centre, less the current shift.
    const home = centreOf(element) - current.offset;
    let centre = current.y - current.grab;
    const list = element.parentElement?.getBoundingClientRect();
    if (list && list.height > 0) {
      const half = element.offsetHeight / 2;
      centre = Math.max(list.top + half, Math.min(list.bottom - half, centre));
    }
    current.offset = centre - home;
    element.style.setProperty('translate', `0 ${current.offset}px`);
  }

  /**
   * Previews the dragged item's place from where it is drawn: it passes an item above once its top
   * edge rises past that item's middle, and an item below once its bottom edge sinks past it. So an
   * item held at either end of its list (it stops there) always takes that end, whatever the
   * heights. Positions are layout positions (offsetTop), which the list's move animation does not
   * disturb.
   */
  function reorder(current: Session) {
    const ids = preview.value?.ids;
    if (!ids) return;
    const element = current.element;
    const items = new Map<string, HTMLElement>();
    for (const child of element.parentElement?.children ?? []) {
      const id = child instanceof HTMLElement ? child.dataset.sortableId : undefined;
      if (id && (child as HTMLElement).dataset.sortableGroup === current.group) {
        items.set(id, child as HTMLElement);
      }
    }
    const top = element.offsetTop + current.offset;
    const bottom = top + element.offsetHeight;
    const from = ids.indexOf(current.id);
    const remaining = ids.filter((id) => id !== current.id);
    const before = remaining.filter((id) => {
      const wasBefore = ids.indexOf(id) < from;
      const item = items.get(id);
      if (!item) return wasBefore;
      const middle = item.offsetTop + item.offsetHeight / 2;
      return wasBefore ? top >= middle : bottom > middle;
    }).length;
    remaining.splice(before, 0, current.id);
    if (remaining.some((id, index) => id !== ids[index])) {
      preview.value = { group: current.group, ids: remaining };
      // The item has a new place in the list: once it is laid out there, shift it back under the
      // pointer (before the next frame is drawn, so it never jumps).
      void nextTick(() => {
        if (session === current && current.dragging) follow(current);
      });
    }
  }

  async function onUp(event: PointerEvent) {
    const current = session;
    if (!current || current.pointerId !== event.pointerId || current.released) return;
    // Let go: while the new order is saved, the item stays where it was dropped (a mouse moving on
    // does not drag it any further).
    current.released = true;
    const toIndex = current.dragging ? (preview.value?.ids.indexOf(current.id) ?? -1) : -1;
    if (current.dragging) swallowNextClick();
    try {
      const ids = preview.value?.ids;
      if (ids && toIndex >= 0 && toIndex !== current.originalOrder.indexOf(current.id)) {
        await options.move(current.group, current.id, toIndex);
        const shown = { group: current.group, ids };
        dropped.value = shown;
        // In case the list never reports exactly this order (it changed meanwhile), stop holding it.
        setTimeout(() => {
          if (dropped.value === shown) dropped.value = undefined;
        }, DROPPED_MS);
      }
    } finally {
      if (session === current) end();
    }
  }

  function touchMove(event: TouchEvent) {
    if (session?.dragging && event.cancelable) event.preventDefault();
  }

  /** A long press on a link would open its menu; while dragging it is the drag instead. */
  function onContextMenu(event: Event) {
    if (session?.dragging) event.preventDefault();
  }

  function onCancel(event: PointerEvent) {
    if (session?.pointerId === event.pointerId && !session.released) end();
  }

  function end() {
    const current = session;
    if (current) {
      clearTimeout(current.holdTimer);
      cancelAnimationFrame(current.scrollFrame);
    }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('contextmenu', onContextMenu, true);
    window.removeEventListener('scroll', onScroll, { capture: true });
    document.removeEventListener('selectstart', preventDefault, true);
    if (current?.dragging) {
      document.documentElement.classList.remove('sorting');
      settle(current.element);
    }
    session = undefined;
    dragged.value = undefined;
    preview.value = undefined;
  }

  function step(group: string, id: string, delta: number) {
    dropped.value = undefined;
    const index = options.order(group).indexOf(id);
    if (index >= 0) void options.move(group, id, index + delta);
  }

  function arrange<T>(group: string, items: T[], idOf: (item: T) => string): T[] {
    const shown = preview.value ?? dropped.value;
    if (shown?.group !== group) return items;
    const byId = new Map(items.map((item) => [idOf(item), item]));
    const ordered = shown.ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
    // Items added meanwhile go last rather than vanish.
    const placed = new Set(shown.ids);
    return [...ordered, ...items.filter((item) => !placed.has(idOf(item)))];
  }

  onUnmounted(end);
  return { dragged, press, touchMove, step, arrange };
}

function preventDefault(event: Event) {
  event.preventDefault();
}

/** An element's vertical centre on screen (as drawn, shifts and scaling included). */
function centreOf(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  return (rect.top + rect.bottom) / 2;
}

/** The settling animation of each dropped item, while it runs. */
const settling = new WeakMap<HTMLElement, Animation>();

/** The look of a lifted item that eases back to normal as it settles. */
function liftLook(element: HTMLElement) {
  const style = getComputedStyle(element);
  return {
    backgroundColor: style.backgroundColor,
    boxShadow: style.boxShadow,
    borderRadius: style.borderRadius,
  };
}

/**
 * Lets go of a dragged item: it glides from where it was dropped (and from its lifted size and
 * look, so it still covers its neighbours) into its place in the list, once the list has its final
 * order.
 */
function settle(element: HTMLElement) {
  const dropped = centreOf(element);
  const scale = getComputedStyle(element).scale;
  const lifted = liftLook(element);
  element.style.removeProperty('translate');
  void nextTick(() => {
    if (!element.isConnected || typeof element.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const shift = dropped - centreOf(element);
    // Above its neighbours while it settles, as while it was dragged.
    element.style.position = 'relative';
    element.style.zIndex = '1';
    const animation = element.animate(
      [
        { translate: `0 ${shift}px`, scale: scale && scale !== 'none' ? scale : '1', ...lifted },
        { translate: '0 0', scale: '1', ...liftLook(element) },
      ],
      { duration: SETTLE_MS, easing: 'ease-out' },
    );
    settling.set(element, animation);
    const done = () => {
      if (settling.get(element) !== animation) return;
      settling.delete(element);
      element.style.removeProperty('position');
      element.style.removeProperty('z-index');
    };
    animation.addEventListener('finish', done);
    animation.addEventListener('cancel', done);
  });
}

/** The nearest box around `element` that scrolls vertically, if any (else the page scrolls). */
function scrollingBoxOf(element: HTMLElement): HTMLElement | undefined {
  for (let box = element.parentElement; box; box = box.parentElement) {
    if (box === document.body || box === document.documentElement) break;
    const overflow = getComputedStyle(box).overflowY;
    if (/auto|scroll|overlay/.test(overflow) && box.scrollHeight > box.clientHeight) return box;
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
