import type { Character } from '@/format/types';
import { FAMILY_TITLES, normaliseName, split } from '@/analysis/castMatch';

/** Two characters that may be one person: `fromId` would merge into `intoId`, for `reason`. */
export interface MergeSuggestion {
  fromId: string;
  intoId: string;
  /** Why they may be one person, in the user's words: "“Bob” is short for “Robert”". */
  reason: string;
}

/** A pair's key, the same whichever way round: what "Not the same" remembers. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Short forms of first names, each with the names it is short for. Kept small and common: a
 * suggestion is only a suggestion, but a wrong one is noise.
 */
const NICKNAMES: Record<string, string[]> = {
  abby: ['abigail'],
  alex: ['alexander', 'alexandra'],
  andy: ['andrew'],
  annie: ['anne', 'ann', 'anna'],
  becky: ['rebecca'],
  ben: ['benjamin'],
  bess: ['elizabeth'],
  beth: ['elizabeth'],
  betsy: ['elizabeth'],
  bill: ['william'],
  billy: ['william'],
  bob: ['robert'],
  bobby: ['robert'],
  charlie: ['charles', 'charlotte'],
  chris: ['christopher', 'christine'],
  dan: ['daniel'],
  danny: ['daniel'],
  dick: ['richard'],
  ed: ['edward', 'edmund'],
  eddie: ['edward'],
  eliza: ['elizabeth'],
  fred: ['frederick'],
  freddie: ['frederick'],
  harry: ['henry', 'harold'],
  jack: ['john'],
  jamie: ['james'],
  jim: ['james'],
  jimmy: ['james'],
  joe: ['joseph'],
  johnny: ['john'],
  kate: ['katherine', 'catherine', 'kathryn'],
  kathy: ['katherine', 'kathryn'],
  kitty: ['katherine', 'catherine', 'kathryn'],
  liz: ['elizabeth'],
  lizzie: ['elizabeth'],
  lizzy: ['elizabeth'],
  maggie: ['margaret'],
  matt: ['matthew'],
  meg: ['margaret'],
  mike: ['michael'],
  molly: ['mary'],
  ned: ['edward', 'edmund'],
  nick: ['nicholas'],
  peggy: ['margaret'],
  polly: ['mary'],
  rob: ['robert'],
  sam: ['samuel', 'samantha'],
  sue: ['susan'],
  ted: ['edward', 'theodore'],
  tom: ['thomas'],
  tommy: ['thomas'],
  tony: ['anthony'],
  will: ['william'],
};

const isNickname = (short: string, full: string) =>
  Object.hasOwn(NICKNAMES, short) && NICKNAMES[short]!.includes(full);

/** Whether two strings are one edit apart: a letter added, dropped, changed or two swapped. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    // A changed letter, or two neighbours swapped ("Hermoine" for "Hermione").
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}
/** Words shorter than this are too often two real names a letter apart ("Jane", "Jade"). */
const TYPO_MIN_LENGTH = 5;

type Words = ReturnType<typeof split>;
const quote = (name: string) => `“${name}”`;

interface Why {
  reason: string;
  /** For the lone-name rule: the single word, which needs checking against whole members. */
  lone?: { word: string; name: string };
}

