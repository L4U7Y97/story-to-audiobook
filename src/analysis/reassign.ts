import type { Mode, Segment } from '@/format/types';

/**
 * Gives segment `index` a new speaker (and optionally mode), marked as a user correction, then
 * joins it with neighbours in the same paragraph that now sound the same.
 * Without an explicit mode: the narrator reads narration, and a character taking over narration
 * speaks it; otherwise the mode is kept.
 */
export function reassignSegment(
  text: string,
  segments: readonly Segment[],
  index: number,
  speakerId: string,
  narratorId: string,
  mode?: Mode,
): Segment[] {
  const target = segments[index];
  if (!target) return [...segments];
  const nextMode: Mode =
    mode ??
    (speakerId === narratorId ? 'narration' : target.mode === 'narration' ? 'speech' : target.mode);
  const updated: Segment = { ...withoutTone(target), speakerId, mode: nextMode, source: 'user' };
  return coalesce(
    text,
    segments.map((s, i) => (i === index ? updated : s)),
  );
}

/**
 * Re-applies earlier user corrections to a fresh analysis of the same text: every new segment
 * that lies inside a range the user corrected takes the user's speaker and mode.
 */
export function applyUserCorrections(
  text: string,
  fresh: readonly Segment[],
  previous: readonly Segment[],
  validSpeakers: ReadonlySet<string>,
): Segment[] {
  const corrections = previous.filter((s) => s.source === 'user' && validSpeakers.has(s.speakerId));
  if (corrections.length === 0) return [...fresh];
  const applied = fresh.map((s) => {
    const c = corrections.find((u) => u.start <= s.start && s.end <= u.end);
    if (!c) return s;
    return { ...withoutTone(s), speakerId: c.speakerId, mode: c.mode, source: 'user' as const };
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
function withoutTone(s: Segment): Segment {
  const copy = { ...s };
  delete copy.tone;
  return copy;
}
