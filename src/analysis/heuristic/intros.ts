/** Colon intros ("Then she said:", "…said Tom, and he answered:"): who says the next line. */

import type { Gender } from '@/format/types';
import type { Unit } from '../units';
import { heOrShe, openingSubject, timeOpening } from './clauses';
import {
  ADDRESSEE_MARKERS,
  ASKING_VERBS,
  NEGATIONS,
  NON_PARTICIPANT_PREPOSITIONS,
  RECOVERY_WORDS,
  SELF_WORDS,
  WH_WORDS,
} from './lexicon';
import { asksInLine } from './lines';
import { isPronoun, verbAt } from './mentions';
import { someone, type Reading, type Who } from './reading';
import { coordinatedSubject, nearestBefore, sentenceSubject, subjectKey } from './subjects';
import { afterVerb, beforeVerb, isVerb, notTeller, pronounSubject, saidToTeller } from './tagVerbs';
import {
  addressedIn,
  afterPreposition,
  gluedAt,
  lastSentenceStart,
  wordAt,
  type Mention,
  type Token,
} from './tokens';

/** A line of one to three words that only hesitate: "Well,", "Well, well,". */
const HESITATIONS = /^(?:(?:well|oh|ah|um+|er+m?|h?m+|uh|so)\s*){1,3}$/u;

/** Who a colon intro says the next line is by, or is not by. */
export interface Intro {
  speaker?: Who;
  /** The intro names nobody, but its speaker is not the teller. */
  notTeller: boolean;
  /** The "he" or "she" of the intro, when nobody of that gender was found. */
  gender?: Gender;
}

/** The last line of a paragraph of speech, as the paragraph read it. */
interface LastLine {
  unit: Unit;
  /** Who said it. */
  who: Who;
  /** The people it was said to: its tag's addressees, then the people it calls on. */
  saidTo: string[];
  /** It calls on someone not in the cast yet. */
  unknownCall: boolean;
  /** It ends with a question mark. */
  asks: boolean;
}

/** The questions earlier lines left open: the Attributor's fields of the same names. */
interface Asked {
  lastAsker: string | undefined;
  lastQuestion: string | undefined;
  headingAsker: string | undefined;
}

