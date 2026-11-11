import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Character, Mode, Segment } from '@/format/types';
import { validateSegments } from '@/format/validate';
import {
  applyUserCorrections,
  coalesce,
  defaultMode,
  modeForAnyone,
  reassignSegment,
  reassignSegments,
  tellerOf,
} from '@/analysis/reassign';
import { analyzePart } from '@/analysis/analyzer';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { createStory, getStory } from '@/storage/stories';
import { addPart } from '@/storage/parts';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';

const seg = (
  start: number,
  end: number,
  speakerId: string,
  extra: Partial<Segment> = {},
): Segment => ({
  start,
  end,
  speakerId,
  mode: speakerId === 'n' ? 'narration' : 'speech',
  source: 'heuristic',
  ...extra,
});

/** Consecutive segments over the joined pieces, each [piece, speakerId, mode, extra?]. */
function tiled(pieces: Array<[string, string, Mode, Partial<Segment>?]>) {
  let start = 0;
  const segments = pieces.map(([piece, speakerId, mode, extra]): Segment => {
    const s: Segment = {
      start,
      end: start + piece.length,
      speakerId,
      mode,
      source: 'llm',
      ...extra,
    };
    start = s.end;
    return s;
  });
  return { text: pieces.map(([piece]) => piece).join(''), segments };
}

// “Hi,” she said, “bye.”\n\nNext.
const text = '“Hi,” she said, “bye.”\n\nNext.';
const segments = [seg(0, 5, 'u'), seg(5, 16, 'n'), seg(16, 24, 'u'), seg(24, 29, 'n')];

