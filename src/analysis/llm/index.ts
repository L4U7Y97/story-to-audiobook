import {
  TONE_LABELS,
  type Character,
  type Gender,
  type Lang,
  type Mode,
  type Tone,
} from '@/format/types';
import { isDefaultName, matchCast, namesOf, normaliseName, type CastEntry } from '../castMatch';
import { NAME_PARTICLES, TITLES } from '../heuristic/lexicon';
import type { AliasAddition, LabelResult, NewCharacter, SpanLabel, SpeakerRef } from '../labels';
import type { Unit } from '../units';
import { chunkUnits, DEFAULT_CHUNK_LIMITS, type ChunkLimits } from './chunking';
import type { Effort, LlmResponse, LlmTransport } from './client';
import {
  buildUserPrompt,
  promptCast,
  SYSTEM_PROMPT,
  type ContextLine,
  type NarratorStyle,
  type PromptCharacter,
} from './prompt';
import {
  LLM_OUTPUT_FORMAT,
  readLlmOutput,
  type LlmOutput,
  type LlmSpan,
  type LlmUnitLabel,
} from './schema';

/** Bump when the prompt or the conversion rules change. */
export const LLM_VERSION = 2;

const CONTEXT_LINES = 20;
const MAX_OUTPUT_TOKENS = 16000;
/** Below this size a truncated chunk is not split again; its units use the heuristic. */
const MIN_SPLIT_UNITS = 8;

/** What a model may call the narrator that is not a name. */
const NARRATOR_PLACEHOLDERS = new Set([
  'i',
  'me',
  'myself',
  'yo',
  'mí',
  'narrator',
  'the narrator',
  'narrador',
  'narradora',
  'el narrador',
  'la narradora',
]);
/** First words of a description rather than a name ("his lady", "la abuela"). */
const DESCRIPTION_STARTS = new Set([
  'his',
  'her',
  'their',
  'my',
  'your',
  'our',
  'the',
  'a',
  'an',
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'su',
  'sus',
  'mi',
  'mis',
  'tu',
  'tus',
]);
/** Title words of both languages, lower-case, without the period ("mr", "doña"). */
const TITLE_WORDS = new Set(
  [...Object.keys(TITLES.en), ...Object.keys(TITLES.es)].map((t) =>
    t.replace(/\.$/u, '').toLowerCase(),
  ),
);
/** Female titles that go before a family name, as in matchCast's rule 2 ("Mrs. Joe"). */
const FAMILY_TITLES = new Set(['mrs', 'miss', 'ms', 'mme', 'mlle', 'madam', 'madame']);
/** Those that also go before a woman's first name ("Miss Elizabeth"), never her husband's. */
const OWN_NAME_TITLES = new Set(['miss', 'ms', 'mlle']);
/** Words that join a name without naming anyone ("Inés de Suárez", "Ortega y Gasset"). */
const NAME_JOINERS = new Set([
  ...NAME_PARTICLES.en,
  ...NAME_PARTICLES.es,
  'the',
  'of',
  'el',
  'la',
  'los',
  'las',
  'y',
]);

