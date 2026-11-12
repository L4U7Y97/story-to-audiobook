import {
  SCHEMA_VERSION,
  type Analysis,
  type AnalysisStatus,
  type Part,
  type Story,
} from '@/format/types';
import { sha256 } from '@/format/hash';
import { validateAnalysis } from '@/format/validate';
import type { StoryDb } from './db';
import { newId, now } from './ids';
import { orderByBooks } from './books';

export const EXPORT_FORMAT = 'story-to-audiobook';

/**
 * One story in a single JSON file: the story with its cast, every part's text and every analysis.
 * Settings (including the API key) live in Preferences and are never part of an export.
 */
export interface StoryExport {
  format: typeof EXPORT_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  story: Story;
  parts: Part[];
  analyses: Analysis[];
}

export type ParseResult = { ok: true; data: StoryExport } | { ok: false; reason: string };

export interface ImportResult {
  story: Story;
  /** Analyses that failed validation and were dropped; their parts need analysing again. */
  droppedAnalyses: number;
}

export async function exportStory(db: StoryDb, storyId: string): Promise<StoryExport> {
  return db.transaction('r', db.stories, db.parts, db.analyses, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw new Error(`story ${storyId} not found`);
    const parts = (await db.parts.bulkGet(story.partIds)).filter((p): p is Part => !!p);
    const analyses = (await db.analyses.bulkGet(story.partIds)).filter((a): a is Analysis => !!a);
    return {
      format: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: now(),
      story,
      parts,
      analyses,
    };
  });
}

export function exportFileName(story: Pick<Story, 'title'>): string {
  const slug = story.title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
  return `${slug || 'story'}.story.json`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the file's shape and version. Text and analyses are checked again by importStory. */
export function parseExport(json: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'This file is not a story export (it is not valid JSON).' };
  }
  if (!isObject(data) || data.format !== EXPORT_FORMAT) {
    return { ok: false, reason: 'This file is not a story export.' };
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'This story was exported by a newer version of the app. Update the app first.',
    };
  }
  const story = data.story;
  if (
    !isObject(story) ||
    typeof story.id !== 'string' ||
    typeof story.title !== 'string' ||
    (story.lang !== 'en' && story.lang !== 'es') ||
    !Array.isArray(story.partIds) ||
    (story.books !== undefined &&
      (!Array.isArray(story.books) ||
        !story.books.every(
          (b) => isObject(b) && typeof b.id === 'string' && typeof b.title === 'string',
        ))) ||
    !Array.isArray(story.cast) ||
    !story.cast.every((c) => isObject(c) && typeof c.id === 'string' && isObject(c.voice)) ||
    !story.cast.some((c) => isObject(c) && c.id === story.narratorId) ||
    !Array.isArray(data.parts) ||
    !data.parts.every(
      (p) => isObject(p) && typeof p.id === 'string' && typeof p.text === 'string',
    ) ||
    !Array.isArray(data.analyses) ||
    !data.analyses.every((a) => isObject(a) && Array.isArray(a.segments))
  ) {
    return { ok: false, reason: 'This story export is damaged and cannot be imported.' };
  }
  return { ok: true, data: data as unknown as StoryExport };
}

/**
 * Adds an exported story to the library. Part text is checked against its hash; analyses are
 * validated like any other (an invalid one is dropped and its part analysed again later). When the
 * story or any part id is already in the database, the import gets new ids, so importing the same
 * file twice gives two independent copies.
 */
export async function importStory(db: StoryDb, data: StoryExport): Promise<ImportResult> {
  const byId = new Map(data.parts.map((p) => [p.id, p]));
  const ordered = data.story.partIds.map((id) => byId.get(id));
  if (ordered.some((p) => !p)) throw new Error('This story export is missing parts.');
  const parts = ordered as Part[];
  for (const p of parts) {
    if ((await sha256(p.text)) !== p.textHash) {
      throw new Error(`The text of “${p.title}” was changed after export. Import cancelled.`);
    }
  }

  return db.transaction('rw', db.stories, db.parts, db.analyses, async () => {
    const taken =
      (await db.stories.get(data.story.id)) !== undefined ||
      (await db.parts.bulkGet(parts.map((p) => p.id))).some((p) => p !== undefined);
    const storyId = taken ? newId() : data.story.id;
    const partIdOf = new Map(parts.map((p) => [p.id, taken ? newId() : p.id]));
    const castIds = new Set(data.story.cast.map((c) => c.id));

    let droppedAnalyses = 0;
    const analyses: Analysis[] = [];
    const status = new Map<string, AnalysisStatus>();
    for (const part of parts) {
      const analysis = data.analyses.find((a) => a.partId === part.id);
      const valid = analysis && validateAnalysis(part, analysis, castIds).ok;
      if (analysis && !valid) droppedAnalyses++;
      if (valid) analyses.push({ ...analysis, partId: partIdOf.get(part.id)! });
      status.set(part.id, valid ? 'done' : 'pending');
    }

    // Every part must belong to a known book (or none, without books); partIds grouped by book.
    const books = data.story.books?.length ? data.story.books : undefined;
    const bookIds = new Set(books?.map((b) => b.id));
    const bookOf = new Map(
      parts.map((p) => [
        partIdOf.get(p.id)!,
        books ? (p.bookId && bookIds.has(p.bookId) ? p.bookId : books[0]!.id) : undefined,
      ]),
    );

    const position = data.story.position;
    const story: Story = {
      ...data.story,
      id: storyId,
      partIds: orderByBooks(
        parts.map((p) => partIdOf.get(p.id)!),
        bookOf,
        books ?? [],
      ),
      cast: data.story.cast.map((c) => {
        if (c.firstSeenPartId === undefined) return c;
        const copy = { ...c, firstSeenPartId: partIdOf.get(c.firstSeenPartId) };
        if (!copy.firstSeenPartId) delete copy.firstSeenPartId;
        return copy;
      }),
      ...(position && partIdOf.has(position.partId)
        ? { position: { ...position, partId: partIdOf.get(position.partId)! } }
        : { position: undefined }),
      updatedAt: now(),
    };
    if (!story.position) delete story.position;
    if (!books) delete story.books;

    await db.stories.add(story);
    await db.parts.bulkAdd(
      parts.map((p) => {
        const id = partIdOf.get(p.id)!;
        const part: Part = { ...p, id, storyId, analysisStatus: status.get(p.id)! };
        const bookId = bookOf.get(id);
        if (bookId) part.bookId = bookId;
        else delete part.bookId;
        return part;
      }),
    );
    await db.analyses.bulkAdd(analyses);
    return { story, droppedAnalyses };
  });
}