/** The colon intro a paragraph of speech may end with, read after its last line. */
export function replyIntro(
  r: Reading,
  units: Unit[],
  tokens: Map<Unit, Token[]>,
  isVoiced: (u: Unit) => boolean,
  { unit: lastVoiced, who, saidTo, unknownCall, asks: lineAsks }: LastLine,
  { lastAsker, lastQuestion, headingAsker }: Asked,
): Intro {
  const intro: Intro = { notTeller: false };
  const lastUnit = units.at(-1)!;
  if (!isVoiced(lastUnit) && r.slice(lastUnit).trimEnd().endsWith(':')) {
    const ts = tokens.get(lastUnit)!;
    const v = beforeVerb(r, lastUnit, ts);
    const gender = v === -1 ? undefined : pronounSubject(ts, v, r.cast.mentions(ts));
    // The verb of the line's tag, when the intro is that tag ("asked Tom, and he answered:").
    const tagVerb =
      units.indexOf(lastUnit) === units.indexOf(lastVoiced) + 1 ? afterVerb(r, lastUnit, ts) : -1;
    if (gender) {
      // A reply answers the line, so it is someone else's, when the line asked something or was
      // said to someone ("“Where were you?” asked Tom, and he answered:", "“Good night, Mama,”
      // said Anne, and she replied:"), or when nothing but its "he" or "she" and their gestures
      // comes between the line and the reply ("“You’re late,” said Anne, and she replied:").
      // The tag's speaker goes on after someone else's act ("“Out,” said Tom, and when she
      // frowned, he answered:") or question ("and when Mary asked where, she answered:"), after
      // an aside that says so ("“Who?” said Anne, and then, recovering herself, she answered:"),
      // when the reply answers itself ("and she answered her own question:"), and when the line
      // answers a question asked just before it (“Will you marry me?” asked Tom. / “Well,” said
      // Anne, and she answered:). Someone of that gender the intro opens with answers, unless
      // they asked ("Mary nodded, and then she replied:"). Nor is the reply the person it is
      // said to ("and then she replied to her sister:").
      const verb = verbAt(ts, v);
      const mentions = r.cast.mentions(ts);
      const replyTo = new Set(
        r.cast.keys(mentions.filter((m) => m.first > v && addressedIn(ts, m))),
      );
      const speaker = who.key;
      const callee = (k: string) =>
        k !== speaker && !replyTo.has(k) && (r.cast.entry(k).gender ?? gender) === gender;
      // Whether the line was said to someone the "he" or "she" may be.
      const called = saidTo.some(callee);
      const sentence = lastSentenceStart(ts.slice(0, v + 1));
      const recovers = ts.slice(sentence, v).some((_, i) => {
        const k = sentence + i;
        return (
          SELF_WORDS.has(wordAt(ts, k)) &&
          (RECOVERY_WORDS.has(wordAt(ts, k - 1)) || wordAt(ts, k + 1) === 'together')
        );
      });
      const after: string[] = [];
      for (let k = v + 1; k < v + 4 && gluedAt(ts, k); k++) after.push(wordAt(ts, k));
      // English "own" only as "her own" right after the verb ("answered her own question:"; not
      // "answered in her own way:").
      const itself =
        after.some(
          (w, i) =>
            SELF_WORDS.has(w) ||
            (w === 'own' && i === 1 && ['her', 'his', 'their', 'my', 'your'].includes(after[0]!)),
        ) || after[0] === 'for';
      const someoneElse =
        mentions.some(
          (m) => m.last < v && !m.possessive && r.cast.match(m.name)?.key !== speaker,
        ) ||
        ts.slice(0, v).some((t) => {
          const pronoun = isPronoun(t.text);
          return pronoun !== undefined && pronoun !== gender;
        });
      // A line that only hesitates, right after a heading, starts the answer to the question
      // asked before it ("“Will you marry me?” / CHAPTER TWO / “Well,” said Anne, and she
      // answered:"), unlike a line of its own ("CHAPTER II / “You’re late,” said Anne, and she
      // replied:").
      const hesitant = HESITATIONS.test(
        r
          .slice(lastVoiced)
          .replace(/[^\p{L}\s]/gu, ' ')
          .trim()
          .toLowerCase(),
      );
      const pending = hesitant && headingAsker !== undefined && headingAsker !== speaker;
      const direct =
        !pending &&
        !someoneElse &&
        !(gluedAt(ts, v + 1) && ADDRESSEE_MARKERS.has(wordAt(ts, v + 1))) &&
        (lastAsker === undefined || lastAsker === speaker);
      // The nearest sentence of the intro that opens with a name.
      let answerer: string | undefined;
      for (let s = sentence, e = v, n = 0; n < 5; n++) {
        const opener = openingSubject(ts, s, mentions);
        // A question the teller asks about one person of that gender names the answerer: "What
        // could Mary say? She shrugged, and then she replied:".
        if (
          n > 0 &&
          opener?.kind !== 'mention' &&
          (ts[e]?.punctBefore ?? '').includes('?') &&
          WH_WORDS.has(ts[s]!.text.toLowerCase())
        ) {
          const about = new Set(
            r.cast
              .keys(mentions.filter((m) => m.first > s && m.last < e && !m.possessive))
              .filter((k) => k !== speaker && r.cast.entry(k).gender === gender),
          );
          if (about.size === 1) {
            answerer = [...about][0];
            break;
          }
          // A line said to someone leaves the reply to them ("“You’re late again, Mary,” said
          // Anne. Jane went on reading. What excuse would it be this time?").
          if (called) break;
        }
        if (opener?.kind === 'mention') {
          const k = r.cast.match(opener.mention.name)?.key;
          const asks = ts.slice(s, e).some((t, j) => {
            const w = t.text.toLowerCase();
            if (ASKING_VERBS.has(w)) return true;
            if (!WH_WORDS.has(w)) return false;
            // Not knowing what to do asks nothing: "Mary did not know what to say".
            const next = ts[s + j + 1];
            const infinitive = !!next && !next.punctBefore && next.text.toLowerCase() === 'to';
            // The negation is in the wh-word's own clause, with no pause or "and" between them.
            let denied = false;
            // An aside a preposition opens between commas, right before it, is skipped: "Mary did
            // not know, for a moment, what to say".
            let from = s + j;
            if (ts[from]!.punctBefore === ',') {
              let a = from - 1;
              while (a > s && !ts[a]!.punctBefore) a--;
              const lead = ts[a]!.text.toLowerCase();
              if (a > s && ts[a]!.punctBefore === ',' && NON_PARTICIPANT_PREPOSITIONS.has(lead)) {
                from = a;
              }
            }
            for (
              let g = from - 1;
              g >= s && ((from !== s + j && g + 1 === from) || !ts[g + 1]!.punctBefore);
              g--
            ) {
              const x = ts[g]!.text.toLowerCase();
              if (NEGATIONS.has(x) || /n['’]t$/u.test(ts[g]!.text)) {
                denied = true;
                break;
              }
              if (['and', 'but', 'or'].includes(x)) break;
            }
            return !(infinitive && denied);
          });
          if (k !== undefined && k !== speaker && r.cast.entry(k).gender === gender && !asks) {
            answerer = k;
          }
          break;
        }
        if (s === 0) break;
        e = s;
        s = lastSentenceStart(ts.slice(0, s));
      }
      // The tag's own asking verb ("asked Tom, and he answered:"), or someone else's.
      const asking = (k: number) => ASKING_VERBS.has(wordAt(ts, k));
      const othersAsk = ts
        .slice(sentence, v)
        .some((_, i) => sentence + i !== tagVerb && asking(sentence + i));
      // A question anywhere in the line counts ("Where were you? I waited all night,"), but not
      // an echo, a lone question word its speaker answers or a question it quotes (see
      // asksInLine), nor one the speaker goes on from ("“Who knows? Perhaps,” said Anne, and
      // then she answered:").
      const answered = lastAsker !== undefined && lastAsker !== speaker ? lastQuestion : undefined;
      const goesOn = [v - 1, v - 2].some((k) => gluedAt(ts, k + 1) && wordAt(ts, k) === 'then');
      // Unless the intro names someone else, whom the "he" or "she" may be ("said Anne, glancing
      // at Mary, and then she answered:").
      const asksSomething =
        lineAsks || ((!goesOn || someoneElse) && asksInLine(r.slice(lastVoiced), answered));
      const asked =
        !othersAsk &&
        (((asksSomething || direct) && !recovers && !itself) ||
          // An asking tag's speaker may answer the question themself ("“Why?” asked Anne, and
          // she answered herself:"; not "she answered for both of them:").
          (tagVerb >= sentence &&
            tagVerb < v &&
            asking(tagVerb) &&
            !after.some(
              (w, i) =>
                SELF_WORDS.has(w) ||
                (w === 'own' && i === 1 && ['her', 'his', 'their'].includes(after[0]!)),
            )) ||
          called ||
          unknownCall);
      const skip = answerer !== undefined || (verb?.reply && !asked);
      // Someone the paragraph's narration names as a subject before the line is there to reply
      // ("Anne and Mary sat by the fire. “You’re late,” said Anne, and she replied:"; not "Anne
      // had a letter from Jane."). Not for a verb its speaker goes on with ("Mary looked up.
      // “You’re late,” said Anne, and she added:", "and then she went on:", "and she repeated:").
      const continuing = !!verb?.continues || ['repeated', 'repeats'].includes(wordAt(ts, v));
      // Nor when the line before was said to someone, who is there to reply (`called`).
      const present =
        skip || continuing || called
          ? []
          : units
              .filter((u) => !isVoiced(u) && u !== lastUnit)
              .flatMap((u) =>
                r.cast.keys(
                  r.cast
                    .mentions(tokens.get(u)!)
                    .filter((m) => !m.possessive && !afterPreposition(tokens.get(u)!, m)),
                ),
              )
              .filter((k) => k !== speaker && !replyTo.has(k) && r.cast.entry(k).gender === gender);
      intro.speaker = someone(
        r.turns.byGender(
          gender,
          replyTo,
          skip ? undefined : verb,
          answerer ? [answerer] : [...new Set(present.reverse())],
        ),
      );
      intro.notTeller = !intro.speaker;
      if (!intro.speaker) intro.gender = gender;
    } else if (ts.some((_, i) => isVerb(r, ts, i))) {
      // The intro's own verb, after the tag's, names its subject: "“Where were you?” said Will,
      // and Tom answered:" introduces Tom, "“Out,” said Anne. Mary frowned and answered:" Mary.
      const mentions = r.cast.mentions(ts);
      const own =
        v !== -1 && v !== tagVerb
          ? (subjectKey(r, ts, v, mentions) ??
            coordinatedSubject(r, ts, v, lastSentenceStart(ts.slice(0, v + 1)), mentions))
          : undefined;
      intro.speaker = own ?? who;
    }
  }
  return intro;
}

/** The colon intro a narration paragraph ends with, in its last unit `last`. */
export function narrationIntro(r: Reading, last: Unit, ts: Token[], mentions: Mention[]): Intro {
  const intro: Intro = { notTeller: false };
  const start = lastSentenceStart(ts);
  const verbIndex = beforeVerb(r, last, ts);
  if (verbIndex === -1) {
    // "At last the old man spoke:" without a speech verb: the sentence's subject.
    intro.speaker = sentenceSubject(r, ts, start, mentions);
    if (!intro.speaker) {
      // "She hesitated:" with no "she" found is read like "She said:".
      intro.gender = heOrShe(openingSubject(ts, start, mentions));
      intro.notTeller = intro.gender !== undefined;
    }
    return intro;
  }
  // "Then she said:", "She turned and said:": someone of that gender, and nobody else.
  const gender = pronounSubject(ts, verbIndex, mentions);
  const previous = lastSentenceStart(ts.slice(0, start));
  intro.speaker = gender
    ? someone(r.turns.byGender(gender, new Set()))
    : (subjectKey(r, ts, verbIndex, mentions) ??
      // "Tom turned to Anne and said:"
      coordinatedSubject(r, ts, verbIndex, start, mentions) ??
      someone(nearestBefore(r, ts, verbIndex, start, mentions)) ??
      // The subject of the sentence before (not past a time phrase that opens it: "That night I
      // lay awake. At dawn somebody knocked at the door and said:")
      (start > 0 && timeOpening(ts, previous) === undefined
        ? sentenceSubject(r, ts, previous, mentions)
        : undefined));
  // A colon intro that names nobody is read like a tag: "Then I was asked:" is not the teller.
  intro.notTeller =
    !intro.speaker && (saidToTeller(ts, verbIndex) || notTeller(r, ts, verbIndex, mentions));
  if (!intro.speaker) intro.gender = gender;
  return intro;
}
