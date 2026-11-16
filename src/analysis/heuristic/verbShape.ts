/** Whether the word after a subject is its verb, judged by the shape of a finite verb. */

import {
  ADDRESSEE_MARKERS,
  AUXILIARIES,
  BEFORE_VERB_PAIRS,
  BEFORE_VERB_SKIP,
  COORDINATORS,
  DETERMINERS,
  FINITE_FORMS,
  NON_PARTICIPANT_PREPOSITIONS,
  NOUN_LIKE_PASTS,
  PHRASE_AFTER_PERSON,
  SELF_WORDS,
  SUBJECT_ADVERBS,
  SUBJECT_PRONOUNS,
  VERB_ADVERBS,
} from './lexicon';
import { verbAt } from './mentions';
import { LOWER, LY_ADVERB, pastLyAdverbs, UPPER, wordAt, type Token } from './tokens';

/**
 * Where the verb after the subject that ends at `end` is, before the join at `join`, or -1: past
 * adverbs ("and Anne only sighed", "and Anne too smiled"), a lower-case word that is not an
 * article, a preposition, a gerund or a word such as "beside" or "included" ("Anne at his side",
 * "her mother still watching us", "Jane included"). A set phrase may come first ("Anne at last
 * looked up"), and so may a phrase with the verb a few words after it ("the old man by the fire
 * looked up"; see verbAfterPhrase, which takes any tense when the stretch is `open`). After a name
 * or a descriptor (`named`), in a stretch that runs to a comma before the join, an English verb
 * has a verb's shape (see finiteShape: "Anne smiled", "Anne cast a glance", not "Anne still pale"
 * or "Anne opposite").
 */
