import type { Character, Gender, Lang, Mode, Tone, ToneLabel } from '@/format/types';
import { matchCast, type CastEntry } from '../castMatch';
import type { AliasAddition, LabelResult, NewCharacter, SpanLabel, SpeakerRef } from '../labels';
import type { Unit } from '../units';
import {
  ADDRESSEE_MARKERS,
  ADVERB_TONES,
  APPEARING_WHERE,
  ARRIVALS,
  ARRIVING,
  AFTER_VERB_SKIP,
  ASIDES,
  ASKING_VERBS,
  AUTHORIAL_SKIP,
  AUTHORIAL_VERBS,
  AUXILIARIES,
  BARE_OBJECTS,
  BEFORE_VERB_PAIRS,
  BEFORE_VERB_SKIP,
  BEING_THERE,
  CALLING_INTRODUCTIONS,
  CLAUSE_LEADS,
  CLITICS,
  COMMENT_VERBS,
  CONJUNCTIONS,
  COORDINATORS,
  DECISION_NOUNS,
  DEPARTURES,
  DETERMINERS,
  ENDEARMENTS,
  ENTERING,
  ENTRY_LEADS,
  FETCHING,
  FINITE_FORMS,
  FIRST_PERSON_WORDS,
  FREQUENCY_ADVERBS,
  HABIT_ADVERBS,
  HEADING_WORDS,
  KNOCKING_WHERE,
  LEAVING,
  NADA_NEGATIONS,
  NAME_ARTICLES,
  NAME_PARTICLES,
  NAME_OWNERS,
  NAME_QUESTIONS,
  NAME_WORDS,
  NEGATIONS,
  NICKNAME_QUALIFIERS,
  NON_PARTICIPANT_PREPOSITIONS,
  NOUN_LEADS,
  NOUN_LIKE_PASTS,
  OFFSTAGE_AUXILIARIES,
  OTHER_SUBJECTS,
  PERCEIVING,
  PHRASE_AFTER_PERSON,
  PREPOSITIONS,
  QUESTION_JOINS,
  QUESTION_LEADS,
  QUESTION_OPENERS,
  RECOVERY_GERUNDS,
  RECOVERY_WORDS,
  REFLEXIVES,
  RELATIVES,
  REPORTED_OBJECTS,
  SACRED_WORDS,
  SAYING_VERBS,
  SEEING_INFINITIVES,
  SEEING_VERBS,
  SELF_INTRODUCTIONS,
  SELF_WORDS,
  SENDING,
  SENTENCE_LEADS,
  SHORT_PAUSES,
  SPEAKER_NOUNS,
  SPEAKER_ONLY_NAMES,
  SPEAKER_STATE,
  STATE_NOUNS,
  STRONG_PRETERITES,
  SUBJECT_ADVERBS,
  SUBJECT_STARTS,
  SUBORDINATORS,
  THERE,
  TIME_AFTER_THAT,
  TIME_COMPARISONS,
  TIME_COUNTS,
  TIME_NOUNS,
  TIME_SHIFTS,
  UNTIL,
  type VerbInfo,
  WH_WORDS,
} from './lexicon';
import {
  ASIDE_WINDOW,
  findMentions,
  isPronoun,
  subjectIndexBefore,
  subjectOf,
  tokenize,
  verbAt,
  type Mention,
  type Subject,
  type Token,
} from './mentions';

export const HEURISTIC_VERSION = 2;

export interface HeuristicInput {
  text: string;
  lang: Lang;
  units: readonly Unit[];
  /** The story's current cast, including the narrator and the unknown speaker. */
  cast: readonly Character[];
}

