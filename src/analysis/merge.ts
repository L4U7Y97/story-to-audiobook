import { cleanTraits } from '@/cast/traits';
import type { Character, Segment } from '@/format/types';
import type { LabelResult, SpanLabel } from './labels';

export interface MergeResult {
  segments: Segment[];
  /** The story cast with new characters (without voices yet) and alias additions applied. */
  cast: Array<Character | Omit<Character, 'voice'>>;
  /** Ids of the characters this analysis created. */
  newCharacterIds: string[];
}

/**
 * Turns analyser labels into stored segments: gives new characters real ids (with the traits the
 * analyser found), applies alias additions to existing characters, and joins adjacent spans with
 * the same speaker, mode and tone within a paragraph (segments never run across a paragraph break).
 */
export function mergeLabels(
  text: string,
  result: LabelResult,
  cast: readonly Character[],
  partId: string,
  newId: () => string,
): MergeResult {
  const ids = new Map(result.newCharacters.map((c) => [c.ref, newId()]));
  const created = result.newCharacters.map((c) => ({
    id: ids.get(c.ref)!,
    role: 'character' as const,
    name: c.name,
    aliases: [...new Set(c.aliases.filter((a) => a !== c.name))],
    // Only the traits that are set, so that a missing one never becomes a stored undefined.
    ...cleanTraits(c),
    ...(c.description ? { description: c.description } : {}),
    firstSeenPartId: partId,
  }));

  const updated = cast.map((c) => {
    const added = result.aliasAdditions
      .filter((a) => a.characterId === c.id)
      .map((a) => a.alias)
      .filter((a) => a !== c.name && !c.aliases.includes(a));
    return added.length ? { ...c, aliases: [...c.aliases, ...new Set(added)] } : c;
  });

  const speakerId = (span: SpanLabel) =>
    span.speaker.kind === 'cast' ? span.speaker.id : ids.get(span.speaker.ref)!;

  const segments: Segment[] = [];
  for (const span of result.spans) {
    const segment: Segment = {
      start: span.start,
      end: span.end,
      speakerId: speakerId(span),
      mode: span.mode,
      ...(span.tone ? { tone: span.tone } : {}),
      source: span.source,
    };
    const last = segments.at(-1);
    const atParagraphBreak = last !== undefined && text[last.end - 1] === '\n';
    if (last && !atParagraphBreak && sameVoice(last, segment)) last.end = segment.end;
    else segments.push(segment);
  }

  return { segments, cast: [...updated, ...created], newCharacterIds: created.map((c) => c.id) };
}

function sameVoice(a: Segment, b: Segment): boolean {
  return (
    a.speakerId === b.speakerId &&
    a.mode === b.mode &&
    a.source === b.source &&
    a.tone?.label === b.tone?.label &&
    a.tone?.intensity === b.tone?.intensity
  );
}
