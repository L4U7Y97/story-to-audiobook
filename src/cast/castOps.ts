import type { Analysis, Character, Lang, Segment, Traits } from '@/format/types';
import { isDefaultName, NARRATOR_NAME, normaliseName } from '@/analysis/castMatch';
import { tellerOf } from '@/analysis/reassign';
import { clashesWithNarrator, repickVoice, spokenVoiceName } from '@/cast/assignVoices';
import { cleanTraits, fillTraits, inferTraits, TRAIT_KEYS, withTraits } from '@/cast/traits';
import type { DeviceVoice } from '@/playback/engine';

export type CastOpResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Merges character `fromId` into `intoId`: every line spoken by `from` in any analysis becomes
 * `into`'s, and `from`'s name and aliases become aliases of `into`. `into` keeps its traits and
 * takes the ones it lacks from `from` (the unknown speaker never has any); its voice stays as it
 * is. The narrator and the unknown speaker are never removed (the analysers need them): merging
 * them moves their lines as user corrections, so a re-analysis keeps the move. The narrator also
 * hands the names it was given to `into` and goes back to `defaultNarratorName`
 * (NARRATOR_NAME[story.lang]); the unknown speaker keeps its names.
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
  const renamed: Character = {
    ...into,
    aliases: dedupe([...into.aliases, ...newAliases]).filter((a) => !sameName(a, into.name)),
  };
  // The unknown speaker has no traits to give or to take.
  const traitless = into.role === 'unknown' || from.role === 'unknown';
  const merged = traitless ? renamed : fillTraits(renamed, from);
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

/**
 * Sets or clears (undefined) traits of member `id`. Its voice is picked again to match unless it
 * was set by hand (voice.manual). Nothing actually changing gives the same cast (the array that
 * was passed in), repicked false. The unknown speaker has no traits, so it is refused. When the
 * narrator's new voice or pitch comes too near to characters (the same voice within 0.05 of its
 * pitch, or the very same voice, pitch and rate), those not voiced by hand are picked again too.
 */
export function setTraits(
  cast: Character[],
  id: string,
  changes: { [K in keyof Traits]?: Traits[K] | undefined },
  deviceVoices: readonly DeviceVoice[],
  locale: string,
): CastOpResult<{ cast: Character[]; repicked: boolean }> {
  const character = cast.find((c) => c.id === id);
  if (!character) return { ok: false, reason: 'character not found' };
  if (character.role === 'unknown') {
    return { ok: false, reason: 'the unknown speaker has no traits' };
  }

  const changed = withTraits(character, changes);
  const [before, after] = [cleanTraits(character), cleanTraits(changed)];
  if (TRAIT_KEYS.every((key) => before[key] === after[key])) {
    return { ok: true, value: { cast, repicked: false } };
  }
  const repicked = !character.voice.manual;
  const updated = repicked
    ? { ...changed, voice: repickVoice(changed, cast, deviceVoices, locale) }
    : changed;
  const updatedCast = cast.map((c) => (c.id === id ? updated : c));
  return {
    ok: true,
    value: {
      cast: repicked ? clearOfNarrator(updatedCast, character, deviceVoices, locale) : updatedCast,
      repicked,
    },
  };
}

/**
 * Picks the voice of member `id` again from its traits, also when it was set by hand. When that
 * moves the narrator, the characters left too near it are picked again as well (see setTraits).
 */
export function repickMember(
  cast: readonly Character[],
  id: string,
  deviceVoices: readonly DeviceVoice[],
  locale: string,
): CastOpResult<Character[]> {
  const character = cast.find((c) => c.id === id);
  if (!character) return { ok: false, reason: 'character not found' };
  const voice = repickVoice(character, cast, deviceVoices, locale);
  const updatedCast = cast.map((c) => (c.id === id ? { ...c, voice } : c));
  return { ok: true, value: clearOfNarrator(updatedCast, character, deviceVoices, locale) };
}

/**
 * After the voice of `before` was picked again: when it is the narrator and the voice it really
 * speaks with or its pitch changed, every character that can no longer be told from it
 * (clashesWithNarrator) gets its voice picked again, in cast order, each seeing the narrator and
 * the picks before it. Voices set by hand stay as they are, and no traits are guessed.
 */
