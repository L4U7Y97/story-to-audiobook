import { describe, expect, it } from 'vitest';
import type { Segment } from '@/format/types';
import { isSpeakable, segmentText, validateAnalysis, validateSegments } from '@/format/validate';

const cast = new Set(['narrator', 'ana']);

function seg(start: number, end: number, speakerId = 'narrator'): Segment {
  return { start, end, speakerId, mode: 'narration', source: 'heuristic' };
}

describe('validateSegments', () => {
  const text = '“Hola,” dijo Ana.';

  it('accepts segments that tile the text', () => {
    const result = validateSegments(text, [seg(0, 7, 'ana'), seg(7, text.length)], cast);
    expect(result).toEqual({ ok: true });
  });

  it('accepts no segments for empty text only', () => {
    expect(validateSegments('', [], cast)).toEqual({ ok: true });
    expect(validateSegments(text, [], cast)).toMatchObject({ ok: false, reason: 'no segments' });
  });

  it.each([
    ['not starting at 0', [seg(1, 7), seg(7, 17)], 'does not start at 0'],
    ['a gap', [seg(0, 6), seg(7, 17)], 'gap or overlap at 1'],
    ['an overlap', [seg(0, 8), seg(7, 17)], 'gap or overlap at 1'],
    ['an empty segment', [seg(0, 0), seg(0, 17)], 'empty segment at 0'],
    ['a reversed segment', [seg(0, 7), seg(7, 5), seg(5, 17)], 'empty segment at 1'],
    ['not reaching the end', [seg(0, 7), seg(7, 16)], 'does not reach end of text'],
    ['going past the end', [seg(0, 7), seg(7, 18)], 'does not reach end of text'],
    ['an unknown speaker', [seg(0, 7, 'bob'), seg(7, 17)], 'unknown speaker bob at 0'],
  ])('rejects %s', (_name, segments, reason) => {
    expect(validateSegments(text, segments, cast)).toEqual({ ok: false, reason });
  });

  it('rejects a whitespace-only segment between spoken ones', () => {
    const t = 'Hi.\n\nBye.';
    const result = validateSegments(t, [seg(0, 3), seg(3, 5), seg(5, 9)], cast);
    expect(result).toEqual({ ok: false, reason: 'whitespace-only segment at 1' });
  });

  it('allows a single whitespace-only segment when the whole text is whitespace', () => {
    expect(validateSegments('\n\n', [seg(0, 2)], cast)).toEqual({ ok: true });
  });

  it('measures offsets in UTF-16 code units (emoji and accents)', () => {
    const t = 'Él 😀 rió.';
    expect(t.length).toBe(10);
    expect(validateSegments(t, [seg(0, 5), seg(5, 10)], cast)).toEqual({ ok: true });
  });
});

describe('validateAnalysis', () => {
  it('rejects an analysis made for different text', () => {
    const part = { text: 'abc', textHash: 'h1' };
    const analysis = { textHash: 'h2', segments: [seg(0, 3)] };
    expect(validateAnalysis(part, analysis, cast)).toEqual({ ok: false, reason: 'stale analysis' });
  });

  it('validates segments when hashes match', () => {
    const part = { text: 'abc', textHash: 'h1' };
    expect(validateAnalysis(part, { textHash: 'h1', segments: [seg(0, 3)] }, cast)).toEqual({
      ok: true,
    });
  });
});

describe('segmentText', () => {
  it('slices the text for a segment', () => {
    expect(segmentText('Hello world', seg(6, 11))).toBe('world');
  });
});

describe('isSpeakable', () => {
  it.each([
    ['Hola', true],
    ['¿Sí?', true],
    ['42', true],
    ['—', false],
    [' \n ', false],
    ['...', false],
  ])('%j → %s', (input, expected) => {
    expect(isSpeakable(input)).toBe(expected);
  });
});
