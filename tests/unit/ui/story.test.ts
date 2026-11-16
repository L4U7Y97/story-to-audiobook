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
  it('opens and closes a book when its heading is clicked', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addBook(db, stored.storyId, 'Book 2');
    const host = await mountView(StoryView, { id: stored.storyId });
    const heading = await until(
      () => host.querySelector<HTMLElement>('.book-header h2'),
      'the book heading',
    );
    const collapse = heading
      .closest('.book-header')!
      .querySelector<HTMLButtonElement>('.book-collapse')!;

    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    heading.click();
    await nextTick();
    expect(collapse.getAttribute('aria-expanded')).toBe('false');
    heading.click();
    await nextTick();
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
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
    let router: Router | undefined;
    const host = await mountView(StoryView, { id: stored.storyId }, (instance) => {
      router = instance;
    });
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
        [...host.querySelectorAll('.book h2')]
          .map((heading) => heading.textContent)
          .join(',') === 'Book 2,Book 3,Book 1',
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

    expect(draggedBook.classList.contains('book-dragging')).toBe(true);
    expect(document.elementFromPoint).toHaveBeenCalled();
    expect([...host.querySelectorAll('.book h2')].map((heading) => heading.textContent)).toEqual([
      'Book 1',
      'Book 2',
      'Book 3',
    ]);

    const titlePointerUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
    Object.assign(titlePointerUp, { pointerId: 11 });
    window.dispatchEvent(titlePointerUp);

    await until(async () => {
      const story = await getStory(db, stored.storyId);
      return story?.books?.map((book) => book.title).join(',') === 'Book 1,Book 2,Book 3'
        ? story
        : undefined;
    }, 'the saved book order', 10_000);

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

  it('collapses a book’s parts and lets the user expand them again', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addBook(db, stored.storyId, 'Book 2');
    const story = (await getStory(db, stored.storyId))!;
    const host = await mountView(StoryView, { id: stored.storyId });
    const section = await until(() => host.querySelector<HTMLElement>('.book'), 'the book section');
    const content = host.querySelector<HTMLElement>('.book-content')!;
    const otherSection = host.querySelectorAll<HTMLElement>('.book')[1]!;
    const otherContent = otherSection.querySelector<HTMLElement>('.book-content')!;
    const collapse = section.querySelector<HTMLButtonElement>('.book-collapse');

    expect(collapse?.getAttribute('aria-label')).toBe(`Collapse ${story.books![0]!.title}`);
    expect(collapse?.querySelector('svg')).not.toBeNull();
    expect(collapse?.textContent?.trim()).toBe('');
    expect(collapse?.getAttribute('aria-expanded')).toBe('true');
    expect(content.style.display).not.toBe('none');

    collapse!.click();

    const expand = await until(
      () => section.querySelector<HTMLButtonElement>('.book-collapse[aria-expanded="false"]'),
      'the collapsed book control',
    );
    expect(expand.getAttribute('aria-label')).toBe(`Expand ${story.books![0]!.title}`);
    expect(expand.querySelector('svg')).not.toBeNull();
    expect(expand.textContent?.trim()).toBe('');
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(content.style.display).toBe('none');
    expect(section.querySelector('h2')?.textContent).toBe(story.books![0]!.title);
    expect(otherContent.style.display).not.toBe('none');

    expand.click();

    expect(
      (
        await until(
          () => section.querySelector<HTMLButtonElement>('.book-collapse[aria-expanded="true"]'),
          'the expanded book control',
        )
      ).getAttribute('aria-label'),
    ).toBe(`Collapse ${story.books![0]!.title}`);
    expect(
      section.querySelector<HTMLButtonElement>('.book-collapse')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(content.style.display).not.toBe('none');
  });
});
