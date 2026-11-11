import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Mode, Segment, SegmentSource } from '@/format/types';
import { validateSegments } from '@/format/validate';
import {
  applyUserCorrections,
  defaultMode,
  modeForAnyone,
  reassignSegments,
  type ReassignScope,
} from '@/analysis/reassign';

const cast = ['n', 'u', 'a', 'b'];
const modes: Mode[] = ['narration', 'speech', 'thought', 'written'];

const voiceFrom = (speakers: string[]) =>
  fc.record({
    speakerId: fc.constantFrom(...speakers),
    mode: fc.constantFrom(...modes),
    source: fc.constantFrom<SegmentSource>('heuristic', 'llm', 'user'),
  });

/** Random text with whitespace runs, paragraph breaks, quotes, dashes and non-BMP characters. */
const texts = fc.string({
  unit: fc.constantFrom('a', 'é', ' ', '\n', '“', '—', '😀', 'Z'),
  minLength: 1,
  maxLength: 40,
});

/** Cut points that leave something to say on both sides, as in every stored analysis. */
function spokenCuts(text: string, cuts: number[]): number[] {
  const kept: number[] = [];
  let from = 0;
  for (const c of [...cuts].sort((x, y) => x - y)) {
    if (c < text.length && /\S/u.test(text.slice(from, c)) && /\S/u.test(text.slice(c))) {
      kept.push(c);
      from = c;
    }
  }
  return kept;
}

/** Segments tiling `text` at random cut points; `blank` also allows whitespace-only segments. */
const tilingOf = (text: string, speakers: string[], { blank = false } = {}) =>
  fc
    .tuple(
      fc.uniqueArray(fc.integer({ min: 1, max: Math.max(1, text.length - 1) }), { maxLength: 12 }),
      fc.array(voiceFrom(speakers), { minLength: 13, maxLength: 13 }),
    )
    .map(([cuts, voices]) => {
      const kept = blank
        ? cuts.filter((c) => c < text.length).sort((x, y) => x - y)
        : spokenCuts(text, cuts);
      const bounds = [0, ...kept, text.length];
      return bounds
        .slice(0, -1)
        .map((start, i): Segment => ({ start, end: bounds[i + 1]!, ...voices[i]! }));
    });

/** Speaker, mode and source at every offset of the text. */
function voiceAt(segments: readonly Segment[], length: number): string[] {
  const out = Array<string>(length).fill('');
  for (const s of segments) {
    out.fill(`${s.speakerId} ${s.mode} ${s.source}`, s.start, s.end);
  }
  return out;
}

function inScope(scope: ReassignScope, index: number, i: number): boolean {
  if (scope === 'line') return i === index;
  if (scope === 'following') return i >= index;
  if (scope === 'part') return true;
  return i >= Math.min(index, scope.through) && i <= Math.max(index, scope.through);
}

const scopes = (count: number) =>
  fc.oneof(
    fc.constantFrom<ReassignScope>('line', 'following', 'part'),
    fc.integer({ min: -2, max: count + 1 }).map((through): ReassignScope => ({ through })),
  );

describe('reassignSegments (properties)', () => {
  const cases = texts.chain((text) =>
    tilingOf(text, cast).chain((segments) =>
      fc.record({
        text: fc.constant(text),
        segments: fc.constant(segments),
        index: fc.nat({ max: segments.length - 1 }),
        speakerId: fc.constantFrom(...cast, 'x'),
        mode: fc.option(fc.constantFrom(...modes), { nil: undefined }),
        scope: scopes(segments.length),
      }),
    ),
  );

  it('keeps a valid tiling and changes exactly the lines in scope', () => {
    fc.assert(
      fc.property(cases, ({ text, segments, index, speakerId, mode, scope }) => {
        const out = reassignSegments(text, segments, index, speakerId, {
          narratorId: 'n',
          mode,
          scope,
        });
        expect(validateSegments(text, out, new Set([...cast, 'x']))).toEqual({ ok: true });
        expect(out.map((s) => text.slice(s.start, s.end)).join('')).toBe(text);

        const old = segments[index]!.speakerId;
        const lineMode = mode ?? defaultMode(text, segments, index, speakerId, 'n');
        const expected = segments.map((s, i): Segment =>
          inScope(scope, index, i) && s.speakerId === old
            ? { ...s, speakerId, mode: scope === 'line' ? lineMode : s.mode, source: 'user' }
            : s,
        );
        expect(voiceAt(out, text.length)).toEqual(voiceAt(expected, text.length));
      }),
    );
  });
});

describe('modeForAnyone (properties)', () => {
  const lines = texts.chain((text) =>
    tilingOf(text, cast).chain((segments) =>
      fc.record({
        text: fc.constant(text),
        segments: fc.constant(segments),
        index: fc.nat({ max: segments.length - 1 }),
      }),
    ),
  );

  it('is defaultMode for everyone when set, and unset only where it depends on who reads', () => {
    fc.assert(
      fc.property(lines, ({ text, segments, index }) => {
        const forAnyone = modeForAnyone(text, segments, index);
        const modes = [...cast, 'x'].map((id) => defaultMode(text, segments, index, id, 'n'));
        if (forAnyone) {
          expect(modes).toEqual(modes.map(() => forAnyone));
        } else {
          // Plain narration: the narrator narrates it, someone who narrates nothing here says it.
          expect(segments[index]!.mode).toBe('narration');
          expect(defaultMode(text, segments, index, 'n', 'n')).toBe('narration');
          expect(defaultMode(text, segments, index, 'x', 'n')).toBe('speech');
        }
      }),
    );
  });
});

describe('applyUserCorrections (properties)', () => {
  const everyone = [...cast, 'gone'];
  const cases = texts.chain((text) =>
    fc.record({
      text: fc.constant(text),
      fresh: tilingOf(text, cast),
      previous: tilingOf(text, everyone, { blank: true }),
      valid: fc.subarray(everyone).map((ids) => new Set(ids)),
    }),
  );

  it('keeps a valid tiling and gives every corrected word its correction', () => {
    fc.assert(
      fc.property(cases, ({ text, fresh, previous, valid }) => {
        const out = applyUserCorrections(text, fresh, previous, valid);
        expect(validateSegments(text, out, new Set([...cast, ...valid]))).toEqual({ ok: true });
        expect(out.map((s) => text.slice(s.start, s.end)).join('')).toBe(text);

        const corrections = previous.filter((s) => s.source === 'user' && valid.has(s.speakerId));
        const expected = voiceAt(fresh, text.length);
        for (const c of corrections) expected.fill(`${c.speakerId} ${c.mode} user`, c.start, c.end);
        // Whitespace may move to a neighbouring piece; every other character keeps its voice.
        const words = (voices: string[]) => voices.map((v, i) => (/\s/u.test(text[i]!) ? '' : v));
        expect(words(voiceAt(out, text.length))).toEqual(words(expected));
      }),
      { numRuns: 300 },
    );
  });
});