export interface LlmAnalyzeInput {
  text: string;
  lang: Lang;
  units: readonly Unit[];
  cast: readonly Character[];
  /** The heuristic's labels for the same units: the fallback for anything the model gets wrong. */
  heuristic: LabelResult;
  /** Labelled lines from the end of the previous part, as context for the first chunk. */
  previous?: ReadonlyArray<{ speakerId: string; mode: Mode; text: string }>;
  /** How the narrator told the story's other analysed parts (see narratorStyleOf). */
  narratorStyle?: NarratorStyle;
  transport: LlmTransport;
  model: string;
  effort: Effort;
  limits?: ChunkLimits;
  /** Responses by chunk key, so a retried analysis does not pay again for chunks that finished. */
  cache?: Map<string, LlmResponse>;
  cacheKey?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface LlmAnalyzeResult {
  labels: LabelResult;
  /** Units labelled by the heuristic because the model's answer for them was unusable. */
  fallbackUnits: number;
  usage: { inputTokens: number; outputTokens: number };
}

interface Speaker {
  ref: SpeakerRef;
  entry: CastEntry;
  /** How the prompt shows the speaker. The aliases and gender learned so far are in `entry`. */
  shown: PromptCharacter;
}

/**
 * The model's labels as tellerNear reads them, in text order, so that a unit left to the heuristic
 * finds its teller by binary search instead of walking the part. `at` is a unit's position.
 */
interface Nearby {
  /** The units with narration whose teller the model chose, each with its last such teller. */
  told: Array<{ at: number; speaker: SpeakerRef }>;
  /** The narration and written spans, and the "I" lines among them (see LlmRun.extendNearby). */
  spans: Array<{ at: number; span: SpanLabel }>;
  /** Where the narration and written spans are in `spans`. */
  telling: number[];
  /** For each entry of `spans`, where the run of entries by its speaker that ends there starts. */
  runs: number[];
}

/**
 * Labels a part with Claude. The model only ever names speakers and (when it splits a unit)
 * repeats unit text; offsets always come from walking the original text, and any unit whose
 * answer is missing, malformed or doesn't match the text takes its heuristic label instead, with
 * its narration and "I" lines voiced by the teller the model chose nearby.
 * Transport errors (bad key, network) are thrown; refusals and truncated answers are not.
 */
export async function analyzeLlm(input: LlmAnalyzeInput): Promise<LlmAnalyzeResult> {
  return new LlmRun(input).run();
}

class LlmRun {
  private readonly speakers = new Map<string, Speaker>();
  private readonly codeOfId = new Map<string, string>();
  private readonly newCharacters: NewCharacter[] = [];
  private readonly aliasAdditions: AliasAddition[] = [];
  private readonly labels = new Map<number, SpanLabel[]>();
  /** Speakers for the heuristic's own characters, by heuristic ref, once a fallback unit uses them. */
  private readonly heuristicRefs = new Map<string, SpeakerRef>();
  private readonly usage = { inputTokens: 0, outputTokens: 0 };
  private context: ContextLine[] = [];
  /** The last speaker other than U that the model gave narration to. */
  private teller?: SpeakerRef;
  /** Narration the model left to U: voiced by the teller in effect, but not a teller it chose. */
  private readonly unchosen = new Set<SpanLabel>();
  /** Where the heuristic's "I" lines start: speech or thought it gave the teller ("“No,” I said"). */
  private readonly tellerLines = new Set<number>();
  /** The heuristic's spans by the position of the unit that holds them. */
  private readonly heuristicSpans = new Map<number, SpanLabel[]>();
  /** The labels so far as tellerNear reads them. */
  private readonly nearby: Nearby = { told: [], spans: [], telling: [], runs: [] };

  constructor(private readonly input: LlmAnalyzeInput) {
    promptCast(input.cast, input.narratorStyle).forEach((shown, i) => {
      const c = input.cast[i]!;
      this.speakers.set(shown.code, {
        ref: { kind: 'cast', id: c.id },
        entry: {
          key: shown.code,
          name: c.name,
          aliases: [...c.aliases],
          gender: c.gender,
          role: c.role,
        },
        shown,
      });
      this.codeOfId.set(c.id, shown.code);
    });
    this.context = (input.previous ?? []).slice(-CONTEXT_LINES).map((line) => ({
      code: this.codeOfId.get(line.speakerId) ?? 'U',
      mode: line.mode,
      text: line.text,
      previousPart: true,
    }));
    const { units } = input;
    for (const s of input.heuristic.spans) {
      if (s.teller && s.mode !== 'narration') this.tellerLines.add(s.start);
      // Units are in text order and never overlap, so only the last one to start at or before a
      // span can hold it.
      const k = partitionPoint(units.length, (i) => units[i]!.start <= s.start) - 1;
      const unit = k >= 0 ? units[k]! : undefined;
      if (!unit || s.end > unit.end) continue;
      const spans = this.heuristicSpans.get(unit.index);
      if (spans) spans.push(s);
      else this.heuristicSpans.set(unit.index, [s]);
    }
  }

  async run(): Promise<LlmAnalyzeResult> {
    const { text, units } = this.input;
    const chunks = chunkUnits(text, units, this.input.limits ?? DEFAULT_CHUNK_LIMITS);
    this.input.onProgress?.(0, chunks.length);
    for (const [i, chunk] of chunks.entries()) {
      await this.labelChunk(chunk, `${i}`);
      this.input.onProgress?.(i + 1, chunks.length);
    }
    return this.result();
  }

