import type { Gender } from '@/format/types';

/** A character as the analysers see it: existing cast members and ones found during analysis. */
export interface CastEntry {
  key: string;
  name: string;
  aliases: string[];
  gender?: Gender;
  role: 'narrator' | 'character' | 'unknown';
}

const TITLE =
  /^(Mr\.?|Mrs\.?|Miss|Ms\.?|Dr\.?|Lady|Lord|Sir|Don|Doña|Sr\.|Sra\.|Srta\.|Señor|Señora|Señorita)\s+/u;

export function normaliseName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(/[.,;:!?]+$/u, '')
    .trim()
    .toLowerCase();
}

function hasTitle(name: string): boolean {
  return TITLE.test(name);
}

function lastWord(name: string): string {
  return normaliseName(name).split(' ').at(-1) ?? '';
}

/**
 * Finds the cast entry a name refers to:
 * 1. exact match on name or alias (case-insensitive);
 * 2. an untitled single word matching the last word of exactly one multi-word name ("Golfín" →
 *    "Teodoro Golfín"), or a longer untitled name whose last word is exactly one single-word
 *    name ("Teodoro Golfín" → "Golfín"). Titled names ("Mr. Bennet" vs "Mrs. Bennet") never
 *    match partially.
 */
export function matchCast(name: string, cast: readonly CastEntry[]): CastEntry | undefined {
  const wanted = normaliseName(name);
  const candidates = cast.filter((c) => c.role === 'character');
  const exact = candidates.find((c) =>
    [c.name, ...c.aliases].some((n) => normaliseName(n) === wanted),
  );
  if (exact || hasTitle(name)) return exact;

  const words = wanted.split(' ');
  const partial = candidates.filter((c) =>
    [c.name, ...c.aliases].some((n) => {
      const other = normaliseName(n).split(' ');
      if (hasTitle(n) || other.length === words.length) return false;
      return words.length === 1
        ? lastWord(n) === wanted
        : other.length === 1 && other[0] === words.at(-1);
    }),
  );
  return partial.length === 1 ? partial[0] : undefined;
}
