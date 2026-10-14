import type { Gender, Lang } from '@/format/types';
import {
  DETERMINERS,
  NAME_PARTICLES,
  NOT_NAMES,
  PRONOUNS,
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
}

export interface Mention {
  kind: 'name' | 'descriptor';
  /** Names keep their case ("Mr. Bennet"); descriptors are lower-case ("el viajero"). */
  name: string;
  gender?: Gender;
  first: number;
  last: number;
}

export type Subject =
  { kind: 'mention'; mention: Mention } | { kind: 'pronoun'; gender: Gender | 'narrator' };

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*\.?/gu;
const SENTENCE_BREAK = /[.!?;:—–\-¿¡(“”"«»_]$/u;
const UPPER = /^\p{Lu}/u;

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
    tokens.push({
      text: word,
      start: m.index,
      end: m.index + word.length,
      // A title keeps its period ("Mr."), so a period in the gap always ends a sentence.
      sentenceStart: tokens.length === 0 ? startsSentence : SENTENCE_BREAK.test(punctBefore),
      punctBefore,
    });
    prevEnd = m.index + word.length;
  }
  return tokens;
}

/**
 * Finds names ("Mr. Bennet", "Teodoro Golfín", "la Nela" → "Nela") and speaker descriptors
 * ("his wife", "el misterioso joven", "una voz de hombre"). A capitalised word at the start of a
 * sentence only counts as a name when `isKnownName` recognises it.
 */
export function findMentions(
  tokens: Token[],
  lang: Lang,
  isKnownName: (name: string) => boolean,
): Mention[] {
  const mentions: Mention[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const mention = nameAt(tokens, i, lang, isKnownName) ?? descriptorAt(tokens, i, lang);
    if (mention) {
      mentions.push(mention);
      i = mention.last;
    }
  }
  return mentions;
}

function isCapitalisedName(t: Token, lang: Lang): boolean {
  return UPPER.test(t.text) && !NOT_NAMES[lang].has(t.text) && !(t.text in PRONOUNS[lang]);
}

function nameAt(
  tokens: Token[],
  i: number,
  lang: Lang,
  isKnownName: (name: string) => boolean,
): Mention | null {
  let first = i;
  let title: Gender | undefined;
  let hasTitle = false;
  const t = tokens[i]!;
  if (t.text in TITLES[lang] && tokens[i + 1] && !tokens[i + 1]!.punctBefore) {
    if (!isCapitalisedName(tokens[i + 1]!, lang)) return null;
    title = TITLES[lang][t.text];
    hasTitle = true;
    i++;
  } else if (
    lang === 'es' &&
    (t.text === 'el' || t.text === 'la') &&
    tokens[i + 1] &&
    !tokens[i + 1]!.punctBefore &&
    isCapitalisedName(tokens[i + 1]!, lang)
  ) {
    // "la Nela": the article is not part of the name.
    first = i + 1;
    i++;
  }
  const head = tokens[i]!;
  if (!isCapitalisedName(head, lang)) return null;

  let last = i;
  while (last - first < 3) {
    const next = tokens[last + 1];
    if (!next || next.punctBefore) break;
    if (isCapitalisedName(next, lang)) {
      last++;
    } else if (
      NAME_PARTICLES[lang].has(next.text) &&
      tokens[last + 2] &&
      !tokens[last + 2]!.punctBefore &&
      isCapitalisedName(tokens[last + 2]!, lang)
    ) {
      last += 2;
    } else {
      break;
    }
  }

  const name = tokens
    .slice(first, last + 1)
    .map((x) => x.text)
    .join(' ');
  const startsSentence = tokens[first]!.sentenceStart && !hasTitle;
  if (startsSentence && !isKnownName(name)) return null;
  return { kind: 'name', name, gender: title, first, last };
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
    if (!(word in nouns)) continue;
    let last = n;
    let gender = nouns[word] ?? DETERMINERS[lang][det];
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
    const words = tokens.slice(i, last + 1).map((x) => x.text.toLowerCase());
    // "al doctor" / "del doctor" name the same person as "el doctor".
    if (lang === 'es' && (words[0] === 'al' || words[0] === 'del')) words[0] = 'el';
    return { kind: 'descriptor', name: words.join(' '), gender, first: i, last };
  }
  return null;
}

export function verbAt(tokens: Token[], i: number, lang: Lang): VerbInfo | undefined {
  const t = tokens[i];
  return t ? VERBS[lang][t.text.toLowerCase()] : undefined;
}

/** The subject of the verb at `v`: after it ("said Anne", "dijo el joven") or before it. */
export function subjectOf(
  tokens: Token[],
  v: number,
  mentions: Mention[],
  lang: Lang,
): Subject | null {
  const after = tokens[v + 1];
  if (after && !after.punctBefore) {
    const pronoun = PRONOUNS[lang][after.text];
    if (pronoun) return { kind: 'pronoun', gender: pronoun };
    const m = mentions.find((x) => x.first === v + 1);
    if (m) return { kind: 'mention', mention: m };
  }
  const before = tokens[v - 1];
  if (before && !tokens[v]!.punctBefore) {
    const pronoun = PRONOUNS[lang][before.text];
    if (pronoun) return { kind: 'pronoun', gender: pronoun };
    const m = mentions.find((x) => x.last === v - 1);
    if (m) return { kind: 'mention', mention: m };
    // "una voz de hombre, que dijo" / "the man, who said"
    if (RELATIVES[lang].has(before.text.toLowerCase())) {
      const rel = mentions.find((x) => x.last === v - 2);
      if (rel) return { kind: 'mention', mention: rel };
    }
  }
  return null;
}
