import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { Router } from 'vue-router';
import type { Part, Segment } from '@/format/types';
import { saveAnalysis } from '@/storage/analyses';
import { addBook } from '@/storage/books';
import { addPart, deletePart, listParts, setAnalysisStatus } from '@/storage/parts';
import { createStory, getStory, updateStory } from '@/storage/stories';
import StoryView from '@/ui/views/StoryView.vue';
import {
  button,
  db,
  holdVoices,
  jumped,
  mountView,
  partsChanged,
  placeRestored,
  played,
  playerAlreadyMade,
  playerSnapshot,
  resumed,
  stopped,
  storeStory,
  submit,
  typeInto,
  unmountView,
  until,
} from '../../helpers/ui';

vi.mock('@/ui/composables/usePlayer', () => import('../../helpers/ui').then((m) => m.playerStub()));

afterEach(unmountView);

/** Waits long enough for a press to become a drag (useSortable's hold). */
const hold = () => new Promise((resolve) => setTimeout(resolve, 350));

/** How far a dragged row is drawn from its place (the `translate` useSortable sets), in px. */
const shiftOf = (row: HTMLElement) =>
  Number(/(-?[\d.]+)px\s*$/.exec(row.style.getPropertyValue('translate'))?.[1] ?? 0);

/**
 * Lays rows out as a browser would for a drag (happy-dom has no layout): `heights` px tall (one
 * for all, or one per row), one under the other from y = 0 in their list's current order, a
 * dragged row drawn at its shift.
 */
function stack(rows: HTMLElement[], heights: number | number[] = 100) {
  const list = rows[0]!.parentElement!;
  const heightOf = (row: HTMLElement) =>
    typeof heights === 'number' ? heights : heights[rows.indexOf(row)]!;
  const topOf = (row: HTMLElement) => {
    let top = 0;
    for (const child of list.children) {
      if (child === row) break;
      if (rows.includes(child as HTMLElement)) top += heightOf(child as HTMLElement);
    }
    return top;
  };
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    left: 0,
    right: 400,
    width: 400,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
  const total = rows.reduce((sum, row) => sum + heightOf(row), 0);
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(rect(0, total));
  for (const row of rows) {
    Object.defineProperty(row, 'offsetTop', { configurable: true, get: () => topOf(row) });
    Object.defineProperty(row, 'offsetHeight', { configurable: true, get: () => heightOf(row) });
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() =>
      rect(topOf(row) + shiftOf(row), heightOf(row)),
    );
  }
}

