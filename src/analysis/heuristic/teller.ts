/** The first-person teller: their "I", their own name, and whether they take part. */

import { groupByParagraph, type Unit } from '../units';
import {
  authorialTeller,
  coordinated,
  isTeller,
  openingSubject,
  otherSubjectBetween,
} from './clauses';
import {
  ASIDES,
  DETERMINERS,
  FIRST_PERSON_WORDS,
  NAME_OWNERS,
  NAME_QUESTIONS,
  NAME_WORDS,
  NICKNAME_QUALIFIERS,
  SELF_INTRODUCTIONS,
} from './lexicon';
import { read } from './lines';
import { isPronoun, subjectIndexBefore, subjectOf, tokenize, verbAt } from './mentions';
import type { Lookup } from './reading';
import { beforeVerb, nearTag, saidToTeller } from './tagVerbs';
import {
  clauseStart,
  gluedAt,
  lastSentenceStart,
  LOWER,
  phraseAt,
  wordAt,
  type Mention,
  type Token,
} from './tokens';

/**
 * Whether some speech in this part is tagged by the teller ("I said", "said I", "I ask.", "I
 * turned to her and said:") or said to them ("asked me", "I was asked").
 * Reads the verbs the tagger reads, never creating characters, so a sentence next to a line
 * whose tag names someone else is none ("I said nothing. “Eat,” Mom said."), and neither is an
 * aside about what someone says ("Mrs. Bennet was nervous, as my aunt told me.").
 */
export function findTellerTag(r: Lookup, partUnits: readonly Unit[]): boolean {
  const tellerTag = (ts: Token[], v: number) =>
    v !== -1 &&
    (firstPersonTag(r, ts, v) || saidToTeller(ts, v)) &&
    !inOthersThought(r, ts, v) &&
    !inAside(ts, v);
  // A colon intro in its own paragraph introduces the lines of the next one.
  let intro: { ts: Token[]; v: number } | undefined;
  for (const units of groupByParagraph(partUnits)) {
    // Plain narration has no lines, so only its colon intro is read.
    const lines = units.some((u) => u.kind !== 'narration') ? read(r, units, false) : undefined;
    if (!lines || !units.some(lines.isVoiced)) {
      const last = units.at(-1)!;
      const ts = r.slice(last).trimEnd().endsWith(':')
        ? (lines?.tokens.get(last) ?? tokenize(r.slice(last)))
        : undefined;
      intro = ts && { ts, v: beforeVerb(r, last, ts) };
      continue;
    }
    if (intro && tellerTag(intro.ts, intro.v)) return true;
    intro = undefined;
    const { tokens, isVoiced } = lines;
    // Each line's tag, from the narration after it or before it as the tagger chooses.
    for (const [n, u] of units.entries()) {
      if (!isVoiced(u)) continue;
      const tag = nearTag(
        r,
        units,
        n,
        tokens,
        isVoiced,
        (ts, v) => (v === -1 ? undefined : { ts, v }),
        (at) => !!at && names(r, at.ts, at.v),
      );
      if (tag && tellerTag(tag.ts, tag.v)) return true;
    }
  }
  return false;
}

/**
 * Whether tagIn would find who says the tag at verb `v` (a name, a pronoun or "I"), without
 * resolving anyone.
 */
function names(r: Lookup, ts: Token[], v: number): boolean {
  const mentions = r.cast.mentions(ts);
  const subject = subjectOf(ts, v, mentions);
  if (isTeller(subject)) {
    return !saidToTeller(ts, v);
  }
  if (subject) return true;
  const start = lastSentenceStart(ts.slice(0, v + 1));
  return coordinated(ts, v, start) && !!openingSubject(ts, start, mentions);
}

/**
 * Whether the tag at verb `v` has the teller's "I" for its subject: "I said", "I turned to her
 * and said". It reads the subject as tagIn does, without resolving anyone.
 * A sentence-opening "I" is not taken across another subject ("I suppose she sighed and said",
 * "I think Mrs. Bennet turned and said"), nor after the teller's "I suppose" or "I must", where
 * the subject may be one no mention shows (see authorialTeller).
 */
function firstPersonTag(r: Lookup, ts: Token[], v: number): boolean {
  const mentions = r.cast.mentions(ts);
  const subject = subjectOf(ts, v, mentions);
  if (subject) return isTeller(subject);
  const start = lastSentenceStart(ts.slice(0, v + 1));
  return (
    coordinated(ts, v, start) &&
    isTeller(openingSubject(ts, start, mentions)) &&
    !authorialTeller(ts, start, v) &&
    !otherSubjectBetween(ts, start, v, mentions)
  );
}

/**
 * "“It’s late.” She told me that every night, Tom thought.": a tag inside someone else's
 * thought, whose "I" and "me" are theirs, not the teller's.
 */