function clearOfNarrator(
  cast: Character[],
  before: Character,
  deviceVoices: readonly DeviceVoice[],
  locale: string,
): Character[] {
  const narrator = cast.find((c) => c.id === before.id);
  if (!narrator || narrator.role !== 'narrator') return cast;
  const moved =
    spokenVoiceName(narrator.voice, deviceVoices) !== spokenVoiceName(before.voice, deviceVoices) ||
    narrator.voice.pitch !== before.voice.pitch;
  // A clash that was there before is the user's to settle ("Match voices to traits").
  if (!moved) return cast;

  const out = [...cast];
  out.forEach((c, i) => {
    if (c.role !== 'character' || c.voice.manual) return;
    if (!clashesWithNarrator(c.voice, narrator.voice, deviceVoices)) return;
    out[i] = { ...c, voice: repickVoice(c, out, deviceVoices, locale) };
  });
  return out;
}

/**
 * Matches every character's voice to its traits. For each member with role 'character', in cast
 * order: the traits it lacks are guessed from its name and aliases (inferTraits, fill-only), then,
 * unless its voice was set by hand, the voice is picked again seeing the narrator, the unknown
 * speaker, the hand-voiced characters and the characters handled before it. The narrator and the
 * unknown speaker are untouched.
 */
export function matchVoicesToTraits(
  cast: readonly Character[],
  deviceVoices: readonly DeviceVoice[],
  locale: string,
  lang: Lang,
): Character[] {
  // The voices that stay: each pick avoids them, and the picks made before it.
  const seen = cast.filter((c) => c.role !== 'character' || c.voice.manual);
  return cast.map((c) => {
    if (c.role !== 'character') return c;
    const filled = fillTraits(c, inferTraits([c.name, ...c.aliases], lang));
    if (filled.voice.manual) return filled;
    const matched = { ...filled, voice: repickVoice(filled, seen, deviceVoices, locale) };
    seen.push(matched);
    return matched;
  });
}

/** Lines per character across analyses; characters with none are "unused". */
export function castUsage(analyses: ReadonlyArray<Analysis | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of analyses) {
    for (const s of a?.segments ?? []) counts.set(s.speakerId, (counts.get(s.speakerId) ?? 0) + 1);
  }
  return counts;
}

/** Where a member's line is: its part, its index in that part's analysis, and the segment. */
export interface LineRef {
  partId: string;
  index: number;
  segment: Segment;
}

/** Every line `id` reads, in story order (analyses in part order, then segment order). */
export function linesOf(analyses: ReadonlyArray<Analysis | undefined>, id: string): LineRef[] {
  const out: LineRef[] = [];
  for (const a of analyses) {
    a?.segments.forEach((segment, index) => {
      if (segment.speakerId === id) out.push({ partId: a.partId, index, segment });
    });
  }
  return out;
}

/** How many of the analysed parts `id` tells, i.e. reads most of the narration of (tellerOf). */
export function partsToldBy(
  analyses: ReadonlyArray<Analysis | undefined>,
  id: string,
  narratorId: string,
): number {
  return analyses.filter((a) => a && tellerOf(a.segments, narratorId) === id).length;
}

/** Folds case, accents and curly apostrophes, so "jose" finds "José" and "o'b" finds "O’Brien". */
function searchKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The members whose name or one of whose other names contains `query`, in the order given;
 * everyone when the query is blank. With no such member, the one a name typed as `query` would
 * go to (findTypedNameOwner: "Mr. Darcy" is "Mr Darcy", "Narrator" is the narrator), if any.
 */
export function filterCast(
  cast: readonly Character[],
  query: string,
  narratorId = cast.find((c) => c.role === 'narrator')?.id ?? '',
): Character[] {
  const q = searchKey(query);
  if (!q) return [...cast];
  const found = cast.filter((c) => [c.name, ...c.aliases].some((n) => searchKey(n).includes(q)));
  if (found.length) return found;
  const owner = findTypedNameOwner(cast, query, narratorId);
  return owner ? [owner] : [];
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
