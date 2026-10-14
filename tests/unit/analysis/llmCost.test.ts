import { describe, expect, it } from 'vitest';
import { costOf, estimateCost, formatUsd, PRICES } from '@/analysis/llm/cost';
import { splitUnits } from '@/analysis/units';
import { baseCast, loadFixture } from '../../helpers/fixtures';

describe('cost', () => {
  it('prices usage per million tokens', () => {
    expect(costOf('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(
      0.6,
    );
    expect(costOf('claude-opus-5-5', { inputTokens: 10_000, outputTokens: 2_000 })).toBeCloseTo(
      0.08,
    );
    expect(costOf('unknown-model', { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });

  it('estimates a chapter from the requests the analysis will send', () => {
    const { text, labels } = loadFixture('en/pride-ch1');
    const units = splitUnits(text, labels.lang);
    const e = estimateCost({
      text,
      lang: 'en',
      units,
      cast: baseCast('en'),
      model: 'claude-haiku-5-5',
    });
    expect(e.requests).toBe(1);
    // The prompt carries the whole chapter plus instructions; the answer is ~24 tokens per unit.
    expect(e.inputTokens).toBeGreaterThan(text.length / 3);
    expect(e.outputTokens).toBeGreaterThan(units.length * 20);
    expect(e.usd).toBeCloseTo(
      (e.inputTokens * PRICES['claude-haiku-5-5']!.input +
        e.outputTokens * PRICES['claude-haiku-5-5']!.output) /
        1e6,
    );
    expect(e.usd!).toBeLessThan(0.01);
  });

  it('formats small amounts readably', () => {
    expect(formatUsd(0.0004)).toBe('under $0.001');
    expect(formatUsd(0.0042)).toBe('$0.004');
    expect(formatUsd(0.123)).toBe('$0.12');
  });
});
