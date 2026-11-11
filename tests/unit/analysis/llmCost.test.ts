import { describe, expect, it } from 'vitest';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { analyzeLlm } from '@/analysis/llm';
import { estimateTokens } from '@/analysis/llm/chunking';
import { costOf, estimateCost, formatUsd, PRICES } from '@/analysis/llm/cost';
import type { NarratorStyle } from '@/analysis/llm/prompt';
import { splitUnits } from '@/analysis/units';
import { baseCast, loadFixture } from '../../helpers/fixtures';
import { fakeTransport, labelAll } from '../../helpers/fakeLlm';

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

  it('counts the cast lines the run sends, the narrator style included', async () => {
    const text = '“Hi,” I said.\n\nIt rained.';
    const units = splitUnits(text, 'en');
    const cast = baseCast('en');
    const model = 'claude-haiku-5-5';
    const sent = async (narratorStyle?: NarratorStyle) => {
      const transport = fakeTransport(({ units: u }) => labelAll(u, 'N'));
      const heuristic = analyzeHeuristic({ text, lang: 'en', units, cast });
      await analyzeLlm({
        text,
        lang: 'en',
        units,
        cast,
        heuristic,
        narratorStyle,
        transport,
        model,
        effort: 'low',
      });
      return transport.calls[0]!.request.user;
    };
    const estimate = (narratorStyle?: NarratorStyle) =>
      estimateCost({ text, lang: 'en', units, cast, model, narratorStyle }).inputTokens;

    const firstPerson = await sent('first person');
    expect(firstPerson).toContain('\nN: the narrator (first person)\n');
    // One request: the estimate is a fixed system part plus the tokens of the prompt sent.
    expect(estimate('first person') - estimateTokens(firstPerson)).toBe(
      estimate() - estimateTokens(await sent()),
    );
  });

  it('formats small amounts readably', () => {
    expect(formatUsd(0.0004)).toBe('under $0.001');
    expect(formatUsd(0.0042)).toBe('$0.004');
    expect(formatUsd(0.123)).toBe('$0.12');
  });
});
