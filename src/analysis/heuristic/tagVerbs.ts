/** Speech verbs that tag a line, and the checks on their subjects that need no resolving. */

import type { Gender } from '@/format/types';
import type { Unit } from '../units';
import {
  coordinated,
  heOrShe,
  joinAt,
  openingSubject,
  openingSubjectAt,
  otherSubjectBetween,
} from './clauses';
import {
  AFTER_VERB_SKIP,
  BARE_OBJECTS,
  BEFORE_VERB_SKIP,
  CONJUNCTIONS,
  DETERMINERS,
  FREQUENCY_ADVERBS,
  INDEFINITE_SUBJECTS,
  NOUN_LEADS,
  QUESTION_JOINS,
  QUESTION_OPENERS,
  RELATIVES,
  REPORTED_OBJECTS,
  SENTENCE_LEADS,
  SPEAKER_NOUNS,
  SUBJECT_PRONOUNS,
  TIME_AFTER_THAT,
} from './lexicon';
import { isPronoun, subjectIndexBefore, subjectOf, verbAt } from './mentions';
import type { Lookup } from './reading';
import {
  apostropheWordAt,
  clauseBeforeJoin,
  clauseStart,
  findLastIndex,
  firstSentenceEnd,
  gluedAt,
  gluedWordAt,
  lastSentenceStart,
  LOWER,
  LY_ADVERB,
  wordAt,
  type Mention,
  type Token,
} from './tokens';

/** How far into a tag (in words) the speech verb may appear: "said his lady". */
export const TAG_WINDOW = 6;

/** Narration that leads into the line after it: "Tom said, “…”". */
const INTRO_END = /[,:]\s*$/u;

/**
 * What `read` gives for the tag of the voiced unit at `n` (see tagNear in tags.ts), reading a
 * narration unit at a verb (-1 for none). `named`: whether what it gave names who speaks, which
 * decides between the narration after the line and before it. The teller check reads tags
 * through here too, so it reads the verbs the tagger reads.
 */
