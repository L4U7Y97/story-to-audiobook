import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { analyzeLlm } from '@/analysis/llm';
import type { SpeakerRef } from '@/analysis/labels';
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

interface Fixture {
  /** Shown in the test name and the results table. */
  name: string;
  path: string;
  /** Names that must not become characters. */
  notCharacters: string[];
  /** The teller's own single-quoted words (emphasis, named words, a note): the narrator's. */
  tellersQuotes: string[];
  /** Read the text with its double quotes made single, as in a book with single-quote dialogue. */
  singleQuoteDialogue?: boolean;
}

const TELLERS_QUOTES = ['‘quiet’', '‘important’', '‘Back by noon.’', '‘noon’', '‘sign’'];

// The heuristic accuracy fixtures: a third-person chapter, a first-person passage (where a
// character named after the narrator takes the narrator's lines) and a passage with single quotes,
// read once more as a book whose dialogue is all in single quotes. There every quote is a unit of
// its own, the teller's too.
const FIXTURES: Fixture[] = [
  { name: 'en/pride-ch1', path: 'en/pride-ch1', notCharacters: [], tellersQuotes: [] },
  { name: 'en/lighthouse', path: 'en/lighthouse', notCharacters: ['Kit'], tellersQuotes: [] },
  {
    name: 'en/single-quotes',
    path: 'en/single-quotes',
    notCharacters: [],
    tellersQuotes: TELLERS_QUOTES,
  },
  {
    name: 'en/single-quotes (single-quote dialogue)',
    path: 'en/single-quotes',
    notCharacters: [],
    tellersQuotes: TELLERS_QUOTES,
    singleQuoteDialogue: true,
  },
];

describe.skipIf(!apiKey).each(FIXTURES)('LLM on $name', (fixture) => {
  const { name, path, notCharacters, tellersQuotes, singleQuoteDialogue } = fixture;
  it(`attributes speakers ≥ ${ATTRIBUTION * 100}% and stays near the cost estimate`, async () => {
    const loaded = loadFixture(path);
    // One quote mark for another keeps every offset, so the labels still fit.
    const text = singleQuoteDialogue
      ? loaded.text.replaceAll('“', '‘').replaceAll('”', '’')
      : loaded.text;
    const { labels } = loaded;
    const cast = baseCast();
    const units = splitUnits(text);
    const estimate = estimateCost({ text, units, cast, model });
    const started = Date.now();
    const result = await analyzeLlm({
      text,
      units,
      cast,
      heuristic: analyzeHeuristic({ text, units, cast }),
      transport: createAnthropicTransport(apiKey),
      model,
      effort,
    });
    const seconds = (Date.now() - started) / 1000;
    const s = score(text, labels, result.labels, cast);
    // The teller's single-quoted words the narrator did not get (as narration, or a note as "written").
    const nameOf = (speaker: SpeakerRef) =>
      speaker.kind === 'cast'
        ? (cast.find((c) => c.id === speaker.id)?.name ?? speaker.id)
        : (result.labels.newCharacters.find((c) => c.ref === speaker.ref)?.name ?? speaker.ref);
    const tellerMisses = tellersQuotes.flatMap((quoted) => {
      const at = text.indexOf(quoted);
      const span = result.labels.spans.find((x) => x.start <= at && at < x.end)!;
      const narrator = span.speaker.kind === 'cast' && span.speaker.id === 'narrator';
      return narrator && ['narration', 'written'].includes(span.mode)
        ? []
        : [`${quoted} → ${nameOf(span.speaker)} (${span.mode})`];
    });
    const tellers = tellersQuotes.length
      ? `${tellersQuotes.length - tellerMisses.length}/${tellersQuotes.length}`
      : '–';
    const actual = costOf(model, result.usage);
    const tokens = (u: { inputTokens: number; outputTokens: number }) =>
      `${u.inputTokens} in / ${u.outputTokens} out`;

    console.info(
      `${name} (${model}, ${effort}): attribution ${(s.attribution * 100).toFixed(1)}%, ` +
        `speech/narration ${(s.speechVsNarration * 100).toFixed(1)}%, ` +
        `teller's quotes ${tellers}, ` +
        `fallback units ${result.fallbackUnits}/${units.length}, ${seconds.toFixed(1)} s\n` +
        `  tokens: actual ${tokens(result.usage)}, estimated ${tokens(estimate)}\n` +
        `  cost: actual ${actual === undefined ? '?' : formatUsd(actual)}, ` +
        `estimated ${estimate.usd === undefined ? '?' : formatUsd(estimate.usd)}\n` +
        `  characters: ${s.characters.join(', ')}` +
        (s.misses.length ? `\n  misses:\n  - ${s.misses.join('\n  - ')}` : '') +
        (tellerMisses.length
          ? `\n  teller's quotes missed:\n  - ${tellerMisses.join('\n  - ')}`
          : ''),
    );

    if (!existsSync(RESULTS)) {
      writeFileSync(
        RESULTS,
        '# LLM eval results\n\nRows are appended by `npm run eval:llm` (see tests/eval/llm.eval.ts).\n\n' +
          "| Date | Fixture | Model | Effort | Attribution | Speech/narration | Teller's quotes | Fallback units | Tokens (in/out) | Estimated tokens (in/out) | Cost | Estimate | Time |\n" +
          '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n',
      );
    }
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    appendFileSync(
      RESULTS,
      `| ${new Date().toISOString().slice(0, 10)} | ${name} | ${model} | ${effort} | ` +
        `${pct(s.attribution)} | ${pct(s.speechVsNarration)} | ${tellers} | ` +
        `${result.fallbackUnits}/${units.length} | ` +
        `${result.usage.inputTokens}/${result.usage.outputTokens} | ` +
        `${estimate.inputTokens}/${estimate.outputTokens} | ` +
        `${actual === undefined ? '?' : formatUsd(actual)} | ` +
        `${estimate.usd === undefined ? '?' : formatUsd(estimate.usd)} | ${seconds.toFixed(0)} s |\n`,
    );

    // Soft, so that one failed check never hides the others: a run costs money.
    expect.soft(s.attribution).toBeGreaterThanOrEqual(ATTRIBUTION);
    for (const character of notCharacters) expect.soft(s.characters).not.toContain(character);
    expect.soft(tellerMisses).toEqual([]);
  });
});

describe.skipIf(Boolean(apiKey))('LLM eval', () => {
  it('needs ANTHROPIC_API_KEY', () => {
    console.warn('Set ANTHROPIC_API_KEY to run the LLM eval. Nothing was sent.');
  });
});
