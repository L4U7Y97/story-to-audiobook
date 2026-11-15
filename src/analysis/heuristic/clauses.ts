/** Clause grammar: opening subjects, joins between clauses, and the teller's hedges. */

import type { Gender } from '@/format/types';
import {
  ADDRESSEE_MARKERS,
  AUTHORIAL_SKIP,
  AUTHORIAL_VERBS,
  AUXILIARIES_AND_MODALS,
  BEFORE_VERB_SKIP,
  CLAUSE_LEADS,
  COORDINATORS,
  NON_PARTICIPANT_PREPOSITIONS,
  OTHER_SUBJECTS,
  PERCEIVING,
  PHRASE_AFTER_PERSON,
  RELATIVES,
  SAYING_VERBS,
  SENTENCE_LEADS,
  SUBORDINATORS,
} from './lexicon';
import { ASIDE_WINDOW, isPronoun, type Subject } from './mentions';
import { timeOpensSentence } from './time';
import {
  addressedIn,
  afterPreposition,
  apostropheWordAt,
  findLastIndex,
  lastSentenceStart,
  LOWER,
  LY_ADVERB,
  wordAt,
  type Mention,
  type Token,
} from './tokens';
import { endsObject, finiteShape } from './verbShape';

/** The subject pronouns of people in narration, lower-case ("you" and "it" left out). */
const PERSONAL_SUBJECTS = new Set(['i', 'we', 'he', 'she', 'they']);

/**
 * The subject that opens the sentence starting at `start`, after a lead word or two ("Then Anne",
 * "But he"), and where it ends: past it another clause's subject begins. A time phrase that opens
 * the sentence comes before it too: "The next morning she knocked and said:".
 */
export function openingSubjectAt(
  ts: Token[],
  start: number,
  mentions: Mention[],
): { subject: Subject; end: number } | null {
  const from = timeOpening(ts, start) ?? start;
  for (let i = from; i < Math.min(ts.length, from + 3); i++) {
    const t = ts[i]!;
    if (i > from && (t.sentenceStart || t.punctBefore)) return null;
    const pronoun = isPronoun(t.text);
    if (pronoun) return { subject: { kind: 'pronoun', gender: pronoun }, end: i };
    const m = mentions.find((x) => x.first === i && !x.possessive);
    if (m) return { subject: { kind: 'mention', mention: m }, end: m.last };
    if (!SENTENCE_LEADS.has(t.text.toLowerCase())) return null;
  }
  return null;
}

/** The subject that opens the sentence starting at `start` (see openingSubjectAt). */
export function openingSubject(ts: Token[], start: number, mentions: Mention[]): Subject | null {
  return openingSubjectAt(ts, start, mentions)?.subject ?? null;
}

/** Where the subject that opens the sentence at `start` ends, or `start` when none does. */
export function openingSubjectEnd(ts: Token[], start: number, mentions: Mention[]): number {
  return openingSubjectAt(ts, start, mentions)?.end ?? start;
}

/** Where the words after a time phrase that opens the sentence at `start` begin, if one does. */
export function timeOpening(ts: Token[], start: number): number | undefined {
  return timeOpensSentence(ts).find(
    (e) => e > start && e < start + 6 && lastSentenceStart(ts.slice(0, e + 1)) === start,
  );
}

/**
 * Where the word is that joins the verb at `v` to the clause before it, past adverbs ("I turned
 * to her and said", "she nodded and then whispered", "Tom nodded, then said"), or opens a short
 * aside between commas right before it ("Tom turned to Anne, and in a low voice, said"), or -1.
 */
export function joinAt(ts: Token[], v: number, start: number): number {
  const word = (k: number) => ts[k]!.text.toLowerCase();
  let b = v - 1;
  while (
    b > start &&
    !ts[b + 1]!.punctBefore &&
    (BEFORE_VERB_SKIP.has(word(b)) || LY_ADVERB.test(ts[b]!.text))
  ) {
    b--;
  }
  if (b > start && !ts[b + 1]!.punctBefore && COORDINATORS.has(word(b))) return b;
  // ", then said": "then" after a comma joins the clause like "and".
  const then = b + 1;
  if (then > start && then < v && word(then) === 'then' && ts[then]!.punctBefore === ',') {
    return then;
  }
  if (ts[v]!.punctBefore !== ',') return -1;
  let k = v - 1;
  while (k > start && v - k < ASIDE_WINDOW && !ts[k]!.punctBefore) k--;
  return k > start && ts[k]!.punctBefore === ',' && COORDINATORS.has(word(k)) ? k : -1;
}