describe('book sections', () => {
  it('opens a book page with only that book’s parts', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    const secondBook = await addBook(db, stored.storyId, 'Book 2');
    await addPart(db, stored.storyId, {
      title: 'Chapter in Book 2',
      source: { kind: 'paste' },
      text: 'The next book.',
      bookId: secondBook.id,
    });
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: stored.storyId }, (instance) => {
      router = instance;
    });
    const bookLink = await until(
      () =>
        [...host.querySelectorAll<HTMLAnchorElement>('.book-title')].find((link) =>
          link.textContent?.includes('Book 2'),
        ),
      'the Book 2 link',
    );

    expect(host.querySelector('.book-collapse')).toBeNull();
    expect(host.querySelector('.part')).toBeNull();

    bookLink.click();

    await until(
      () => (router?.currentRoute.value.name === 'book' ? router.currentRoute.value : undefined),
      'the book route',
    );
    await until(
      () => host.querySelector<HTMLElement>('.part-title')?.textContent === 'Chapter in Book 2',
      'the selected book’s part',
    );

    expect(router!.currentRoute.value.params.bookId).toBe(secondBook.id);
    expect(host.querySelector('h1')?.textContent).toBe('Book 2');
    expect(host.textContent).not.toContain('Once upon a time.');
    expect(host.querySelector('.back')?.textContent).toContain('Story');
    expect(host.querySelector('.book-collapse')).toBeNull();

    host.querySelector<HTMLAnchorElement>('.back')!.click();
    await until(
      () => (router?.currentRoute.value.name === 'story' ? router.currentRoute.value : undefined),
      'the story overview route',
    );
    await until(
      () => host.querySelectorAll('.book-title').length === 2,
      'the books in the overview',
    );
    expect(host.querySelector('.part')).toBeNull();
  });

  it('opens the reader when a part row is clicked', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    let router: Router | undefined;
    const host = await mountView(
      StoryView,
      { id: stored.storyId },
      (instance) => (router = instance),
    );
    const row = await until(() => host.querySelector<HTMLElement>('.part'), 'the part row');

    row.click();
    await until(
      () => (router?.currentRoute.value.name === 'reader' ? router.currentRoute.value : undefined),
      'the reader route',
    );

    expect(router!.currentRoute.value.params.partId).toBe(stored.partId);
  });

  it('opens a book page when its header is clicked, like a part row opens the reader', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    const secondBook = await addBook(db, stored.storyId, 'Book 2');
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: stored.storyId }, (instance) => {
      router = instance;
    });
    const headers = await until(() => {
      const current = host.querySelectorAll<HTMLElement>('.book-header');
      return current.length === 2 ? current : undefined;
    }, 'the book headers');

    headers[1]!.click();
    await until(
      () => (router?.currentRoute.value.name === 'book' ? router.currentRoute.value : undefined),
      'the book route',
    );

    expect(router!.currentRoute.value.params.bookId).toBe(secondBook.id);
  });

  it('does not offer reordering for the only book shown on its own page', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addBook(db, stored.storyId, 'Book 2');
    const story = (await getStory(db, stored.storyId))!;
    const host = await mountView(StoryView, { id: stored.storyId, bookId: story.books![0]!.id });
    const actions = await until(
      () => host.querySelector<HTMLElement>('.book-menu summary'),
      'the book actions control',
    );

    expect(actions.getAttribute('aria-label')).not.toContain('reorder');
    actions.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await getStory(db, stored.storyId);
    expect(after!.books!.map((book) => book.title)).toEqual(['Book 1', 'Book 2']);
  });

  it('reorders a part by dragging its title link inside a book', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'The next part.',
    });
    await addPart(db, stored.storyId, {
      title: 'Three',
      source: { kind: 'paste' },
      text: 'One more part.',
    });
    await addBook(db, stored.storyId, 'Book 2');
    const story = (await getStory(db, stored.storyId))!;
    let router: Router | undefined;
    const host = await mountView(
      StoryView,
      { id: stored.storyId, bookId: story.books![0]!.id },
      (instance) => {
        router = instance;
      },
    );
    const book = await until(() => host.querySelector<HTMLElement>('.book'), 'the first book');
    const parts = await until(() => {
      const current = book.querySelectorAll<HTMLElement>('.part');
      return current.length === 3 ? [...current] : undefined;
    }, 'the parts in the first book');
    const title = parts[0]!.querySelector<HTMLAnchorElement>('.part-title')!;

    expect(title.getAttribute('draggable')).toBe('false');
    window.getSelection()!.selectAllChildren(book);
    stack(parts);

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 20,
      clientY: 0,
    });
    Object.assign(pointerDown, { pointerId: 12 });
    title.dispatchEvent(pointerDown);
    await hold();
    // A press on a row must not start selecting text across rows.
    const selectStart = new Event('selectstart', { bubbles: true, cancelable: true });
    parts[1]!.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(true);
    const pointerMove = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 260,
    });
    Object.assign(pointerMove, { pointerId: 12 });
    window.dispatchEvent(pointerMove);
    await nextTick();

    expect([...book.querySelectorAll('.part-title')].map((link) => link.textContent)).toEqual([
      'Two',
      'Three',
      'One',
    ]);
    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(document.documentElement.classList.contains('sorting')).toBe(true);

    const pointerUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
    Object.assign(pointerUp, { pointerId: 12 });
    window.dispatchEvent(pointerUp);
    await until(async () => {
      const currentParts = await listParts(db, stored.storyId);
      return currentParts.map((part) => part.title).join(',') === 'Two,Three,One'
        ? currentParts
        : undefined;
    }, 'the part order dragged from its title link');

    expect(router!.currentRoute.value.path).toBe('/');
    await until(
      () => !document.documentElement.classList.contains('sorting') || undefined,
      'text selection allowed again after the drag',
    );
    const afterDrag = new Event('selectstart', { bubbles: true, cancelable: true });
    parts[1]!.dispatchEvent(afterDrag);
    expect(afterDrag.defaultPrevented).toBe(false);
  });

  it('reorders books as a section is dragged and saves the new order when released', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addBook(db, stored.storyId, 'Book 2');
    await addBook(db, stored.storyId, 'Book 3');
    const host = await mountView(StoryView, { id: stored.storyId });
    const sections = await until(() => {
      const current = host.querySelectorAll<HTMLElement>('.book');
      return current.length === 3 ? current : undefined;
    }, 'the book sections');
    const row = sections[0]!.querySelector<HTMLElement>('.book-header');
    const actions = sections[0]!.querySelector<HTMLElement>('.book-menu summary');

    expect(row).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(host.textContent).not.toContain('Move book up');
    expect(host.textContent).not.toContain('Move book down');
    stack([...sections]);

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 20,
      clientY: 0,
    });
    Object.assign(pointerDown, { pointerId: 7 });
    actions!.dispatchEvent(pointerDown);
    await hold();
    const pointerMove = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 260,
    });
    Object.assign(pointerMove, { pointerId: 7 });
    window.dispatchEvent(pointerMove);
    await nextTick();
    expect([...host.querySelectorAll('.book h2')].map((heading) => heading.textContent)).toEqual([
      'Book 2',
      'Book 3',
      'Book 1',
    ]);

    const actionPointerUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
    Object.assign(actionPointerUp, { pointerId: 7 });
    window.dispatchEvent(actionPointerUp);
    await until(async () => {
      const story = await getStory(db, stored.storyId);
      return story?.books?.map((book) => book.title).join(',') === 'Book 2,Book 3,Book 1'
        ? story
        : undefined;
    }, 'the book order dragged from its actions control');
    await until(
      () =>
        [...host.querySelectorAll('.book h2')].map((heading) => heading.textContent).join(',') ===
        'Book 2,Book 3,Book 1',
      'the rendered book order after the first drag',
    );

    const draggedBook = [...host.querySelectorAll<HTMLElement>('.book')].find((section) =>
      section.querySelector('h2')?.textContent?.includes('Book 1'),
    )!;
    // Book 1 is last now (200–300): held 10px above its centre and dragged right up to the top.
    const titlePointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 20,
      clientY: 240,
    });
    Object.assign(titlePointerDown, { pointerId: 11 });
    draggedBook.querySelector('h2')!.dispatchEvent(titlePointerDown);
    await hold();
    const titlePointerMove = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: -400,
    });
    Object.assign(titlePointerMove, { pointerId: 11 });
    window.dispatchEvent(titlePointerMove);
    await nextTick();

    expect(draggedBook.classList.contains('dragging')).toBe(true);
    expect([...host.querySelectorAll('.book h2')].map((heading) => heading.textContent)).toEqual([
      'Book 1',
      'Book 2',
      'Book 3',
    ]);

    const titlePointerUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
    Object.assign(titlePointerUp, { pointerId: 11 });
    window.dispatchEvent(titlePointerUp);

    await until(
      async () => {
        const story = await getStory(db, stored.storyId);
        return story?.books?.map((book) => book.title).join(',') === 'Book 1,Book 2,Book 3'
          ? story
          : undefined;
      },
      'the saved book order',
      10_000,
    );

    actions!.click();
    await nextTick();
    expect(actions!.closest('details')?.open).toBe(true);
    expect(actions!.closest('details')?.textContent).toContain('Rename');
  }, 15_000);

  it('reorders parts as a section is dragged and keeps actions available on a tap', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'The next part.',
    });
    await addPart(db, stored.storyId, {
      title: 'Three',
      source: { kind: 'paste' },
      text: 'One more part.',
    });
    const host = await mountView(StoryView, { id: stored.storyId });
    const parts = await until(() => {
      const current = host.querySelectorAll<HTMLElement>('.part');
      return current.length === 3 ? current : undefined;
    }, 'the part sections');
    const row = parts[0]!;
    const actions = row.querySelector<HTMLElement>('.part-menu summary');

    expect(actions).not.toBeNull();
    expect(row).not.toBeNull();
    expect(host.textContent).not.toContain('Move up');
    expect(host.textContent).not.toContain('Move down');
    stack([...parts]);

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 20,
      clientY: 0,
    });
    Object.assign(pointerDown, { pointerId: 8 });
    actions!.dispatchEvent(pointerDown);
    await hold();
    const actionPointerMove = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 260,
    });
    Object.assign(actionPointerMove, { pointerId: 8 });
    window.dispatchEvent(actionPointerMove);
    await nextTick();
    expect([...host.querySelectorAll('.part-title')].map((title) => title.textContent)).toEqual([
      'Two',
      'Three',
      'One',
    ]);
    // Every order the list shows from the drop on, until its data has the saved order.
    const shownTitles = () =>
      [...host.querySelectorAll('.part-title')].map((title) => title.textContent).join(',');
    const shown: string[] = [];
    const observer = new MutationObserver(() => shown.push(shownTitles()));
    observer.observe(row.parentElement!, { childList: true });
    const actionPointerUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
    Object.assign(actionPointerUp, { pointerId: 8 });
    window.dispatchEvent(actionPointerUp);
    await until(async () => {
      const currentParts = await listParts(db, stored.storyId);
      return currentParts.map((part) => part.title).join(',') === 'Two,Three,One'
        ? currentParts
        : undefined;
    }, 'the part order dragged from its actions control');
    await new Promise((resolve) => setTimeout(resolve, 100));
    observer.disconnect();
    // The dropped order stays: the list never flashes back to the order before the drag while the
    // save reaches it.
    expect(shownTitles()).toBe('Two,Three,One');
    expect(shown.filter((order) => order !== 'Two,Three,One')).toEqual([]);

    const titlePointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 20,
      clientY: 260,
    });
    Object.assign(titlePointerDown, { pointerId: 10 });
    row.querySelector('.part-title')!.dispatchEvent(titlePointerDown);
    const pointerMove = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 260,
    });
    Object.assign(pointerMove, { pointerId: 10 });
    window.dispatchEvent(pointerMove);
    await nextTick();

    // A tap (no hold) moves nothing.
    expect([...host.querySelectorAll('.part-title')].map((title) => title.textContent)).toEqual([
      'Two',
      'Three',
      'One',
    ]);

    const pointerUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
    Object.assign(pointerUp, { pointerId: 10 });
    window.dispatchEvent(pointerUp);

    // Nor does it save anything.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await listParts(db, stored.storyId)).map((part) => part.title).join(',')).toBe(
      'Two,Three,One',
    );

    actions!.click();
    await nextTick();
    expect(actions!.closest('details')?.open).toBe(true);
    expect(actions!.closest('details')?.textContent).toContain('Rename');
  });

  it('supports keyboard reordering for books', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'The next part.',
    });
    await addBook(db, stored.storyId, 'Book 2');
    const host = await mountView(StoryView, { id: stored.storyId });
    const bookActions = await until(
      () => host.querySelector<HTMLElement>('.book-menu summary'),
      'the first book actions control',
    );

    bookActions.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }),
    );
    await until(async () => {
      const story = await getStory(db, stored.storyId);
      return story?.books?.map((book) => book.title).join(',') === 'Book 2,Book 1'
        ? story
        : undefined;
    }, 'the books reordered from the keyboard');
    await until(
      () =>
        [...host.querySelectorAll('.book h2')].map((heading) => heading.textContent).join(',') ===
        'Book 2,Book 1',
      'the rendered books reordered from the keyboard',
    );
  });

  it('supports keyboard reordering for parts within a selected book', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'The next part.',
    });
    await addBook(db, stored.storyId, 'Book 2');
    const story = (await getStory(db, stored.storyId))!;
    const host = await mountView(StoryView, { id: stored.storyId, bookId: story.books![0]!.id });
    const partActions = await until(
      () => host.querySelector<HTMLElement>('.part-menu summary'),
      'the first part actions control',
    );
    partActions.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }),
    );
    await until(async () => {
      const currentParts = await listParts(db, stored.storyId);
      return currentParts.map((part) => part.title).join(',') === 'Two,One'
        ? currentParts
        : undefined;
    }, 'the parts reordered from the keyboard');
    // A step leaves nothing drawn out of place: only reading the parts again moves the rows.
    await until(
      () =>
        [...host.querySelectorAll('.part-title')].map((title) => title.textContent).join(',') ===
        'Two,One',
      'the rendered parts reordered from the keyboard',
    );
  });

  it('closes an actions menu on a press outside it or Escape', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addBook(db, stored.storyId, 'Book 2');
    const host = await mountView(StoryView, { id: stored.storyId });
    const summaries = await until(() => {
      const current = host.querySelectorAll<HTMLElement>('.book-menu summary');
      return current.length === 2 ? current : undefined;
    }, 'the book actions controls');
    const first = summaries[0]!.closest('details')!;
    const second = summaries[1]!.closest('details')!;
    const press = (target: Element) =>
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    const open = async (details: HTMLDetailsElement) => {
      details.querySelector('summary')!.click();
      await until(() => details.open || undefined, 'the menu opened');
      // The menu starts watching for outside presses once its toggle event has fired.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await open(first);
    press(first.querySelector('.menu button')!);
    expect(first.open).toBe(true);
    press(host.querySelector('h1')!);
    expect(first.open).toBe(false);

    await open(first);
    press(summaries[1]!);
    expect(first.open).toBe(false);

    await open(second);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(second.open).toBe(false);
  });

  it('scrolls instead of dragging when a row moves before it is held, and drags after a hold', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'The next part.',
    });
    const host = await mountView(StoryView, { id: stored.storyId });
    const parts = await until(() => {
      const current = host.querySelectorAll<HTMLElement>('.part');
      return current.length === 2 ? [...current] : undefined;
    }, 'the parts');
    const [first] = parts as [HTMLElement, HTMLElement];
    stack(parts);
    const pointer = (type: string, target: EventTarget, clientY: number, pointerId: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 20,
        clientY,
      });
      Object.assign(event, { pointerId });
      target.dispatchEvent(event);
    };
    const touchMove = () => {
      const event = new Event('touchmove', { bubbles: true, cancelable: true });
      first.dispatchEvent(event);
      return event;
    };
    const titles = () => [...host.querySelectorAll('.part-title')].map((t) => t.textContent);

    // A swipe: the row moves straight away, so the page scrolls and nothing is dragged.
    pointer('pointerdown', first, 10, 1);
    pointer('pointermove', window, 180, 1);
    expect(touchMove().defaultPrevented).toBe(false);
    await hold();
    await nextTick();
    expect(first.classList.contains('dragging')).toBe(false);
    pointer('pointermove', window, 190, 1);
    await nextTick();
    expect(titles()).toEqual(['One', 'Two']);
    pointer('pointerup', window, 190, 1);

    // A hold, then a move: the row is dragged and the page does not scroll.
    pointer('pointerdown', first, 10, 2);
    await hold();
    await nextTick();
    expect(first.classList.contains('dragging')).toBe(true);
    expect(touchMove().defaultPrevented).toBe(true);
    pointer('pointermove', window, 180, 2);
    await nextTick();
    expect(titles()).toEqual(['Two', 'One']);
    pointer('pointerup', window, 180, 2);
    await until(async () => {
      const current = await listParts(db, stored.storyId);
      return current.map((part) => part.title).join(',') === 'Two,One' ? current : undefined;
    }, 'the order saved after the held drag');
  });

  it('moves a dragged row up and down with the pointer, inside its list, to either end', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'The next part.',
    });
    const host = await mountView(StoryView, { id: stored.storyId });
    const parts = await until(() => {
      const current = host.querySelectorAll<HTMLElement>('.part');
      return current.length === 2 ? [...current] : undefined;
    }, 'the parts');
    const [first] = parts as [HTMLElement, HTMLElement];
    // A tall row (200px, say one showing an error) above a short one (50px): a 250px list.
    stack(parts, [200, 50]);
    const shift = () => shiftOf(first);
    const pointer = (type: string, target: EventTarget, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
      });
      Object.assign(event, { pointerId: 3 });
      target.dispatchEvent(event);
    };
    const titles = () => [...host.querySelectorAll('.part-title')].map((t) => t.textContent);

    // Grabbed 40px above its centre: the row moves with the pointer, keeping that grip, and keeps
    // its place until its bottom edge passes the middle of the row below.
    pointer('pointerdown', first, 20, 60);
    await hold();
    await nextTick();
    pointer('pointermove', window, 20, 80);
    expect(shift()).toBe(20);
    expect(titles()).toEqual(['One', 'Two']);

    // Far above the list: the first row stays at the top, where it is.
    pointer('pointermove', window, 20, -300);
    expect(shift()).toBe(0);

    // Far below the list (and off to the side): the row stops at the bottom of its list and takes
    // the last place.
    pointer('pointermove', window, 900, 500);
    expect(shift()).toBe(50);
    await nextTick();
    expect(titles()).toEqual(['Two', 'One']);
    // In its new place it is drawn where it was, so it does not jump.
    expect(shift()).toBe(0);

    // Back up past the top: although it is taller than the row above, it takes the first place.
    pointer('pointermove', window, 20, -300);
    expect(shift()).toBe(-50);
    await nextTick();
    expect(titles()).toEqual(['One', 'Two']);
    expect(shift()).toBe(0);

    pointer('pointermove', window, 20, 500);
    await nextTick();
    expect(titles()).toEqual(['Two', 'One']);
    pointer('pointerup', window, 20, 500);
    // Let go: a mouse moving on while the order saves drags nothing.
    pointer('pointermove', window, 20, -300);
    await nextTick();
    expect(titles()).toEqual(['Two', 'One']);
    await until(async () => {
      const current = await listParts(db, stored.storyId);
      return current.map((part) => part.title).join(',') === 'Two,One' ? current : undefined;
    }, 'the order saved after following the pointer');
    expect(first.style.getPropertyValue('translate')).toBe('');
  });

  it('scrolls the page while a row is dragged near the bottom of the screen', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'The next part.',
    });
    const host = await mountView(StoryView, { id: stored.storyId });
    const parts = await until(() => {
      const current = host.querySelectorAll<HTMLElement>('.part');
      return current.length === 2 ? [...current] : undefined;
    }, 'the parts');
    const [first] = parts as [HTMLElement, HTMLElement];
    // A 600px list on a 300px tall screen: it goes on below the bottom edge.
    stack(parts, 300);
    const screenHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
    const page = document.scrollingElement ?? document.documentElement;
    page.scrollTop = 0;
    const pointer = (type: string, target: EventTarget, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY });
      Object.assign(event, { pointerId: 4 });
      target.dispatchEvent(event);
    };
    try {
      pointer('pointerdown', first, 150);
      await hold();
      // In the middle of the screen: no scrolling.
      pointer('pointermove', window, 150);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(page.scrollTop).toBe(0);

      // Near the bottom edge: the page scrolls down, and keeps scrolling with the pointer still.
      pointer('pointermove', window, 290);
      await until(() => page.scrollTop > 0 || undefined, 'the page scrolling down');
      const scrolled = page.scrollTop;
      await until(() => page.scrollTop > scrolled || undefined, 'the page still scrolling');

      // Let go: the scrolling stops.
      pointer('pointerup', window, 290);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stopped = page.scrollTop;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(page.scrollTop).toBe(stopped);
    } finally {
      if (screenHeight) Object.defineProperty(window, 'innerHeight', screenHeight);
      else delete (window as { innerHeight?: number }).innerHeight;
      page.scrollTop = 0;
    }
  });
});