export function verbAfterSubject(
  ts: Token[],
  end: number,
  join: number,
  named: boolean,
  open = false,
  present = true,
  clause = false,
): number {
  const word = (k: number) => ts[k]!.text.toLowerCase();
  const glued = (k: number) => k < join && !!ts[k] && !ts[k]!.punctBefore;
  const skip = (k: number) => {
    while (
      glued(k) &&
      (LY_ADVERB.test(ts[k]!.text) ||
        BEFORE_VERB_SKIP.has(word(k)) ||
        SUBJECT_ADVERBS.has(word(k)) ||
        // "and Anne once more smiled", "and Anne all but ran"
        (word(k) === 'more' && word(k - 1) === 'once') ||
        (word(k) === 'all' && word(k + 1) === 'but' && glued(k + 1)) ||
        (word(k) === 'but' && word(k - 1) === 'all' && k - 1 > end))
    ) {
      k++;
    }
    return k;
  };
  let k = skip(end + 1);
  if (!glued(k) || !LOWER.test(ts[k]!.text)) return -1;
  if (glued(k + 1) && BEFORE_VERB_PAIRS.has(`${word(k)} ${word(k + 1)}`)) {
    k = skip(k + 2);
    if (!glued(k) || !LOWER.test(ts[k]!.text)) return -1;
  } else if (opensPhrase(word(k))) {
    // After a subject pronoun, which is never an object, an open stretch has its verb whatever its
    // shape ("and I without a word give him the letter and say").
    const after = verbAfterPhrase(ts, k, join, open, present);
    return after === -1 && open && !named ? k : after;
  }
  const w = word(k);
  // The shape test is for a stretch that runs to a comma before the join ("Anne still pale, and
  // said"); before a join with no comma the stretch has its verb ("and Anne herself opened the
  // door and said", "and Anne almost cried and said").
  if (named && !!ts[join]!.punctBefore) {
    if (endsObject(ts, k) || PHRASE_AFTER_PERSON.has(w)) return -1;
    // After an auxiliary any word goes on with the verb ("Anne could not believe it").
    const auxiliary = ts.slice(end + 1, k).some((t) => AUXILIARIES.has(t.text.toLowerCase()));
    // A past that is also a participle takes its object when it is a verb ("Anne cast a glance",
    // "Anne bound up the wound", "Anne spoilt everything"; not "Tom bound hand and foot", "Anne
    // spoilt and sulky"), and is no verb before a phrase of its own ("Anne bound for London,",
    // "Anne cast in shadow,", "Anne wound up in her shawl,"; but "Anne ground to a halt,", "Anne
    // wound through the crowd,", "Anne knit in silence,", "Anne cast off,").
    const object = (j: number) =>
      DETERMINERS.has(word(j)) ||
      UPPER.test(ts[j]!.text) ||
      [
        'him',
        'her',
        'them',
        'me',
        'us',
        'it',
        'its',
        'everything',
        'nothing',
        'something',
        'anything',
        'everyone',
        'all',
        'both',
      ].includes(word(j));
    // After "quite", "rather" or "all but" an -ed word is a state ("Anne quite exhausted,", "Anne
    // rather flushed with the heat,", "Anne all but finished with her packing,") unless it takes an
    // object ("Anne rather liked it,", "Anne rather liked and trusted him,", "Anne quite agreed
    // with him,") or is "agreed" ("Anne quite agreed,").
    const degree =
      ['quite', 'rather'].includes(word(k - 1)) || (word(k - 1) === 'but' && word(k - 2) === 'all');
    // Verbs that are seldom a state are exempt, as "agreed" is ("Anne rather objected,", "Anne all
    // but fainted,"), and a "that" after the word is its object ("Anne rather feared that he had
    // heard,").
    if (
      degree &&
      !clause &&
      /\p{Ll}ed$/u.test(w) &&
      !/^(?:agreed|disagreed|approved|disapproved|objected|consented|demurred|hesitated|relented|protested|screamed|shrieked|fainted|laughed|smiled|nodded|sighed|frowned|winced|gasped|wanted|hoped|wished|expected|liked|preferred|intended|planned|decided|doubted|suspected)$/u.test(
        w,
      )
    ) {
      // After a word of feeling, a "that" with a subject after it opens a clause, no object
      // ("Anne quite surprised that he had come,"; not "Anne rather feared that he had heard,").
      const feeling =
        /^(?:surprised|astonished|amazed|pleased|delighted|relieved|disappointed|shocked|annoyed|ashamed|worried|alarmed|frightened|convinced|satisfied)$/u.test(
          w,
        );
      const clauseAfter = (j: number) =>
        feeling &&
        word(j) === 'that' &&
        glued(j + 1) &&
        (SUBJECT_PRONOUNS.has(word(j + 1)) ||
          UPPER.test(ts[j + 1]!.text) ||
          DETERMINERS.has(word(j + 1)));
      const takes = (j: number) =>
        glued(j) && ((object(j) && !clauseAfter(j)) || SELF_WORDS.has(word(j)));
      const withSomeone =
        word(k + 1) === 'with' &&
        glued(k + 2) &&
        ['him', 'her', 'them', 'me', 'us'].includes(word(k + 2)) &&
        !(word(k + 2) === 'her' && glued(k + 3));
      const takesObject =
        takes(k + 1) ||
        withSomeone ||
        (word(k + 1) === 'and' && glued(k + 2) && finiteShape(word(k + 2), false) && takes(k + 3));
      if (!takesObject) return -1;
    }
    const transitive = ['cast', 'bound', 'strung', 'spoilt'].includes(w);
    const next = word(k + 1);
    // "by", or a particle before a preposition, makes a participle only of a past that can be a
    // participle of a person ("Anne cast down by the news,", "bid by her father", "ground down by
    // work"; not "Anne knit by the fire,", "Anne knit away at her scarf,", nor "bet", "shed",
    // "smelt", "spilt" or "slew"). After cast, bound, strung and spoilt a count or a bare plural is
    // an object ("Anne cast one last look", "Anne strung beads", "Anne bound two sticks"), an
    // adjective or adverb is not ("Anne strung taut with nerves,", "Anne cast loose from her
    // friends,").
    const personParticiple = [
      'cast',
      'bid',
      'bound',
      'ground',
      'strung',
      'spoilt',
      'wound',
    ].includes(w);
    const participle =
      (w === 'bound' && ['for', 'to'].includes(next)) ||
      (next === 'by' && personParticiple) ||
      (next === 'in' && ['bound', 'wound', 'cast'].includes(w)) ||
      (personParticiple &&
        ['up', 'down', 'out', 'off', 'away'].includes(next) &&
        glued(k + 2) &&
        (NON_PARTICIPANT_PREPOSITIONS.has(word(k + 2)) ||
          ['by', 'with', 'behind', 'beside', 'to'].includes(word(k + 2))));
    // In a stretch that must be a clause (`clause`) the past is its verb whatever follows it.
    const nounLike =
      NOUN_LIKE_PASTS.has(w) &&
      glued(k + 1) &&
      (clause ||
        (!participle &&
          (!transitive ||
            object(k + 1) ||
            /^(?:one|two|three|four|five|six|some|no|every|each|several|many|few|another|those|these|half)$/u.test(
              next,
            ) ||
            (/^\p{Ll}{3,}s$/u.test(next) &&
              !/(?:ss|us|is|ways|wards|less|always|sometimes|perhaps|besides|nevertheless|nonetheless|unawares)$/u.test(
                next,
              ) &&
              !(
                word(k + 2) === 'and' &&
                glued(k + 2) &&
                glued(k + 3) &&
                LOWER.test(ts[k + 3]!.text)
              )) ||
            (w === 'cast' && ['about', 'around', 'off'].includes(next)) ||
            (['up', 'off', 'out', 'down', 'away', 'back', 'aside'].includes(next) &&
              glued(k + 2) &&
              object(k + 2)))));
    return auxiliary || finiteShape(w, true) || nounLike || verbAt(ts, k) ? k : -1;
  }
  if (endsObject(ts, k) || PHRASE_AFTER_PERSON.has(w)) {
    return -1;
  }
  return /\p{L}ing$/u.test(w) ? -1 : k;
}

