/** Where time passes in narration, and who arrives when it does. */

import {
  ADDRESSEE_MARKERS,
  APPEARING_WHERE,
  ARRIVALS,
  ARRIVING,
  BARE_OBJECTS,
  CLAUSE_LEADS,
  COORDINATORS,
  DECISION_NOUNS,
  DETERMINERS,
  HABIT_ADVERBS,
  KNOCKING_WHERE,
  NEGATIONS,
  NON_PARTICIPANT_PREPOSITIONS,
  OFFSTAGE_AUXILIARIES,
  OTHER_SUBJECTS,
  QUESTION_LEADS,
  RELATIVES,
  SENTENCE_LEADS,
  SHORT_PAUSES,
  STATE_NOUNS,
  TIME_COMPARISONS,
  TIME_COUNTS,
  TIME_SHIFTS,
  UNTIL,
} from './lexicon';
import { isPronoun, verbAt } from './mentions';
import {
  gluedWordAt,
  lastSentenceStart,
  LOWER,
  LY_ADVERB,
  nameAt,
  phrasesAt,
  sentenceEndAfter,
  wordAt,
  type Mention,
  type Token,
} from './tokens';

/**
 * "In the evening", "Hours later": where time passes. Not after a short pause ("A moment later"),
 * nor in a comparison ("later than usual").
 */
export function timeShifts(ts: Token[]): number[] {
  const pause = (i: number) =>
    i > 0 && !ts[i]!.punctBefore && SHORT_PAUSES.has(ts[i - 1]!.text.toLowerCase());
  const compared = new Set(phrasesAt(ts, TIME_COMPARISONS));
  return phrasesAt(ts, TIME_SHIFTS).filter((i) => !pause(i) && !compared.has(i));
}

/** Where time first passes (see timeShifts), or -1. */
export function timePasses(ts: Token[]): number {
  return timeShifts(ts)[0] ?? -1;
}

/**
 * Where the subject would be after each time shift that opens a sentence: "In the evening she came
 * to see me.", "The next day Anne came.", "A few days later she came.", "Hours later, she
 * came." After three lead words, not when what follows looks ahead ("A few weeks later she would
 * be married").
 */
export function timeOpensSentence(ts: Token[]): number[] {
  return timeShifts(ts).flatMap((i) => {
    let s = i;
    while (s > 0 && i - s < 3 && !ts[s]!.punctBefore && !ts[s]!.sentenceStart) s--;
    if (s !== 0 && !ts[s]!.sentenceStart) return [];
    // A third word before it only counts the time: "A few days later", not "I found out later".
    const counts = ts.slice(s, i).every((t) => TIME_COUNTS.has(t.text.toLowerCase()));
    if (i - s === 3 && !counts) return [];
    const phrase = TIME_SHIFTS.find((p) => p.every((w, k) => ts[i + k]?.text.toLowerCase() === w))!;
    const e = i + phrase.length;
    const punct = ts[e]?.punctBefore;
    if (i - s === 3) {
      const after = ts.slice(e, e + 3).filter((t, k) => k === 0 || !t.punctBefore);
      // A name is no auxiliary or conditional ("A few weeks later May knocked").
      const offstage = (t: Token) =>
        LOWER.test(t.text) && OFFSTAGE_AUXILIARIES.has(t.text.toLowerCase());
      if (after.some(offstage)) return [];
    }
    return punct === undefined || (punct !== '' && punct !== ',') ? [] : [e];
  });
}

/**
 * Where the time phrase whose shift word is at `i` starts, past its own article, count or unit
 * ("the next morning", "an hour later"), leaving a word after the verb at `v`.
 */
export function timePhraseStart(ts: Token[], v: number, i: number): number {
  const unit = /^(?:half|couple|of|or|so|hours?|days?|weeks?|months?|years?|nights?|minutes?)$/u;
  let stop = i;
  while (stop > v + 1 && !ts[stop]!.punctBefore) {
    const w = ts[stop - 1]!.text.toLowerCase();
    if (!DETERMINERS.has(w) && !TIME_COUNTS.has(w) && !unit.test(w)) break;
    stop--;
  }
  return stop;
}

