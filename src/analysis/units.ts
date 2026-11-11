import type { Hint, Lang } from '@/format/types';

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
export type UnitKind = 'narration' | 'speech' | 'emphasis';

interface Piece {
  start: number;
  end: number;
  kind: UnitKind;
  paragraph: number;
}

const DASHES = '—―–';
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/u;
const NON_WHITESPACE = /\S/u;
const SINGLE_QUOTE_OPENERS_BEFORE = new Set(['(', '[', '{', '—', '–', '"', '“', '«', '-']);
/** A text with a blank line in it separates paragraphs only by blank lines. */
const BLANK_LINE = /\n[^\S\n]*\n/;

/**
 * Splits text into units at paragraph breaks, quoted speech (“…”, «…», "…", ‘…’, '…') and
 * dash dialogue (—Hola —dijo Ana—. ¿Vienes?). When the text contains blank lines, only blank
 * lines separate paragraphs (single newlines are hard wraps); otherwise every newline does.
 */
export function splitUnits(text: string, lang: Lang, hints: readonly Hint[] = []): Unit[] {
  if (text.length === 0) return [];

  const pieces: Piece[] = [];
  const separator = BLANK_LINE.test(text) ? /\n[^\S\n]*\n\s*/g : /\n\s*/g;
  let paragraph = 0;
  let paraStart = 0;
  // A «…» quotation the last paragraph left open (see scanQuotes).
  let open: OpenQuote | null = null;
  for (const match of text.matchAll(separator)) {
    const scanned = scanParagraph(text, paraStart, match.index, paragraph, lang, open);
    pieces.push(...scanned.pieces);
    open = scanned.open;
    pieces.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: 'narration',
      paragraph,
    });
    paraStart = match.index + match[0].length;
    paragraph++;
  }
  pieces.push(...scanParagraph(text, paraStart, text.length, paragraph, lang, open).pieces);

  const merged = mergeBlankPieces(text, splitAtEmphasis(text, pieces, hints));
  const paragraphNumbers = new Map<number, number>();
  return merged.map((p, index) => {
    if (!paragraphNumbers.has(p.paragraph))
      paragraphNumbers.set(p.paragraph, paragraphNumbers.size);
    return { ...p, index, paragraph: paragraphNumbers.get(p.paragraph)! };
  });
}

/**
 * Whether a paragraph starts at `offset`, as splitUnits splits them: only whitespace lies before
 * it, back to the start of the text or to a paragraph break (a hard wrap is not one).
 */
export function startsParagraph(text: string, offset: number): boolean {
  let from = offset;
  while (from > 0 && WHITESPACE.test(text[from - 1]!)) from--;
  if (from === 0) return true;
  const gap = text.slice(from, offset);
  return BLANK_LINE.test(text) ? BLANK_LINE.test(gap) : gap.includes('\n');
}

function scanParagraph(
  text: string,
  start: number,
  end: number,
  paragraph: number,
  lang: Lang,
  continued: OpenQuote | null,
): { pieces: Piece[]; open: OpenQuote | null } {
  if (start >= end) return { pieces: [], open: null };
  const lead = start + (text.slice(start, end).length - text.slice(start, end).trimStart().length);
  if (lang === 'es' && dashLength(text, lead, end) > 0) {
    return { pieces: scanDashDialogue(text, start, lead, end, paragraph), open: null };
  }
  return scanQuotes(text, start, lead, end, paragraph, continued);
}

/** Length of a dialogue dash at i: one of —―– or a run of two or more hyphens ("--"). */
function dashLength(text: string, i: number, end: number): number {
  if (i >= end) return 0;
  if (DASHES.includes(text[i]!)) return 1;
  let j = i;
  while (j < end && text[j] === '-') j++;
  return j - i >= 2 ? j - i : 0;
}

/**
 * Spanish dash dialogue. Every dash toggles between speech and narration (the inciso).
 * A dash that opens narration belongs to it ("—dijo Ana"). A dash that leaves narration closes it
 * ("Ana—") unless it is preceded by whitespace and followed by text, which opens new speech.
 */
function scanDashDialogue(
  text: string,
  start: number,
  lead: number,
  end: number,
  paragraph: number,
): Piece[] {
  const pieces: Piece[] = [];
  let kind: UnitKind = 'speech';
  let pieceStart = start;
  let i = lead + dashLength(text, lead, end);

  const cut = (at: number, next: UnitKind) => {
    if (at > pieceStart) pieces.push({ start: pieceStart, end: at, kind, paragraph });
    pieceStart = at;
    kind = next;
  };

  while (i < end) {
    const len = dashLength(text, i, end);
    if (len === 0) {
      i++;
      continue;
    }
    if (kind === 'speech') {
      cut(i, 'narration');
    } else {
      const before = i === start ? ' ' : text[i - 1]!;
      const after = i + len < end ? text[i + len]! : ' ';
      const opensSpeech = WHITESPACE.test(before) && !WHITESPACE.test(after);
      cut(opensSpeech ? i : i + len, 'speech');
    }
    i += len;
  }
  cut(end, kind);
  return pieces;
}

interface OpenQuote {
  close: string;
  single: boolean;
}

/**
 * Quoted speech in one paragraph. `continued` is a «…» quotation the paragraph before left open:
 * a paragraph starting with "»" carries it on (Spanish comillas de seguir). Returns the «…»
 * quotation this paragraph leaves open, if any.
 */
function scanQuotes(
  text: string,
  start: number,
  lead: number,
  end: number,
  paragraph: number,
  continued: OpenQuote | null,
): { pieces: Piece[]; open: OpenQuote | null } {
  const pieces: Piece[] = [];
  const continues = continued?.close === '»' && text[lead] === '»';
  let open: OpenQuote | null = continues ? continued : null;
  let pieceStart = start;

  const cut = (at: number, kind: UnitKind) => {
    if (at > pieceStart) pieces.push({ start: pieceStart, end: at, kind, paragraph });
    pieceStart = at;
  };

  for (let i = continues ? lead + 1 : start; i < end; i++) {
    const ch = text[i]!;
    if (open === null) {
      const quote = openingQuote(text, i, start, end);
      if (quote) {
        cut(i, 'narration');
        open = quote;
      }
    } else if (ch === open.close && (!open.single || isClosingSingle(text, i, start, end))) {
      cut(i + 1, 'speech');
      open = null;
    }
  }
  // A quote left open at the end of a paragraph continues to its end (multi-paragraph speech
  // repeats the opening quote on each paragraph, or opens it with "»").
  cut(end, open ? 'speech' : 'narration');
  return { pieces, open: open?.close === '»' ? open : null };
}

function openingQuote(text: string, i: number, start: number, end: number): OpenQuote | null {
  switch (text[i]) {
    case '“':
      return { close: '”', single: false };
    case '«':
      return { close: '»', single: false };
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
    const blank = !NON_WHITESPACE.test(text.slice(piece.start, piece.end));
    const last = out.at(-1);
    if (last && (blank || (last.kind === piece.kind && last.paragraph === piece.paragraph))) {
      last.end = piece.end;
    } else {
      out.push({ ...piece });
    }
  }
  // Leading whitespace (before any spoken content) joins the first non-blank piece.
  if (out.length > 1 && !NON_WHITESPACE.test(text.slice(out[0]!.start, out[0]!.end))) {
    const [first, second] = out as [Piece, Piece];
    second.start = first.start;
    out.shift();
  }
  return out;
}
