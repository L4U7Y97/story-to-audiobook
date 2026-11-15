/** A line's tag, or the action beat beside it: who says the line, in what tone, to whom. */

import type { Gender, ToneLabel } from '@/format/types';
import type { Unit } from '../units';
import { ADVERB_TONES, REFLEXIVES, SENTENCE_LEADS, type VerbInfo } from './lexicon';
import { isPronoun, subjectOf, verbAt } from './mentions';
import type { Reading, Who } from './reading';
import { coordinatedSubject, sentenceSubject } from './subjects';
import {
  indefiniteSubject,
  isVerb,
  nearTag,
  notTeller,
  pronounSubject,
  saidToTeller,
  TAG_WINDOW,
  wordsAfterVerb,
} from './tagVerbs';
import {
  addressedIn,
  afterPreposition,
  firstSentenceEnd,
  lastSentenceStart,
  type Mention,
  type Token,
} from './tokens';

interface Tag {
  verb: VerbInfo;
  tone?: ToneLabel;
  speaker?: string;
  /**
   * A he/she subject ("she said", or "she turned and said" with no "she" found yet), resolved
   * once the whole paragraph has been read.
   */
  pending?: Gender;
  /** The subject is the teller's "I" ("I said", "I … and said"), not a name. */
  teller: boolean;
  /** "asked me": said to the teller, so not by them. */
  toTeller: boolean;
  /** "she asked", "someone said": someone other than the teller (see notTeller). */
  notTeller: boolean;
  /** "I told myself": talking to oneself is thinking. */
  thought: boolean;
  /** Other people named in the tag. */
  others: string[];
  /** People the line is said to ("to Anne", "asked Holmes"): never its speaker. */
  addressees: string[];
}

/** The tag for the voiced unit at `n`: in the narration right after it, else right before. */
export function tagNear(
  r: Reading,
  units: Unit[],
  n: number,
  tokens: Map<Unit, Token[]>,
  isVoiced: (u: Unit) => boolean,
): Tag | undefined {
  return nearTag(
    r,
    units,
    n,
    tokens,
    isVoiced,
    (ts, v) => tagIn(r, ts, v),
    (tag) => !!tag && (!!tag.speaker || !!tag.pending),
  );
}

function tagIn(r: Reading, ts: Token[], verbIndex: number): Tag | undefined {
  if (verbIndex === -1) return undefined;
  const verb = verbAt(ts, verbIndex)!;
  const mentions = r.cast.mentions(ts);
  const others = mentions.filter((m) => !afterPreposition(ts, m)).map((m) => r.cast.resolve(m));
  const adverb = ts
    .slice(0, TAG_WINDOW + 4)
    .map((t) => ADVERB_TONES[t.text.toLowerCase()])
    .find(Boolean);
  const subject = subjectOf(ts, verbIndex, mentions);
  const { nextWord, afterTo } = wordsAfterVerb(ts, verbIndex);
  const toTeller = saidToTeller(ts, verbIndex);
  // Reflexive speech is thought.
  const thought = REFLEXIVES.has(nextWord ?? '') || REFLEXIVES.has(afterTo ?? '');

  let speaker: string | undefined;
  let pending: Gender | undefined;
  // Whether the teller's "I" names the speaker, not a name ("said Nick" for a narrator Nick).
  let teller = false;
  if (subject?.kind === 'mention') speaker = r.cast.resolve(subject.mention, true);
  else if (subject?.gender === 'narrator') {
    speaker = r.cast.narratorKey;
    teller = true;
  } else if (subject) pending = subject.gender;
  // "someone said": nobody in particular.
  else if (indefiniteSubject(r, ts, verbIndex)) speaker = r.cast.unknownKey;
  else {
    const start = lastSentenceStart(ts.slice(0, verbIndex + 1));
    const who = coordinatedSubject(r, ts, verbIndex, start, mentions);
    speaker = who?.key;
    teller = !!who?.teller;
    // "she turned and said" with no "she" found yet is read like "she said".
    if (!who) pending = pronounSubject(ts, verbIndex, mentions);
  }
  if (toTeller && speaker === r.cast.narratorKey) speaker = undefined;

  const preverbal =
    subject?.kind === 'mention'
      ? subject.mention.last < verbIndex
      : !!subject && isPronoun(ts[verbIndex - 1]?.text ?? '') !== undefined;
  // "to Anne", or the person right after the verb when the subject came first ("I asked Holmes").
  const addressees = mentions
    .filter(
      (m) =>
        addressedIn(ts, m) || (preverbal && m.first === verbIndex + 1 && !ts[m.first]!.punctBefore),
    )
    .map((m) => r.cast.resolve(m));
  // "she asked him": the man in the scene is the one spoken to.
  if (preverbal && (nextWord === 'him' || nextWord === 'her')) {
    const exclude = new Set(speaker ? [speaker] : []);
    const person = r.turns.byGender(nextWord === 'him' ? 'male' : 'female', exclude);
    if (person) addressees.push(person);
  }
  return {
    verb,
    tone: verb.tone ?? adverb,
    ...(speaker ? { speaker } : {}),
    ...(pending ? { pending } : {}),
    teller: teller && speaker === r.cast.narratorKey,
    toTeller,
    notTeller: notTeller(r, ts, verbIndex, mentions),
    thought,
    others,
    addressees,
  };
}

/** "Tom shrugged. “Nowhere.”": the subject of the narration sentence right before line `n`. */
export function beatBefore(
  r: Reading,
  units: Unit[],
  n: number,
  tokens: Map<Unit, Token[]>,
  isVoiced: (u: Unit) => boolean,
): Who | undefined {
  const before = units[n - 1];
  if (!before || isVoiced(before)) return undefined;
  const ts = tokens.get(before)!;
  return beatSubject(r, ts.slice(lastSentenceStart(ts)));
}

/** "“Hello.” Anne smiled. “How are you?”": narration between two lines names their speaker. */
export function beatAfter(
  r: Reading,
  units: Unit[],
  n: number,
  tokens: Map<Unit, Token[]>,
  isVoiced: (u: Unit) => boolean,
): Who | undefined {
  const after = units[n + 1];
  const next = units[n + 2];
  if (!after || isVoiced(after) || !next || !isVoiced(next)) return undefined;
  const ts = tokens.get(after)!;
  return beatSubject(r, ts.slice(0, firstSentenceEnd(ts)));
}

/** The subject of a beat sentence with no speech verb that names nobody else. */
function beatSubject(r: Reading, sentence: Token[]): Who | undefined {
  if (sentence.some((_, k) => isVerb(r, sentence, k))) return undefined;
  const mentions = r.cast.mentions(sentence);
  // A beat never introduces a name.
  const subject = sentenceSubject(r, sentence, 0, mentions, true);
  if (!subject) return undefined;
  const leading = (m: Mention) =>
    sentence.slice(0, m.first).every((t) => SENTENCE_LEADS.has(t.text.toLowerCase()));
  return mentions.some((m) => !leading(m)) ? undefined : subject;
}
