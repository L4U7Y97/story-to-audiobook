import type { Mode, Segment } from '@/format/types';
import { startsParagraph } from './units';

/**
 * Which lines a manual change covers: the tapped line; it and the later lines of its speaker;
 * every line of its speaker in the part ('Told by'); or its speaker's lines between the tapped
 * line and segment `through`, in either order.
 */
export type ReassignScope = 'line' | 'following' | 'part' | { through: number };

export interface ReassignOptions {
  narratorId: string;
  /** Scope 'line' only. Undefined = defaultMode. */
  mode?: Mode;
  /** Defaults to 'line'. */
  scope?: ReassignScope;
}

const NON_WHITESPACE = /\S/u;
/** Quote marks that open speech, including the Spanish » that reopens it in a new paragraph. */
const OPENING_QUOTE = /^[“«»"‘']/u;
const DIALOGUE_DASH = /^(?:--|[—―–])/u;

/**
 * Gives segment `index` to `speakerId` as a user correction, then joins neighbours in the same
 * paragraph that now sound the same. Wider scopes move only the lines of the tapped line's old
 * speaker and keep each line's mode, so a new teller narrates the narration and speaks the lines.
 */
export function reassignSegments(
  text: string,
  segments: readonly Segment[],
  index: number,
  speakerId: string,
  { narratorId, mode, scope = 'line' }: ReassignOptions,
): Segment[] {
  const target = segments[index];
  if (!target) return [...segments];
  if (scope === 'line') {
    const lineMode = mode ?? defaultMode(text, segments, index, speakerId, narratorId);
    const updated = corrected(target, speakerId, lineMode);
    return coalesce(
      text,
      segments.map((s, i) => (i === index ? updated : s)),
    );
  }
  const [first, last] = scopeRange(segments.length, index, scope);
  return coalesce(
    text,
    segments.map((s, i) =>
      i >= first && i <= last && s.speakerId === target.speakerId
        ? corrected(s, speakerId, s.mode)
        : s,
    ),
  );
}

/** reassignSegments with scope 'line'. */
export function reassignSegment(
  text: string,
  segments: readonly Segment[],
  index: number,
  speakerId: string,
  narratorId: string,
  mode?: Mode,
): Segment[] {
  return reassignSegments(text, segments, index, speakerId, { narratorId, mode });
}

/**
 * The mode a line gets when it is given to `speakerId` without an explicit choice: how it reads
 * for anyone (modeForAnyone). Other narration stays narration for the narrator or for someone who
 * already narrates in the part; anyone else speaks it (the analyser missed unquoted speech).
 */
export function defaultMode(
  text: string,
  segments: readonly Segment[],
  index: number,
  speakerId: string,
  narratorId: string,
): Mode {
  const narrates =
    speakerId === narratorId ||
    segments.some((s) => s.speakerId === speakerId && s.mode === 'narration');
  return modeForAnyone(text, segments, index) ?? (narrates ? 'narration' : 'speech');
}

/**
 * How line `index` reads whoever it is given to: speech, thoughts and writing keep their mode,
 * and narration that opens like dialogue (a quote mark, or a dash starting its paragraph) is
 * speech. Undefined for other narration, which depends on who reads it (see defaultMode).
 */
export function modeForAnyone(
  text: string,
  segments: readonly Segment[],
  index: number,
): Mode | undefined {
  const target = segments[index];
  if (!target) return undefined;
  if (target.mode !== 'narration') return target.mode;
  return opensLikeDialogue(text, target) ? 'speech' : undefined;
}

/**
 * Who tells these segments: the speaker with the most narration. Ties, and segments without
 * narration, go to the narrator; between other speakers, to the one who narrates first.
 */
export function tellerOf(segments: readonly Segment[], narratorId: string): string {
  const narrated = new Map<string, number>([[narratorId, 0]]);
  for (const s of segments) {
    if (s.mode !== 'narration') continue;
    narrated.set(s.speakerId, (narrated.get(s.speakerId) ?? 0) + s.end - s.start);
  }
  let teller = narratorId;
  let most = 0;
  for (const [id, length] of narrated) {
    if (length > most) {
      teller = id;
      most = length;
    }
  }
  return teller;
}

/**
 * Re-applies earlier user corrections to a fresh analysis of the same text. Fresh segments are
 * cut at the corrected ranges' edges, so a correction survives a fresh segment that runs past it;
 * each piece whose words lie inside a corrected range takes the user's speaker and mode.
 */
export function applyUserCorrections(
  text: string,
  fresh: readonly Segment[],
  previous: readonly Segment[],
  validSpeakers: ReadonlySet<string>,
): Segment[] {
  const corrections = previous.filter((s) => s.source === 'user' && validSpeakers.has(s.speakerId));
  if (corrections.length === 0) return [...fresh];
  const edges = [...new Set(corrections.flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
  const applied = cutAt(text, fresh, edges).map((piece) => {
    const [from, to] = wordsOf(text, piece);
    const c = corrections.find((u) => u.start <= from && to <= u.end);
    return c ? corrected(piece, c.speakerId, c.mode) : piece;
  });
  return coalesce(text, applied);
}

/** Joins adjacent segments with the same voice, never across a paragraph break. */
export function coalesce(text: string, segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    const last = out.at(-1);
    if (
      last &&
      text[last.end - 1] !== '\n' &&
      last.speakerId === s.speakerId &&
      last.mode === s.mode &&
      last.source === s.source &&
      last.tone?.label === s.tone?.label
    ) {
      out[out.length - 1] = { ...last, end: s.end };
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** A corrected line loses the analyser's tone guess, which belonged to the old speaker. */
function corrected(s: Segment, speakerId: string, mode: Mode): Segment {
  const copy: Segment = { ...s, speakerId, mode, source: 'user' };
  delete copy.tone;
  return copy;
}

/** The first and last segment index a scope wider than one line can change. */
function scopeRange(
  count: number,
  index: number,
  scope: Exclude<ReassignScope, 'line'>,
): [number, number] {
  if (scope === 'part') return [0, count - 1];
  if (scope === 'following') return [index, count - 1];
  return [Math.min(index, scope.through), Math.max(index, scope.through)];
}

/**
 * Narration that starts with a quote mark, or with a dash at the start of its paragraph (as
 * splitUnits finds paragraphs). A dash after speech in the same paragraph opens the narration of
 * an inciso ('—Hola —dijo Ana.'), also when a hard wrap puts it at the start of a line.
 */
function opensLikeDialogue(text: string, s: Segment): boolean {
  const body = text.slice(s.start, s.end).trimStart();
  if (OPENING_QUOTE.test(body)) return true;
  return DIALOGUE_DASH.test(body) && startsParagraph(text, s.end - body.length);
}

/**
 * Cuts segments at the given sorted offsets. A piece of whitespace only joins the piece before
 * it (or the next one at the very start), so no piece is left without words.
 */
function cutAt(text: string, segments: readonly Segment[], edges: readonly number[]): Segment[] {
  const pieces: Segment[] = [];
  let k = 0;
  for (const s of segments) {
    while (k < edges.length && edges[k]! <= s.start) k++;
    const cuts = [s.start];
    while (k < edges.length && edges[k]! < s.end) cuts.push(edges[k++]!);
    cuts.push(s.end);
    for (let i = 1; i < cuts.length; i++) {
      const piece: Segment = { ...s, start: cuts[i - 1]!, end: cuts[i]! };
      const last = pieces.at(-1);
      if (last && isBlank(text, piece)) last.end = piece.end;
      else pieces.push(piece);
    }
  }
  if (pieces.length > 1 && isBlank(text, pieces[0]!)) {
    const [first, second] = pieces as [Segment, Segment];
    second.start = first.start;
    pieces.shift();
  }
  return pieces;
}

/** The stretch from a segment's first to its last non-whitespace character (all of it if blank). */
function wordsOf(text: string, s: Segment): [number, number] {
  const body = text.slice(s.start, s.end);
  const from = s.start + body.length - body.trimStart().length;
  const to = s.end - (body.length - body.trimEnd().length);
  return from < to ? [from, to] : [s.start, s.end];
}

function isBlank(text: string, s: Segment): boolean {
  return !NON_WHITESPACE.test(text.slice(s.start, s.end));
}