/** "I turned to her and said": the verb at `v` shares the subject of the clause before "and". */
export function coordinated(ts: Token[], v: number, start: number): boolean {
  return joinAt(ts, v, start) !== -1;
}

/**
 * "I suppose she sighed and said", "I daresay Mrs. Bennet turned and said": another clause's
 * subject between the sentence's opening subject (from `start`) and the verb at `v`. A name or
 * descriptor is one unless a preposition comes before it or it ends as an object (see endsObject):
 * "I turned to Anne and said", "I hugged Anne and said". English "he", "she" and "they" are too,
 * though after a word such as "for" only in a clause that runs on into the verb ("I paused, for
 * she sighed and said", not "I went to him, for he had called me, and said"), like a relative
 * after a comma ("I went back to Mrs. Bennet, who sighed and said").
 */
export function otherSubjectBetween(
  ts: Token[],
  start: number,
  v: number,
  mentions: Mention[],
): boolean {
  const runsIntoVerb = (i: number) => ts.slice(i + 1, v + 1).every((t) => !t.punctBefore);
  for (let i = start + 1; i < v; i++) {
    const word = ts[i]!.text.toLowerCase();
    const prev = ts[i]!.punctBefore ? '' : ts[i - 1]!.text.toLowerCase();
    const relative = RELATIVES.has(word) || word === 'which';
    if (relative && ts[i]!.punctBefore === ',' && runsIntoVerb(i)) return true;
    const object = NON_PARTICIPANT_PREPOSITIONS.has(prev) || ADDRESSEE_MARKERS.has(prev);
    // English "for she", "till he" open a clause.
    if (OTHER_SUBJECTS.has(word) && (!object || runsIntoVerb(i))) {
      return true;
    }
    const m = mentions.find((x) => x.first === i && !x.possessive);
    if (!m || object) continue;
    if (CLAUSE_LEADS.has(prev) || !endsObject(ts, m.last + 1)) return true;
  }
  return false;
}

/**
 * Whether someone else's subject comes right after "that", "as" or "while" between `start` and
 * `end`: "I noticed that Anne looked away", "I watched as Anne put down her cup". An English
 * "that" counts only after a verb of perceiving, not after a noun or "knew" ("the coat that Anne
 * had given me", "I knew that Tom was right").
 */
export function perceived(ts: Token[], start: number, end: number, mentions: Mention[]) {
  const leads = new Set(['that', 'as', 'while']);
  for (let i = start + 1; i < end; i++) {
    const lead = ts[i - 1]!.text.toLowerCase();
    if (ts[i]!.punctBefore || !leads.has(lead)) continue;
    if (lead === 'that' && !PERCEIVING.has(wordAt(ts, i - 2))) {
      continue;
    }
    if (OTHER_SUBJECTS.has(ts[i]!.text.toLowerCase())) return true;
    if (mentions.some((m) => m.first === i && !m.possessive)) return true;
  }
  return false;
}

/**
 * "I suppose the cook sighed and said", "But I must now return to …", "I’m bound to say …": the
 * teller's "I" takes a clause or a modal (see AUTHORIAL_VERBS) and the verb at `v` is past, so the
 * clause's subject says it, whoever it is. That "I" is the last one before the verb that is not in
 * an aside between commas or in a clause such as "when" opens ("I think I sighed, and said" is
 * the teller's, and so is "I laughed, I think, and said"; "I think, when I was young, the cook
 * sighed and said" is not). A present "say" is the teller's own ("I feel my face go hot and say",
 * "I would kiss her cheek and say"), and so is a past modal ("I must have blushed and said", "I
 * must not have heard him, and said"), or "would" before anything but a verb of saying ("I would
 * not look at him and said", but not "I would add that the cook…"). "I’m" is "I am" and "I’ll" is
 * "I will"; "I’d" may be "I had", so the word after it decides.
 */
