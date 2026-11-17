import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { Router } from 'vue-router';
import { addBook } from '@/storage/books';
import { addPart, listParts } from '@/storage/parts';
import { getStory } from '@/storage/stories';
import StoryView from '@/ui/views/StoryView.vue';
import { db, mountView, storeStory, unmountView, until } from '../../helpers/ui';

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
