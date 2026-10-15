import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzePart } from '@/analysis/analyzer';
import { openStoryDb, type StoryDb } from '@/storage/db';
import {
  exportFileName,
  exportStory,
  importStory,
  parseExport,
  type StoryExport,
} from '@/storage/exportImport';
import { getAnalysis } from '@/storage/analyses';
import { addPart, listParts } from '@/storage/parts';
import { setSetting } from '@/storage/settings';
import { createStory, getStory, listStories, updateStory } from '@/storage/stories';
import { renameCharacter } from '@/cast/castOps';

const KEY = 'sk-ant-test-SECRET-9876';
const voices = [
  { name: 'en-a', lang: 'en-US', isDefault: true },
  { name: 'en-b', lang: 'en-GB' },
];

let db: StoryDb;
let other: StoryDb;
let count = 0;
beforeEach(() => {
  db = openStoryDb(`export-${++count}`);
  other = openStoryDb(`export-other-${count}`);
});
afterEach(async () => {
  await db.delete();
  await other.delete();
  localStorage.clear();
});

/** A story with two analysed parts, a renamed character and a saved position. */
async function sampleStory(): Promise<string> {
  const story = await createStory(db, { title: 'Ana y Tom', lang: 'en' });
  const p1 = await addPart(db, story.id, {
    title: 'One',
    source: { kind: 'paste' },
    text: '“Hi,” said Anne.\n\n“Hello,” said Tom.',
  });
  const p2 = await addPart(db, story.id, {
    title: 'Two',
    source: { kind: 'txt', fileName: 'two.txt' },
    text: '“Again?” asked Tom.',
    hints: [{ start: 0, end: 8, kind: 'emphasis' }],
  });
  await analyzePart(db, p1.id, { voices });
  await analyzePart(db, p2.id, { voices });
  const saved = (await getStory(db, story.id))!;
  const anne = saved.cast.find((c) => c.name === 'Anne')!;
  const renamed = renameCharacter(saved.cast, anne.id, 'Anne Shirley');
  if (!renamed.ok) throw new Error(renamed.reason);
  await updateStory(db, story.id, {
    cast: renamed.value,
    position: { partId: p2.id, segmentIndex: 1 },
  });
  return story.id;
}

/** Replaces story and part ids with placeholders and drops timestamps, for comparison. */
function normalise(e: StoryExport) {
  const names = new Map<string, string>([[e.story.id, 'story']]);
  e.story.partIds.forEach((id, i) => names.set(id, `part${i}`));
  const json = JSON.stringify({ ...e, exportedAt: undefined }, (key, value) =>
    key === 'updatedAt' || key === 'createdAt'
      ? undefined
      : typeof value === 'string' && names.has(value)
        ? names.get(value)
        : value,
  );
  return JSON.parse(json) as unknown;
}

describe('export and import', () => {
  it('round-trips a story: export → import → export is identical apart from ids and timestamps', async () => {
    const storyId = await sampleStory();
    const first = await exportStory(db, storyId);
    const parsed = parseExport(JSON.stringify(first));
    if (!parsed.ok) throw new Error(parsed.reason);

    // Importing into the same library gives the copy new ids.
    const { story: copy, droppedAnalyses } = await importStory(db, parsed.data);
    expect(droppedAnalyses).toBe(0);
    expect(copy.id).not.toBe(storyId);
    expect(copy.partIds.some((id) => first.story.partIds.includes(id))).toBe(false);
    expect(await listStories(db)).toHaveLength(2);

    const second = await exportStory(db, copy.id);
    expect(normalise(second)).toEqual(normalise(first));
    expect(second.story.position?.partId).toBe(copy.partIds[1]);
  });

  it('keeps the ids when importing into another library, and the copy plays with the same cast', async () => {
    const storyId = await sampleStory();
    const file = JSON.stringify(await exportStory(db, storyId));
    const parsed = parseExport(file);
    if (!parsed.ok) throw new Error(parsed.reason);
    const { story } = await importStory(other, parsed.data);

    expect(story.id).toBe(storyId);
    const original = (await getStory(db, storyId))!;
    expect(story.cast).toEqual(original.cast);
    const parts = await listParts(other, story.id);
    expect(parts.map((p) => p.analysisStatus)).toEqual(['done', 'done']);
    const analysis = (await getAnalysis(other, parts[0]!.id))!;
    expect(analysis.segments).toEqual((await getAnalysis(db, parts[0]!.id))!.segments);
  });

  it('never includes settings or the API key', async () => {
    await setSetting('apiKey', KEY);
    await setSetting('model', 'claude-opus-5-5');
    const file = JSON.stringify(await exportStory(db, await sampleStory()));
    expect(file).not.toContain('SECRET');
    expect(file).not.toContain('apiKey');
    expect(file).not.toContain('claude-opus-5-5');
  });

  it('drops an analysis that no longer matches its part, so the part is analysed again', async () => {
    const data = await exportStory(db, await sampleStory());
    data.analyses[0]!.segments[0]!.speakerId = 'nobody';
    const { story, droppedAnalyses } = await importStory(other, data);
    expect(droppedAnalyses).toBe(1);
    const parts = await listParts(other, story.id);
    expect(parts.map((p) => p.analysisStatus)).toEqual(['pending', 'done']);
    expect(await getAnalysis(other, parts[0]!.id)).toBeUndefined();
  });

  it('refuses text that was edited after export, and stores nothing', async () => {
    const data = await exportStory(db, await sampleStory());
    data.parts[0]!.text = data.parts[0]!.text.replace('Hi', 'Bye');
    await expect(importStory(other, data)).rejects.toThrow('changed after export');
    expect(await listStories(other)).toEqual([]);
  });

  it('explains files it cannot import', () => {
    expect(parseExport('not json')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not valid JSON'),
    });
    expect(parseExport('{"format":"other"}')).toMatchObject({
      ok: false,
      reason: 'This file is not a story export.',
    });
    expect(
      parseExport(JSON.stringify({ format: 'story-to-audiobook', schemaVersion: 99 })),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('newer version') });
    expect(
      parseExport(JSON.stringify({ format: 'story-to-audiobook', schemaVersion: 1, story: {} })),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('damaged') });
  });

  it('names the file after the story', () => {
    expect(exportFileName({ title: 'Marianela: Capítulo 1' })).toBe(
      'marianela-capitulo-1.story.json',
    );
    expect(exportFileName({ title: '¿?' })).toBe('story.story.json');
  });
});
