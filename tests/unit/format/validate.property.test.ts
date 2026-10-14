import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Segment } from '@/format/types';
import { validateSegments } from '@/format/validate';

const cast = new Set(['narrator', 'a', 'b']);

/** Random text (with whitespace runs and non-BMP characters) plus random cut points that tile it. */
const textWithCuts = fc
  .string({ unit: fc.constantFrom('a', 'é', ' ', '\n', '“', '—', '😀', 'Z'), minLength: 1 })
  .chain((text) =>
    fc
      .uniqueArray(fc.integer({ min: 1, max: Math.max(1, text.length - 1) }), {
        maxLength: Math.min(10, text.length - 1),
      })
      .map((cuts) => ({ text, cuts: [...cuts].sort((x, y) => x - y) })),
  );

function toSegments(text: string, cuts: number[]): Segment[] {
  const bounds = [0, ...cuts.filter((c) => c > 0 && c < text.length), text.length];
  return bounds.slice(0, -1).map((start, i) => ({
    start,
    end: bounds[i + 1]!,
    speakerId: i % 2 ? 'a' : 'narrator',
    mode: 'narration',
    source: 'heuristic',
  }));
}

describe('validateSegments (properties)', () => {
  it('any accepted segmentation reproduces the text exactly', () => {
    fc.assert(
      fc.property(textWithCuts, ({ text, cuts }) => {
        const segments = toSegments(text, cuts);
        if (validateSegments(text, segments, cast).ok) {
          expect(segments.map((s) => text.slice(s.start, s.end)).join('')).toBe(text);
        }
      }),
    );
  });

  it('rejects any segmentation where one segment end is moved', () => {
    fc.assert(
      fc.property(textWithCuts, fc.nat(), fc.constantFrom(-1, 1), ({ text, cuts }, pick, delta) => {
        const segments = toSegments(text, cuts);
        const i = pick % segments.length;
        // Moving one end without moving the next start leaves a gap, an overlap or a bad ending.
        const broken = segments.map((s, j) => (j === i ? { ...s, end: s.end + delta } : s));
        expect(validateSegments(text, broken, cast).ok).toBe(false);
      }),
    );
  });

  it('rejects any segment pointing at a speaker outside the cast', () => {
    fc.assert(
      fc.property(textWithCuts, fc.nat(), ({ text, cuts }, pick) => {
        const segments = toSegments(text, cuts);
        const i = pick % segments.length;
        segments[i] = { ...segments[i]!, speakerId: 'ghost' };
        expect(validateSegments(text, segments, cast).ok).toBe(false);
      }),
    );
  });
});
