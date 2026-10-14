import { TONE_LABELS, type Character, type Lang, type Mode, type Tone } from '@/format/types';
import { matchCast, normaliseName, type CastEntry } from '../castMatch';
import type { AliasAddition, LabelResult, NewCharacter, SpanLabel, SpeakerRef } from '../labels';
import type { Unit } from '../units';
import { chunkUnits, DEFAULT_CHUNK_LIMITS, type ChunkLimits } from './chunking';
import type { Effort, LlmResponse, LlmTransport } from './client';
import { buildUserPrompt, SYSTEM_PROMPT, type ContextLine, type PromptCharacter } from './prompt';
import { LLM_OUTPUT_FORMAT, readLlmOutput, type LlmSpan, type LlmUnitLabel } from './schema';

/** Bump when the prompt or the conversion rules change. */
export const LLM_VERSION = 1;

const CONTEXT_UNITS = 20;
const MAX_OUTPUT_TOKENS = 16000;
/** Below this size a truncated chunk is not split again; its units use the heuristic. */
const MIN_SPLIT_UNITS = 8;

export interface LlmAnalyzeInput {
  text: string;
  lang: Lang;
  units: readonly Unit[];
  cast: readonly Character[];
  /** The heuristic's labels for the same units: the fallback for anything the model gets wrong. */
  heuristic: LabelResult;
  /** Labelled lines from the end of the previous part, as context for the first chunk. */
  previous?: ReadonlyArray<{ speakerId: string; mode: Mode; text: string }>;
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
}