/** Why names `a` and `b` (each as written) may name one person, or undefined. */
function why(a: string, b: string): Why | undefined {
  const [x, y]: [Words, Words] = [split(a), split(b)];
  const same = (p: string[], q: string[]) => p.join(' ') === q.join(' ');
  if (normaliseName(a) === normaliseName(b)) return { reason: `Both are called ${quote(a)}` };

  // The same name, one with a title ("Darcy", "Mr. Darcy"); two titles are two people. A
  // female title before a single name is a family name: "Miss Bingley" may be his sister.
  if (!x.title !== !y.title && same(x.words, y.words)) {
    const title = (x.title ?? y.title)!;
    if (!(x.words.length === 1 && FAMILY_TITLES.has(title))) {
      return { reason: `${quote(a)} and ${quote(b)} differ only by a title` };
    }
  }
  // Two titles are two people ("Mr. Bennet", "Mrs. Bennet"); the same title may hide a typo.
  if (x.title && y.title && x.title !== y.title) return undefined;

  // A first-name nickname, the rest the same or missing ("Bob" or "Bob Smith" for "Robert Smith").
  const [fx, fy] = [x.words[0]!, y.words[0]!];
  const restAgrees =
    x.words.length === 1 || y.words.length === 1 || same(x.words.slice(1), y.words.slice(1));
  if (restAgrees && (isNickname(fx, fy) || isNickname(fy, fx))) {
    const [short, full] = isNickname(fx, fy) ? [a, b] : [b, a];
    return { reason: `${quote(short)} can be short for ${quote(full)}` };
  }

  // A lone first or last name of a full name ("Harker", "Jonathan Harker"), neither titled.
  if (!x.title && !y.title && x.words.length !== y.words.length) {
    const [one, full] = x.words.length === 1 ? [x, y] : y.words.length === 1 ? [y, x] : [];
    if (one && full) {
      const word = one.words[0]!;
      if (full.words.at(-1) === word || full.words[0] === word) {
        const [lone, whole] = one === x ? [a, b] : [b, a];
        return { reason: `${quote(lone)} may be ${quote(whole)}`, lone: { word, name: lone } };
      }
    }
  }

  // A misspelling: one word one edit apart, the rest the same, and that word long enough. A shared
  // family name doesn't count towards the length: "Jane Bennet" and "Jade Bennet" are sisters.
  if (x.title === y.title && x.words.length === y.words.length) {
    const differ = x.words.flatMap((w, i) => (w === y.words[i] ? [] : [i]));
    const [p, q] = differ.length === 1 ? [x.words[differ[0]!]!, y.words[differ[0]!]!] : [];
    if (p && q && Math.min(p.length, q.length) >= TYPO_MIN_LENGTH && oneEditApart(p, q)) {
      return { reason: `${quote(a)} and ${quote(b)} are spelled almost alike` };
    }
  }
  return undefined;
}

/**
 * The lone-name rule as the analysers apply it (matchCast): a lone word is one of a full name
 * only when its member has no other name that says otherwise (a title, or a full name with other
 * words: "Harker" known as "Jonathan Harker" is not "Mina Harker"), and only one other character
 * has a full name with that word ("Harker" with both Jonathan and Mina is anyone's guess).
 */
function loneHolds(
  loneMember: Character,
  word: string,
  fullName: string,
  characters: readonly Character[],
): boolean {
  const full = split(fullName).words.join(' ');
  for (const n of [loneMember.name, ...loneMember.aliases]) {
    const w = split(n);
    if (w.title) return false;
    if (w.words.length > 1 && w.words.join(' ') !== full) return false;
  }
  const holders = characters.filter(
    (c) =>
      c.id !== loneMember.id &&
      [c.name, ...c.aliases].some((n) => {
        const w = split(n);
        return !w.title && w.words.length > 1 && (w.words[0] === word || w.words.at(-1) === word);
      }),
  );
  return holders.length === 1;
}

/**
 * Characters that may be one person, found from their names and other names, most-heard first.
 * Each pair is suggested once, merging the one with fewer lines into the other (on a tie, the
 * later one in the cast into the earlier). The narrator and the unknown speaker are left out: a
 * name of theirs is merged from their own cards. Pairs in `notSame` (pairKey) are left out too.
 */
export function suggestMerges(
  cast: readonly Character[],
  lines: ReadonlyMap<string, number>,
  notSame: ReadonlySet<string> = new Set(),
): MergeSuggestion[] {
  const characters = cast.filter((c) => c.role === 'character');
  const count = (c: Character) => lines.get(c.id) ?? 0;
  const found: Array<MergeSuggestion & { weight: number }> = [];
  characters.forEach((a, i) => {
    for (const b of characters.slice(i + 1)) {
      if (notSame.has(pairKey(a.id, b.id))) continue;
      let reason: string | undefined;
      for (const na of [a.name, ...a.aliases]) {
        for (const nb of [b.name, ...b.aliases]) {
          const found = reason ? undefined : why(na, nb);
          if (!found) continue;
          if (found.lone) {
            const lone = found.lone.name === na ? a : b;
            const fullName = found.lone.name === na ? nb : na;
            if (!loneHolds(lone, found.lone.word, fullName, characters)) continue;
          }
          reason = found.reason;
        }
      }
      if (!reason) continue;
      const [from, into] = count(b) <= count(a) ? [b, a] : [a, b];
      found.push({ fromId: from.id, intoId: into.id, reason, weight: count(into) });
    }
  });
  return found
    .sort((p, q) => q.weight - p.weight)
    .map((s) => ({ fromId: s.fromId, intoId: s.intoId, reason: s.reason }));
}
