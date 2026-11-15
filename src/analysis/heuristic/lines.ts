/** A paragraph's lines: which units are speech or thought, whom each calls on, whether it asks. */

import type { Unit } from '../units';
import { COORDINATORS, ENDEARMENTS, NAME_PARTICLES, WH_WORDS } from './lexicon';
import { tokenize, verbAt } from './mentions';
import type { Lookup } from './reading';
import {
  afterPreposition,
  firstSentenceEnd,
  gluedAt,
  lastSentenceStart,
  LOWER,
  wordAt,
  type Mention,
  type Token,
} from './tokens';

const NOUN_BEFORE_THOUGHT = new Set([
  'a',
  'the',
  'his',
  'her',
  'that',
  'this',
  'my',
  'their',
  'our',
  'your',
  'no',
]);

const VOCATIVE_LEAD = new Set(['dear', 'oh', 'my']);

/**
 * A paragraph's tokens, unit by unit, and which units are lines (speech, or a thought).
 * `speech`: tokenize speech units too, which only attribution reads.
 */
export function read(
  r: Lookup,
  units: Unit[],
  speech = true,
): { tokens: Map<Unit, Token[]>; isVoiced: (u: Unit) => boolean } {
  const tokens = new Map<Unit, Token[]>();
  units.forEach((u, n) => {
    if (!speech && u.kind === 'speech') return;
    // A narration unit right after speech is a tag ("…,” said Anne"), not a new sentence.
    const startsSentence = n === 0 || units[n - 1]!.kind === 'narration';
    tokens.set(u, tokenize(r.slice(u), startsSentence));
  });
  const voiced = new Set(
    units.filter(
      (u, n) => u.kind === 'speech' || (u.kind === 'emphasis' && thoughtCueNear(units, n, tokens)),
    ),
  );
  return { tokens, isVoiced: (u) => voiced.has(u) };
}

/** An emphasis unit is a thought only next to a thought verb in the sentence it touches. */
function thoughtCueNear(units: Unit[], n: number, tokens: Map<Unit, Token[]>): boolean {
  const cue = (ts: Token[], from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (!verbAt(ts, i)?.thought) continue;
      // "the thought of", "a thought": a noun.
      const noun =
        NOUN_BEFORE_THOUGHT.has(wordAt(ts, i - 1)) || ts[i + 1]?.text.toLowerCase() === 'of';
      if (!noun) return true;
    }
    return false;
  };
  const after = units[n + 1];
  if (after?.kind === 'narration') {
    const ts = tokens.get(after)!;
    if (cue(ts, 0, firstSentenceEnd(ts))) return true;
  }
  const before = units[n - 1];
  if (before?.kind === 'narration') {
    const ts = tokens.get(before)!;
    if (cue(ts, lastSentenceStart(ts), ts.length)) return true;
  }
  return false;
}

/**
 * The names line `n` addresses ("Sit down, Anne.", "Dear Tom"), also with words of endearment or
 * the rest of a full name after them ("Come here, Anne dear."), and the first of a list ("Come
 * in, Anne and Tom."). The people addressed do not say the line.
 */