export function authorialTeller(ts: Token[], start: number, v: number): boolean {
  if (ts[v]!.text.toLowerCase() === 'say') return false;
  const runs = (k: number) => ts.slice(k + 1, v + 1).every((t) => !t.punctBefore);
  const governs = (k: number) =>
    k === start ||
    runs(k) ||
    (!ts[k]!.punctBefore && !SUBORDINATORS.has(apostropheWordAt(ts, k - 1)));
  // "…, I thought, and said": the aside's own past verb is the one "and said" joins.
  const aside = (k: number) => {
    if (ts[k]!.punctBefore !== ',' || AUTHORIAL_VERBS.has(apostropheWordAt(ts, k + 1)))
      return false;
    let e = k + 1;
    while (e < v && !ts[e]!.punctBefore) e++;
    return (
      e < v &&
      ts[e]!.punctBefore === ',' &&
      apostropheWordAt(ts, e) === 'and' &&
      ts.slice(e + 1, v + 1).every((t) => !t.punctBefore)
    );
  };
  const i = findLastIndex(
    ts,
    (t, k) => k >= start && k < v && isPronoun(t.text) === 'narrator' && (governs(k) || aside(k)),
  );
  if (i === -1) return false;
  const contraction = ts[i]!.text.replace(/’/gu, "'");
  if (contraction === "I'm" || contraction === "I'll") return true;
  if (contraction === "I've") return false;
  for (let k = i + 1; k < v && !ts[k]!.punctBefore; k++) {
    if (toldAt(ts, k + 1)) continue;
    const word = apostropheWordAt(ts, k);
    if (AUTHORIAL_VERBS.has(word) || toldAt(ts, k)) {
      let n = k + 1;
      while (n < v && !ts[n]!.punctBefore && AUTHORIAL_SKIP.has(apostropheWordAt(ts, n))) n++;
      const next = apostropheWordAt(ts, n);
      if (next === 'have' && !ts[n]!.punctBefore) return false;
      return (word !== 'would' && word !== "wouldn't") || SAYING_VERBS.has(next);
    }
    if (!AUTHORIAL_SKIP.has(word) && !LY_ADVERB.test(ts[k]!.text)) return false;
  }
  return false;
}

/**
 * Where the teller's hedge that opens the stretch at `from` ends, before `end`: its verb ("I
 * think", "I really believe"), or the "that" after it ("I suppose that"), or -1.
 */
export function hedgeEnd(ts: Token[], from: number, end: number): number {
  let k = from;
  while (k < end && isPronoun(ts[k]!.text) !== 'narrator') k++;
  for (k++; k < end && !ts[k]!.punctBefore; k++) {
    if (toldAt(ts, k + 1)) continue;
    if (AUTHORIAL_VERBS.has(wordAt(ts, k)) || toldAt(ts, k)) {
      return wordAt(ts, k + 1) === 'that' && !ts[k + 1]!.punctBefore ? k + 1 : k;
    }
    if (!AUTHORIAL_SKIP.has(wordAt(ts, k))) return -1;
  }
  return -1;
}

/** "I was told", "I am told": the "told" of a passive at `k`, the teller's hearsay. */
function toldAt(ts: Token[], k: number): boolean {
  return (
    ts[k]?.text.toLowerCase() === 'told' &&
    !ts[k]!.punctBefore &&
    /^(?:was|am|were)$/u.test(wordAt(ts, k - 1))
  );
}

/**
 * Whether the English aside after the join at `join` (before the verb at `v`) opens with an
 * indefinite or "you" that is the subject of the verb right after it: "and no one expected it,",
 * "and none of us expected it,", "and everyone was surprised,", "and you will hardly believe it,";
 * not "and everyone else," or "and everyone who was there,".
 */
