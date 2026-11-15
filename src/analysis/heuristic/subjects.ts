/** Who a clause's subject is in the cast: resolving it may add characters or guess genders. */

import {
  authorialTeller,
  hedgeEnd,
  isTeller,
  joinAt,
  openingSubject,
  openingSubjectAt,
  openingSubjectEnd,
  opensWithoutSubject,
  perceived,
  remarkSubject,
} from './clauses';
import {
  AFTER_VERB_SKIP,
  AUXILIARIES_AND_MODALS,
  BEFORE_VERB_PAIRS,
  COMMENT_VERBS,
  COORDINATORS,
  DETERMINERS,
  NON_PARTICIPANT_PREPOSITIONS,
  POSSESSIVE_DETERMINERS,
  QUESTION_JOINS,
  RELATIVES,
  SENTENCE_LEADS,
  SPEAKER_NOUNS,
  SUBORDINATORS,
} from './lexicon';
import { isPronoun, subjectOf, verbAt } from './mentions';
import { someone, type Reading, type Who } from './reading';
import { indefiniteSubject, passiveToTeller } from './tagVerbs';
import {
  addressedIn,
  afterPreposition,
  clauseBeforeJoin,
  LOWER,
  LY_ADVERB,
  UPPER,
  wordAt,
  type Mention,
  type Token,
} from './tokens';
import { finiteShape, verbAfterSubject } from './verbShape';

/** "to my surprise", "to everyone’s surprise". */
const POSSESSIVES = new Set([...POSSESSIVE_DETERMINERS, 'everyone’s', "everyone's"]);

/** A count or quantifier before a plural: "her two sons", "both boys". */
const COUNT_WORD = /^(?:two|three|four|five|six|both|several|many|few|some|other)$/u;

/**
 * The subject at the start of the sentence beginning at `start` (see openingSubject).
 * `knownOnly`: a name must already be in the cast.
 */
export function sentenceSubject(
  r: Reading,
  ts: Token[],
  start: number,
  mentions: Mention[],
  knownOnly = false,
): Who | undefined {
  const subject = openingSubject(ts, start, mentions);
  if (!subject) return undefined;
  if (subject.kind === 'pronoun') {
    if (subject.gender === 'narrator') return { key: r.cast.narratorKey, teller: true };
    return someone(r.turns.byGender(subject.gender, new Set()));
  }
  const m = subject.mention;
  if (knownOnly && m.kind === 'name' && !r.cast.match(m.name)) return undefined;
  return someone(r.cast.resolve(m));
}

/**
 * "I turned to her and said": the subject of the clause the verb is coordinated with. That is
 * the subject of the clause right before the join, after a comma, when that is a clause of its
 * own (see ownClauseSubject: "Tom came in, and Anne smiled and then said"), else the sentence's
 * ("Then Mr. Darcy bowed and said", "Tom waited until she had finished, then said", "Tom looked
 * at his daughter, Jane, and said", "I turned to Uncle Abel, who was mending the net, and
 * said"). The teller's "I" is nobody's after "I suppose" or "I daresay" (see authorialTeller: "I
 * daresay Mrs. Bennet turned, then said"), or when someone the teller watched may have spoken
 * after an aside ("I noticed that Anne looked away, and after a moment, said").
 */
