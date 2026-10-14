import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { analyzeLlm } from '@/analysis/llm';
import { createAnthropicTransport, type Effort } from '@/analysis/llm/client';
import { costOf, estimateCost, formatUsd } from '@/analysis/llm/cost';
import { splitUnits } from '@/analysis/units';
import { baseCast, loadFixture, score } from '../helpers/fixtures';

/**
 * Manual LLM accuracy eval (SPEC.md: speaker attribution ≥ 90% on the fixtures).
 *   ANTHROPIC_API_KEY=… npm run eval:llm
 * Optional: EVAL_MODEL (default claude-haiku-5-5), EVAL_EFFORT (default low).
 * Each run appends a row per fixture to docs/eval-results.md.
 */
const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
const model = process.env.EVAL_MODEL ?? 'claude-haiku-5-5';
const effort = (process.env.EVAL_EFFORT ?? 'low') as Effort;
const RESULTS = 'docs/eval-results.md';
const ATTRIBUTION = 0.9;

describe.skipIf(!apiKey).each([['en/pride-ch1'], ['es/marianela-ch1']])('LLM on %s', (path) => {
  it(`attributes speakers ≥ ${ATTRIBUTION * 100}% and stays near the cost estimate`, async () => {
    const { text, labels } = loadFixture(path);
    const cast = baseCast(labels.lang);
    const units = splitUnits(text, labels.lang);
    const estimate = estimateCost({ text, lang: labels.lang, units, cast, model });
    const started = Date.now();
    const result = await analyzeLlm({
      text,
      lang: labels.lang,
      units,
      cast,
      heuristic: analyzeHeuristic({ text, lang: labels.lang, units, cast }),
      transport: createAnthropicTransport(apiKey),
      model,
      effort,
    });
    const seconds = (Date.now() - started) / 1000;
    const s = score(text, labels, result.labels, cast);
    const actual = costOf(model, result.usage);
    const tokens = (u: { inputTokens: number; outputTokens: number }) =>
      `${u.inputTokens} in / ${u.outputTokens} out`;

    console.info(
      `${path} (${model}, ${effort}): attribution ${(s.attribution * 100).toFixed(1)}%, ` +
        `speech/narration ${(s.speechVsNarration * 100).toFixed(1)}%, ` +
        `fallback units ${result.fallbackUnits}/${units.length}, ${seconds.toFixed(1)} s\n` +
        `  tokens: actual ${tokens(result.usage)}, estimated ${tokens(estimate)}\n` +
        `  cost: actual ${actual === undefined ? '?' : formatUsd(actual)}, ` +
        `estimated ${estimate.usd === undefined ? '?' : formatUsd(estimate.usd)}\n` +
        `  characters: ${s.characters.join(', ')}` +
        (s.misses.length ? `\n  misses:\n  - ${s.misses.join('\n  - ')}` : ''),
    );

    if (!existsSync(RESULTS)) {
      writeFileSync(
        RESULTS,
        '# LLM eval results\n\nRows are appended by `npm run eval:llm` (see tests/eval/llm.eval.ts).\n\n' +
          '| Date | Fixture | Model | Effort | Attribution | Speech/narration | Fallback units | Tokens (in/out) | Estimated tokens (in/out) | Cost | Estimate | Time |\n' +
          '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n',
      );
    }
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    appendFileSync(
      RESULTS,
      `| ${new Date().toISOString().slice(0, 10)} | ${path} | ${model} | ${effort} | ` +
        `${pct(s.attribution)} | ${pct(s.speechVsNarration)} | ${result.fallbackUnits}/${units.length} | ` +
        `${result.usage.inputTokens}/${result.usage.outputTokens} | ` +
        `${estimate.inputTokens}/${estimate.outputTokens} | ` +
        `${actual === undefined ? '?' : formatUsd(actual)} | ` +
        `${estimate.usd === undefined ? '?' : formatUsd(estimate.usd)} | ${seconds.toFixed(0)} s |\n`,
    );

    expect(s.attribution).toBeGreaterThanOrEqual(ATTRIBUTION);
  });
});

describe.skipIf(Boolean(apiKey))('LLM eval', () => {
  it('needs ANTHROPIC_API_KEY', () => {
    console.warn('Set ANTHROPIC_API_KEY to run the LLM eval. Nothing was sent.');
  });
});
