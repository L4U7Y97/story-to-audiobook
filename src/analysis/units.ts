import type { Hint } from '@/format/types';
import { VERBS } from './heuristic/lexicon';

/**
 * A unit is the smallest piece of text that gets a speaker label. Units tile the text exactly
 * (same invariants as segments) and never consist of whitespace only.
 */
export interface Unit {
  index: number;
  start: number;
  end: number;
  /** Provisional mode from punctuation alone; the analysers decide the final mode. */
  kind: UnitKind;
  /** Paragraph number, 0-based. */
  paragraph: number;
}

/** emphasis = narration covered by an emphasis hint (e.g. EPUB italics): a thought candidate. */
type UnitKind = 'narration' | 'speech' | 'emphasis';

interface Piece {
  start: number;
  end: number;
  kind: UnitKind;
  paragraph: number;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/u;
const NON_WHITESPACE = /\S/u;
const SINGLE_QUOTE_OPENERS_BEFORE = new Set(['(', '[', '{', '—', '–', '"', '“', '-']);
/** A text with a blank line in it separates paragraphs only by blank lines. */
const BLANK_LINE = /\n[^\S\n]*\n/;
/** Text that opens with a quote mark, after any whitespace: "“Hello,” she said." */
export const OPENING_QUOTE = /^\s*[“"‘']/u;

/** The speech and thought verbs of tags: "said", "asked", "thought", "whispered"… */
const TAG_VERB = `(?:${Object.keys(VERBS).join('|')})`;
/** A sentence ends right before: "She laughed. ‘…" (closing quotes and brackets may follow). */
const SENTENCE_ENDED = /[.!?…][”’"')\]]*\s+$/u;
/** A speech verb, a few more words, then a comma or colon right before: "said the old man, ‘…". */
const VERB_BEFORE = new RegExp(
  String.raw`(?<!\p{L})${TAG_VERB}(?!\p{L})[^.!?…”"]{0,30}[,:]\s*$`,
  'u',
);
/**
 * A speech verb right before, with at most "on", a pronoun or a name (maybe after "to") and an
 * -ly adverb between it and a comma or colon: "Then he said, ‘…", "Pip told her, ‘…", "he
 * declared: ‘…", "Then he went on, ‘…".
 */
const VERB_RIGHT_BEFORE = new RegExp(
  String.raw`(?<!\p{L})${TAG_VERB}(?!\p{L})(?:\s+on)?(?:\s+(?:to\s+)?(?:me|him|her|us|them|you|\p{Lu}[\p{L}’'-]*))?(?:\s+\p{Ll}+ly)?[,:]\s*$`,
  'u',
);
/** Who says a tag: a pronoun, "the old man", or a name of up to three capitalised words. */
const TAG_SUBJECT = String.raw`(?:he|she|they|I|we|you|it|(?:the|a|an|his|her|their|my|our|your)(?:\s+\p{L}+){1,3}|\p{Lu}[\p{L}’'-]*(?:\s+\p{Lu}[\p{L}’'-]*){0,2})`;
/** A tag right after a closing quote: "she thought", "Bi De asked", "said Pip". */
const TAG_AFTER = new RegExp(
  String.raw`^,?\s+(?:${TAG_SUBJECT}\s+(?:\p{Ll}+ly\s+)?${TAG_VERB}|${TAG_VERB}\s+${TAG_SUBJECT})(?!\p{L})`,
  'u',
);

/**
 * Splits text into units at paragraph breaks and quoted speech (“…”, "…", ‘…’, '…'). When the
 * text contains blank lines, only blank lines separate paragraphs (single newlines are hard
 * wraps); otherwise every newline does. Single quotes are speech only where dialogue goes (see
 * singleOpensSpeech), unless the text writes its dialogue in single quotes.
 */
export function splitUnits(text: string, hints: readonly Hint[] = []): Unit[] {
  if (text.length === 0) return [];

  const pieces: Piece[] = [];
  const separator = BLANK_LINE.test(text) ? /\n[^\S\n]*\n\s*/g : /\n\s*/g;
  const breaks = [...text.matchAll(separator)];
  const singleDialogue = dialogueInSingleQuotes(text, [
    0,
    ...breaks.map((m) => m.index + m[0].length),
  ]);
  let paragraph = 0;
  let paraStart = 0;
  for (const match of breaks) {
    pieces.push(...scanParagraph(text, paraStart, match.index, paragraph, singleDialogue));
    pieces.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: 'narration',
      paragraph,
    });
    paraStart = match.index + match[0].length;
    paragraph++;
  }
  pieces.push(...scanParagraph(text, paraStart, text.length, paragraph, singleDialogue));

  const merged = mergeBlankPieces(text, splitAtEmphasis(text, pieces, hints));
  const paragraphNumbers = new Map<number, number>();
  return merged.map((p, index) => {
    if (!paragraphNumbers.has(p.paragraph))
      paragraphNumbers.set(p.paragraph, paragraphNumbers.size);
    return { ...p, index, paragraph: paragraphNumbers.get(p.paragraph)! };
  });
}

/** Units grouped by paragraph, in order. */
export function groupByParagraph(units: readonly Unit[]): Unit[][] {
  const groups: Unit[][] = [];
  for (const u of units) {
    const group = groups.at(-1);
    if (group && group[0]!.paragraph === u.paragraph) group.push(u);
    else groups.push([u]);
  }
  return groups;
}

/**
 * Whether the text writes its dialogue in single quotes (‘Hello,’ she said.): more of its
 * paragraphs open with a single quote than with a double one. Its single quotes are then speech
 * wherever they open, like double quotes.
 */
function dialogueInSingleQuotes(text: string, paragraphStarts: number[]): boolean {
  let single = 0;
  let double = 0;
  for (const start of paragraphStarts) {
    let i = start;
    while (i < text.length && WHITESPACE.test(text[i]!)) i++;
    const quote = openingQuote(text, i, start, text.length);
    if (quote?.single) single++;
    else if (quote) double++;
  }
  return single > double;
}

interface OpenQuote {
  close: string;
  single: boolean;
}

/** Quoted speech in one paragraph. `singleDialogue`: the text writes dialogue in single quotes. */
function scanParagraph(
  text: string,
  start: number,
  end: number,
  paragraph: number,
  singleDialogue: boolean,
): Piece[] {
  const pieces: Piece[] = [];
  let open: OpenQuote | null = null;
  let pieceStart = start;
  let lead = start;
  while (lead < end && WHITESPACE.test(text[lead]!)) lead++;

  const cut = (at: number, kind: UnitKind) => {
    if (at > pieceStart) pieces.push({ start: pieceStart, end: at, kind, paragraph });
    pieceStart = at;
  };

  for (let i = start; i < end; i++) {
    const ch = text[i]!;
    if (open === null) {
      const quote = openingQuote(text, i, start, end);
      if (
        quote &&
        (!quote.single ||
          singleDialogue ||
          singleOpensSpeech(text, i, lead, start, end, quote.close))
      ) {
        cut(i, 'narration');
        open = quote;
      }
    } else if (ch === open.close && (!open.single || isClosingSingle(text, i, start, end))) {
      cut(i + 1, 'speech');
      open = null;
    }
  }
  // A quote left open at the end of a paragraph continues to its end (multi-paragraph speech
  // repeats the opening quote on each paragraph).
  cut(end, open ? 'speech' : 'narration');
  return pieces;
}

function openingQuote(text: string, i: number, start: number, end: number): OpenQuote | null {
  switch (text[i]) {
    case '“':
      return { close: '”', single: false };
    case '"':
      return { close: '"', single: false };
    case '‘':
      return isOpeningSingle(text, i, start, end) ? { close: '’', single: true } : null;
    case "'":
      return isOpeningSingle(text, i, start, end) ? { close: "'", single: true } : null;
    default:
      return null;
  }
}

/** A single quote opens speech after whitespace/an opening mark and before text (not "don't"). */
function isOpeningSingle(text: string, i: number, start: number, end: number): boolean {
  const before = i > start ? text[i - 1]! : ' ';
  const after = i + 1 < end ? text[i + 1]! : ' ';
  return (
    (WHITESPACE.test(before) || SINGLE_QUOTE_OPENERS_BEFORE.has(before)) &&
    NON_WHITESPACE.test(after)
  );
}

/** A single quote closes speech when not followed by a letter (so "don't" stays inside). */
function isClosingSingle(text: string, i: number, start: number, end: number): boolean {
  const before = i > start ? text[i - 1]! : ' ';
  const after = i + 1 < end ? text[i + 1]! : ' ';
  return !WHITESPACE.test(before) && !LETTER_OR_DIGIT.test(after);
}

/**
 * Whether the single quote at `i` opens speech, in a text whose dialogue is in double quotes.
 * There a single-quoted stretch is dialogue only where dialogue goes: at the start of its
 * paragraph (‘You are late,’ the crow said.), at the start of a sentence with a tag right after
 * it (She laughed. ‘Of course,’ she thought.), or right after a speech verb and a comma or colon
 * (Then he said, ‘Fine.’). In a paragraph a single-quoted line opens, the rest of that line may
 * come after a longer tag (‘Yes,’ said the old man, ‘and no.’). Anywhere else it is the teller's:
 * emphasis, a scare quote, a word named or a thought (a ‘quiet’ morning; He went home, ‘tired’ but
 * happy.). `lead`: where the paragraph's text starts.
 */
function singleOpensSpeech(
  text: string,
  i: number,
  lead: number,
  start: number,
  end: number,
  close: string,
): boolean {
  if (i === lead) return true;
  const before = text.slice(start, i);
  const lineOpened = text[lead] === '‘' || text[lead] === "'";
  if ((lineOpened ? VERB_BEFORE : VERB_RIGHT_BEFORE).test(before)) return true;
  if (!SENTENCE_ENDED.test(before)) return false;
  const closing = closingSingle(text, i, start, end, close);
  return closing >= 0 && TAG_AFTER.test(text.slice(closing + 1, Math.min(end, closing + 80)));
}

/** Where the single quote opened at `i` closes in its paragraph, or -1. */
function closingSingle(text: string, i: number, start: number, end: number, close: string): number {
  for (let k = i + 1; k < end; k++) {
    if (text[k] === close && isClosingSingle(text, k, start, end)) return k;
  }
  return -1;
}

/** Splits narration pieces where an emphasis hint (≥ 2 words, inside the piece) begins and ends. */
function splitAtEmphasis(text: string, pieces: Piece[], hints: readonly Hint[]): Piece[] {
  const usable = hints
    .filter((h) => h.kind === 'emphasis' && /\S\s+\S/u.test(text.slice(h.start, h.end)))
    .sort((a, b) => a.start - b.start);
  if (usable.length === 0) return pieces;

  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.kind !== 'narration') {
      out.push(piece);
      continue;
    }
    let cursor = piece.start;
    for (const h of usable) {
      if (h.start < cursor || h.end > piece.end) continue;
      if (h.start > cursor) out.push({ ...piece, start: cursor, end: h.start });
      out.push({ ...piece, start: h.start, end: h.end, kind: 'emphasis' });
      cursor = h.end;
    }
    if (cursor < piece.end) out.push({ ...piece, start: cursor, end: piece.end });
  }
  return out;
}

/**
 * Whitespace-only pieces join the previous piece (or the next one at the very start), then
 * adjacent pieces of the same kind in the same paragraph are joined.
 */
function mergeBlankPieces(text: string, pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    const blank = isBlank(text, piece);
    const last = out.at(-1);
    if (last && (blank || (last.kind === piece.kind && last.paragraph === piece.paragraph))) {
      last.end = piece.end;
    } else {
      out.push({ ...piece });
    }
  }
  return joinLeadingBlank(text, out);
}

/** Whether a stretch of the text is whitespace only. */
export function isBlank(text: string, range: { start: number; end: number }): boolean {
  return !NON_WHITESPACE.test(text.slice(range.start, range.end));
}

/**
 * Joins leading whitespace (before any spoken content) to the piece after it, the first one with
 * words in it. Changes `pieces` and returns it.
 */
export function joinLeadingBlank<T extends { start: number; end: number }>(
  text: string,
  pieces: T[],
): T[] {
  if (pieces.length > 1 && isBlank(text, pieces[0]!)) {
    pieces[1]!.start = pieces[0]!.start;
    pieces.shift();
  }
  return pieces;
}
