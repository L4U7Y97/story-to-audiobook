import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Analysis, Segment } from '@/format/types';
import { sha256 } from '@/format/hash';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { createStory, deleteStory, getStory, listStories, updateStory } from '@/storage/stories';
import * as partsRepo from '@/storage/parts';
import { AnalysisRejectedError, getAnalysis, saveAnalysis } from '@/storage/analyses';

let db: StoryDb;
let dbCount = 0;

beforeEach(() => {
  db = openStoryDb(`test-${++dbCount}`);
});

afterEach(async () => {
  await db.delete();
});

const pasted = (text: string, title = 'Part') => ({
  title,
  source: { kind: 'paste' as const },
  text,
});

describe('stories', () => {
  it('creates a story with a narrator and an unknown speaker', async () => {
    const story = await createStory(db, { title: 'Marianela', lang: 'es' });
    expect(story.cast.map((c) => c.role)).toEqual(['narrator', 'unknown']);
    expect(story.narratorId).toBe(story.cast[0]!.id);
    expect(story.cast[0]!.voice.lang).toBe('es-ES');
    expect(await getStory(db, story.id)).toEqual(story);
  });

  it('lists the most recently updated story first', async () => {
    const a = await createStory(db, { title: 'A', lang: 'en' });
    const b = await createStory(db, { title: 'B', lang: 'en' });
    await new Promise((r) => setTimeout(r, 5));
    await updateStory(db, a.id, { title: 'A2' });
    expect((await listStories(db)).map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('deletes a story with its parts and analyses', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await partsRepo.addPart(db, story.id, pasted('Hello.'));
    await saveAnalysis(db, await analysisFor(part.id, 'Hello.', story.narratorId));
    await deleteStory(db, story.id);
    expect(await db.stories.count()).toBe(0);
    expect(await db.parts.count()).toBe(0);
    expect(await db.analyses.count()).toBe(0);
  });
});

describe('parts', () => {
  it('appends by default and inserts at a position', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const one = await partsRepo.addPart(db, story.id, pasted('one', '1'));
    const three = await partsRepo.addPart(db, story.id, pasted('three', '3'));
    const two = await partsRepo.addPart(db, story.id, pasted('two', '2'), 1);
    const titles = (await partsRepo.listParts(db, story.id)).map((p) => p.title);
    expect(titles).toEqual(['1', '2', '3']);
    expect([one, two, three].every((p) => p.analysisStatus === 'pending')).toBe(true);
  });

  it('stores the text unchanged with its hash', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const text = '  “Odd”\twhitespace\n\n\n—kept—  ';
    const part = await partsRepo.addPart(db, story.id, pasted(text));
    const stored = await partsRepo.getPart(db, part.id);
    expect(stored!.text).toBe(text);
    expect(stored!.textHash).toBe(await sha256(text));
  });

  it('reorders parts', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const a = await partsRepo.addPart(db, story.id, pasted('a', 'a'));
    await partsRepo.addPart(db, story.id, pasted('b', 'b'));
    await partsRepo.addPart(db, story.id, pasted('c', 'c'));
    await partsRepo.movePart(db, story.id, a.id, 2);
    expect((await partsRepo.listParts(db, story.id)).map((p) => p.title)).toEqual(['b', 'c', 'a']);
  });

  it('deletes a part, its analysis and a reading position pointing at it', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await partsRepo.addPart(db, story.id, pasted('Hello.'));
    await saveAnalysis(db, await analysisFor(part.id, 'Hello.', story.narratorId));
    await updateStory(db, story.id, { position: { partId: part.id, segmentIndex: 0 } });
    await partsRepo.deletePart(db, story.id, part.id);
    const after = await getStory(db, story.id);
    expect(after!.partIds).toEqual([]);
    expect(after!.position).toBeUndefined();
    expect(await getAnalysis(db, part.id)).toBeUndefined();
  });

  it('offers no way to change a stored part text', () => {
    const exported = Object.keys(partsRepo);
    expect(exported.filter((name) => /text/i.test(name))).toEqual([]);
  });
});

describe('analyses', () => {
  it('saves a valid analysis and marks the part done', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await partsRepo.addPart(db, story.id, pasted('Hello.'));
    const analysis = await analysisFor(part.id, 'Hello.', story.narratorId);
    await saveAnalysis(db, analysis);
    expect(await getAnalysis(db, part.id)).toEqual(analysis);
    expect((await partsRepo.getPart(db, part.id))!.analysisStatus).toBe('done');
  });

  it('rejects an analysis for different text and stores nothing', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await partsRepo.addPart(db, story.id, pasted('Hello.'));
    const stale = await analysisFor(part.id, 'Hello!', story.narratorId);
    await expect(saveAnalysis(db, stale)).rejects.toThrow(AnalysisRejectedError);
    expect(await getAnalysis(db, part.id)).toBeUndefined();
  });

  it('rejects segments that do not tile the text', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await partsRepo.addPart(db, story.id, pasted('Hello.'));
    const bad = await analysisFor(part.id, 'Hello.', story.narratorId);
    bad.segments[0]!.end = 3;
    await expect(saveAnalysis(db, bad)).rejects.toThrow('does not reach end of text');
  });

  it('rejects speakers outside the cast', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await partsRepo.addPart(db, story.id, pasted('Hello.'));
    const bad = await analysisFor(part.id, 'Hello.', 'nobody');
    await expect(saveAnalysis(db, bad)).rejects.toThrow('unknown speaker');
  });
});

async function analysisFor(partId: string, text: string, speakerId: string): Promise<Analysis> {
  const segment: Segment = {
    start: 0,
    end: text.length,
    speakerId,
    mode: 'narration',
    source: 'heuristic',
  };
  return {
    partId,
    textHash: await sha256(text),
    analyzer: { kind: 'heuristic', version: 1 },
    createdAt: new Date().toISOString(),
    segments: [segment],
  };
}