export function nearTag<T>(
  r: Lookup,
  units: Unit[],
  n: number,
  tokens: Map<Unit, Token[]>,
  isVoiced: (u: Unit) => boolean,
  read: (ts: Token[], v: number) => T | undefined,
  named: (tag: T | undefined) => boolean,
): T | undefined {
  const after = units[n + 1];
  const before = units[n - 1];
  const beforeTag = () => {
    if (!before || isVoiced(before)) return undefined;
    const ts = tokens.get(before)!;
    return read(ts, beforeVerb(r, before, ts));
  };

  // The second half of an interrupted quote takes the tag that interrupts it: "“Lucy,” he
  // said to me, “you are…”"
  const interrupted =
    !!before &&
    !isVoiced(before) &&
    /,\s*$/u.test(r.slice(before)) &&
    !!units[n - 2] &&
    isVoiced(units[n - 2]!) &&
    (/^\s*[“"‘']\s*\p{Ll}/u.test(r.slice(units[n]!)) ||
      /,\s*[”"’']?\s*$/u.test(r.slice(units[n - 2]!)));
  if (interrupted) {
    const tag = beforeTag();
    if (named(tag)) return tag;
  }
  if (after && !isVoiced(after)) {
    const ts = tokens.get(after)!;
    const verbIndex = afterVerb(r, after, ts);
    const tag = read(ts, verbIndex);
    if (tag) {
      // "Tom said, “Yes.” Then Anne said, “No.”": the narration after the line leads into the
      // next one, so this line's own intro wins. The first half of a split quote with no intro
      // of its own keeps the tag that splits it ("Anne laughed. “You,” Tom said, “…”").
      const introBefore = !!before && !isVoiced(before) && INTRO_END.test(r.slice(before));
      const firstHalf =
        /,\s*[”"’']?\s*$/u.test(r.slice(units[n]!)) || /^\s*,/u.test(r.slice(after));
      const leadsOn =
        verbIndex > 0 &&
        INTRO_END.test(r.slice(after)) &&
        !!units[n + 2] &&
        isVoiced(units[n + 2]!) &&
        (introBefore || !firstHalf);
      const own = !named(tag) || leadsOn ? beforeTag() : undefined;
      return named(own) ? own : tag;
    }
  }
  return beforeTag();
}

/**
 * The verb of a tag after a line: the first in the narration's first sentence, in 6 words, or
 * the verb it reports ("I was told I said"). A question has none ("“Tom?” Why had he told me
 * nothing?"; see asks).
 */
export function afterVerb(r: Lookup, u: Unit, ts: Token[]): number {
  const end = firstSentenceEnd(ts);
  const limit = Math.min(TAG_WINDOW, end);
  const v = ts.findIndex((_, i) => i < limit && tagVerb(r, ts, i));
  const reported = v === -1 ? -1 : reportedVerb(r, ts, v);
  const w = reported === -1 ? v : reported;
  return w !== -1 && asks(r, u, ts, w, end) ? -1 : w;
}

/**
 * "I was told I said", "I’m told she asked", "he told me that Anne said": hearsay told to the
 * teller about who said the line. The reported speech verb, right after its own subject in the
 * same sentence, or -1.
 */
function reportedVerb(r: Lookup, ts: Token[], v: number): number {
  if (!saidToTeller(ts, v)) return -1;
  const word = (k: number) => (ts[k]?.punctBefore ? undefined : ts[k]?.text.toLowerCase());
  let k = v + 1;
  if (word(k) === 'me') k++;
  else if (word(k) === 'to' && word(k + 1) === 'me') k += 2;
  if (word(k) === 'that') k++;
  if (word(k) === undefined) return -1;
  const mention = r.cast.mentions(ts).find((m) => m.first === k && !m.possessive);
  const subjectEnd = isPronoun(ts[k]!.text) ? k : mention?.last;
  if (subjectEnd === undefined) return -1;
  const end = firstSentenceEnd(ts);
  const w = ts.findIndex((_, i) => i > subjectEnd && i < end && isVerb(r, ts, i));
  return w !== -1 && subjectIndexBefore(ts, w) === subjectEnd ? w : -1;
}

/**
 * The verb of a tag before a line: the last in the narration's last 6 words. Never across a
 * sentence ("“Help!” screamed Anne. Tom ran in. “What’s wrong?”"), but an intro clause is read
 * whole ("Mrs. Bennet said to her husband one cold evening, “…”"). A question has none.
 */
export function beforeVerb(r: Lookup, u: Unit, ts: Token[]): number {
  const sentence = lastSentenceStart(ts);
  const from = INTRO_END.test(r.slice(u)) ? sentence : Math.max(sentence, ts.length - TAG_WINDOW);
  const v = findLastIndex(ts, (_, i) => i >= from && tagVerb(r, ts, i));
  return v !== -1 && asks(r, u, ts, v, ts.length) ? -1 : v;
}

/**
 * Whether the verb at `v` asks: the sentence of narration unit `u` that ends before token `end`
 * (at the unit's end when it is `ts.length`) is a question, and the verb is in it: its own clause
 * opens with a question word or an auxiliary, perhaps after "and" or "but" ("What could I
 * say?", "Had he told me nothing, or had I not listened?"), or no comma or pause and a word such
 * as "but" or "because" separate it from the question ("Did he mean it, I wondered?", "Why, I
 * ask you, did he come?"), also when the question opens before an aside the verb is in ("Did he
 * mean it, I asked myself, as I watched him go?"). A tag before such a word is a tag: "“I’m
 * fine,” I said, but was I?", "Tom said, because what else could he say?", "I said… but was I?",
 * and so is one that goes on from its line after a comma, whatever its first word ("“I’m fine,”
 * Will said, but was he?", "“Out,” was all I said, but…").
 */
function asks(r: Lookup, u: Unit, ts: Token[], v: number, end: number): boolean {
  const after =
    end < ts.length ? ts[end]!.punctBefore : r.text.slice(u.start + (ts.at(-1)?.end ?? 0), u.end);
  if (!after.includes('?')) return false;
  const names = r.cast.mentions(ts);
  // A cast name such as "Will" or "May" opens no question before its verb ("“I’m fine!” Will
  // said, but was he?"), only before a subject ("Will we ever see her again, I wondered?").
  const name = (k: number) =>
    names.some((m) => m.first === k && m.kind === 'name' && !!r.cast.match(m.name)) &&
    !(gluedAt(ts, k + 1) && SUBJECT_PRONOUNS.has(apostropheWordAt(ts, k + 1)));
  // A wh-word before its subject opens a clause, not a question: "When I asked", "How she
  // laughed", "Where the road ended" ("How do you know?", "Why the devil did you go?").
  const subordinate = (k: number) => {
    if (!['when', 'where', 'how', 'why'].includes(apostropheWordAt(ts, k))) return false;
    if (!gluedAt(ts, k + 1)) return false;
    if (names.some((m) => m.first === k + 1 && !m.possessive)) return true;
    if (SUBJECT_PRONOUNS.has(apostropheWordAt(ts, k + 1))) return true;
    const determiners = [
      'the',
      'a',
      'an',
      'his',
      'her',
      'my',
      'our',
      'their',
      'its',
      'this',
      'that',
    ];
    return (
      determiners.includes(apostropheWordAt(ts, k + 1)) &&
      gluedAt(ts, k + 2) &&
      !['hell', 'devil', 'heck', 'deuce'].includes(apostropheWordAt(ts, k + 2))
    );
  };
  const opens = (k: number) =>
    QUESTION_OPENERS.has(apostropheWordAt(ts, k)) && !name(k) && !subordinate(k);
  let c = clauseStart(ts, v);
  if (QUESTION_JOINS.has(apostropheWordAt(ts, c)) && c + 1 < v) c++;
  const goesOn =
    c === 0 &&
    (/,[”"’]?\s*$/u.test(r.text.slice(Math.max(0, u.start - 3), u.start)) ||
      ts[0]!.punctBefore.startsWith(','));
  if (!goesOn && opens(c)) return true;
  let s = lastSentenceStart(ts.slice(0, v + 1));
  if (QUESTION_JOINS.has(apostropheWordAt(ts, s)) && s + 1 < c) s++;
  if (s < c && opens(s)) return true;
  const joined = (t: Token) =>
    /[,;…]|\.\.\./u.test(t.punctBefore) && CONJUNCTIONS.has(t.text.toLowerCase());
  return !ts.slice(v + 1, end).some(joined);
}

/**
 * A speech verb that can tag a line: not one that reports what was said with an object of its
 * own ("She nodded and said goodbye.", "She said nothing.").
 */
function tagVerb(r: Lookup, ts: Token[], i: number): boolean {
  const next = ts[i + 1];
  // A capitalised word is a name, not the object: "asked Grace" (but "said grace").
  const object = next && !next.punctBefore && LOWER.test(next.text) ? next.text.toLowerCase() : '';
  // "said no one" is said by nobody: an inverted subject.
  const reports =
    REPORTED_OBJECTS.has(object) &&
    !tagAdverb(ts, i) &&
    !(object === 'no' && ts[i + 2]?.text.toLowerCase() === 'one');
  return !reports && isVerb(r, ts, i);
}

export function isVerb(r: Lookup, ts: Token[], i: number): boolean {
  if (verbAt(ts, i) === undefined) return false;
  return !presentForm(ts[i]!) || presentSubject(r, ts, i);
}

/**
 * Whether the -s form at `v` has a subject: a name, descriptor or pronoun right before it, past
 * adverbs ("Jonah laughs", "the man who calls", "she always tells me"), or before an aside
 * ("Tom, red-faced, shouts"); the subject of the clause it is joined to ("she turns and
 * whispers", "Tom says, and then whispers"); or a person right after it when it opens its clause
 * or follows a fronted phrase ("“Ha!” laughs Jonah", "shouts one of the guards", "From the
 * doorway shouts Tom,"). Nobody in particular is a subject too ("someone sighs", "somebody else
 * mutters", "whispers someone"), and so is someone the lexicon does not know who opens the
 * clause the form ends ("“Sit down,” the teacher snaps."). Without one it is a plural noun:
 * "between sobs", "all demands", "Mom’s cries", "I heard the loud cries.", "Screams echo down
 * the hall."
 */
function presentSubject(r: Lookup, ts: Token[], v: number): boolean {
  const mentions = r.cast.mentions(ts);
  const start = lastSentenceStart(ts.slice(0, v + 1));
  // Joined to the clause before it, unless "and" joins two plural nouns ("between sobs and
  // gasps").
  const join = joinAt(ts, v, start);
  if (join !== -1) {
    const plural = (k: number) =>
      verbAt(ts, k) !== undefined && presentForm(ts[k]!) && !isVerb(r, ts, k);
    let s = start;
    while (s < join && SENTENCE_LEADS.has(ts[s]!.text.toLowerCase())) s++;
    // The subject of the clause it is joined to, or of the sentence: "Somebody laughs, and Mom
    // turns around and whispers". That clause starts before the comma of ", and" ("says Anne,
    // and Tom, and after a moment, adds").
    const clause = clauseBeforeJoin(ts, join, start);
    return (
      !plural(join - 1) &&
      (openingSubject(ts, clause, mentions) !== null ||
        openingSubject(ts, start, mentions) !== null ||
        indefiniteSubject(r, ts, v) ||
        // "The judge bangs his gavel and shouts,"
        nounSubject(ts, s, s + 1, v))
    );
  }
  let b = subjectIndexBefore(ts, v);
  while (b > 0 && FREQUENCY_ADVERBS.has(ts[b]!.text.toLowerCase())) {
    b = subjectIndexBefore(ts, b);
  }
  const before = b === -1 ? undefined : ts[b]!;
  const word = before?.text.toLowerCase() ?? '';
  const after = gluedWordAt(ts, v + 1);
  if (!before || BEFORE_VERB_SKIP.has(word) || LY_ADVERB.test(before.text)) {
    return (
      subjectOf(ts, v, mentions) !== null ||
      indefiniteSubject(r, ts, v) ||
      // "shouts one of the guards", "cries the old woman", but not "Whispers that the king…"
      (DETERMINERS.has(after) && after !== 'that' && after !== 'this') ||
      after === 'one'
    );
  }
  if (NOUN_LEADS.has(word) || before.possessive) return false;
  if (
    isPronoun(before.text) !== undefined ||
    indefiniteAt(ts, b) ||
    RELATIVES.has(word) ||
    word === 'it' ||
    word in SPEAKER_NOUNS ||
    mentions.some((m) => m.last === b && !m.possessive)
  ) {
    return true;
  }
  if (DETERMINERS.has(word)) return false;
  // After a fronted phrase, a person right after the form who ends the clause.
  const inverted = subjectOf(ts, v, mentions);
  const last = inverted?.kind === 'mention' ? inverted.mention.last : -1;
  if (last > v && (!ts[last + 1] || !!ts[last + 1]!.punctBefore)) return true;
  // A determiner and a word or two right before it that open the clause ("“Sit down,” the
  // teacher snaps.", "the old judge sighs").
  return [b - 1, b - 2].some((d) => (d === 0 || !!ts[d]?.punctBefore) && nounSubject(ts, d, b, v));
}

/**
 * Whether the tag at verb `v` is someone else's: a he/she subject ("she asked", "she turned and
 * said") or "someone said". Even unresolved, such a tag never goes to the teller.
 */
export function notTeller(r: Lookup, ts: Token[], v: number, mentions: Mention[]): boolean {
  const subject = subjectOf(ts, v, mentions);
  if (subject) return subject.kind === 'pronoun' && subject.gender !== 'narrator';
  const start = lastSentenceStart(ts.slice(0, v + 1));
  const opening = coordinated(ts, v, start) ? openingSubject(ts, start, mentions) : null;
  if (opening) return opening.kind === 'pronoun' && opening.gender !== 'narrator';
  return indefiniteSubject(r, ts, v);
}

/**
 * "someone said", "said somebody else", "Then someone turned and said": the verb at `v` has
 * nobody in particular for its subject, so its line is the unknown speaker's.
 */
export function indefiniteSubject(r: Lookup, ts: Token[], v: number): boolean {
  const indefinite = (k: number) => INDEFINITE_SUBJECTS.has(wordAt(ts, k));
  // Before the verb, also with "else" after it ("someone else said").
  const b = subjectIndexBefore(ts, v);
  if (b !== -1 && indefiniteAt(ts, b)) return true;
  // Opening the clause it is coordinated with, after lead words ("Then someone"), with no other
  // subject between ("Someone knocked, and Tom went to the door and said" is Tom's). Someone
  // after such a verb is spoken to ("Tom turned and asked someone").
  const start = lastSentenceStart(ts.slice(0, v + 1));
  if (coordinated(ts, v, start)) {
    let s = start;
    while (s < v && SENTENCE_LEADS.has(wordAt(ts, s))) s++;
    return indefinite(s) && !otherSubjectBetween(ts, start, v, r.cast.mentions(ts));
  }
  // After it, past adverbs.
  let a = v + 1;
  while (gluedAt(ts, a) && AFTER_VERB_SKIP.has(wordAt(ts, a))) a++;
  return gluedAt(ts, a) && indefinite(a);
}

/**
 * Whether the word after the speech verb at `i` is an adverb, not what was said: "so" before an
 * -ly word and a clause "that" opens ("I said so quietly that he leaned in", not "Tom had said so
 * early that morning" or "so early that very morning"). "said so" reports.
 */
function tagAdverb(ts: Token[], i: number): boolean {
  if (!gluedAt(ts, i + 1) || !gluedAt(ts, i + 2)) return false;
  const object = wordAt(ts, i + 1);
  // "that very morning", "that same day": a noun of time after "very" or "same".
  const time = (k: number): boolean =>
    ['very', 'same'].includes(wordAt(ts, k))
      ? gluedAt(ts, k + 1) && time(k + 1)
      : TIME_AFTER_THAT.has(wordAt(ts, k));
  return (
    object === 'so' &&
    LY_ADVERB.test(ts[i + 2]!.text) &&
    wordAt(ts, i + 3) === 'that' &&
    gluedAt(ts, i + 3) &&
    gluedAt(ts, i + 4) &&
    gluedAt(ts, i + 5) &&
    !time(i + 4)
  );
}

/** An English -s form ("laughs", "calls"), but not "says" or "asks", which are always verbs. */
function presentForm(t: Token): boolean {
  const word = t.text.toLowerCase();
  return word.endsWith('s') && word !== 'says' && word !== 'asks';
}

/**
 * "“Sit down,” the teacher snaps.", "“You’re late,” my boss tells me.", "The judge bangs his gavel
 * and shouts,": a determiner at `d` and the words after it to `end`, which open their clause (see
 * the callers), as the subject of the -s form at `v`, which ends its clause, maybe after an object
 * ("me", "to me", "him") or an adverb ("quietly"). "I heard the loud cries.", "The loud cries woke her." and "the cries of the gulls"
 * stay nouns, and so does a continuation, which is never the last speaker's when someone else is
 * its subject ("The music resumes.", "the conductor continues").
 */
function nounSubject(ts: Token[], d: number, end: number, v: number): boolean {
  if (d < 0 || !DETERMINERS.has(wordAt(ts, d))) return false;
  for (let k = d + 1; k <= end; k++) {
    if (!gluedAt(ts, k) || !LOWER.test(ts[k]!.text) || DETERMINERS.has(wordAt(ts, k))) return false;
  }
  if (verbAt(ts, v)?.continues) return false;
  const object = (k: number) => BARE_OBJECTS.has(wordAt(ts, k)) || wordAt(ts, k) === 'me';
  let e = v + 1;
  if ((wordAt(ts, e) === 'at' || wordAt(ts, e) === 'to') && gluedAt(ts, e) && object(e + 1)) e++;
  if (gluedAt(ts, e) && object(e)) e++;
  if (gluedAt(ts, e) && LY_ADVERB.test(ts[e]!.text)) e++;
  return !gluedAt(ts, e);
}

/**
 * The word right after the verb at `v`, with nothing but a space between ("asked me"), and the one
 * after it when that word is "to" ("said to me").
 */
export function wordsAfterVerb(
  ts: Token[],
  v: number,
): { nextWord: string | undefined; afterTo: string | undefined } {
  const next = ts[v + 1];
  const nextWord = next && !next.punctBefore ? next.text : undefined;
  const afterTo = nextWord === 'to' ? ts[v + 2]?.text : undefined;
  return { nextWord, afterTo };
}

/** "asked me", "said to me", "I was asked": said to the teller, so not by them. */
export function saidToTeller(ts: Token[], v: number): boolean {
  const { nextWord, afterTo } = wordsAfterVerb(ts, v);
  return nextWord === 'me' || afterTo === 'me' || passiveToTeller(ts, v);
}

/**
 * "I was asked", "I’m also told": said to the teller. No speech verb is an -ing form, so after
 * "was" or "I’m" it is always a passive.
 */
export function passiveToTeller(ts: Token[], v: number): boolean {
  const b = subjectIndexBefore(ts, v);
  const word = ts[b]?.text;
  if (word === 'I’m' || word === "I'm") return true;
  return (word === 'was' || word === 'were') && !ts[b]!.punctBefore && ts[b - 1]?.text === 'I';
}

/** Whether the subject ending at `b` is nobody in particular: "someone", "someone else". */
function indefiniteAt(ts: Token[], b: number): boolean {
  const indefinite = (k: number) => INDEFINITE_SUBJECTS.has(wordAt(ts, k));
  return indefinite(b) || (wordAt(ts, b) === 'else' && !ts[b]!.punctBefore && indefinite(b - 1));
}

/**
 * The "he" or "she" the verb at `v` has for its subject, before or after it ("she said", "said
 * she") or opening the clause it is coordinated with ("she turned and said", "But he shook his
 * head and said"), unless another subject comes between ("She came in, and Tom turned and
 * said").
 */
export function pronounSubject(ts: Token[], v: number, mentions: Mention[]): Gender | undefined {
  const start = lastSentenceStart(ts.slice(0, v + 1));
  const opening = openingSubjectAt(ts, start, mentions);
  const end = opening?.end ?? start;
  return heOrShe(
    subjectOf(ts, v, mentions) ??
      (coordinated(ts, v, start) && !otherSubjectBetween(ts, end, v, mentions)
        ? (opening?.subject ?? null)
        : null),
  );
}
