import type { Unit } from '../units';

export interface ChunkLimits {
  maxUnits: number;
  /** Estimated tokens of unit text per chunk. */
  maxTokens: number;
}

export const DEFAULT_CHUNK_LIMITS: ChunkLimits = { maxUnits: 300, maxTokens: 6000 };

/**
 * A rough token count for prompt sizing and cost estimates. Claude's current tokenizer averages
 * about three characters per token for English and Spanish prose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Groups units into request-sized chunks. Chunks end at paragraph breaks whenever possible, so a
 * paragraph's speech and its dialogue tag are labelled together; a paragraph larger than a whole
 * chunk is split between units.
 */
export function chunkUnits(
  text: string,
  units: readonly Unit[],
  limits: ChunkLimits = DEFAULT_CHUNK_LIMITS,
): Unit[][] {
  const paragraphs: Unit[][] = [];
  for (const unit of units) {
    const last = paragraphs.at(-1);
    if (last && last[0]!.paragraph === unit.paragraph) last.push(unit);
    else paragraphs.push([unit]);
  }

  const tokens = (u: Unit) => estimateTokens(text.slice(u.start, u.end));
  const chunks: Unit[][] = [];
  let current: Unit[] = [];
  let currentTokens = 0;
  const fits = (n: number, t: number) =>
    current.length + n <= limits.maxUnits && currentTokens + t <= limits.maxTokens;
  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    currentTokens = 0;
  };

  for (const paragraph of paragraphs) {
    const paragraphTokens = paragraph.reduce((sum, u) => sum + tokens(u), 0);
    if (fits(paragraph.length, paragraphTokens)) {
      current.push(...paragraph);
      currentTokens += paragraphTokens;
      continue;
    }
    flush();
    for (const unit of paragraph) {
      const t = tokens(unit);
      if (!fits(1, t)) flush();
      current.push(unit);
      currentTokens += t;
    }
  }
  flush();
  return chunks;
}