describe('reassignSegment', () => {
  it('marks the change as a user correction and defaultMode keeps quotes as speech, even for the narrator', () => {
    const out = reassignSegment(text, segments, 0, 'anne', 'n');
    expect(out[0]).toEqual({ start: 0, end: 5, speakerId: 'anne', mode: 'speech', source: 'user' });
    const byNarrator = reassignSegment(text, segments, 0, 'n', 'n');
    expect(byNarrator[0]).toMatchObject({ speakerId: 'n', mode: 'speech' });
    const spoken = reassignSegment(text, segments, 1, 'anne', 'n');
    expect(spoken[1]).toMatchObject({ speakerId: 'anne', mode: 'speech' });
    const narrated = reassignSegment(text, segments, 1, 'n', 'n');
    expect(narrated[1]).toMatchObject({ speakerId: 'n', mode: 'narration', source: 'user' });
    const thought = reassignSegment(text, segments, 1, 'n', 'n', 'thought');
    expect(thought[1]).toMatchObject({ speakerId: 'n', mode: 'thought' });
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

describe('defaultMode', () => {
  it('keeps narration for someone who already narrates in the part', () => {
    const told = [seg(0, 5, 'u'), seg(5, 16, 'amy', { mode: 'narration' }), ...segments.slice(2)];
    expect(defaultMode(text, told, 3, 'amy', 'n')).toBe('narration');
    expect(defaultMode(text, told, 3, 'bob', 'n')).toBe('speech');
  });

  it('reads narration that opens with a quote mark, or a dash line, as speech', () => {
    expect(defaultMode('“Hi,” she said.', [seg(0, 15, 'n')], 0, 'n', 'n')).toBe('speech');
    const es = tiled([
      ['—Hola ', 'u', 'speech'],
      ['—dijo Ana.\n\n', 'n', 'narration'],
      ['—¿Vienes?', 'n', 'narration'],
    ]);
    expect(defaultMode(es.text, es.segments, 2, 'n', 'n')).toBe('speech');
    expect(defaultMode(es.text, es.segments, 2, 'ana', 'n')).toBe('speech');
    // An inciso opens with a dash too, but it is narration.
    expect(defaultMode(es.text, es.segments, 1, 'n', 'n')).toBe('narration');
  });

  it('reads an inciso that a hard wrap puts at the start of a line as narration', () => {
    // Blank lines separate the paragraphs, so the newline before '—dijo' only wraps the line. (A
    // turn after a single newline, '—Hola.\n—Adiós.', is read the same way, as splitUnits does.)
    const wrapped = tiled([
      ['Llovía.\n\n', 'n', 'narration'],
      ['—No sé si vendrá\n', 'u', 'speech'],
      ['—dijo Ana—', 'n', 'narration'],
      ['. Ya veremos.', 'u', 'speech'],
    ]);
    expect(defaultMode(wrapped.text, wrapped.segments, 2, 'n', 'n')).toBe('narration');
    expect(reassignSegment(wrapped.text, wrapped.segments, 2, 'n', 'n')[2]).toMatchObject({
      speakerId: 'n',
      mode: 'narration',
      source: 'user',
    });
    // With no blank line in the text every newline starts a paragraph, so a dash after one opens
    // dialogue.
    const lines = tiled([
      ['Ana entró.\n', 'n', 'narration'],
      ['—¿Vienes?', 'n', 'narration'],
    ]);
    expect(defaultMode(lines.text, lines.segments, 1, 'n', 'n')).toBe('speech');
  });
});

describe('modeForAnyone', () => {
  it('gives how a line reads whoever reads it, and nothing for plain narration', () => {
    expect(modeForAnyone(text, segments, 0)).toBe('speech');
    expect(modeForAnyone(text, [seg(0, 5, 'u', { mode: 'thought' })], 0)).toBe('thought');
    expect(modeForAnyone('“Hi,” she said.', [seg(0, 15, 'n')], 0)).toBe('speech');
    // ' she said, ': narration for the narrator, speech for someone who does not narrate here.
    expect(modeForAnyone(text, segments, 1)).toBeUndefined();
    expect(defaultMode(text, segments, 1, 'n', 'n')).toBe('narration');
    expect(defaultMode(text, segments, 1, 'tom', 'n')).toBe('speech');
    expect(modeForAnyone(text, segments, segments.length)).toBeUndefined();
  });
});

describe('reassignSegments', () => {
  const amy = tiled([
    ['AMY\n\n', 'n', 'narration'],
    ['I met Nick at a party.\n\n', 'n', 'narration'],
    ['“Hello,”', 'nick', 'speech'],
    [' said Nick.\n\n', 'n', 'narration'],
    ['“Not yet,”', 'n', 'speech', { tone: { label: 'tired' } }],
    [' I said.', 'n', 'narration'],
  ]);
  const castIds = new Set(['n', 'nick', 'amy']);
  const voices = (out: Segment[]) => out.map((s) => `${s.speakerId} ${s.mode}`);

  it("gives every line of the tapped line's speaker in the part to a new teller", () => {
    const out = reassignSegments(amy.text, amy.segments, 1, 'amy', {
      narratorId: 'n',
      scope: 'part',
    });
    expect(voices(out)).toEqual([
      'amy narration',
      'amy narration',
      'nick speech',
      'amy narration',
      'amy speech',
      'amy narration',
    ]);
    expect(out.filter((s) => s.speakerId === 'amy').map((s) => s.source)).toEqual(
      Array(5).fill('user'),
    );
    expect(out[2]!.source).toBe('llm');
    expect(out[4]!.tone).toBeUndefined();
    expect(validateSegments(amy.text, out, castIds)).toEqual({ ok: true });
    expect(tellerOf(amy.segments, 'n')).toBe('n');
    expect(tellerOf(out, 'n')).toBe('amy');
  });

  it("changes only the old speaker's lines in a range, tapped in either order", () => {
    const out = reassignSegments(amy.text, amy.segments, 1, 'amy', {
      narratorId: 'n',
      scope: { through: 3 },
    });
    expect(out.map((s) => s.speakerId)).toEqual(['n', 'amy', 'nick', 'amy', 'n', 'n']);
    const reversed = reassignSegments(amy.text, amy.segments, 3, 'amy', {
      narratorId: 'n',
      scope: { through: 1 },
    });
    expect(reversed).toEqual(out);
  });

  it("changes the tapped line and the old speaker's later lines", () => {
    const out = reassignSegments(amy.text, amy.segments, 3, 'amy', {
      narratorId: 'n',
      scope: 'following',
    });
    expect(voices(out)).toEqual([
      'n narration',
      'n narration',
      'nick speech',
      'amy narration',
      'amy speech',
      'amy narration',
    ]);
  });
});

describe('tellerOf', () => {
  it('gives ties, and segments without narration, to the narrator', () => {
    expect(tellerOf([seg(0, 5, 'u')], 'n')).toBe('n');
    expect(tellerOf([seg(0, 5, 'amy', { mode: 'narration' }), seg(5, 10, 'n')], 'n')).toBe('n');
    expect(tellerOf([seg(0, 6, 'amy', { mode: 'narration' }), seg(6, 11, 'n')], 'n')).toBe('amy');
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

  it('keeps a correction inside a longer fresh segment', () => {
    const jane =
      '“Who is there?” said Grace Poole.\n\nShe looked up from her sewing and muttered “good night” without a smile.';
    const paragraph = jane.indexOf('She');
    const from = jane.indexOf('“good');
    const to = jane.indexOf(' without');
    const llm = { source: 'llm' as const };
    const fresh = [
      seg(0, 15, 'grace', llm),
      seg(15, paragraph, 'n', llm),
      seg(paragraph, jane.length, 'n', llm),
    ];
    const previous = [
      ...fresh.slice(0, 2),
      seg(paragraph, from, 'n', llm),
      seg(from, to, 'grace', { source: 'user' }),
      seg(to, jane.length, 'n', llm),
    ];
    const castIds = new Set(['n', 'grace']);
    const out = applyUserCorrections(jane, fresh, previous, castIds);
    expect(
      out
        .filter((s) => s.start >= paragraph)
        .map((s) => [jane.slice(s.start, s.end), s.speakerId, s.mode, s.source]),
    ).toEqual([
      ['She looked up from her sewing and muttered ', 'n', 'narration', 'llm'],
      ['“good night”', 'grace', 'speech', 'user'],
      [' without a smile.', 'n', 'narration', 'llm'],
    ]);
    expect(validateSegments(jane, out, castIds)).toEqual({ ok: true });
  });

  it('gives whitespace cut off by a correction to the piece before it', () => {
    const hi = '“Hi,” said Anne.';
    const fresh = [seg(0, 6, 'u'), seg(6, 16, 'n')];
    const previous = [seg(0, 5, 'anne', { source: 'user' }), seg(5, 16, 'n')];
    const out = applyUserCorrections(hi, fresh, previous, new Set(['anne', 'n', 'u']));
    expect(out.map((s) => [s.start, s.end, s.speakerId, s.source])).toEqual([
      [0, 6, 'anne', 'user'],
      [6, 16, 'n', 'heuristic'],
    ]);
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

  it('keeps a part told by a new character after a re-analysis', async () => {
    db = openStoryDb(`reassign-${Math.random()}`);
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await addPart(db, story.id, {
      title: 'p',
      source: { kind: 'paste' },
      text: '“Hi,” I said.\n\nIt rained.',
    });
    await analyzePart(db, part.id, { voices: [] });
    const before = (await getAnalysis(db, part.id))!;
    const told = before.segments.findIndex((s) => s.mode === 'narration');
    expect(before.segments[told]!.speakerId).toBe(story.narratorId);

    const amy: Character = {
      id: 'amy',
      role: 'character',
      name: 'Amy',
      aliases: [],
      voice: { lang: 'en-US', pitch: 1, rate: 1 },
    };
    const toldByAmy = reassignSegments(part.text, before.segments, told, amy.id, {
      narratorId: story.narratorId,
      scope: 'part',
    });
    await saveAnalysis(
      db,
      { ...before, segments: toldByAmy },
      { added: [amy], aliasAdditions: [] },
    );
    await analyzePart(db, part.id, { voices: [] });

    const after = (await getAnalysis(db, part.id))!;
    expect(
      after.segments.map((s) => [
        part.text.slice(s.start, s.end).trim(),
        s.speakerId,
        s.mode,
        s.source,
      ]),
    ).toEqual([
      ['“Hi,”', amy.id, 'speech', 'user'],
      ['I said.', amy.id, 'narration', 'user'],
      ['It rained.', amy.id, 'narration', 'user'],
    ]);
  });
});
