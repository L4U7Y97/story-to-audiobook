import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Character, Lang } from '@/format/types';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { analyzeLlm } from '@/analysis/llm';
import { mergeLabels } from '@/analysis/merge';
import { splitUnits } from '@/analysis/units';
import { cleanTraits, TRAIT_KEYS } from '@/cast/traits';
import { segmentText, validateSegments } from '@/format/validate';
import { baseCast } from '../../helpers/fixtures';
import { fakeTransport } from '../../helpers/fakeLlm';

const TEXTS: Array<[Lang, string]> = [
  ['en', '“Hi,” said Anne. “Where is Tom?”\n\nTom looked up. “Here.”\n\nThe end.'],
  ['es', '—¿Quién es? —preguntó Pablo—. No veo nada.\n\n—Soy yo —dijo Nela.\n\nCallaron.'],
  ['en', 'Anne smiled. Hello there, Tom.\n\nShe thought: this is odd. “Is it?”'],
];

const cast: Character[] = [
  ...baseCast('en'),
  {
    id: 'anne',
    role: 'character',
    name: 'Anne',
    aliases: [],
    voice: { lang: 'en-US', pitch: 1, rate: 1 },
  },
];

const pieces = [
  ...new Set(TEXTS.flatMap(([, t]) => [...t.split(/\s+/u), ...t.split('\n\n'), t.slice(0, 7)])),
  ' ',
  '\n\n',
];

const span = fc.record(
  {
    text: fc.oneof(fc.constantFrom(...pieces), fc.string()),
    speaker: fc.constantFrom('N', 'U', 'c1', 'c2', 'new1', 'new2', 'x1', 'zz', ''),
    mode: fc.constantFrom('narration', 'speech', 'thought', 'written', 'singing'),
    tone: fc.record(
      {
        label: fc.constantFrom('shout', 'whisper', 'neutral', 'grumpy'),
        intensity: fc.integer({ min: -1, max: 5 }),
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);

const output = fc.record(
  {
    units: fc.array(
      fc.record({ id: fc.integer({ min: -1, max: 12 }), spans: fc.array(span, { maxLength: 3 }) }),
      { maxLength: 14 },
    ),
    newCharacters: fc.array(
      fc.record(
        {
          ref: fc.constantFrom('new1', 'new2', 'N', 'c1', 'x1'),
          name: fc.constantFrom('Tom', 'Anne', 'Pablo', '', ' ', 'Mr. Bennet', 'the old man'),
          aliases: fc.array(fc.constantFrom('Tommy', 'Anne', '', 'la Nela')),
          description: fc.string({ maxLength: 10 }),
          // Values the format knows, values it does not, and values that are not even strings.
          gender: fc.constantFrom('male', 'female', 'other', 'robot', ''),
          age: fc.constantFrom('child', 'teen', 'adult', 'elder', 'elderly', 'CHILD', '', 7, null),
          species: fc.constantFrom('human', 'animal', 'creature', 'machine', 'dragon', '', false),
          size: fc.constantFrom('small', 'large', 'medium', 'average', '', 0),
        },
        { requiredKeys: ['ref', 'name', 'aliases', 'description'] },
      ),
      { maxLength: 3 },
    ),
    aliasAdditions: fc.array(
      fc.record({
        characterId: fc.constantFrom('N', 'U', 'c1', 'new1', 'x1', 'zz'),
        alias: fc.constantFrom('Annie', '', 'Narrator'),
      }),
      { maxLength: 3 },
    ),
  },
  { requiredKeys: [] },
);

/** Anything the transport might hand back: valid-looking JSON, junk, or a cut-off answer. */
const reply = fc.record({
  stopReason: fc.constantFrom('end_turn', 'end_turn', 'refusal', 'max_tokens', null),
  text: fc.oneof(
    output.map((o) => JSON.stringify(o)),
    fc.string(),
    output.map((o) => JSON.stringify(o).slice(0, 40)),
  ),
});

describe('LLM output → stored analysis (property)', () => {
  it('always yields segments that tile the text and only name cast members', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: TEXTS.length - 1 }),
        fc.array(reply, { minLength: 1, maxLength: 4 }),
        async (which, replies) => {
          const [lang, text] = TEXTS[which]!;
          const units = splitUnits(text, lang);
          const heuristic = analyzeHeuristic({ text, lang, units, cast });
          let n = 0;
          const transport = fakeTransport(() => replies[n++ % replies.length]!);
          const result = await analyzeLlm({
            text,
            lang,
            units,
            cast,
            heuristic,
            transport,
            model: 'm',
            effort: 'low',
            limits: { maxUnits: 3, maxTokens: 10_000 },
          });
          let id = 0;
          const merged = mergeLabels(text, result.labels, cast, 'p', () => `id${++id}`);
          const castIds = new Set(merged.cast.map((c) => c.id));
          expect(validateSegments(text, merged.segments, castIds)).toEqual({ ok: true });
          expect(merged.segments.map((s) => segmentText(text, s)).join('')).toBe(text);
          // A stored trait is always one the format knows; anything else leaves no key behind.
          for (const member of merged.cast) {
            const held = TRAIT_KEYS.filter((key) => key in member);
            expect(held).toEqual(Object.keys(cleanTraits(member)));
          }
          // The run never gives a trait to someone who was in the cast before it.
          const before = merged.cast.slice(0, cast.length);
          expect(before.flatMap((m) => TRAIT_KEYS.filter((key) => key in m))).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });
});
