import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Lang } from '@/format/types';
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
