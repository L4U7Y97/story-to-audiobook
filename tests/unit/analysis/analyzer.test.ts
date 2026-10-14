import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzePart } from '@/analysis/analyzer';
import { validateAnalysis } from '@/format/validate';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { createStory, getStory, updateStory } from '@/storage/stories';
import { addPart, getPart } from '@/storage/parts';
import { getAnalysis } from '@/storage/analyses';
import { splitUnits } from '@/analysis/units';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { mergeLabels } from '@/analysis/merge';
import { baseCast, loadFixture } from '../../helpers/fixtures';

let db: StoryDb;
let count = 0;
const voices = [
  { name: 'en-a', lang: 'en-US', isDefault: true },
  { name: 'en-b', lang: 'en-GB' },
];

beforeEach(() => {
  db = openStoryDb(`analyzer-${++count}`);
});
afterEach(async () => {
  await db.delete();
});

const paste = (text: string) => ({ title: 'p', source: { kind: 'paste' as const }, text });

describe('analyzePart', () => {
  it('stores a valid analysis and adds voiced characters to the cast', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await addPart(db, story.id, paste('“Hi,” said Anne.\n\n“Hello,” said Tom.'));
    await analyzePart(db, part.id, { voices });

    const saved = (await getStory(db, story.id))!;
    const analysis = (await getAnalysis(db, part.id))!;
    expect(saved.cast.map((c) => c.name)).toEqual(['Narrator', 'Unknown speaker', 'Anne', 'Tom']);
    expect(saved.cast.slice(2).every((c) => c.voice.voiceName === 'en-b')).toBe(true);
    expect(saved.cast[2]!.voice).not.toEqual(saved.cast[3]!.voice);
    expect((await getPart(db, part.id))!.analysisStatus).toBe('done');
    expect(analysis.analyzer.kind).toBe('heuristic');
    const castIds = new Set(saved.cast.map((c) => c.id));
    expect(validateAnalysis((await getPart(db, part.id))!, analysis, castIds)).toEqual({
      ok: true,
    });
  });

  it('reuses characters from part 1 when analysing part 2', async () => {
    const { text } = loadFixture('es/marianela-ch1');
    const cut = text.indexOf('--¿Va usted al establecimiento?');
    const story = await createStory(db, { title: 'Marianela', lang: 'es' });
    const one = await addPart(db, story.id, paste(text.slice(0, cut)));
    const two = await addPart(db, story.id, paste(text.slice(cut)));

    await analyzePart(db, one.id, { voices: [] });
    const afterOne = (await getStory(db, story.id))!.cast;
    await analyzePart(db, two.id, { voices: [] });
    const afterTwo = (await getStory(db, story.id))!.cast;

    // Characters from part 1 keep their ids and voices; part 2 speaks through them.
    expect(afterTwo.slice(0, afterOne.length)).toEqual(
      afterOne.map((c) => ({ ...c, aliases: expect.any(Array) })),
    );
    const golfin = afterOne.find((c) => c.name === 'Golfín')!;
    const speakers = new Set((await getAnalysis(db, two.id))!.segments.map((s) => s.speakerId));
    expect(speakers.has(golfin.id)).toBe(true);
  });

  it('keeps cast edits made while an analysis runs', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await addPart(db, story.id, paste('“Hi,” said Anne.'));
    const running = analyzePart(db, part.id, { voices });
    const renamed = story.cast.map((c) => (c.role === 'narrator' ? { ...c, name: 'Voice' } : c));
    await updateStory(db, story.id, { cast: renamed });
    await running;
    const names = (await getStory(db, story.id))!.cast.map((c) => c.name);
    expect(names).toEqual(['Voice', 'Unknown speaker', 'Anne']);
  });

  it('marks the part failed when analysis throws, and keeps the queue going', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await addPart(db, story.id, paste('Hello.'));
    await updateStory(db, story.id, { cast: [] }); // no narrator: the analyser cannot run
    await expect(analyzePart(db, part.id, { voices })).rejects.toThrow();
    expect((await getPart(db, part.id))!.analysisStatus).toBe('failed');

    const other = await createStory(db, { title: 'T', lang: 'en' });
    const ok = await addPart(db, other.id, paste('Fine.'));
    await analyzePart(db, ok.id, { voices });
    expect((await getPart(db, ok.id))!.analysisStatus).toBe('done');
  });
});

describe('heuristic pipeline performance', () => {
  it('analyses a 5,000-word chapter in under a second', () => {
    const { text: base } = loadFixture('en/pride-ch1');
    const words = base.split(/\s+/).length;
    const text = Array.from({ length: Math.ceil(5000 / words) }, () => base).join('\n\n');
    const cast = baseCast('en');
    const t0 = performance.now();
    const labels = analyzeHeuristic({ text, lang: 'en', units: splitUnits(text, 'en'), cast });
    mergeLabels(text, labels, cast, 'p', () => crypto.randomUUID());
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
