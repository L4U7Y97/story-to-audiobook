import type { Analysis, Character } from '@/format/types';

export type CastOpResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Merges character `fromId` into `intoId`: every line spoken by `from` in any analysis becomes
 * `into`'s, and `from`'s name and aliases become aliases of `into`. The narrator and the unknown
 * speaker are never removed (the analysers need them): merging them only moves their lines.
 */
export function mergeCharacters(
  cast: readonly Character[],
  analyses: readonly Analysis[],
  fromId: string,
  intoId: string,
): CastOpResult<{ cast: Character[]; analyses: Analysis[] }> {
  if (fromId === intoId) return { ok: false, reason: 'cannot merge a character into itself' };
  const from = cast.find((c) => c.id === fromId);
  const into = cast.find((c) => c.id === intoId);
  if (!from || !into) return { ok: false, reason: 'character not found' };

  const keepFrom = from.role !== 'character';
  const newAliases = keepFrom ? [] : [from.name, ...from.aliases];
  const merged: Character = {
    ...into,
    aliases: dedupe([...into.aliases, ...newAliases]).filter((a) => !sameName(a, into.name)),
    gender: into.gender ?? from.gender,
  };
  const updatedCast = cast
    .filter((c) => keepFrom || c.id !== fromId)
    .map((c) => (c.id === intoId ? merged : c));

  const updatedAnalyses = analyses.map((a) =>
    a.segments.some((s) => s.speakerId === fromId)
      ? {
          ...a,
          segments: a.segments.map((s) =>
            s.speakerId === fromId ? { ...s, speakerId: intoId } : s,
          ),
        }
      : a,
  );
  return { ok: true, value: { cast: updatedCast, analyses: updatedAnalyses } };
}

export function renameCharacter(
  cast: readonly Character[],
  id: string,
  name: string,
): CastOpResult<Character[]> {
  const trimmed = name.trim().replace(/\s+/gu, ' ');
  if (!trimmed) return { ok: false, reason: 'name cannot be empty' };
  const character = cast.find((c) => c.id === id);
  if (!character) return { ok: false, reason: 'character not found' };
  // The old name stays findable as an alias so later analyses still match it.
  const aliases =
    character.role === 'character' && !sameName(character.name, trimmed)
      ? dedupe([...character.aliases, character.name])
      : character.aliases;
  return {
    ok: true,
    value: cast.map((c) =>
      c.id === id
        ? { ...c, name: trimmed, aliases: aliases.filter((a) => !sameName(a, trimmed)) }
        : c,
    ),
  };
}

/** Parses a comma-separated alias list ("Liz, Lizzy, Miss Bennet"). */
export function parseAliases(input: string, name: string): string[] {
  return dedupe(
    input
      .split(',')
      .map((a) => a.trim().replace(/\s+/gu, ' '))
      .filter((a) => a && !sameName(a, name)),
  );
}

export function setAliases(
  cast: readonly Character[],
  id: string,
  aliases: string[],
): CastOpResult<Character[]> {
  if (!cast.some((c) => c.id === id)) return { ok: false, reason: 'character not found' };
  return { ok: true, value: cast.map((c) => (c.id === id ? { ...c, aliases } : c)) };
}

/** Lines per character across analyses; characters with none are "unused". */
export function castUsage(analyses: ReadonlyArray<Analysis | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of analyses) {
    for (const s of a?.segments ?? []) counts.set(s.speakerId, (counts.get(s.speakerId) ?? 0) + 1);
  }
  return counts;
}

function sameName(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = n.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
