import type { Gender } from '@/format/types';
import {
  ADDRESSEE_MARKERS,
  AFTER_VERB_PAIRS,
  AFTER_VERB_SKIP,
  BARE_OBJECTS,
  BEFORE_VERB_SKIP,
  COORDINATORS,
  DETERMINERS,
  EPICENE,
  NAME_PARTICLES,
  NON_PARTICIPANT_PREPOSITIONS,
  NOT_NAMES,
  POSSESSIVE_DETERMINERS,
  PRONOUNS,
  QUESTION_AUXILIARIES,
  QUESTION_LEADS,
  RELATIVES,
  SPEAKER_NOUNS,
  TITLES,
  VERBS,
  type VerbInfo,
} from './lexicon';
import { gluedAt, LY_ADVERB, UPPER, wordAt, type Mention, type Token } from './tokens';

export type Subject =
  { kind: 'mention'; mention: Mention } | { kind: 'pronoun'; gender: Gender | 'narrator' };

// Letters, combining marks (NFD text) and digits. An apostrophe or a single hyphen may join
// letters inside a word ("don't", "Anne-Marie"); "--" and spaced dashes stay breaks.
const WORD = /[\p{L}\p{M}\p{N}]+(?:(?:['’]|-(?=\p{L}))[\p{L}\p{M}]+)*\.?/gu;
const SENTENCE_BREAK = /[.!?;:—–\-(“”"_]$/u;
const ALL_CAPS = /^[\p{Lu}\p{M}'’.-]{2,}$/u;
const POSSESSIVE = /^(\p{Lu}[\p{L}\p{M}'’-]*?)['’]s$/u;

/** `startsSentence`: whether the text's first word begins a sentence (false for a tag after speech). */
export function tokenize(text: string, startsSentence = true): Token[] {
  const tokens: Token[] = [];
  let prevEnd = 0;
  for (const m of text.matchAll(WORD)) {
    let word = m[0];
    // Keep a trailing period only on titles ("Mr."); otherwise it ends the sentence.
    if (word.endsWith('.') && !(word in TITLES)) word = word.slice(0, -1);
    const gap = text.slice(prevEnd, m.index);
    const punctBefore = gap.replace(/\s+/gu, '');
    const possessive = POSSESSIVE.exec(word);
    tokens.push({
      text: possessive ? possessive[1]! : word,
      end: m.index + word.length,
      // A title keeps its period ("Mr."), so a period in the gap always ends a sentence.
      sentenceStart: tokens.length === 0 ? startsSentence : SENTENCE_BREAK.test(punctBefore),
      punctBefore,
      ...(possessive ? { possessive: true } : {}),
    });
    prevEnd = m.index + word.length;
  }
  return tokens;
}

/**
 * Finds names ("Mr. Bennet") and speaker descriptors ("his wife"). A run of capitalised words at
 * the start of a sentence, or in capitals, only counts as a name when `isKnownName` recognises it
 * or its first words.
 */
export function findMentions(tokens: Token[], isKnownName: (name: string) => boolean): Mention[] {
  const mentions: Mention[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const named = nameAt(tokens, i, isKnownName);
    if (named) {
      if (named.mention) mentions.push(named.mention);
      i = named.next - 1;
      continue;
    }
    const descriptor = descriptorAt(tokens, i);
    if (descriptor) {
      mentions.push(descriptor);
      i = descriptor.last;
    }
  }
  return mentions;
}

/** The pronoun a word is, if any: "She" at a sentence start too, and "I’d" as "I". */
export function isPronoun(text: string): Gender | 'narrator' | undefined {
  return PRONOUNS[text] ?? PRONOUNS[text.replace(/’/gu, "'")] ?? PRONOUNS[text.toLowerCase()];
}

function isCapitalisedName(t: Token): boolean {
  return UPPER.test(t.text) && !NOT_NAMES.has(t.text) && isPronoun(t.text) === undefined;
}

/**
 * The name starting at token i, if any, and where scanning resumes. A rejected run of
 * capitalised words (an unknown name at a sentence start, a heading in capitals) is skipped
 * whole, so its tail never becomes a name ("Elizabeth Bennet smiled" never yields "Bennet"),
 * unless a title inside it opens one ("Even Mr. Darcy smiled" yields "Mr. Darcy").
 */
function nameAt(
  tokens: Token[],
  i: number,
  isKnownName: (name: string) => boolean,
): { mention: Mention | null; next: number } | null {
  const first = i;
  let title: Gender | undefined;
  let hasTitle = false;
  const t = tokens[i]!;
  const next = tokens[i + 1];
  // "de Winter" in "Mr. de Winter"
  const particleAt = (k: number) =>
    NAME_PARTICLES.has(tokens[k]?.text ?? '') &&
    !tokens[k]!.punctBefore &&
    tokens[k + 1] !== undefined &&
    !tokens[k + 1]!.punctBefore &&
    isCapitalisedName(tokens[k + 1]!);
  if (t.text in TITLES && next && !next.punctBefore && !t.possessive) {
    if (!isCapitalisedName(next) && !particleAt(i + 1)) return null;
    title = TITLES[t.text];
    hasTitle = true;
    i += isCapitalisedName(next) ? 1 : 2;
  }
  if (!isCapitalisedName(tokens[i]!)) return null;

  let last = i;
  while (last - first < 3 && !tokens[last]!.possessive) {
    const n = tokens[last + 1];
    if (!n || n.punctBefore) break;
    if (isCapitalisedName(n)) last++;
    else if (particleAt(last + 1)) last += 2;
    else break;
  }

  const nameTo = (end: number) =>
    tokens
      .slice(first, end + 1)
      .map((x) => x.text)
      .join(' ');
  const name = nameTo(last);
  const words = tokens.slice(first, last + 1).filter((w) => !(w.text in TITLES));
  const shouting = words.every((w) => ALL_CAPS.test(w.text));
  const startsSentence = tokens[first]!.sentenceStart && !hasTitle;
  if ((startsSentence || shouting) && !isKnownName(name)) {
    // Its longest known beginning ("Jane" in "Jane Bennet smiled" when only Jane is known).
    for (let end = last - 1; end >= (hasTitle ? first + 1 : first); end--) {
      if (isKnownName(nameTo(end))) {
        return {
          mention: { kind: 'name', name: nameTo(end), gender: title, first, last: end },
          next: last + 1,
        };
      }
    }
    // A title inside the run opens a name ("Even Mr. Darcy"): resume there.
    // "St." also sits inside a full name ("Elizabeth St. Clair").
    for (let k = first + 1; k <= last; k++) {
      const word = tokens[k]!.text;
      if (word in TITLES && word !== 'St.') {
        return { mention: null, next: k };
      }
    }
    return { mention: null, next: last + 1 };
  }

  const possessive = tokens[last]!.possessive === true;
  // "Lucy’s mother": a possessive name before a speaker noun is a descriptor.
  const noun = tokens[last + 1];
  const nounWord = noun?.text.toLowerCase() ?? '';
  if (
    possessive &&
    noun &&
    !noun.punctBefore &&
    nounWord in SPEAKER_NOUNS &&
    !EPICENE.has(nounWord)
  ) {
    return {
      mention: {
        kind: 'descriptor',
        name: `${name}’s ${nounWord}`,
        gender: SPEAKER_NOUNS[nounWord],
        first,
        last: last + 1,
      },
      next: last + 2,
    };
  }
  return {
    mention: {
      kind: 'name',
      name,
      gender: title,
      first,
      last,
      ...(possessive ? { possessive } : {}),
    },
    next: last + 1,
  };
}

function descriptorAt(tokens: Token[], i: number): Mention | null {
  const det = tokens[i]!.text.toLowerCase();
  if (!DETERMINERS.has(det)) return null;
  // det [adjective] [adjective] noun
  for (let n = i + 1; n <= i + 3 && n < tokens.length; n++) {
    const tok = tokens[n]!;
    if (tok.punctBefore || UPPER.test(tok.text)) return null;
    const word = tok.text.toLowerCase();
    // Another determiner or a speech verb ends the phrase: "that her mother".
    if (DETERMINERS.has(word) || word in VERBS) return null;
    if (!(word in SPEAKER_NOUNS)) continue;
    const epicene = EPICENE.has(word);
    // "his voice": a voice that has an owner is not a speaker.
    if (epicene && POSSESSIVE_DETERMINERS.has(det)) return null;
    const last = n;
    const gender = SPEAKER_NOUNS[word];
    // "her sister Jane": the name that follows is the person.
    const after = tokens[last + 1];
    if (after && !after.punctBefore && isCapitalisedName(after)) {
      const named = nameAt(tokens, last + 1, () => true)?.mention;
      if (named?.kind === 'name') {
        return { ...named, gender: named.gender ?? gender, first: i };
      }
    }
    const words = tokens.slice(i, last + 1).map((x) => x.text.toLowerCase());
    return { kind: 'descriptor', name: words.join(' '), gender, first: i, last };
  }
  return null;
}

/**
 * The speech or thought verb at token i, if it is one there. An English -s form other than "says"
 * and "asks" also needs a subject, which only the heuristic can tell from the cast (see isVerb).
 */
export function verbAt(tokens: Token[], i: number): VerbInfo | undefined {
  const t = tokens[i];
  if (!t) return undefined;
  const word = t.text.toLowerCase();
  const info = VERBS[word];
  if (!info) return undefined;
  if (info.bare) {
    // "I ask." / "I tell him.": only right after "I", at the end of its clause.
    const object = (k: number) => gluedAt(tokens, k) && BARE_OBJECTS.has(tokens[k]!.text);
    let end = i + 1;
    if (info.thought) {
      // "I think she was lying" is no tag.
      if (object(end)) end++;
    } else {
      // "I tell Mrs. Pruett.", "I whisper to her.", "I tell myself.", "I ask Mom again."
      const person = (k: number) =>
        object(k) || (gluedAt(tokens, k) && tokens[k]!.text === 'myself');
      const capital = (k: number) => gluedAt(tokens, k) && UPPER.test(tokens[k]!.text);
      const to = gluedAt(tokens, end) && tokens[end]!.text === 'to';
      if (to && (person(end + 1) || capital(end + 1))) end++;
      if (person(end)) end++;
      else for (let n = 0; n < 3 && capital(end); n++) end++;
      const adverb = gluedAt(tokens, end) ? tokens[end]!.text : '';
      if (LY_ADVERB.test(adverb) || adverb === 'back' || adverb === 'again') end++;
    }
    if (tokens[i - 1]?.text !== 'I' || t.punctBefore || gluedAt(tokens, end)) return undefined;
    // "Should I tell Dad?", "What do I tell Mom?", "And can I ask?": a question, not a tag. The
    // auxiliary opens the clause, follows a question word, or a "?" ends the clause. "Only then
    // did I tell him." is a tag.
    const k = i - 2;
    const aux = tokens[k]?.text.toLowerCase().replace(/’/gu, "'");
    if (aux && gluedAt(tokens, i - 1) && QUESTION_AUXILIARIES.has(aux)) {
      const lead = gluedAt(tokens, k) ? tokens[k - 1]?.text.toLowerCase() : undefined;
      if (!lead || QUESTION_LEADS.has(lead) || tokens[end]?.punctBefore.includes('?')) {
        return undefined;
      }
    }
  }
  return info;
}

function pairAt(tokens: Token[], i: number): boolean {
  const a = tokens[i];
  const b = tokens[i + 1];
  return (
    !!a &&
    !!b &&
    !b.punctBefore &&
    AFTER_VERB_PAIRS.has(`${a.text.toLowerCase()} ${b.text.toLowerCase()}`)
  );
}

/**
 * Where a subject before the verb at `v` would be, past auxiliaries and adverbs ("Tom finally
 * said"); -1 when the verb follows punctuation.
 */
export function subjectIndexBefore(tokens: Token[], v: number): number {
  if (v === 0 || tokens[v]!.punctBefore) return -1;
  let b = v - 1;
  const skippable = (t: Token) =>
    BEFORE_VERB_SKIP.has(t.text.toLowerCase()) || (/ly$/u.test(t.text) && !UPPER.test(t.text));
  while (b > 0 && !tokens[b]!.punctBefore && skippable(tokens[b]!)) b--;
  return b;
}

/**
 * Whether the name or pronoun ending at `b` opens its sentence: at most three words before it,
 * none of them a name or a pronoun, and no preposition right before it ("Suddenly Tom", "That
 * evening Mr. Bennet", not "Tom told Anne").
 */
function opensSentence(tokens: Token[], b: number, mentions: Mention[]): boolean {
  const first = mentions.find((x) => x.last === b && !x.possessive)?.first ?? b;
  const before = wordAt(tokens, first - 1);
  const object = NON_PARTICIPANT_PREPOSITIONS.has(before) || ADDRESSEE_MARKERS.has(before);
  if (!tokens[first]!.punctBefore && object) return false;
  for (let k = first; k >= 0; k--) {
    const t = tokens[k]!;
    if (k < first && (isPronoun(t.text) || mentions.some((x) => x.first === k))) return false;
    if (t.sentenceStart || k === 0) return first - k <= 3;
    if (k < first && t.punctBefore && t.punctBefore !== ',') return false;
  }
  return false;
}

/** How many words an aside between a subject and its verb may have ("Tom, red-faced, shouted"). */
export const ASIDE_WINDOW = 6;

/**
 * The subject of the verb at `v`. A subject right before the verb ("Tom asked Anne", "I had
 * said"), or right before a short aside between commas ("Tom, red-faced, shouted", "At last
 * Mr. Bennet, laying down his paper, said"), wins over a word after it, which is only the subject
 * of an inverted tag ("said Anne"); "to Anne" is the person spoken to. A stretch that "and" opens
 * is no aside: it joins the verb to the clause before it, so the person before it is no subject
 * ("Tom told Anne, and after a pause, added"), unless they open the sentence ("Suddenly Tom, and I
 * shall never forget it, shouted").
 */
export function subjectOf(tokens: Token[], v: number, mentions: Mention[]): Subject | null {
  const subjectAt = (b: number): Subject | null => {
    const pronoun = isPronoun(tokens[b]!.text);
    if (pronoun) return { kind: 'pronoun', gender: pronoun };
    const m = mentions.find((x) => x.last === b && !x.possessive);
    return m ? { kind: 'mention', mention: m } : null;
  };
  const b = subjectIndexBefore(tokens, v);
  if (b !== -1) {
    const subject = subjectAt(b);
    if (subject) return subject;
    // "the man, who said"
    if (RELATIVES.has(tokens[b]!.text.toLowerCase())) {
      const rel = mentions.find((x) => x.last === b - 1);
      if (rel) return { kind: 'mention', mention: rel };
    }
  } else if (tokens[v]?.punctBefore === ',') {
    let k = v - 1;
    while (k > 0 && v - k < ASIDE_WINDOW && !tokens[k]!.punctBefore) k--;
    const opener = wordAt(tokens, k);
    if (k > 0 && tokens[k]!.punctBefore === ',') {
      const subject = subjectAt(k - 1);
      // After "and" an inverted subject of the verb's own wins.
      const joins = COORDINATORS.has(opener);
      const opens = () =>
        opensSentence(tokens, k - 1, mentions) && !subjectAfter(tokens, v, mentions);
      if (subject && (!joins || opens())) return subject;
    }
  }
  return subjectAfter(tokens, v, mentions);
}

/** The subject of an inverted tag, right after the verb at `v` past adverbs ("said Anne"). */
function subjectAfter(tokens: Token[], v: number, mentions: Mention[]): Subject | null {
  let a = v + 1;
  while (tokens[a] && !tokens[a]!.punctBefore) {
    if (AFTER_VERB_SKIP.has(tokens[a]!.text.toLowerCase())) a++;
    else if (pairAt(tokens, a)) a += 2;
    else break;
  }
  const after = tokens[a];
  if (!after || after.punctBefore) return null;
  if (ADDRESSEE_MARKERS.has(after.text.toLowerCase())) return null;
  const pronoun = isPronoun(after.text);
  if (pronoun) return { kind: 'pronoun', gender: pronoun };
  const m = mentions.find((x) => x.first === a && !x.possessive);
  if (m) return { kind: 'mention', mention: m };
  // "says the Lord High Chancellor": the article is not part of the name.
  const article = after.text === 'the';
  const named = article ? mentions.find((x) => x.first === a + 1 && x.kind === 'name') : undefined;
  return named ? { kind: 'mention', mention: named } : null;
}