describe('part rows', () => {
  /** A story with its stored part ("One", analysed) and two more: one waiting, one failed. */
  async function storyWithParts() {
    const stored = await storeStory([['Once upon a time, there was a road.', 'N', 'narration']]);
    await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'Not read yet.',
    });
    const failed = await addPart(db, stored.storyId, {
      title: 'Three',
      source: { kind: 'paste' },
      text: 'This one went wrong.',
    });
    await setAnalysisStatus(db, failed.id, 'failed');
    return stored;
  }

  const rows = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('.part')].map((row) => ({
      number: row.querySelector('.part-number')?.textContent?.trim(),
      title: row.querySelector('.part-title')?.textContent?.trim(),
      meta: row.querySelector('.part-meta')?.textContent?.replace(/\s+/gu, ' ').trim(),
      action: row.querySelector('.part-do button')?.textContent?.trim(),
    }));

  it('gives each part its length, and its analysis only when the part needs something', async () => {
    const stored = await storyWithParts();
    const host = await mountView(StoryView, { id: stored.storyId });
    await until(() => host.querySelectorAll('.part').length === 3, 'the parts');
    expect(rows(host)).toEqual([
      { number: '1.', title: 'One', meta: '8 words', action: undefined },
      { number: '2.', title: 'Two', meta: '3 words · Not analysed yet', action: 'Analyse' },
      { number: '3.', title: 'Three', meta: '4 words · Analysis failed', action: 'Retry' },
    ]);
    expect(host.querySelector('.parts')?.getAttribute('style')).toContain('--digits: 1');
  });

  it('says which parts wait for their analysis, and offers them no Analyse meanwhile', async () => {
    const stored = await storyWithParts();
    // An analysis starts by listing the device's voices: held, the parts wait their turn.
    const release = holdVoices();
    const host = await mountView(StoryView, { id: stored.storyId });
    const [, two, three] = await until(() => {
      const current = host.querySelectorAll<HTMLElement>('.part');
      return current.length === 3 ? current : undefined;
    }, 'the parts');

    button(two!, 'Analyse')!.click();
    button(three!, 'Retry')!.click();
    await until(() => rows(host)[2]?.meta === '4 words · Waiting for analysis', 'the waiting rows');
    expect(rows(host).slice(1)).toEqual([
      { number: '2.', title: 'Two', meta: '3 words · Waiting for analysis', action: undefined },
      { number: '3.', title: 'Three', meta: '4 words · Waiting for analysis', action: undefined },
    ]);

    release();
    await until(() => rows(host).every((row) => !row.meta?.includes('·')), 'every part analysed');
    expect(rows(host).map((row) => row.action)).toEqual([undefined, undefined, undefined]);
  });

  it('opens the reader at a book’s first part from its Listen, not the book page', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    const second = await addBook(db, stored.storyId, 'Book 2');
    const two = await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'The next book.',
      bookId: second.id,
    });
    let router: Router | undefined;
    const host = await mountView(
      StoryView,
      { id: stored.storyId },
      (instance) => (router = instance),
    );
    const listen = await until(
      () => host.querySelectorAll<HTMLElement>('.book-listen')[1],
      'Book 2’s Listen',
    );

    listen.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader route');
    // The header around it opens its book on a click: that must not follow.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(router!.currentRoute.value.name).toBe('reader');
    expect(router!.currentRoute.value.params.partId).toBe(two.id);
    // Its first part is not analysed yet: the reader shows it, and nothing plays.
    expect(played).not.toHaveBeenCalled();
  });

  it('sums up each book under its title, with Listen when it has parts', async () => {
    const stored = await storyWithParts();
    // The story's parts become “Book 1”; “Book 2” stays empty.
    await addBook(db, stored.storyId, 'Book 2');
    const host = await mountView(StoryView, { id: stored.storyId });
    await until(() => host.querySelectorAll('.book').length === 2, 'the books');
    const books = [...host.querySelectorAll<HTMLElement>('.book')].map((book) => ({
      title: book.querySelector('h2')?.textContent,
      summary: book.querySelector('.book-summary')?.textContent?.replace(/\s+/gu, ' ').trim(),
      listen: book.querySelector('.book-listen')?.getAttribute('aria-label'),
    }));
    expect(books).toEqual([
      {
        title: 'Book 1',
        summary: '3 parts · 2 not analysed',
        listen: 'Listen to Book 1 from the start',
      },
      { title: 'Book 2', summary: 'No parts yet', listen: undefined },
    ]);
  });

  it('does not read the parts again when only the story’s place is saved', async () => {
    const stored = await storyWithParts();
    const reads = vi.spyOn(db.parts, 'bulkGet');
    try {
      const host = await mountView(StoryView, { id: stored.storyId });
      await until(() => host.querySelectorAll('.part').length === 3, 'the parts');
      const before = reads.mock.calls.length;
      // While a story plays, its place is saved every few seconds.
      await updateStory(db, stored.storyId, {
        position: { partId: stored.partId, segmentIndex: 0 },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(reads.mock.calls.length).toBe(before);
      // A change to a part is read.
      await db.parts.update(stored.partId, { title: 'One, renamed' });
      await until(() => rows(host)[0]?.title === 'One, renamed', 'the new title');
      expect(reads.mock.calls.length).toBeGreaterThan(before);
    } finally {
      reads.mockRestore();
    }
  });
});

