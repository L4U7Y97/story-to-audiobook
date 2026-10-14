import type { Character, Lang } from '@/format/types';
import type { Unit } from '../units';
import { chunkUnits, DEFAULT_CHUNK_LIMITS, estimateTokens } from './chunking';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';

/** USD per million tokens (prompts under 100k tokens, which every chunk is). */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

/** The output schema the API adds to every request, and the context lines after chunk 1. */
const SCHEMA_TOKENS = 700;
const CONTEXT_TOKENS_PER_LINE = 25;
/** One `{"id":12,"spans":[{"speaker":"c1","mode":"speech"}]}` entry, plus some tones and splits. */
const OUTPUT_TOKENS_PER_UNIT = 24;
/** Thinking at low effort, new characters and the JSON wrapper. */
const OUTPUT_TOKENS_PER_CHUNK = 400;

export interface CostEstimate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Undefined when the model has no known price. */
  usd?: number;
}

export function costOf(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

/** Estimates what analysing a part will cost, from the same chunks and prompts the run will send. */
export function estimateCost(input: {
  text: string;
  lang: Lang;
  units: readonly Unit[];
  cast: readonly Character[];
  model: string;
}): CostEstimate {
  const chunks = chunkUnits(input.text, input.units, DEFAULT_CHUNK_LIMITS);
  let n = 0;
  const cast = input.cast.map((c) => ({
    code: c.role === 'narrator' ? 'N' : c.role === 'unknown' ? 'U' : `c${++n}`,
    name: c.name,
    role: c.role,
    aliases: c.aliases,
    ...(c.gender ? { gender: c.gender } : {}),
    ...(c.description ? { description: c.description } : {}),
  }));
  const system = estimateTokens(SYSTEM_PROMPT) + SCHEMA_TOKENS;

  let inputTokens = 0;
  let outputTokens = 0;
  chunks.forEach((chunk, i) => {
    const user = buildUserPrompt({
      lang: input.lang,
      cast,
      context: [],
      units: chunk.map((u) => input.text.slice(u.start, u.end)),
    });
    inputTokens += system + estimateTokens(user) + (i > 0 ? 20 * CONTEXT_TOKENS_PER_LINE : 0);
    outputTokens += chunk.length * OUTPUT_TOKENS_PER_UNIT + OUTPUT_TOKENS_PER_CHUNK;
  });
  const estimate = { requests: chunks.length, inputTokens, outputTokens };
  const usd = costOf(input.model, estimate);
  return usd === undefined ? estimate : { ...estimate, usd };
}

/** "$0.004", "$0.12", or "under $0.001". */
export function formatUsd(usd: number): string {
  if (usd < 0.001) return 'under $0.001';
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
