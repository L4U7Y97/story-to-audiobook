import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Segment } from '@/format/types';
import { applyUserCorrections, coalesce, reassignSegment } from '@/analysis/reassign';
import { analyzePart } from '@/analysis/analyzer';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { createStory, getStory } from '@/storage/stories';
import { addPart } from '@/storage/parts';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';

const seg = (start: number, end: number, speakerId: string, extra: Partial<Segment> = {}): Segment => ({
  start,
  end,
  speakerId,
  mode: speakerId === 'n' ? 'narration' : 'speech',
  source: 'heuristic',
  ...extra,
});

// “Hi,” she said, “bye.”\n\nNext.
const text = '“Hi,” she said, “bye.”\n\nNext.';
const segments = [seg(0, 5, 'u'), seg(5, 16, 'n'), seg(16, 24, 'u'), seg(24, 29, 'n')];

describe('reassignSegment', () => {
  it('marks the change as a user correction and picks a sensible mode', () => {
    const out = reassignSegment(text, segments, 0, 'anne', 'n');
    expect(out[0]).toEqual({ start: 0, end: 5, speakerId: 'anne', mode: 'speech', source: 'user' });
    const narrated = reassignSegment(text, segments, 0, 'n', 'n');
    expect(narrated[0]).toMatchObject({ speakerId: 'n', mode: 'narration' });
    const spoken = reassignSegment(text, segments, 1, 'anne', 'n');
    expect(spoken[1]).toMatchObject({ speakerId: 'anne', mode: 'speech' });
  });

  it('honours an explicit mode and drops the old tone', () => {
    const toned = [seg(0, 5, 'u', { tone: { label: 'shout' } }), ...segments.slice(1)];
    expect(reassignSegment(text, toned, 0, 'anne', 'n', 'thought')[0]).toEqual({
      start: 0,
      end: 5,
      speakerId: 'anne',
      mode: 'thought',
      source: 'user',
    });
  });

  it('joins neighbours that now sound the same, within the paragraph only', () => {
    let out = reassignSegment(text, segments, 0, 'anne', 'n');
    out = reassignSegment(text, out, 2, 'anne', 'n');
    out = reassignSegment(text, out, 1, 'anne', 'n', 'speech');
    expect(out.map((s) => [s.start, s.end, s.speakerId])).toEqual([
      [0, 24, 'anne'],
      [24, 29, 'n'],
    ]);
  });
});

describe('applyUserCorrections', () => {
  it('re-applies corrections to fresh segments inside the corrected range', () => {
    const previous = [seg(0, 24, 'anne', { source: 'user' }), seg(24, 29, 'n')];
    const out = applyUserCorrections(text, segments, previous, new Set(['anne', 'n', 'u']));
    expect(out.map((s) => [s.start, s.end, s.speakerId, s.source])).toEqual([
      [0, 24, 'anne', 'user'],
      [24, 29, 'n', 'heuristic'],
    ]);
  });

  it('ignores corrections to characters that no longer exist', () => {
    const previous = [seg(0, 5, 'gone', { source: 'user' })];
    expect(applyUserCorrections(text, segments, previous, new Set(['n', 'u']))).toEqual(segments);
  });
});

describe('coalesce', () => {
  it('keeps segments with different tones apart', () => {
    const out = coalesce('abcd', [seg(0, 2, 'a', { tone: { label: 'sad' } }), seg(2, 4, 'a')]);
    expect(out).toHaveLength(2);
  });
});

describe('re-running analysis keeps user corrections', () => {
  let db: StoryDb | undefined;
  afterEach(async () => {
    await db?.delete();
  });

  it('keeps the corrected speaker after a re-analysis', async () => {
    db = openStoryDb(`reassign-${Math.random()}`);
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await addPart(db, story.id, {
      title: 'p',
      source: { kind: 'paste' },
      text: '“Who is there?”\n\nNobody answered.',
    });
    await analyzePart(db, part.id, { voices: [] });
    const narrator = (await getStory(db, story.id))!.narratorId;
    const before = (await getAnalysis(db, part.id))!;
    expect(before.segments[0]!.speakerId).not.toBe(narrator);

    const fixed = reassignSegment(part.text, before.segments, 0, narrator, narrator);
    await saveAnalysis(db, { ...before, segments: fixed });
    await analyzePart(db, part.id, { voices: [] });

    const after = (await getAnalysis(db, part.id))!;
    expect(after.segments[0]).toMatchObject({ speakerId: narrator, source: 'user' });
  });
});