  private async labelChunk(chunk: Unit[], key: string): Promise<void> {
    const response = await this.send(chunk, key);
    if (response.stopReason === 'max_tokens' && chunk.length >= MIN_SPLIT_UNITS) {
      const half = Math.ceil(chunk.length / 2);
      await this.labelChunk(chunk.slice(0, half), `${key}a`);
      await this.labelChunk(chunk.slice(half), `${key}b`);
      return;
    }
    // After a refusal the whole chunk uses the heuristic.
    if (response.stopReason !== 'refusal') this.apply(chunk, response.text);
    this.extendContext(chunk);
  }

  private async send(chunk: Unit[], key: string): Promise<LlmResponse> {
    const cacheKey = this.input.cacheKey && `${this.input.cacheKey}:${key}`;
    const cached = cacheKey ? this.input.cache?.get(cacheKey) : undefined;
    if (cached) return cached;

    const { text } = this.input;
    const user = buildUserPrompt({
      lang: this.input.lang,
      cast: [...this.speakers.values()].map((s) => this.promptCharacter(s)),
      context: this.context,
      units: chunk.map((u) => text.slice(u.start, u.end)),
    });
    const response = await this.input.transport.send({
      model: this.input.model,
      effort: this.input.effort,
      system: SYSTEM_PROMPT,
      user,
      maxTokens: MAX_OUTPUT_TOKENS,
      format: LLM_OUTPUT_FORMAT,
    });
    this.usage.inputTokens += response.usage.inputTokens;
    this.usage.outputTokens += response.usage.outputTokens;
    if (cacheKey) this.input.cache?.set(cacheKey, response);
    return response;
  }

  private promptCharacter({ entry, shown }: Speaker): PromptCharacter {
    // An "I" that older analyses stored as a name says nothing about who someone is.
    const aliases = entry.aliases.filter((a) => !isPlaceholder(a));
    return { ...shown, aliases, ...(entry.gender ? { gender: entry.gender } : {}) };
  }

  private apply(chunk: Unit[], raw: string): void {
    const output = readLlmOutput(raw);
    const forNarrator = output.aliasAdditions.filter((a) => a.characterId === 'N');
    const forOthers = output.aliasAdditions.filter((a) => a.characterId !== 'N');
    // N's names first, so that a character proposed under one of them is N.
    this.registerAliases(forNarrator, new Map());
    const local = this.registerNewCharacters(output.newCharacters);
    this.registerAliases(forOthers, local);

    const byId = new Map<number, LlmUnitLabel>();
    for (const u of output.units) if (!byId.has(u.id)) byId.set(u.id, u);

    chunk.forEach((unit, i) => {
      const label = byId.get(i);
      const spans = label && this.toSpans(unit, label.spans, local);
      if (!spans) return;
      for (const span of spans) {
        if (span.mode !== 'narration') continue;
        // Narration always has a teller: U's goes to the last one the model named, else N.
        if (this.codeOf(span.speaker) !== 'U') {
          this.teller = span.speaker;
        } else {
          span.speaker = this.teller ?? this.speakers.get('N')!.ref;
          this.unchosen.add(span);
        }
      }
      this.labels.set(unit.index, spans);
      this.extendNearby(unit, spans);
    });
  }

  /**
   * Adds a unit's final labels to what tellerNear reads (see Nearby): its last narration span with
   * a teller the model chose, and its narration and written spans with the "I" lines among them,
   * which are speech or thought that the heuristic gave the teller ("“No,” I said"), where the
   * speaker the model chose, unless U, is who tells there. Each chunk is labelled once, in text
   * order, so the unit goes after every unit already there.
   */
  private extendNearby(unit: Unit, spans: readonly SpanLabel[]): void {
    const { told, spans: placed, telling, runs } = this.nearby;
    const chosen = spans.filter((s) => s.mode === 'narration' && !this.unchosen.has(s)).at(-1);
    if (chosen) told.push({ at: unit.index, speaker: chosen.speaker });
    const tellerLine = this.tellerLines.has(unit.start);
    for (const span of spans) {
      if (!isTelling(span) && !(tellerLine && this.codeOf(span.speaker) !== 'U')) continue;
      const last = placed.at(-1);
      runs.push(
        last && sameSpeaker(last.span.speaker, span.speaker) ? runs.at(-1)! : placed.length,
      );
      if (isTelling(span)) telling.push(placed.length);
      placed.push({ at: unit.index, span });
    }
  }