export function coordinatedSubject(
  r: Reading,
  ts: Token[],
  v: number,
  start: number,
  mentions: Mention[],
): Who | undefined {
  const join = joinAt(ts, v, start);
  if (join === -1) return undefined;
  const clause = clauseBeforeJoin(ts, join, start);
  const own =
    clause > start ? ownClauseSubject(r, ts, clause, start, join, v, mentions) : undefined;
  if (own) return own;
  // A subject "and" brings in before an aside between commas, when the clause the join takes
  // has no subject of its own ("Tom went out, and the old man, after a while, sat down and
  // said").
  if (clause - 1 > start && !openingSubject(ts, clause, mentions)) {
    let a = clause - 1;
    while (a > start && !ts[a]!.punctBefore) a--;
    let b = a - 1;
    while (b > start && !ts[b]!.punctBefore) b--;
    const before = b > start ? openingSubjectAt(ts, b, mentions) : null;
    if (before && QUESTION_JOINS.has(ts[b]!.text.toLowerCase()) && before.end === a - 1) {
      // An aside that "and" opens with a phrase ("and after a while,", "and at last,") may go on
      // with the sentence's verb, after one more object ("kissed the children, and Tom, and
      // after a while, sat down and said"); with no "and", or as a clause, it may not.
      const lead = wordAt(ts, a + 1);
      const phraseAside =
        QUESTION_JOINS.has(ts[a]!.text.toLowerCase()) &&
        (NON_PARTICIPANT_PREPOSITIONS.has(lead) ||
          /^(?:after|before|with|without|by|despite|then|later|afterwards|presently|finally|suddenly|soon|again|still)$/u.test(
            lead,
          ) ||
          /\p{Ll}ly$/u.test(lead));
      if (before.subject.kind === 'pronoun' || !phraseAside || !!verbAt(ts, start)) {
        return sentenceSubject(r, ts, b, mentions);
      }
    }
  }
  const who = sentenceSubject(r, ts, start, mentions);
  // An English sentence that opens with no subject of its own has it after the opening, in a
  // part that a comma opens with a name or "I" and its verb ("When the music stopped, Mr. Darcy
  // crossed the room, bowed, then said").
  if (!who && !openingSubject(ts, start, mentions)) {
    let verbOnly = false;
    for (let p = join - 1; p > start; p--) {
      if (ts[p]!.punctBefore !== ',') continue;
      const opening = openingSubjectAt(ts, p, mentions);
      if (!opening) {
        verbOnly ||= LOWER.test(ts[p]!.text) && finiteShape(ts[p]!.text, false);
        continue;
      }
      const { subject, end } = opening;
      // The teller's hedge is no such part ("Elizabeth hesitated, I believe, and then said").
      const hedge =
        subject.kind === 'pronoun' && subject.gender === 'narrator' ? hedgeEnd(ts, p, join) : -1;
      if (hedge !== -1 && (hedge + 1 >= join || !!ts[hedge + 1]!.punctBefore)) continue;
      const after = ts[end + 1];
      // A comment ("she thought,", "I thought,", "it seemed,") is no clause the join goes on
      // with.
      const commentWord = after?.text ?? '';
      if (
        after &&
        !after.punctBefore &&
        (!!verbAt(ts, end + 1)?.thought ||
          COMMENT_VERBS.has(commentWord) ||
          ['seemed', 'appeared'].includes(commentWord)) &&
        (!ts[end + 2] || !!ts[end + 2]!.punctBefore)
      ) {
        continue;
      }
      // A part with only a subject, before a part with only a verb, gives the subject, unless it
      // follows a person, as an appositive does ("Tom bowed to Mrs. Bennet, Anne's mother,
      // smiled, and said").
      const beforeWord = ts[p - 1]!.text;
      const afterPerson =
        mentions.some((m) => m.last === p - 1) ||
        isPronoun(beforeWord) !== undefined ||
        beforeWord.toLowerCase() in SPEAKER_NOUNS ||
        UPPER.test(beforeWord);
      if (verbOnly && !afterPerson && (!after || !!after.punctBefore)) {
        return sentenceSubject(r, ts, p, mentions);
      }
      if (subject.kind === 'pronoun' && subject.gender !== 'narrator') {
        if (verbAfterSubject(ts, end, join, false) === -1) continue;
        const earlier = r.cast
          .keys(mentions.filter((m) => m.first >= start && m.last < p && !m.possessive))
          .filter((k) => r.cast.entry(k).gender === subject.gender);
        return someone(earlier[earlier.length - 1] ?? r.turns.byGender(subject.gender, new Set()));
      }
      const named =
        subject.kind === 'mention'
          ? subject.mention.kind === 'name'
          : subject.gender === 'narrator';
      if (!named) {
        if (
          subject.kind === 'mention' &&
          after &&
          !after.punctBefore &&
          (/^(?:arose|awoke|became|began|blew|broke|chose|came|drew|drank|drove|ate|fell|flew|forbade|forgave|froze|gave|went|grew|knew|rode|rang|rose|ran|saw|shook|shrank|sang|sank|spoke|sprang|stole|strode|swore|swam|took|tore|threw|trod|woke|wore|wrote|withdrew|overtook|strove|smote|stank|foresaw|mistook|forsook|undertook|overcame|overthrew)$/u.test(
            after.text,
          ) ||
            (/^(?:sat|stood)$/u.test(after.text) &&
              /^(?:down|up|back)$/u.test(ts[end + 2]?.text ?? '') &&
              !ts[end + 2]!.punctBefore))
        ) {
          return sentenceSubject(r, ts, p, mentions);
        }
        continue;
      }
      // After a clause such as "when" opens, the first part with a subject is the main clause,
      // which has its verb: no phrase reading (see verbAfterSubject's `clause`). A later part may
      // be a phrase ("When the music stopped, Tom stood up, Anne quite exhausted beside him, and
      // said").
      const mainClause =
        SUBORDINATORS.has(ts[start]!.text.toLowerCase()) &&
        !ts
          .slice(start + 1, p)
          .some(
            (t, i) =>
              t.punctBefore === ',' &&
              !COORDINATORS.has(t.text.toLowerCase()) &&
              !!openingSubject(ts, start + 1 + i, mentions),
          );
      const main = verbAfterSubject(
        ts,
        end,
        join,
        subject.kind === 'mention',
        false,
        true,
        mainClause,
      );
      if (main === -1) continue;
      return sentenceSubject(r, ts, p, mentions);
    }
  }
  if (!who?.teller) return who;
  const aside = ts[v]!.punctBefore === ',' && !!ts[join]!.punctBefore && join + 1 < v;
  if (aside && perceived(ts, start, join, mentions)) return undefined;
  return authorialTeller(ts, start, v) ? undefined : who;
}

