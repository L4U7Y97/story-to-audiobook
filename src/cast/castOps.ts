import type { Analysis, Character } from '@/format/types';
import { isDefaultName, NARRATOR_NAME, normaliseName } from '@/analysis/castMatch';
import { tellerOf } from '@/analysis/reassign';

export type CastOpResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Merges character `fromId` into `intoId`: every line spoken by `from` in any analysis becomes
 * `into`'s, and `from`'s name and aliases become aliases of `into`. The narrator and the unknown
 * speaker are never removed (the analysers need them): merging them moves their lines as user
 * corrections, so a re-analysis keeps the move. The narrator also hands the names it was given
 * to `into` and goes back to `defaultNarratorName` (NARRATOR_NAME[story.lang]); the unknown
 * speaker keeps its names.
 */
export function mergeCharacters(
  cast: readonly Character[],
  analyses: readonly Analysis[],
  fromId: string,
  intoId: string,
  defaultNarratorName: string = NARRATOR_NAME.en,
): CastOpResult<{ cast: Character[]; analyses: Analysis[] }> {
  if (fromId === intoId) return { ok: false, reason: 'cannot merge a character into itself' };
  const from = cast.find((c) => c.id === fromId);
  const into = cast.find((c) => c.id === intoId);
  if (!from || !into) return { ok: false, reason: 'character not found' };

  const keepFrom = from.role !== 'character';
  const newAliases =
    from.role === 'unknown'
      ? []
      : [from.name, ...from.aliases].filter((n) => !isDefaultName(n, from.role));
  const merged: Character = {
    ...into,
    aliases: dedupe([...into.aliases, ...newAliases]).filter((a) => !sameName(a, into.name)),
    gender: into.gender ?? from.gender,
  };
  const remaining =
    from.role === 'narrator' ? { ...from, name: defaultNarratorName, aliases: [] } : from;
  const updatedCast = cast
    .filter((c) => keepFrom || c.id !== fromId)
    .map((c) => (c.id === intoId ? merged : c.id === fromId ? remaining : c));

  const updatedAnalyses = analyses.map((a) =>
    a.segments.some((s) => s.speakerId === fromId)
      ? {
          ...a,
          segments: a.segments.map((s) =>
            s.speakerId === fromId
              ? { ...s, speakerId: intoId, source: keepFrom ? 'user' : s.source }
              : s,
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
  // The old name stays findable as an alias so later analyses still match it. A default name
  // ("Narrator", "Unknown speaker") was never anyone's real name, and renaming to one un-names,
  // so the old name is dropped then too. The unknown speaker is matched only by names merged into
  // it, so its old names are never kept.
  const keepOld =
    character.role !== 'unknown' &&
    !isDefaultName(character.name, character.role) &&
    !isDefaultName(trimmed, character.role) &&
    !sameName(character.name, trimmed);
  const aliases = keepOld ? dedupe([...character.aliases, character.name]) : character.aliases;
  return {
    ok: true,
    value: cast.map((c) =>
      c.id === id
        ? { ...c, name: trimmed, aliases: aliases.filter((a) => !sameName(a, trimmed)) }
        : c,
    ),
  };
}

/**
 * The first member other than `exceptId` already called `name`, by name or alias (compared with
 * normaliseName). Default names ("Narrator", "Unknown speaker") belong to nobody.
 */
export function findNameOwner(
  cast: readonly Character[],
  name: string,
  exceptId?: string,
): Character | undefined {
  const wanted = normaliseName(name);
  if (!wanted) return undefined;
  return cast.find(
    (c) =>
      c.id !== exceptId &&
      [c.name, ...c.aliases].some((n) => !isDefaultName(n, c.role) && normaliseName(n) === wanted),
  );
}

/**
 * Who a name the user types for someone (a rename, a new character) refers to: findNameOwner, or
 * the narrator for its default name ("Narrator", "Narrador"), whatever it is called now. The
 * unknown speaker's default name stays free ("Desconocido" can be a character's name).
 */
export function findTypedNameOwner(
  cast: readonly Character[],
  name: string,
  narratorId: string,
  exceptId?: string,
): Character | undefined {
  const owner = findNameOwner(cast, name, exceptId);
  if (owner || narratorId === exceptId || !isDefaultName(name, 'narrator')) return owner;
  return cast.find((c) => c.id === narratorId);
}

/**
 * The first name in an edit of member `id` (its new name, then its other names) that another
 * member already has, and who has it. The new name is read as typed (findTypedNameOwner), the
 * other names as findNameOwner reads them. So that a clash saved earlier never blocks an edit,
 * the member's current name and the other names it already has are skipped. A new name is
 * checked even if it is one of those other names, or two members could end up with one name.
 */
export function findNameClash(
  cast: readonly Character[],
  id: string,
  changes: { name: string; aliases: readonly string[] },
  narratorId: string,
): { name: string; owner: Character } | undefined {
  const character = cast.find((c) => c.id === id);
  if (!character) return undefined;
  const nameOwner = sameName(changes.name, character.name)
    ? undefined
    : findTypedNameOwner(cast, changes.name, narratorId, id);
  if (nameOwner) return { name: changes.name, owner: nameOwner };
  const own = new Set([character.name, ...character.aliases].map((n) => normaliseName(n)));
  for (const alias of changes.aliases) {
    const owner = own.has(normaliseName(alias)) ? undefined : findNameOwner(cast, alias, id);
    if (owner) return { name: alias, owner };
  }
  return undefined;
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

/** How many of the analysed parts `id` tells, i.e. reads most of the narration of (tellerOf). */
export function partsToldBy(
  analyses: ReadonlyArray<Analysis | undefined>,
  id: string,
  narratorId: string,
): number {
  return analyses.filter((a) => a && tellerOf(a.segments, narratorId) === id).length;
}

function sameName(a: string, b: string): boolean {
  return normaliseName(a) === normaliseName(b);
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = normaliseName(n);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
