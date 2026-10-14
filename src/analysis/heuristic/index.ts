import type { Character, Gender, Lang, Mode, Tone, ToneLabel } from '@/format/types';
import { matchCast, type CastEntry } from '../castMatch';
import type { AliasAddition, LabelResult, NewCharacter, SpanLabel, SpeakerRef } from '../labels';
import type { Unit } from '../units';
import { ADVERB_TONES, type VerbInfo } from './lexicon';
import { findMentions, subjectOf, tokenize, verbAt, type Mention, type Token } from './mentions';

export const HEURISTIC_VERSION = 1;

export interface HeuristicInput {
  text: string;
  lang: Lang;
  units: readonly Unit[];
  /** The story's current cast, including the narrator and the unknown speaker. */
  cast: readonly Character[];
}

/** How far into a tag (in words) the speech verb may appear: "said his lady" / "—dijo Ana". */
const TAG_WINDOW = 6;
const CLOSING_QUOTE = /[”"»’']\s*$/u;
const OPENING_QUOTE = /^\s*[“"«‘']/u;
const VOCATIVE_LEAD = new Set(['dear', 'querido', 'querida', 'oh', 'mi', 'my', 'amigo', 'amiga']);

interface Tag {
  verb: VerbInfo;
  tone?: ToneLabel;
  speaker?: string;
  /** Other people named in the tag ("sin mirar al doctor"). */
  others: string[];
}

/**
 * Free, deterministic speaker attribution. Per paragraph with speech:
 * 1. an explicit tag (speech verb + name, descriptor or pronoun) in the paragraph's narration;
 * 2. a colon intro in the previous narration paragraph ("…, que dijo:");
 * 3. alternation: the most recent other participant (speakers, people addressed by name, people
 *    named in narration);
 * 4. otherwise the "unknown" speaker.
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
  private clock = 0;
  private newCount = 0;

  private lastSpeaker?: string;
  private colonSpeaker?: string;
  private narrationGap = Infinity;
  private continuesSpeech = false;

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
    // A narration unit right after speech is a tag ("…,” said Anne"), not a new sentence.
    const tokens = new Map(
      units.map((u, n) => [
        u,
        tokenize(this.slice(u), this.lang, n === 0 || units[n - 1]!.kind === 'narration'),
      ]),
    );
    const hasThoughtVerb = [...tokens.values()].some((ts) =>
      ts.some((_, i) => verbAt(ts, i, this.lang)?.thought),
    );
    const isVoiced = (u: Unit) => u.kind === 'speech' || (u.kind === 'emphasis' && hasThoughtVerb);
    const voiced = units.filter(isVoiced);

    if (voiced.length === 0) {
      this.narrationParagraph(units, tokens);
      return units.map((u) => this.label(u, this.narratorKey, 'narration'));
    }

    // Each voiced unit takes its nearest tag; untagged ones share the paragraph's speaker.
    const tags = new Map(
      voiced.map((u) => [u, this.tagNear(units, units.indexOf(u), tokens, isVoiced)]),
    );
    const firstTag = [...tags.values()].find((t) => t !== undefined);
    let fallback = [...tags.values()].find((t) => t?.speaker)?.speaker;
    if (!fallback && this.continuesSpeech && OPENING_QUOTE.test(this.slice(voiced[0]!))) {
      fallback = this.lastSpeaker;
    }
    fallback ??= this.colonSpeaker ?? this.alternate();
    const speakerOf = (u: Unit) => tags.get(u)?.speaker ?? fallback;

    // People addressed or mentioned rank just below the speaker as the next "other" participant.
    for (const u of voiced) {
      const speaker = speakerOf(u);
      for (const key of tags.get(u)?.others ?? []) if (key !== speaker) this.touch(key);
      this.touchVocatives(u, tokens.get(u)!, speaker);
      if (speaker !== this.unknownKey) {
        this.touch(speaker);
        this.lastSpeaker = speaker;
      }
    }

    const lastVoiced = voiced.at(-1)!;
    this.continuesSpeech =
      lastVoiced === units.at(-1) &&
      lastVoiced.kind === 'speech' &&
      !CLOSING_QUOTE.test(this.slice(lastVoiced)) &&
      OPENING_QUOTE.test(this.slice(lastVoiced));
    this.colonSpeaker = undefined;
    this.narrationGap = 0;

    return units.map((u) => {
      if (!isVoiced(u)) return this.label(u, this.narratorKey, 'narration');
      const tag = tags.get(u) ?? firstTag;
      const mode: Mode = u.kind === 'emphasis' || tag?.verb.thought ? 'thought' : 'speech';
      const tone: Tone | undefined = tag?.tone ? { label: tag.tone } : undefined;
      return this.label(u, speakerOf(u), mode, tone);
    });
  }

  private narrationParagraph(units: Unit[], tokens: Map<Unit, Token[]>): void {
    this.colonSpeaker = undefined;
    this.continuesSpeech = false;
    this.narrationGap++;
    const all: Array<{ tokens: Token[]; mentions: Mention[] }> = units.map((u) => {
      const ts = tokens.get(u)!;
      return { tokens: ts, mentions: this.mentions(ts) };
    });
    for (const { mentions } of all) for (const m of mentions) this.touch(this.resolve(m));

    // "…y después una voz de hombre, que dijo:" introduces the next paragraph's speaker.
    const last = all.at(-1)!;
    if (!this.slice(units.at(-1)!).trimEnd().endsWith(':')) return;
    const verbIndex = findLastIndex(last.tokens, (_, i) => this.isVerb(last.tokens, i));
    if (verbIndex === -1) return;
    const subject = this.subjectKey(last.tokens, verbIndex, last.mentions);
    // Without a direct subject, prefer the nearest proper name, then the nearest descriptor.
    const before = [
      ...all.slice(0, -1).flatMap((x) => x.mentions),
      ...last.mentions.filter((m) => m.last < verbIndex),
    ];
    const nearest = before.filter((m) => m.kind === 'name').at(-1) ?? before.at(-1);
    this.colonSpeaker = subject ?? (nearest ? this.resolve(nearest) : undefined);
  }

  /** The tag for the voiced unit at `n`: in the narration right after it, else right before. */
  private tagNear(
    units: Unit[],
    n: number,
    tokens: Map<Unit, Token[]>,
    isVoiced: (u: Unit) => boolean,
  ): Tag | undefined {
    const after = units[n + 1];
    const before = units[n - 1];
    if (after && !isVoiced(after)) {
      const ts = tokens.get(after)!;
      const tag = this.tagIn(
        ts,
        ts.findIndex((_, i) => i < TAG_WINDOW && this.isVerb(ts, i)),
      );
      if (tag) return tag;
    }
    if (before && !isVoiced(before)) {
      const ts = tokens.get(before)!;
      return this.tagIn(
        ts,
        findLastIndex(ts, (_, i) => i >= ts.length - TAG_WINDOW && this.isVerb(ts, i)),
      );
    }
    return undefined;
  }

  private tagIn(ts: Token[], verbIndex: number): Tag | undefined {
    if (verbIndex === -1) return undefined;
    const verb = verbAt(ts, verbIndex, this.lang)!;
    const mentions = this.mentions(ts);
    const others = mentions.map((m) => this.resolve(m));
    const adverb = ts
      .slice(0, TAG_WINDOW + 4)
      .map((t) => ADVERB_TONES[this.lang][t.text.toLowerCase()])
      .find(Boolean);
    return {
      verb,
      tone: verb.tone ?? adverb,
      speaker: this.subjectKey(ts, verbIndex, mentions),
      others,
    };
  }

  private isVerb(ts: Token[], i: number): boolean {
    return verbAt(ts, i, this.lang) !== undefined;
  }

  private subjectKey(tokens: Token[], verbIndex: number, mentions: Mention[]): string | undefined {
    const subject = subjectOf(tokens, verbIndex, mentions, this.lang);
    if (!subject) return undefined;
    if (subject.kind === 'mention') return this.resolve(subject.mention);
    if (subject.gender === 'narrator') return this.narratorKey;
    return this.byGender(subject.gender);
  }

  /** The most recent participant of a gender; learns the gender of someone not yet known. */
  private byGender(gender: Gender): string | undefined {
    const recent = this.recentParticipants();
    const match = recent.find((k) => this.entry(k).gender === gender);
    if (match) return match;
    const unknownGender = recent.find((k) => !this.entry(k).gender);
    if (unknownGender) this.entry(unknownGender).gender = gender;
    return unknownGender;
  }

  private alternate(): string {
    if (this.narrationGap > 1 || !this.lastSpeaker) return this.unknownKey;
    return this.recentParticipants().find((k) => k !== this.lastSpeaker) ?? this.unknownKey;
  }

  private recentParticipants(): string[] {
    return [...this.lastActive.entries()]
      .filter(([k]) => this.entry(k).role === 'character')
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  }

  private touchVocatives(unit: Unit, tokens: Token[], speaker: string): void {
    for (const m of this.mentions(tokens)) {
      if (m.kind !== 'name') continue;
      const lead = tokens[m.first - 1];
      const afterGap =
        tokens[m.last + 1]?.punctBefore ?? this.slice(unit).slice(tokens[m.last]!.end);
      const opens =
        m.first === 0 ||
        !!tokens[m.first]!.punctBefore.match(/[,“"«¡]/u) ||
        (lead !== undefined && VOCATIVE_LEAD.has(lead.text.toLowerCase()));
      if (opens && /^[,!?”"»]/u.test(afterGap.trim())) {
        const key = this.resolve(m);
        if (key !== speaker) this.touch(key);
      }
    }
  }

  private mentions(tokens: Token[]): Mention[] {
    return findMentions(tokens, this.lang, (name) => !!matchCast(name, this.entries));
  }

  /** Finds or creates the character a mention refers to. */
  private resolve(m: Mention): string {
    const existing = matchCast(m.name, this.entries);
    if (existing) {
      if (m.gender && !existing.gender) existing.gender = m.gender;
      const known = [existing.name, ...existing.aliases].some(
        (n) => n.toLowerCase() === m.name.toLowerCase(),
      );
      if (!known) {
        existing.aliases.push(m.name);
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

  private label(u: Unit, key: string, mode: Mode, tone?: Tone): SpanLabel {
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
    };
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

function findLastIndex<T>(items: T[], predicate: (item: T, i: number) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!, i)) return i;
  return -1;
}