export function remarkSubject(ts: Token[], join: number, v: number): boolean {
  const opener = wordAt(ts, join + 1);
  let j: number;
  if (opener === 'no' && wordAt(ts, join + 2) === 'one') j = join + 3;
  else if (
    ['none', 'everyone', 'everybody', 'someone', 'somebody', 'anyone', 'anybody', 'you'].includes(
      opener,
    )
  ) {
    j = join + 2;
  } else return false;
  if (wordAt(ts, j) === 'of' && ['us', 'them', 'you'].includes(wordAt(ts, j + 1))) j += 2;
  while (j < v && ['ever', 'never', 'hardly', 'really', 'even', 'scarcely'].includes(wordAt(ts, j)))
    j++;
  const t = ts[j];
  if (!t || j >= v || t.punctBefore || !LOWER.test(t.text)) return false;
  return finiteShape(wordAt(ts, j), true) || AUXILIARIES_AND_MODALS.has(wordAt(ts, j));
}

/**
 * Whether the sentence at `start` has no subject of its own before `clause`: it opens with a
 * phrase or a clause ("When the music stopped, Mr. Darcy bowed, then said", "Presently, the old
 * man rose and said"), not with a subject, nor with a verb and its subject.
 */
export function opensWithoutSubject(
  ts: Token[],
  start: number,
  clause: number,
  mentions: Mention[],
): boolean {
  const first = ts[start]!.text.toLowerCase();
  // The phrase or clause that opens the sentence runs to its first comma, right before the
  // stretch: "When the music stopped, the old man rose, and said".
  let opening = start + 1;
  while (opening < clause && !ts[opening]!.punctBefore) opening++;
  const second = wordAt(ts, start + 1);
  // Someone named in an English phrase that opens with a participle or a preposition is not
  // its subject: "Seeing Tom, the old woman rose", "With Tom gone, the housekeeper came in",
  // "Long after Tom had gone to bed, the old man rose".
  const fronted =
    /\p{L}ing$/u.test(first) ||
    NON_PARTICIPANT_PREPOSITIONS.has(first) ||
    PHRASE_AFTER_PERSON.has(first) ||
    first === 'like' ||
    first === 'unlike' ||
    (/^(?:long|soon|shortly|just|right|even)$/u.test(first) && SUBORDINATORS.has(second));
  // In English it may run on past that comma when nobody is a subject before the stretch
  // ("Seeing Tom at the gate, and knowing what it meant, the old woman rose", "When the music
  // stopped, and the dancers had gone, the old man rose"; not "Hearing the gate, Anne ran to her
  // father, a tall man dressed in black,").
  // Someone named in a part that "and" or "or" adds to the opening is no subject before the
  // stretch either ("When the music stopped, and Anne sat down again, the old man rose").
  const continues = (k: number) => {
    let j = k;
    while (j > opening && !ts[j]!.punctBefore) j--;
    return ['and', 'or'].includes(ts[j]!.text.toLowerCase());
  };
  const subject =
    ts
      .slice(opening, clause)
      .some((t, i) => PERSONAL_SUBJECTS.has(t.text.toLowerCase()) && !continues(opening + i)) ||
    mentions.some(
      (m) =>
        m.first >= opening &&
        m.last < clause &&
        !continues(m.first) &&
        !m.possessive &&
        !afterPreposition(ts, m) &&
        !addressedIn(ts, m) &&
        !['like', 'unlike'].includes(wordAt(ts, m.first - 1)),
    );
  const runs = opening === clause || !subject;
  if (fronted && runs) return true;
  if (openingSubject(ts, start, mentions)) return false;
  if (SUBORDINATORS.has(first) || CLAUSE_LEADS.has(first)) return runs;
  // An English part after a comma that opens with a subject pronoun is the main clause, as a
  // name is ("Hearing the gate, I ran to my father, a tall man dressed in black, and said").
  const pronounClause = ts
    .slice(start + 1, clause)
    .some((t) => !!t.punctBefore && PERSONAL_SUBJECTS.has(t.text.toLowerCase()));
  if (pronounClause) return false;
  return !mentions.some(
    (m) =>
      m.first >= start &&
      m.last < clause &&
      !m.possessive &&
      !afterPreposition(ts, m) &&
      !addressedIn(ts, m),
  );
}

/** The teller's "I". */
export function isTeller(subject: Subject | null | undefined): boolean {
  return subject?.kind === 'pronoun' && subject.gender === 'narrator';
}

/** The gender of a "he" or "she" subject. */
export function heOrShe(subject: Subject | null): Gender | undefined {
  return subject?.kind === 'pronoun' && subject.gender !== 'narrator' ? subject.gender : undefined;
}
