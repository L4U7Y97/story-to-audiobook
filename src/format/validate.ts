import type { Analysis, Part, Segment } from './types';

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const NON_WHITESPACE = /\S/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Checks the segment invariants from SPEC.md: segments tile the text exactly (sorted, contiguous,
 * non-empty, from 0 to text.length), every speaker is in the cast, and whitespace never forms a
 * segment of its own (unless the whole text is whitespace).
 */
export function validateSegments(
  text: string,
  segments: readonly Segment[],
  castIds: ReadonlySet<string>,
): ValidationResult {
  if (segments.length === 0) {
    return text.length === 0 ? { ok: true } : { ok: false, reason: 'no segments' };
  }
  if (segments[0]!.start !== 0) return { ok: false, reason: 'does not start at 0' };

  const wholeTextIsBlank = !NON_WHITESPACE.test(text);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.start >= s.end) return { ok: false, reason: `empty segment at ${i}` };
    if (i > 0 && segments[i - 1]!.end !== s.start) {
      return { ok: false, reason: `gap or overlap at ${i}` };
    }
    if (!castIds.has(s.speakerId)) {
      return { ok: false, reason: `unknown speaker ${s.speakerId} at ${i}` };
    }
    if (s.end <= text.length && !wholeTextIsBlank && !NON_WHITESPACE.test(segmentText(text, s))) {
      return { ok: false, reason: `whitespace-only segment at ${i}` };
    }
  }

  if (segments.at(-1)!.end !== text.length) {
    return { ok: false, reason: 'does not reach end of text' };
  }
  return { ok: true };
}

/** Validates an analysis against the part it claims to describe. */
export function validateAnalysis(
  part: Pick<Part, 'text' | 'textHash'>,
  analysis: Pick<Analysis, 'textHash' | 'segments'>,
  castIds: ReadonlySet<string>,
): ValidationResult {
  if (analysis.textHash !== part.textHash) return { ok: false, reason: 'stale analysis' };
  return validateSegments(part.text, analysis.segments, castIds);
}

export function segmentText(text: string, segment: Pick<Segment, 'start' | 'end'>): string {
  return text.slice(segment.start, segment.end);
}

/** Whether a piece of text has anything to say aloud (playback skips the rest). */
export function isSpeakable(text: string): boolean {
  return LETTER_OR_DIGIT.test(text);
}
