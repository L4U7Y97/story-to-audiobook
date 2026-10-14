import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzePart } from '@/analysis/analyzer';
import { castUsage } from '@/cast/castOps';
import { sha256 } from '@/format/hash';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { createStory, getStory, updateStory } from '@/storage/stories';
import { addPart, deletePart, getPart, listParts, replacePart } from '@/storage/parts';
import { getAnalysis } from '@/storage/analyses';

let db: StoryDb;
let count = 0;
beforeEach(() => {
  db = openStoryDb(`parts-${++count}`);
});
afterEach(async () => {
  await db.delete();
});

const paste = (text: string, title = 'p') => ({ title, source: { kind: 'paste' as const }, text });

async function usage(storyId: string) {
  const story = (await getStory(db, storyId))!;
  const counts = castUsage(await db.analyses.bulkGet(story.partIds));
  return (name: string) => counts.get(story.cast.find((c) => c.name === name)!.id) ?? 0;
}

describe('replacePart', () => {
  it('swaps the text, keeps id and order, discards the analysis and keeps every voice', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const one = await addPart(db, story.id, paste('“Hi,” said Anne.', 'one'));
    await addPart(db, story.id, paste('Two.', 'two'));
    await analyzePart(db, one.id, { voices: [] });
    const castBefore = (await getStory(db, story.id))!.cast;
    await updateStory(db, story.id, { position: { partId: one.id, segmentIndex: 1 } });

    const replaced = await replacePart(db, story.id, one.id, paste('“Bye,” said Anne.', 'one v2'));

    expect(replaced.id).toBe(one.id);
    expect((await listParts(db, story.id)).map((p) => p.title)).toEqual(['one v2', 'two']);
    const stored = (await getPart(db, one.id))!;
    expect(stored.text).toBe('“Bye,” said Anne.');
    expect(stored.textHash).toBe(await sha256('“Bye,” said Anne.'));
    expect(stored.analysisStatus).toBe('pending');
    expect(await getAnalysis(db, one.id)).toBeUndefined();
    const after = (await getStory(db, story.id))!;
    expect(after.cast).toEqual(castBefore);
    expect(after.position).toEqual({ partId: one.id, segmentIndex: 0 });

    await analyzePart(db, one.id, { voices: [] });
    const afterReanalysis = (await getStory(db, story.id))!.cast;
    expect(afterReanalysis.find((c) => c.name === 'Anne')!.voice).toEqual(
      castBefore.find((c) => c.name === 'Anne')!.voice,
    );
  });

  it('refuses parts from another story', async () => {
    const a = await createStory(db, { title: 'A', lang: 'en' });
    const b = await createStory(db, { title: 'B', lang: 'en' });
    const part = await addPart(db, a.id, paste('x'));
    await expect(replacePart(db, b.id, part.id, paste('y'))).rejects.toThrow('not in story');
  });
});

describe('unused characters', () => {
  it('appear when their only part is deleted or replaced, and disappear when they speak again', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const one = await addPart(db, story.id, paste('“Hi,” said Anne.'));
    const two = await addPart(db, story.id, paste('“Hello,” said Tom.'));
    await analyzePart(db, one.id, { voices: [] });
    await analyzePart(db, two.id, { voices: [] });
    expect((await usage(story.id))('Tom')).toBe(1);

    await deletePart(db, story.id, two.id);
    expect((await usage(story.id))('Tom')).toBe(0);

    await replacePart(db, story.id, one.id, paste('Nobody spoke.'));
    await analyzePart(db, one.id, { voices: [] });
    expect((await usage(story.id))('Anne')).toBe(0);

    await replacePart(db, story.id, one.id, paste('“Back,” said Anne.'));
    await analyzePart(db, one.id, { voices: [] });
    expect((await usage(story.id))('Anne')).toBe(1);
  });
});