  /** Adds the chunk's final labels to the context, one line per span. */
  private extendContext(chunk: Unit[]): void {
    const { text } = this.input;
    const lines = chunk.flatMap((unit) =>
      (this.labels.get(unit.index) ?? this.fallbackSpans(unit)).map((s) => ({
        code: this.codeOf(s.speaker),
        mode: s.mode,
        text: text.slice(s.start, s.end),
      })),
    );
    this.context = [...this.context, ...lines].slice(-CONTEXT_LINES);
  }

  /**
   * Gives each of the model's new characters a speaker: the member it names (see memberNamed),
   * which learns the proposal's other names, or a new character under a fresh code. A proposal
   * with ref "N" only names the narrator, and one under another code the request showed is used
   * only if it names that member. Returns the speakers by this answer's refs.
   */
  private registerNewCharacters(proposed: LlmOutput['newCharacters']): Map<string, Speaker> {
    const local = new Map<string, Speaker>();
    // Refs only name characters within this answer, so fresh codes avoid all of them.
    const refs = new Set(proposed.map((c) => c.ref));
    // The codes the request showed, which keep their meaning in its answer.
    const shown = new Set(this.speakers.keys());
    const narrator = this.speakers.get('N')!;
    for (const c of proposed) {
      const name = c.name.trim();
      if (!name || local.has(c.ref)) continue;
      if (c.ref === 'N') {
        for (const n of [name, ...c.aliases]) this.addAlias(narrator, n);
        local.set(c.ref, narrator);
        continue;
      }
      const member = this.memberNamed(name, c.aliases);
      if (shown.has(c.ref) && member !== this.speakers.get(c.ref)) continue;
      if (member) {
        // The gender first, since a woman may take her family title (see isFamilyTitleOf).
        if (c.gender && !member.entry.gender && member.entry.role !== 'unknown') {
          this.fillGender(member, c.gender);
        }
        for (const n of [name, ...c.aliases]) {
          if (!matchCast(n, this.entries())) this.addAlias(member, n);
        }
        local.set(c.ref, member);
        continue;
      }
      // The family name of "Mrs. Watson" stays the name of a member who goes by it, so that a
      // later "Dr. Watson" still finds him.
      const family = familyName(name);
      const taken = this.entries().some((e) => isFamilyTitleOf(name, e));
      const aliases = [
        ...new Set(
          c.aliases
            .map((a) => a.trim())
            .filter(
              (a) =>
                a && a !== name && !isPlaceholder(a) && !(taken && normaliseName(a) === family),
            ),
        ),
      ];
      const description = c.description.trim();
      const created = this.createCharacter(
        {
          name,
          aliases,
          ...(c.gender ? { gender: c.gender } : {}),
          ...(description ? { description } : {}),
        },
        refs,
      );
      local.set(c.ref, created);
    }
    return local;
  }

  /** The member a proposed character is (see matchProposal). */
  private memberNamed(name: string, aliases: readonly string[]): Speaker | undefined {
    const entry = matchProposal(name, aliases, this.entries());
    return entry && this.speakers.get(entry.key);
  }

  /** Adds a character found in this run under a fresh code. */
  private createCharacter(
    c: Omit<NewCharacter, 'ref'>,
    refs: ReadonlySet<string> = new Set(),
  ): Speaker {
    const code = this.freshCode(refs);
    this.newCharacters.push({ ...c, ref: code, aliases: [...c.aliases] });
    const speaker: Speaker = {
      ref: { kind: 'new', ref: code },
      // The entry owns its own aliases, so an alias added later is recorded once.
      entry: {
        key: code,
        name: c.name,
        aliases: [...c.aliases],
        gender: c.gender,
        role: 'character',
      },
      shown: {
        code,
        name: c.name,
        role: 'character',
        aliases: [],
        ...(c.description ? { description: c.description } : {}),
      },
    };
    this.speakers.set(code, speaker);
    return speaker;
  }

  /** The first "xK", from K = new characters + 1, that is neither a speaker code nor in `refs`. */
  private freshCode(refs: ReadonlySet<string>): string {
    let k = this.newCharacters.length + 1;
    while (this.speakers.has(`x${k}`) || refs.has(`x${k}`)) k++;
    return `x${k}`;
  }

  /** Adds the model's alias additions. A code is looked up among this answer's refs first. */
  private registerAliases(
    additions: LlmOutput['aliasAdditions'],
    local: ReadonlyMap<string, Speaker>,
  ): void {
    for (const { characterId, alias } of additions) {
      const speaker = local.get(characterId) ?? this.speakers.get(characterId);
      if (speaker) this.addAlias(speaker, alias);
    }
  }

