import type { Gender, Lang } from '@/format/types';
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
  PREPOSITIONS,
  PRONOUNS,
  QUESTION_AUXILIARIES,
  QUESTION_LEADS,
  RELATIVES,
  SPEAKER_NOUNS,
  TITLES,
  VERBS,
  type VerbInfo,
} from './lexicon';

export interface Token {
  text: string;
  start: number;
  end: number;
  /** First word of a sentence, clause after a dash, or quoted passage. */
  sentenceStart: boolean;
  /** Punctuation between the previous token and this one (whitespace removed). */
  punctBefore: string;
  /** A capitalised word that ended in ’s ("Elizabeth’s"); `text` is the name without it. */
  possessive?: boolean;
}

export interface Mention {
  kind: 'name' | 'descriptor';
  /** Names keep their case ("Mr. Bennet"); descriptors are lower-case ("el viajero"). */
  name: string;
  gender?: Gender;
  first: number;
  last: number;
  /** "Elizabeth’s": refers to Elizabeth, but is never the subject of a verb. */
  possessive?: boolean;
  /** The speaker noun before a name: "sister" in "her sister Jane", "tío" in "su tío Jesús". */
  noun?: string;
}

export type Subject =
  { kind: 'mention'; mention: Mention } | { kind: 'pronoun'; gender: Gender | 'narrator' };

