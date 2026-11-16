import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addBook } from '@/storage/books';
import { getStory } from '@/storage/stories';
import StoryView from '@/ui/views/StoryView.vue';
import { button, db, mountView, storeStory, unmountView, until } from '../../helpers/ui';

vi.mock('@/ui/composables/usePlayer', () => import('../../helpers/ui').then((m) => m.playerStub()));

afterEach(unmountView);

describe('book sections', () => {
  it('collapses a book’s parts and lets the user expand them again', async () => {
    const stored = await storeStory([['Once upon a time.', 'N', 'narration']]);
    await addBook(db, stored.storyId, 'Book 2');
    const story = (await getStory(db, stored.storyId))!;
    const host = await mountView(StoryView, { id: stored.storyId });
    const section = await until(() => host.querySelector<HTMLElement>('.book'), 'the book section');
    const content = host.querySelector<HTMLElement>('.book-content')!;
    const otherSection = host.querySelectorAll<HTMLElement>('.book')[1]!;
    const otherContent = otherSection.querySelector<HTMLElement>('.book-content')!;
    const collapse = button(section, 'Collapse');

    expect(collapse?.getAttribute('aria-expanded')).toBe('true');
    expect(content.style.display).not.toBe('none');

    collapse!.click();

    const expand = await until(() => button(section, 'Expand'), 'Expand');
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(content.style.display).toBe('none');
    expect(section.querySelector('h2')?.textContent).toBe(story.books![0]!.title);
    expect(otherContent.style.display).not.toBe('none');

    expand.click();

    expect(
      (await until(() => button(section, 'Collapse'), 'Collapse')).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(content.style.display).not.toBe('none');
  });
});