  /**
   * Records a new name for a speaker. Nobody takes "I" or "the narrator", nor a woman's family
   * title before a name they go by bare (see isFamilyTitleOf), U takes no name, and N only those
   * isNarratorAlias allows.
   */
  private addAlias(speaker: Speaker, alias: string): void {
    const name = alias.trim();
    const { entry } = speaker;
    if (!name || entry.role === 'unknown' || isPlaceholder(name)) return;
    if (isFamilyTitleOf(name, entry)) return;
    if (entry.role === 'narrator' && !this.isNarratorAlias(name)) return;
    const known = [entry.name, ...entry.aliases].map(normaliseName);
    if (known.includes(normaliseName(name))) return;
    entry.aliases.push(name);
    if (speaker.ref.kind === 'cast') {
      this.aliasAdditions.push({ characterId: speaker.ref.id, alias: name });
    } else {
      const ref = speaker.ref.ref;
      this.newCharacters.find((c) => c.ref === ref)?.aliases.push(name);
    }
  }

  private fillGender(speaker: Speaker, gender: Gender): void {
    speaker.entry.gender = gender;
    if (speaker.ref.kind === 'new') {
      const ref = speaker.ref.ref;
      const created = this.newCharacters.find((c) => c.ref === ref);
      if (created) created.gender = gender;
    }
  }

  /**
   * Whether the model may give N this name: a capitalised real name (not a default name; "doña
   * Inés" counts) that no character has, and that fits N's names if N has any (see fitsNames), so
   * that another narrator's name never lands on N.
   */
  private isNarratorAlias(name: string): boolean {
    if (isDefaultName(name, 'narrator') || isDefaultName(name, 'unknown')) return false;
    if (!startsCapitalised(name)) return false;
    const characters = this.entries().filter((e) => e.role === 'character');
    if (matchCast(name, characters)) return false;
    const own = namesOf(this.speakers.get('N')!.entry);
    return own.length === 0 || fitsNames(own, name);
  }

  private entries(): CastEntry[] {
    return [...this.speakers.values()].map((s) => s.entry);
  }

  /**
   * Converts the model's spans for one unit into offsets. One span covers the whole unit. Several
   * spans must repeat the unit text in order (whitespace between and around them may be skipped,
   * since the prompt shows trimmed units); each span then runs to the start of the next.
   */
  private toSpans(
    unit: Unit,
    spans: readonly LlmSpan[],
    local: Map<string, Speaker>,
  ): SpanLabel[] | undefined {
    const speakers = spans.map((s) => local.get(s.speaker) ?? this.speakers.get(s.speaker));
    if (spans.length === 0 || speakers.some((s) => s === undefined)) return undefined;

    const starts: number[] = [];
    if (spans.length === 1) {
      starts.push(unit.start);
    } else {
      const { text } = this.input;
      let cursor = unit.start;
      for (const span of spans) {
        const piece = span.text;
        // Whitespace never forms a segment of its own (invariant 5).
        if (!piece || !/\S/u.test(piece)) return undefined;
        while (cursor < unit.end && /\s/u.test(text[cursor]!) && !text.startsWith(piece, cursor))
          cursor++;
        if (cursor + piece.length > unit.end || !text.startsWith(piece, cursor)) return undefined;
        starts.push(cursor);
        cursor += piece.length;
      }
      if (/\S/u.test(text.slice(cursor, unit.end))) return undefined;
      starts[0] = unit.start;
    }

    return spans.map((span, i) => ({
      start: starts[i]!,
      end: i + 1 < spans.length ? starts[i + 1]! : unit.end,
      speaker: speakers[i]!.ref,
      mode: span.mode,
      ...(toTone(span.tone) ? { tone: toTone(span.tone)! } : {}),
      source: 'llm' as const,
    }));
  }

  private codeOf(ref: SpeakerRef): string {
    return ref.kind === 'cast' ? (this.codeOfId.get(ref.id) ?? 'U') : ref.ref;
  }