function inOthersThought(r: Lookup, ts: Token[], v: number): boolean {
  const mentions = r.cast.mentions(ts);
  for (let w = v + 1; w < ts.length && !ts[w]!.sentenceStart; w++) {
    if (!verbAt(ts, w)?.thought) continue;
    const subject = subjectOf(ts, w, mentions);
    if (!subject || isTeller(subject)) continue;
    // The thought tag is a clause of its own: ", Tom thought.", ", thought he,".
    let first = w;
    let last = w;
    const b = subjectIndexBefore(ts, w);
    if (subject.kind === 'mention') {
      if (subject.mention.last < w) first = subject.mention.first;
      else last = subject.mention.last;
    } else if (b !== -1 && isPronoun(ts[b]!.text)) first = b;
    else last = w + 1;
    const after = ts[last + 1];
    if (ts[first]!.punctBefore === ',' && (!after || !!after.punctBefore)) return true;
  }
  return false;
}

/** "as my aunt told me": the clause of the verb at `v` is an aside. */
function inAside(ts: Token[], v: number): boolean {
  const c = clauseStart(ts, v);
  return ASIDES.some((words) => phraseAt(ts, c, words));
}

export function isFirstPerson(ts: Token[], i: number): boolean {
  const t = ts[i]!.text;
  if (FIRST_PERSON_WORDS.has(t)) return true;
  // "I" before a lower-case word in the same sentence ("I ran"), not "I." or "I, Claudius".
  const next = ts[i + 1];
  return t === 'I' && !!next && !next.punctBefore && LOWER.test(next.text);
}

/**
 * "Call me Ishmael", "they call me the old man": the teller's own name or nickname, right after
 * the phrase or after a pause, an opening quote or emphasis ("My name is… Kit", "called me
 * *Kit*", "_the old man_"). After a dash, a colon or a closing parenthesis it is the name only
 * when it ends its clause, a short phrase that qualifies it included ("called me—the girl with
 * the red hair—and", not "called me—my uncle was waiting"), and after a question only when the
 * question asks for it ("What did they call me? The old man.", not "Who called me? My uncle.").
 * A name after a comma or in the next sentence is not what the teller is called ("called me,
 * Davy too", "Mother called me. My uncle was at the table."), nor is a possessive ("called me
 * Tom’s shadow").
 */
export function selfIntroduced(ts: Token[], m: Mention): boolean {
  if (m.possessive) return false;
  const after = ts[m.last + 1];
  const endsClause = !after || !!after.punctBefore;
  const phrase = SELF_INTRODUCTIONS.find((words) => phraseAt(ts, m.first - words.length, words));
  if (!phrase) return false;
  // What stands between the phrase and the name, quotes and emphasis marks aside; a dash after a
  // question mark is part of the question ("call me?—the old man"), and one after a colon part of
  // the colon before a nickname ("called me:—the old man"), not before a name ("called me:—Mr.
  // Collins, from the hall").
  const separator = ts[m.first]!.punctBefore;
  const punct = separator
    .replace(/['‘*_]{1,3}$/u, '')
    .replace(/^\?(?:—|―|–|--?)$/u, '?')
    .replace(/^:(?:—|―|–|--?)$/u, m.kind === 'descriptor' ? ':' : '$&');
  const ends = endsClause || qualifiedNickname(ts, m);
  if (punct === '' || punct === '…' || punct === '...') return true;
  if (!ends) return false;
  if (/^(?:—|―|–|--?|:|\))$/u.test(punct)) return true;
  if (punct !== '?') return false;
  const opens = m.first - phrase.length;
  const question = lastSentenceStart(ts.slice(0, opens + 1));
  // "Who knew my name well enough to have called me?" asks for a person, not a name.
  const who = ['who', 'whom'].includes(wordAt(ts, question));
  for (let k = question; k < opens; k++) {
    if (NAME_QUESTIONS.has(wordAt(ts, k))) return true;
    if (!who && NAME_WORDS.has(wordAt(ts, k)) && !NAME_OWNERS.has(wordAt(ts, k + 1))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the teller's nickname at `m` ends its clause after a short phrase that qualifies it:
 * "the old man of the lighthouse.", "the girl with the red hair—". A name ends such a phrase, so a
 * verb after it goes on from the person, and so does one after a word or two ("my uncle with his
 * coat on was").
 */
function qualifiedNickname(ts: Token[], m: Mention): boolean {
  const ends = (k: number) => !gluedAt(ts, k);
  let k = m.last + 1;
  if (!gluedAt(ts, k) || !NICKNAME_QUALIFIERS.has(ts[k]!.text.toLowerCase())) return false;
  k++;
  if (gluedAt(ts, k) && !LOWER.test(ts[k]!.text)) {
    while (gluedAt(ts, k) && !LOWER.test(ts[k]!.text)) k++;
    return ends(k);
  }
  if (gluedAt(ts, k) && ts[k]!.text.toLowerCase() in DETERMINERS) k++;
  for (let n = 0; n < 2 && gluedAt(ts, k); n++) if (ends(++k)) return true;
  return false;
}