/**
 * Calls `look` now and after every change to the page, until the function this returns is called:
 * a page that shows something for a moment only is caught too.
 */
function watchPage(host: HTMLElement, look: () => void): () => void {
  const observer = new MutationObserver(look);
  observer.observe(host, { subtree: true, childList: true, characterData: true });
  look();
  return () => observer.disconnect();
}

describe('listening', () => {
  /**
   * Adds a part the narrator reads, analysed: one line per piece, each piece ten letters long, so
   * line n starts n tenths of the way in.
   */
  async function addHeardPart(storyId: string, title: string, lines: number, bookId?: string) {
    const pieces = Array.from({ length: lines }, (_, n) => `Line ${n}...`.padEnd(10, '.'));
    const text = pieces.join('');
    const part = await addPart(db, storyId, { title, source: { kind: 'paste' }, text, bookId });
    await analyseInLines(part, 10);
    return part;
  }

  /** Saves an analysis of `part` that cuts its text into lines `width` letters long. */
  async function analyseInLines(part: Part, width: number) {
    const narratorId = (await getStory(db, part.storyId))!.narratorId;
    const count = Math.ceil(part.text.length / width);
    const segments = Array.from({ length: count }, (_, n): Segment => ({
      start: n * width,
      end: Math.min(part.text.length, n * width + width),
      speakerId: narratorId,
      mode: 'narration',
      source: 'heuristic',
    }));
    await saveAnalysis(db, {
      partId: part.id,
      textHash: part.textHash,
      analyzer: { kind: 'heuristic', version: 2 },
      createdAt: new Date().toISOString(),
      segments,
    });
  }

  /** A story of two books, each with one part, ten lines long unless `lines` says otherwise. */
  async function twoBooks(lines: [number, number] = [10, 10]) {
    const story = await createStory(db, { title: 'Story', lang: 'en' });
    const first = await addBook(db, story.id, 'Book 1');
    const second = await addBook(db, story.id, 'Book 2');
    const one = await addHeardPart(story.id, 'Into the woods', lines[0], first.id);
    const two = await addHeardPart(story.id, 'The way back', lines[1], second.id);
    return { storyId: story.id, books: [first, second], one, two };
  }

  /** What the Continue button says: what it does, and where. */
  const listenButton = (host: HTMLElement) => {
    const listen = host.querySelector<HTMLButtonElement>('.listen');
    return {
      what: listen?.querySelector('.listen-what')?.textContent?.trim(),
      where: listen?.querySelector('.listen-where')?.textContent?.replace(/\s+/gu, ' ').trim(),
    };
  };

  const bookButtons = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('.book-listen')].map((pill) => ({
      text: pill.textContent?.trim(),
      label: pill.getAttribute('aria-label'),
    }));

  const click = (element: Element | null | undefined) => (element as HTMLElement).click();

  it('starts a story never played at its first part, and opens the reader there', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: stored.storyId }, (r) => (router = r));
    await until(() => listenButton(host).where, 'the Continue button');

    expect(listenButton(host)).toEqual({ what: 'Start listening', where: '1. One' });
    expect(placeRestored).toHaveBeenCalledWith(stored.storyId);

    click(host.querySelector('.listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');
    // From the place the player restores, if the app was killed mid-story, else the start.
    expect(played).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(router!.currentRoute.value.params.partId).toBe(stored.partId);
  });

  it('says where listening goes on, and goes on from there', async () => {
    const { storyId, two } = await twoBooks();
    await updateStory(db, storyId, { position: { partId: two.id, segmentIndex: 4 } });
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: storyId }, (r) => (router = r));
    await until(() => listenButton(host).where?.includes('%'), 'the place');

    expect(listenButton(host)).toEqual({
      what: 'Continue',
      where: 'Book 2 · 1. The way back · 40%',
    });
    // Starting Book 1 would lose the place: only its own book offers to go on.
    expect(bookButtons(host)).toEqual([{ text: 'Continue', label: 'Continue Book 2' }]);

    click(host.querySelector('.listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');
    expect(played).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(router!.currentRoute.value.params.partId).toBeFalsy();
  });

  it('goes on from the place with its book’s Continue, as the main button does', async () => {
    const { storyId, two } = await twoBooks();
    await updateStory(db, storyId, { position: { partId: two.id, segmentIndex: 4 } });
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: storyId }, (r) => (router = r));
    await until(() => bookButtons(host).length === 1, 'the books');

    click(host.querySelector('.book-listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');

    expect(played).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(router!.currentRoute.value.params.partId).toBeFalsy();
  });

  it('offers Continue on the page of the book with the place, and nothing on another’s', async () => {
    const { storyId, two, books } = await twoBooks();
    await updateStory(db, storyId, { position: { partId: two.id, segmentIndex: 4 } });
    const host = await mountView(StoryView, { id: storyId, bookId: books[1]!.id });
    await until(() => bookButtons(host).length === 1, 'the book');

    expect(bookButtons(host)).toEqual([{ text: 'Continue', label: 'Continue Book 2' }]);
    expect(host.querySelector('.listen')).toBeNull();
    click(host.querySelector('.book-listen'));
    await until(() => played.mock.calls.length, 'playback');
    expect(played).toHaveBeenCalledExactlyOnceWith(undefined);

    unmountView();
    const other = await mountView(StoryView, { id: storyId, bookId: books[0]!.id });
    await until(() => other.querySelector('.book-summary'), 'the other book');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bookButtons(other)).toEqual([]);
  });

  it('starts any book from its beginning while nothing has been heard', async () => {
    const { storyId, two } = await twoBooks();
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: storyId }, (r) => (router = r));
    await until(() => bookButtons(host).length === 2, 'the books');
    expect(bookButtons(host)).toEqual([
      { text: 'Listen', label: 'Listen to Book 1 from the start' },
      { text: 'Listen', label: 'Listen to Book 2 from the start' },
    ]);

    click(host.querySelectorAll('.book-listen')[1]);
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');

    expect(played).toHaveBeenCalledExactlyOnceWith({ partId: two.id, segmentIndex: 0 });
    expect(router!.currentRoute.value.params.partId).toBe(two.id);
    await until(() => listenButton(host).what === 'Now playing', 'the playing state');
    expect(listenButton(host).where).toBe('Book 2 · 1. The way back');
    expect(bookButtons(host)).toEqual([{ text: 'Playing', label: 'Playing Book 2' }]);

    // While it plays, Continue only opens the reader.
    await router!.push({ name: 'story', params: { id: storyId } });
    click(host.querySelector('.listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader again');
    expect(played).toHaveBeenCalledTimes(1);
    expect(resumed).not.toHaveBeenCalled();
  });

  it('resumes a story paused elsewhere, from the player’s place', async () => {
    const { storyId, one, two } = await twoBooks();
    await updateStory(db, storyId, { position: { partId: one.id, segmentIndex: 0 } });
    playerAlreadyMade(storyId, {
      state: 'paused',
      speed: 1,
      position: { partId: two.id, segmentIndex: 7 },
    });
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: storyId }, (r) => (router = r));
    await until(() => listenButton(host).where?.includes('%'), 'the place');

    expect(listenButton(host)).toEqual({
      what: 'Continue',
      where: 'Book 2 · 1. The way back · 70%',
    });
    click(host.querySelector('.listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');

    expect(resumed).toHaveBeenCalledOnce();
    expect(played).not.toHaveBeenCalled();
  });

  /** A player made before the page: in `state`, at `line` of Book 2 if given; a saved place too. */
  interface PlayerCase {
    when: string;
    state: 'idle' | 'blocked';
    line?: number;
    saved?: number;
    where: string;
  }
  it.each<PlayerCase>([
    {
      when: 'an idle player with no place of its own (the Cast page made it)',
      state: 'idle',
      saved: 6,
      where: 'Book 2 · 1. The way back · 60%',
    },
    {
      when: 'an idle player with a place, ahead of the one saved',
      state: 'idle',
      line: 3,
      saved: 1,
      where: 'Book 2 · 1. The way back · 30%',
    },
    {
      when: 'a player that could not go on, and nothing saved',
      state: 'blocked',
      line: 2,
      where: 'Book 2 · 1. The way back · 20%',
    },
  ])('goes on from the place with $when', async ({ state, line, saved, where }) => {
    const { storyId, two } = await twoBooks();
    if (saved !== undefined) {
      await updateStory(db, storyId, { position: { partId: two.id, segmentIndex: saved } });
    }
    const position = line === undefined ? undefined : { partId: two.id, segmentIndex: line };
    playerAlreadyMade(storyId, {
      state,
      speed: 1,
      ...(position ? { position } : {}),
      ...(state === 'blocked' ? { message: 'This part could not be read.' } : {}),
    });
    const host = await mountView(StoryView, { id: storyId });
    await until(() => listenButton(host).where === where, 'the place');

    expect(listenButton(host).what).toBe('Continue');
    click(host.querySelector('.listen'));
    await until(() => played.mock.calls.length, 'playback');
    // The player's own place when it has one; else the saved one, as the player restores it.
    expect(played).toHaveBeenCalledExactlyOnceWith(position);
    expect(resumed).not.toHaveBeenCalled();
  });

  it('leaves another story playing until this one is played', async () => {
    const other = await storeStory([['Somewhere else.', 'N', 'narration']]);
    playerAlreadyMade(other.storyId, {
      state: 'playing',
      speed: 1,
      position: { partId: other.partId, segmentIndex: 0 },
    });
    const { storyId, two } = await twoBooks();
    await updateStory(db, storyId, { position: { partId: two.id, segmentIndex: 4 } });
    const host = await mountView(StoryView, { id: storyId });
    await until(() => listenButton(host).where?.includes('%'), 'the place');

    expect(listenButton(host).what).toBe('Continue');
    expect(stopped).not.toHaveBeenCalled();

    click(host.querySelector('.listen'));
    await until(() => played.mock.calls.length, 'playback');
    expect(stopped).toHaveBeenCalledOnce();
    expect(played).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('starts from the beginning once the part being heard is deleted', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    const gone = await addHeardPart(stored.storyId, 'Gone', 10);
    playerAlreadyMade(stored.storyId, {
      state: 'idle',
      speed: 1,
      position: { partId: gone.id, segmentIndex: 4 },
    });
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: stored.storyId }, (r) => (router = r));
    await until(() => listenButton(host).where === '2. Gone · 40%', 'the place');

    await deletePart(db, stored.storyId, gone.id);
    await until(() => listenButton(host).what === 'Start listening', 'the place gone');
    expect(listenButton(host).where).toBe('1. One');

    click(host.querySelector('.listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');
    expect(played).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(router!.currentRoute.value.params.partId).toBe(stored.partId);
  });

  it.each(['idle', 'paused'] as const)(
    'goes on from the saved place when the player’s own part was deleted (%s)',
    async (state) => {
      const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
      const kept = await addHeardPart(stored.storyId, 'Kept', 10);
      const gone = await addHeardPart(stored.storyId, 'Gone', 10);
      await updateStory(db, stored.storyId, { position: { partId: kept.id, segmentIndex: 3 } });
      playerAlreadyMade(stored.storyId, {
        state,
        speed: 1,
        position: { partId: gone.id, segmentIndex: 4 },
      });
      const host = await mountView(StoryView, { id: stored.storyId });
      await until(() => listenButton(host).where === '3. Gone · 40%', 'the player’s place');

      await deletePart(db, stored.storyId, gone.id);
      await until(() => listenButton(host).where === '2. Kept · 30%', 'the saved place');
      click(host.querySelector('.listen'));
      await until(() => played.mock.calls.length, 'playback');
      // Not the queue paused in the deleted part.
      expect(played).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(resumed).not.toHaveBeenCalled();
    },
  );

  it('offers to listen again from the start once the story was heard to its end', async () => {
    const { storyId, one, two } = await twoBooks();
    await updateStory(db, storyId, { position: { partId: two.id, segmentIndex: 9 }, ended: true });
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: storyId }, (r) => (router = r));
    // Every state the page shows as it opens: no Continue on the way to Listen again.
    const shown = new Set<string>();
    const stop = watchPage(host, () => {
      const { what, where } = listenButton(host);
      const pills = bookButtons(host).map((pill) => pill.text);
      if (what) shown.add(`${what} | ${where} | ${pills.join('/')}`);
    });
    await until(() => listenButton(host).what === 'Listen again', 'the end');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    // Nothing is lost by starting any book.
    expect([...shown]).toEqual(['Listen again | Book 1 · 1. Into the woods | Listen/Listen']);

    click(host.querySelector('.listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');
    expect(played).toHaveBeenCalledExactlyOnceWith({ partId: one.id, segmentIndex: 0 });
    expect(router!.currentRoute.value.params.partId).toBe(one.id);
  });

  it('offers to listen again where the player ended, before a last line with nothing to say', async () => {
    const { storyId, one, two } = await twoBooks();
    // The part's last line ("* * *", say) is not spoken: listening ended on the line before it.
    playerAlreadyMade(storyId, {
      state: 'idle',
      speed: 1,
      position: { partId: two.id, segmentIndex: 8 },
      message: 'End of the story.',
      ended: true,
    });
    const host = await mountView(StoryView, { id: storyId });
    await until(() => listenButton(host).what, 'the end');

    expect(listenButton(host)).toEqual({
      what: 'Listen again',
      where: 'Book 1 · 1. Into the woods',
    });
    expect(bookButtons(host).map((pill) => pill.text)).toEqual(['Listen', 'Listen']);
    click(host.querySelector('.listen'));
    await until(() => played.mock.calls.length, 'playback');
    expect(played).toHaveBeenCalledExactlyOnceWith({ partId: one.id, segmentIndex: 0 });
  });

  it('goes on at the story’s last line when listening only got there', async () => {
    // A last part one line long: the player waits on its only line, moved there, say.
    const { storyId, two } = await twoBooks([10, 1]);
    playerAlreadyMade(storyId, {
      state: 'idle',
      speed: 1,
      position: { partId: two.id, segmentIndex: 0 },
    });
    const host = await mountView(StoryView, { id: storyId });
    await until(() => listenButton(host).what, 'the place');

    expect(listenButton(host)).toEqual({ what: 'Continue', where: 'Book 2 · 1. The way back' });
    expect(bookButtons(host)).toEqual([{ text: 'Continue', label: 'Continue Book 2' }]);
    click(host.querySelector('.listen'));
    await until(() => played.mock.calls.length, 'playback');
    expect(played).toHaveBeenCalledExactlyOnceWith({ partId: two.id, segmentIndex: 0 });
  });

  it('goes on with a part added after the end, from its start', async () => {
    const { storyId, books, two } = await twoBooks();
    await updateStory(db, storyId, { position: { partId: two.id, segmentIndex: 9 }, ended: true });
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: storyId }, (r) => (router = r));
    await until(() => listenButton(host).what === 'Listen again', 'the end');

    const added = await addHeardPart(storyId, 'Home again', 10, books[1]!.id);
    await until(() => listenButton(host).what === 'Continue', 'the new part');
    expect(listenButton(host).where).toBe('Book 2 · 2. Home again');
    expect(bookButtons(host)).toEqual([{ text: 'Continue', label: 'Continue Book 2' }]);

    click(host.querySelector('.listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');
    expect(played).toHaveBeenCalledExactlyOnceWith({ partId: added.id, segmentIndex: 0 });
    expect(router!.currentRoute.value.params.partId).toBe(added.id);
  });

  it('goes on from the last line of a part that is not the story’s last', async () => {
    const { storyId, one } = await twoBooks();
    await updateStory(db, storyId, { position: { partId: one.id, segmentIndex: 9 } });
    const host = await mountView(StoryView, { id: storyId });
    await until(() => listenButton(host).where?.includes('%'), 'the place');

    expect(listenButton(host)).toEqual({
      what: 'Continue',
      where: 'Book 1 · 1. Into the woods · 90%',
    });
    expect(bookButtons(host)).toEqual([{ text: 'Continue', label: 'Continue Book 1' }]);
  });

  it('says Now playing on the last line while it plays, before the end saved there is cleared', async () => {
    const { storyId, two } = await twoBooks();
    // Played again from the end: the end saved stays until the player saves its next line.
    await updateStory(db, storyId, { position: { partId: two.id, segmentIndex: 9 }, ended: true });
    playerAlreadyMade(storyId, {
      state: 'playing',
      speed: 1,
      position: { partId: two.id, segmentIndex: 9 },
    });
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: storyId }, (r) => (router = r));
    await until(() => listenButton(host).where?.includes('%'), 'the place');

    expect(listenButton(host)).toEqual({
      what: 'Now playing',
      where: 'Book 2 · 1. The way back · 90%',
    });
    expect(bookButtons(host)).toEqual([{ text: 'Playing', label: 'Playing Book 2' }]);
    click(host.querySelector('.listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');
    expect(played).not.toHaveBeenCalled();
  });

  it('starts at the first part when the saved place is in a part that no longer exists', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await updateStory(db, stored.storyId, { position: { partId: 'deleted', segmentIndex: 1 } });
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: stored.storyId }, (r) => (router = r));
    await until(() => listenButton(host).what, 'the button');
    expect(listenButton(host)).toEqual({ what: 'Start listening', where: '1. One' });

    click(host.querySelector('.listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');
    // Not from the saved place: the player would find nothing to read there.
    expect(played).toHaveBeenCalledExactlyOnceWith({ partId: stored.partId, segmentIndex: 0 });
  });

  it('gives how far into its own part the place is, never into the part it was in', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    const first = await addHeardPart(stored.storyId, 'First', 10);
    // The same words cut into four lines: only the part tells the two analyses apart.
    const second = await addPart(db, stored.storyId, {
      title: 'Second',
      source: { kind: 'paste' },
      text: first.text,
    });
    await analyseInLines(second, 25);
    playerAlreadyMade(stored.storyId, {
      state: 'paused',
      speed: 1,
      position: { partId: first.id, segmentIndex: 8 },
    });
    const host = await mountView(StoryView, { id: stored.storyId });
    const shown = new Set<string>();
    const stop = watchPage(host, () => {
      const where = listenButton(host).where;
      if (where?.includes('%')) shown.add(where);
    });
    await until(() => listenButton(host).where?.endsWith('80%'), 'the place');

    playerSnapshot.value = {
      ...playerSnapshot.value,
      position: { partId: second.id, segmentIndex: 2 },
    };
    await until(() => listenButton(host).where?.endsWith('50%'), 'the place in the next part');
    stop();
    expect([...shown]).toEqual(['2. First · 80%', '3. Second · 50%']);
  });

  it('goes on from the last line when the player was only paused there', async () => {
    const { storyId, two } = await twoBooks();
    playerAlreadyMade(storyId, {
      state: 'paused',
      speed: 1,
      position: { partId: two.id, segmentIndex: 9 },
    });
    const host = await mountView(StoryView, { id: storyId });
    await until(() => listenButton(host).where?.includes('%'), 'the place');

    expect(listenButton(host)).toEqual({
      what: 'Continue',
      where: 'Book 2 · 1. The way back · 90%',
    });
  });

  it('gives no percentage at the start of a part, or past the lines it has', async () => {
    const { storyId, one } = await twoBooks();
    const placeAt = (segmentIndex: number) =>
      updateStory(db, storyId, { position: { partId: one.id, segmentIndex } });
    await placeAt(4);
    const host = await mountView(StoryView, { id: storyId });
    const where = () => listenButton(host).where;
    await until(() => where()?.endsWith('40%'), 'the place');

    // A place kept from an analysis with more lines than this one has.
    await placeAt(99);
    await until(() => where() === 'Book 1 · 1. Into the woods', 'no percentage past the lines');
    await placeAt(6);
    await until(() => where()?.endsWith('60%'), 'the place again');
    await placeAt(0);
    await until(() => where() === 'Book 1 · 1. Into the woods', 'no percentage at the start');
    expect(listenButton(host).what).toBe('Continue');
  });

  it('only opens a part not analysed yet: the reader says why it cannot be heard', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    const waiting = await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'Not read yet.',
    });
    await updateStory(db, stored.storyId, { position: { partId: waiting.id, segmentIndex: 0 } });
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: stored.storyId }, (r) => (router = r));
    await until(() => listenButton(host).where === '2. Two', 'the place');

    click(host.querySelector('.listen'));
    await until(() => router?.currentRoute.value.name === 'reader', 'the reader');

    expect(played).not.toHaveBeenCalled();
    expect(resumed).not.toHaveBeenCalled();
  });

  it.each(['running', 'failed'] as const)(
    'plays a part being analysed again (%s), from the analysis it has',
    async (status) => {
      const { storyId, two } = await twoBooks();
      await updateStory(db, storyId, { position: { partId: two.id, segmentIndex: 4 } });
      await setAnalysisStatus(db, two.id, status);
      const host = await mountView(StoryView, { id: storyId });
      await until(() => listenButton(host).where?.includes('40%'), 'the place');

      click(host.querySelector('.listen'));
      await until(() => played.mock.calls.length, 'playback');
      expect(played).toHaveBeenCalledExactlyOnceWith(undefined);
    },
  );

  it('sends the player back to a part’s first line when its text is replaced', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    const heard = await addHeardPart(stored.storyId, 'Heard', 10);
    playerAlreadyMade(stored.storyId, {
      state: 'paused',
      speed: 1,
      position: { partId: heard.id, segmentIndex: 5 },
    });
    const host = await mountView(StoryView, { id: stored.storyId });
    const row = await until(() => host.querySelectorAll<HTMLElement>('.part')[1], 'the row');

    click(row.querySelector('.part-menu summary'));
    button(row, 'Replace text…')!.click();
    const form = await until(() => host.querySelector('form.replacing'), 'the replace form');
    typeInto(form.querySelector('textarea')!, 'A new text, read from its start.');
    submit(form);

    await until(() => jumped.mock.calls.length, 'the player told');
    expect(jumped).toHaveBeenCalledExactlyOnceWith({ partId: heard.id, segmentIndex: 0 });
    expect(resumed).not.toHaveBeenCalled();
  });

  it('leaves the player where it is when another part’s text is replaced', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    const heard = await addHeardPart(stored.storyId, 'Heard', 10);
    playerAlreadyMade(stored.storyId, {
      state: 'paused',
      speed: 1,
      position: { partId: heard.id, segmentIndex: 5 },
    });
    const host = await mountView(StoryView, { id: stored.storyId });
    const row = await until(() => host.querySelectorAll<HTMLElement>('.part')[0], 'the row');

    click(row.querySelector('.part-menu summary'));
    button(row, 'Replace text…')!.click();
    const form = await until(() => host.querySelector('form.replacing'), 'the replace form');
    typeInto(form.querySelector('textarea')!, 'Another beginning.');
    submit(form);

    await until(
      async () => (await listParts(db, stored.storyId))[0]?.analysisStatus === 'done',
      'the new text analysed',
    );
    expect(jumped).not.toHaveBeenCalled();
    // Whether its queue holds that part is the player's to check: once the old text is gone, and
    // again once the new text is analysed.
    expect(partsChanged).toHaveBeenCalledTimes(2);
  });

  describe('has the player check its queue', () => {
    /** Does `act`, waits for `done`, then for the player to be asked to check its queue again. */
    async function checkedAfter(act: () => void, done: () => Promise<boolean>, what: string) {
      const before = partsChanged.mock.calls.length;
      act();
      await until(done, what);
      await until(() => partsChanged.mock.calls.length > before, `a check after ${what}`);
    }

    const pressKey = (target: Element | null, key: string) =>
      target!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));

    /** Two books, the player playing in the first; its parts in reading order. */
    async function playingStory(...extra: string[]) {
      const { storyId, books, one } = await twoBooks();
      for (const title of extra) {
        const text = `${title} words.`;
        await addPart(db, storyId, {
          title,
          source: { kind: 'paste' },
          text,
          bookId: books[0]!.id,
        });
      }
      playerAlreadyMade(storyId, {
        state: 'playing',
        speed: 1,
        position: { partId: one.id, segmentIndex: 2 },
      });
      const titles = async () => (await listParts(db, storyId)).map((part) => part.title).join();
      return { storyId, books, titles };
    }

    it('once parts are analysed, moved or deleted', async () => {
      const { storyId, books, titles } = await playingStory('Extra', 'Spare');
      const host = await mountView(StoryView, { id: storyId, bookId: books[0]!.id });
      const row = (title: string) =>
        [...host.querySelectorAll<HTMLElement>('.part')].find((part) =>
          part.textContent?.includes(title),
        )!;
      await until(() => row('Spare'), 'the parts');

      await checkedAfter(
        () => button(row('Extra'), 'Analyse')!.click(),
        async () =>
          (await listParts(db, storyId)).find((part) => part.title === 'Extra')?.analysisStatus ===
          'done',
        'the analysis',
      );
      await checkedAfter(
        () => pressKey(row('Extra').querySelector('.part-menu summary'), 'ArrowUp'),
        async () => (await titles()) === 'Extra,Into the woods,Spare,The way back',
        'the move up',
      );
      await checkedAfter(
        () => {
          click(row('Spare').querySelector('.part-menu summary'));
          const remove = button(row('Spare'), 'Delete part')!;
          remove.click();
          remove.click();
        },
        async () => (await titles()) === 'Extra,Into the woods,The way back',
        'the deletion',
      );
      await checkedAfter(
        () => {
          click(row('Extra').querySelector('.part-menu summary'));
          button(row('Extra'), 'Move to “Book 2”')!.click();
        },
        async () => (await titles()) === 'Into the woods,The way back,Extra',
        'the move to Book 2',
      );
    });

    it('once books are moved or deleted', async () => {
      const { storyId, titles } = await playingStory();
      const host = await mountView(StoryView, { id: storyId });
      const menus = () => host.querySelectorAll<HTMLElement>('.book-menu summary');
      await until(() => menus().length === 2, 'the books');

      await checkedAfter(
        () => pressKey(menus()[1]!, 'ArrowUp'),
        async () => (await titles()) === 'The way back,Into the woods',
        'the move up',
      );
      await checkedAfter(
        () => {
          const section = host.querySelectorAll<HTMLElement>('.book')[0]!;
          click(section.querySelector('.book-menu summary'));
          const remove = button(section, /Delete book/)!;
          remove.click();
          remove.click();
        },
        async () => (await titles()) === 'Into the woods',
        'the deletion',
      );
    });
  });

  it('lifts a book held by its play button, and plays nothing on release', async () => {
    const { storyId } = await twoBooks();
    const host = await mountView(StoryView, { id: storyId });
    const sections = await until(() => {
      const current = host.querySelectorAll<HTMLElement>('.book');
      return bookButtons(host).length === 2 ? current : undefined;
    }, 'the books');
    stack([...sections]);
    const pill = sections[0]!.querySelector<HTMLElement>('.book-listen')!;
    const pointer = (type: string, init: MouseEventInit) =>
      Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }), {
        pointerId: 5,
      });

    pill.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 20, clientY: 10 }));
    await hold();
    window.dispatchEvent(pointer('pointermove', { clientX: 20, clientY: 170 }));
    await nextTick();
    expect([...host.querySelectorAll('.book h2')].map((title) => title.textContent)).toEqual([
      'Book 2',
      'Book 1',
    ]);
    window.dispatchEvent(pointer('pointerup', {}));
    // The click a release fires.
    pill.click();

    await until(async () => {
      const story = await getStory(db, storyId);
      return story?.books?.map((book) => book.title).join(',') === 'Book 2,Book 1';
    }, 'the new order');
    expect(played).not.toHaveBeenCalled();
  });
});