/**
 * "Then Anne came to see me that evening.", "Then Anne came to see me, hours later.", "I went to
 * see Anne the next day.": time passes later in the clause that names the person at `m`, with no
 * pronoun, other person or word that starts another clause in between. When they `came` in
 * themselves, a comma may come between, and an aside between commas ("Then Anne, who had heard
 * the news, came to see me that evening."); when they are only named, nothing may ("I remembered
 * Anne, waiting on the platform that night."). Not "with the bread for the next day" (a
 * preposition before it), "as she always did in the evening" or "came in, still in the coat she
 * had worn that night". "Then Anne and her mother came…" and "I did not see Anne until the next
 * day" count, but not someone who has spoken coming with them ("Then Anne and Tom came in
 * together that evening"), nor a wait that is their own ("Anne did not leave her bed until that
 * evening", unlike "Anne did not come down until…").
 */
export function timeInClause(
  ts: Token[],
  m: Mention,
  came: boolean,
  mentions: Mention[],
  spoken: (x: Mention) => boolean,
): boolean {
  const t = timePasses(ts);
  if (t <= m.last) return false;
  // "I did not see Anne until the next day": a wait that ends then, with a "not" before the
  // person or before a verb of arriving, and no "had" ("Anne had been in bed until that evening"
  // ends no scene), so "until" is a preposition before the time, not another clause.
  const from = lastSentenceStart(ts.slice(0, t + 1));
  const sentence = ts.slice(from, t);
  const negated = (x: Token) => NEGATIONS.has(x.text.toLowerCase()) || /n['’]t$/u.test(x.text);
  const n = sentence.findIndex(negated);
  let a = from + n + 1;
  while (a < t && ['not', 'even', 'actually'].includes(wordAt(ts, a))) {
    a++;
  }
  // Being back or seen again ends a wait as coming does: "Anne was not back until", "Anne didn't
  // get home until", "Anne didn't make it back until", "Anne didn't make it here until", "Anne
  // didn't make it to the house until" (not "to the top of the hill").
  const madeIt =
    wordAt(ts, a) === 'make' &&
    wordAt(ts, a + 1) === 'it' &&
    (['back', 'home', 'here', 'there', 'over'].includes(wordAt(ts, a + 2)) ||
      (wordAt(ts, a + 2) === 'to' && ![a + 4, a + 5].some((k) => wordAt(ts, k) === 'of')));
  const back =
    ['home', 'back'].includes(wordAt(ts, a)) ||
    (wordAt(ts, a) === 'get' && ['back', 'home', 'there', 'in'].includes(wordAt(ts, a + 1))) ||
    madeIt;
  const arrival = ARRIVALS.has(wordAt(ts, a)) || ARRIVING.has(wordAt(ts, a)) || back;
  const waits =
    n !== -1 &&
    (from + n < m.first || arrival) &&
    // A name is no auxiliary ("I did not see May until", "Will did not come back until"), nor is
    // "could" right before the negation ("Anne could not make it back until", as "couldn't").
    !sentence.some(
      (x, j) =>
        OFFSTAGE_AUXILIARIES.has(x.text.toLowerCase()) &&
        !nameAt(ts, from + j, mentions) &&
        !(x.text.toLowerCase() === 'could' && j + 1 === n),
    );
  // "Anne had been crying all that evening": a time before the scene, not one it moves to (but
  // "Anne had arrived that evening", "Anne had come back that evening" bring her in).
  const aux = ts[m.last + 1];
  const participle = wordAt(ts, m.last + 2);
  // So is a participle of moving with a word of direction right before the time or a place it
  // came from ("Anne had driven over that evening", "Anne had driven down the next morning", "Anne
  // had walked over from the farm that evening", "Anne had dropped by that evening"; not "Anne had
  // walked over the hills all that evening", "Anne had walked over to the window that evening",
  // "Anne had given in that evening", "Anne had sat by the fire that evening", "Anne had stayed
  // home that evening").
  const toward = m.last + 3;
  const moved =
    [
      'over',
      'back',
      'round',
      'around',
      'across',
      'by',
      'in',
      'home',
      'down',
      'up',
      'here',
    ].includes(wordAt(ts, toward)) &&
    !!ts[toward] &&
    !ts[toward]!.punctBefore &&
    [
      'walked',
      'driven',
      'ridden',
      'run',
      'hurried',
      'rushed',
      'raced',
      'dashed',
      'flown',
      'sailed',
      'rowed',
      'cycled',
      'travelled',
      'traveled',
      'wandered',
      'strolled',
      'dropped',
      'popped',
      'stopped',
      'motored',
      'galloped',
      'marched',
      'crept',
      'slipped',
    ].includes(participle) &&
    (toward + 1 === timePhraseStart(ts, toward, t) ||
      ['from', 'with'].includes(wordAt(ts, toward + 1)));
  const arriving =
    ARRIVALS.has(participle) ||
    ARRIVING.has(participle) ||
    ['got', 'gotten', 'turned', 'shown', 'made'].includes(participle) ||
    moved;
  if (!waits && aux && !aux.punctBefore && aux.text === 'had' && !arriving) return false;
  const untilTime = (k: number) =>
    waits &&
    UNTIL.has(ts[k]!.text.toLowerCase()) &&
    // "until the next day", "until an hour later"
    (k + 1 === t || k + 1 === timePhraseStart(ts, k, t));
  const stops = (k: number) => {
    const word = ts[k]!.text.toLowerCase();
    if (untilTime(k)) return false;
    // "Anne and her mother came": the person joined to them, not another clause's subject.
    if (
      k === m.last + 1 &&
      COORDINATORS.has(word) &&
      mentions.some((x) => x.first === k + 1 && !spoken(x))
    ) {
      return false;
    }
    return (
      mentions.some((x) => x.first === k) ||
      isPronoun(ts[k]!.text) !== undefined ||
      OTHER_SUBJECTS.has(word) ||
      CLAUSE_LEADS.has(word) ||
      RELATIVES.has(word) ||
      COORDINATORS.has(word) ||
      QUESTION_LEADS.has(word)
    );
  };
  for (let k = m.last + 1; k < t; k++) {
    if (k === m.last + 2 && COORDINATORS.has(ts[k - 1]!.text.toLowerCase())) {
      const joined = mentions.find((x) => x.first === k);
      if (joined && !spoken(joined)) {
        k = joined.last;
        continue;
      }
    }
    if (ts[k]!.punctBefore) {
      if (ts[k]!.punctBefore !== ',' || !came) return false;
      let j = k + 1;
      while (j < t && !ts[j]!.punctBefore) j++;
      if (ts[j]!.punctBefore === ',') {
        // An aside with nobody else in it: "Anne, who had heard the news, came".
        if (mentions.some((x) => x.first >= k && x.first < j)) return false;
        k = j;
        if (k === t) break;
      }
    }
    if (stops(k)) return false;
  }
  const punct = ts[t]!.punctBefore;
  if (punct && (punct !== ',' || !came)) return false;
  // "for the next day": the time of something else; but "came in that evening".
  const before = wordBeforeTime(ts, t);
  return (
    (before === 'in' ||
      (waits && UNTIL.has(before)) ||
      !NON_PARTICIPANT_PREPOSITIONS.has(before)) &&
    !ADDRESSEE_MARKERS.has(before)
  );
}

/**
 * Where the subject of the sentence holding token `i` would be: past the lead words that open it
 * ("Then", "And then"; a later one only with nothing but a space before it), never past `i`.
 */
export function subjectAfterLeads(ts: Token[], i: number): number {
  const s = lastSentenceStart(ts.slice(0, i + 1));
  let e = s;
  while (e < i && SENTENCE_LEADS.has(wordAt(ts, e)) && (e === s || !ts[e]!.punctBefore)) e++;
  return e;
}

/**
 * The subjects of sentences in which time passes later in the subject's own clause, with no other
 * clause, comma or preposition such as "for" before it: "She arrived that evening.", "Anne came
 * to see me in the evening.". Each is the subject's index, its mention and where its verb is.
 * Only someone arriving counts (see ARRIVALS and arrives): not "She used to wait in the evening",
 * "She was leaving the next day", nor "She came with the bread for the next day", a habit ("She
 * usually came in the evening"), another clause's time ("She came to tell me what had happened
 * that night") or someone else's report ("She came that evening, Tom said, because…").
 */
export function timeLaterInSentence(
  ts: Token[],
  mentions: Mention[],
  spoken: (x: Mention) => boolean,
): { e: number; named: Mention | undefined; v: number }[] {
  return timeShifts(ts).flatMap((i) => {
    const e = subjectAfterLeads(ts, i);
    if (e >= i) return [];
    const pronoun = isPronoun(ts[e]!.text);
    const named = mentions.find((m) => m.first === e && !m.possessive);
    if (!pronoun && !named) return [];
    // The verb right after the subject, past -ly adverbs, is one of arriving.
    let v = named ? named.last + 1 : e + 1;
    // "Then Anne herself came to see me that evening."
    const skips = (t: Token) => LY_ADVERB.test(t.text) || ['herself', 'himself'].includes(t.text);
    while (v < i && (v === e || !ts[v]!.punctBefore) && skips(ts[v]!)) v++;
    // A habit ("She usually came in the evening"), but "only" before one evening is not ("She
    // only came that evening", unlike "She only came in the evening").
    const habit = (t: Token) =>
      HABIT_ADVERBS.has(t.text.toLowerCase()) &&
      (t.text.toLowerCase() !== 'only' || wordAt(ts, i) === 'in');
    if (ts.slice(e, v).some(habit)) return [];
    if (v >= i || (v > e && ts[v]!.punctBefore)) return [];
    if (!ARRIVALS.has(ts[v]!.text.toLowerCase())) return [];
    if (!arrives(ts, v, i)) return [];
    // "She came most days in the evening", "every week", "each time".
    const often = (k: number) =>
      ['most', 'every', 'each'].includes(wordAt(ts, k)) &&
      /^(?:days?|nights?|evenings?|mornings?|afternoons?|weeks?|times?|other|sunday|week-?end)$/u.test(
        wordAt(ts, k + 1),
      );
    for (let k = v + 1; k < i; k++) if (often(k)) return [];
    if (ts[i]!.punctBefore) return [];
    // Someone named between the verb and the time is another clause's, but not a companion who
    // has not spoken ("She came with her mother that evening").
    const other = (k: number) =>
      mentions.some((m) => m.first === k && (spoken(m) || wordAt(ts, k - 1) !== 'with'));
    for (let k = v; k < i; k++) {
      const w = ts[k]!.text.toLowerCase();
      if (
        (k > e && ts[k]!.punctBefore) ||
        (CLAUSE_LEADS.has(w) && !nameAt(ts, k, mentions)) ||
        RELATIVES.has(w) ||
        COORDINATORS.has(w) ||
        (k > v && other(k))
      ) {
        return [];
      }
    }
    // A question word or an auxiliary between them: "She came to ask what I wanted that
    // evening", "She would come the next day". Not "or" or "so", nor "how I was" right before the
    // time phrase ("She came round to see how I was that evening", "... the next morning").
    const time = timePhraseStart(ts, v, i);
    const asks = (k: number) =>
      QUESTION_LEADS.has(wordAt(ts, k)) &&
      wordAt(ts, k) !== 'or' &&
      wordAt(ts, k) !== 'so' &&
      !(
        wordAt(ts, k) === 'how' &&
        (!!isPronoun(ts[k + 1]?.text ?? '') || ['we', 'they', 'you'].includes(wordAt(ts, k + 1))) &&
        ['was', 'were'].includes(wordAt(ts, k + 2)) &&
        k + 3 === time
      );
    for (let k = v + 1; k < i; k++) {
      if (asks(k) || (OFFSTAGE_AUXILIARIES.has(wordAt(ts, k)) && !nameAt(ts, k, mentions))) {
        return [];
      }
    }
    const before = wordBeforeTime(ts, i);
    if (
      (before !== 'in' && NON_PARTICIPANT_PREPOSITIONS.has(before)) ||
      ADDRESSEE_MARKERS.has(before)
    ) {
      return [];
    }
    if (reportedAfter(ts, i)) return [];
    return [{ e, named, v }];
  });
}

/**
 * Whether the verb of arriving at `v` (before the time at `i`) is used as one: "She appeared at the
 * gate", "knocked twice", "called on me", not "She appeared tired", "appeared in better spirits",
 * "knocked the ash", "showed no sign", "called her mother", "returned the book" or "came to a
 * decision". The time phrase's own article, count or unit is no word after the verb ("She
 * appeared the next morning").
 */
export function arrives(ts: Token[], v: number, i: number): boolean {
  const stop = timePhraseStart(ts, v, i);
  const word = (k: number) =>
    k < stop && ts[k] && !ts[k]!.punctBefore ? ts[k]!.text.toLowerCase() : '';
  const verb = ts[v]!.text.toLowerCase();
  const next = word(v + 1);
  if (!next) return true;
  if (verb === 'appeared') {
    const state = ts.slice(v + 1, i).some((t) => STATE_NOUNS.has(t.text.toLowerCase()));
    return (APPEARING_WHERE.has(next) || LY_ADVERB.test(next)) && !state;
  }
  if (verb === 'knocked' || verb === 'showed' || verb === 'called') {
    // "knocked a little after nine"
    const little =
      next === 'a' && word(v + 2) === 'little' && ['after', 'before', 'past'].includes(word(v + 3));
    return little || KNOCKING_WHERE.has(next) || LY_ADVERB.test(next);
  }
  if (verb === 'returned' && (DETERMINERS.has(next) || BARE_OBJECTS.has(next))) return false;
  if (verb === 'came' && next === 'down' && word(v + 2) === 'with') return false;
  const decision =
    ['to', 'at'].includes(next) &&
    ['a', 'an'].includes(word(v + 2)) &&
    DECISION_NOUNS.has(word(v + 3));
  return !((verb === 'came' || verb === 'arrived') && decision);
}

/** "She came to love the place", "came to understand": becoming, not arriving. */
export function becomes(ts: Token[], v: number): boolean {
  return (
    gluedWordAt(ts, v) === 'came' &&
    gluedWordAt(ts, v + 1) === 'to' &&
    [
      'love',
      'like',
      'hate',
      'know',
      'understand',
      'realize',
      'realise',
      'believe',
      'think',
      'feel',
      'accept',
      'appreciate',
      'regret',
      'trust',
      'respect',
      'enjoy',
      'prefer',
      'fear',
      'dread',
      'expect',
      'depend',
      'rely',
      'resent',
      'admire',
      'miss',
    ].includes(gluedWordAt(ts, v + 2))
  );
}

/** A verb of coming back: "returned", "came back". */
export function returns(ts: Token[], v: number): boolean {
  const word = wordAt(ts, v);
  return word === 'returned' || (word === 'came' && gluedWordAt(ts, v + 1) === 'back');
}

/**
 * Whether a short aside with a speech verb follows the time at `i` in its sentence ("She came that
 * evening, Tom said, because her house was cold"): someone else's report, not the arrival itself.
 * The teller's own "I think" and "as I said" are no report ("She came back the next day, I
 * thought.", "She arrived that evening, as I said, soaked to the skin").
 */
function reportedAfter(ts: Token[], i: number): boolean {
  const stop = sentenceEndAfter(ts, i);
  for (let k = i + 1; k < stop; k++) {
    const lead = ts[k]!.text.toLowerCase();
    if (ts[k]!.punctBefore !== ',' || COORDINATORS.has(lead)) continue;
    if (lead === 'as') continue;
    for (let j = k + 1; j < Math.min(stop, k + 3); j++) {
      if (ts[j]!.punctBefore) break;
      const verb = verbAt(ts, j);
      const hedge = ['i', 'we'].includes(lead) && !!verb?.thought;
      if (verb && !hedge && (j + 1 >= stop || !!ts[j + 1]!.punctBefore)) return true;
    }
  }
  return false;
}

/**
 * Where time first passes (see timePasses) when a wait ends there: "until" or "till" comes right
 * before it, maybe with a determiner between ("until later", "until the next day"); else -1.
 */
export function untilTimeAt(ts: Token[]): number {
  const t = timePasses(ts);
  const until =
    t > 0 &&
    (UNTIL.has(wordAt(ts, t - 1)) ||
      (DETERMINERS.has(wordAt(ts, t - 1)) && UNTIL.has(wordAt(ts, t - 2))));
  return until ? t : -1;
}

/** The word before the time phrase at `t`, past a determiner: "for" in "for the next day". */
function wordBeforeTime(ts: Token[], t: number): string {
  let p = t - 1;
  if (DETERMINERS.has(wordAt(ts, p))) p--;
  return wordAt(ts, p);
}