/**
 * Labels a part with Claude. The model only ever names speakers and (when it splits a unit)
 * repeats unit text; offsets always come from walking the original text, and any unit whose
 * answer is missing, malformed or doesn't match the text takes its heuristic label instead.
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
  private readonly usage = { inputTokens: 0, outputTokens: 0 };
  private context: ContextLine[] = [];

  constructor(private readonly input: LlmAnalyzeInput) {
    let n = 0;
    for (const c of input.cast) {
      const code = c.role === 'narrator' ? 'N' : c.role === 'unknown' ? 'U' : `c${++n}`;
      this.speakers.set(code, {
        ref: { kind: 'cast', id: c.id },
        entry: { key: code, name: c.name, aliases: [...c.aliases], gender: c.gender, role: c.role },
      });
      this.codeOfId.set(c.id, code);
    }
    this.context = (input.previous ?? []).slice(-CONTEXT_UNITS).map((line) => ({
      code: this.codeOfId.get(line.speakerId) ?? 'U',
      mode: line.mode,
      text: line.text,
    }));
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
    if (response.stopReason === 'refusal') return; // the whole chunk uses the heuristic
    if (response.stopReason === 'max_tokens' && chunk.length >= MIN_SPLIT_UNITS) {
      const half = Math.ceil(chunk.length / 2);
      await this.labelChunk(chunk.slice(0, half), `${key}a`);
      await this.labelChunk(chunk.slice(half), `${key}b`);
      return;
    }
    this.apply(chunk, response.text);
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

  private promptCharacter({ entry }: Speaker): PromptCharacter {
    const description =
      this.input.cast.find((c) => this.codeOfId.get(c.id) === entry.key)?.description ??
      this.newCharacters.find((c) => c.ref === entry.key)?.description;
    return {
      code: entry.key,
      name: entry.name,
      role: entry.role,
      aliases: entry.aliases,
      ...(entry.gender ? { gender: entry.gender } : {}),
      ...(description ? { description } : {}),
    };
  }

  private apply(chunk: Unit[], raw: string): void {
    const output = readLlmOutput(raw);
    const local = this.registerNewCharacters(output.newCharacters);
    this.registerAliases(output.aliasAdditions);

    const byId = new Map<number, LlmUnitLabel>();
    for (const u of output.units) if (!byId.has(u.id)) byId.set(u.id, u);

    chunk.forEach((unit, i) => {
      const label = byId.get(i);
      const spans = label && this.toSpans(unit, label.spans, local);
      if (spans) this.labels.set(unit.index, spans);
    });

    const labelled = chunk.filter((u) => this.labels.has(u.index));
    this.context = [
      ...this.context,
      ...labelled.map((u) => {
        const first = this.labels.get(u.index)![0]!;
        return {
          code: this.codeOf(first.speaker),
          mode: first.mode,
          text: this.input.text.slice(u.start, u.end),
        };
      }),
    ].slice(-CONTEXT_UNITS);
  }

  /** Adds the model's new characters, mapping names that match the cast to the existing entry. */
  private registerNewCharacters(
    proposed: ReturnType<typeof readLlmOutput>['newCharacters'],
  ): Map<string, Speaker> {
    const local = new Map<string, Speaker>();
    for (const c of proposed) {
      const name = c.name.trim();
      if (!name || this.speakers.has(c.ref) || local.has(c.ref)) continue;
      const entries = [...this.speakers.values()].map((s) => s.entry);
      const existing = [name, ...c.aliases]
        .map((n) => matchCast(n, entries))
        .find((e) => e !== undefined);
      if (existing) {
        local.set(c.ref, this.speakers.get(existing.key)!);
        continue;
      }
      const code = `x${this.newCharacters.length + 1}`;
      const aliases = [...new Set(c.aliases.map((a) => a.trim()).filter((a) => a && a !== name))];
      const created: NewCharacter = {
        ref: code,
        name,
        aliases,
        ...(c.gender ? { gender: c.gender } : {}),
        ...(c.description.trim() ? { description: c.description.trim() } : {}),
      };
      this.newCharacters.push(created);
      const speaker: Speaker = {
        ref: { kind: 'new', ref: code },
        entry: { key: code, name, aliases, gender: c.gender, role: 'character' },
      };
      this.speakers.set(code, speaker);
      local.set(c.ref, speaker);
    }
    return local;
  }

  private registerAliases(additions: ReturnType<typeof readLlmOutput>['aliasAdditions']): void {
    for (const { characterId, alias } of additions) {
      const speaker = this.speakers.get(characterId);
      const name = alias.trim();
      if (!speaker || speaker.entry.role !== 'character' || !name) continue;
      const known = [speaker.entry.name, ...speaker.entry.aliases].map(normaliseName);
      if (known.includes(normaliseName(name))) continue;
      speaker.entry.aliases.push(name);
      if (speaker.ref.kind === 'cast') {
        this.aliasAdditions.push({ characterId: speaker.ref.id, alias: name });
      } else {
        const ref = speaker.ref.ref;
        this.newCharacters.find((c) => c.ref === ref)?.aliases.push(name);
      }
    }
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
    const { units, heuristic } = this.input;
    const heuristicRefs = this.mapHeuristicCharacters();
    const spans: SpanLabel[] = [];
    let fallbackUnits = 0;
    for (const unit of units) {
      const llm = this.labels.get(unit.index);
      if (llm) {
        spans.push(...llm);
        continue;
      }
      fallbackUnits++;
      for (const s of heuristic.spans) {
        if (s.start < unit.start || s.end > unit.end) continue;
        spans.push(
          s.speaker.kind === 'new'
            ? { ...s, speaker: heuristicRefs.get(s.speaker.ref)! }
            : { ...s, speaker: s.speaker },
        );
      }
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
   * Heuristic characters used by fallback units join the model's characters: one with a matching
   * name reuses that entry, and the rest are added as new characters.
   */
  private mapHeuristicCharacters(): Map<string, SpeakerRef> {
    const refs = new Map<string, SpeakerRef>();
    for (const c of this.input.heuristic.newCharacters) {
      const entries = [...this.speakers.values()].map((s) => s.entry);
      const existing = matchCast(c.name, entries);
      if (existing) {
        refs.set(c.ref, this.speakers.get(existing.key)!.ref);
        continue;
      }
      const code = `x${this.newCharacters.length + 1}`;
      this.newCharacters.push({ ...c, ref: code, aliases: [...c.aliases] });
      const ref: SpeakerRef = { kind: 'new', ref: code };
      this.speakers.set(code, {
        ref,
        entry: {
          key: code,
          name: c.name,
          aliases: [...c.aliases],
          gender: c.gender,
          role: 'character',
        },
      });
      refs.set(c.ref, ref);
    }
    return refs;
  }
}

function toTone(tone: LlmSpan['tone']): Tone | undefined {
  if (!tone || !(TONE_LABELS as readonly string[]).includes(tone.label)) return undefined;
  if (tone.label === 'neutral') return undefined;
  const intensity = tone.intensity;
  return intensity === 1 || intensity === 2 || intensity === 3
    ? { label: tone.label, intensity }
    : { label: tone.label };
}