describe('while the parts are read', () => {
  const textOf = (element: Element) => element.textContent?.replace(/\s+/gu, ' ').trim() ?? '';

  it('shows the books once their parts are read, none of them empty meanwhile', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    const second = await addBook(db, stored.storyId, 'Book 2');
    await addPart(db, stored.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'The next book.',
      bookId: second.id,
    });
    const host = await mountView(StoryView, { id: stored.storyId });
    const seen = new Set<string>();
    const stop = watchPage(host, () => {
      for (const summary of host.querySelectorAll('.book-summary')) seen.add(textOf(summary));
      // Shown alone, it would move down under the books a moment later.
      if (host.querySelector('.add-book-button') && !host.querySelector('.book')) {
        seen.add('Add a book before the books');
      }
    });
    await until(() => host.querySelectorAll('.book-listen').length === 2, 'both books');
    stop();

    expect([...seen]).toEqual(['1 part', '1 part · 1 not analysed']);
  });

  it('offers Add a part once the parts are read, so it adds at the end', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    const host = await mountView(StoryView, { id: stored.storyId });
    let early = false;
    const stop = watchPage(host, () => {
      if (button(host, 'Add a part') && !host.querySelector('.part')) early = true;
    });
    await until(() => host.querySelector('.part') && button(host, 'Add a part'), 'the part');
    stop();

    expect(early).toBe(false);
  });

  it('says a book is missing only once the parts are read, and only when it is', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addBook(db, stored.storyId, 'Book 2');
    const story = (await getStory(db, stored.storyId))!;
    let host = await mountView(StoryView, { id: stored.storyId, bookId: story.books![0]!.id });
    const said = new Set<string>();
    const stop = watchPage(host, () => {
      for (const status of host.querySelectorAll('[role="status"]')) said.add(textOf(status));
    });
    await until(() => host.querySelector('.book-summary'), 'the book');
    stop();
    expect(said).not.toContain('Book not found.');

    unmountView();
    host = await mountView(StoryView, { id: stored.storyId, bookId: 'no-such-book' });
    await until(
      () => host.querySelector('[role="status"]')?.textContent === 'Book not found.',
      'the message',
    );
    expect(host.querySelector('.book')).toBeNull();
  });
});
