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
    const target = parts[2]!;

    expect(title.getAttribute('draggable')).toBe('false');
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 200,
      bottom: 300,
      left: 0,
      right: 400,
      width: 400,
      height: 100,
      x: 0,
      y: 200,
      toJSON: () => ({}),
    });

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 20,
      clientY: 0,
    });
    Object.assign(pointerDown, { pointerId: 12 });
    title.dispatchEvent(pointerDown);
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
    const target = sections[2]!;
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 200,
      bottom: 300,
      left: 0,
      right: 400,
      width: 400,
      height: 100,
      x: 0,
      y: 200,
      toJSON: () => ({}),
    });

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 20,
      clientY: 0,
    });
    Object.assign(pointerDown, { pointerId: 7 });
    actions!.dispatchEvent(pointerDown);
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
    const titleTarget = [...host.querySelectorAll<HTMLElement>('.book')].find((section) =>
      section.querySelector('h2')?.textContent?.includes('Book 2'),
    )!;
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(titleTarget);
    vi.spyOn(titleTarget, 'getBoundingClientRect').mockReturnValue({
      top: 200,
      bottom: 300,
      left: 0,
      right: 400,
      width: 400,
      height: 100,
      x: 0,
      y: 200,
      toJSON: () => ({}),
    });
    const titlePointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 20,
      clientY: 0,
    });
    Object.assign(titlePointerDown, { pointerId: 11 });
    draggedBook.querySelector('h2')!.dispatchEvent(titlePointerDown);
    const titlePointerMove = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 210,
    });
    Object.assign(titlePointerMove, { pointerId: 11 });
    window.dispatchEvent(titlePointerMove);
    await nextTick();

    expect(draggedBook.classList.contains('dragging')).toBe(true);
    expect(document.elementFromPoint).toHaveBeenCalled();
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
    const target = parts[2]!;

    expect(actions).not.toBeNull();
    expect(row).not.toBeNull();
    expect(host.textContent).not.toContain('Move up');
    expect(host.textContent).not.toContain('Move down');
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 200,
      bottom: 300,
      left: 0,
      right: 400,
      width: 400,
      height: 100,
      x: 0,
      y: 200,
      toJSON: () => ({}),
    });

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 20,
      clientY: 0,
    });
    Object.assign(pointerDown, { pointerId: 8 });
    actions!.dispatchEvent(pointerDown);
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
    const actionPointerUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
    Object.assign(actionPointerUp, { pointerId: 8 });
    window.dispatchEvent(actionPointerUp);
    await until(async () => {
      const currentParts = await listParts(db, stored.storyId);
      return currentParts.map((part) => part.title).join(',') === 'One,Two,Three'
        ? currentParts
        : undefined;
    }, 'the part order dragged from its actions control');

    vi.spyOn(document, 'elementFromPoint').mockReturnValue(parts[1]!);
    vi.spyOn(parts[1]!, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 100,
      left: 0,
      right: 400,
      width: 400,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
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

    expect([...host.querySelectorAll('.part-title')].map((title) => title.textContent)).toEqual([
      'One',
      'Two',
      'Three',
    ]);

    const pointerUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
    Object.assign(pointerUp, { pointerId: 10 });
    window.dispatchEvent(pointerUp);

    await until(async () => {
      const currentParts = await listParts(db, stored.storyId);
      return currentParts.map((part) => part.title).join(',') === 'Two,Three,One'
        ? currentParts
        : undefined;
    }, 'the saved part order');

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
});
