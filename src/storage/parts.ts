import { sha256 } from '@/format/hash';
import type { AnalysisStatus, Hint, Part } from '@/format/types';
import type { StoryDb } from './db';
import { newId, now } from './ids';

export interface NewPart {
  title: string;
  source: Part['source'];
  /** Canonical text (see src/ingest). Stored as-is and never modified afterwards. */
  text: string;
  hints?: Hint[];
}

/**
 * Adds a part to a story. `index` is the position in reading order (default: at the end).
 * Note: there is deliberately no way to change a part's text once stored — replacing a part
 * (Task 16) creates new text with a new hash and discards the old analysis.
 */
export async function addPart(
  db: StoryDb,
  storyId: string,
  input: NewPart,
  index?: number,
): Promise<Part> {
  const part: Part = {
    id: newId(),
    storyId,
    title: input.title,
    source: input.source,
    text: input.text,
    textHash: await sha256(input.text),
    ...(input.hints?.length ? { hints: input.hints } : {}),
    analysisStatus: 'pending',
  };
  await db.transaction('rw', db.stories, db.parts, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw new Error(`story ${storyId} not found`);
    const partIds = [...story.partIds];
    const at = index === undefined ? partIds.length : clamp(index, 0, partIds.length);
    partIds.splice(at, 0, part.id);
    await db.parts.add(part);
    await db.stories.update(storyId, { partIds, updatedAt: now() });
  });
  return part;
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

export async function movePart(
  db: StoryDb,
  storyId: string,
  partId: string,
  toIndex: number,
): Promise<void> {
  await db.transaction('rw', db.stories, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw new Error(`story ${storyId} not found`);
    const from = story.partIds.indexOf(partId);
    if (from === -1) throw new Error(`part ${partId} not in story ${storyId}`);
    const partIds = [...story.partIds];
    partIds.splice(from, 1);
    partIds.splice(clamp(toIndex, 0, partIds.length), 0, partId);
    await db.stories.update(storyId, { partIds, updatedAt: now() });
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

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