  /** Model labels where usable, heuristic labels elsewhere, with one consistent set of new characters. */
  private result(): LlmAnalyzeResult {
    const spans: SpanLabel[] = [];
    let fallbackUnits = 0;
    for (const unit of this.input.units) {
      const llm = this.labels.get(unit.index);
      if (llm) {
        spans.push(...llm);
        continue;
      }
      fallbackUnits++;
      spans.push(...this.fallbackSpans(unit));
    }

    const used = new Set(spans.flatMap((s) => (s.speaker.kind === 'new' ? [s.speaker.ref] : [])));
    return {
      labels: {
        spans,
        newCharacters: this.newCharacters.filter((c) => used.has(c.ref)),
        aliasAdditions: this.aliasAdditions,
      },
      fallbackUnits,
      usage: this.usage,
    };
  }

  /**
   * The heuristic's spans for a unit the model did not label. Its narration and "I" lines (the
   * teller flag, which is dropped here) go to the teller the model chose nearby, if any.
   */
  private fallbackSpans(unit: Unit): SpanLabel[] {
    const teller = this.tellerNear(unit.index);
    return (this.heuristicSpans.get(unit.index) ?? []).map(({ teller: told, ...span }) => ({
      ...span,
      speaker: told && teller ? teller : this.heuristicSpeaker(span.speaker),
    }));
  }

  /**
   * Who the model says tells unit `index`: the writer of the letter or diary around it (see
   * writerAround), else the teller of the narration near it (see toldNear). Where that narration
   * is the narrator's, the narrator keeps the unit even inside a letter: the labels around a line
   * of a letter can be the same as around the narrator's own line between two notes by one
   * writer, and the narrator reading a line of a letter is the milder mistake.
   */
  private tellerNear(index: number): SpeakerRef | undefined {
    const told = this.toldNear(index);
    if (told && this.codeOf(told) === 'N') return told;
    return this.writerAround(index) ?? told;
  }

  /**
   * The speaker of the last narration span of the nearest unit before `index` that the model gave
   * narration, else of the nearest one after it. Narration the model left to U names no teller.
   */
  private toldNear(index: number): SpeakerRef | undefined {
    const { told } = this.nearby;
    const before = partitionPoint(told.length, (k) => told[k]!.at < index);
    const after = partitionPoint(told.length, (k) => told[k]!.at <= index);
    return (before > 0 ? told[before - 1] : told[after])?.speaker;
  }

  /**
   * The writer of the letter or diary unit `index` is in, by the model's labels: the nearest
   * narration or written spans on both sides, and the next one on one side, are written by one
   * speaker other than U (one written span on each side may be two notes with the teller's
   * narration between them). Narration the model left to U ends a letter, and so does an "I" line
   * it gave anyone but the writer. A stretch the model left unlabelled between two of the writer's
   * notes or entries, one of them two paragraphs long or more, also goes to the writer when it is
   * a character teller's own line or chapter, or a line between two letters in a part where the
   * model named no teller, since the labels around it are the same as inside one entry.
   */
  private writerAround(index: number): SpeakerRef | undefined {
    const { spans, telling, runs } = this.nearby;
    // spans[0, start) come before the unit and spans[end, …) after it, and the narration or
    // written spans nearest it are telling[b - 1] before it and telling[a] after it.
    const start = partitionPoint(spans.length, (k) => spans[k]!.at < index);
    const end = partitionPoint(spans.length, (k) => spans[k]!.at <= index);
    const b = partitionPoint(telling.length, (k) => telling[k]! < start);
    const a = partitionPoint(telling.length, (k) => telling[k]! < end);
    if (b === 0 || a === telling.length) return undefined;
    const before = telling[b - 1]!;
    const after = telling[a]!;
    const writer = spans[before]!.span.speaker;
    if (this.codeOf(writer) === 'U') return undefined;
    const wrote = (k: number) =>
      spans[k]!.span.mode === 'written' && sameSpeaker(spans[k]!.span.speaker, writer);
    // Whether spans[from, to) are all the writer's: its own "I" lines are part of the letter, and
    // anyone else's end it.
    const own = (from: number, to: number) =>
      to <= from || (sameSpeaker(spans[to - 1]!.span.speaker, writer) && runs[to - 1]! <= from);
    if (!wrote(before) || !own(before + 1, start) || !wrote(after) || !own(end, after)) {
      return undefined;
    }
    const previous = b > 1 ? telling[b - 2]! : undefined;
    const next = a + 1 < telling.length ? telling[a + 1]! : undefined;
    const twoBefore = previous !== undefined && wrote(previous) && own(previous + 1, before);
    const twoAfter = next !== undefined && wrote(next) && own(after + 1, next);
    return twoBefore || twoAfter ? writer : undefined;
  }

