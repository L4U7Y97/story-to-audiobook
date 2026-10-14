import { describe, expect, it } from 'vitest';
import { splitUnits } from '@/analysis/units';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { baseCast, loadFixture, score } from '../../helpers/fixtures';

// Accuracy thresholds from SPEC.md (Testing strategy → Fixture accuracy).
const SPEECH_VS_NARRATION = 0.95;
const ATTRIBUTION = 0.7;

describe.each([['en/pride-ch1'], ['es/marianela-ch1']])('heuristic on %s', (path) => {
  const { text, labels } = loadFixture(path);
  const cast = baseCast(labels.lang);
  const result = analyzeHeuristic({
    text,
    lang: labels.lang,
    units: splitUnits(text, labels.lang),
    cast,
  });
  const s = score(text, labels, result, cast);

  it('reports its accuracy', () => {
    console.info(
      `${path}: speech/narration ${(s.speechVsNarration * 100).toFixed(1)}%, ` +
        `attribution ${(s.attribution * 100).toFixed(1)}%, characters [${s.characters.join(', ')}]` +
        (s.misses.length ? `\n  misses:\n  - ${s.misses.join('\n  - ')}` : ''),
    );
  });

  it(`classifies speech vs narration ≥ ${SPEECH_VS_NARRATION * 100}%`, () => {
    expect(s.speechVsNarration).toBeGreaterThanOrEqual(SPEECH_VS_NARRATION);
  });

  it(`attributes speakers ≥ ${ATTRIBUTION * 100}%`, () => {
    expect(s.attribution).toBeGreaterThanOrEqual(ATTRIBUTION);
  });

  it('is deterministic', () => {
    const again = analyzeHeuristic({
      text,
      lang: labels.lang,
      units: splitUnits(text, labels.lang),
      cast,
    });
    expect(again).toEqual(result);
  });

  it('tiles the text', () => {
    expect(result.spans[0]!.start).toBe(0);
    expect(result.spans.at(-1)!.end).toBe(text.length);
    result.spans.forEach((span, i) => i && expect(span.start).toBe(result.spans[i - 1]!.end));
  });
});
