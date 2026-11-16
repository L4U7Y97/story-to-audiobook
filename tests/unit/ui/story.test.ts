import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { addBook } from '@/storage/books';
import { addPart, listParts } from '@/storage/parts';
import { getStory } from '@/storage/stories';
import StoryView from '@/ui/views/StoryView.vue';
import { db, mountView, storeStory, unmountView, until } from '../../helpers/ui';

vi.mock('@/ui/composables/usePlayer', () => import('../../helpers/ui').then((m) => m.playerStub()));

afterEach(unmountView);

describe('book sections', () => {
  it('reorders books as a section is dragged and saves the new order when released', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addBook(db, stored.storyId, 'Book 2');
    await addBook(db, stored.storyId, 'Book 3');
    const host = await mountView(StoryView, { id: stored.storyId });
    const sections = await until(() => {
      const current = host.querySelectorAll<HTMLElement>('.book');
      return current.length === 3 ? current : undefined;
    }, 'the book sections');
    const handle = sections[0]!.querySelector<HTMLElement>('.book-menu summary');

    expect(handle).not.toBeNull();
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
    handle!.dispatchEvent(pointerDown);
    const pointerMove = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 260,
    });
    Object.assign(pointerMove, { pointerId: 7 });
    handle!.dispatchEvent(pointerMove);
    await nextTick();

    expect(sections[0]!.classList.contains('book-dragging')).toBe(true);
    expect(document.elementFromPoint).toHaveBeenCalled();
    expect([...host.querySelectorAll('.book h2')].map((heading) => heading.textContent)).toEqual([
      'Book 2',
      'Book 3',
      'Book 1',
    ]);

    const pointerUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
    Object.assign(pointerUp, { pointerId: 7 });
    handle!.dispatchEvent(pointerUp);

    await until(async () => {
      const story = await getStory(db, stored.storyId);
      return story?.books?.map((book) => book.title).join(',') === 'Book 2,Book 3,Book 1'
        ? story
        : undefined;
    }, 'the saved book order');

    handle!.click();
    await nextTick();
    expect(handle!.closest('details')?.open).toBe(true);
    expect(handle!.closest('details')?.textContent).toContain('Rename');
  });

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
    const handle = parts[0]!.querySelector<HTMLElement>('.part-menu summary');
    const target = parts[2]!;

    expect(handle).not.toBeNull();
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
    handle!.dispatchEvent(pointerDown);
    await new Promise((resolve) => setTimeout(resolve, 275));
    const pointerMove = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 260,
    });
    Object.assign(pointerMove, { pointerId: 8 });
    window.dispatchEvent(pointerMove);
    await nextTick();

    expect([...host.querySelectorAll('.part-title')].map((title) => title.textContent)).toEqual([
      'Two',
      'Three',
      'One',
    ]);

    const pointerUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
    Object.assign(pointerUp, { pointerId: 8 });
    window.dispatchEvent(pointerUp);

    await until(async () => {
      const currentParts = await listParts(db, stored.storyId);
      return currentParts.map((part) => part.title).join(',') === 'Two,Three,One'
        ? currentParts
        : undefined;
    }, 'the saved part order');

    handle!.click();
    await nextTick();
    expect(handle!.closest('details')?.open).toBe(true);
    expect(handle!.closest('details')?.textContent).toContain('Rename');
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
