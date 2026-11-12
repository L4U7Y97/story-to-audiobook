import { sha256 } from '@/format/hash';
import type { AnalysisStatus, Hint, Part } from '@/format/types';
import type { StoryDb } from './db';
import { newId, now } from './ids';
import { bookOfParts, orderByBooks } from './books';

export interface NewPart {
  title: string;
  source: Part['source'];
  /** Canonical text (see src/ingest). Stored as-is and never modified afterwards. */
  text: string;
  hints?: Hint[];
  /** The book to add it to when the story has books (default: the last book). */
  bookId?: string;
}

/**
 * Adds a part to a story. `index` is the position in reading order (default: at the end); when the
 * story has books, it is the position within the part's book.
 * Note: there is deliberately no way to edit a part's text once stored — replacePart swaps in a
 * whole new upload with a new hash and discards the old analysis.
 */
export async function addPart(
  db: StoryDb,
  storyId: string,
  input: NewPart,
  index?: number,
): Promise<Part> {
  const textHash = await sha256(input.text);
  return db.transaction('rw', db.stories, db.parts, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw new Error(`story ${storyId} not found`);
    const books = story.books ?? [];
    const bookId = books.length ? (input.bookId ?? books.at(-1)!.id) : undefined;
    if (bookId && !books.some((b) => b.id === bookId)) {
      throw new Error(`book ${bookId} not in story ${storyId}`);
    }
    const part: Part = {
      id: newId(),
      storyId,
      ...(bookId ? { bookId } : {}),
      title: input.title,
      source: input.source,
      text: input.text,
      textHash,
      ...(input.hints?.length ? { hints: input.hints } : {}),
      analysisStatus: 'pending',
    };
    const bookOf = await bookOfParts(db, story);
    bookOf.set(part.id, bookId);
    const partIds = insertInGroup(story.partIds, part.id, index, (id) => bookOf.get(id) === bookId);
    await db.parts.add(part);
    await db.stories.update(storyId, {
      partIds: orderByBooks(partIds, bookOf, books),
      updatedAt: now(),
    });
    return part;
  });
}

/**
 * Replaces a part's content with new text (from a new upload). The part keeps its id and place in
 * the story; its old analysis is discarded and it goes back to "pending". The story's cast — and so
 * every voice — is untouched.
 */
export async function replacePart(
  db: StoryDb,
  storyId: string,
  partId: string,
  input: NewPart,
): Promise<Part> {
  const textHash = await sha256(input.text);
  return db.transaction('rw', db.stories, db.parts, db.analyses, async () => {
    const story = await db.stories.get(storyId);
    const existing = await db.parts.get(partId);
    if (!story || !existing || existing.storyId !== storyId) {
      throw new Error(`part ${partId} not in story ${storyId}`);
    }
    const part: Part = {
      id: partId,
      storyId,
      title: input.title,
      source: input.source,
      text: input.text,
      textHash,
      ...(input.hints?.length ? { hints: input.hints } : {}),
      analysisStatus: 'pending',
    };
    // Replacing is the one sanctioned way to give a part different text: a whole new upload.
    await db.parts.put(part);
    await db.analyses.delete(partId);
    if (story.position?.partId === partId) {
      await db.stories.update(storyId, { position: { partId, segmentIndex: 0 }, updatedAt: now() });
    }
    return part;
  });
}

export async function getPart(db: StoryDb, id: string): Promise<Part | undefined> {
  return db.parts.get(id);
}

/** Parts in reading order. */
export async function listParts(db: StoryDb, storyId: string): Promise<Part[]> {
  const story = await db.stories.get(storyId);
  if (!story) return [];
  const parts = await db.parts.bulkGet(story.partIds);
  return parts.filter((p): p is Part => p !== undefined);
}

/**
 * Moves a part to `toIndex` in reading order — within its own book when the story has books (use
 * movePartToBook to change book).
 */
export async function movePart(
  db: StoryDb,
  storyId: string,
  partId: string,
  toIndex: number,
): Promise<void> {
  await db.transaction('rw', db.stories, db.parts, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw new Error(`story ${storyId} not found`);
    if (!story.partIds.includes(partId)) throw new Error(`part ${partId} not in story ${storyId}`);
    const books = story.books ?? [];
    const bookOf = await bookOfParts(db, story);
    const bookId = bookOf.get(partId);
    const rest = story.partIds.filter((id) => id !== partId);
    const partIds = insertInGroup(rest, partId, toIndex, (id) => bookOf.get(id) === bookId);
    await db.stories.update(storyId, {
      partIds: orderByBooks(partIds, bookOf, books),
      updatedAt: now(),
    });
  });
}

export async function renamePart(db: StoryDb, partId: string, title: string): Promise<void> {
  await db.parts.update(partId, { title });
}

export async function setAnalysisStatus(
  db: StoryDb,
  partId: string,
  analysisStatus: AnalysisStatus,
): Promise<void> {
  await db.parts.update(partId, { analysisStatus });
}

export async function deletePart(db: StoryDb, storyId: string, partId: string): Promise<void> {
  await db.transaction('rw', db.stories, db.parts, db.analyses, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw new Error(`story ${storyId} not found`);
    const partIds = story.partIds.filter((id) => id !== partId);
    const position = story.position?.partId === partId ? undefined : story.position;
    await db.stories.update(storyId, { partIds, position, updatedAt: now() });
    await db.analyses.delete(partId);
    await db.parts.delete(partId);
  });
}

/**
 * Inserts `id` so that it is at `index` among the ids that match `inGroup` (default: after the last
 * of them). Ids outside the group keep their places.
 */
function insertInGroup(
  ids: readonly string[],
  id: string,
  index: number | undefined,
  inGroup: (id: string) => boolean,
): string[] {
  const out = [...ids];
  const members = ids.map((x, i) => (inGroup(x) ? i : -1)).filter((i) => i !== -1);
  if (!members.length) {
    out.push(id);
    return out;
  }
  const at = index === undefined ? members.length : clamp(index, 0, members.length);
  out.splice(at === members.length ? members.at(-1)! + 1 : members[at]!, 0, id);
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
