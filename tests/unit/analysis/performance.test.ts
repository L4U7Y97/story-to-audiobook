import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Character, Gender, Lang } from '@/format/types';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { mergeLabels } from '@/analysis/merge';
import { splitUnits } from '@/analysis/units';
import { baseCast } from '../../helpers/fixtures';

/**
 * Spec success criterion 3 asks for a 5,000-word chapter in under 5 s on a mid-range phone. This
 * guards against regressions on the dev machine (about 20–30 ms here as of 2026-10-15), with a
 * ceiling far below the phone budget; the phone itself is checked by hand.
 */
const CEILING_MS = 500;

function chapterOf(path: string, words: number): string {
  const excerpt = readFileSync(`tests/fixtures/${path}.txt`, 'utf8');
  let text = excerpt;
  while (text.split(/\s+/u).length < words) text += `\n\n${excerpt}`;
  return text;
}

describe.each([
  ['en/pride-ch1', 'en'],
  ['es/marianela-ch1', 'es'],
] as Array<[string, Lang]>)('heuristic speed on %s', (path, lang) => {
  it(`analyses a 5,000-word chapter in under ${CEILING_MS} ms`, () => {
    const text = chapterOf(path, 5000);
    const cast = baseCast(lang);
    let n = 0;
    const run = () => {
      const units = splitUnits(text, lang);
      const labels = analyzeHeuristic({ text, lang, units, cast });
      return mergeLabels(text, labels, cast, 'p', () => `id${++n}`);
    };
    run(); // warm-up (JIT)
    const started = performance.now();
    const merged = run();
    const elapsed = performance.now() - started;
    expect(merged.segments.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });
});

const DIALOGUE = [
  '“Where have you been, Margaret?” she asked, and Frederick looked at Dixon and Mr. Thornton.',
  'Margaret turned to Frederick. “At the mill with Mr. Thornton,” she said. “Dixon knows.”',
  'Frederick frowned at Margaret and Dixon. “Sunday?” he asked. “Yes,” she said.',
  '“I hope so,” he replied, looking at Mr. Thornton. “Dixon and Margaret will wait,” she said.',
];
/** Short lines: many "he said" tags for their length. */
const SHORT_DIALOGUE = [
  '“Yes,” she said.',
  '“No,” he said.',
  'Margaret looked at Frederick. “Why?” she asked.',
  '“Because,” he replied.',
];

/**
 * A chapter pasted from a word processor: a title, one blank line, then paragraphs on single
 * newlines, which splitUnits reads as one long paragraph. `lines` repeat up to `words`.
 */
function pastedChapter(words: number, lines = DIALOGUE): string {
  const body: string[] = [];
  for (let n = 0, count = 0; count < words; n++) {
    const line = lines[n % lines.length]!;
    body.push(line);
    count += line.split(/\s+/u).length;
  }
  return `Chapter One\n\n${body.join('\n')}`;
}

describe('heuristic speed on a pasted chapter', () => {
  const people: Array<[string, Gender]> = [
    ['Margaret', 'female'],
    ['Frederick', 'male'],
    ['Mr. Thornton', 'male'],
    ['Dixon', 'female'],
  ];
  const voice = { lang: 'en-GB', pitch: 1, rate: 1 };
  const cast: Character[] = [
    ...baseCast('en'),
    ...people.map(([name, gender]) => ({
      id: name,
      role: 'character' as const,
      name,
      aliases: [],
      gender,
      voice,
    })),
  ];

  // A "he said" tag looks for people named earlier in its paragraph, which must stay cheap however
  // long the paragraph is.
  it(`analyses one 5,000-word paragraph of "he said" dialogue in under ${CEILING_MS} ms`, () => {
    const text = pastedChapter(5000);
    expect(new Set(splitUnits(text, 'en').map((u) => u.paragraph)).size).toBe(2);
    let n = 0;
    const run = () => {
      const units = splitUnits(text, 'en');
      const labels = analyzeHeuristic({ text, lang: 'en', units, cast });
      return mergeLabels(text, labels, cast, 'p', () => `id${++n}`);
    };
    run(); // warm-up (JIT)
    const started = performance.now();
    const merged = run();
    const elapsed = performance.now() - started;
    expect(merged.segments.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  // Four times as long, with a tag every few words: about 170 ms here. Time that grows with the
  // square of the paragraph (reading it again from the start for each tag) takes seconds.
  it(`analyses one 20,000-word paragraph of short "he said" lines in under ${CEILING_MS} ms`, () => {
    const text = pastedChapter(20000, SHORT_DIALOGUE);
    expect(new Set(splitUnits(text, 'en').map((u) => u.paragraph)).size).toBe(2);
    let n = 0;
    const run = () => {
      const units = splitUnits(text, 'en');
      const labels = analyzeHeuristic({ text, lang: 'en', units, cast });
      return mergeLabels(text, labels, cast, 'p', () => `id${++n}`);
    };
    run(); // warm-up (JIT)
    const started = performance.now();
    const merged = run();
    const elapsed = performance.now() - started;
    expect(merged.segments.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });
});
