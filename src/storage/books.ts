import type { Book, Part, Story } from '@/format/types';
import type { StoryDb } from './db';
import { newId, now } from './ids';

/*
 * Books split one story into separate volumes (a series), each with its own parts. The story keeps
 * a single reading order (Story.partIds) that is always grouped by book, so playback, analysis and
 * the cast work across books exactly as they do across parts.
 */

/** Reading order grouped by book (book order first, then each book's own order). */
export function orderByBooks(
  partIds: readonly string[],
  bookOf: ReadonlyMap<string, string | undefined>,
  books: readonly Book[],
): string[] {
  if (!books.length) return [...partIds];
  const known = new Set(books.map((b) => b.id));
  const grouped = books.flatMap((b) => partIds.filter((id) => bookOf.get(id) === b.id));
  // Defensive: a part pointing at no book keeps reading at the end rather than vanishing.
  return [...grouped, ...partIds.filter((id) => !known.has(bookOf.get(id) ?? ''))];
}

/** Each part's book, by part id. */
export async function bookOfParts(
  db: StoryDb,
  story: Pick<Story, 'partIds'>,
): Promise<Map<string, string | undefined>> {
  const parts = await db.parts.bulkGet(story.partIds);
  return new Map(parts.filter((p): p is Part => !!p).map((p) => [p.id, p.bookId]));
}

/** Parts grouped under their books, in reading order. Without books: one group, book undefined. */
export function groupParts<P extends Pick<Part, 'bookId'>>(
  books: readonly Book[] | undefined,
  parts: readonly P[],
): { book: Book | undefined; parts: P[] }[] {
  if (!books?.length) return [{ book: undefined, parts: [...parts] }];
  return books.map((book) => ({ book, parts: parts.filter((p) => p.bookId === book.id) }));
}

/**
 * Adds a book at the end of the story. The first time, the story's existing parts (if any) become
 * "Book 1" so that every part keeps belonging to a book.
 */
export async function addBook(db: StoryDb, storyId: string, title = ''): Promise<Book> {
  return db.transaction('rw', db.stories, db.parts, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw new Error(`story ${storyId} not found`);
    const books = [...(story.books ?? [])];
    if (!books.length && story.partIds.length) {
      const first: Book = { id: newId(), title: 'Book 1' };
      books.push(first);
      await db.parts.where('storyId').equals(storyId).modify({ bookId: first.id });
    }
    const book: Book = { id: newId(), title: title.trim() || `Book ${books.length + 1}` };
    books.push(book);
    await db.stories.update(storyId, { books, updatedAt: now() });
    return book;
  });
}

export async function renameBook(
  db: StoryDb,
  storyId: string,
  bookId: string,
  title: string,
): Promise<void> {
  const t = title.trim();
  if (!t) return;
  await db.transaction('rw', db.stories, async () => {
    const story = await db.stories.get(storyId);
    if (!story?.books?.some((b) => b.id === bookId)) {
      throw new Error(`book ${bookId} not in story ${storyId}`);
    }
    const books = story.books.map((b) => (b.id === bookId ? { ...b, title: t } : b));
    await db.stories.update(storyId, { books, updatedAt: now() });
  });
}

/** Moves a book (with all its parts) to `toIndex` in book order. */
export async function moveBook(
  db: StoryDb,
  storyId: string,
  bookId: string,
  toIndex: number,
): Promise<void> {
  await db.transaction('rw', db.stories, db.parts, async () => {
    const story = await db.stories.get(storyId);
    const books = [...(story?.books ?? [])];
    const from = books.findIndex((b) => b.id === bookId);
    if (!story || from === -1) throw new Error(`book ${bookId} not in story ${storyId}`);
    const [book] = books.splice(from, 1);
    books.splice(Math.min(books.length, Math.max(0, toIndex)), 0, book!);
    const partIds = orderByBooks(story.partIds, await bookOfParts(db, story), books);
    await db.stories.update(storyId, { books, partIds, updatedAt: now() });
  });
}

/** Moves a part to the end of another book. */
export async function movePartToBook(
  db: StoryDb,
  storyId: string,
  partId: string,
  bookId: string,
): Promise<void> {
  await db.transaction('rw', db.stories, db.parts, async () => {
    const story = await db.stories.get(storyId);
    const part = await db.parts.get(partId);
    if (!story || !part || part.storyId !== storyId) {
      throw new Error(`part ${partId} not in story ${storyId}`);
    }
    const books = story.books ?? [];
    if (!books.some((b) => b.id === bookId)) {
      throw new Error(`book ${bookId} not in story ${storyId}`);
    }
    if (part.bookId === bookId) return;
    await db.parts.update(partId, { bookId });
    // Last in its new book: take it out, put it at the very end, then regroup (stable).
    const rest = story.partIds.filter((id) => id !== partId);
    const bookOf = await bookOfParts(db, story);
    const partIds = orderByBooks([...rest, partId], bookOf, books);
    await db.stories.update(storyId, { partIds, updatedAt: now() });
  });
}

/**
 * Deletes a book with all its parts and their analyses. When only one book is left, the story stays
 * in books mode (the user can add another); with none left, it is a plain story again.
 */
export async function deleteBook(db: StoryDb, storyId: string, bookId: string): Promise<void> {
  await db.transaction('rw', db.stories, db.parts, db.analyses, async () => {
    const story = await db.stories.get(storyId);
    if (!story?.books?.some((b) => b.id === bookId)) {
      throw new Error(`book ${bookId} not in story ${storyId}`);
    }
    const bookOf = await bookOfParts(db, story);
    const doomed = story.partIds.filter((id) => bookOf.get(id) === bookId);
    const gone = new Set(doomed);
    const position = story.position && gone.has(story.position.partId) ? undefined : story.position;
    await db.stories.update(storyId, {
      books: story.books.filter((b) => b.id !== bookId),
      partIds: story.partIds.filter((id) => !gone.has(id)),
      position,
      updatedAt: now(),
    });
    await db.analyses.bulkDelete(doomed);
    await db.parts.bulkDelete(doomed);
  });
}
