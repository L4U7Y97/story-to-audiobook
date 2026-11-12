import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { createStory, getStory, updateStory } from '@/storage/stories';
import { addPart, deletePart, listParts, movePart } from '@/storage/parts';
import {
  addBook,
  deleteBook,
  groupParts,
  moveBook,
  movePartToBook,
  renameBook,
} from '@/storage/books';
import { exportStory, importStory } from '@/storage/exportImport';
import { analyzePart } from '@/analysis/analyzer';

let db: StoryDb;
let count = 0;
beforeEach(() => {
  db = openStoryDb(`books-${++count}`);
});
afterEach(async () => {
  await db.delete();
});

const paste = (title: string, text = 'Some text.') => ({
  title,
  source: { kind: 'paste' as const },
  text,
});

async function titles(storyId: string): Promise<string[]> {
  return (await listParts(db, storyId)).map((p) => p.title);
}

async function grouped(storyId: string): Promise<Record<string, string[]>> {
  const story = (await getStory(db, storyId))!;
  const parts = await listParts(db, storyId);
  return Object.fromEntries(
    groupParts(story.books, parts).map((g) => [g.book?.title ?? '-', g.parts.map((p) => p.title)]),
  );
}

describe('books', () => {
  it('turns existing parts into "Book 1" when the first book is added', async () => {
    const story = await createStory(db, { title: 'Saga', lang: 'en' });
    await addPart(db, story.id, paste('a'));
    await addPart(db, story.id, paste('b'));

    const two = await addBook(db, story.id, '  The Sequel ');

    expect(two.title).toBe('The Sequel');
    expect((await getStory(db, story.id))!.books!.map((b) => b.title)).toEqual([
      'Book 1',
      'The Sequel',
    ]);
    expect(await grouped(story.id)).toEqual({ 'Book 1': ['a', 'b'], 'The Sequel': [] });
  });

  it('starts an empty story with a single book and no wrapper', async () => {
    const story = await createStory(db, { title: 'Saga', lang: 'en' });
    const one = await addBook(db, story.id);
    expect(one.title).toBe('Book 1');
    expect((await getStory(db, story.id))!.books).toHaveLength(1);
  });

  it('keeps reading order grouped by book whatever order parts are added in', async () => {
    const story = await createStory(db, { title: 'Saga', lang: 'en' });
    const b1 = await addBook(db, story.id, 'One');
    const b2 = await addBook(db, story.id, 'Two');
    await addPart(db, story.id, { ...paste('2.1'), bookId: b2.id });
    await addPart(db, story.id, { ...paste('1.1'), bookId: b1.id });
    await addPart(db, story.id, { ...paste('2.2'), bookId: b2.id });
    await addPart(db, story.id, { ...paste('1.0'), bookId: b1.id }, 0);
    await addPart(db, story.id, paste('2.3')); // no book: goes to the last one

    expect(await titles(story.id)).toEqual(['1.0', '1.1', '2.1', '2.2', '2.3']);
  });

  it('moves parts within their book only, and between books on request', async () => {
    const story = await createStory(db, { title: 'Saga', lang: 'en' });
    const b1 = await addBook(db, story.id, 'One');
    const b2 = await addBook(db, story.id, 'Two');
    const a = await addPart(db, story.id, { ...paste('a'), bookId: b1.id });
    await addPart(db, story.id, { ...paste('b'), bookId: b1.id });
    await addPart(db, story.id, { ...paste('c'), bookId: b2.id });

    await movePart(db, story.id, a.id, 5); // clamped to the end of book One
    expect(await titles(story.id)).toEqual(['b', 'a', 'c']);

    await movePartToBook(db, story.id, a.id, b2.id);
    expect(await grouped(story.id)).toEqual({ One: ['b'], Two: ['c', 'a'] });
  });

  it('reorders, renames and deletes whole books', async () => {
    const story = await createStory(db, { title: 'Saga', lang: 'en' });
    const b1 = await addBook(db, story.id, 'One');
    const b2 = await addBook(db, story.id, 'Two');
    const a = await addPart(db, story.id, { ...paste('a', '“Hi,” said Anne.'), bookId: b1.id });
    await addPart(db, story.id, { ...paste('c'), bookId: b2.id });
    await analyzePart(db, a.id, { voices: [] });
    await updateStory(db, story.id, { position: { partId: a.id, segmentIndex: 0 } });

    await moveBook(db, story.id, b1.id, 1);
    await renameBook(db, story.id, b2.id, 'Prequel');
    expect(await titles(story.id)).toEqual(['c', 'a']);
    expect((await getStory(db, story.id))!.books!.map((b) => b.title)).toEqual(['Prequel', 'One']);

    await deleteBook(db, story.id, b1.id);
    const after = (await getStory(db, story.id))!;
    expect(after.books!.map((b) => b.title)).toEqual(['Prequel']);
    expect(after.position).toBeUndefined();
    expect(await titles(story.id)).toEqual(['c']);
    expect(await db.parts.get(a.id)).toBeUndefined();
    expect(await db.analyses.get(a.id)).toBeUndefined();
    // The cast is the story's, so characters met in a deleted book stay.
    expect(after.cast.some((c) => c.name === 'Anne')).toBe(true);
  });

  it('deleting a part keeps the books', async () => {
    const story = await createStory(db, { title: 'Saga', lang: 'en' });
    const b1 = await addBook(db, story.id, 'One');
    const a = await addPart(db, story.id, { ...paste('a'), bookId: b1.id });
    await deletePart(db, story.id, a.id);
    expect(await grouped(story.id)).toEqual({ One: [] });
  });

  it('survives export and import, including into the same database', async () => {
    const story = await createStory(db, { title: 'Saga', lang: 'en' });
    const b1 = await addBook(db, story.id, 'One');
    const b2 = await addBook(db, story.id, 'Two');
    await addPart(db, story.id, { ...paste('a'), bookId: b1.id });
    await addPart(db, story.id, { ...paste('c'), bookId: b2.id });

    const { story: copy } = await importStory(db, await exportStory(db, story.id));

    expect(copy.id).not.toBe(story.id);
    expect(await grouped(copy.id)).toEqual({ One: ['a'], Two: ['c'] });
  });

  it('on import, puts parts with a missing book into the first book', async () => {
    const story = await createStory(db, { title: 'Saga', lang: 'en' });
    const b1 = await addBook(db, story.id, 'One');
    const b2 = await addBook(db, story.id, 'Two');
    await addPart(db, story.id, { ...paste('a'), bookId: b2.id });
    await addPart(db, story.id, { ...paste('b'), bookId: b1.id });
    const data = await exportStory(db, story.id);
    data.parts = data.parts.map((p) => (p.title === 'a' ? { ...p, bookId: 'gone' } : p));

    const { story: copy } = await importStory(db, data);

    expect(await grouped(copy.id)).toEqual({ One: ['b', 'a'], Two: [] });
  });
});