/**
 * The verb after the phrase that opens at `k`, right after a subject, within a few words, or -1.
 * English: an -ed word or another past form, or an -s form after "him", "them", "me" or "us",
 * within five words, unless it ends the stretch ("the old man by the fire looked up", "Anne a
 * moment later looked up", "Anne behind him laughs"; not "Anne with her arms folded,", "Anne in
 * tears", "his wife of twenty years", "Anne with Will beside her,"). Right after "and" with no
 * comma before the join (`open`) the verb may be in any tense ("and Arthur without a word gathers
 * up his notes and says").
 */
function verbAfterPhrase(
  ts: Token[],
  k: number,
  join: number,
  open: boolean,
  present: boolean,
): number {
  const glued = (j: number) => j < join && !!ts[j] && !ts[j]!.punctBefore;
  // In an open stretch an -s form after an article or a count is a noun of the phrase ("and
  // Anne with two kisses on each cheek and said"), and so is an -ed word between an article and
  // its noun ("on her flushed cheeks", "under the painted ceiling").
  const noun = (j: number) =>
    // "her" is a possessive after a preposition that opens the phrase right after the
    // subject ("and Anne for her gifts and says", "and Anne on her cheeks and says"), not after
    // one inside it ("and Anne with a smile for her nods and says").
    (DETERMINERS.has(wordAt(ts, j)) &&
      (wordAt(ts, j) !== 'her' ||
        (j - 1 === k &&
          ['for', 'on', 'in', 'into', 'onto', 'from'].includes(wordAt(ts, j - 1))))) ||
    [
      'both',
      'two',
      'three',
      'four',
      'all',
      'some',
      'many',
      'few',
      'several',
      'these',
      'those',
      'its',
    ].includes(wordAt(ts, j));
  const particles = [
    'and',
    'or',
    'at',
    'to',
    'in',
    'on',
    'into',
    'from',
    'with',
    'for',
    'by',
    'up',
    'down',
    'out',
    'off',
    'away',
    'back',
    'over',
    'round',
    'around',
    'about',
    'after',
    'before',
    'through',
  ];
  for (let n = k + 1; n <= (open ? join : k + 5) && glued(n); n++) {
    if (!LOWER.test(ts[n]!.text)) continue;
    if (VERB_ADVERBS.has(wordAt(ts, n))) continue;
    if (
      open &&
      DETERMINERS.has(wordAt(ts, n - 1)) &&
      /\p{Ll}ed$/u.test(wordAt(ts, n)) &&
      glued(n + 1) &&
      LOWER.test(ts[n + 1]!.text) &&
      !particles.includes(wordAt(ts, n + 1))
    ) {
      continue;
    }
    // A past such as "cast" that is also a noun, in a stretch with no comma before the join and
    // not after an article ("the old man by the fire cast a glance at him and said"; not "Anne
    // with a wound on her arm," or "Anne with her eyes cast down,").
    const nounLike =
      NOUN_LIKE_PASTS.has(wordAt(ts, n)) &&
      !ts[join]!.punctBefore &&
      !DETERMINERS.has(wordAt(ts, n - 1));
    const shaped =
      AUXILIARIES.has(wordAt(ts, n)) ||
      finiteShape(wordAt(ts, n), false) ||
      nounLike ||
      (finiteShape(wordAt(ts, n), true) &&
        ((open && present && !noun(n - 1)) ||
          ['him', 'them', 'me', 'us'].includes(wordAt(ts, n - 1))));
    if (shaped) return glued(n + 1) || (n + 1 === join && !ts[join]!.punctBefore) ? n : -1;
  }
  return -1;
}

/** An English word that opens a phrase before a verb: an article, a preposition, an -ing word. */
function opensPhrase(w: string): boolean {
  return (
    DETERMINERS.has(w) ||
    NON_PARTICIPANT_PREPOSITIONS.has(w) ||
    PHRASE_AFTER_PERSON.has(w) ||
    /\p{L}ing$/u.test(w)
  );
}

/**
 * The shape of an English finite verb: "smiled", "rose", "was", "can", "didn't", and with
 * `present` "laughs"; not "pale", "opposite", "tears" or "twenty-two".
 */
export function finiteShape(w: string, present: boolean): boolean {
  if (w.includes('-')) return false;
  if (/^\p{Ll}{2,}ed$/u.test(w) || FINITE_FORMS.has(w) || /^\p{Ll}+n['’]t$/u.test(w)) return true;
  return present && /^\p{Ll}{2,}s$/u.test(w) && !/(?:ss|us|is|as)$/u.test(w);
}

/**
 * Whether a name or descriptor ending before `k` is an object: the clause ends after it, or an
 * article or a preposition follows ("I hugged Anne and said", "I gave Tom the letter", "I led Anne
 * into the house"). Any other word is read as its own verb ("Mrs. Bennet turned").
 */
export function endsObject(ts: Token[], k: number): boolean {
  const next = ts[pastLyAdverbs(ts, k)];
  if (!next) return true;
  const word = next.text.toLowerCase();
  if (COORDINATORS.has(word)) return true;
  return (
    !next.punctBefore &&
    (DETERMINERS.has(word) || NON_PARTICIPANT_PREPOSITIONS.has(word) || ADDRESSEE_MARKERS.has(word))
  );
}
