import type { Gender } from '@/format/types';
import { TITLES } from './heuristic/lexicon';

/** A character as the analysers see it: existing cast members and ones found during analysis. */
export interface CastEntry {
  key: string;
  name: string;
  aliases: string[];
  gender?: Gender;
  role: 'narrator' | 'character' | 'unknown';
}

/** The names a story's narrator and unknown speaker get on creation (storage/stories.ts). */
export const NARRATOR_NAME = { en: 'Narrator', es: 'Narrador' } as const;
export const UNKNOWN_NAME = { en: 'Unknown speaker', es: 'Desconocido' } as const;

const DEFAULT_NARRATOR_NAMES = new Set(Object.values(NARRATOR_NAME).map((n) => normaliseName(n)));
const DEFAULT_UNKNOWN_NAMES = new Set(Object.values(UNKNOWN_NAME).map((n) => normaliseName(n)));

/** Title words of both languages, lower-case, without the period ("mr", "doña", "uncle"). */
const TITLE_WORDS = new Set(
  [...Object.keys(TITLES.en), ...Object.keys(TITLES.es)].map((t) =>
    t.replace(/\.$/u, '').toLowerCase(),
  ),
);

/** Female titles that go before a family name ("Miss Bingley", "Mrs. Joe", "Madame Defarge"). */
const FAMILY_TITLES = new Set(['mrs', 'miss', 'ms', 'mme', 'mlle', 'madam', 'madame']);

/**
 * The form names are compared in: NFC, ’ = ', no trailing punctuation or possessive ’s,
 * lower-case, no period after a short leading word ("Mr Darcy" = "Mr. Darcy"), and a leading
 * "Mister" spelled as "Mr" ("Mister Smith" = "Mr. Smith").
 */
export function normaliseName(name: string): string {
  const normal = name
    .normalize('NFC')
    .replace(/[’‘]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.,;:!?]+$/u, '')
    .replace(/'s$/u, '')
    .toLowerCase()
    .replace(/^(\p{L}{1,4})\.(?= )/u, '$1');
  return normal.startsWith('mister ') ? `mr${normal.slice('mister'.length)}` : normal;
}

/** Whether a name is the default the story gave its narrator or unknown speaker. */
export function isDefaultName(name: string, role: CastEntry['role']): boolean {
  if (role === 'narrator') return DEFAULT_NARRATOR_NAMES.has(normaliseName(name));
  if (role === 'unknown') return DEFAULT_UNKNOWN_NAMES.has(normaliseName(name));
  return false;
}

/**
 * The names an entry can be matched by. The narrator matches by its own name and aliases, but
 * never by its default name ("Narrator"), so an unnamed narrator matches nothing; the unknown
 * speaker matches only by an alias (a name the user merged into it).
 */
export function namesOf(entry: CastEntry): string[] {
  if (entry.role === 'unknown') return entry.aliases;
  return [entry.name, ...entry.aliases].filter((n) => !isDefaultName(n, entry.role));
}

function split(name: string): { title?: string; words: string[] } {
  const words = normaliseName(name).split(' ');
  return words.length > 1 && TITLE_WORDS.has(words[0]!)
    ? { title: words[0]!, words: words.slice(1) }
    : { words };
}

/**
 * Finds the cast entry a name refers to:
 * 1. an exact name or alias (see normaliseName), first in cast order;
 * 2. the same name with and without a title ("Darcy" ↔ "Mr. Darcy", "Pablo" ↔ "Don Pablo"); two
 *    different titles never match ("Mr. Bennet" ≠ "Mrs. Bennet"), and a female title before a
 *    single name is a family name, so "Bingley" is not "Miss Bingley" (she may be his sister);
 * 3. an untitled single word matching the last word ("Golfín" → "Teodoro Golfín") or the first
 *    word ("Amy" → "Amy Elliott") of a multi-word name, or the reverse; a full name with another
 *    first name is someone else ("Carlos Golfín" is not "Golfín" known as "Teodoro Golfín").
 * Rules 2 and 3 need exactly one candidate. See namesOf for the narrator and unknown speaker.
 */
export function matchCast(name: string, cast: readonly CastEntry[]): CastEntry | undefined {
  const wanted = normaliseName(name);
  if (!wanted) return undefined;
  const exact = cast.find((c) => namesOf(c).some((n) => normaliseName(n) === wanted));
  if (exact) return exact;

  const candidates = cast.filter((c) => c.role !== 'unknown');
  const w = split(name);
  const same = (a: string[], b: string[]) => a.join(' ') === b.join(' ');
  const unique = (hits: CastEntry[]) => (hits.length === 1 ? hits[0] : undefined);

  // Exactly one of the two has a title (the same title on both is an exact match).
  const paired = (o: { title?: string; words: string[] }) =>
    !w.title !== !o.title && same(o.words, w.words);
  // "Bingley" and "Miss Bingley", "Joe" and "Mrs. Joe": maybe two people, so a pair like this
  // still makes a name ambiguous but is never a match on its own.
  const family = (o: { title?: string }) =>
    w.words.length === 1 && FAMILY_TITLES.has((w.title ?? o.title)!);
  const titled = candidates.filter((c) => namesOf(c).some((n) => paired(split(n))));
  if (titled.length > 1) return undefined;
  const [only] = titled;
  const pairs = only ? namesOf(only).map(split).filter(paired) : [];
  if (pairs.some((o) => !family(o))) return only;
  if (w.title) return undefined;

  const words = w.words;
  const partial = candidates.filter((c) => {
    const names = namesOf(c)
      .map(split)
      .filter((o) => !o.title);
    const full = names.filter((o) => o.words.length > 1);
    return names.some((o) => {
      if (o.words.length === words.length) return false;
      if (words.length === 1) return o.words.at(-1) === words[0] || o.words[0] === words[0];
      if (o.words.length !== 1) return false;
      // A longer name for a single-word entry, unless a full name it already has disagrees.
      if (o.words[0] === words.at(-1)) return full.every((f) => f.words[0] === words[0]);
      if (o.words[0] === words[0]) return full.every((f) => f.words.at(-1) === words.at(-1));
      return false;
    });
  });
  return unique(partial);
}
