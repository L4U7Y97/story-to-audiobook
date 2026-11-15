/** The Token and Mention types, and the pure token helpers the heuristic modules share. */

import type { Gender } from '@/format/types';
import { ADDRESSEE_MARKERS, NON_PARTICIPANT_PREPOSITIONS } from './lexicon';

export interface Token {
  text: string;
  /** Where the word ends in the tokenized text. */
  end: number;
  /** First word of a sentence, clause after a dash, or quoted passage. */
  sentenceStart: boolean;
  /** Punctuation between the previous token and this one (whitespace removed). */
  punctBefore: string;
  /** A capitalised word that ended in ’s ("Elizabeth’s"); `text` is the name without it. */
  possessive?: boolean;
}

export interface Mention {
  kind: 'name' | 'descriptor';
  /** Names keep their case ("Mr. Bennet"); descriptors are lower-case ("his wife"). */
  name: string;
  gender?: Gender;
  first: number;
  last: number;
  /** "Elizabeth’s": refers to Elizabeth, but is never the subject of a verb. */
  possessive?: boolean;
}

/** A word that starts with a lower-case letter. */
export const LOWER = /^\p{Ll}/u;
/** A word that starts with a capital. */
export const UPPER = /^\p{Lu}/u;
/** An adverb in -ly: "quietly". */
export const LY_ADVERB = /^\p{Ll}+ly$/u;

/** The word at `k`, lower-case ('' when there is none). */
export function wordAt(ts: Token[], k: number): string {
  return ts[k]?.text.toLowerCase() ?? '';
}

/** The word at `k`, lower-case and with ’ as ' ("i'd"), or ''. */
export function apostropheWordAt(ts: Token[], k: number): string {
  return ts[k]?.text.toLowerCase().replace(/’/gu, "'") ?? '';
}

/** The word at `k`, lower-case, when nothing but a space comes before it; otherwise ''. */
export function gluedWordAt(ts: Token[], k: number): string {
  return ts[k] && !ts[k]!.punctBefore ? ts[k]!.text.toLowerCase() : '';
}

/** Whether there is a word at `k` with nothing but a space before it. */
export function gluedAt(ts: Token[], k: number): boolean {
  return !!ts[k] && !ts[k]!.punctBefore;
}

/** The first word from `k` on that is not an -ly adverb with nothing but a space before it. */
export function pastLyAdverbs(ts: Token[], k: number): number {
  while (ts[k] && !ts[k]!.punctBefore && LY_ADVERB.test(ts[k]!.text)) k++;
  return k;
}

/** Where the first sentence after token `k` starts, or the end of the tokens. */
export function sentenceEndAfter(ts: Token[], k: number): number {
  const end = ts.findIndex((t, i) => i > k && t.sentenceStart);
  return end === -1 ? ts.length : end;
}

/** Where the clause of the word at `v` starts: after punctuation, at a sentence start or at 0. */
export function clauseStart(ts: Token[], v: number): number {
  let c = v;
  while (c > 0 && !ts[c]!.punctBefore && !ts[c]!.sentenceStart) c--;
  return c;
}

/**
 * Where the clause before the join at `join` starts, back to `start` at most: back from the join,
 * or from before the comma of ", then" or ", and".
 */
export function clauseBeforeJoin(ts: Token[], join: number, start: number): number {
  let clause = ts[join]!.punctBefore ? join - 1 : join;
  while (clause > start && !ts[clause]!.punctBefore) clause--;
  return clause;
}

/** Whether `words` stand from `i` on with nothing but spaces between them ("my name is"). */
export function phraseAt(ts: Token[], i: number, words: readonly string[]): boolean {
  return words.every((w, k) => {
    const t = ts[i + k];
    return t !== undefined && t.text.toLowerCase() === w && (k === 0 || !t.punctBefore);
  });
}

/** Where the first sentence of a run of tokens ends (exclusive). */
export function firstSentenceEnd(ts: Token[]): number {
  return sentenceEndAfter(ts, 0);
}

/** Where the last sentence of a run of tokens starts. */
export function lastSentenceStart(ts: Token[]): number {
  return Math.max(
    0,
    findLastIndex(ts, (t, i) => i > 0 && t.sentenceStart),
  );
}

export function findLastIndex<T>(items: T[], predicate: (item: T, i: number) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!, i)) return i;
  return -1;
}

/** The lower-case word right before a mention, when nothing but a space separates them. */
export function wordBefore(ts: Token[], m: Mention): string | undefined {
  const prev = ts[m.first - 1];
  return prev && !ts[m.first]!.punctBefore ? prev.text.toLowerCase() : undefined;
}

/** "in London", "from Mr. Collins": a place or someone absent. */
export function afterPreposition(ts: Token[], m: Mention): boolean {
  return NON_PARTICIPANT_PREPOSITIONS.has(wordBefore(ts, m) ?? '');
}

/** "to Anne": the person spoken to. */
export function addressedIn(ts: Token[], m: Mention): boolean {
  return ADDRESSEE_MARKERS.has(wordBefore(ts, m) ?? '');
}

/**
 * Where one of `phrases` starts as words with nothing but spaces between them. `clauseEnd`: only
 * at the end of a clause ("Tom left.", never "Tom left the bread").
 */
export function phrasesAt(ts: Token[], phrases: string[][], clauseEnd = false): number[] {
  const words = ts.map((t) => t.text.toLowerCase());
  return words.flatMap((word, i) =>
    phrases.some((phrase) => {
      const next = ts[i + phrase.length];
      return (
        phrase[0] === word &&
        phrase.every((w, k) => k === 0 || (words[i + k] === w && !ts[i + k]!.punctBefore)) &&
        (!clauseEnd || !next || !!next.punctBefore)
      );
    })
      ? [i]
      : [],
  );
}

/**
 * Whether the word at `k` is a name rather than the word it spells ("May", "Will", "Hope"):
 * capitalised, past a sentence's first word or a mention of its own there ("May didn’t get home",
 * not "Had Anne not come").
 */
export function nameAt(ts: Token[], k: number, mentions: Mention[]): boolean {
  const t = ts[k];
  return (
    !!t &&
    !LOWER.test(t.text) &&
    (!t.sentenceStart || mentions.some((y) => y.first === k && y.last === k))
  );
}