/** How far into a tag (in words) the speech verb may appear: "said his lady" / "—dijo Ana". */
const TAG_WINDOW = 6;
/** Narration that leads into the line after it: "Tom said, “…”", "Ana le dijo:". */
const INTRO_END = /[,:]\s*$/u;
const CLOSING_QUOTE = /[”"»’']\s*$/u;
// "»" also opens a paragraph that continues a Spanish quotation (comillas de seguir).
const OPENING_QUOTE = /^\s*[“"«‘'»]/u;
const VOCATIVE_LEAD = new Set(['dear', 'querido', 'querida', 'oh', 'mi', 'my', 'amigo', 'amiga']);
const NOUN_BEFORE_THOUGHT = new Set([
  'a',
  'the',
  'his',
  'her',
  'that',
  'this',
  'my',
  'their',
  'our',
  'your',
  'no',
]);
// "Me llamaba Inés y tenía doce años": words that start the next clause after a name.
const CLAUSE_OPENERS = new Set(['y', 'e', 'pero', 'aunque', 'porque']);
// "someone said", "—dijo alguien": nobody in particular, and never the teller, who would say "I".
const INDEFINITE_SUBJECTS: Record<Lang, Set<string>> = {
  en: new Set(['someone', 'somebody', 'everyone', 'everybody']),
  es: new Set(['alguien']),
};
// "someone else", "alguien más".
const ELSE = new Set(['else', 'más']);
// "everyone had left": all who were there.
const EVERYONE: Record<Lang, Set<string>> = {
  en: new Set(['everyone', 'everybody']),
  es: new Set(['todos']),
};
const LOWER = /^\p{Ll}/u;

/** A speaker, and whether the teller's "I" chose them rather than a name or turn-taking. */
interface Who {
  key: string;
  teller: boolean;
}

/** What the narration between two lines says about the conversation before it. */
interface Stretch {
  /** A scene break, time passing or someone leaving ("* * *", "In the evening", "Tom left."). */
  changed: boolean;
}

interface Tag {
  verb: VerbInfo;
  tone?: ToneLabel;
  speaker?: string;
  /**
   * A he/she subject ("she said", or "she turned and said" with no "she" found yet), resolved
   * once the whole paragraph has been read.
   */
  pending?: Gender;
  /** The subject is the teller's "I" ("I said", "—respondí", "I … and said"), not a name. */
  teller: boolean;
  /** "—me dijo", "asked me": said to the teller, so not by them. */
  toTeller: boolean;
  /** "she asked", "someone said", "—dijo": someone other than the teller (see notTeller). */
  notTeller: boolean;
  /** "—me dije", "—se preguntó", "I told myself": talking to oneself is thinking. */
  thought: boolean;
  /** Other people named in the tag ("sin mirar al doctor"). */
  others: string[];
  /** People the line is said to ("to Anne", "a Pedro", "asked Holmes"): never its speaker. */
  addressees: string[];
}

/**
 * Free, deterministic speaker attribution. Per paragraph with speech:
 * 1. an explicit tag (speech verb + name, descriptor or pronoun, or a first-person verb) in the
 *    narration around the line, or an action beat right before it ("Tom shrugged.");
 * 2. a colon intro in the previous narration paragraph ("…, que dijo:");
 * 3. turn-taking: the most recent other participant (speakers, people addressed by name, people
 *    named in narration). In a part with speech tagged by the teller or said to them ("I said",
 *    "—respondí", "—me dijo") the teller takes part, and people who talk in the current scene
 *    rank above earlier speakers and people only mentioned;
 * 4. after a stretch of narration, the one person it introduced; otherwise the "unknown" speaker.
 * Narration, and "I" lines, go to the narrator; the teller flag marks them (see SpanLabel).
 */
export function analyzeHeuristic(input: HeuristicInput): LabelResult {
  return new Attributor(input).run();
}

class Attributor {
  private readonly lang: Lang;
  private readonly text: string;
  private readonly entries: CastEntry[];
  private readonly narratorKey: string;
  private readonly unknownKey: string;
  private readonly aliasAdditions: AliasAddition[] = [];
  private readonly lastActive = new Map<string, number>();
  /** When each participant last spoke. */
  private readonly spoke = new Map<string, number>();
  /** Characters whose gender byGender guessed in this part, which rules nobody out. */
  private readonly guessed = new Set<string>();
  /** Counts the names and aliases added to the cast, which change what mentions finds. */
  private castVersion = 0;
  private readonly mentionCache = new WeakMap<Token[], { version: number; mentions: Mention[] }>();
  private clock = 0;
  private newCount = 0;

  /** Some speech in this part is tagged by the teller or said to them, so the teller takes part. */
  private tellerSpeaks = false;
  private lastSpeaker?: string;
  /** The last line's speaker, the unknown speaker included. */
  private lastTurn?: Who;
  private colonSpeaker?: Who;
  /** The last colon intro names nobody, but its speaker is not the teller ("Se volvió y dijo:"). */
  private colonNotTeller = false;
  /** The "he" or "she" of the last colon intro, when nobody of that gender was found. */
  private colonGender?: Gender;
  /** Who said the last line, when it asked something. */
  private lastAsker?: string;
  /** The line `lastAsker` said. */
  private lastQuestion?: string;
  /** Who asked the question right before the last heading, until the next line. */
  private headingAsker?: string;
  private narrationGap = Infinity;
  private continuesSpeech = false;
  /** Characters the last narration paragraph brought in (not after a preposition). */
  private entrants: string[] = [];
  /** People the last speech paragraph was said to. */
  private addressed: string[] = [];
  /** When the current scene began: people who spoke before it have left the conversation. */
  private sceneStart = 0;
  /** The narration since the last line. */
  private stretch: Stretch = { changed: false };
  /**
   * Characters narration brought in who have not spoken yet: when, in which stretch, whether the
   * stretch had changed the scene before them, and whether they came in themselves, opening a
   * clause ("Then Anne came in"), rather than being only named ("I had not seen Anne").
   */
  private readonly newcomers = new Map<
    string,
    { entered: number; stretch: Stretch; changed: boolean; came: boolean; plan?: boolean }
  >();

  constructor(private readonly input: HeuristicInput) {
    this.lang = input.lang;
    this.text = input.text;
    this.entries = input.cast.map((c) => ({
      key: c.id,
      name: c.name,
      aliases: [...c.aliases],
      gender: c.gender,
      role: c.role,
    }));
    this.narratorKey = input.cast.find((c) => c.role === 'narrator')!.id;
    this.unknownKey = input.cast.find((c) => c.role === 'unknown')!.id;
  }

  run(): LabelResult {
    this.tellerSpeaks = this.findTellerTag();
    const spans: SpanLabel[] = [];
    for (const paragraph of groupByParagraph(this.input.units)) {
      spans.push(...this.paragraph(paragraph));
    }
    const used = new Set(spans.map((s) => (s.speaker.kind === 'new' ? s.speaker.ref : '')));
    const newCharacters: NewCharacter[] = this.entries
      .filter((e) => e.key.startsWith('new:') && used.has(e.key))
      .map((e) => ({
        ref: e.key,
        name: e.name,
        aliases: e.aliases,
        ...(e.gender ? { gender: e.gender } : {}),
      }));
    return { spans, newCharacters, aliasAdditions: this.aliasAdditions };
  }

  private paragraph(units: Unit[]): SpanLabel[] {
    const { tokens, isVoiced } = this.read(units);
    const voiced = units.filter(isVoiced);

    if (voiced.length === 0) {
      this.narrationParagraph(units, tokens);
      return units.map((u) => this.label(u, this.narratorKey, 'narration', undefined, true));
    }

    // Where each unit stands, so a long paragraph is never searched line by line.
    const at = new Map(units.map((u, n) => [u, n]));
    // Each voiced unit takes its nearest tag; untagged ones share the paragraph's speaker.
    const tags = new Map(voiced.map((u) => [u, this.tagNear(units, at.get(u)!, tokens, isVoiced)]));
    // The names each line calls on, and the people among them: "¡Ay, Jesús!" addresses no one yet
    // (see speakerOnly), but is still not said by a Jesús. Nor is a line said by someone it talks
    // about right before an inciso ("—Oye, Ana dice que vengas —dijo Nela.").
    const calls = new Map(
      voiced.map((u) => [u, this.vocativeMentions(units, at.get(u)!, tokens.get(u)!)]),
    );
    const callsRead = this.castVersion;
    const called = new Map(voiced.map((u) => [u, this.castKeys(calls.get(u)!.named)]));
    const vocatives = new Map(
      voiced.map((u) => [
        u,
        this.castKeys(calls.get(u)!.addressed.filter((m) => !this.speakerOnly(m))),
      ]),
    );
    // A call on someone not in the cast yet, read before touchVocatives adds them.
    const unknownCall = new Map(
      voiced.map((u) => [u, calls.get(u)!.addressed.some((m) => !matchCast(m.name, this.entries))]),
    );
    // Nobody says a line to themselves, nor one about themselves: those people never speak it.
    const saidTo = (u: Unit) => new Set([...(tags.get(u)?.addressees ?? []), ...called.get(u)!]);
    // The people each unit names, read in one walk of the paragraph. Nothing in this loop resolves
    // a mention or adds a name (byGender only learns genders), so they stay valid throughout.
    const namedBefore = this.namesSoFar(units, tokens, vocatives);
    for (const u of voiced) {
      const tag = tags.get(u);
      if (tag?.speaker === undefined && tag?.pending) {
        // People named earlier in the paragraph come first: "“Hello,” said Tom, turning to
        // Anne. “How are you?” she asked."
        tag.speaker = this.byGender(tag.pending, saidTo(u), tag.verb, namedBefore(at.get(u)!));
      }
    }
    // Who cannot say a line whose tag names nobody: the people it is said to, the teller when the
    // tag is someone else's ("—me dijo", "she asked", "—dijo"), and anyone known to have another
    // gender than its "he" or "she".
    const ruledOut = (u: Unit) => {
      const tag = tags.get(u);
      const out = saidTo(u);
      if (tag?.toTeller || tag?.notTeller) out.add(this.narratorKey);
      if (tag?.pending) for (const k of this.otherGender(tag.pending)) out.add(k);
      return out;
    };
    const exclude = new Set<string>();
    for (const u of voiced) if (!tags.get(u)?.speaker) for (const k of ruledOut(u)) exclude.add(k);
    // An untagged line right after a narration sentence (a beat or an inciso) is its subject's.
    const beats = new Map<Unit, Who>();
    for (const u of voiced) {
      if (tags.get(u)?.speaker) continue;
      const n = at.get(u)!;
      const beat =
        this.beatBefore(units, n, tokens, isVoiced) ?? this.incisoAfter(units, n, tokens, isVoiced);
      if (beat && !ruledOut(u).has(beat.key)) beats.set(u, beat);
    }

    const allTags = [...tags.values()];
    const firstTag = allTags.find((t) => t !== undefined);
    const speakerTag = allTags.find((t) => t?.speaker);
    let fallback: Who | undefined = speakerTag?.speaker
      ? { key: speakerTag.speaker, teller: speakerTag.teller }
      : undefined;
    if (!fallback && this.continuesSpeech && OPENING_QUOTE.test(this.slice(voiced[0]!))) {
      fallback = this.lastTurn;
    }
    // A colon intro that names nobody rules people out like a tag: the line after "Se volvió hacia
    // mí y dijo:" is not the teller's, and the line after "She turned and said:" is not a man's.
    if (this.colonNotTeller) exclude.add(this.narratorKey);
    if (this.colonGender) for (const k of this.otherGender(this.colonGender)) exclude.add(k);
    // "—Hace frío —añadió.": the last speaker goes on.
    const continues = allTags.some((t) => t?.verb.continues && !t.speaker);
    if (!fallback && continues && this.narrationGap <= 1 && this.lastSpeaker) {
      if (!exclude.has(this.lastSpeaker)) fallback = someone(this.lastSpeaker);
    }
    fallback ??= this.colonSpeaker ?? beats.get(voiced[0]!);
    if (fallback && exclude.has(fallback.key)) fallback = undefined;
    const chosen: Who = fallback ?? { key: this.alternate(exclude), teller: false };
    // A line's own tag names its speaker, else its beat, else the paragraph's speaker.
    const whoOf = (u: Unit): Who => {
      const own = tags.get(u);
      return own?.speaker ? { key: own.speaker, teller: own.teller } : (beats.get(u) ?? chosen);
    };
    const speakerOf = (u: Unit) => whoOf(u).key;

    const addressed: string[] = [];
    for (const u of voiced) {
      for (const k of [...(tags.get(u)?.addressees ?? []), ...vocatives.get(u)!])
        if (k !== speakerOf(u) && !addressed.includes(k)) addressed.push(k);
      if (tags.get(u)?.toTeller && speakerOf(u) !== this.narratorKey) {
        addressed.push(this.narratorKey);
      }
    }
    // People addressed or mentioned rank just below the speaker as the next "other" participant.
    for (const u of voiced) {
      const speaker = speakerOf(u);
      // A newcomer's first line with a tag or beat of its own ("—dijo al fin") starts a scene
      // when the narration brought them in after a scene break, time passing or someone leaving.
      // Without one before them they join the talk ("Then Anne came in.", "Then Anne came in.
      // Later I would remember…"), and an untagged line given to someone only mentioned starts
      // nothing.
      const newcomer = this.newcomers.get(speaker);
      // A colon intro that names them is a tag of their own ("The next morning she knocked at my
      // door and said:").
      const introduced = u === voiced[0] && this.colonSpeaker?.key === speaker;
      if (newcomer && (tags.get(u) !== undefined || beats.has(u) || introduced)) {
        if (newcomer.changed) this.sceneStart = Math.max(this.sceneStart, newcomer.entered);
        this.newcomers.delete(speaker);
      }
      for (const key of tags.get(u)?.others ?? []) if (key !== speaker) this.touch(key);
      // A name an earlier line here brought in is a mention by now, also at a sentence start
      // ("“Hello, Anne,” said Tom. “Anne, can you hear me?”"), so a line is read again once the
      // cast has grown.
      const { addressed: names } =
        this.castVersion === callsRead
          ? calls.get(u)!
          : this.vocativeMentions(units, at.get(u)!, tokens.get(u)!);
      this.touchVocatives(names, speaker);
      if (speaker !== this.unknownKey) {
        this.touch(speaker);
        this.spoke.set(speaker, this.clock);
        this.lastSpeaker = speaker;
      }
      this.lastTurn = whoOf(u);
    }

    const lastVoiced = voiced.at(-1)!;
    const lineAsks = /\?[”"»’']?\s*$/u.test(this.slice(lastVoiced).trimEnd());
    this.continuesSpeech =
      lastVoiced === units.at(-1) &&
      lastVoiced.kind === 'speech' &&
      !CLOSING_QUOTE.test(this.slice(lastVoiced)) &&
      OPENING_QUOTE.test(this.slice(lastVoiced));
    // "“Well,” said Tom, and then he added:" introduces Tom's next paragraph. A "he" or "she" there
    // is read as in a colon intro of its own ("“Well,” I said, and then she added:").
    this.colonSpeaker = undefined;
    this.colonNotTeller = false;
    this.colonGender = undefined;
    const lastUnit = units.at(-1)!;
    if (!isVoiced(lastUnit) && this.slice(lastUnit).trimEnd().endsWith(':')) {
      const ts = tokens.get(lastUnit)!;
      const v = this.beforeVerb(lastUnit, ts);
      const gender = v === -1 ? undefined : this.pronounSubject(ts, v, this.mentions(ts));
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
        const verb = verbAt(ts, v, this.lang);
        const mentions = this.mentions(ts);
        const replyTo = new Set(
          mentions
            .filter((m) => m.first > v && this.addressedIn(ts, m))
            .map((m) => matchCast(m.name, this.entries)?.key)
            .filter((k): k is string => k !== undefined),
        );
        const speaker = speakerOf(lastVoiced);
        const callee = (k: string) =>
          k !== speaker && !replyTo.has(k) && (this.entry(k).gender ?? gender) === gender;
        const sentence = lastSentenceStart(ts.slice(0, v + 1));
        const lower = (k: number) => ts[k]?.text.toLowerCase() ?? '';
        const glued = (k: number) => !!ts[k] && !ts[k]!.punctBefore;
        const recovers = ts.slice(sentence, v).some((_, i) => {
          const k = sentence + i;
          return this.lang === 'es'
            ? RECOVERY_GERUNDS.test(lower(k))
            : SELF_WORDS.has(lower(k)) &&
                (RECOVERY_WORDS.has(lower(k - 1)) || lower(k + 1) === 'together');
        });
        const after: string[] = [];
        for (let k = v + 1; k < v + 4 && glued(k); k++) after.push(lower(k));
        // Spanish: "y ella se respondió:", "contestó a sí misma:" (not "respondió que sí:").
        // English "own" only as "her own" right after the verb ("answered her own question:"; not
        // "answered in her own way:").
        const itself =
          this.lang === 'es'
            ? lower(v - 1) === 'se' ||
              after.some(
                (w, i) =>
                  w === 'sí' && (after[i - 1] === 'a' || /^mism[oa]s?$/u.test(after[i + 1] ?? '')),
              )
            : after.some(
                (w, i) =>
                  SELF_WORDS.has(w) ||
                  (w === 'own' &&
                    i === 1 &&
                    ['her', 'his', 'their', 'my', 'your'].includes(after[0]!)),
              ) || after[0] === 'for';
        const someoneElse =
          mentions.some(
            (m) => m.last < v && !m.possessive && matchCast(m.name, this.entries)?.key !== speaker,
          ) ||
          ts.slice(0, v).some((t, k) => {
            const pronoun = isPronoun(t.text, this.lang);
            return (
              (pronoun !== undefined && pronoun !== gender) ||
              !!verbAt(ts, k, this.lang)?.firstPerson
            );
          });
        // A line that only hesitates, right after a heading, starts the answer to the question
        // asked before it ("“Will you marry me?” / CHAPTER TWO / “Well,” said Anne, and she
        // answered:"), unlike a line of its own ("CHAPTER II / “You’re late,” said Anne, and she
        // replied:").
        const hesitant = HESITATIONS[this.lang].test(
          this.slice(lastVoiced)
            .replace(/[^\p{L}\s]/gu, ' ')
            .trim()
            .toLowerCase(),
        );
        const pending =
          hesitant && this.headingAsker !== undefined && this.headingAsker !== speaker;
        const direct =
          !pending &&
          !someoneElse &&
          !(glued(v + 1) && ADDRESSEE_MARKERS[this.lang].has(lower(v + 1))) &&
          (this.lastAsker === undefined || this.lastAsker === speaker);
        // The nearest sentence of the intro that opens with a name.
        let answerer: string | undefined;
        for (let s = sentence, e = v, n = 0; n < 5; n++) {
          const opener = openingSubject(ts, s, mentions, this.lang);
          // A question the teller asks about one person of that gender names the answerer: "What
          // could Mary say? She shrugged, and then she replied:", "¿Qué podía decir Nela?".
          if (
            n > 0 &&
            opener?.kind !== 'mention' &&
            (ts[e]?.punctBefore ?? '').includes('?') &&
            WH_WORDS[this.lang].has(ts[s]!.text.toLowerCase())
          ) {
            const about = new Set(
              mentions
                .filter((m) => m.first > s && m.last < e && !m.possessive)
                .map((m) => matchCast(m.name, this.entries)?.key)
                .filter(
                  (k): k is string =>
                    k !== undefined && k !== speaker && this.entry(k).gender === gender,
                ),
            );
            if (about.size === 1) {
              answerer = [...about][0];
              break;
            }
            // A line said to someone leaves the reply to them ("“You’re late again, Mary,” said
            // Anne. Jane went on reading. What excuse would it be this time?").
            if (
              [...(tags.get(lastVoiced)?.addressees ?? []), ...vocatives.get(lastVoiced)!].some(
                callee,
              )
            ) {
              break;
            }
          }
          if (opener?.kind === 'mention') {
            const k = matchCast(opener.mention.name, this.entries)?.key;
            const asks = ts.slice(s, e).some((t, j) => {
              const w = t.text.toLowerCase();
              if (ASKING_VERBS[this.lang].has(w)) return true;
              if (!WH_WORDS[this.lang].has(w)) return false;
              // Not knowing what to do asks nothing: "Nela no supo qué decir", "Mary did not know
              // what to say" (but "Nela quiso saber qué hacer" asks).
              const next = ts[s + j + 1];
              const infinitive =
                !!next &&
                !next.punctBefore &&
                (this.lang === 'en'
                  ? next.text.toLowerCase() === 'to'
                  : /^\p{Ll}+(?:ar|er|ir|ír)(?:me|te|se|lo|la|le|nos|los|las|les)?$/u.test(
                      next.text,
                    ));
              // The negation is in the wh-word's own clause, with no pause or "and" between them
              // (not "Nela, que no conocía el pueblo, quiso saber qué lugar era").
              let denied = false;
              // An aside a preposition opens between commas, right before it, is skipped: "Mary did
              // not know, for a moment, what to say", "Nela no supo, por un momento, qué decir".
              let from = s + j;
              if (ts[from]!.punctBefore === ',') {
                let a = from - 1;
                while (a > s && !ts[a]!.punctBefore) a--;
                const lead = ts[a]!.text.toLowerCase();
                if (
                  a > s &&
                  ts[a]!.punctBefore === ',' &&
                  (NON_PARTICIPANT_PREPOSITIONS[this.lang].has(lead) ||
                    PREPOSITIONS[this.lang].has(lead))
                ) {
                  from = a;
                }
              }
              for (
                let g = from - 1;
                g >= s && ((from !== s + j && g + 1 === from) || !ts[g + 1]!.punctBefore);
                g--
              ) {
                const x = ts[g]!.text.toLowerCase();
                if (NEGATIONS[this.lang].has(x) || /n['’]t$/u.test(ts[g]!.text)) {
                  denied = true;
                  break;
                }
                if (['and', 'but', 'or', 'y', 'e', 'pero', 'o', 'u'].includes(x)) break;
              }
              return !(infinitive && denied);
            });
            if (k !== undefined && k !== speaker && this.entry(k).gender === gender && !asks) {
              answerer = k;
            }
            break;
          }
          if (s === 0) break;
          e = s;
          s = lastSentenceStart(ts.slice(0, s));
        }
        // The tag's own asking verb ("asked Tom, and he answered:"), or someone else's.
        const tagVerb =
          units.indexOf(lastUnit) === units.indexOf(lastVoiced) + 1
            ? this.afterVerb(lastUnit, ts)
            : -1;
        const asking = (k: number) => ASKING_VERBS[this.lang].has(lower(k));
        const othersAsk = ts
          .slice(sentence, v)
          .some((_, i) => sentence + i !== tagVerb && asking(sentence + i));
        // A question anywhere in the line counts ("Where were you? I waited all night,"), but not
        // an echo, a lone question word its speaker answers or a question it quotes (see
        // asksInLine), nor one the speaker goes on from ("“Who knows? Perhaps,” said Anne, and
        // then she answered:", "—¿Quién sabe? Quizá —dijo Nela, y luego ella respondió:").
        const answered =
          this.lastAsker !== undefined && this.lastAsker !== speaker
            ? this.lastQuestion
            : undefined;
        const goesOn = [v - 1, v - 2].some(
          (k) => glued(k + 1) && ['then', 'luego', 'después'].includes(lower(k)),
        );
        // Unless the intro names someone else, whom the "he" or "she" may be ("said Anne, glancing
        // at Mary, and then she answered:", "—dijo Ana, apoyándose en Nela, y luego ella respondió:").
        const asksSomething =
          lineAsks ||
          ((!goesOn || someoneElse) && asksInLine(this.slice(lastVoiced), this.lang, answered));
        const asked =
          !othersAsk &&
          (((asksSomething || direct) && !recovers && !itself) ||
            // An asking tag's speaker may answer the question themself ("“Why?” asked Anne, and
            // she answered herself:", "—preguntó Ana, y ella se respondió:"; not "she answered for
            // both of them:").
            (tagVerb >= sentence &&
              tagVerb < v &&
              asking(tagVerb) &&
              !(this.lang === 'es'
                ? itself
                : after.some(
                    (w, i) =>
                      SELF_WORDS.has(w) ||
                      (w === 'own' && i === 1 && ['her', 'his', 'their'].includes(after[0]!)),
                  ))) ||
            [...(tags.get(lastVoiced)?.addressees ?? []), ...vocatives.get(lastVoiced)!].some(
              callee,
            ) ||
            unknownCall.get(lastVoiced)!);
        const skip = answerer !== undefined || (verb?.reply && !asked);
        // Someone the paragraph's narration names as a subject before the line is there to reply
        // ("Anne and Mary sat by the fire. “You’re late,” said Anne, and she replied:"; not "Anne
        // had a letter from Jane."). Not for a verb its speaker goes on with ("Mary looked up.
        // “You’re late,” said Anne, and she added:", "and then she went on:", "and she repeated:").
        const continuing =
          !!verb?.continues || ['repeated', 'repeats', 'repitió', 'repite'].includes(lower(v));
        // Nor when the line before was said to someone, who is there to reply.
        const called = [
          ...(tags.get(lastVoiced)?.addressees ?? []),
          ...vocatives.get(lastVoiced)!,
        ].some(callee);
        const present =
          skip || continuing || called
            ? []
            : units
                .filter((u) => !isVoiced(u) && u !== lastUnit)
                .flatMap((u) =>
                  this.mentions(tokens.get(u)!)
                    .filter((m) => !m.possessive && !this.afterPreposition(tokens.get(u)!, m))
                    .map((m) => matchCast(m.name, this.entries)?.key),
                )
                .filter(
                  (k): k is string =>
                    k !== undefined &&
                    k !== speaker &&
                    !replyTo.has(k) &&
                    this.entry(k).gender === gender,
                );
        this.colonSpeaker = someone(
          this.byGender(
            gender,
            replyTo,
            skip ? undefined : verb,
            answerer ? [answerer] : [...new Set(present.reverse())],
          ),
        );
        this.colonNotTeller = !this.colonSpeaker;
        if (!this.colonSpeaker) this.colonGender = gender;
      } else if (ts.some((_, i) => this.isVerb(ts, i))) {
        // The intro's own verb, after the tag's, names its subject: "“Where were you?” said Will,
        // and Tom answered:" introduces Tom, "“Out,” said Anne. Mary frowned and answered:" Mary.
        const tagAt =
          units.indexOf(lastUnit) === units.indexOf(lastVoiced) + 1
            ? this.afterVerb(lastUnit, ts)
            : -1;
        const mentions = this.mentions(ts);
        const own =
          v !== -1 && v !== tagAt
            ? (this.subjectKey(ts, v, mentions) ??
              this.coordinatedSubject(ts, v, lastSentenceStart(ts.slice(0, v + 1)), mentions))
            : undefined;
        this.colonSpeaker = own ?? whoOf(lastVoiced);
      }
    }
    // A question inside the line asks too ("Where were you? I waited all night,"), but not a short
    // one that opens it, which may be an echo ("Marry Tom? Never,"; see asksInLine).
    this.lastAsker =
      lineAsks || asksInLine(this.slice(lastVoiced), this.lang, true)
        ? speakerOf(lastVoiced)
        : undefined;
    this.lastQuestion = this.lastAsker === undefined ? undefined : this.slice(lastVoiced);
    this.headingAsker = undefined;
    this.narrationGap = 0;
    this.entrants = [];
    this.addressed = addressed;
    this.stretch = { changed: false };

    return units.map((u) => {
      if (!isVoiced(u)) return this.label(u, this.narratorKey, 'narration', undefined, true);
      const own = tags.get(u);
      // A line spoken after a beat does not take the tone of another line's tag.
      const tag = own ?? (beats.has(u) ? undefined : firstTag);
      const mode: Mode =
        u.kind === 'emphasis' || tag?.verb.thought || tag?.thought ? 'thought' : 'speech';
      const tone: Tone | undefined = tag?.tone ? { label: tag.tone } : undefined;
      const { key, teller } = whoOf(u);
      return this.label(u, key, mode, tone, teller);
    });
  }

  /**
   * A paragraph's tokens, unit by unit, and which units are lines (speech, or a thought).
   * `speech`: tokenize speech units too, which only attribution reads.
   */
  private read(
    units: Unit[],
    speech = true,
  ): { tokens: Map<Unit, Token[]>; isVoiced: (u: Unit) => boolean } {
    const tokens = new Map<Unit, Token[]>();
    units.forEach((u, n) => {
      if (!speech && u.kind === 'speech') return;
      // A narration unit right after speech is a tag ("…,” said Anne"), not a new sentence.
      const startsSentence = n === 0 || units[n - 1]!.kind === 'narration';
      tokens.set(u, tokenize(this.slice(u), this.lang, startsSentence));
    });
    const voiced = new Set(
      units.filter(
        (u, n) =>
          u.kind === 'speech' || (u.kind === 'emphasis' && this.thoughtCueNear(units, n, tokens)),
      ),
    );
    return { tokens, isVoiced: (u) => voiced.has(u) };
  }

  /** An emphasis unit is a thought only next to a thought verb in the sentence it touches. */
  private thoughtCueNear(units: Unit[], n: number, tokens: Map<Unit, Token[]>): boolean {
    const cue = (ts: Token[], from: number, to: number) => {
      for (let i = from; i < to; i++) {
        if (!verbAt(ts, i, this.lang)?.thought) continue;
        // "the thought of", "a thought": a noun.
        const noun =
          NOUN_BEFORE_THOUGHT.has(ts[i - 1]?.text.toLowerCase() ?? '') ||
          ts[i + 1]?.text.toLowerCase() === 'of';
        if (!noun) return true;
      }
      return false;
    };
    const after = units[n + 1];
    if (after?.kind === 'narration') {
      const ts = tokens.get(after)!;
      if (cue(ts, 0, firstSentenceEnd(ts))) return true;
    }
    const before = units[n - 1];
    if (before?.kind === 'narration') {
      const ts = tokens.get(before)!;
      if (cue(ts, lastSentenceStart(ts), ts.length)) return true;
    }
    return false;
  }

  private narrationParagraph(units: Unit[], tokens: Map<Unit, Token[]>): void {
    this.colonSpeaker = undefined;
    this.colonNotTeller = false;
    this.colonGender = undefined;
    this.continuesSpeech = false;
    this.narrationGap++;
    this.entrants = [];
    // Headings ("CHAPTER II", "NICK DUNNE", "* * *") are never read for names.
    if (this.isHeading(units)) {
      const asker = this.lastAsker;
      this.breakScene();
      this.headingAsker = asker;
      return;
    }
    const all = units.map((u) => {
      const ts = tokens.get(u)!;
      return { tokens: ts, mentions: this.mentions(ts) };
    });
    for (const { tokens: ts, mentions } of all) {
      // A scene cue, which only orders first-person turn-taking (see alternate). It changes the
      // scene from where it stands: "Then Anne came in. Later I would remember…" brings Anne in
      // before it.
      const cue = this.tellerSpeaks ? sceneCue(ts, mentions, this.lang) : -1;
      if (this.tellerSpeaks && ts.some((_, i) => this.isFirstPerson(ts, i))) {
        this.touch(this.narratorKey);
      }
      for (const m of mentions) {
        if (cue !== -1 && cue < m.first) this.stretch.changed = true;
        // "My name is Ishmael", "Me llamo Inés": the teller's own name, never a new character.
        if (this.selfIntroduced(ts, m)) {
          this.touch(this.narratorKey);
          continue;
        }
        // "walked to London", "a letter from Mr. Collins": not someone present.
        if (this.afterPreposition(ts, m) || (this.lang === 'en' && wordBefore(ts, m) === 'to')) {
          continue;
        }
        // "rezó a Jesús": a sacred name until someone of that name speaks.
        if (this.speakerOnly(m)) continue;
        const key = this.resolve(m);
        this.touch(key);
        const spokenMention = (x: Mention) => {
          const k = matchCast(x.name, this.entries)?.key;
          return k !== undefined && this.spoke.has(k);
        };
        let first = false;
        if (this.entry(key).role === 'character' && !this.entrants.includes(key)) {
          this.entrants.push(key);
          // The stretch brings someone in once, where it first names them. Time passing in the
          // clause that names them brings them in after it too ("Then Anne came to see me that
          // evening.", "I went to see Anne the next day.").
          const { stretch } = this;
          if (!this.spoke.has(key) && this.newcomers.get(key)?.stretch !== stretch) {
            const came = opensClause(ts, m, this.lang);
            const changed =
              stretch.changed ||
              (this.tellerSpeaks && timeInClause(ts, m, came, mentions, this.lang, spokenMention));
            // A plan to come with no arrival after it in this paragraph reads as coming in, until a
            // later arrival in the stretch tells otherwise ("Then Anne agreed to come. / She
            // arrived the next morning.").
            const plan = came && clearPlan(ts, m, this.lang);
            this.newcomers.set(key, { entered: this.clock, stretch, changed, came, plan });
            first = true;
          }
        }
        // Named again in this stretch, in a wait that ends when time passes: "I had asked Anne to
        // come. Anne did not come back until the next morning."
        const known = this.newcomers.get(key);
        const t = timePasses(ts, this.lang);
        const low = (k: number) => ts[k]?.text.toLowerCase() ?? '';
        const until =
          t > 0 &&
          (UNTIL[this.lang].has(low(t - 1)) ||
            (low(t - 1) in DETERMINERS[this.lang] && UNTIL[this.lang].has(low(t - 2))));
        if (
          !first &&
          until &&
          this.tellerSpeaks &&
          known?.stretch === this.stretch &&
          !known.changed &&
          !known.came &&
          timeInClause(ts, m, opensClause(ts, m, this.lang), mentions, this.lang, spokenMention)
        ) {
          known.changed = true;
        }
      }
      if (this.tellerSpeaks) this.timeBringsIn(ts, mentions);
      if (cue !== -1) this.stretch.changed = true;
      // Someone who has spoken leaving ends their talk, also for people named before ("Then Anne
      // came in, and Tom left.").
      if (this.tellerSpeaks && this.speakerLeaves(ts, mentions)) this.breakScene();
    }
    // A paragraph that sets the new scene with its people leaves the question before the heading
    // behind ("CHAPTER II / Anne and Mary sat by the fire. / “Well,” said Anne, and she replied:"),
    // unlike one about someone there ("CHAPTER TWO / Mary held her breath.").
    if (this.entrants.length > 1) this.headingAsker = undefined;

    // "…y después una voz de hombre, que dijo:" introduces the next paragraph's speaker. Only the
    // sentence that ends with the colon counts.
    const last = units.at(-1)!;
    if (!this.slice(last).trimEnd().endsWith(':')) return;
    const { tokens: ts, mentions } = all.at(-1)!;
    const start = lastSentenceStart(ts);
    const verbIndex = this.beforeVerb(last, ts);
    if (verbIndex === -1) {
      // "At last the old man spoke:" without a speech verb: the sentence's subject.
      this.colonSpeaker = this.sentenceSubject(ts, start, mentions);
      if (!this.colonSpeaker) {
        // "She hesitated:" with no "she" found is read like "She said:".
        this.colonGender = heOrShe(openingSubject(ts, start, mentions, this.lang));
        this.colonNotTeller = this.colonGender !== undefined;
      }
      return;
    }
    // "Then she said:", "She turned and said:": someone of that gender, and nobody else.
    const gender = this.pronounSubject(ts, verbIndex, mentions);
    this.colonSpeaker = gender
      ? someone(this.byGender(gender, new Set()))
      : (this.subjectKey(ts, verbIndex, mentions) ??
        // "Tom turned to Anne and said:"
        this.coordinatedSubject(ts, verbIndex, start, mentions) ??
        someone(this.nearestBefore(ts, verbIndex, start, mentions)) ??
        // "Teodoro creyó… Levantándose, gritó:": the subject of the sentence before.
        // (not past a time phrase that opens it: "That night I lay awake. At dawn somebody knocked
        // at the door and said:")
        (start > 0 &&
        !timeOpensSentence(ts, this.lang).some((e) => {
          const before = lastSentenceStart(ts.slice(0, start));
          return e > before && e < before + 6 && lastSentenceStart(ts.slice(0, e + 1)) === before;
        })
          ? this.sentenceSubject(ts, lastSentenceStart(ts.slice(0, start)), mentions)
          : undefined));
    // A colon intro that names nobody is read like a tag: "Then I was asked:" is not the teller.
    this.colonNotTeller =
      !this.colonSpeaker &&
      (this.saidToTeller(ts, verbIndex) || this.notTeller(ts, verbIndex, mentions));
    if (!this.colonSpeaker) this.colonGender = gender;
  }

  /** "Golfín, que …, exclamó:" → Golfín; else the nearest name, then descriptor, before the verb. */
  private nearestBefore(
    ts: Token[],
    verbIndex: number,
    start: number,
    mentions: Mention[],
  ): string | undefined {
    for (let i = verbIndex - 1; i > start; i--) {
      if (RELATIVES[this.lang].has(ts[i]!.text.toLowerCase()) && ts[i]!.punctBefore === ',') {
        const antecedent = mentions.find((m) => m.last === i - 1);
        if (antecedent) return this.resolve(antecedent);
        break;
      }
    }
    const before = mentions.filter(
      (m) =>
        m.first >= start &&
        m.last < verbIndex &&
        !this.afterPreposition(ts, m) &&
        !this.addressedIn(ts, m),
    );
    const nearest = before.filter((m) => m.kind === 'name').at(-1) ?? before.at(-1);
    return nearest ? this.resolve(nearest) : undefined;
  }

  /**
   * A scene break, or someone who has spoken leaving: the scene changes from here, and for the
   * people this stretch brought in before it too ("I hoped Anne would come. / * * * / She came").
   * A question asked before it is no longer the one a later reply answers.
   */
  private breakScene(): void {
    this.stretch.changed = true;
    this.lastAsker = undefined;
    this.headingAsker = undefined;
    for (const n of this.newcomers.values()) if (n.stretch === this.stretch) n.changed = true;
  }

  /**
   * "I had not seen Anne for a month. In the evening she came to see me.", "I had asked Anne to
   * come. She arrived that evening.": time passing in a sentence about someone this stretch only
   * named so far (by their name, a "he" or "she", or a subject Spanish leaves out), at its start or
   * later in its subject's own clause, brings them in after it. Someone who came in before it joins
   * the talk ("Then Anne came in. Later she told me she had been crying."), and a "he", "she" or
   * left-out subject that comes back may be someone who has spoken and went out ("Tom went out to
   * the boat. He came back later with the lamp.").
   */
  private timeBringsIn(ts: Token[], mentions: Mention[]): void {
    const subjects = timeOpensSentence(ts, this.lang).flatMap((e) => {
      const after = ts[e];
      if (!after) return [];
      const named = mentions.find((m) => m.first === e && !m.possessive);
      const dropped =
        this.lang === 'es' &&
        !isPronoun(after.text, this.lang) &&
        !named &&
        LOWER.test(after.text) &&
        !(after.text in DETERMINERS.es);
      return [{ e, named, dropped }];
    });
    const spoken = (m: Mention) => {
      const k = matchCast(m.name, this.entries)?.key;
      return k !== undefined && this.spoke.has(k);
    };
    const later = timeLaterInSentence(ts, mentions, this.lang, spoken).filter(
      ({ e, named, dropped, v }) =>
        !!named || !returns(ts, v, this.lang) || !this.speakerBefore(ts, e, mentions, dropped),
    );
    // "She did not come until the next morning", "She was not back until that evening": a wait
    // that ends when time passes, in a sentence a "he" or "she" opens (read as timeInClause reads
    // "Anne did not come until…").
    const waits: { e: number; named: Mention | undefined; dropped: boolean }[] = [];
    const t = timePasses(ts, this.lang);
    const low = (k: number) => ts[k]?.text.toLowerCase() ?? '';
    const until =
      t > 0 &&
      (UNTIL[this.lang].has(low(t - 1)) ||
        (low(t - 1) in DETERMINERS[this.lang] && UNTIL[this.lang].has(low(t - 2))));
    if (until) {
      const s = lastSentenceStart(ts.slice(0, t + 1));
      let e = s;
      while (e < t && SENTENCE_LEADS[this.lang].has(low(e)) && (e === s || !ts[e]!.punctBefore))
        e++;
      const pronoun = isPronoun(ts[e]?.text ?? '', this.lang);
      const at = { ...(mentions[0] ?? {}), first: e, last: e } as Mention;
      if (
        (pronoun === 'male' || pronoun === 'female') &&
        timeInClause(ts, at, false, mentions, this.lang, spoken) &&
        !this.speakerBefore(ts, e, mentions, false)
      ) {
        waits.push({ e, named: undefined, dropped: false });
      }
    }
    // Whether the subject at `e` arrives, for a plan to come read as coming in ("The next morning
    // she knocked at my door."; not "Later she told me…").
    const arrivesAt = (e: number, named: Mention | undefined) => {
      let v = named ? named.last + 1 : e + 1;
      while (ts[v] && !ts[v]!.punctBefore && /^\p{Ll}+ly$/u.test(ts[v]!.text)) v++;
      if (!ts[v] || ts[v]!.punctBefore || !ARRIVALS[this.lang].has(low(v))) return false;
      let end = v + 1;
      while (end < ts.length && !ts[end]!.sentenceStart) end++;
      const time = timeShifts(ts, this.lang).find((x) => x > v && x < end) ?? end;
      const closed = [
        ...ts,
        { ...ts[ts.length - 1]!, text: '', punctBefore: '.', sentenceStart: true },
      ];
      return arrives(closed, v, time, this.lang) && !becomes(ts, v);
    };
    // A plan to come ends in an arrival at a time the narration moves to ("The next morning she
    // knocked at my door.", "She knocked an hour later."), not after a bare "Later" ("Then Anne rose
    // to come over. / Later she came back with a pot of tea.").
    const moved = (e: number) => {
      let start = e;
      while (start > 0 && !ts[start]!.sentenceStart) start--;
      let end = e + 1;
      while (end < ts.length && !ts[end]!.sentenceStart) end++;
      return timeShifts(ts, this.lang).some(
        (x) =>
          x >= start &&
          x < end &&
          !(low(x) === 'later' && timePhraseStart(ts, start - 1, x, this.lang) === x),
      );
    };
    const triggers = [
      ...subjects.map((s) => ({ ...s, arrival: moved(s.e) && arrivesAt(s.e, s.named) })),
      ...later.map((s) => ({ ...s, arrival: moved(s.e) })),
      ...waits.map((s) => ({ ...s, arrival: moved(s.e) })),
    ];
    for (const { e, named, dropped, arrival } of triggers) {
      const pronoun = isPronoun(ts[e]!.text, this.lang);
      const key = named && matchCast(named.name, this.entries)?.key;
      for (const [k, n] of this.newcomers) {
        if (n.stretch !== this.stretch || n.changed || (n.came && !(n.plan && arrival))) continue;
        const gender = this.entry(k).gender;
        if (
          (key !== undefined && key === k) ||
          ((pronoun === 'male' || pronoun === 'female') && (!gender || gender === pronoun)) ||
          dropped
        ) {
          n.changed = true;
        }
      }
    }
  }

  /**
   * Whether someone who has spoken is named before `e` in this narration and may be the subject
   * there: a "he" or "she" of their gender, or a subject Spanish leaves out. Someone sent away or
   * gone, named last, is the one who comes back, and counts only if they spoke ("Tom stayed with
   * the horses. I had sent Anne to the village. She returned that evening." brings Anne in).
   */
  private speakerBefore(ts: Token[], e: number, mentions: Mention[], dropped: boolean): boolean {
    const pronoun = isPronoun(ts[e]!.text, this.lang);
    const lower = (k: number) => ts[k]?.text.toLowerCase() ?? '';
    const fits = (m: Mention, key: string | undefined): key is string => {
      if (m.last >= e || m.possessive) return false;
      if (key === undefined || this.entry(key).role !== 'character') return false;
      const gender = this.entry(key).gender;
      return (
        dropped || ((pronoun === 'male' || pronoun === 'female') && (!gender || gender === pronoun))
      );
    };
    // "Anne had gone", "Ana se fue", "I had sent Anne", "Mandé a Ana".
    const away = (m: Mention) => {
      const after = ['had', 'se', 'había'].includes(lower(m.last + 1)) ? m.last + 2 : m.last + 1;
      const before = this.lang === 'es' && lower(m.first - 1) === 'a' ? m.first - 2 : m.first - 1;
      return LEAVING[this.lang].has(lower(after)) || SENDING[this.lang].has(lower(before));
    };
    const gone = mentions.filter((m) => away(m) && fits(m, matchCast(m.name, this.entries)?.key));
    if (gone.length > 0) {
      const key = matchCast(gone.at(-1)!.name, this.entries)?.key;
      return key !== undefined && this.spoke.has(key);
    }
    return mentions.some((m) => {
      const key = matchCast(m.name, this.entries)?.key;
      return fits(m, key) && this.spoke.has(key);
    });
  }

  /**
   * Whether someone who has spoken leaves in this narration, or had left: "Tom left.", "y Tomás se
   * fue", "By the time I woke, Tom had left", "Tom’d left", "everyone had left". Someone who never
   * spoke leaves no talk ("The boy had left.").
   */
  private speakerLeaves(ts: Token[], mentions: Mention[]): boolean {
    return phrasesAt(ts, DEPARTURES[this.lang], true).some((i) => {
      const b = subjectIndexBefore(ts, i, this.lang);
      const word = (k: number) => ts[k]?.text.toLowerCase() ?? '';
      if (EVERYONE[this.lang].has(word(ELSE.has(word(b)) ? b - 1 : b))) return this.spoke.size > 0;
      const subject = subjectOf(ts, i, mentions, this.lang);
      // "Tom’d left": the name before the "’d".
      const contracted = /\p{Lu}.*['’]d$/u.test(ts[b]?.text ?? '');
      const name =
        subject?.kind === 'mention' ? subject.mention.name : contracted ? ts[b]!.text : '';
      const key = name ? matchCast(name.replace(/['’]d$/u, ''), this.entries)?.key : undefined;
      return key !== undefined && this.spoke.has(key);
    });
  }

  /** One short line with no final punctuation: a chapter heading, a scene break, a name. */
  private isHeading(units: Unit[]): boolean {
    if (units.length !== 1) return false;
    const text = this.slice(units[0]!).trim();
    if (!text || text.length > 60 || /[.!?…:;,]$/u.test(text)) return false;
    const words = text.split(/\s+/u);
    if (words.length > 8) return false;
    if (/^[\s*#~·•⁂◆◇❖—–\-_=+.]+$/u.test(text) || HEADING_WORDS.test(text)) return true;
    const letters = text.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 2 && letters === letters.toUpperCase()) return true;
    return words
      .filter((w) => w.replace(/[^\p{L}]/gu, '').length > 3)
      .every((w) => /^[\p{Lu}\d]/u.test(w));
  }

  private isFirstPerson(ts: Token[], i: number): boolean {
    const t = ts[i]!.text;
    if (FIRST_PERSON_WORDS[this.lang].has(t)) return true;
    // "I" before a lower-case word in the same sentence ("I ran"), not "I." or "I, Claudius".
    const next = ts[i + 1];
    return this.lang === 'en' && t === 'I' && !!next && !next.punctBefore && LOWER.test(next.text);
  }

  /**
   * "Call me Ishmael", "Me llamo Inés", "they call me the old man": the teller's own name or
   * nickname, right after the phrase or after a pause, an opening quote or emphasis ("My name is…
   * Kit", "called me *Kit*", "_the old man_"). After a dash, a colon, a closing parenthesis or an
   * opening "¡" it is the name only when it ends its clause, a short phrase that qualifies it
   * included ("called me—the girl with the red hair—and", "me llamaban (todavía me llaman) la
   * niña, aunque", "me llamaban… ¡la niña!", not "called me—my uncle was waiting" or "Me llamaron:
   * la abuela de Pablo quería verme"), and after a question only when the question asks for it
   * ("What did they call me? The old man.", not "Who called me? My uncle."). A name after a comma
   * or in the next sentence is not what the teller is called ("called me, Davy too", "Mother
   * called me. My uncle was at the table."), nor is a possessive ("called me Tom’s shadow"). After
   * "me llamaba" a descriptor is the verb's subject ("me llamaba mi madre"), and so is a name that
   * does not end its clause ("me llamaba Pablo desde el patio").
   */
  private selfIntroduced(ts: Token[], m: Mention): boolean {
    if (m.possessive) return false;
    const after = ts[m.last + 1];
    const endsClause = !after || !!after.punctBefore || CLAUSE_OPENERS.has(after.text);
    const phrase = SELF_INTRODUCTIONS[this.lang].find(
      (words) =>
        (!CALLING_INTRODUCTIONS[this.lang].has(words.join(' ')) ||
          (m.kind === 'name' && endsClause)) &&
        words.every((w, k) => {
          const t = ts[m.first - words.length + k];
          return t !== undefined && t.text.toLowerCase() === w && (k === 0 || !t.punctBefore);
        }),
    );
    if (!phrase) return false;
    // What stands between the phrase and the name, quotes, emphasis marks and "¡" aside; a dash
    // after a question mark is part of the question ("call me?—the old man"), and one after a colon
    // part of the colon before a nickname ("called me:—the old man"), not before a name ("called
    // me:—Mr. Collins, from the hall").
    const separator = ts[m.first]!.punctBefore;
    const punct = separator
      .replace(/['‘*_¡]{1,3}$/u, '')
      .replace(/^\?(?:—|―|–|--?)$/u, '?')
      .replace(/^:(?:—|―|–|--?)$/u, m.kind === 'descriptor' ? ':' : '$&');
    const ends = endsClause || qualifiedNickname(ts, m, this.lang);
    if (punct === '' || punct === '…' || punct === '...') return !separator.includes('¡') || ends;
    if (!ends) return false;
    if (/^(?:—|―|–|--?|:|\))$/u.test(punct)) return true;
    if (punct !== '?') return false;
    const opens = m.first - phrase.length;
    const question = lastSentenceStart(ts.slice(0, opens + 1));
    const word = (k: number) => ts[k]?.text.toLowerCase() ?? '';
    // "Who knew my name well enough to have called me?" asks for a person, not a name.
    const who = ['who', 'whom', 'quién', 'quiénes'].includes(word(question));
    for (let k = question; k < opens; k++) {
      if (NAME_QUESTIONS[this.lang].has(word(k))) return true;
      if (!who && NAME_WORDS[this.lang].has(word(k)) && !NAME_OWNERS[this.lang].has(word(k + 1))) {
        return true;
      }
    }
    return false;
  }

  /** "in London", "from Mr. Collins": a place or someone absent. */
  private afterPreposition(ts: Token[], m: Mention): boolean {
    return NON_PARTICIPANT_PREPOSITIONS[this.lang].has(wordBefore(ts, m) ?? '');
  }

  /** "to Anne", "a Pedro", "al ciego": the person spoken to. */
  private addressedIn(ts: Token[], m: Mention): boolean {
    return ADDRESSEE_MARKERS[this.lang].has(wordBefore(ts, m) ?? '');
  }

  /**
   * The subject at the start of the sentence beginning at `start` (see openingSubject).
   * `knownOnly`: a name must already be in the cast.
   */
  private sentenceSubject(
    ts: Token[],
    start: number,
    mentions: Mention[],
    knownOnly = false,
  ): Who | undefined {
    const subject = openingSubject(ts, start, mentions, this.lang);
    if (!subject) return undefined;
    if (subject.kind === 'pronoun') {
      if (subject.gender === 'narrator') return { key: this.narratorKey, teller: true };
      return someone(this.byGender(subject.gender, new Set()));
    }
    const m = subject.mention;
    if (knownOnly && m.kind === 'name' && !matchCast(m.name, this.entries)) return undefined;
    return someone(this.resolve(m));
  }

  /**
   * "I turned to her and said": the subject of the clause the verb is coordinated with. That is
   * the subject of the clause right before the join, after a comma, when that is a clause of its
   * own (see ownClauseSubject: "Pablo entró, y Nela se levantó y entonces le dijo:", "Tom came in,
   * and Anne smiled and then said"), else the sentence's ("Then Mr. Darcy bowed and said", "Tom
   * waited until she had finished, then said", "Tom looked at his daughter, Jane, and said", "I
   * turned to Uncle Abel, who was mending the net, and said"). In Spanish someone who sees the
   * person in an aside after the join says it ("Ana entró, y cuando Pablo la vio, exclamó:"). The
   * teller's "I" is nobody's after "I suppose" or "I daresay" (see authorialTeller: "I daresay Mrs.
   * Bennet turned, then said"), for a Spanish form that cannot be "yo" ("Me volví hacia Nela, y
   * después de un rato, dijo:"), or when someone the teller watched may have spoken after an aside
   * ("I noticed that Anne looked away, and after a moment, said").
   */
  private coordinatedSubject(
    ts: Token[],
    v: number,
    start: number,
    mentions: Mention[],
  ): Who | undefined {
    const join = joinAt(ts, v, start, this.lang);
    if (join === -1) return undefined;
    const verb = verbAt(ts, v, this.lang);
    const notYo = this.lang === 'es' && !!verb && !verb.firstPerson && !verb.anyPerson;
    const seer = this.asideSeer(ts, join, v, mentions);
    if (seer) return seer;
    // The clause before the join: back from it, or from before the comma of ", then" or ", and".
    let clause = ts[join]!.punctBefore ? join - 1 : join;
    while (clause > start && !ts[clause]!.punctBefore) clause--;
    const own =
      clause > start
        ? this.ownClauseSubject(ts, clause, start, join, v, notYo, mentions)
        : undefined;
    if (own) return own;
    // A subject "and" brings in before an aside between commas, when the clause the join takes
    // has no subject of its own ("Tom went out, and the old man, after a while, sat down and
    // said", "La madre se levantó, y Nela, y no era la primera vez, se echó a llorar y dijo:").
    if (clause - 1 > start && !openingSubject(ts, clause, mentions, this.lang)) {
      let a = clause - 1;
      while (a > start && !ts[a]!.punctBefore) a--;
      let b = a - 1;
      while (b > start && !ts[b]!.punctBefore) b--;
      const before = b > start ? openingSubject(ts, b, mentions, this.lang) : null;
      if (
        before &&
        QUESTION_JOINS[this.lang].has(ts[b]!.text.toLowerCase()) &&
        openingSubjectEnd(ts, b, mentions, this.lang) === a - 1
      ) {
        // An aside that "and" opens with a phrase ("and after a while,", "and at last,") may go on
        // with the sentence's verb, after one more object ("kissed the children, and Tom, and
        // after a while, sat down and said"); with no "and", or as a clause, it may not. A Spanish
        // descriptor may be one more object ("pidió agua, y el médico, y sin decir nada más, se
        // sentó y dijo:"), a name or "él" not.
        const lead = ts[a + 1]?.text.toLowerCase() ?? '';
        const phraseAside =
          QUESTION_JOINS[this.lang].has(ts[a]!.text.toLowerCase()) &&
          (NON_PARTICIPANT_PREPOSITIONS.en.has(lead) ||
            /^(?:after|before|with|without|by|despite|then|later|afterwards|presently|finally|suddenly|soon|again|still)$/u.test(
              lead,
            ) ||
            /\p{Ll}ly$/u.test(lead));
        const named = before.kind === 'pronoun' || before.mention.kind === 'name';
        if (
          before.kind === 'pronoun' ||
          (this.lang === 'es' ? named : !phraseAside || !!verbAt(ts, start, this.lang))
        ) {
          return this.sentenceSubject(ts, b, mentions);
        }
      }
    }
    const who = this.sentenceSubject(ts, start, mentions);
    // An English sentence that opens with no subject of its own has it after the opening, in a
    // part that a comma opens with a name or "I" and its verb ("When the music stopped, Mr. Darcy
    // crossed the room, bowed, then said").
    if (!who && this.lang === 'en' && !openingSubject(ts, start, mentions, this.lang)) {
      let verbOnly = false;
      for (let p = join - 1; p > start; p--) {
        if (ts[p]!.punctBefore !== ',') continue;
        const subject = openingSubject(ts, p, mentions, this.lang);
        if (!subject) {
          verbOnly ||= LOWER.test(ts[p]!.text) && finiteShape(ts[p]!.text, false);
          continue;
        }
        const end = openingSubjectEnd(ts, p, mentions, this.lang);
        // The teller's hedge is no such part ("Elizabeth hesitated, I believe, and then said").
        const hedge =
          subject.kind === 'pronoun' && subject.gender === 'narrator'
            ? hedgeEnd(ts, p, join, this.lang)
            : -1;
        if (hedge !== -1 && (hedge + 1 >= join || !!ts[hedge + 1]!.punctBefore)) continue;
        const after = ts[end + 1];
        // A comment ("she thought,", "I thought,", "it seemed,") is no clause the join goes on
        // with.
        const commentWord = after?.text ?? '';
        if (
          after &&
          !after.punctBefore &&
          (!!verbAt(ts, end + 1, this.lang)?.thought ||
            COMMENT_VERBS.en.has(commentWord) ||
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
          isPronoun(beforeWord, this.lang) !== undefined ||
          beforeWord.toLowerCase() in SPEAKER_NOUNS.en ||
          /^\p{Lu}/u.test(beforeWord);
        if (verbOnly && !afterPerson && (!after || !!after.punctBefore)) {
          return this.sentenceSubject(ts, p, mentions);
        }
        if (subject.kind === 'pronoun' && subject.gender !== 'narrator') {
          if (verbAfterSubject(ts, end, join, this.lang, false) === -1) continue;
          const earlier = mentions
            .filter((m) => m.first >= start && m.last < p && !m.possessive)
            .map((m) => matchCast(m.name, this.entries)?.key)
            .filter((k): k is string => k !== undefined && this.entry(k).gender === subject.gender);
          return someone(earlier[earlier.length - 1] ?? this.byGender(subject.gender, new Set()));
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
            return this.sentenceSubject(ts, p, mentions);
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
                !COORDINATORS.en.has(t.text.toLowerCase()) &&
                !!openingSubject(ts, start + 1 + i, mentions, this.lang),
            );
        const main = verbAfterSubject(
          ts,
          end,
          join,
          this.lang,
          subject.kind === 'mention',
          false,
          true,
          mainClause,
        );
        if (main === -1) continue;
        return this.sentenceSubject(ts, p, mentions);
      }
    }
    if (!who?.teller) return who;
    const aside = ts[v]!.punctBefore === ',' && !!ts[join]!.punctBefore && join + 1 < v;
    if (aside && perceived(ts, start, join, mentions, this.lang)) return undefined;
    return notYo || authorialTeller(ts, start, v, this.lang) ? undefined : who;
  }

  /**
   * The subject of the stretch after the comma at `clause`, when that stretch is a clause of its
   * own, its subject followed by a verb (see verbAfterSubject: "Pablo entró, Nela se levantó, y
   * después de un rato, dijo:", "Tom came in, and Anne smiled and then said", "When the music
   * stopped, Mr. Darcy bowed, then said"). An appositive is none ("his daughter, Jane,", "a su
   * padre, don Ramón,"), nor is the rest of a list ("then his sister,", "then at Anne,", "luego al
   * capitán,", "Mr. Darcy and Mr. Hurst,"), a phrase with no verb ("Anne at his side,", "the old
   * man watching him,", "Jane included,", "su mujer detrás,") or the teller's comment ("I think,",
   * "yo creo,"). Between commas a descriptor opens one only after "and" or "but", or in a sentence
   * that opens with no subject of its own ("Presently, the old man rose, and said", not "Ana
   * abrazó a su hijo, un niño de seis años, y le dijo"). Someone else's comment is none either
   * ("Tom hesitated, she thought, and then said"). After the teller's "I suppose" the subject is
   * the next one ("Tom came in, and I suppose Anne smiled and said").
   */
  private ownClauseSubject(
    ts: Token[],
    clause: number,
    start: number,
    join: number,
    v: number,
    notYo: boolean,
    mentions: Mention[],
  ): Who | undefined {
    let from = clause;
    let subject = openingSubject(ts, from, mentions, this.lang);
    // "y de pronto Nela se echó a reír y dijo:", "y por fin Nela levanta la vista y dice:": a set
    // phrase between the "y" and the subject.
    const glued3 = [1, 2, 3].every((d) => clause + d < join && !ts[clause + d]!.punctBefore);
    if (
      !subject &&
      QUESTION_JOINS[this.lang].has(ts[clause]!.text.toLowerCase()) &&
      glued3 &&
      BEFORE_VERB_PAIRS[this.lang].has(
        `${ts[clause + 1]!.text.toLowerCase()} ${ts[clause + 2]!.text.toLowerCase()}`,
      )
    ) {
      from = clause + 3;
      subject = openingSubject(ts, from, mentions, this.lang);
      // A "he" or "she" there is the sentence's own subject when that subject is of its gender
      // ("Mr. Holt reads the letter twice, and at last he looks up and says", "The old woman looks
      // at them for a long time, and at last she nods and says", "Tom went red, and in answer he
      // only nodded"); not when the subject's gender is another or unknown ("The nurse shook her
      // head, and at last he understood"), nor for a reply by someone of that gender the subject
      // acted on ("Tom shoved him against the wall, and in return he only laughed").
      const pair = `${ts[clause + 1]!.text.toLowerCase()} ${ts[clause + 2]!.text.toLowerCase()}`;
      const own = openingSubject(ts, start, mentions, this.lang);
      const ownGender =
        own?.kind === 'pronoun'
          ? own.gender
          : own && (matchCast(own.mention.name, this.entries)?.gender ?? own.mention.gender);
      const lw = (k: number) => ts[k]?.text.toLowerCase() ?? '';
      const actedOn =
        ['in reply', 'in answer', 'in return', 'in turn'].includes(pair) &&
        subject?.kind === 'pronoun' &&
        ts.slice(start + 1, clause).some((_, i) => {
          const k = start + 1 + i;
          if (subject?.kind !== 'pronoun') return false;
          if (subject.gender === 'male') return lw(k) === 'him';
          // "her" as an object, not a possessive ("scolded her for an hour", "questioned her
          // closely"; not "bit her lip")
          return (
            lw(k) === 'her' &&
            (k + 1 >= clause ||
              !!ts[k + 1]!.punctBefore ||
              /\p{Ll}ly$/u.test(lw(k + 1)) ||
              ['for', 'with', 'about', 'against', 'into', 'to', 'at', 'on', 'in', 'over'].includes(
                lw(k + 1),
              ))
          );
        });
      if (
        subject?.kind === 'pronoun' &&
        subject.gender !== 'narrator' &&
        ownGender === subject.gender &&
        !actedOn
      ) {
        from = clause;
        subject = null;
      }
    }
    // The hedge is in the stretch, before the join: not the teller's own aside after it ("and I,
    // and this I regret, said").
    if (isTeller(subject) && (notYo || authorialTeller(ts, clause, join, this.lang))) {
      const hedge = notYo ? -1 : hedgeEnd(ts, clause, join, this.lang);
      if (hedge === -1 || hedge + 1 >= join || ts[hedge + 1]!.punctBefore) return undefined;
      from = hedge + 1;
      subject = openingSubject(ts, from, mentions, this.lang);
      if (isTeller(subject)) return undefined;
    }
    if (!subject) return undefined;
    const end = openingSubjectEnd(ts, from, mentions, this.lang);
    // "so" + subject + a modal after an act is its purpose, no clause of its own ("Tom held the
    // door, so Anne could get through, and said"); after a state it is what follows ("Tom was
    // gone, so Anne could at last ask her question, and said").
    if (
      this.lang === 'en' &&
      ts[clause]!.text.toLowerCase() === 'so' &&
      /^(?:could|would|might|should|can|will|may|shall|must)$/u.test(
        ts[end + 1]?.text.toLowerCase() ?? '',
      )
    ) {
      const o = openingSubjectEnd(ts, start, mentions, this.lang);
      const be = ts[o + 1]?.text.toLowerCase() ?? '';
      const state =
        o > start - 1 &&
        /^(?:was|were|is|are)$/u.test(be) &&
        !/\p{Ll}ing$/u.test(ts[o + 2]?.text ?? '');
      if (!state) return undefined;
    }
    const joined = QUESTION_JOINS[this.lang].has(ts[clause]!.text.toLowerCase());
    // "dijo Nela, y Pablo, y esto no lo olvidaré nunca, respondió": the subject "and" brings in,
    // right before an aside, is the tag's when it cannot be one more object. So it is after the
    // tag's own subject ("said Anne, and Tom, and after a moment, replied"), for "he" or "él"
    // ("looked at Anne, and he, and this I will never forget, said"), and before an aside that is
    // a clause of its own, in a tag-first sentence or with no person right before ("Mrs. Bennet
    // looked away, and Anne, and this surprised me, said", "y Pablo, y no era la primera vez,
    // contestó:"); not in a list ("Mrs. Bennet kissed Tom, and then Anne, and after a moment,
    // said", "kissed him, and Anne, and I shall never forget it, said").
    const tagFirst = !!verbAt(ts, start, this.lang);
    // The tag's subject may be followed by -ly words, again/then/now, a set pair, "to <person>"
    // before a reply verb, or an aside that is a participle with no object (", smiling,",
    // ", smiling broadly,"); a tag with the name first counts too.
    const subjectEndAt = (k: number) =>
      isPronoun(ts[k]?.text ?? '', this.lang) !== undefined
        ? k
        : (mentions.find((m) => m.first === k && !m.possessive)?.last ?? -1);
    let tagEnd = tagFirst ? subjectEndAt(start + 1) : -1;
    if (!tagFirst && this.lang === 'en') {
      const e = subjectEndAt(start);
      if (e !== -1 && ts[e + 1] && !ts[e + 1]!.punctBefore && verbAt(ts, e + 1, this.lang)) {
        tagEnd = e + 1;
      }
    }
    const lowerTag = (k: number) => ts[k]?.text.toLowerCase() ?? '';
    let f = tagEnd + 1;
    while (tagEnd !== -1 && f < clause) {
      if (ts[f]!.punctBefore) {
        if (ts[f]!.punctBefore !== ',' || !/^\p{Ll}+ing$/u.test(ts[f]!.text)) break;
        f++;
        while (f < clause && !ts[f]!.punctBefore && /^\p{Ll}+ly$/u.test(ts[f]!.text)) f++;
        if (f < clause && !ts[f]!.punctBefore) {
          f = -1;
          break;
        }
      } else if (/^\p{Ll}+ly$/u.test(ts[f]!.text) || AFTER_VERB_SKIP[this.lang].has(lowerTag(f)))
        f++;
      else if (
        !ts[f + 1]?.punctBefore &&
        BEFORE_VERB_PAIRS[this.lang].has(`${lowerTag(f)} ${lowerTag(f + 1)}`)
      ) {
        f += 2;
      } else if (
        lowerTag(f) === 'to' &&
        !!verbAt(ts, v, this.lang)?.reply &&
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
      !!verbAt(ts, v, this.lang)?.reply &&
      mentions.some((m) => m.first === start + 1 && !m.possessive && m.last < clause - 1);
    const tagSubject =
      (tagFirst && this.lang === 'es') || (tagEnd !== -1 && f === clause) || saidTo;
    const opener = ts[join + 1]?.text.toLowerCase() ?? '';
    const remark =
      join + 1 < v &&
      // A clitic too ("y se lo agradezco"), not an article ("y la verdad,").
      (this.lang === 'es'
        ? ['esto', 'eso', 'aquello', 'ello', 'no', 'nunca', 'jamás', 'nadie'].includes(opener) ||
          (CLITICS.es.has(opener) && !['la', 'los', 'las'].includes(opener)) ||
          // "ninguno" as "nadie", and a subject pronoun ("y yo nunca lo olvidaré,")
          [
            'ninguno',
            'ninguna',
            'yo',
            'tú',
            'él',
            'ella',
            'nosotros',
            'nosotras',
            'vosotros',
            'vosotras',
            'ellos',
            'ellas',
            'usted',
            'ustedes',
          ].includes(opener)
        : ['i', 'we', 'he', 'she', 'they', 'it', 'this', 'that', 'nobody'].includes(opener) ||
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
                ['my', 'his', 'her', 'our', 'their', 'your', 'everyone’s', "everyone's"].includes(
                  ts[join + 2]?.text.toLowerCase() ?? '',
                ) &&
                !(
                  (ts[join + 3]?.text.toLowerCase() ?? '') in SPEAKER_NOUNS.en ||
                  /^\p{Lu}/u.test(ts[join + 3]?.text ?? '')
                )) ||
              (opener === 'much' && ts[join + 2]?.text.toLowerCase() === 'to') ||
              (opener === 'strange' &&
                ts[join + 2]?.text.toLowerCase() === 'to' &&
                ts[join + 3]?.text.toLowerCase() === 'say'))));
    // A person no mention shows counts too: "kissed the baby, and Anne,", "hugged the boys, and".
    const before = ts[clause - 1]?.text.toLowerCase() ?? '';
    // A plural too ("the ladies", "the gentlemen", "her parents"), and after a count ("her two
    // sons", "both boys").
    const beforeNoun = ts[clause - 2]?.text.toLowerCase() ?? '';
    // The narrow test (a determiner right before a person noun) always counts; the wider one
    // (plurals, counts) only before a verb that is no reply ("Mrs. Bennet scolded the twins, and
    // Anne, and nobody expected it, replied" is Anne's).
    const narrowNoun =
      this.lang === 'en' &&
      beforeNoun in DETERMINERS.en &&
      (['baby', 'babies', 'children', 'men', 'women'].includes(before) ||
        before.replace(/s$/u, '') in SPEAKER_NOUNS.en);
    const widerNoun =
      this.lang === 'en' &&
      !verbAt(ts, v, this.lang)?.reply &&
      (beforeNoun in DETERMINERS.en ||
        /^(?:two|three|four|five|six|both|several|many|few|some|other)$/u.test(beforeNoun)) &&
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
        before.replace(/s$/u, '') in SPEAKER_NOUNS.en ||
        before.replace(/ies$/u, 'y') in SPEAKER_NOUNS.en ||
        before.replace(/men$/u, 'man') in SPEAKER_NOUNS.en);
    // The wider test counts only for a direct object ("kissed the twins, and Anne,", not "laughed
    // at the twins, and Anne,").
    let d = clause - 2;
    while (
      d > start &&
      (ts[d]!.text.toLowerCase() in DETERMINERS.en ||
        /^(?:two|three|four|five|six|both|several|many|few|some|other)$/u.test(
          ts[d]!.text.toLowerCase(),
        ))
    ) {
      d--;
    }
    const direct =
      !/^(?:at|to|with|for|of|in|on|from|by|about|towards?|into|onto|upon|over|under|behind|beside|near|among|between|around|after|before|without|like|past|through|across|against|beyond)$/u.test(
        ts[d]?.text.toLowerCase() ?? '',
      );
    const personNoun = narrowNoun || (widerNoun && direct);
    const personBefore =
      personNoun ||
      mentions.some((m) => m.last === clause - 1 && !m.possessive && !this.addressedIn(ts, m)) ||
      ['him', 'them', 'me', 'us', 'both', 'all'].includes(before);
    // A Spanish name with no "a" is no object either ("Nela miró a Ana, y Pablo, y después de un
    // rato, dijo:"; not "pidió agua, y el médico,").
    // Not after a capitalised word that is no one of the cast and no "a" marks as a person: then it
    // is a list of places or things ("Nela nombró Sevilla, y Córdoba,", "visitó Toledo, y
    // Segovia,"), unless the name is someone of the cast ("Entró Lucía, y Nela,"). After someone of
    // the cast it is a person ("Entró Nela, y Lucía,", "Nela hablaba con Pablo, y Lucía,"). With no
    // cast the engine cannot tell a place from a person, so nothing changes.
    const listedAfter = mentions.find((x) => x.last === clause - 1);
    const listedKey = listedAfter && matchCast(listedAfter.name, this.entries)?.key;
    const listed =
      /^\p{Lu}/u.test(ts[clause - 1]?.text ?? '') &&
      !['a', 'al'].includes(
        ts[(listedAfter ? listedAfter.first : clause - 1) - 1]?.text.toLowerCase() ?? '',
      ) &&
      (listedKey === undefined || listedKey.startsWith('new:'));
    const castKnown = this.entries.some((e) => e.role === 'character' && !e.key.startsWith('new:'));
    const castName =
      subject.kind === 'mention' &&
      !(matchCast(subject.mention.name, this.entries)?.key ?? 'new:').startsWith('new:');
    const spanishName =
      this.lang === 'es' &&
      subject.kind === 'mention' &&
      subject.mention.kind === 'name' &&
      (!listed || castName || !castKnown);
    // Nor is a Spanish descriptor after a person the "a" marks, which one more object would need
    // too ("Nela miró a Ana, y el médico, y después de un rato, dijo:"; "y al médico" would be
    // one), nor one after "y entonces", unless it adds to someone named with no "a" ("pidió un
    // médico, y entonces una enfermera,"; but "cerró la puerta, y entonces el médico,").
    const personalA =
      this.lang === 'es' &&
      (mentions.some(
        (m) =>
          m.last === clause - 1 &&
          !m.possessive &&
          ['a', 'al'].includes(ts[m.first - 1]?.text.toLowerCase() ?? ''),
      ) ||
        // "Nela llamó al médico, y la enfermera,"
        ((ts[clause - 2]?.text.toLowerCase() ?? '') === 'al' &&
          (ts[clause - 1]?.text.toLowerCase() ?? '') in SPEAKER_NOUNS.es));
    const bareObject = mentions.some(
      (m) =>
        m.last === clause - 1 &&
        !m.possessive &&
        !['a', 'al'].includes(ts[m.first - 1]?.text.toLowerCase() ?? '') &&
        [ts[m.first - 1], ts[m.first]].some((t) =>
          ['un', 'una', 'unos', 'unas'].includes(t?.text.toLowerCase() ?? ''),
        ),
    );
    const entonces =
      this.lang === 'es' && ts[clause + 1]?.text.toLowerCase() === 'entonces' && !bareObject;
    // A person the stretch itself marks with "a" or "al" stays one more object ("llamó a la
    // enfermera, y al cura,", "miró a Ana, y entonces al médico,").
    const marked =
      subject.kind === 'mention' &&
      ts
        .slice(clause + 1, subject.mention.first + 1)
        .some((t) => ['a', 'al'].includes(t.text.toLowerCase()));
    const newSubject =
      tagSubject ||
      subject.kind === 'pronoun' ||
      spanishName ||
      ((personalA || entonces) && !marked) ||
      (remark && (tagFirst || !personBefore));
    if (
      joined &&
      newSubject &&
      end + 1 === join &&
      !!ts[join]!.punctBefore &&
      ts[v]!.punctBefore === ','
    ) {
      return this.sentenceSubject(ts, from, mentions);
    }
    // "and Arthur without a word gathers up his notes and says", "y Lucía por fin apoya la cabeza y
    // dice:": a name or pronoun right after the "and" that opens a stretch with no comma before the
    // join, so a phrase before its verb may end in a present form. A descriptor opens one too ("and
    // the old man by the fire nods and says", "y su madre muy despacio dobla la carta y dice:"), and
    // a lead word may come first ("and then Anne with a sigh gets up and says", "y luego ella con
    // calma dobla la carta y dice:").
    const first = subject.kind === 'pronoun' ? end : subject.mention.first;
    const open =
      from === clause &&
      (first === clause + 1 ||
        (first === clause + 2 &&
          !ts[clause + 1]!.punctBefore &&
          SENTENCE_LEADS[this.lang].has(ts[clause + 1]!.text.toLowerCase()))) &&
      joined &&
      !ts[join]!.punctBefore;
    // An -s form is a verb in an open stretch only in present narration ("and Anne without a word
    // gathers up her notes and says"; not "and Anne with two kisses on both cheeks and said").
    const present = this.lang === 'es' || /\p{Ll}s$/u.test(ts[v]!.text);
    // A stretch that "and" or "but" opens, or the main clause after a clause that "when" or the
    // like opens, has a verb: it is no phrase ("Tom shook his head, and Anne all but begged to
    // come along, and said", "When the music stopped, Anne cast another glance at the door, and
    // said"; not "Tom came in, Anne rather flushed with the heat, and said").
    const clauseOnly =
      joined ||
      (SUBORDINATORS.has(ts[start]!.text.toLowerCase()) &&
        this.opensWithoutSubject(ts, start, clause, mentions));
    const verb = verbAfterSubject(
      ts,
      end,
      join,
      this.lang,
      subject.kind === 'mention',
      open,
      present,
      clauseOnly,
    );
    if (verb === -1) return undefined;
    // In past narration a participle after the subject makes a phrase with no verb: "Pablo entró,
    // Nela todavía dormida en sus brazos, y dijo:".
    const tagWord = ts[v]!.text.normalize('NFC').toLowerCase();
    if (
      this.lang === 'es' &&
      /^\p{Ll}+(?:ad|id)[oa]s?$/u.test(ts[verb]!.text) &&
      !CLITICS.es.has(ts[verb - 1]!.text.toLowerCase()) &&
      (spanishPast(tagWord) || /ía$/u.test(tagWord))
    ) {
      return undefined;
    }
    // After a Spanish set phrase, in a stretch that runs to a comma, an adjective or a participle
    // makes a phrase: "Nela por fin tranquila, y dijo:", "Nela al fin dormida en sus brazos, y
    // dice:", "Nela por fin sentada a la mesa, y dice:" (not "Nela de pronto tenía miedo, y dijo:",
    // "Nela de pronto sonríe, y dice:", nor a verb of that shape: "Nela de pronto olvida, y dice:").
    // In present narration only a participle or an adjective of state that is no verb form does.
    if (
      this.lang === 'es' &&
      !!ts[join]!.punctBefore &&
      verb >= 2 &&
      BEFORE_VERB_PAIRS.es.has(
        `${ts[verb - 2]!.text.toLowerCase()} ${ts[verb - 1]!.text.toLowerCase()}`,
      )
    ) {
      const w = ts[verb]!.text.normalize('NFC').toLowerCase();
      const next = ts[verb + 1]?.text.toLowerCase() ?? '';
      const pastForm = spanishPast(w) || /ían?$/u.test(w) || /^(?:era|eran|iba|iban)$/u.test(w);
      const shaped = (x: string) =>
        /^\p{Ll}+(?:ad|id|íd)[oa]s?$/u.test(x) &&
        !/^(?:olvid|cuid|nad|convid|intimid|valid|liquid|anid|agrad|desagrad|degrad)an?$/u.test(x);
      const listed = (x: string) => /^(?:tranquil|quiet|sol|seri)[oa]s?$|^tristes?$/u.test(x);
      // An adjective with no verb shape is one too, unless it is a past form ("Nela por fin vino,",
      // "Tomás de pronto dio con"): it ends in a consonant other than n or s ("feliz", "fiel",
      // "capaz de hablar"), in -ces ("felices"), is an -ioso one ("nerviosa"), or ends in -o or -os
      // after a third person, which has no present form in -o ("Pablo al fin despierto,", "Tomás
      // por fin contento"; not "yo por fin respiro,").
      const unverbal = (x: string) =>
        !pastForm &&
        (/\p{Ll}[zldrj]$|\p{Ll}ces$|\p{Ll}ios[oa]s?$/u.test(x) ||
          (/\p{Ll}os?$/u.test(x) && !isTeller(subject)));
      // The phrase ends at the join, before a preposition ("tranquila en su sillón"), or with a
      // second participle or state word after "y" ("seria y callada", "sola y triste").
      const third = ts[verb + 2]?.text.normalize('NFC').toLowerCase() ?? '';
      const phraseEnds =
        verb + 1 === join ||
        PREPOSITIONS.es.has(next) ||
        (next === 'y' && verb + 3 === join && (shaped(third) || listed(third)));
      const participle = shaped(w) && phraseEnds;
      const state = (listed(w) || unverbal(w)) && phraseEnds;
      if (participle || state || ((spanishPast(tagWord) || /ía$/u.test(tagWord)) && !pastForm)) {
        return undefined;
      }
    }
    // Someone else's comment with nothing after its verb: "Tom hesitated, she thought, and then
    // said". The teller's own past verb is the one the join takes ("Anne was right, I thought, and
    // said"; see authorialTeller).
    // A comment's verb may come after a modal or an auxiliary: "Anne can see,", "Anne must have
    // noticed,", "Anne by the window had noticed,".
    let main = verb;
    while (
      this.lang === 'en' &&
      main + 1 < join &&
      !ts[main + 1]!.punctBefore &&
      (AUXILIARIES.has(ts[main]!.text.toLowerCase()) ||
        ['can', 'cannot', 'may', 'might', 'must'].includes(ts[main]!.text.toLowerCase()))
    ) {
      main++;
    }
    const comment =
      !!verbAt(ts, main, this.lang)?.thought || COMMENT_VERBS[this.lang].has(ts[main]!.text);
    // A comment about a state, or what the teller was told: "Anne was sure, and said", "Anne tells
    // me, and says".
    const after = ts[verb + 1]?.text ?? '';
    const sure =
      this.lang === 'en' &&
      verb + 2 === join &&
      ((/^(?:was|were)$/u.test(ts[verb]!.text) &&
        /^(?:sure|certain|convinced|aware)$/u.test(after)) ||
        (/^(?:tells|told)$/u.test(ts[verb]!.text) && /^(?:me|us)$/u.test(after)));
    // The teller's comment on a state is the clause the join takes ("Anne was right, I thought,
    // and said"), not one on someone's act ("Tom hesitated, I noticed, and then said").
    const opening = openingSubjectEnd(ts, start, mentions, this.lang);
    const state =
      /^(?:was|were|is|are)$/u.test(ts[opening + 1]?.text ?? '') &&
      !/ing$/u.test(ts[opening + 2]?.text ?? '');
    // A comment "and" or "but" opens is the clause the join goes on with ("but Anne noticed, and
    // said", "y Nela lo oyó y contestó:"), and so is a Spanish verb with an object of its own
    // before it ("Nela lo oyó, y gritó desde la cocina:", as "Anne heard it, and shouted").
    // Not when its "he" or "she" is whoever just asked, watching the other hesitate before the
    // answer: "—¿Qué te pasa? —preguntó Ana. / Pablo dudó, ella lo notó, y luego dijo:" and
    // "Pablo dudó, ella lo vio, y dijo:" are Pablo's (but "Pablo tosió, ella lo oyó, y luego
    // gritó:" is Nela's).
    const lowerAt = (k: number) => ts[k]?.text.toLowerCase() ?? '';
    let h = openingSubjectEnd(ts, start, mentions, this.lang) + 1;
    while (h < clause && CLITICS.es.has(lowerAt(h))) h++;
    const hesitated =
      /^(?:dud|vacil|titube|tard|call|enrojec|sonroj|ruboriz)/u.test(lowerAt(h)) ||
      (/^(?:puso|pone)$/u.test(lowerAt(h)) &&
        /^(?:colorad|roj|pálid|nervios)/u.test(lowerAt(h + 1))) ||
      (/^(?:quedó|queda)$/u.test(lowerAt(h)) &&
        /^(?:callad|quiet|pensativ|mud|en)/u.test(lowerAt(h + 1)));
    const asker =
      subject.kind === 'pronoun' &&
      this.lastAsker !== undefined &&
      this.entry(this.lastAsker).gender === subject.gender &&
      hesitated &&
      !verbAt(ts, v, this.lang)?.tone;
    const object =
      this.lang === 'es' &&
      verb > end + 1 &&
      CLITICS.es.has(ts[verb - 1]!.text.toLowerCase()) &&
      !asker;
    // A Spanish present seeing or hearing verb comments only there, on whoever just asked ("Pablo
    // duda, ella lo nota, y luego dice:"); otherwise its subject goes on ("Ana la llama desde el
    // patio, Nela oye, y responde:"). "piensa" comments as before ("Pablo duda, ella piensa, y
    // luego dice:").
    const remarks =
      comment &&
      (asker ||
        this.lang !== 'es' ||
        !['nota', 've', 'oye', 'siente'].includes(ts[main]!.text.toLowerCase()));
    if (
      ((remarks && main + 1 === join) || sure) &&
      !joined &&
      !object &&
      !(isTeller(subject) && state)
    ) {
      return undefined;
    }
    // Between commas a descriptor may be an appositive ("Ana abrazó a su hijo, un niño de seis
    // años, y le dijo", "a la anciana, una mujer menuda, y"); right before the join, or before a
    // Spanish past form, it is the verb's subject ("Pablo cogió el abrigo, su madre suspiró y
    // dijo:", "su madre suspiró, y dijo:", "su madre se puso pálida, y dijo:", "la abuela había
    // estado llorando, y dijo:").
    const named = subject.kind === 'pronoun' || subject.mention.kind === 'name';
    const pastWord = ts[verb]!.text.normalize('NFC').toLowerCase();
    const past =
      this.lang === 'es' &&
      (/(?:ó|aban?|ían)$/u.test(pastWord) ||
        STRONG_PRETERITES.has(pastWord) ||
        (verb > end + 1 && CLITICS.es.has(ts[verb - 1]!.text.toLowerCase())) ||
        (/^hab[íi]an?$/u.test(pastWord) && /(?:ad|id)o$/u.test(ts[verb + 1]?.text ?? '')));
    // A present form is not enough there: it may be an adjective ("a Nela, su hija pequeña, y le
    // dice:", "Pablo se sienta, su madre seria, y dice:"), so "su madre suspira, y dice:" stays
    // with the sentence's subject.
    const enclosed = !!ts[join]!.punctBefore && !past;
    if (!named && !joined && enclosed && !this.opensWithoutSubject(ts, start, clause, mentions)) {
      return undefined;
    }
    return this.sentenceSubject(ts, from, mentions);
  }

  /**
   * Whether the sentence at `start` has no subject of its own before `clause`: it opens with a
   * phrase or a clause ("When the music stopped, Mr. Darcy bowed, then said", "Presently, the old
   * man rose and said"), not with a subject, nor with a verb and its subject ("Entró don Ramón, el
   * padre de Ana, y dijo").
   */
  private opensWithoutSubject(
    ts: Token[],
    start: number,
    clause: number,
    mentions: Mention[],
  ): boolean {
    const first = ts[start]!.text.toLowerCase();
    // The phrase or clause that opens the sentence runs to its first comma, right before the
    // stretch: "When the music stopped, the old man rose, and said", not "Cuando Ana llegó, abrazó
    // a su hijo, un niño pálido y delgado, y le dijo".
    let opening = start + 1;
    while (opening < clause && !ts[opening]!.punctBefore) opening++;
    const second = ts[start + 1]?.text.toLowerCase() ?? '';
    // Someone named in an English phrase that opens with a participle or a preposition is not
    // its subject: "Seeing Tom, the old woman rose", "With Tom gone, the housekeeper came in",
    // "Long after Tom had gone to bed, the old man rose".
    const fronted =
      this.lang === 'en' &&
      (/\p{L}ing$/u.test(first) ||
        NON_PARTICIPANT_PREPOSITIONS.en.has(first) ||
        PHRASE_AFTER_PERSON.en.has(first) ||
        first === 'like' ||
        first === 'unlike' ||
        (/^(?:long|soon|shortly|just|right|even)$/u.test(first) && SUBORDINATORS.has(second)));
    // In English it may run on past that comma when nobody is a subject before the stretch
    // ("Seeing Tom at the gate, and knowing what it meant, the old woman rose", "When the music
    // stopped, and the dancers had gone, the old man rose"; not "Hearing the gate, Anne ran to her
    // father, a tall man dressed in black,"). Spanish leaves its subject out, so there it may not.
    // Someone named in a part that "and" or "or" adds to the opening is no subject before the
    // stretch either ("When the music stopped, and Anne sat down again, the old man rose").
    const continues = (k: number) => {
      let j = k;
      while (j > opening && !ts[j]!.punctBefore) j--;
      return ['and', 'or'].includes(ts[j]!.text.toLowerCase());
    };
    const subject =
      this.lang === 'es' ||
      ts
        .slice(opening, clause)
        .some(
          (t, i) =>
            ['i', 'we', 'he', 'she', 'they'].includes(t.text.toLowerCase()) &&
            !continues(opening + i),
        ) ||
      mentions.some(
        (m) =>
          m.first >= opening &&
          m.last < clause &&
          !continues(m.first) &&
          !m.possessive &&
          !this.afterPreposition(ts, m) &&
          !this.addressedIn(ts, m) &&
          !['like', 'unlike'].includes(ts[m.first - 1]?.text.toLowerCase() ?? ''),
      );
    const runs = opening === clause || !subject;
    if (fronted && runs) return true;
    if (openingSubject(ts, start, mentions, this.lang)) return false;
    if (SUBORDINATORS.has(first) || CLAUSE_LEADS[this.lang].has(first)) return runs;
    // An English part after a comma that opens with a subject pronoun is the main clause, as a
    // name is ("Hearing the gate, I ran to my father, a tall man dressed in black, and said").
    const pronounClause = ts
      .slice(start + 1, clause)
      .some(
        (t) => !!t.punctBefore && ['i', 'we', 'he', 'she', 'they'].includes(t.text.toLowerCase()),
      );
    if (this.lang === 'en' && pronounClause) return false;
    return !mentions.some(
      (m) =>
        m.first >= start &&
        m.last < clause &&
        !m.possessive &&
        !this.afterPreposition(ts, m) &&
        !this.addressedIn(ts, m),
    );
  }

  /**
   * "Ana entró, y cuando Pablo la vio, exclamó:", "Ana entró, y al verla Pablo, exclamó:": in a
   * Spanish aside that "cuando" or "al" opens right after the join, the person who sees or hears
   * someone ("la vio", "verla") says the line, unless they spoke last ("Ana se levantó, y cuando
   * Pablo la miró, dijo:" answers Pablo). Someone who acts on them does not ("y cuando Pablo la
   * llamó, contestó:", "y al despertarla Pablo, preguntó:").
   */
  private asideSeer(ts: Token[], join: number, v: number, mentions: Mention[]): Who | undefined {
    if (this.lang !== 'es' || ts[join]!.punctBefore !== ',' || ts[v]!.punctBefore !== ',') {
      return undefined;
    }
    const lead = ts[join + 1]?.text.toLowerCase();
    if (lead !== 'cuando' && lead !== 'al') return undefined;
    const word = (k: number) => ts[k]?.text.toLowerCase() ?? '';
    const sees = ts.slice(join + 1, v).some((_, j) => {
      const k = join + 1 + j;
      // The clitic comes right after "cuando" or the seer ("cuando Pablo la vio", "cuando la vio
      // Pablo"); after a verb it is an article ("cuando Pablo leyó la nota").
      if (/^l[oa]s?$/u.test(word(k))) {
        // An adverb may stand between them ("cuando Pablo también la vio", "cuando él ya la oyó").
        const adverb =
          (BEFORE_VERB_SKIP.es.has(word(k - 1)) && !CLITICS.es.has(word(k - 1))) ||
          SUBJECT_ADVERBS.es.has(word(k - 1));
        const at = adverb && k - 2 > join ? k - 2 : k - 1;
        const lead =
          at === join + 1 ||
          isPronoun(ts[at]!.text, this.lang) !== undefined ||
          mentions.some((m) => m.last === at);
        return lead && SEEING_VERBS.has(word(k + 1));
      }
      const infinitive = /^(\p{Ll}+?)l[oa]s?$/u.exec(word(k));
      return !!infinitive && SEEING_INFINITIVES.has(infinitive[1]!);
    });
    const before = (m: Mention) => ts[m.first - 1]!.text.toLowerCase();
    const m = mentions.find(
      (x) =>
        x.first > join + 1 &&
        x.last < v &&
        !x.possessive &&
        !ADDRESSEE_MARKERS.es.has(before(x)) &&
        !PREPOSITIONS.es.has(before(x)),
    );
    const who = sees && m ? someone(this.resolve(m)) : undefined;
    return who && who.key !== this.lastSpeaker ? who : undefined;
  }

  /** The tag for the voiced unit at `n`: in the narration right after it, else right before. */
  private tagNear(
    units: Unit[],
    n: number,
    tokens: Map<Unit, Token[]>,
    isVoiced: (u: Unit) => boolean,
  ): Tag | undefined {
    return this.nearTag(
      units,
      n,
      tokens,
      isVoiced,
      (ts, v) => this.tagIn(ts, v),
      (tag) => !!tag && (!!tag.speaker || !!tag.pending),
    );
  }

  /**
   * What `read` gives for the tag of the voiced unit at `n` (see tagNear), reading a narration
   * unit at a verb (-1 for none). `named`: whether what it gave names who speaks, which decides
   * between the narration after the line and before it. The teller check reads tags through here
   * too, so it reads the verbs the tagger reads.
   */
  private nearTag<T>(
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
      return read(ts, this.beforeVerb(before, ts));
    };

    // The second half of an interrupted quote takes the tag that interrupts it: "“Lucy,” he
    // said to me, “you are…”"
    const interrupted =
      !!before &&
      !isVoiced(before) &&
      /,\s*$/u.test(this.slice(before)) &&
      !!units[n - 2] &&
      isVoiced(units[n - 2]!) &&
      (/^\s*[“"«‘'—]\s*\p{Ll}/u.test(this.slice(units[n]!)) ||
        /,\s*[”"»’']?\s*$/u.test(this.slice(units[n - 2]!)));
    if (interrupted) {
      const tag = beforeTag();
      if (named(tag)) return tag;
    }
    if (after && !isVoiced(after)) {
      const ts = tokens.get(after)!;
      const verbIndex = this.afterVerb(after, ts);
      const tag = read(ts, verbIndex);
      if (tag) {
        // "Tom said, “Yes.” Then Anne said, “No.”": the narration after the line leads into the
        // next one, so this line's own intro wins. The first half of a split quote with no intro
        // of its own keeps the tag that splits it ("Anne laughed. “You,” Tom said, “…”").
        const introBefore = !!before && !isVoiced(before) && INTRO_END.test(this.slice(before));
        const firstHalf =
          /,\s*[”"»’']?\s*$/u.test(this.slice(units[n]!)) || /^\s*,/u.test(this.slice(after));
        const leadsOn =
          verbIndex > 0 &&
          INTRO_END.test(this.slice(after)) &&
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
  private afterVerb(u: Unit, ts: Token[]): number {
    const end = firstSentenceEnd(ts);
    const limit = Math.min(TAG_WINDOW, end);
    const v = ts.findIndex((_, i) => i < limit && this.tagVerb(ts, i));
    const reported = v === -1 ? -1 : this.reportedVerb(ts, v);
    const w = reported === -1 ? v : reported;
    return w !== -1 && this.asks(u, ts, w, end) ? -1 : w;
  }

  /**
   * "I was told I said", "I’m told she asked", "he told me that Anne said": hearsay told to the
   * teller about who said the line. The reported speech verb, right after its own subject in the
   * same sentence, or -1.
   */
  private reportedVerb(ts: Token[], v: number): number {
    if (this.lang !== 'en' || !this.saidToTeller(ts, v)) return -1;
    const word = (k: number) => (ts[k]?.punctBefore ? undefined : ts[k]?.text.toLowerCase());
    let k = v + 1;
    if (word(k) === 'me') k++;
    else if (word(k) === 'to' && word(k + 1) === 'me') k += 2;
    if (word(k) === 'that') k++;
    if (word(k) === undefined) return -1;
    const mention = this.mentions(ts).find((m) => m.first === k && !m.possessive);
    const subjectEnd = isPronoun(ts[k]!.text, this.lang) ? k : mention?.last;
    if (subjectEnd === undefined) return -1;
    const end = firstSentenceEnd(ts);
    const w = ts.findIndex((_, i) => i > subjectEnd && i < end && this.isVerb(ts, i));
    return w !== -1 && subjectIndexBefore(ts, w, this.lang) === subjectEnd ? w : -1;
  }

  /**
   * The verb of a tag before a line: the last in the narration's last 6 words. Never across a
   * sentence ("“Help!” screamed Anne. Tom ran in. “What’s wrong?”"), but an intro clause is read
   * whole ("Mrs. Bennet said to her husband one cold evening, “…”"). A question has none.
   */
  private beforeVerb(u: Unit, ts: Token[]): number {
    const sentence = lastSentenceStart(ts);
    const from = INTRO_END.test(this.slice(u))
      ? sentence
      : Math.max(sentence, ts.length - TAG_WINDOW);
    // "y ella respondió que sí:" introduces its line, though "respondió que sí." reports one.
    const n = ts.length;
    if (
      this.lang === 'es' &&
      this.slice(u).trimEnd().endsWith(':') &&
      n - 3 >= from &&
      ts[n - 2]!.text.toLowerCase() === 'que' &&
      ['sí', 'no'].includes(ts[n - 1]!.text.toLowerCase()) &&
      !ts[n - 2]!.punctBefore &&
      !ts[n - 1]!.punctBefore &&
      this.isVerb(ts, n - 3)
    ) {
      return n - 3;
    }
    const v = findLastIndex(ts, (_, i) => i >= from && this.tagVerb(ts, i));
    return v !== -1 && this.asks(u, ts, v, ts.length) ? -1 : v;
  }

  /**
   * Whether the verb at `v` asks: the sentence of narration unit `u` that ends before token `end`
   * (at the unit's end when it is `ts.length`) is a question, and the verb is in it: its own clause
   * opens with "¿", a question word or an auxiliary, perhaps after "and" or "but" ("What could I
   * say?", "Had he told me nothing, or had I not listened?"), or no comma or pause and a word such
   * as "but" or "because" separate it from the question ("Did he mean it, I wondered?", "Why, I
   * ask you, did he come?"), also when the question opens before an aside the verb is in ("Did he
   * mean it, I asked myself, as I watched him go?"). A tag before such a word is a tag: "“I’m
   * fine,” I said, but was I?", "Tom said, because what else could he say?", "I said… but was I?",
   * and so is one that goes on from its line after a comma, whatever its first word ("“I’m fine,”
   * Will said, but was he?", "“Out,” was all I said, but…").
   */
  private asks(u: Unit, ts: Token[], v: number, end: number): boolean {
    const after =
      end < ts.length
        ? ts[end]!.punctBefore
        : this.text.slice(u.start + (ts.at(-1)?.end ?? 0), u.end);
    if (!after.includes('?')) return false;
    const word = (k: number) => ts[k]?.text.toLowerCase().replace(/’/gu, "'") ?? '';
    const glued = (k: number) => !!ts[k] && !ts[k]!.punctBefore;
    const names = this.mentions(ts);
    const subjects = ['i', 'you', 'he', 'she', 'we', 'they', 'it'];
    // A cast name such as "Will" or "May" opens no question before its verb ("“I’m fine!” Will
    // said, but was he?"), only before a subject ("Will we ever see her again, I wondered?").
    const name = (k: number) =>
      names.some((m) => m.first === k && m.kind === 'name' && !!matchCast(m.name, this.entries)) &&
      !(glued(k + 1) && subjects.includes(word(k + 1)));
    // A wh-word before its subject opens a clause, not a question: "When I asked", "How she
    // laughed", "Where the road ended" ("How do you know?", "Why the devil did you go?").
    const subordinate = (k: number) => {
      if (this.lang !== 'en' || !['when', 'where', 'how', 'why'].includes(word(k))) return false;
      if (!glued(k + 1)) return false;
      if (names.some((m) => m.first === k + 1 && !m.possessive)) return true;
      if (subjects.includes(word(k + 1))) return true;
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
        determiners.includes(word(k + 1)) &&
        glued(k + 2) &&
        !['hell', 'devil', 'heck', 'deuce'].includes(word(k + 2))
      );
    };
    // "Por qué", never "Por fin".
    const opens = (k: number) =>
      ts[k]!.punctBefore.includes('¿') ||
      (QUESTION_OPENERS[this.lang].has(word(k)) &&
        (word(k) !== 'por' || word(k + 1) === 'qué') &&
        !name(k) &&
        !subordinate(k));
    let c = v;
    while (c > 0 && !ts[c]!.punctBefore && !ts[c]!.sentenceStart) c--;
    if (QUESTION_JOINS[this.lang].has(word(c)) && c + 1 < v) c++;
    const goesOn =
      c === 0 &&
      (/,[”"’»]?\s*$/u.test(this.text.slice(Math.max(0, u.start - 3), u.start)) ||
        ts[0]!.punctBefore.startsWith(','));
    if (!goesOn && opens(c)) return true;
    let s = lastSentenceStart(ts.slice(0, v + 1));
    if (QUESTION_JOINS[this.lang].has(word(s)) && s + 1 < c) s++;
    if (s < c && opens(s)) return true;
    const joined = (t: Token) =>
      /[,;…]|\.\.\./u.test(t.punctBefore) && CONJUNCTIONS[this.lang].has(t.text.toLowerCase());
    return !ts.slice(v + 1, end).some(joined);
  }

  private tagIn(ts: Token[], verbIndex: number): Tag | undefined {
    if (verbIndex === -1) return undefined;
    const verb = verbAt(ts, verbIndex, this.lang)!;
    const mentions = this.mentions(ts);
    const others = mentions
      .filter((m) => !this.afterPreposition(ts, m) && !this.speakerOnly(m))
      .map((m) => this.resolve(m));
    const adverb = ts
      .slice(0, TAG_WINDOW + 4)
      .map((t) => ADVERB_TONES[this.lang][t.text.toLowerCase()])
      .find(Boolean);
    const subject = subjectOf(ts, verbIndex, mentions, this.lang);
    const glued = !ts[verbIndex]!.punctBefore;
    const prev = glued ? ts[verbIndex - 1]?.text.toLowerCase() : undefined;
    const next = ts[verbIndex + 1];
    const nextWord = next && !next.punctBefore ? next.text : undefined;
    const afterTo = nextWord === 'to' ? ts[verbIndex + 2]?.text : undefined;
    const toTeller = this.saidToTeller(ts, verbIndex);
    // Reflexive speech is thought; "se rió" is only laughing, so verbs with a tone never count.
    const reflexives = REFLEXIVES[this.lang];
    const thought =
      this.lang === 'es'
        ? !verb.tone &&
          ((prev === 'me' && !!verb.firstPerson) ||
            (prev === 'se' && !verb.firstPerson && nextWord !== 'lo'))
        : reflexives.has(nextWord ?? '') || reflexives.has(afterTo ?? '');

    let speaker: string | undefined;
    let pending: Gender | undefined;
    // Whether the teller's "I" names the speaker, not a name ("said Nick" for a narrator Nick).
    let teller = false;
    if (subject?.kind === 'mention') speaker = this.resolve(subject.mention, true);
    else if (subject?.gender === 'narrator' || (!subject && verb.firstPerson)) {
      speaker = this.narratorKey;
      teller = true;
    } else if (subject) pending = subject.gender;
    // "someone said", "—dijo alguien": nobody in particular.
    else if (this.indefiniteSubject(ts, verbIndex)) speaker = this.unknownKey;
    else {
      const start = lastSentenceStart(ts.slice(0, verbIndex + 1));
      const who = this.coordinatedSubject(ts, verbIndex, start, mentions);
      speaker = who?.key;
      teller = !!who?.teller;
      // "she turned and said" with no "she" found yet is read like "she said".
      if (!who) pending = this.pronounSubject(ts, verbIndex, mentions);
    }
    if (toTeller && speaker === this.narratorKey) speaker = undefined;

    const preverbal =
      subject?.kind === 'mention'
        ? subject.mention.last < verbIndex
        : !!subject && isPronoun(ts[verbIndex - 1]?.text ?? '', this.lang) !== undefined;
    // "to Anne", or the person right after the verb when the subject came first ("I asked Holmes").
    const addressees = mentions
      .filter(
        (m) =>
          this.addressedIn(ts, m) ||
          (preverbal && m.first === verbIndex + 1 && !ts[m.first]!.punctBefore),
      )
      .map((m) => this.resolve(m));
    // "she asked him": the man in the scene is the one spoken to.
    if (this.lang === 'en' && preverbal && (nextWord === 'him' || nextWord === 'her')) {
      const exclude = new Set(speaker ? [speaker] : []);
      const person = this.byGender(nextWord === 'him' ? 'male' : 'female', exclude);
      if (person) addressees.push(person);
    }
    return {
      verb,
      tone: verb.tone ?? adverb,
      ...(speaker ? { speaker } : {}),
      ...(pending ? { pending } : {}),
      teller: teller && speaker === this.narratorKey,
      toTeller,
      notTeller: this.notTeller(ts, verbIndex, mentions),
      thought,
      others,
      addressees,
    };
  }

  /**
   * A speech verb that can tag a line: not one that reports what was said with an object of its
   * own ("She nodded and said goodbye.", "She said nothing.", "Ella asintió y dijo adiós.").
   */
  private tagVerb(ts: Token[], i: number): boolean {
    const next = ts[i + 1];
    // A capitalised word is a name, not the object: "asked Grace" (but "said grace").
    const object =
      next && !next.punctBefore && LOWER.test(next.text) ? next.text.toLowerCase() : '';
    // "said no one" is said by nobody: an inverted subject.
    const reports =
      REPORTED_OBJECTS[this.lang].has(object) &&
      !tagAdverb(ts, i, this.lang) &&
      !(object === 'no' && ts[i + 2]?.text.toLowerCase() === 'one');
    return !reports && this.isVerb(ts, i);
  }

  private isVerb(ts: Token[], i: number): boolean {
    if (verbAt(ts, i, this.lang) === undefined) return false;
    return !this.presentForm(ts[i]!) || this.presentSubject(ts, i);
  }

  /** An English -s form ("laughs", "calls"), but not "says" or "asks", which are always verbs. */
  private presentForm(t: Token): boolean {
    const word = t.text.toLowerCase();
    return this.lang === 'en' && word.endsWith('s') && word !== 'says' && word !== 'asks';
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
  private presentSubject(ts: Token[], v: number): boolean {
    const mentions = this.mentions(ts);
    const start = lastSentenceStart(ts.slice(0, v + 1));
    // Joined to the clause before it, unless "and" joins two plural nouns ("between sobs and
    // gasps").
    const join = joinAt(ts, v, start, this.lang);
    if (join !== -1) {
      const plural = (k: number) =>
        verbAt(ts, k, this.lang) !== undefined && this.presentForm(ts[k]!) && !this.isVerb(ts, k);
      let s = start;
      while (s < join && SENTENCE_LEADS[this.lang].has(ts[s]!.text.toLowerCase())) s++;
      // The subject of the clause it is joined to, or of the sentence: "Somebody laughs, and Mom
      // turns around and whispers". That clause starts before the comma of ", and" ("says Anne,
      // and Tom, and after a moment, adds").
      let clause = ts[join]!.punctBefore ? join - 1 : join;
      while (clause > start && !ts[clause]!.punctBefore) clause--;
      return (
        !plural(join - 1) &&
        (openingSubject(ts, clause, mentions, this.lang) !== null ||
          openingSubject(ts, start, mentions, this.lang) !== null ||
          this.indefiniteSubject(ts, v) ||
          // "The judge bangs his gavel and shouts,"
          nounSubject(ts, s, s + 1, v, this.lang))
      );
    }
    let b = subjectIndexBefore(ts, v, this.lang);
    while (b > 0 && FREQUENCY_ADVERBS.has(ts[b]!.text.toLowerCase())) {
      b = subjectIndexBefore(ts, b, this.lang);
    }
    const before = b === -1 ? undefined : ts[b]!;
    const word = before?.text.toLowerCase() ?? '';
    const after = ts[v + 1] && !ts[v + 1]!.punctBefore ? ts[v + 1]!.text.toLowerCase() : '';
    if (!before || BEFORE_VERB_SKIP[this.lang].has(word) || /^\p{Ll}+ly$/u.test(before.text)) {
      return (
        subjectOf(ts, v, mentions, this.lang) !== null ||
        this.indefiniteSubject(ts, v) ||
        // "shouts one of the guards", "cries the old woman", but not "Whispers that the king…"
        (after in DETERMINERS[this.lang] && after !== 'that' && after !== 'this') ||
        after === 'one'
      );
    }
    if (NOUN_LEADS.has(word) || before.possessive) return false;
    if (
      isPronoun(before.text, this.lang) !== undefined ||
      this.indefiniteAt(ts, b) ||
      RELATIVES[this.lang].has(word) ||
      word === 'it' ||
      word in SPEAKER_NOUNS[this.lang] ||
      mentions.some((m) => m.last === b && !m.possessive)
    ) {
      return true;
    }
    if (word in DETERMINERS[this.lang]) return false;
    // After a fronted phrase, a person right after the form who ends the clause.
    const inverted = subjectOf(ts, v, mentions, this.lang);
    const last = inverted?.kind === 'mention' ? inverted.mention.last : -1;
    if (last > v && (!ts[last + 1] || !!ts[last + 1]!.punctBefore)) return true;
    // A determiner and a word or two right before it that open the clause ("“Sit down,” the
    // teacher snaps.", "the old judge sighs").
    return [b - 1, b - 2].some(
      (d) => (d === 0 || !!ts[d]?.punctBefore) && nounSubject(ts, d, b, v, this.lang),
    );
  }

  /**
   * "I was asked", "I’m also told": said to the teller. No speech verb is an -ing form, so after
   * "was" or "I’m" it is always a passive.
   */
  private passiveToTeller(ts: Token[], v: number): boolean {
    if (this.lang !== 'en') return false;
    const b = subjectIndexBefore(ts, v, this.lang);
    const word = ts[b]?.text;
    if (word === 'I’m' || word === "I'm") return true;
    return (word === 'was' || word === 'were') && !ts[b]!.punctBefore && ts[b - 1]?.text === 'I';
  }

  /** "—me dijo", "asked me", "said to me", "I was asked": said to the teller, so not by them. */
  private saidToTeller(ts: Token[], v: number): boolean {
    if (verbAt(ts, v, this.lang)!.firstPerson) return false;
    if (this.lang === 'es') {
      const prev = ts[v]!.punctBefore ? undefined : ts[v - 1]?.text.toLowerCase();
      return prev === 'me' || prev === 'nos';
    }
    const next = ts[v + 1];
    const nextWord = next && !next.punctBefore ? next.text : undefined;
    const afterTo = nextWord === 'to' ? ts[v + 2]?.text : undefined;
    return nextWord === 'me' || afterTo === 'me' || this.passiveToTeller(ts, v);
  }

  /**
   * Whether the tag at verb `v` is someone else's: a he/she subject ("she asked", "she turned and
   * said"), "someone said", or, where the teller speaks, a Spanish third-person form ("—dijo";
   * "—decía" may also be "I"). Even unresolved, such a tag never goes to the teller.
   */
  private notTeller(ts: Token[], v: number, mentions: Mention[]): boolean {
    const subject = subjectOf(ts, v, mentions, this.lang);
    if (subject) return subject.kind === 'pronoun' && subject.gender !== 'narrator';
    const verb = verbAt(ts, v, this.lang)!;
    if (verb.firstPerson) return false;
    const start = lastSentenceStart(ts.slice(0, v + 1));
    const opening = coordinated(ts, v, start, this.lang)
      ? openingSubject(ts, start, mentions, this.lang)
      : null;
    if (opening) return opening.kind === 'pronoun' && opening.gender !== 'narrator';
    if (this.indefiniteSubject(ts, v)) return true;
    return this.lang === 'es' && this.tellerSpeaks && !verb.anyPerson;
  }

  /**
   * "someone said", "said somebody else", "Then someone turned and said", "—dijo alguien": the
   * verb at `v` has nobody in particular for its subject, so its line is the unknown speaker's.
   */
  private indefiniteSubject(ts: Token[], v: number): boolean {
    const word = (k: number) => ts[k]?.text.toLowerCase() ?? '';
    const glued = (k: number) => !!ts[k] && !ts[k]!.punctBefore;
    const indefinite = (k: number) => INDEFINITE_SUBJECTS[this.lang].has(word(k));
    // Before the verb, also with "else" after it ("someone else said", "alguien más dijo").
    const b = subjectIndexBefore(ts, v, this.lang);
    if (b !== -1 && this.indefiniteAt(ts, b)) return true;
    // Opening the clause it is coordinated with, after lead words ("Then someone"), with no other
    // subject between ("Someone knocked, and Tom went to the door and said" is Tom's). Someone
    // after such a verb is spoken to ("Tom turned and asked someone").
    const start = lastSentenceStart(ts.slice(0, v + 1));
    if (coordinated(ts, v, start, this.lang)) {
      let s = start;
      while (s < v && SENTENCE_LEADS[this.lang].has(word(s))) s++;
      return indefinite(s) && !otherSubjectBetween(ts, start, v, this.mentions(ts), this.lang);
    }
    // After it, past adverbs ("—dijo entonces alguien").
    let a = v + 1;
    while (glued(a) && AFTER_VERB_SKIP[this.lang].has(word(a))) a++;
    return glued(a) && indefinite(a);
  }

  /** Whether the subject ending at `b` is nobody in particular: "someone", "alguien más". */
  private indefiniteAt(ts: Token[], b: number): boolean {
    const indefinite = (k: number) =>
      INDEFINITE_SUBJECTS[this.lang].has(ts[k]?.text.toLowerCase() ?? '');
    return (
      indefinite(b) ||
      (ELSE.has(ts[b]?.text.toLowerCase() ?? '') && !ts[b]!.punctBefore && indefinite(b - 1))
    );
  }

  /**
   * The "he" or "she" the verb at `v` has for its subject, before or after it ("she said", "dijo
   * ella") or opening the clause it is coordinated with ("she turned and said", "But he shook his
   * head and said"), unless another subject comes between ("She came in, and Tom turned and
   * said").
   */
  private pronounSubject(ts: Token[], v: number, mentions: Mention[]): Gender | undefined {
    const start = lastSentenceStart(ts.slice(0, v + 1));
    const end = openingSubjectEnd(ts, start, mentions, this.lang);
    return heOrShe(
      subjectOf(ts, v, mentions, this.lang) ??
        (coordinated(ts, v, start, this.lang) &&
        !otherSubjectBetween(ts, end, v, mentions, this.lang)
          ? openingSubject(ts, start, mentions, this.lang)
          : null),
    );
  }

  /**
   * Whether the tag at verb `v` has the teller's "I" for its subject: "I said", "—respondí", "I
   * turned to her and said". It reads the subject as tagIn does, without resolving anyone.
   * A sentence-opening "I" is not taken across another subject ("I suppose she sighed and said",
   * "I think Mrs. Bennet turned and said"), nor after the teller's "I suppose" or "I must", where
   * the subject may be one no mention shows (see authorialTeller), nor for a Spanish form that
   * cannot be "yo" ("Yo creo que ella se volvió y le dijo").
   */
  private firstPersonTag(ts: Token[], v: number): boolean {
    const mentions = this.mentions(ts);
    const subject = subjectOf(ts, v, mentions, this.lang);
    if (subject) return isTeller(subject);
    const verb = verbAt(ts, v, this.lang)!;
    if (verb.firstPerson) return true;
    if (this.lang === 'es' && !verb.anyPerson) return false;
    const start = lastSentenceStart(ts.slice(0, v + 1));
    return (
      coordinated(ts, v, start, this.lang) &&
      isTeller(openingSubject(ts, start, mentions, this.lang)) &&
      !authorialTeller(ts, start, v, this.lang) &&
      !otherSubjectBetween(ts, start, v, mentions, this.lang)
    );
  }

  /**
   * "“It’s late.” She told me that every night, Tom thought.": a tag inside someone else's
   * thought, whose "I" and "me" are theirs, not the teller's.
   */
  private inOthersThought(ts: Token[], v: number): boolean {
    const mentions = this.mentions(ts);
    for (let w = v + 1; w < ts.length && !ts[w]!.sentenceStart; w++) {
      if (!verbAt(ts, w, this.lang)?.thought) continue;
      const subject = subjectOf(ts, w, mentions, this.lang);
      if (!subject || isTeller(subject)) continue;
      // The thought tag is a clause of its own: ", Tom thought.", ", thought he,".
      let first = w;
      let last = w;
      const b = subjectIndexBefore(ts, w, this.lang);
      if (subject.kind === 'mention') {
        if (subject.mention.last < w) first = subject.mention.first;
        else last = subject.mention.last;
      } else if (b !== -1 && isPronoun(ts[b]!.text, this.lang)) first = b;
      else last = w + 1;
      const after = ts[last + 1];
      if (ts[first]!.punctBefore === ',' && (!after || !!after.punctBefore)) return true;
    }
    return false;
  }

  private subjectKey(tokens: Token[], verbIndex: number, mentions: Mention[]): Who | undefined {
    const subject = subjectOf(tokens, verbIndex, mentions, this.lang);
    const I: Who = { key: this.narratorKey, teller: true };
    if (!subject) {
      if (verbAt(tokens, verbIndex, this.lang)?.firstPerson) return I;
      // "Then someone said:"
      return this.indefiniteSubject(tokens, verbIndex) ? someone(this.unknownKey) : undefined;
    }
    if (subject.kind === 'mention') return someone(this.resolve(subject.mention, true));
    if (subject.gender !== 'narrator') return someone(this.byGender(subject.gender, new Set()));
    return this.passiveToTeller(tokens, verbIndex) ? undefined : I;
  }

  /**
   * The most recent character of a gender, never the teller ("he"/"she" is not "I"). `named`:
   * people named earlier in the paragraph, who come first. A reply is not by the person it
   * answers; a continuation ("he added") is by the last speaker.
   */
  private byGender(
    gender: Gender,
    exclude: ReadonlySet<string>,
    verb?: VerbInfo,
    named: string[] = [],
  ): string | undefined {
    const recent = [
      ...named,
      ...this.recentParticipants().filter((k) => !named.includes(k)),
    ].filter((k) => this.entry(k).role === 'character' && !exclude.has(k));
    const matches = recent.filter((k) => this.entry(k).gender === gender);
    if (matches.length > 0) {
      return verb?.reply && matches[0] === this.lastSpeaker && matches[1] ? matches[1] : matches[0];
    }
    // Someone with no known gender: not the last speaker, unless the verb continues their turn.
    const ungendered = recent.filter((k) => !this.entry(k).gender);
    const last = this.lastSpeaker;
    const pick =
      verb?.continues && last && ungendered.includes(last)
        ? last
        : (ungendered.find((k) => k !== last) ?? ungendered[0]);
    // Learn the gender only when the guess had no rival.
    if (pick && ungendered.length === 1) {
      this.entry(pick).gender = gender;
      this.guessed.add(pick);
    }
    return pick;
  }

  /**
   * Characters with a known gender other than `gender`, who never say a "he" or "she" line:
   * byGender never picks them, and nothing else may when it finds nobody. A gender byGender only
   * guessed is not known ("Tom walked in. / “Cold?” she asked." may be someone else's line).
   */
  private otherGender(gender: Gender): string[] {
    return this.entries
      .filter(
        (e) =>
          e.role === 'character' &&
          e.gender !== undefined &&
          e.gender !== gender &&
          !this.guessed.has(e.key),
      )
      .map((e) => e.key);
  }

  private alternate(exclude: ReadonlySet<string>): string {
    if (this.narrationGap > 1 || !this.lastSpeaker) {
      // A line an unknown voice said to someone, right before, is answered by them: "—¿Cómo te
      // llamas? —me preguntó. / —Inés."
      if (this.tellerSpeaks && this.narrationGap === 0) {
        const answer = this.addressed.find((k) => !exclude.has(k));
        if (answer) return answer;
      }
      const [entrant, ...rest] = this.entrants;
      return entrant && rest.length === 0 && !exclude.has(entrant) ? entrant : this.unknownKey;
    }
    const last = this.lastSpeaker;
    const others = this.recentParticipants().filter((k) => k !== last);
    let ranked = others;
    if (this.tellerSpeaks) {
      // A first-person conversation is between people who talk, the teller included: people
      // the narration just brought in and people the last line was said to come first, then
      // people who have spoken in this scene, then the teller, then earlier speakers; people
      // only mentioned come last.
      const first = [
        ...others.filter((k) => this.entrants.includes(k)),
        ...this.addressed.filter((k) => k !== last && !this.entrants.includes(k)),
      ];
      const speakers = others
        .filter((k) => this.spoke.has(k) && !first.includes(k))
        .sort((a, b) => this.spoke.get(b)! - this.spoke.get(a)!);
      const ahead = [...first, ...speakers.filter((k) => this.spoke.get(k)! >= this.sceneStart)];
      if (last !== this.narratorKey && !ahead.includes(this.narratorKey)) {
        ahead.push(this.narratorKey);
      }
      ahead.push(...speakers.filter((k) => !ahead.includes(k)));
      ranked = [...ahead, ...others.filter((k) => !ahead.includes(k))];
    }
    const natural = ranked[0];
    if (natural && !exclude.has(natural)) return natural;
    // The person a line is said to never says it: the last speaker goes on, or someone else.
    if (natural && !exclude.has(last)) return last;
    return ranked.find((k) => !exclude.has(k)) ?? this.unknownKey;
  }

  private recentParticipants(): string[] {
    return [...this.lastActive.entries()]
      .filter(([k]) => this.entry(k).role !== 'unknown')
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  }

  /** "Tom shrugged. “Nowhere.”": the subject of the narration sentence right before line `n`. */
  private beatBefore(
    units: Unit[],
    n: number,
    tokens: Map<Unit, Token[]>,
    isVoiced: (u: Unit) => boolean,
  ): Who | undefined {
    const before = units[n - 1];
    if (!before || isVoiced(before)) return undefined;
    const ts = tokens.get(before)!;
    return this.beatSubject(ts.slice(lastSentenceStart(ts)));
  }

  /** "—Hola —Ana sonrió—. ¿Qué tal?": narration between two lines names their speaker. */
  private incisoAfter(
    units: Unit[],
    n: number,
    tokens: Map<Unit, Token[]>,
    isVoiced: (u: Unit) => boolean,
  ): Who | undefined {
    const after = units[n + 1];
    const next = units[n + 2];
    if (!after || isVoiced(after) || !next || !isVoiced(next)) return undefined;
    const ts = tokens.get(after)!;
    return this.beatSubject(ts.slice(0, firstSentenceEnd(ts)));
  }

  /** The subject of a beat sentence with no speech verb that names nobody else. */
  private beatSubject(sentence: Token[]): Who | undefined {
    if (sentence.some((_, k) => this.isVerb(sentence, k))) return undefined;
    const mentions = this.mentions(sentence);
    // A beat never introduces a name ("—Dejó los cubos…" is a verb, not a person).
    const subject = this.sentenceSubject(sentence, 0, mentions, true);
    if (!subject) return undefined;
    const leading = (m: Mention) =>
      sentence.slice(0, m.first).every((t) => SENTENCE_LEADS[this.lang].has(t.text.toLowerCase()));
    return mentions.some((m) => !leading(m)) ? undefined : subject;
  }

  /**
   * For units asked about in paragraph order, by index: the characters named before each one in
   * the paragraph (narration, earlier lines' vocatives), latest first. It keeps a running list, so
   * a long paragraph is read once, and reads no further than the last unit asked about.
   */
  private namesSoFar(
    units: Unit[],
    tokens: Map<Unit, Token[]>,
    vocatives: Map<Unit, string[]>,
  ): (n: number) => string[] {
    const named: string[] = [];
    let next = 0;
    return (n) => {
      for (; next < n; next++) {
        const x = units[next]!;
        const ts = tokens.get(x)!;
        const keys =
          vocatives.get(x) ??
          this.castKeys(
            this.mentions(ts).filter(
              (m) => m.kind === 'name' && !this.afterPreposition(ts, m) && !this.speakerOnly(m),
            ),
          );
        // Someone named again moves to the front.
        for (const key of keys) {
          const seen = named.indexOf(key);
          if (seen !== -1) named.splice(seen, 1);
          named.unshift(key);
        }
      }
      return [...named];
    };
  }

  /**
   * `addressed`: names line `n` addresses ("Sit down, Anne.", "—Siéntate, Ana —dijo Tomás.", "Dear
   * Tom"), also with words of endearment or the rest of a full name after them ("Come here, Anne
   * dear.", "—Adiós, Ana preciosa —dijo Tomás.", "—Ven aquí, María de los Ángeles —dijo Nela."),
   * and the first of a list ("—Venid, Ana y Pablo —dijo Nela."). Before an inciso a name is
   * addressed only when the line ends with it; when words follow, the line talks about the person
   * ("—Oye, Ana dice que vengas —dijo Nela.", "—Sí, Ana tiene razón —dijo ella."), and a list a
   * sacred name opens is an exclamation ("—¡Jesús, María y José! —exclamó Nela."). `named`: the
   * people addressed or talked about, who do not say the line.
   */
  private vocativeMentions(
    units: Unit[],
    n: number,
    tokens: Token[],
  ): { addressed: Mention[]; named: Mention[] } {
    const text = this.slice(units[n]!);
    const nextUnit = units[n + 1];
    const beforeInciso = !!nextUnit && /^\s*[—―–]/u.test(this.slice(nextUnit));
    const glued = (k: number) => !!tokens[k] && !tokens[k]!.punctBefore;
    const word = (k: number) => tokens[k]?.text.toLowerCase() ?? '';
    const capital = (k: number) => glued(k) && !LOWER.test(tokens[k]!.text);
    const mentions = this.mentions(tokens);
    const addressed: Mention[] = [];
    const named: Mention[] = [];
    const { after, family, invocations } = SACRED_WORDS[this.lang];
    // Where a list of the Holy Family after "¡Jesús," ends: its other names are no calls.
    let listEnd = -1;
    for (const [i, m] of mentions.entries()) {
      if (m.kind !== 'name' || m.first <= listEnd) continue;
      const lead = tokens[m.first - 1];
      // The word before the name, which may open an exclamation ("¡Jesús, María!").
      const k = m.first - 1;
      const before: Mention | undefined =
        mentions[i - 1]?.last === k
          ? mentions[i - 1]
          : tokens[k] && { kind: 'name', name: tokens[k]!.text, first: k, last: k };
      const afterSacred =
        !!before && tokens[m.first]!.punctBefore === ',' && this.speakerOnly(before);
      // The rest of a full name ("María de los Ángeles"), words of endearment ("Ana de mi alma"),
      // the other people of a list ("Ana y Pablo"), and the Holy Family after "¡Jesús," with
      // commas ("¡Jesús, María, José y todos los santos!").
      let end = m.last;
      const listed = [m.name];
      for (;;) {
        const holy =
          afterSacred &&
          tokens[end + 1]?.punctBefore === ',' &&
          listed.every((x) => family.has(x)) &&
          mentions.find((x) => x.first === end + 1 && x.kind === 'name' && family.has(x.name));
        if (holy) {
          end = holy.last;
          listed.push(holy.name);
          continue;
        }
        if (!glued(end + 1)) break;
        const article = NAME_ARTICLES[this.lang].has(word(end + 2)) && glued(end + 2) ? 1 : 0;
        const other = mentions.find((x) => x.first === end + 2 && x.kind === 'name');
        if (NAME_PARTICLES[this.lang].has(word(end + 1)) && capital(end + 2 + article)) {
          end += 2 + article;
          while (capital(end + 1)) end++;
        } else if (ENDEARMENTS[this.lang].has(word(end + 1))) end++;
        else if (COORDINATORS[this.lang].has(word(end + 1)) && other && glued(end + 2)) {
          end = other.last;
          listed.push(other.name);
        } else break;
      }
      if (afterSacred && listed.length > 1) listEnd = end;
      const rest = (tokens[end + 1]?.punctBefore ?? text.slice(tokens[end]!.end)).trim();
      const opened =
        /[,“"«¡]/u.test(tokens[m.first]!.punctBefore) ||
        (lead !== undefined && VOCATIVE_LEAD.has(lead.text.toLowerCase()));
      if (m.first !== 0 && !opened) continue;
      const beforeIt = opened && rest === '' && beforeInciso;
      // After "¡Jesús," the Holy Family, an invocation, and a list or a sacred word nobody in the
      // cast has are an exclamation: "¡Jesús, María y José!", "¡Jesús, María, José y todos los
      // santos!", "¡Jesús, María Santísima!", "¡Jesús, Madre Santa!", "¡Jesús, Santa Bárbara!",
      // "¡Jesús, Madre de Dios!", "¡Jesús, Madre mía!", and "¡Jesús, María!" alone, also with a
      // María in the cast. Someone in the cast is still called: "¡Jesús, Ana, qué susto!"
      const words = m.name.split(' ');
      const tail = tokens.slice(m.last + 1, end + 1).map((t) => t.text);
      const unknown = !matchCast(m.name, this.entries);
      const invocation =
        (words.length > 1 &&
          (invocations.has(words[0]!) ||
            words.slice(1).some((w) => after.has(w) || invocations.has(w)))) ||
        (unknown &&
          (tail.includes('Dios') ||
            (words[0] === 'Madre' &&
              tail.length > 0 &&
              tail.every((w) => ENDEARMENTS[this.lang].has(w.toLowerCase())))));
      const exclaims =
        afterSacred &&
        (invocation ||
          (listed.length > 1 && listed.every((n) => family.has(n))) ||
          (unknown && (listed.length > 1 || after.has(m.name))) ||
          (listed.length === 1 && m.name === 'María' && rest.startsWith('!')));
      if (
        !exclaims &&
        (/^[,!?”"»]/u.test(rest) ||
          (opened && /^[.;:…]/u.test(rest)) ||
          (beforeIt && tokens[end + 1] === undefined))
      ) {
        addressed.push(m);
        named.push(m);
      } else if (beforeIt || exclaims) named.push(m);
    }
    return { addressed, named };
  }

  /** The keys of the people these mentions name who are in the cast or found in the part. */
  private castKeys(mentions: Mention[]): string[] {
    return mentions
      .map((m) => matchCast(m.name, this.entries)?.key)
      .filter((k): k is string => k !== undefined);
  }

  private touchVocatives(addressed: Mention[], speaker: string): void {
    for (const m of addressed) {
      // In a first-person part, an unknown name said to someone is often the teller's own: it
      // must not become a second voice that could take the teller's lines.
      if (this.tellerSpeaks && !matchCast(m.name, this.entries)) continue;
      // "¡Ay, Jesús!": an interjection, unless someone of that name is known.
      if (this.speakerOnly(m)) continue;
      const key = this.resolve(m);
      if (key !== speaker) this.touch(key);
    }
  }

  private mentions(tokens: Token[]): Mention[] {
    // The same tokens are read for many verbs; the mentions change only with the cast.
    const cached = this.mentionCache.get(tokens);
    if (cached?.version === this.castVersion) return cached.mentions;
    const mentions = findMentions(tokens, this.lang, (name) => !!matchCast(name, this.entries));
    this.mentionCache.set(tokens, { version: this.castVersion, mentions });
    return mentions;
  }

  /**
   * "Jesús", "Jesús de Nazaret" with nobody of that name in the cast or speaking yet: only a
   * speaker position makes it a person. A tag's addressee ("—le dijo a Jesús") is kept, but until
   * he speaks a line that calls on him ("¡Ay, Jesús!") or a sentence that names him makes him no
   * participant. A speaker noun makes him someone ("su tío Jesús"), but not the child ("el niño
   * Jesús").
   */
  private speakerOnly(m: Mention): boolean {
    if (m.kind !== 'name' || !sacredName(m.name, this.lang)) return false;
    if (m.noun !== undefined && !SACRED_WORDS[this.lang].nouns.has(m.noun)) return false;
    const entry = matchCast(m.name, this.entries);
    return !entry || (entry.key.startsWith('new:') && !this.spoke.has(entry.key));
  }

  /**
   * Finds or creates the character a mention refers to. `learn`: the mention names a speaker (a
   * tag or colon-intro subject), so a new name for an existing character is kept as an alias;
   * the narrator and the unknown speaker never get aliases from here.
   */
  private resolve(m: Mention, learn = false): string {
    const existing = matchCast(m.name, this.entries);
    if (existing) {
      if (existing.role !== 'character') return existing.key;
      if (m.gender && !existing.gender) existing.gender = m.gender;
      const known = [existing.name, ...existing.aliases].some(
        (n) => n.toLowerCase() === m.name.toLowerCase(),
      );
      if (!known && learn) {
        existing.aliases.push(m.name);
        this.castVersion++;
        if (!existing.key.startsWith('new:')) {
          this.aliasAdditions.push({ characterId: existing.key, alias: m.name });
        }
      }
      return existing.key;
    }
    const entry: CastEntry = {
      key: `new:${++this.newCount}`,
      name: m.name,
      aliases: [],
      gender: m.gender,
      role: 'character',
    };
    this.entries.push(entry);
    this.castVersion++;
    return entry.key;
  }

  private touch(key: string): void {
    this.lastActive.set(key, ++this.clock);
  }

  private entry(key: string): CastEntry {
    return this.entries.find((e) => e.key === key)!;
  }

  private slice(u: Unit): string {
    return this.text.slice(u.start, u.end);
  }

  private label(u: Unit, key: string, mode: Mode, tone?: Tone, teller?: boolean): SpanLabel {
    const speaker: SpeakerRef = key.startsWith('new:')
      ? { kind: 'new', ref: key }
      : { kind: 'cast', id: key };
    return {
      start: u.start,
      end: u.end,
      speaker,
      mode,
      ...(tone ? { tone } : {}),
      source: 'heuristic',
      ...(teller && key === this.narratorKey ? { teller: true as const } : {}),
    };
  }

  /**
   * Whether some speech in this part is tagged by the teller ("I said", "said I", "—respondí", "I
   * ask.", "I turned to her and said:") or said to them ("—me dijo", "asked me", "I was asked").
   * Reads the verbs the tagger reads, never creating characters, so a sentence next to a line
   * whose tag names someone else is none ("I said nothing. “Eat,” Mom said."), and neither is an
   * aside about what someone says ("Mrs. Bennet was nervous, as my aunt told me.").
   */
  private findTellerTag(): boolean {
    const tellerTag = (ts: Token[], v: number) =>
      v !== -1 &&
      (this.firstPersonTag(ts, v) || this.saidToTeller(ts, v)) &&
      !this.inOthersThought(ts, v) &&
      !this.inAside(ts, v);
    // A colon intro in its own paragraph introduces the lines of the next one.
    let intro: { ts: Token[]; v: number } | undefined;
    for (const units of groupByParagraph(this.input.units)) {
      // Plain narration has no lines, so only its colon intro is read.
      const read = units.some((u) => u.kind !== 'narration') ? this.read(units, false) : undefined;
      if (!read || !units.some(read.isVoiced)) {
        const last = units.at(-1)!;
        const ts = this.slice(last).trimEnd().endsWith(':')
          ? (read?.tokens.get(last) ?? tokenize(this.slice(last), this.lang))
          : undefined;
        intro = ts && { ts, v: this.beforeVerb(last, ts) };
        continue;
      }
      if (intro && tellerTag(intro.ts, intro.v)) return true;
      intro = undefined;
      const { tokens, isVoiced } = read;
      // Each line's tag, from the narration after it or before it as the tagger chooses.
      for (const [n, u] of units.entries()) {
        if (!isVoiced(u)) continue;
        const tag = this.nearTag(
          units,
          n,
          tokens,
          isVoiced,
          (ts, v) => (v === -1 ? undefined : { ts, v }),
          (at) => !!at && this.names(at.ts, at.v),
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
  private names(ts: Token[], v: number): boolean {
    const mentions = this.mentions(ts);
    const subject = subjectOf(ts, v, mentions, this.lang);
    if (isTeller(subject) || (!subject && verbAt(ts, v, this.lang)!.firstPerson)) {
      return !this.saidToTeller(ts, v);
    }
    if (subject) return true;
    const start = lastSentenceStart(ts.slice(0, v + 1));
    return coordinated(ts, v, start, this.lang) && !!openingSubject(ts, start, mentions, this.lang);
  }

  /** "as my aunt told me", "como nos dice el refrán": the clause of the verb at `v` is an aside. */
  private inAside(ts: Token[], v: number): boolean {
    let c = v;
    while (c > 0 && !ts[c]!.punctBefore && !ts[c]!.sentenceStart) c--;
    return ASIDES[this.lang].some((words) =>
      words.every((w, k) => {
        const t = ts[c + k];
        return t !== undefined && t.text.toLowerCase() === w && (k === 0 || !t.punctBefore);
      }),
    );
  }
}

function groupByParagraph(units: readonly Unit[]): Unit[][] {
  const groups: Unit[][] = [];
  for (const u of units) {
    const group = groups.at(-1);
    if (group && group[0]!.paragraph === u.paragraph) group.push(u);
    else groups.push([u]);
  }
  return groups;
}

/**
 * Whether the English aside after the join at `join` (before the verb at `v`) opens with an
 * indefinite or "you" that is the subject of the verb right after it: "and no one expected it,",
 * "and none of us expected it,", "and everyone was surprised,", "and you will hardly believe it,";
 * not "and everyone else," or "and everyone who was there,".
 */
function remarkSubject(ts: Token[], join: number, v: number): boolean {
  const w = (k: number) => ts[k]?.text.toLowerCase() ?? '';
  const opener = w(join + 1);
  let j: number;
  if (opener === 'no' && w(join + 2) === 'one') j = join + 3;
  else if (
    ['none', 'everyone', 'everybody', 'someone', 'somebody', 'anyone', 'anybody', 'you'].includes(
      opener,
    )
  ) {
    j = join + 2;
  } else return false;
  if (w(j) === 'of' && ['us', 'them', 'you'].includes(w(j + 1))) j += 2;
  while (j < v && ['ever', 'never', 'hardly', 'really', 'even', 'scarcely'].includes(w(j))) j++;
  const t = ts[j];
  if (!t || j >= v || t.punctBefore || !LOWER.test(t.text)) return false;
  return (
    finiteShape(w(j), true) ||
    AUXILIARIES.has(w(j)) ||
    ['can', 'cannot', 'may', 'might', 'must'].includes(w(j))
  );
}

/**
 * Where the subject that opens the sentence at `start` ends, after a lead word or two ("Then Mr.
 * Darcy", "But he"), or `start` when none does: past it another clause's subject begins.
 */
function openingSubjectEnd(ts: Token[], start: number, mentions: Mention[], lang: Lang): number {
  // Past a time phrase that opens the sentence, as in openingSubject.
  const shifted = timeOpensSentence(ts, lang).find(
    (e) => e > start && e < start + 6 && lastSentenceStart(ts.slice(0, e + 1)) === start,
  );
  const from = start;
  if (shifted !== undefined) start = shifted;
  for (let i = start; i < Math.min(ts.length, start + 3); i++) {
    const t = ts[i]!;
    if (i > start && (t.sentenceStart || t.punctBefore)) return from;
    if (isPronoun(t.text, lang)) return i;
    const m = mentions.find((x) => x.first === i && !x.possessive);
    if (m) return m.last;
    if (!SENTENCE_LEADS[lang].has(t.text.toLowerCase())) return from;
  }
  return from;
}

/**
 * The subject that opens the sentence starting at `start`, after a lead word or two ("Then Anne",
 * "Entonces la anciana"). Spanish "Me encogí de hombros." is the teller's "I".
 */
function openingSubject(
  ts: Token[],
  start: number,
  mentions: Mention[],
  lang: Lang,
): Subject | null {
  // Past a time phrase that opens the sentence: "The next morning she knocked and said:".
  const shifted = timeOpensSentence(ts, lang).find(
    (e) => e > start && e < start + 6 && lastSentenceStart(ts.slice(0, e + 1)) === start,
  );
  if (shifted !== undefined) start = shifted;
  for (let i = start; i < Math.min(ts.length, start + 3); i++) {
    const t = ts[i]!;
    if (i > start && (t.sentenceStart || t.punctBefore)) return null;
    const pronoun = isPronoun(t.text, lang);
    if (pronoun) return { kind: 'pronoun', gender: pronoun };
    const m = mentions.find((x) => x.first === i && !x.possessive);
    if (m) return { kind: 'mention', mention: m };
    // Spanish pro-drop: "Me encogí de hombros."
    const verb = ts[i + 1];
    if (lang === 'es' && i === start && t.text.toLowerCase() === 'me' && verb) {
      if (/[éí]$/u.test(verb.text)) return { kind: 'pronoun', gender: 'narrator' };
    }
    if (!SENTENCE_LEADS[lang].has(t.text.toLowerCase())) return null;
  }
  return null;
}

/**
 * Where the verb after the subject that ends at `end` is, before the join at `join`, or -1: past
 * adverbs and clitics ("and Anne only sighed", "and Anne too smiled", "y Nela se levantó", "y él la
 * abrazó"), a lower-case word that is not an article, a preposition, a gerund or a word such as
 * "beside" or "included" ("Anne at his side", "her mother still watching us", "Jane included").
 * A set phrase may come first ("Anne at last looked up", "Lucía por fin apoya"), and so may a
 * phrase with the verb a few words after it ("the old man by the fire looked up", "Nela con mucha
 * calma dobló"; see verbAfterPhrase, which takes any tense when the stretch is `open`). After a
 * name or a descriptor (`named`), in a stretch that runs to a comma before the join, an English
 * verb has a verb's shape (see finiteShape: "Anne smiled", "Anne cast a glance", not "Anne still
 * pale" or "Anne opposite").
 */
function verbAfterSubject(
  ts: Token[],
  end: number,
  join: number,
  lang: Lang,
  named = false,
  open = false,
  present = true,
  clause = false,
): number {
  const word = (k: number) => ts[k]!.text.toLowerCase();
  const glued = (k: number) => k < join && !!ts[k] && !ts[k]!.punctBefore;
  const skip = (k: number) => {
    while (
      glued(k) &&
      (/^\p{Ll}+ly$/u.test(ts[k]!.text) ||
        BEFORE_VERB_SKIP[lang].has(word(k)) ||
        CLITICS[lang].has(word(k)) ||
        SUBJECT_ADVERBS[lang].has(word(k)) ||
        // "and Anne once more smiled", "and Anne all but ran"
        (lang === 'en' && word(k) === 'more' && word(k - 1) === 'once') ||
        (lang === 'en' && word(k) === 'all' && word(k + 1) === 'but' && glued(k + 1)) ||
        (lang === 'en' && word(k) === 'but' && word(k - 1) === 'all' && k - 1 > end))
    ) {
      k++;
    }
    return k;
  };
  let k = skip(end + 1);
  if (!glued(k) || !LOWER.test(ts[k]!.text)) return -1;
  if (glued(k + 1) && BEFORE_VERB_PAIRS[lang].has(`${word(k)} ${word(k + 1)}`)) {
    k = skip(k + 2);
    if (!glued(k) || !LOWER.test(ts[k]!.text)) return -1;
  } else if (lang === 'en' && opensPhrase(word(k))) {
    // After a subject pronoun, which is never an object, an open stretch has its verb whatever its
    // shape ("and I without a word give him the letter and say").
    const after = verbAfterPhrase(ts, k, join, lang, open, present);
    return after === -1 && open && !named ? k : after;
  }
  const w = word(k);
  // The shape test is for a stretch that runs to a comma before the join ("Anne still pale, and
  // said"); before a join with no comma the stretch has its verb ("and Anne herself opened the
  // door and said", "and Anne almost cried and said").
  if (lang === 'en' && named && !!ts[join]!.punctBefore) {
    if (endsObject(ts, k, lang) || PHRASE_AFTER_PERSON.en.has(w)) return -1;
    // After an auxiliary any word goes on with the verb ("Anne could not believe it").
    const auxiliary = ts.slice(end + 1, k).some((t) => AUXILIARIES.has(t.text.toLowerCase()));
    // A past that is also a participle takes its object when it is a verb ("Anne cast a glance",
    // "Anne bound up the wound", "Anne spoilt everything"; not "Tom bound hand and foot", "Anne
    // spoilt and sulky"), and is no verb before a phrase of its own ("Anne bound for London,",
    // "Anne cast in shadow,", "Anne wound up in her shawl,"; but "Anne ground to a halt,", "Anne
    // wound through the crowd,", "Anne knit in silence,", "Anne cast off,").
    const object = (j: number) =>
      word(j) in DETERMINERS.en ||
      /^\p{Lu}/u.test(ts[j]!.text) ||
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
        (/^(?:he|she|they|i|we|it|you)$/u.test(word(j + 1)) ||
          /^\p{Lu}/u.test(ts[j + 1]!.text) ||
          word(j + 1) in DETERMINERS.en);
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
        (NON_PARTICIPANT_PREPOSITIONS.en.has(word(k + 2)) ||
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
    return auxiliary || finiteShape(w, true) || nounLike || verbAt(ts, k, lang) ? k : -1;
  }
  if (endsObject(ts, k, lang) || PREPOSITIONS[lang].has(w) || PHRASE_AFTER_PERSON[lang].has(w)) {
    return lang === 'es' && !PHRASE_AFTER_PERSON.es.has(w)
      ? verbAfterPhrase(ts, k, join, lang, open)
      : -1;
  }
  // "y Nela muy despacio dobla la carta y dice:": "muy" or "tan" opens a phrase as a preposition
  // does, before a verb in any tense when the stretch is open.
  if (lang === 'es' && (w === 'muy' || w === 'tan')) {
    return verbAfterPhrase(ts, k, join, lang, open);
  }
  return (lang === 'en' ? /\p{L}ing$/u : /\p{L}(?:ando|iendo)$/u).test(w) ? -1 : k;
}

/** An English word that opens a phrase before a verb: an article, a preposition, an -ing word. */
function opensPhrase(w: string): boolean {
  return (
    w in DETERMINERS.en ||
    NON_PARTICIPANT_PREPOSITIONS.en.has(w) ||
    PHRASE_AFTER_PERSON.en.has(w) ||
    /\p{L}ing$/u.test(w)
  );
}

/**
 * The shape of an English finite verb: "smiled", "rose", "was", "can", "didn't", and with
 * `present` "laughs"; not "pale", "opposite", "tears" or "twenty-two".
 */
function finiteShape(w: string, present: boolean): boolean {
  if (w.includes('-')) return false;
  if (/^\p{Ll}{2,}ed$/u.test(w) || FINITE_FORMS.has(w) || /^\p{Ll}+n['’]t$/u.test(w)) return true;
  return present && /^\p{Ll}{2,}s$/u.test(w) && !/(?:ss|us|is|as)$/u.test(w);
}

/** A Spanish past form: "suspiró", "rompió", "miraba", "sonreían", "dio", "hizo". */
function spanishPast(text: string): boolean {
  const w = text.normalize('NFC').toLowerCase();
  return /\p{L}(?:ó|aba|aban|ían|aron|ieron)$/u.test(w) || STRONG_PRETERITES.has(w);
}

/**
 * The verb after the phrase that opens at `k`, right after a subject, within a few words, or -1.
 * English: an -ed word or another past form, or an -s form after "him", "them", "me" or "us",
 * within five words, unless it ends the stretch ("the old man by the fire looked up", "Anne a
 * moment later looked up", "Anne behind him laughs"; not "Anne with her arms folded,", "Anne in
 * tears", "his wife of twenty years", "Anne with Will beside her,"). Spanish, after a preposition,
 * "del" or "al", "una vez" or "otra vez", or "muy" or "tan", within four words: a clitic and the
 * verb after it, or a past form ("la madre de Pablo se encogió", "la mujer del panadero abrió",
 * "Nela por fin levantó", "Nela con mucha calma dobló", "Nela una vez más se lo pidió"; not "Nela
 * tras él,", "un niño de seis años,", "Nela muy seria a su lado,"). Right after "and" or "y" with no
 * comma before the join (`open`) the verb may be in any tense ("and Arthur without a word gathers
 * up his notes and says", "y Nela con mucha calma dobla la carta y dice:").
 */
function verbAfterPhrase(
  ts: Token[],
  k: number,
  join: number,
  lang: Lang,
  open = false,
  present = true,
): number {
  const word = (j: number) => ts[j]?.text.toLowerCase() ?? '';
  const glued = (j: number) => j < join && !!ts[j] && !ts[j]!.punctBefore;
  if (lang === 'en') {
    // In an open stretch an -s form after an article or a count is a noun of the phrase ("and
    // Anne with two kisses on each cheek and said"), and so is an -ed word between an article and
    // its noun ("on her flushed cheeks", "under the painted ceiling").
    const noun = (j: number) =>
      // "her" is a possessive after a preposition that opens the phrase right after the
      // subject ("and Anne for her gifts and says", "and Anne on her cheeks and says"), not after
      // one inside it ("and Anne with a smile for her nods and says").
      (word(j) in DETERMINERS.en &&
        (word(j) !== 'her' ||
          (j - 1 === k && ['for', 'on', 'in', 'into', 'onto', 'from'].includes(word(j - 1))))) ||
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
      ].includes(word(j));
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
      if (BEFORE_VERB_SKIP.en.has(word(n)) && !AUXILIARIES.has(word(n))) continue;
      if (
        open &&
        word(n - 1) in DETERMINERS.en &&
        /\p{Ll}ed$/u.test(word(n)) &&
        glued(n + 1) &&
        LOWER.test(ts[n + 1]!.text) &&
        !particles.includes(word(n + 1))
      ) {
        continue;
      }
      // A past such as "cast" that is also a noun, in a stretch with no comma before the join and
      // not after an article ("the old man by the fire cast a glance at him and said"; not "Anne
      // with a wound on her arm," or "Anne with her eyes cast down,").
      const nounLike =
        NOUN_LIKE_PASTS.has(word(n)) && !ts[join]!.punctBefore && !(word(n - 1) in DETERMINERS.en);
      const shaped =
        AUXILIARIES.has(word(n)) ||
        finiteShape(word(n), false) ||
        nounLike ||
        (finiteShape(word(n), true) &&
          ((open && present && !noun(n - 1)) || ['him', 'them', 'me', 'us'].includes(word(n - 1))));
      if (shaped) return glued(n + 1) || (n + 1 === join && !ts[join]!.punctBefore) ? n : -1;
    }
    return -1;
  }
  const w = word(k);
  const opens =
    PREPOSITIONS.es.has(w) ||
    w === 'del' ||
    w === 'al' ||
    w === 'muy' ||
    w === 'tan' ||
    ((w === 'una' || w === 'otra') && word(k + 1) === 'vez' && glued(k + 1));
  if (!opens) return -1;
  for (let j = k + 1; j < join && j <= k + 4; j++) {
    // A relative or another clause ends the phrase: "un niño de seis años que lloraba".
    if (ts[j]!.punctBefore || CLAUSE_LEADS.es.has(word(j)) || RELATIVES.es.has(word(j))) return -1;
    if (['se', 'le', 'les', 'me', 'te', 'nos', 'os'].includes(word(j))) {
      let v = j;
      while (glued(v) && CLITICS.es.has(word(v))) v++;
      return glued(v) && LOWER.test(ts[v]!.text) ? v : -1;
    }
    if (spanishPast(ts[j]!.text)) return j;
    if (
      ['lo', 'la', 'los', 'las'].includes(word(j)) &&
      glued(j + 1) &&
      spanishPast(ts[j + 1]!.text)
    ) {
      return j + 1;
    }
  }
  // Right after "y" with no comma before the join, the phrase comes before a verb in any tense.
  return open ? k : -1;
}

/**
 * Where the teller's hedge that opens the stretch at `from` ends, before `end`: its verb ("I
 * think", "I really believe"), or the "that" after it ("I suppose that"), or -1.
 */
function hedgeEnd(ts: Token[], from: number, end: number, lang: Lang): number {
  const word = (k: number) => ts[k]?.text.toLowerCase() ?? '';
  let k = from;
  while (k < end && isPronoun(ts[k]!.text, lang) !== 'narrator') k++;
  for (k++; k < end && !ts[k]!.punctBefore; k++) {
    if (toldAt(ts, k + 1)) continue;
    if (AUTHORIAL_VERBS.has(word(k)) || toldAt(ts, k)) {
      return word(k + 1) === 'that' && !ts[k + 1]!.punctBefore ? k + 1 : k;
    }
    if (!AUTHORIAL_SKIP.has(word(k))) return -1;
  }
  return -1;
}

/** "I was told", "I am told": the "told" of a passive at `k`, the teller's hearsay. */
function toldAt(ts: Token[], k: number): boolean {
  return (
    ts[k]?.text.toLowerCase() === 'told' &&
    !ts[k]!.punctBefore &&
    /^(?:was|am|were)$/u.test(ts[k - 1]?.text.toLowerCase() ?? '')
  );
}

/**
 * Whether someone else's subject comes right after "that", "as" or "while" between `start` and
 * `end`: "I noticed that Anne looked away", "I watched as Anne put down her cup". An English
 * "that" counts only after a verb of perceiving, not after a noun or "knew" ("the coat that Anne
 * had given me", "I knew that Tom was right").
 */
function perceived(ts: Token[], start: number, end: number, mentions: Mention[], lang: Lang) {
  const leads = new Set(['that', 'as', 'while', 'que', 'mientras']);
  for (let i = start + 1; i < end; i++) {
    const lead = ts[i - 1]!.text.toLowerCase();
    if (ts[i]!.punctBefore || !leads.has(lead)) continue;
    if (lang === 'en' && lead === 'that' && !PERCEIVING.has(ts[i - 2]?.text.toLowerCase() ?? '')) {
      continue;
    }
    if (OTHER_SUBJECTS[lang].has(ts[i]!.text.toLowerCase())) return true;
    if (mentions.some((m) => m.first === i && !m.possessive)) return true;
  }
  return false;
}

/** "I turned to her and said": the verb at `v` shares the subject of the clause before "and". */
function coordinated(ts: Token[], v: number, start: number, lang: Lang): boolean {
  return joinAt(ts, v, start, lang) !== -1;
}

/**
 * "“Sit down,” the teacher snaps.", "“You’re late,” my boss tells me.", "The judge bangs his gavel
 * and shouts,": a determiner at `d` and the words after it to `end`, which open their clause (see
 * the callers), as the subject of the -s form at `v`, which ends its clause, maybe after an object
 * ("me", "to me", "him") or an adverb ("quietly"). "I heard the loud cries.", "The loud cries woke her." and "the cries of the gulls"
 * stay nouns, and so does a continuation, which is never the last speaker's when someone else is
 * its subject ("The music resumes.", "the conductor continues").
 */
function nounSubject(ts: Token[], d: number, end: number, v: number, lang: Lang): boolean {
  const glued = (k: number) => !!ts[k] && !ts[k]!.punctBefore;
  const word = (k: number) => ts[k]?.text.toLowerCase() ?? '';
  if (d < 0 || !(word(d) in DETERMINERS[lang])) return false;
  for (let k = d + 1; k <= end; k++) {
    if (!glued(k) || !LOWER.test(ts[k]!.text) || word(k) in DETERMINERS[lang]) return false;
  }
  if (verbAt(ts, v, lang)?.continues) return false;
  const object = (k: number) => BARE_OBJECTS.has(word(k)) || word(k) === 'me';
  let e = v + 1;
  if ((word(e) === 'at' || word(e) === 'to') && glued(e) && object(e + 1)) e++;
  if (glued(e) && object(e)) e++;
  if (glued(e) && /^\p{Ll}+ly$/u.test(ts[e]!.text)) e++;
  return !glued(e);
}

/**
 * Where the word is that joins the verb at `v` to the clause before it, past clitics and adverbs
 * ("I turned to her and said", "Ana se volvió y le dijo", "she nodded and then whispered", "Tom
 * nodded, then said"), or opens a short aside between commas right before it ("Nela miró a Pablo,
 * y después de un rato, dijo", "Tom turned to Anne, and in a low voice, said"), or -1.
 */
function joinAt(ts: Token[], v: number, start: number, lang: Lang): number {
  const word = (k: number) => ts[k]!.text.toLowerCase();
  let b = v - 1;
  while (
    b > start &&
    !ts[b + 1]!.punctBefore &&
    (CLITICS[lang].has(word(b)) ||
      BEFORE_VERB_SKIP[lang].has(word(b)) ||
      (lang === 'en' && /^\p{Ll}+ly$/u.test(ts[b]!.text)))
  ) {
    b--;
  }
  if (b > start && !ts[b + 1]!.punctBefore && COORDINATORS[lang].has(word(b))) return b;
  // ", then said": "then" after a comma joins the clause like "and".
  const then = b + 1;
  if (
    lang === 'en' &&
    then > start &&
    then < v &&
    word(then) === 'then' &&
    ts[then]!.punctBefore === ','
  ) {
    return then;
  }
  if (ts[v]!.punctBefore !== ',') return -1;
  let k = v - 1;
  while (k > start && v - k < ASIDE_WINDOW && !ts[k]!.punctBefore) k--;
  return k > start && ts[k]!.punctBefore === ',' && COORDINATORS[lang].has(word(k)) ? k : -1;
}

/**
 * Whether the word after the speech verb at `i` is an adverb, not what was said: "so" before an
 * -ly word and a clause "that" opens ("I said so quietly that he leaned in", not "Tom had said so
 * early that morning" or "so early that very morning"), "nada" with no "no" before the verb in its
 * clause ("respondí nada convencida", "—dijo nada más entrar", "—dije nada más."), "algo" before
 * the speaker's state ("dije algo nervioso", "contestó algo molesta"). "said so", "No dije nada",
 * "Apenas dijo nada en toda la tarde", "Ninguno dijo nada más", "dijo algo extraño" report.
 */
function tagAdverb(ts: Token[], i: number, lang: Lang): boolean {
  const word = (k: number) => ts[k]?.text.toLowerCase() ?? '';
  const glued = (k: number) => !!ts[k] && !ts[k]!.punctBefore;
  if (!glued(i + 1) || !glued(i + 2)) return false;
  const object = word(i + 1);
  if (lang === 'en') {
    // "that very morning", "that same day": a noun of time after "very" or "same".
    const time = (k: number): boolean =>
      ['very', 'same'].includes(word(k))
        ? glued(k + 1) && time(k + 1)
        : TIME_AFTER_THAT.has(word(k));
    return (
      object === 'so' &&
      /^\p{Ll}+ly$/u.test(ts[i + 2]!.text) &&
      word(i + 3) === 'that' &&
      glued(i + 3) &&
      glued(i + 4) &&
      glued(i + 5) &&
      !time(i + 4)
    );
  }
  if (object === 'nada') {
    // "nada más" is what was said, unless an infinitive or a participle follows ("dijo nada más
    // llegar", "nada más dármelo", "nada más terminada la cena") or it ends the sentence with no
    // "no" before it ("—Gracias —dije nada más.").
    const infinitive =
      /^\p{Ll}+(?:ar|er|ir|ár|ér|ír)(?:me|te|se|lo|la|le|nos|os|los|las|les){0,2}$/u;
    const participle = /^\p{Ll}+(?:ad|id)[oa]s?$/u;
    const denied = (k: number) => NEGATIONS.es.has(word(k)) || NADA_NEGATIONS.has(word(k));
    const adverb =
      glued(i + 3) && (infinitive.test(ts[i + 3]!.text) || participle.test(ts[i + 3]!.text));
    const from = lastSentenceStart(ts.slice(0, i + 1));
    const closing = !glued(i + 3) && !ts.slice(from, i).some((_, k) => denied(from + k));
    if (word(i + 2) === 'más' && !adverb && !closing) return false;
    for (let k = i - 1; k >= 0 && k >= i - 6; k--) {
      if (NEGATIONS.es.has(word(k)) || NADA_NEGATIONS.has(word(k))) return false;
      if (ts[k]!.punctBefore) break;
    }
    return true;
  }
  return object === 'algo' && SPEAKER_STATE.test(word(i + 2));
}

/**
 * "I suppose she sighed and said", "I daresay Mrs. Bennet turned and said", "Yo creo que se volvía
 * y le decía": another clause's subject between the sentence's opening subject (from `start`) and
 * the verb at `v`. A name or descriptor is one unless a preposition comes before it or it ends as
 * an object (see endsObject): "I turned to Anne and said", "I hugged Anne and said". English "he",
 * "she" and "they" are too, though after a word such as "for" only in a clause that runs on into
 * the verb ("I paused, for she sighed and said", not "I went to him, for he had called me, and
 * said"), like a relative after a comma ("I went back to Mrs. Bennet, who sighed and said").
 */
function otherSubjectBetween(
  ts: Token[],
  start: number,
  v: number,
  mentions: Mention[],
  lang: Lang,
): boolean {
  const runsIntoVerb = (i: number) => ts.slice(i + 1, v + 1).every((t) => !t.punctBefore);
  for (let i = start + 1; i < v; i++) {
    const word = ts[i]!.text.toLowerCase();
    const prev = ts[i]!.punctBefore ? '' : ts[i - 1]!.text.toLowerCase();
    // Spanish drops the subject, so the clause "que" opens may have one of its own. "si", and a
    // word after "como", open one only before a person who shows ("si la cocinera suspiraba",
    // "si ella suspiraba"), not before a thing or a verb ("si la sopa estaba lista", "como si la
    // viera", "a ver si llovía", "por si acaso", "como si nada"). So "como cuando" with no subject
    // is the teller's ("Yo me reía como cuando era niña y le decía"), but a reflexive "se" before
    // a past form is someone else's ("Yo la recuerdo como cuando se volvía y le decía"), unless
    // another clitic follows it ("como que se me olvidaba", "como cuando se lo contaba a mi
    // madre"); before a present form it is nobody's ("como cuando se reza en misa").
    if (lang === 'es' && CLAUSE_LEADS.es.has(word)) {
      const next = ts[i + 1];
      // "la Nela": the name after the article.
      const named = (m: Mention) =>
        m.first === i + 1 ||
        (m.first === i + 2 && m.kind === 'name' && (next?.text === 'el' || next?.text === 'la'));
      const shows =
        !!next &&
        !next.punctBefore &&
        (SUBJECT_STARTS[lang].has(next.text.toLowerCase()) || mentions.some(named));
      const clitic = ts[i + 2] && !ts[i + 2]!.punctBefore && CLITICS.es.has(ts[i + 2]!.text);
      const past = /(?:aban?|ían?|ó)$/u.test((ts[i + 2]?.text ?? '').normalize('NFC'));
      const se = !!next && !next.punctBefore && next.text.toLowerCase() === 'se' && !clitic && past;
      if ((word !== 'si' && prev !== 'como') || shows || (word !== 'si' && se)) return true;
    }
    const relative = RELATIVES[lang].has(word) || (lang === 'en' && word === 'which');
    if (relative && ts[i]!.punctBefore === ',' && runsIntoVerb(i)) return true;
    const object =
      NON_PARTICIPANT_PREPOSITIONS[lang].has(prev) || ADDRESSEE_MARKERS[lang].has(prev);
    // Spanish "a ella", "con él" are objects; English "for she", "till he" open a clause.
    if (OTHER_SUBJECTS[lang].has(word) && (!object || (lang === 'en' && runsIntoVerb(i)))) {
      return true;
    }
    const m = mentions.find((x) => x.first === i && !x.possessive);
    if (!m || object) continue;
    if (CLAUSE_LEADS[lang].has(prev) || !endsObject(ts, m.last + 1, lang)) return true;
  }
  return false;
}

/**
 * "I suppose the cook sighed and said", "But I must now return to …", "I’m bound to say …": the
 * teller's "I" takes a clause or a modal (see AUTHORIAL_VERBS) and the verb at `v` is past, so the
 * clause's subject says it, whoever it is. That "I" is the last one before the verb that is not in
 * an aside between commas or in a clause such as "when" opens ("I think I sighed, and said" is
 * the teller's, and so is "I laughed, I think, and said"; "I think, when I was young, the cook
 * sighed and said" is not). A present "say" is the teller's own ("I feel my face go hot and say",
 * "I would kiss her cheek and say"), and so is a past modal ("I must have blushed and said", "I
 * must not have heard him, and said"), or "would" before anything but a verb of saying ("I would
 * not look at him and said", but not "I would add that the cook…"). "I’m" is "I am" and "I’ll" is
 * "I will"; "I’d" may be "I had", so the word after it decides.
 */
function authorialTeller(ts: Token[], start: number, v: number, lang: Lang): boolean {
  if (lang !== 'en' || ts[v]!.text.toLowerCase() === 'say') return false;
  const word = (k: number) => ts[k]?.text.toLowerCase().replace(/’/gu, "'") ?? '';
  const runs = (k: number) => ts.slice(k + 1, v + 1).every((t) => !t.punctBefore);
  const governs = (k: number) =>
    k === start || runs(k) || (!ts[k]!.punctBefore && !SUBORDINATORS.has(word(k - 1)));
  // "…, I thought, and said": the aside's own past verb is the one "and said" joins.
  const aside = (k: number) => {
    if (ts[k]!.punctBefore !== ',' || AUTHORIAL_VERBS.has(word(k + 1))) return false;
    let e = k + 1;
    while (e < v && !ts[e]!.punctBefore) e++;
    return (
      e < v &&
      ts[e]!.punctBefore === ',' &&
      word(e) === 'and' &&
      ts.slice(e + 1, v + 1).every((t) => !t.punctBefore)
    );
  };
  const i = findLastIndex(
    ts,
    (t, k) =>
      k >= start && k < v && isPronoun(t.text, lang) === 'narrator' && (governs(k) || aside(k)),
  );
  if (i === -1) return false;
  const contraction = ts[i]!.text.replace(/’/gu, "'");
  if (contraction === "I'm" || contraction === "I'll") return true;
  if (contraction === "I've") return false;
  for (let k = i + 1; k < v && !ts[k]!.punctBefore; k++) {
    if (toldAt(ts, k + 1)) continue;
    if (AUTHORIAL_VERBS.has(word(k)) || toldAt(ts, k)) {
      let n = k + 1;
      while (n < v && !ts[n]!.punctBefore && AUTHORIAL_SKIP.has(word(n))) n++;
      if (word(n) === 'have' && !ts[n]!.punctBefore) return false;
      return (word(k) !== 'would' && word(k) !== "wouldn't") || SAYING_VERBS.has(word(n));
    }
    if (!AUTHORIAL_SKIP.has(word(k)) && !/^\p{Ll}+ly$/u.test(ts[k]!.text)) return false;
  }
  return false;
}

/**
 * Whether the teller's nickname at `m` ends its clause after a short phrase that qualifies it:
 * "the old man of the lighthouse.", "the girl with the red hair—", "la niña de la casa,", "la niña
 * del pueblo". A name ends such a phrase, so a verb after it goes on from the person ("la abuela de
 * Pablo quería verme"), and so does one after a word or two ("my uncle with his coat on was").
 */
function qualifiedNickname(ts: Token[], m: Mention, lang: Lang): boolean {
  const glued = (k: number) => !!ts[k] && !ts[k]!.punctBefore;
  const ends = (k: number) => !glued(k) || CLAUSE_OPENERS.has(ts[k]!.text);
  let k = m.last + 1;
  if (!glued(k) || !NICKNAME_QUALIFIERS[lang].has(ts[k]!.text.toLowerCase())) return false;
  k++;
  if (glued(k) && !LOWER.test(ts[k]!.text)) {
    while (glued(k) && !LOWER.test(ts[k]!.text)) k++;
    return ends(k);
  }
  if (glued(k) && ts[k]!.text.toLowerCase() in DETERMINERS[lang]) k++;
  for (let n = 0; n < 2 && glued(k); n++) if (ends(++k)) return true;
  return false;
}

/**
 * Whether a name or descriptor ending before `k` is an object: the clause ends after it, or an
 * article or a preposition follows ("I hugged Anne and said", "I gave Tom the letter", "I led Anne
 * into the house"). Any other word is read as its own verb ("Mrs. Bennet turned").
 */
function endsObject(ts: Token[], k: number, lang: Lang): boolean {
  while (lang === 'en' && ts[k] && !ts[k]!.punctBefore && /^\p{Ll}+ly$/u.test(ts[k]!.text)) k++;
  const next = ts[k];
  if (!next) return true;
  const word = next.text.toLowerCase();
  if (COORDINATORS[lang].has(word)) return true;
  return (
    !next.punctBefore &&
    (word in DETERMINERS[lang] ||
      NON_PARTICIPANT_PREPOSITIONS[lang].has(word) ||
      ADDRESSEE_MARKERS[lang].has(word))
  );
}

/**
 * "Jesús", "Niño Jesús", "Jesús María", "Jesús de Nazaret", "Corazón de Jesús": a speaker-only
 * name, alone or in a sacred name (see SACRED_WORDS). "Jesús Pérez", "María Jesús", "Jesús María
 * Pérez" and "María Jesús del Valle" are not.
 */
function sacredName(name: string, lang: Lang): boolean {
  const words = name.normalize('NFC').split(' ');
  const { before, after, family, places } = SACRED_WORDS[lang];
  const last = words.length - 1;
  const particle = (k: number) => NAME_PARTICLES[lang].has(words[k] ?? '');
  return words.some(
    (w, k) =>
      SPEAKER_ONLY_NAMES[lang].has(w) &&
      (last === 0 ||
        before.has(words[k - 1] ?? '') ||
        // A sacred word after it, wherever it stands ("Jesús Nazareno de Medinaceli", "Cofradía
        // de Jesús Nazareno"). "María" only at the start of the name or after a place, with
        // nothing but sacred words or "José" after it ("Jesús María", "¡Jesús María José!",
        // "Colegio Jesús María", never "Jesús María Pérez", "don Jesús María" or "Fray Jesús
        // María").
        (after.has(words[k + 1] ?? '') &&
          (words[k + 1] !== 'María' ||
            ((k === 0 || words.slice(0, k).some((x) => places.has(x))) &&
              words.slice(k + 2).every((x) => after.has(x) || family.has(x))))) ||
        // Opening the name with "de" right after it ("Jesús de Nazaret", "Jesús del Gran Poder"),
        // after "de" at its end ("Corazón de Jesús"), or with "de" on both sides inside a longer
        // one ("la Cofradía de Jesús de Nazaret").
        (k === 0 && particle(1)) ||
        (k === last && particle(k - 1)) ||
        (particle(k - 1) && particle(k + 1))),
  );
}

/** A speaker found by a name, a pronoun or turn-taking: not chosen by the teller's "I". */
function someone(key: string | undefined): Who | undefined {
  return key === undefined ? undefined : { key, teller: false };
}

/** The teller's "I", "yo", or Spanish "Me" before a first-person verb. */
function isTeller(subject: Subject | null): boolean {
  return subject?.kind === 'pronoun' && subject.gender === 'narrator';
}

/** The gender of a "he" or "she" subject ("él", "ella"). */
function heOrShe(subject: Subject | null): Gender | undefined {
  return subject?.kind === 'pronoun' && subject.gender !== 'narrator' ? subject.gender : undefined;
}

/**
 * Where one of `phrases` starts as words with nothing but spaces between them. `clauseEnd`: only
 * at the end of a clause ("Tom left.", never "Tom left the bread").
 */
function phrasesAt(ts: Token[], phrases: string[][], clauseEnd = false): number[] {
  const words = ts.map((t) => t.text.toLowerCase());
  return words.flatMap((word, i) =>
    phrases.some((phrase) => {
      const next = ts[i + phrase.length];
      return (
        phrase[0] === word &&
        phrase.every((w, k) => k === 0 || (words[i + k] === w && !ts[i + k]!.punctBefore)) &&
        (!clauseEnd || !next || !!next.punctBefore)
      );
    })
      ? [i]
      : [],
  );
}

/** Where the first scene cue in a run of tokens starts (see timePasses, someoneLeaves), or -1. */
function sceneCue(ts: Token[], mentions: Mention[], lang: Lang): number {
  const cues = [timePasses(ts, lang), someoneLeaves(ts, mentions, lang)].filter((i) => i !== -1);
  return cues.length > 0 ? Math.min(...cues) : -1;
}

/**
 * Whether the person at `m` opens their clause, after lead words or "and" ("Then Anne came in",
 * "Suddenly Anne came in", "and Anne came in", "De repente entró Ana"), or right after the verb
 * that opens it in Spanish ("Entonces entró Ana"): they come in themselves, rather than being only
 * named ("I had not seen Anne", "I hoped Anne would come", "Sabía que Ana vendría", "and Anne had
 * promised to come"). After an entry lead such as "suddenly" or "finally" they come in only with a
 * verb of coming or of being there ("Suddenly Anne was there"; not "Suddenly Anne stopped
 * writing", "Finally Anne agreed to come").
 */
function opensClause(ts: Token[], m: Mention, lang: Lang): boolean {
  const next = ts[m.last + 1];
  if (next && !next.punctBefore && OFFSTAGE_AUXILIARIES[lang].has(next.text.toLowerCase())) {
    return false;
  }
  const word = (k: number) => ts[k]?.text.toLowerCase() ?? '';
  const coming = (k: number) =>
    ARRIVALS[lang].has(word(k)) ||
    ENTERING[lang].has(word(k)) ||
    (BEING_THERE[lang].has(word(k)) && THERE[lang].has(word(k + 1)));
  let after = m.last + 1;
  while (ts[after] && !ts[after]!.punctBefore && /^\p{Ll}+ly$/u.test(ts[after]!.text)) after++;
  // "Then Anne agreed to come. She arrived that evening.": a plan to come, not coming in, when a
  // later sentence of the paragraph tells of the arrival (not "Then Anne came to show me her
  // shawl. Later she told me she had knitted it.", "Then Anne happened to come in."). A plan with
  // no arrival after it here may still be one (see the `plan` of newcomers).
  let later = m.last + 1;
  while (later < ts.length && !ts[later]!.sentenceStart) later++;
  // A plan that ends its clause ("Then Anne agreed to come.") takes any later sentence with a verb
  // of arriving after a pronoun or a name. Other shapes may be someone there already ("Then Anne
  // came to show me her shawl."), so the arrival has to be the person's own, a "he", "she" or their
  // name before the verb (not "Later she told me Tom returned it", "Tom came over to look", "I came
  // to love it"), and no becoming ("Later she came to love the place").
  const clear = clearPlan(ts, m, lang);
  const arrivesLater = ts.slice(later).some((t, i) => {
    const k = later + i;
    const before = ts[k - 1]?.text ?? '';
    const pronoun = isPronoun(before, lang);
    if (i === 0 || t.punctBefore || !ARRIVALS[lang].has(t.text.toLowerCase())) return false;
    if (clear) return pronoun !== undefined || /^\p{Lu}/u.test(before);
    const self = pronoun === 'male' || pronoun === 'female' || before === ts[m.last]!.text;
    return self && !becomes(ts, k);
  });
  if (arrivesLater && plansToCome(ts, m, lang)) return false;
  const comesIn =
    (!!ts[after] && !ts[after]!.punctBefore && coming(after)) ||
    (lang === 'es' && m.first > 0 && !ts[m.first]!.punctBefore && coming(m.first - 1));
  const opens = (k: number) => {
    for (; k > 0 && !ts[k]!.punctBefore && !ts[k]!.sentenceStart; k--) {
      const lead = ts[k - 1]!.text.toLowerCase();
      if (COORDINATORS[lang].has(lead)) return true;
      // "De repente": "de" before an entry word.
      const entry =
        ENTRY_LEADS[lang].has(lead) ||
        (lead === 'de' && ENTRY_LEADS[lang].has(ts[k]!.text.toLowerCase()));
      if (!SENTENCE_LEADS[lang].has(lead) && !(entry && comesIn)) return false;
    }
    return true;
  };
  if (opens(m.first)) return true;
  const verb = ts[m.first - 1];
  return (
    lang === 'es' &&
    !!verb &&
    !ts[m.first]!.punctBefore &&
    LOWER.test(verb.text) &&
    !(verb.text in DETERMINERS.es) &&
    !PREPOSITIONS.es.has(verb.text) &&
    opens(m.first - 1)
  );
}

/** "She came to love the place", "came to understand": becoming, not arriving. */
function becomes(ts: Token[], v: number): boolean {
  const word = (k: number) => (ts[k] && !ts[k]!.punctBefore ? ts[k]!.text.toLowerCase() : '');
  return (
    word(v) === 'came' &&
    word(v + 1) === 'to' &&
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
    ].includes(word(v + 2))
  );
}

/**
 * "Then Anne agreed to come", "At last Anne promised to come": the person at `m` has a verb with
 * "to" and a verb of arriving after it, which may be a plan to come (see opensClause).
 */
function plansToCome(ts: Token[], m: Mention, lang: Lang): boolean {
  const word = (k: number) => ts[k]?.text.toLowerCase() ?? '';
  const glued = (k: number) => !!ts[k] && !ts[k]!.punctBefore;
  let after = m.last + 1;
  while (ts[after] && !ts[after]!.punctBefore && /^\p{Ll}+ly$/u.test(ts[after]!.text)) after++;
  return (
    lang === 'en' &&
    glued(after) &&
    glued(after + 1) &&
    glued(after + 2) &&
    word(after + 1) === 'to' &&
    ARRIVING.has(word(after + 2))
  );
}

/**
 * "Then Anne agreed to come.", "At last Anne agreed to come over.", "Then Anne agreed to show up.":
 * a plan to come that ends its clause, which a later arrival in the stretch makes the arrival (see
 * the `plan` of newcomers). Not someone there already: "Then Anne happened to come in.", "Then
 * Anne came to show me her shawl.", "Then Anne seemed to appear from nowhere.".
 */
function clearPlan(ts: Token[], m: Mention, lang: Lang): boolean {
  if (!plansToCome(ts, m, lang)) return false;
  const word = (k: number) => (ts[k] && !ts[k]!.punctBefore ? ts[k]!.text.toLowerCase() : '');
  let after = m.last + 1;
  while (ts[after] && !ts[after]!.punctBefore && /^\p{Ll}+ly$/u.test(ts[after]!.text)) after++;
  let end = after + 3;
  if (['show', 'turn'].includes(word(after + 2))) {
    if (word(end) !== 'up') return false;
    end++;
  } else if (['over', 'back', 'home', 'round', 'again'].includes(word(end))) {
    end++;
  }
  return !ts[end] || !!ts[end]!.punctBefore;
}

/**
 * "Then Anne came to see me that evening.", "Then Anne came to see me, hours later.", "Entonces
 * vino Ana a verme por la tarde.", "I went to see Anne the next day.": time passes later in the
 * clause that names the person at `m`, with no pronoun, other person or word that starts another
 * clause in between. When they `came` in themselves, a comma may come between, and an aside
 * between commas ("Then Anne, who had heard the news, came to see me that evening."); when they
 * are only named, nothing may ("I remembered Anne, waiting on the platform that night."). Not
 * "with the bread for the next day" (a preposition before it), "as she always did in the
 * evening" or "came in, still in the coat she had worn that night". "Then Anne and her mother
 * came…" and "I did not see Anne until the next day" count, but not someone who has spoken coming
 * with them ("Then Anne and Tom came in together that evening"), nor a wait that is their own
 * ("Anne did not leave her bed until that evening", unlike "Anne did not come down until…").
 */
function timeInClause(
  ts: Token[],
  m: Mention,
  came: boolean,
  mentions: Mention[],
  lang: Lang,
  spoken: (x: Mention) => boolean = () => false,
): boolean {
  const t = timePasses(ts, lang);
  if (t <= m.last) return false;
  // "I did not see Anne until the next day", "No vi a Ana hasta esa noche": a wait that ends
  // then, with a "not" before the person or before a verb of arriving, and no "had" ("Anne had
  // been in bed until that evening" ends no scene), so "until" is a preposition before the time,
  // not another clause.
  const from = lastSentenceStart(ts.slice(0, t + 1));
  const sentence = ts.slice(from, t);
  const negated = (x: Token) =>
    NEGATIONS[lang].has(x.text.toLowerCase()) || /n['’]t$/u.test(x.text);
  const n = sentence.findIndex(negated);
  let a = from + n + 1;
  const lower = (k: number) => ts[k]?.text.toLowerCase() ?? '';
  while (
    a < t &&
    (CLITICS[lang].has(lower(a)) || ['not', 'even', 'actually', 'siquiera'].includes(lower(a)))
  ) {
    a++;
  }
  // Being back or seen again ends a wait as coming does: "Anne was not back until", "Anne didn't
  // get home until", "Anne didn't make it back until", "Anne didn't make it here until", "Anne
  // didn't make it to the house until" (not "to the top of the hill"), "Ana no bajó hasta", "A Ana
  // no la vi hasta", "Ana no se dejó ver hasta".
  const madeIt =
    lower(a) === 'make' &&
    lower(a + 1) === 'it' &&
    (['back', 'home', 'here', 'there', 'over'].includes(lower(a + 2)) ||
      (lower(a + 2) === 'to' && ![a + 4, a + 5].some((k) => lower(k) === 'of')));
  const back =
    lang === 'en'
      ? ['home', 'back'].includes(lower(a)) ||
        (lower(a) === 'get' && ['back', 'home', 'there', 'in'].includes(lower(a + 1))) ||
        madeIt
      : ['bajó', 'vi'].includes(lower(a)) || (lower(a) === 'dejó' && lower(a + 1) === 'ver');
  const arrival = ARRIVALS[lang].has(lower(a)) || (lang === 'en' && ARRIVING.has(lower(a))) || back;
  const waits =
    n !== -1 &&
    (from + n < m.first || arrival) &&
    // A name is no auxiliary ("I did not see May until", "Will did not come back until"), nor is
    // "could" right before the negation ("Anne could not make it back until", as "couldn't").
    !sentence.some(
      (x, j) =>
        OFFSTAGE_AUXILIARIES[lang].has(x.text.toLowerCase()) &&
        !nameAt(ts, from + j, mentions) &&
        !(x.text.toLowerCase() === 'could' && j + 1 === n),
    );
  // "Anne had been crying all that evening": a time before the scene, not one it moves to (but
  // "Anne had arrived that evening", "Anne had come back that evening" bring her in).
  const aux = ts[m.last + 1];
  const participle = lower(m.last + 2);
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
    ].includes(lower(toward)) &&
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
    (toward + 1 === timePhraseStart(ts, toward, t, lang) ||
      ['from', 'with'].includes(lower(toward + 1)));
  const arriving =
    ARRIVALS[lang].has(participle) ||
    ARRIVING.has(participle) ||
    ['got', 'gotten', 'turned', 'shown', 'made'].includes(participle) ||
    moved;
  if (!waits && aux && !aux.punctBefore && aux.text === 'had' && !arriving) return false;
  const untilTime = (k: number) =>
    waits &&
    UNTIL[lang].has(ts[k]!.text.toLowerCase()) &&
    // "until the next day", "until an hour later"
    (k + 1 === t || k + 1 === timePhraseStart(ts, k, t, lang));
  const stops = (k: number) => {
    const word = ts[k]!.text.toLowerCase();
    if (untilTime(k)) return false;
    // "Anne and her mother came": the person joined to them, not another clause's subject.
    if (
      k === m.last + 1 &&
      COORDINATORS[lang].has(word) &&
      mentions.some((x) => x.first === k + 1 && !spoken(x))
    ) {
      return false;
    }
    return (
      mentions.some((x) => x.first === k) ||
      isPronoun(ts[k]!.text, lang) !== undefined ||
      OTHER_SUBJECTS[lang].has(word) ||
      CLAUSE_LEADS[lang].has(word) ||
      RELATIVES[lang].has(word) ||
      COORDINATORS[lang].has(word) ||
      (lang === 'en' && QUESTION_LEADS.has(word))
    );
  };
  for (let k = m.last + 1; k < t; k++) {
    if (k === m.last + 2 && COORDINATORS[lang].has(ts[k - 1]!.text.toLowerCase())) {
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
  let p = t - 1;
  if ((ts[p]?.text.toLowerCase() ?? '') in DETERMINERS[lang]) p--;
  const before = ts[p]?.text.toLowerCase() ?? '';
  return (
    (before === 'in' ||
      (waits && UNTIL[lang].has(before)) ||
      !NON_PARTICIPANT_PREPOSITIONS[lang].has(before)) &&
    !ADDRESSEE_MARKERS[lang].has(before)
  );
}

/**
 * Where the subject would be after each time shift that opens a sentence: "In the evening she came
 * to see me.", "The next day Anne came.", "A few days later she came.", "Hours later, she
 * came.", "Por la tarde vino a verme." After three lead words, not when what follows looks ahead
 * ("A few weeks later she would be married", "Unas pocas semanas más tarde se casaría").
 */
function timeOpensSentence(ts: Token[], lang: Lang): number[] {
  return timeShifts(ts, lang).flatMap((i) => {
    let s = i;
    while (s > 0 && i - s < 3 && !ts[s]!.punctBefore && !ts[s]!.sentenceStart) s--;
    if (s !== 0 && !ts[s]!.sentenceStart) return [];
    // A third word before it only counts the time: "A few days later", not "I found out later".
    const counts = ts.slice(s, i).every((t) => TIME_COUNTS[lang].has(t.text.toLowerCase()));
    if (i - s === 3 && !counts) return [];
    const phrase = TIME_SHIFTS[lang].find((p) =>
      p.every((w, k) => ts[i + k]?.text.toLowerCase() === w),
    )!;
    const e = i + phrase.length;
    const punct = ts[e]?.punctBefore;
    if (i - s === 3) {
      const after = ts.slice(e, e + 3).filter((t, k) => k === 0 || !t.punctBefore);
      // A name is no auxiliary or conditional ("A few weeks later May knocked", "Unas pocas
      // semanas más tarde María llamó").
      const offstage = (t: Token) =>
        LOWER.test(t.text) &&
        (OFFSTAGE_AUXILIARIES[lang].has(t.text.toLowerCase()) ||
          (lang === 'es' && /r(?:ía|ías|íamos|íais|ían)$/u.test(t.text.toLowerCase())));
      if (after.some(offstage)) return [];
    }
    return punct === undefined || (punct !== '' && punct !== ',') ? [] : [e];
  });
}

/**
 * The subjects of sentences in which time passes later in the subject's own clause, with no other
 * clause, comma or preposition such as "for" before it: "She arrived that evening.", "Anne came
 * to see me in the evening.", "Llegó esa noche." (Spanish leaves the subject out). Each is the
 * subject's index, its mention, whether it was left out and where its verb is. Only someone
 * arriving counts (see ARRIVALS and arrives): not "She used to wait in the evening", "She was
 * leaving the next day", "Hacía frío esa noche" or "Llegó la tormenta esa noche", nor "She came
 * with the bread for the next day", a habit ("She usually came in the evening"), a question ("¿Vino
 * a cenar al día siguiente?"), another clause's time ("She came to tell me what had happened that
 * night") or someone else's report ("She came that evening, Tom said, because…").
 */
function timeLaterInSentence(
  ts: Token[],
  mentions: Mention[],
  lang: Lang,
  spoken: (x: Mention) => boolean = () => false,
): { e: number; named: Mention | undefined; dropped: boolean; v: number }[] {
  return timeShifts(ts, lang).flatMap((i) => {
    const s = lastSentenceStart(ts.slice(0, i + 1));
    let e = s;
    if (ts[s]!.punctBefore.includes('¿')) return [];
    while (
      e < i &&
      SENTENCE_LEADS[lang].has(ts[e]!.text.toLowerCase()) &&
      (e === s || !ts[e]!.punctBefore)
    ) {
      e++;
    }
    if (e >= i) return [];
    const word = ts[e]!.text.toLowerCase();
    const pronoun = isPronoun(ts[e]!.text, lang);
    const named = mentions.find((m) => m.first === e && !m.possessive);
    const dropped =
      lang === 'es' &&
      !pronoun &&
      !named &&
      !(word in DETERMINERS.es) &&
      !PREPOSITIONS.es.has(word);
    if (!pronoun && !named && !dropped) return [];
    // The verb right after the subject, past -ly adverbs or Spanish clitics, is one of arriving.
    let v = named ? named.last + 1 : dropped ? e : e + 1;
    // "Then Anne herself came to see me that evening."
    const skips = (t: Token) =>
      /^\p{Ll}+ly$/u.test(t.text) ||
      (lang === 'es' && CLITICS.es.has(t.text.toLowerCase())) ||
      (lang === 'en' && ['herself', 'himself'].includes(t.text));
    while (v < i && (v === e || !ts[v]!.punctBefore) && skips(ts[v]!)) v++;
    const lower = (k: number) => ts[k]?.text.toLowerCase() ?? '';
    // A determiner right after a verb with its subject left out opens that subject ("Volvió la
    // tormenta esa noche"), unless it opens the time ("Volvió una hora más tarde").
    if (
      dropped &&
      v + 1 < i &&
      !ts[v + 1]!.punctBefore &&
      lower(v + 1) in DETERMINERS.es &&
      !['al', 'del'].includes(lower(v + 1)) &&
      !TIME_NOUNS.es.has(lower(v + 2)) &&
      !['horas', 'semanas', 'días', 'meses', 'años', 'par'].includes(lower(v + 2))
    ) {
      return [];
    }
    // A habit ("She usually came in the evening"), but "only" before one evening is not ("She
    // only came that evening", unlike "She only came in the evening").
    const habit = (t: Token) =>
      HABIT_ADVERBS.has(t.text.toLowerCase()) &&
      (t.text.toLowerCase() !== 'only' || lower(i) === 'in');
    if (ts.slice(e, v).some(habit)) return [];
    if (v >= i || (v > e && ts[v]!.punctBefore)) return [];
    if (!ARRIVALS[lang].has(ts[v]!.text.toLowerCase())) return [];
    if (!arrives(ts, v, i, lang)) return [];
    // "She came most days in the evening", "every week", "each time".
    const often = (k: number) =>
      ['most', 'every', 'each'].includes(lower(k)) &&
      /^(?:days?|nights?|evenings?|mornings?|afternoons?|weeks?|times?|other|sunday|week-?end)$/u.test(
        lower(k + 1),
      );
    for (let k = v + 1; k < i; k++) if (often(k)) return [];
    if (ts[i]!.punctBefore) return [];
    // Someone named between the verb and the time is another clause's, but not a companion who
    // has not spoken ("She came with her mother that evening") nor the place the narration put
    // someone in ("Me quedé en Sevilla… Llegó a Sevilla esa noche").
    const other = (k: number) =>
      mentions.some(
        (m) =>
          m.first === k &&
          (spoken(m) || !['with', 'con'].includes(lower(k - 1))) &&
          !(k === v + 2 && placeHere(ts, v)),
      );
    for (let k = v; k < i; k++) {
      const w = ts[k]!.text.toLowerCase();
      if (
        (k > e && ts[k]!.punctBefore) ||
        (CLAUSE_LEADS[lang].has(w) && !nameAt(ts, k, mentions)) ||
        RELATIVES[lang].has(w) ||
        COORDINATORS[lang].has(w) ||
        (k > v && other(k))
      ) {
        return [];
      }
    }
    // A question word or an auxiliary between them: "She came to ask what I wanted that
    // evening", "She would come the next day". Not "or" or "so", nor "how I was" right before the
    // time phrase ("She came round to see how I was that evening", "... the next morning").
    const time = timePhraseStart(ts, v, i, lang);
    const asks = (k: number) =>
      lang === 'en' &&
      QUESTION_LEADS.has(lower(k)) &&
      lower(k) !== 'or' &&
      lower(k) !== 'so' &&
      !(
        lower(k) === 'how' &&
        (!!isPronoun(ts[k + 1]?.text ?? '', lang) ||
          ['we', 'they', 'you'].includes(lower(k + 1))) &&
        ['was', 'were'].includes(lower(k + 2)) &&
        k + 3 === time
      );
    for (let k = v + 1; k < i; k++) {
      if (asks(k) || (OFFSTAGE_AUXILIARIES[lang].has(lower(k)) && !nameAt(ts, k, mentions))) {
        return [];
      }
    }
    let p = i - 1;
    if ((ts[p]?.text.toLowerCase() ?? '') in DETERMINERS[lang]) p--;
    const before = ts[p]?.text.toLowerCase() ?? '';
    if (
      (before !== 'in' && NON_PARTICIPANT_PREPOSITIONS[lang].has(before)) ||
      ADDRESSEE_MARKERS[lang].has(before)
    ) {
      return [];
    }
    if (reportedAfter(ts, i, lang)) return [];
    return [{ e, named, dropped, v }];
  });
}

/**
 * Where the time phrase whose shift word is at `i` starts, past its own article, count or unit
 * ("the next morning", "an hour later", "una hora más tarde"), leaving a word after the verb at `v`.
 */
function timePhraseStart(ts: Token[], v: number, i: number, lang: Lang): number {
  const unit =
    /^(?:half|couple|of|or|so|hours?|days?|weeks?|months?|years?|nights?|minutes?|una|un|semanas?|horas?)$/u;
  let stop = i;
  while (stop > v + 1 && !ts[stop]!.punctBefore) {
    const w = ts[stop - 1]!.text.toLowerCase();
    if (!(w in DETERMINERS[lang]) && !TIME_COUNTS[lang].has(w) && !unit.test(w)) break;
    stop--;
  }
  return stop;
}

/**
 * Whether the verb of arriving at `v` (before the time at `i`) is used as one: "She appeared at the
 * gate", "knocked twice", "called on me", "Volvió a casa", "Llamó a la puerta", "Volvió a
 * recogerlas", not "She appeared tired", "appeared in better spirits", "knocked the ash", "showed
 * no sign", "called her mother", "returned the book", "came to a decision", "Volvió a llover",
 * "Llegó a pensar", "Volvió en sí", "Volvió a Madrid", "Regresó a su pueblo" or "Llamó a su madre".
 * The time phrase's own article, count or unit is no word after the verb ("She appeared the next
 * morning", "Apareció una hora más tarde").
 */
function arrives(ts: Token[], v: number, i: number, lang: Lang): boolean {
  const stop = timePhraseStart(ts, v, i, lang);
  const word = (k: number) =>
    k < stop && ts[k] && !ts[k]!.punctBefore ? ts[k]!.text.toLowerCase() : '';
  const verb = ts[v]!.text.toLowerCase();
  const next = word(v + 1);
  if (!next) return true;
  if (lang === 'en') {
    if (verb === 'appeared') {
      const state = ts.slice(v + 1, i).some((t) => STATE_NOUNS.has(t.text.toLowerCase()));
      return (APPEARING_WHERE.has(next) || /^\p{Ll}+ly$/u.test(next)) && !state;
    }
    if (verb === 'knocked' || verb === 'showed' || verb === 'called') {
      // "knocked a little after nine"
      const little =
        next === 'a' &&
        word(v + 2) === 'little' &&
        ['after', 'before', 'past'].includes(word(v + 3));
      return little || KNOCKING_WHERE.has(next) || /^\p{Ll}+ly$/u.test(next);
    }
    if (verb === 'returned' && (next in DETERMINERS.en || BARE_OBJECTS.has(next))) return false;
    if (verb === 'came' && next === 'down' && word(v + 2) === 'with') return false;
    const decision =
      ['to', 'at'].includes(next) &&
      ['a', 'an'].includes(word(v + 2)) &&
      DECISION_NOUNS.has(word(v + 3));
    return !((verb === 'came' || verb === 'arrived') && decision);
  }
  if (next === 'en' && ['sí', 'calor', 'razón'].includes(word(v + 2))) return false;
  if (next !== 'a') return true;
  const then = word(v + 2);
  if (verb === 'llamó') {
    return (
      ['la', 'mi', 'tu', 'su', 'nuestra'].includes(then) &&
      ['puerta', 'ventana'].includes(word(v + 3))
    );
  }
  if (verb === 'volvió' || verb === 'regresó' || verb === 'llegó') {
    // "Volvió a llover", "Llegó a odiarme", but coming to fetch or see someone is coming:
    // "Regresó a recogerlas", "Volvió a verme".
    const infinitive =
      /^(\p{Ll}+?(?:ar|er|ir|ár|ér|ír))((?:me|te|nos|os|se|lo|la|los|las|le|les){0,2})$/u.exec(
        then,
      );
    const base = infinitive ? infinitive[1]!.replace(/á/u, 'a').replace(/é/u, 'e') : '';
    const fetching =
      verb !== 'llegó' &&
      (FETCHING.has(base) || (base === 'ver' && /^(?:me|te|nos|os)/u.test(infinitive?.[2] ?? '')));
    const away =
      (/^\p{Lu}/u.test(ts[v + 2]?.text ?? '') && !placeHere(ts, v)) ||
      then === 'su' ||
      then === 'sus';
    return !(infinitive && !fetching) && !away;
  }
  return true;
}

/** "Me quedé en Sevilla… Llegó a Sevilla": "llegó a" the place where the narration put someone. */
function placeHere(ts: Token[], v: number): boolean {
  const place = ts[v + 2];
  if (ts[v]?.text.toLowerCase() !== 'llegó' || ts[v + 1]?.text !== 'a' || !place) return false;
  return ts
    .slice(0, v)
    .some((t, k) => t.text === place.text && ts[k - 1]?.text.toLowerCase() === 'en');
}

/** A verb of coming back: "returned", "came back", "volvió", "regresó". */
function returns(ts: Token[], v: number, lang: Lang): boolean {
  const word = ts[v]?.text.toLowerCase() ?? '';
  const next = ts[v + 1] && !ts[v + 1]!.punctBefore ? ts[v + 1]!.text.toLowerCase() : '';
  return lang === 'en'
    ? word === 'returned' || (word === 'came' && next === 'back')
    : word === 'volvió' || word === 'regresó';
}

/**
 * Whether a short aside with a speech verb follows the time at `i` in its sentence ("She came that
 * evening, Tom said, because her house was cold"): someone else's report, not the arrival itself.
 * The teller's own "I think" and "as I said" are no report ("She came back the next day, I
 * thought.", "She arrived that evening, as I said, soaked to the skin").
 */
function reportedAfter(ts: Token[], i: number, lang: Lang): boolean {
  const end = ts.findIndex((t, k) => k > i && t.sentenceStart);
  const stop = end === -1 ? ts.length : end;
  for (let k = i + 1; k < stop; k++) {
    const lead = ts[k]!.text.toLowerCase();
    if (ts[k]!.punctBefore !== ',' || COORDINATORS[lang].has(lead)) continue;
    if (lead === 'as' || lead === 'como') continue;
    for (let j = k + 1; j < Math.min(stop, k + 3); j++) {
      if (ts[j]!.punctBefore) break;
      const verb = verbAt(ts, j, lang);
      const hedge = ['i', 'we', 'yo'].includes(lead) && !!verb?.thought;
      if (verb && !hedge && (j + 1 >= stop || !!ts[j + 1]!.punctBefore)) return true;
    }
  }
  return false;
}

/**
 * "In the evening", "Hours later", "Por la tarde": where time passes. Not after a short pause ("A
 * moment later"), nor in a comparison ("later than usual", "más tarde que nunca").
 */
function timeShifts(ts: Token[], lang: Lang): number[] {
  const pause = (i: number) =>
    i > 0 && !ts[i]!.punctBefore && SHORT_PAUSES[lang].has(ts[i - 1]!.text.toLowerCase());
  const compared = new Set(phrasesAt(ts, TIME_COMPARISONS[lang]));
  return phrasesAt(ts, TIME_SHIFTS[lang]).filter((i) => !pause(i) && !compared.has(i));
}

/** Where time first passes (see timeShifts), or -1. */
function timePasses(ts: Token[], lang: Lang): number {
  return timeShifts(ts, lang)[0] ?? -1;
}

/**
 * "Tom left.", "drove me home and left", "y se fue": where someone leaves, at the end of a clause,
 * or -1. In English someone has to be the one leaving ("on my left", "no butter left"), and
 * someone who had left was gone before the scene ("the scarf she had left"; but see
 * speakerLeaves). Spanish leaves the subject out ("Se fue.", "Al rato salió."), so only a subject
 * that is a thing ("el gato salió") or a "no" rules a departure out; a time, or a phrase after a
 * preposition, is no subject ("Esa tarde se fue.", "Después de la cena se fue.").
 */
function someoneLeaves(ts: Token[], mentions: Mention[], lang: Lang): number {
  const found = phrasesAt(ts, DEPARTURES[lang], true).find((i) => {
    const b = subjectIndexBefore(ts, i, lang);
    const word = ts[b]?.text.toLowerCase() ?? '';
    if (lang === 'es') {
      // A noun after an article that names nobody; "al rato" is no subject.
      const det = b > 0 && !ts[b]!.punctBefore ? ts[b - 1]!.text.toLowerCase() : '';
      const prep = b > 1 && !ts[b - 1]!.punctBefore ? ts[b - 2]!.text.toLowerCase() : '';
      const thing =
        det in DETERMINERS.es &&
        det !== 'al' &&
        det !== 'del' &&
        !PREPOSITIONS.es.has(prep) &&
        !TIME_NOUNS.es.has(word) &&
        !mentions.some((m) => m.last === b);
      // "no se fue", "nadie se fue": a departure that does not happen.
      return !thing && !NEGATIONS.es.has(word);
    }
    // "she had left", "I’d left": gone before the scene.
    if (
      b !== -1 &&
      (/['’]d$/u.test(ts[b]!.text) || ts.slice(b + 1, i).some((t) => t.text === 'had'))
    ) {
      return false;
    }
    return (
      subjectOf(ts, i, mentions, lang) !== null ||
      OTHER_SUBJECTS[lang].has(word) ||
      INDEFINITE_SUBJECTS[lang].has(word) ||
      word === 'we' ||
      coordinated(ts, i, lastSentenceStart(ts.slice(0, i + 1)), lang)
    );
  });
  return found ?? -1;
}

/**
 * Whether the word at `k` is a name rather than the word it spells ("May", "Will", "Hope"):
 * capitalised, past a sentence's first word or a mention of its own there ("May didn’t get home",
 * not "Had Anne not come").
 */
function nameAt(ts: Token[], k: number, mentions: Mention[]): boolean {
  const t = ts[k];
  return (
    !!t &&
    !LOWER.test(t.text) &&
    (!t.sentenceStart || mentions.some((y) => y.first === k && y.last === k))
  );
}

/** The lower-case word right before a mention, when nothing but a space separates them. */
function wordBefore(ts: Token[], m: Mention): string | undefined {
  const prev = ts[m.first - 1];
  return prev && !ts[m.first]!.punctBefore ? prev.text.toLowerCase() : undefined;
}

/**
 * Whether a line asks its listener something before it ends: a question inside it, but not one it
 * quotes ("He kept asking me, ‘Do you sleep well?’"), a lone question word its speaker answers
 * ("Why? Because I was tired,"), or an echo of one or two words that opens it before more of the
 * line (not "And you?", "Well?", "Is it?"). With `answered`, the question the line answers, an echo
 * repeats a word of it or is a lone pronoun ("Will you marry me?" / "Marry you? Well,", "Are you
 * coming in?" / "In? Not yet,", "¿Quieres casarte conmigo?" / "¿Casarme contigo? Bueno"; not "Is that
 * you?" / "Hungry? I made soup,"), and has no question word ("Shall we go?" / "Go where? It is
 * late," asks back). With `true` any short question there is taken for one.
 */
function asksInLine(text: string, lang: Lang, answered?: string | true): boolean {
  const body = text
    .trim()
    .replace(/^[—–―\-“"«‘']+/u, '')
    .replace(/[”"»’']+$/u, '')
    .replace(/‘[^‘’]*’(?!\p{L})|«[^«»]*»|“[^“”]*”|"[^"]*"/gu, ' ');
  const sentences = body.split(/(?<=[?!.…])\s+/u).filter((s) => /\p{L}/u.test(s));
  const words = (s: string) =>
    s
      .split(/[^\p{L}'’]+/u)
      .filter(Boolean)
      .map((w) => w.toLowerCase());
  const leads =
    lang === 'en'
      ? /^(?:what|why|how|who|whom|where|when|which|whose|do|does|did|is|are|am|was|were|have|has|had|can|could|will|would|shall|should|may|might|must|and|but|or|so|well|yes|eh|huh|hm+)(?:n['’]t)?$/u
      : /^(?:qué|quién|quiénes|cómo|dónde|adónde|cuándo|cuál|cuáles|cuánto|cuánta|cuántos|cuántas|por|y|pero|o|eh|sí|bien)$/u;
  const pronouns =
    lang === 'en'
      ? /^(?:me|you|us|him|her|them|i|we)$/u
      : /^(?:yo|tú|mí|ti|nosotros|nosotras|él|ella|ellos|ellas|usted)$/u;
  const minor =
    lang === 'en'
      ? /^(?:the|a|an|of|to|in|on|at|for|with|it|that|this|you|me)$/u
      : /^(?:el|la|los|las|un|una|de|a|en|con|que|se|te|me|lo|le)$/u;
  const asked = typeof answered === 'string' ? words(answered) : [];
  const same = (a: string, b: string) =>
    a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));
  const echo = (w: string[]) =>
    answered === true ||
    (w.length === 1 && pronouns.test(w[0]!)) ||
    w.some((x) => (w.length === 1 || !minor.test(x)) && asked.some((y) => same(x, y)));
  return sentences.some((s, n) => {
    if (!s.includes('?')) return false;
    const w = words(s);
    const more = n + 1 < sentences.length;
    const wh = w.some((x) => WH_WORDS[lang].has(x));
    if (answered && n === 0 && more && w.length <= 2 && !leads.test(w[0] ?? '') && !wh && echo(w)) {
      return false;
    }
    // Nor does a "can you believe it?" the line goes on from ("Me preguntó si dormía bien, ¿te lo
    // puedes creer? Nada más").
    const believe = [
      'lo puedes creer',
      'puedes creerlo',
      'can you believe it',
      'would you believe it',
    ];
    if (more && believe.some((p) => w.slice(-p.split(' ').length).join(' ') === p)) return false;
    const lone = w.length === 1 ? WH_WORDS[lang].has(w[0]!) : w.join(' ') === 'por qué';
    return !(lone && more && ['because', 'porque'].includes(words(sentences[n + 1]!)[0] ?? ''));
  });
}

/** A line of one to three words that only hesitate: "Well,", "Well, well,", "Bueno", "Pues…". */
const HESITATIONS: Record<Lang, RegExp> = {
  en: /^(?:(?:well|oh|ah|um+|er+m?|h?m+|uh|so)\s*){1,3}$/u,
  es: /^(?:(?:bueno|pues|vaya|eh|ah|oh|ay|este|bien|h?m+)\s*){1,3}$/u,
};

/** Where the first sentence of a run of tokens ends (exclusive). */
function firstSentenceEnd(ts: Token[]): number {
  const end = ts.findIndex((t, i) => i > 0 && t.sentenceStart);
  return end === -1 ? ts.length : end;
}

/** Where the last sentence of a run of tokens starts. */
function lastSentenceStart(ts: Token[]): number {
  return Math.max(
    0,
    findLastIndex(ts, (t, i) => i > 0 && t.sentenceStart),
  );
}

function findLastIndex<T>(items: T[], predicate: (item: T, i: number) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!, i)) return i;
  return -1;
}