export function vocativeMentions(r: Lookup, units: Unit[], n: number, tokens: Token[]): Mention[] {
  const text = r.slice(units[n]!);
  const capital = (k: number) => gluedAt(tokens, k) && !LOWER.test(tokens[k]!.text);
  const mentions = r.cast.mentions(tokens);
  const addressed: Mention[] = [];
  for (const m of mentions) {
    if (m.kind !== 'name') continue;
    const lead = tokens[m.first - 1];
    // The rest of a full name, words of endearment ("Anne dear") and the other people of a list
    // ("Anne and Tom").
    let end = m.last;
    for (;;) {
      if (!gluedAt(tokens, end + 1)) break;
      const other = mentions.find((x) => x.first === end + 2 && x.kind === 'name');
      if (NAME_PARTICLES.has(wordAt(tokens, end + 1)) && capital(end + 2)) {
        end += 2;
        while (capital(end + 1)) end++;
      } else if (ENDEARMENTS.has(wordAt(tokens, end + 1))) end++;
      else if (COORDINATORS.has(wordAt(tokens, end + 1)) && other && gluedAt(tokens, end + 2)) {
        end = other.last;
      } else break;
    }
    const rest = (tokens[end + 1]?.punctBefore ?? text.slice(tokens[end]!.end)).trim();
    const opened =
      /[,“"]/u.test(tokens[m.first]!.punctBefore) ||
      (lead !== undefined && VOCATIVE_LEAD.has(lead.text.toLowerCase()));
    if (m.first !== 0 && !opened) continue;
    if (/^[,!?”"]/u.test(rest) || (opened && /^[.;:…]/u.test(rest))) addressed.push(m);
  }
  return addressed;
}

/**
 * For units asked about in paragraph order, by index: the characters named before each one in
 * the paragraph (narration, earlier lines' vocatives), latest first. It keeps a running list, so
 * a long paragraph is read once, and reads no further than the last unit asked about.
 */
export function namesSoFar(
  r: Lookup,
  units: Unit[],
  tokens: Map<Unit, Token[]>,
  vocatives: Map<Unit, string[]>,
): (n: number) => string[] {
  const named: string[] = [];
  let next = 0;
  return (n) => {
    for (; next < n; next++) {
      const x = units[next]!;
      const ts = tokens.get(x)!;
      const keys =
        vocatives.get(x) ??
        r.cast.keys(
          r.cast.mentions(ts).filter((m) => m.kind === 'name' && !afterPreposition(ts, m)),
        );
      // Someone named again moves to the front.
      for (const key of keys) {
        const seen = named.indexOf(key);
        if (seen !== -1) named.splice(seen, 1);
        named.unshift(key);
      }
    }
    return [...named];
  };
}

/**
 * Whether a line asks its listener something before it ends: a question inside it, but not one it
 * quotes ("He kept asking me, ‘Do you sleep well?’"), a lone question word its speaker answers
 * ("Why? Because I was tired,"), or an echo of one or two words that opens it before more of the
 * line (not "And you?", "Well?", "Is it?"). With `answered`, the question the line answers, an echo
 * repeats a word of it or is a lone pronoun ("Will you marry me?" / "Marry you? Well,", "Are you
 * coming in?" / "In? Not yet,"; not "Is that you?" / "Hungry? I made soup,"), and has no question
 * word ("Shall we go?" / "Go where? It is late," asks back). With `true` any short question there
 * is taken for one.
 */
export function asksInLine(text: string, answered?: string | true): boolean {
  const body = text
    .trim()
    .replace(/^[“"‘']+/u, '')
    .replace(/[”"’']+$/u, '')
    .replace(/‘[^‘’]*’(?!\p{L})|“[^“”]*”|"[^"]*"/gu, ' ');
  const sentences = body.split(/(?<=[?!.…])\s+/u).filter((s) => /\p{L}/u.test(s));
  const words = (s: string) =>
    s
      .split(/[^\p{L}'’]+/u)
      .filter(Boolean)
      .map((w) => w.toLowerCase());
  const leads =
    /^(?:what|why|how|who|whom|where|when|which|whose|do|does|did|is|are|am|was|were|have|has|had|can|could|will|would|shall|should|may|might|must|and|but|or|so|well|yes|eh|huh|hm+)(?:n['’]t)?$/u;
  const pronouns = /^(?:me|you|us|him|her|them|i|we)$/u;
  const minor = /^(?:the|a|an|of|to|in|on|at|for|with|it|that|this|you|me)$/u;
  const asked = typeof answered === 'string' ? words(answered) : [];
  const same = (a: string, b: string) =>
    a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));
  const echo = (w: string[]) =>
    answered === true ||
    (w.length === 1 && pronouns.test(w[0]!)) ||
    w.some((x) => (w.length === 1 || !minor.test(x)) && asked.some((y) => same(x, y)));
  return sentences.some((s, n) => {
    if (!s.includes('?')) return false;
    const w = words(s);
    const more = n + 1 < sentences.length;
    const wh = w.some((x) => WH_WORDS.has(x));
    if (answered && n === 0 && more && w.length <= 2 && !leads.test(w[0] ?? '') && !wh && echo(w)) {
      return false;
    }
    // Nor does a "can you believe it?" the line goes on from.
    const believe = ['can you believe it', 'would you believe it'];
    if (more && believe.some((p) => w.slice(-p.split(' ').length).join(' ') === p)) return false;
    const lone = w.length === 1 && WH_WORDS.has(w[0]!);
    return !(lone && more && words(sentences[n + 1]!)[0] === 'because');
  });
}