/**
 * The subject of the stretch after the comma at `clause`, when that stretch is a clause of its
 * own, its subject followed by a verb (see verbAfterSubject: "Tom came in, and Anne smiled and
 * then said", "When the music stopped, Mr. Darcy bowed, then said"). An appositive is none ("his
 * daughter, Jane,"), nor is the rest of a list ("then his sister,", "then at Anne,", "Mr. Darcy
 * and Mr. Hurst,"), a phrase with no verb ("Anne at his side,", "the old man watching him,",
 * "Jane included,") or the teller's comment ("I think,"). Between commas a descriptor opens one
 * only after "and" or "but", or in a sentence that opens with no subject of its own
 * ("Presently, the old man rose, and said"). Someone else's comment is none either ("Tom
 * hesitated, she thought, and then said"). After the teller's "I suppose" the subject is the
 * next one ("Tom came in, and I suppose Anne smiled and said").
 */
function ownClauseSubject(
  r: Reading,
  ts: Token[],
  clause: number,
  start: number,
  join: number,
  v: number,
  mentions: Mention[],
): Who | undefined {
  let from = clause;
  let opening = openingSubjectAt(ts, from, mentions);
  // "and at last Anne looked up and said": a set phrase between the "and" and the subject.
  const glued3 = [1, 2, 3].every((d) => clause + d < join && !ts[clause + d]!.punctBefore);
  if (
    !opening &&
    QUESTION_JOINS.has(ts[clause]!.text.toLowerCase()) &&
    glued3 &&
    BEFORE_VERB_PAIRS.has(
      `${ts[clause + 1]!.text.toLowerCase()} ${ts[clause + 2]!.text.toLowerCase()}`,
    )
  ) {
    from = clause + 3;
    opening = openingSubjectAt(ts, from, mentions);
    // A "he" or "she" there is the sentence's own subject when that subject is of its gender
    // ("Mr. Holt reads the letter twice, and at last he looks up and says", "The old woman looks
    // at them for a long time, and at last she nods and says", "Tom went red, and in answer he
    // only nodded"); not when the subject's gender is another or unknown ("The nurse shook her
    // head, and at last he understood"), nor for a reply by someone of that gender the subject
    // acted on ("Tom shoved him against the wall, and in return he only laughed").
    const pair = `${ts[clause + 1]!.text.toLowerCase()} ${ts[clause + 2]!.text.toLowerCase()}`;
    const own = openingSubject(ts, start, mentions);
    const ownGender =
      own?.kind === 'pronoun'
        ? own.gender
        : own && (r.cast.match(own.mention.name)?.gender ?? own.mention.gender);
    const pronoun = opening?.subject.kind === 'pronoun' ? opening.subject.gender : undefined;
    const actedOn =
      ['in reply', 'in answer', 'in return', 'in turn'].includes(pair) &&
      pronoun !== undefined &&
      ts.slice(start + 1, clause).some((_, i) => {
        const k = start + 1 + i;
        if (pronoun === 'male') return wordAt(ts, k) === 'him';
        // "her" as an object, not a possessive ("scolded her for an hour", "questioned her
        // closely"; not "bit her lip")
        return (
          wordAt(ts, k) === 'her' &&
          (k + 1 >= clause ||
            !!ts[k + 1]!.punctBefore ||
            /\p{Ll}ly$/u.test(wordAt(ts, k + 1)) ||
            ['for', 'with', 'about', 'against', 'into', 'to', 'at', 'on', 'in', 'over'].includes(
              wordAt(ts, k + 1),
            ))
        );
      });
    if (pronoun !== undefined && pronoun !== 'narrator' && ownGender === pronoun && !actedOn) {
      from = clause;
      opening = null;
    }
  }
  // The hedge is in the stretch, before the join: not the teller's own aside after it ("and I,
  // and this I regret, said").
  if (isTeller(opening?.subject) && authorialTeller(ts, clause, join)) {
    const hedge = hedgeEnd(ts, clause, join);
    if (hedge === -1 || hedge + 1 >= join || ts[hedge + 1]!.punctBefore) return undefined;
    from = hedge + 1;
    opening = openingSubjectAt(ts, from, mentions);
    if (isTeller(opening?.subject)) return undefined;
  }
  if (!opening) return undefined;
  const { subject, end } = opening;
  // "so" + subject + a modal after an act is its purpose, no clause of its own ("Tom held the
  // door, so Anne could get through, and said"); after a state it is what follows ("Tom was
  // gone, so Anne could at last ask her question, and said").
  if (
    ts[clause]!.text.toLowerCase() === 'so' &&
    /^(?:could|would|might|should|can|will|may|shall|must)$/u.test(wordAt(ts, end + 1))
  ) {
    const o = openingSubjectEnd(ts, start, mentions);
    const be = wordAt(ts, o + 1);
    const state =
      o > start - 1 &&
      /^(?:was|were|is|are)$/u.test(be) &&
      !/\p{Ll}ing$/u.test(ts[o + 2]?.text ?? '');
    if (!state) return undefined;
  }
  const joined = QUESTION_JOINS.has(ts[clause]!.text.toLowerCase());
  // The subject "and" brings in, right before an aside, is the tag's when it cannot be one more
  // object. So it is after the tag's own subject ("said Anne, and Tom, and after a moment,
  // replied"), for "he" ("looked at Anne, and he, and this I will never forget, said"), and
  // before an aside that is a clause of its own, in a tag-first sentence or with no person right
  // before ("Mrs. Bennet looked away, and Anne, and this surprised me, said"); not in a list
  // ("Mrs. Bennet kissed Tom, and then Anne, and after a moment, said", "kissed him, and Anne,
  // and I shall never forget it, said").
  const tagFirst = !!verbAt(ts, start);
  // The tag's subject may be followed by -ly words, again/then/now, a set pair, "to <person>"
  // before a reply verb, or an aside that is a participle with no object (", smiling,",
  // ", smiling broadly,"); a tag with the name first counts too.
  const subjectEndAt = (k: number) =>
    isPronoun(ts[k]?.text ?? '') !== undefined
      ? k
      : (mentions.find((m) => m.first === k && !m.possessive)?.last ?? -1);
  let tagEnd = tagFirst ? subjectEndAt(start + 1) : -1;
  if (!tagFirst) {
    const e = subjectEndAt(start);
    if (e !== -1 && ts[e + 1] && !ts[e + 1]!.punctBefore && verbAt(ts, e + 1)) {
      tagEnd = e + 1;
    }
  }
  let f = tagEnd + 1;
  while (tagEnd !== -1 && f < clause) {
    if (ts[f]!.punctBefore) {
      if (ts[f]!.punctBefore !== ',' || !/^\p{Ll}+ing$/u.test(ts[f]!.text)) break;
      f++;
      while (f < clause && !ts[f]!.punctBefore && LY_ADVERB.test(ts[f]!.text)) f++;
      if (f < clause && !ts[f]!.punctBefore) {
        f = -1;
        break;
      }
    } else if (LY_ADVERB.test(ts[f]!.text) || AFTER_VERB_SKIP.has(wordAt(ts, f))) f++;
    else if (
      !ts[f + 1]?.punctBefore &&
      BEFORE_VERB_PAIRS.has(`${wordAt(ts, f)} ${wordAt(ts, f + 1)}`)
    ) {
      f += 2;
    } else if (
      wordAt(ts, f) === 'to' &&
      !!verbAt(ts, v)?.reply &&
      mentions.some((m) => m.first === f + 1 && m.last === clause - 1)
    ) {
      f = clause;
    } else break;
  }
  // Before a reply, what follows a tag's named subject is the person it is said to,
  // whom the reply's speaker does not make one more of ("said Mrs. Bennet to Tom, who was very
  // pale, and Anne, and after a moment, answered", "said Mrs. Bennet, looking at Tom, and Anne,
  // and after a moment, answered"; not "said Mrs. Bennet to Anne, and then Tom, and after a
  // moment, added").
  const saidTo =
    tagFirst &&
    !!verbAt(ts, v)?.reply &&
    mentions.some((m) => m.first === start + 1 && !m.possessive && m.last < clause - 1);
  const tagSubject = (tagEnd !== -1 && f === clause) || saidTo;
  const opener = wordAt(ts, join + 1);
  const remark =
    join + 1 < v &&
    (['i', 'we', 'he', 'she', 'they', 'it', 'this', 'that', 'nobody'].includes(opener) ||
      // and so is "and to my surprise,"
      (opener === 'to' && ts[join + 3]?.text.toLowerCase() === 'surprise') ||
      // Outside a tag-first sentence (where a remark makes the stretch a new subject
      // even after a person), an indefinite or "you" that is the subject of the verb right
      // after it ("and no one expected it,", "and none of us expected it,", "and everyone was
      // surprised,", "and you will hardly believe it,"; not "and everyone else," or "and
      // everyone who was there,"), "to" with a possessive ("and to my great astonishment,",
      // not "and to her mother,"), "and much to my surprise," and "and strange to say,".
      (!tagFirst &&
        (remarkSubject(ts, join, v) ||
          (opener === 'to' &&
            POSSESSIVES.has(wordAt(ts, join + 2)) &&
            !(wordAt(ts, join + 3) in SPEAKER_NOUNS || UPPER.test(ts[join + 3]?.text ?? ''))) ||
          (opener === 'much' && ts[join + 2]?.text.toLowerCase() === 'to') ||
          (opener === 'strange' &&
            ts[join + 2]?.text.toLowerCase() === 'to' &&
            ts[join + 3]?.text.toLowerCase() === 'say'))));
  // A person no mention shows counts too: "kissed the baby, and Anne,", "hugged the boys, and".
  const before = wordAt(ts, clause - 1);
  // A plural too ("the ladies", "the gentlemen", "her parents"), and after a count ("her two
  // sons", "both boys").
  const beforeNoun = wordAt(ts, clause - 2);
  // The narrow test (a determiner right before a person noun) always counts; the wider one
  // (plurals, counts) only before a verb that is no reply ("Mrs. Bennet scolded the twins, and
  // Anne, and nobody expected it, replied" is Anne's).
  const narrowNoun =
    DETERMINERS.has(beforeNoun) &&
    (['baby', 'babies', 'children', 'men', 'women'].includes(before) ||
      before.replace(/s$/u, '') in SPEAKER_NOUNS);
  const widerNoun =
    !verbAt(ts, v)?.reply &&
    (DETERMINERS.has(beforeNoun) || COUNT_WORD.test(beforeNoun)) &&
    ([
      'baby',
      'babies',
      'children',
      'grandchildren',
      'men',
      'women',
      'people',
      'twins',
      'parents',
      'others',
    ].includes(before) ||
      before.replace(/s$/u, '') in SPEAKER_NOUNS ||
      before.replace(/ies$/u, 'y') in SPEAKER_NOUNS ||
      before.replace(/men$/u, 'man') in SPEAKER_NOUNS);
  // The wider test counts only for a direct object ("kissed the twins, and Anne,", not "laughed
  // at the twins, and Anne,").
  let d = clause - 2;
  while (
    d > start &&
    (DETERMINERS.has(ts[d]!.text.toLowerCase()) || COUNT_WORD.test(ts[d]!.text.toLowerCase()))
  ) {
    d--;
  }
  const direct =
    !/^(?:at|to|with|for|of|in|on|from|by|about|towards?|into|onto|upon|over|under|behind|beside|near|among|between|around|after|before|without|like|past|through|across|against|beyond)$/u.test(
      wordAt(ts, d),
    );
  const personNoun = narrowNoun || (widerNoun && direct);
  const personBefore =
    personNoun ||
    mentions.some((m) => m.last === clause - 1 && !m.possessive && !addressedIn(ts, m)) ||
    ['him', 'them', 'me', 'us', 'both', 'all'].includes(before);
  const newSubject =
    tagSubject || subject.kind === 'pronoun' || (remark && (tagFirst || !personBefore));
  if (
    joined &&
    newSubject &&
    end + 1 === join &&
    !!ts[join]!.punctBefore &&
    ts[v]!.punctBefore === ','
  ) {
    return sentenceSubject(r, ts, from, mentions);
  }
  // "and Arthur without a word gathers up his notes and says": a name or pronoun right after the
  // "and" that opens a stretch with no comma before the join, so a phrase before its verb may end
  // in a present form. A descriptor opens one too ("and the old man by the fire nods and says"),
  // and a lead word may come first ("and then Anne with a sigh gets up and says").
  const first = subject.kind === 'pronoun' ? end : subject.mention.first;
  const open =
    from === clause &&
    (first === clause + 1 ||
      (first === clause + 2 &&
        !ts[clause + 1]!.punctBefore &&
        SENTENCE_LEADS.has(ts[clause + 1]!.text.toLowerCase()))) &&
    joined &&
    !ts[join]!.punctBefore;
  // An -s form is a verb in an open stretch only in present narration ("and Anne without a word
  // gathers up her notes and says"; not "and Anne with two kisses on both cheeks and said").
  const present = /\p{Ll}s$/u.test(ts[v]!.text);
  // A stretch that "and" or "but" opens, or the main clause after a clause that "when" or the
  // like opens, has a verb: it is no phrase ("Tom shook his head, and Anne all but begged to
  // come along, and said", "When the music stopped, Anne cast another glance at the door, and
  // said"; not "Tom came in, Anne rather flushed with the heat, and said").
  const clauseOnly =
    joined ||
    (SUBORDINATORS.has(ts[start]!.text.toLowerCase()) &&
      opensWithoutSubject(ts, start, clause, mentions));
  const verb = verbAfterSubject(
    ts,
    end,
    join,
    subject.kind === 'mention',
    open,
    present,
    clauseOnly,
  );
  if (verb === -1) return undefined;
  // Someone else's comment with nothing after its verb: "Tom hesitated, she thought, and then
  // said". The teller's own past verb is the one the join takes ("Anne was right, I thought, and
  // said"; see authorialTeller).
  // A comment's verb may come after a modal or an auxiliary: "Anne can see,", "Anne must have
  // noticed,", "Anne by the window had noticed,".
  let main = verb;
  while (
    main + 1 < join &&
    !ts[main + 1]!.punctBefore &&
    AUXILIARIES_AND_MODALS.has(ts[main]!.text.toLowerCase())
  ) {
    main++;
  }
  const comment = !!verbAt(ts, main)?.thought || COMMENT_VERBS.has(ts[main]!.text);
  // A comment about a state, or what the teller was told: "Anne was sure, and said", "Anne tells
  // me, and says".
  const after = ts[verb + 1]?.text ?? '';
  const sure =
    verb + 2 === join &&
    ((/^(?:was|were)$/u.test(ts[verb]!.text) &&
      /^(?:sure|certain|convinced|aware)$/u.test(after)) ||
      (/^(?:tells|told)$/u.test(ts[verb]!.text) && /^(?:me|us)$/u.test(after)));
  // The teller's comment on a state is the clause the join takes ("Anne was right, I thought,
  // and said"), not one on someone's act ("Tom hesitated, I noticed, and then said").
  const openingEnd = openingSubjectEnd(ts, start, mentions);
  const state =
    /^(?:was|were|is|are)$/u.test(ts[openingEnd + 1]?.text ?? '') &&
    !/ing$/u.test(ts[openingEnd + 2]?.text ?? '');
  // A comment "and" or "but" opens is the clause the join goes on with ("but Anne noticed, and
  // said").
  if (((comment && main + 1 === join) || sure) && !joined && !(isTeller(subject) && state)) {
    return undefined;
  }
  // Between commas a descriptor may be an appositive; right before the join it is the verb's
  // subject.
  const named = subject.kind === 'pronoun' || subject.mention.kind === 'name';
  const enclosed = !!ts[join]!.punctBefore;
  if (!named && !joined && enclosed && !opensWithoutSubject(ts, start, clause, mentions)) {
    return undefined;
  }
  return sentenceSubject(r, ts, from, mentions);
}