// Letters, combining marks (NFD text) and digits. An apostrophe or a single hyphen may join
// letters inside a word ("don't", "Anne-Marie"); "--" and spaced dashes stay breaks.
const WORD = /[\p{L}\p{M}\p{N}]+(?:(?:['’]|-(?=\p{L}))[\p{L}\p{M}]+)*\.?/gu;
const SENTENCE_BREAK = /[.!?;:—–\-¿¡(“”"«»_]$/u;
const UPPER = /^\p{Lu}/u;
const ALL_CAPS = /^[\p{Lu}\p{M}'’.-]{2,}$/u;
const POSSESSIVE = /^(\p{Lu}[\p{L}\p{M}'’-]*?)['’]s$/u;

/** `startsSentence`: whether the text's first word begins a sentence (false for a tag after speech). */
export function tokenize(text: string, lang: Lang, startsSentence = true): Token[] {
  const tokens: Token[] = [];
  let prevEnd = 0;
  for (const m of text.matchAll(WORD)) {
    let word = m[0];
    // Keep a trailing period only on titles ("Mr."); otherwise it ends the sentence.
    if (word.endsWith('.') && !(word in TITLES[lang])) word = word.slice(0, -1);
    const gap = text.slice(prevEnd, m.index);
    const punctBefore = gap.replace(/\s+/gu, '');
    const possessive = POSSESSIVE.exec(word);
    tokens.push({
      text: possessive ? possessive[1]! : word,
      start: m.index,
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
 * Finds names ("Mr. Bennet", "Teodoro Golfín", "la Nela" → "Nela") and speaker descriptors
 * ("his wife", "el misterioso joven", "una voz de hombre"). A run of capitalised words at the
 * start of a sentence, or in capitals, only counts as a name when `isKnownName` recognises it or
 * its first words.
 */
export function findMentions(
  tokens: Token[],
  lang: Lang,
  isKnownName: (name: string) => boolean,
): Mention[] {
  const mentions: Mention[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const named = nameAt(tokens, i, lang, isKnownName);
    if (named) {
      if (named.mention) mentions.push(named.mention);
      i = named.next - 1;
      continue;
    }
    const descriptor = descriptorAt(tokens, i, lang);
    if (descriptor) {
      mentions.push(descriptor);
      i = descriptor.last;
    }
  }
  return mentions;
}

/** The pronoun a word is, if any: "She" at a sentence start too, and "I’d" as "I". */
export function isPronoun(text: string, lang: Lang): Gender | 'narrator' | undefined {
  const pronouns = PRONOUNS[lang];
  return (
    pronouns[text] ??
    pronouns[text.replace(/’/gu, "'")] ??
    (text === 'I' ? undefined : pronouns[text.toLowerCase()])
  );
}

function isCapitalisedName(t: Token, lang: Lang): boolean {
  return (
    UPPER.test(t.text) && !NOT_NAMES[lang].has(t.text) && isPronoun(t.text, lang) === undefined
  );
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
  lang: Lang,
  isKnownName: (name: string) => boolean,
): { mention: Mention | null; next: number } | null {
  let first = i;
  let title: Gender | undefined;
  let hasTitle = false;
  const t = tokens[i]!;
  const next = tokens[i + 1];
  // "de Winter" in "Mr. de Winter"
  const particleAt = (k: number) =>
    NAME_PARTICLES[lang].has(tokens[k]?.text ?? '') &&
    !tokens[k]!.punctBefore &&
    tokens[k + 1] !== undefined &&
    !tokens[k + 1]!.punctBefore &&
    isCapitalisedName(tokens[k + 1]!, lang);
  if (t.text in TITLES[lang] && next && !next.punctBefore && !t.possessive) {
    if (!isCapitalisedName(next, lang) && !particleAt(i + 1)) return null;
    title = TITLES[lang][t.text];
    hasTitle = true;
    i += isCapitalisedName(next, lang) ? 1 : 2;
  } else if (
    lang === 'es' &&
    (t.text === 'el' || t.text === 'la') &&
    next &&
    !next.punctBefore &&
    isCapitalisedName(next, lang)
  ) {
    // "la Nela": the article is not part of the name.
    first = i + 1;
    i++;
  }
  if (!isCapitalisedName(tokens[i]!, lang)) return null;

  let last = i;
  while (last - first < 3 && !tokens[last]!.possessive) {
    const n = tokens[last + 1];
    if (!n || n.punctBefore) break;
    if (isCapitalisedName(n, lang)) last++;
    else if (particleAt(last + 1)) last += 2;
    else break;
  }

  const nameTo = (end: number) =>
    tokens
      .slice(first, end + 1)
      .map((x) => x.text)
      .join(' ');
  const name = nameTo(last);
  const words = tokens.slice(first, last + 1).filter((w) => !(w.text in TITLES[lang]));
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
    // A title inside the run opens a name ("Even Mr. Darcy", "Pobre Don Pablo"): resume there.
    // "St." and "D." also sit inside a full name ("Elizabeth St. Clair", "Juan D. Pérez").
    for (let k = first + 1; k <= last; k++) {
      const word = tokens[k]!.text;
      if (word in TITLES[lang] && word !== 'St.' && word !== 'D.') {
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
    nounWord in SPEAKER_NOUNS[lang] &&
    !EPICENE[lang].has(nounWord)
  ) {
    return {
      mention: {
        kind: 'descriptor',
        name: `${name}’s ${nounWord}`,
        gender: SPEAKER_NOUNS[lang][nounWord],
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

function descriptorAt(tokens: Token[], i: number, lang: Lang): Mention | null {
  const det = tokens[i]!.text.toLowerCase();
  if (!(det in DETERMINERS[lang])) return null;
  const nouns = SPEAKER_NOUNS[lang];
  // det [adjective] [adjective] noun
  for (let n = i + 1; n <= i + 3 && n < tokens.length; n++) {
    const tok = tokens[n]!;
    if (tok.punctBefore || UPPER.test(tok.text)) return null;
    const word = tok.text.toLowerCase();
    // Another determiner or a speech verb ends the phrase: "that her mother", "la interrumpió el doctor".
    if (word in DETERMINERS[lang] || word in VERBS[lang]) return null;
    if (!(word in nouns)) continue;
    const epicene = EPICENE[lang].has(word);
    // "his voice", "su voz": a voice that has an owner is not a speaker.
    if (epicene && POSSESSIVE_DETERMINERS[lang].has(det)) return null;
    let last = n;
    let gender = epicene ? undefined : (nouns[word] ?? DETERMINERS[lang][det]);
    // "una voz de hombre": a speaker noun qualified by another one.
    const de = tokens[n + 1];
    const qualifier = tokens[n + 2];
    if (
      lang === 'es' &&
      de?.text === 'de' &&
      !de.punctBefore &&
      qualifier &&
      !qualifier.punctBefore &&
      qualifier.text in nouns
    ) {
      last = n + 2;
      gender = nouns[qualifier.text] ?? gender;
    }
    // "her sister Jane", "el doctor Golfín": the name that follows is the person.
    const after = tokens[last + 1];
    if (after && !after.punctBefore && isCapitalisedName(after, lang)) {
      const named = nameAt(tokens, last + 1, lang, () => true)?.mention;
      if (named?.kind === 'name') {
        return { ...named, gender: named.gender ?? gender, first: i, noun: word };
      }
    }
    const words = tokens.slice(i, last + 1).map((x) => x.text.toLowerCase());
    // "al doctor" / "del doctor" name the same person as "el doctor".
    if (lang === 'es' && (words[0] === 'al' || words[0] === 'del')) words[0] = 'el';
    return { kind: 'descriptor', name: words.join(' '), gender, first: i, last };
  }
  return null;
}

const ACCENTED: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u' };
const ENCLITIC = /^(\p{L}+?)(les|los|las|nos|le|lo|la|me|te|se)$/u;

/**
 * The speech or thought verb at token i, if it is one there. An English -s form other than "says"
 * and "asks" also needs a subject, which only the heuristic can tell from the cast (see isVerb).
 */
export function verbAt(tokens: Token[], i: number, lang: Lang): VerbInfo | undefined {
  const t = tokens[i];
  if (!t) return undefined;
  const word = t.text.toLowerCase();
  let info = VERBS[lang][word];
  // "díjole", "preguntóle": a verb with an enclitic pronoun (older Spanish).
  const enclitic = !info && lang === 'es' ? ENCLITIC.exec(word) : null;
  if (enclitic) {
    const base = enclitic[1]!;
    info = VERBS.es[base] ?? VERBS.es[base.replace(/[áéíóú]/u, (c) => ACCENTED[c]!)];
    // A real first-person or "-se" form keeps its written accent ("díjele", "preguntéle",
    // "díjose"). Without one, "dijese" and "preguntase" are subjunctives, and "preguntole" is
    // "preguntó" + "le" in modern spelling.
    if (info && !/[áéíóú]/u.test(word) && (info.firstPerson || enclitic[2] === 'se')) {
      info = base.endsWith('o') ? VERBS.es[`${base.slice(0, -1)}ó`] : undefined;
    }
  }
  if (!info) return undefined;
  if (info.bare) {
    // "I ask." / "I tell him.": only right after "I", at the end of its clause.
    const glued = (k: number) => !!tokens[k] && !tokens[k]!.punctBefore;
    const object = (k: number) => glued(k) && BARE_OBJECTS.has(tokens[k]!.text);
    let end = i + 1;
    if (info.thought) {
      // "I think she was lying" is no tag.
      if (object(end)) end++;
    } else {
      // "I tell Mrs. Pruett.", "I whisper to her.", "I tell myself.", "I ask Mom again."
      const person = (k: number) => object(k) || (glued(k) && tokens[k]!.text === 'myself');
      const capital = (k: number) => glued(k) && UPPER.test(tokens[k]!.text);
      if (glued(end) && tokens[end]!.text === 'to' && (person(end + 1) || capital(end + 1))) end++;
      if (person(end)) end++;
      else for (let n = 0; n < 3 && capital(end); n++) end++;
      const adverb = tokens[end]?.text ?? '';
      if (glued(end) && (/^\p{Ll}+ly$/u.test(adverb) || adverb === 'back' || adverb === 'again')) {
        end++;
      }
    }
    if (tokens[i - 1]?.text !== 'I' || t.punctBefore || glued(end)) return undefined;
    // "Should I tell Dad?", "What do I tell Mom?", "And can I ask?": a question, not a tag. The
    // auxiliary opens the clause, follows a question word, or a "?" ends the clause. "Only then
    // did I tell him." is a tag.
    const k = i - 2;
    const aux = tokens[k]?.text.toLowerCase().replace(/’/gu, "'");
    if (aux && glued(i - 1) && QUESTION_AUXILIARIES.has(aux)) {
      const lead = glued(k) ? tokens[k - 1]?.text.toLowerCase() : undefined;
      if (!lead || QUESTION_LEADS.has(lead) || tokens[end]?.punctBefore.includes('?')) {
        return undefined;
      }
    }
  }
  // "un grito", "el pienso": a first-person form right after a determiner is a noun.
  const prev = t.punctBefore ? undefined : tokens[i - 1]?.text.toLowerCase();
  if (info.firstPerson && prev !== undefined && prev in DETERMINERS[lang]) return undefined;
  return info;
}

function pairAt(tokens: Token[], i: number, lang: Lang): boolean {
  const a = tokens[i];
  const b = tokens[i + 1];
  return (
    !!a &&
    !!b &&
    !b.punctBefore &&
    AFTER_VERB_PAIRS[lang].has(`${a.text.toLowerCase()} ${b.text.toLowerCase()}`)
  );
}

/**
 * Where a subject before the verb at `v` would be, past clitics, auxiliaries and adverbs ("Tom
 * finally said", "Ana le dijo"); -1 when the verb follows punctuation.
 */
export function subjectIndexBefore(tokens: Token[], v: number, lang: Lang): number {
  if (v === 0 || tokens[v]!.punctBefore) return -1;
  let b = v - 1;
  const skippable = (t: Token) =>
    BEFORE_VERB_SKIP[lang].has(t.text.toLowerCase()) ||
    (lang === 'en' && /ly$/u.test(t.text) && !UPPER.test(t.text));
  while (b > 0 && !tokens[b]!.punctBefore && skippable(tokens[b]!)) b--;
  return b;
}

/**
 * Whether the name or pronoun ending at `b` opens its sentence: at most three words before it,
 * none of them a name or a pronoun, and no preposition right before it ("Suddenly Tom", "That
 * evening Mr. Bennet", not "Tom told Anne", "Miré a Nela").
 */
function opensSentence(tokens: Token[], b: number, mentions: Mention[], lang: Lang): boolean {
  const first = mentions.find((x) => x.last === b && !x.possessive)?.first ?? b;
  const before = tokens[first - 1]?.text.toLowerCase() ?? '';
  const object =
    NON_PARTICIPANT_PREPOSITIONS[lang].has(before) ||
    ADDRESSEE_MARKERS[lang].has(before) ||
    PREPOSITIONS[lang].has(before);
  if (!tokens[first]!.punctBefore && object) return false;
  for (let k = first; k >= 0; k--) {
    const t = tokens[k]!;
    if (k < first && (isPronoun(t.text, lang) || mentions.some((x) => x.first === k))) return false;
    if (t.sentenceStart || k === 0) return first - k <= 3;
    if (k < first && t.punctBefore && t.punctBefore !== ',') return false;
  }
  return false;
}

/** How many words an aside between a subject and its verb may have ("Tom, red-faced, shouted"). */
export const ASIDE_WINDOW = 6;

/**
 * The subject of the verb at `v`. A subject right before the verb ("Tom asked Anne", "Ana le
 * dijo", "I had said"), or right before a short aside between commas ("Tom, red-faced, shouted",
 * "At last Mr. Bennet, laying down his paper, said"), wins over a word after it, which is only the
 * subject of an inverted tag ("said Anne", "dijo entonces el doctor", "dijo la Nela"); "to Anne",
 * "al ciego" are the people spoken to. A stretch that "and" or "y" opens is no aside: it joins the
 * verb to the clause before it, so the person before it is no subject ("Nela miró a Pablo, y
 * después de un rato, dijo:", "Tom told Anne, and after a pause, added"), unless they open the
 * sentence ("Suddenly Tom, and I shall never forget it, shouted").
 */
export function subjectOf(
  tokens: Token[],
  v: number,
  mentions: Mention[],
  lang: Lang,
): Subject | null {
  const subjectAt = (b: number): Subject | null => {
    const pronoun = isPronoun(tokens[b]!.text, lang);
    if (pronoun) return { kind: 'pronoun', gender: pronoun };
    const m = mentions.find((x) => x.last === b && !x.possessive);
    return m ? { kind: 'mention', mention: m } : null;
  };
  const b = subjectIndexBefore(tokens, v, lang);
  if (b !== -1) {
    const subject = subjectAt(b);
    if (subject) return subject;
    // "una voz de hombre, que dijo" / "the man, who said"
    if (RELATIVES[lang].has(tokens[b]!.text.toLowerCase())) {
      const rel = mentions.find((x) => x.last === b - 1);
      if (rel) return { kind: 'mention', mention: rel };
    }
  } else if (tokens[v]?.punctBefore === ',') {
    let k = v - 1;
    while (k > 0 && v - k < ASIDE_WINDOW && !tokens[k]!.punctBefore) k--;
    const opener = tokens[k]?.text.toLowerCase() ?? '';
    if (k > 0 && tokens[k]!.punctBefore === ',') {
      const subject = subjectAt(k - 1);
      // After "and" an inverted subject of the verb's own wins ("—dijo Ana, y después de un rato,
      // respondió Pablo").
      const joins = COORDINATORS[lang].has(opener);
      const opens = () =>
        opensSentence(tokens, k - 1, mentions, lang) && !subjectAfter(tokens, v, mentions, lang);
      if (subject && (!joins || opens())) return subject;
    }
  }
  return subjectAfter(tokens, v, mentions, lang);
}

/** The subject of an inverted tag, right after the verb at `v` past adverbs ("said Anne"). */
function subjectAfter(tokens: Token[], v: number, mentions: Mention[], lang: Lang): Subject | null {
  let a = v + 1;
  while (tokens[a] && !tokens[a]!.punctBefore) {
    if (AFTER_VERB_SKIP[lang].has(tokens[a]!.text.toLowerCase())) a++;
    else if (pairAt(tokens, a, lang)) a += 2;
    else break;
  }
  const after = tokens[a];
  if (!after || after.punctBefore) return null;
  if (ADDRESSEE_MARKERS[lang].has(after.text.toLowerCase())) return null;
  const pronoun = isPronoun(after.text, lang);
  if (pronoun) return { kind: 'pronoun', gender: pronoun };
  const m = mentions.find((x) => x.first === a && !x.possessive);
  if (m) return { kind: 'mention', mention: m };
  // "dijo la Nela", "says the Lord High Chancellor": the article is not part of the name.
  const article = lang === 'es' ? after.text === 'el' || after.text === 'la' : after.text === 'the';
  const named = article ? mentions.find((x) => x.first === a + 1 && x.kind === 'name') : undefined;
  return named ? { kind: 'mention', mention: named } : null;
}