  /**
   * The speaker for a heuristic span. A character the heuristic found joins the cast and the
   * model's characters: one matching its name or an alias is reused, and otherwise it is added
   * as a new character.
   */
  private heuristicSpeaker(ref: SpeakerRef): SpeakerRef {
    if (ref.kind === 'cast') return ref;
    const known = this.heuristicRefs.get(ref.ref);
    if (known) return known;
    const c = this.input.heuristic.newCharacters.find((n) => n.ref === ref.ref)!;
    const entries = this.entries();
    const existing = [c.name, ...c.aliases]
      .map((n) => matchCast(n, entries))
      .find((e) => e !== undefined);
    const speaker = existing ? this.speakers.get(existing.key)! : this.createCharacter(c);
    this.heuristicRefs.set(ref.ref, speaker.ref);
    return speaker.ref;
  }
}

/**
 * The entry a character the model proposes is: the narrator for "I" or "the narrator", else the
 * one its name matches (matchCast), else the one entry that one of its proper-name aliases names
 * exactly ("Lizzy" called "Elizabeth"). Descriptions ("his lady") and "I" are shared too easily to
 * identify anyone, and a word of the proposal's own full name names an entry only if the entry's
 * full names agree with that name ("Watson" of "Dr. John Watson" is "John H. Watson", but "Jane"
 * of "Jane Fairfax" is not "Jane Bennet"; see disagrees). The family name of "Mrs. Watson" does
 * not name an entry that may be her husband (see isFamilyTitleOf).
 */
export function matchProposal(
  name: string,
  aliases: readonly string[],
  entries: readonly CastEntry[],
): CastEntry | undefined {
  if (isPlaceholder(name)) return entries.find((e) => e.role === 'narrator');
  const byName = matchCast(name, entries);
  if (byName) return byName;
  const own = untitledWords(name);
  const family = familyName(name);
  const wanted = aliases
    .filter((a) => !isPlaceholder(a))
    .map(normaliseName)
    .filter((a) => a && !DESCRIPTION_STARTS.has(a.split(' ')[0]!));
  const byAlias = entries.filter((e) => {
    const names = namesOf(e);
    return wanted.some(
      (a) =>
        names.some((n) => normaliseName(n) === a) &&
        !(a === family && isFamilyTitleOf(name, e)) &&
        !(own.length > 1 && own.includes(a) && names.some((n) => disagrees(n, own, a))),
    );
  });
  return byAlias.length === 1 ? byAlias[0] : undefined;
}

/**
 * The family name in a name like "Mrs. Joe" or "Miss Bingley": the one word after a female title,
 * which her husband, father or brother may go by too.
 */
function familyName(name: string): string | undefined {
  const [title, word, ...rest] = normaliseName(name).split(' ');
  return word && rest.length === 0 && FAMILY_TITLES.has(title!) ? word : undefined;
}

/**
 * Whether `name` is a woman's family title before a name that `entry` goes by bare ("Mrs. Watson"
 * for "Watson"), and the entry is not known to be a woman. The entry may then be her husband,
 * father or brother, so the name is never the entry's, as matchCast's rule 2 never pairs the two.
 * "Miss", "Ms" and "Mlle" also go before a woman's first name. They are the entry's own title when
 * it is not known to be a man and has full names that have the word only as their first word, if
 * at all, so that it is no family name ("Miss Elizabeth" or "Miss Eliza" for "Elizabeth Bennet").
 * Otherwise her name looks like his family name: "Miss Elizabeth" is not a member called only
 * "Elizabeth", as "Miss Smith" is not "Smith", and "Miss Marple" is not "Marple" known as "Jane
 * Marple", as "Miss Bingley" is not "Charles Bingley". A woman made twice, whom the user can merge,
 * is a milder mistake than a man who reads her lines in every later part.
 */
function isFamilyTitleOf(name: string, entry: CastEntry): boolean {
  const family = familyName(name);
  if (family === undefined || entry.gender === 'female') return false;
  const names = namesOf(entry);
  if (!names.some((n) => normaliseName(n) === family)) return false;
  if (entry.gender === 'male' || !OWN_NAME_TITLES.has(normaliseName(name).split(' ')[0]!)) {
    return true;
  }
  // Full names, titles left out; a description such as "the old man" is none.
  const full = names
    .map(untitledWords)
    .filter((words) => words.length > 1 && !DESCRIPTION_STARTS.has(words[0]!));
  return full.length === 0 || full.some((words) => words.slice(1).includes(family));
}

/** "I", "the narrator", "yo"…: what a model may call a teller, which is not a name. */
function isPlaceholder(name: string): boolean {
  return NARRATOR_PLACEHOLDERS.has(normaliseName(name));
}

/** The words of a name, titles left out ("Miss Jane Fairfax": jane, fairfax). */
function untitledWords(name: string): string[] {
  return normaliseName(name)
    .split(' ')
    .filter((w) => w && !TITLE_WORDS.has(w));
}

/** A full name as matchCast reads one: two or more words, not starting with a title. */
function isFullName(name: string): boolean {
  const words = normaliseName(name).split(' ');
  return words.length > 1 && !TITLE_WORDS.has(words[0]!);
}

/**
 * Whether `name` is a full name of someone other than a proposal called by the words `own`, when
 * only `word`, one of those words, links them: as in matchCast's rule 3, it has another surname
 * when `word` is the first name ("Jane Bennet" for "Jane" of "Jane Fairfax"), another first name
 * when `word` is the surname, and either when `word` is in between.
 */
function disagrees(name: string, own: readonly string[], word: string): boolean {
  if (!isFullName(name)) return false;
  const words = untitledWords(name);
  return (
    (word !== own[0] && words[0] !== own[0]) || (word !== own.at(-1) && words.at(-1) !== own.at(-1))
  );
}

/** The words of a name that identify someone: no titles and no joining words ("de", "y"). */
function nameWords(name: string): string[] {
  return untitledWords(name).filter((w) => !NAME_JOINERS.has(w));
}

/**
 * Whether a name fits N's names: it shares a word with one of them ("Dr. Watson" and "John
 * Watson"), or one of the two is a single word of the other ("Della" and "Della Street"), and as
 * a full name it keeps the first name of every full name N has, as matchCast's rule 3 does ("Amy
 * Dunne" is not "Nick Dunne", "Pedro de Valdivia" is not "Inés de Suárez").
 */
function fitsNames(own: readonly string[], name: string): boolean {
  const wanted = nameWords(name);
  const names = own.map(nameWords).filter((words) => words.length > 0);
  const shares =
    names.some((words) => words.some((w) => wanted.includes(w))) ||
    own.some((n) => isWordOf(n, name) || isWordOf(name, n));
  if (!shares) return false;
  return wanted.length < 2 || names.every((words) => words.length < 2 || words[0] === wanted[0]);
}

/**
 * Whether `word`, titles left out, is one word that `name` has with a capital: a first name such
 * as "Della" or "Van" is a joining word only in lower case ("de Winter").
 */
function isWordOf(word: string, name: string): boolean {
  const [only, ...rest] = untitledWords(word);
  return (
    only !== undefined &&
    rest.length === 0 &&
    name.split(/\s+/u).some((w) => /^\p{Lu}/u.test(w) && normaliseName(w) === only)
  );
}

/** Whether a name starts with a capital letter, or does after a lower-case title ("doña Inés"). */
function startsCapitalised(name: string): boolean {
  const [first = '', second] = name.split(/\s+/u);
  if (/^\p{Lu}/u.test(first)) return true;
  const titled = second !== undefined && TITLE_WORDS.has(first.replace(/\.$/u, '').toLowerCase());
  return titled && /^\p{Lu}/u.test(second);
}

function sameSpeaker(a: SpeakerRef, b: SpeakerRef): boolean {
  return a.kind === 'cast'
    ? b.kind === 'cast' && a.id === b.id
    : b.kind === 'new' && a.ref === b.ref;
}

/** Narration, or a letter or diary entry: text whose speaker tells that stretch. */
function isTelling(span: SpanLabel): boolean {
  return span.mode === 'narration' || span.mode === 'written';
}

/** The first k below `length` where `before(k)` is false, for a `before` true up to some k only. */
function partitionPoint(length: number, before: (k: number) => boolean): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (before(middle)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function toTone(tone: LlmSpan['tone']): Tone | undefined {
  if (!tone || !(TONE_LABELS as readonly string[]).includes(tone.label)) return undefined;
  if (tone.label === 'neutral') return undefined;
  const intensity = tone.intensity;
  return intensity === 1 || intensity === 2 || intensity === 3
    ? { label: tone.label, intensity }
    : { label: tone.label };
}