/** "Tom, who …, exclaimed:" → Tom; else the nearest name, then descriptor, before the verb. */
export function nearestBefore(
  r: Reading,
  ts: Token[],
  verbIndex: number,
  start: number,
  mentions: Mention[],
): string | undefined {
  for (let i = verbIndex - 1; i > start; i--) {
    if (RELATIVES.has(ts[i]!.text.toLowerCase()) && ts[i]!.punctBefore === ',') {
      const antecedent = mentions.find((m) => m.last === i - 1);
      if (antecedent) return r.cast.resolve(antecedent);
      break;
    }
  }
  const before = mentions.filter(
    (m) =>
      m.first >= start && m.last < verbIndex && !afterPreposition(ts, m) && !addressedIn(ts, m),
  );
  const nearest = before.filter((m) => m.kind === 'name').at(-1) ?? before.at(-1);
  return nearest ? r.cast.resolve(nearest) : undefined;
}

export function subjectKey(
  r: Reading,
  tokens: Token[],
  verbIndex: number,
  mentions: Mention[],
): Who | undefined {
  const subject = subjectOf(tokens, verbIndex, mentions);
  const I: Who = { key: r.cast.narratorKey, teller: true };
  if (!subject) {
    // "Then someone said:"
    return indefiniteSubject(r, tokens, verbIndex) ? someone(r.cast.unknownKey) : undefined;
  }
  if (subject.kind === 'mention') return someone(r.cast.resolve(subject.mention, true));
  if (subject.gender !== 'narrator') return someone(r.turns.byGender(subject.gender, new Set()));
  return passiveToTeller(tokens, verbIndex) ? undefined : I;
}
