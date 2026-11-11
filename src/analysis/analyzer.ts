import type { Analysis, Character, Story } from '@/format/types';
import { assignVoices } from '@/cast/assignVoices';
import type { DeviceVoice } from '@/playback/engine';
import type { StoryDb } from '@/storage/db';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { getPart, setAnalysisStatus } from '@/storage/parts';
import { defaultLocale, getStory } from '@/storage/stories';
import { newId, now } from '@/storage/ids';
import { matchCast, normaliseName, type CastEntry } from './castMatch';
import { analyzeHeuristic, HEURISTIC_VERSION } from './heuristic';
import type { AliasAddition, LabelResult } from './labels';
import { mergeLabels } from './merge';
import { applyUserCorrections } from './reassign';
import { splitUnits } from './units';
import type { Effort, LlmResponse, LlmTransport } from './llm/client';
import { analyzeLlm, LLM_VERSION, matchProposal } from './llm';
import { narratorStyleOf } from './llm/prompt';

export interface AnalyzeOptions {
  /** Device voices used to give new characters distinct voices. */
  voices: readonly DeviceVoice[];
  /** Analyse with Claude; without it the free heuristic is used. */
  llm?: { transport: LlmTransport; model: string; effort: Effort };
  /** Called as each LLM request finishes. */
  onProgress?: (done: number, total: number) => void;
}

export interface AnalyzeReport {
  kind: Analysis['analyzer']['kind'];
  /** Units the heuristic labelled because the model's answer for them was unusable. */
  fallbackUnits: number;
  usage?: { inputTokens: number; outputTokens: number };
}

let queue: Promise<unknown> = Promise.resolve();

/** Finished LLM responses, kept until the part is stored so a retry resumes where it failed. */
const llmCache = new Map<string, LlmResponse>();

/**
 * Analyses a part and stores the result with any new characters. Runs one analysis at a time so
 * that parts analysed in parallel see each other's characters.
 */
export function analyzePart(
  db: StoryDb,
  partId: string,
  options: AnalyzeOptions,
): Promise<AnalyzeReport | undefined> {
  const run = queue.then(() => runAnalysis(db, partId, options));
  queue = run.catch(() => undefined);
  return run;
}

async function runAnalysis(
  db: StoryDb,
  partId: string,
  options: AnalyzeOptions,
): Promise<AnalyzeReport | undefined> {
  const part = await getPart(db, partId);
  if (!part) return undefined;
  const story = await getStory(db, part.storyId);
  if (!story) return undefined;

  await setAnalysisStatus(db, partId, 'running');
  try {
    const units = splitUnits(part.text, story.lang, part.hints);
    const heuristic = analyzeHeuristic({
      text: part.text,
      lang: story.lang,
      units,
      cast: story.cast,
    });

    let labels = heuristic;
    let analyzer: Analysis['analyzer'] = { kind: 'heuristic', version: HEURISTIC_VERSION };
    let report: AnalyzeReport = { kind: 'heuristic', fallbackUnits: 0 };
    const llm = options.llm;
    if (llm) {
      // Cached answers name speakers by cast codes, which mean the same only with the same cast.
      const signature = castSignature(story.cast);
      const result = await analyzeLlm({
        text: part.text,
        lang: story.lang,
        units,
        cast: story.cast,
        heuristic,
        previous: await previousLines(db, story, partId),
        narratorStyle: await narratorStyle(db, story, partId),
        ...llm,
        cache: llmCache,
        cacheKey: `${part.id}:${part.textHash}:${llm.model}:${llm.effort}:${LLM_VERSION}:${signature}`,
        onProgress: options.onProgress,
      });
      labels = result.labels;
      const kind = result.fallbackUnits > 0 ? 'mixed' : 'llm';
      analyzer = { kind, model: llm.model, version: LLM_VERSION };
      report = { kind, fallbackUnits: result.fallbackUnits, usage: result.usage };
    }

    // The cast may have changed while the analyser ran (a merge, a character made in the Reader).
    const latest = (await getStory(db, story.id)) ?? story;
    labels = forLatestCast(labels, story.cast, latest.cast);
    const merged = mergeLabels(part.text, labels, latest.cast, part.id, newId);
    const added = merged.cast.filter((c) => merged.newCharacterIds.includes(c.id));
    const voiced: Character[] = assignVoices(
      added,
      latest.cast,
      options.voices,
      defaultLocale(story.lang),
    );

    // Manual speaker corrections survive a re-analysis of the same text.
    const previous = await getAnalysis(db, partId);
    const speakers = new Set([...latest.cast, ...voiced].map((c) => c.id));
    const segments =
      previous?.textHash === part.textHash
        ? applyUserCorrections(part.text, merged.segments, previous.segments, speakers)
        : merged.segments;

    const analysis: Analysis = {
      partId,
      textHash: part.textHash,
      analyzer,
      createdAt: now(),
      segments,
    };
    await saveAnalysis(db, analysis, {
      added: voiced,
      aliasAdditions: labels.aliasAdditions,
    });
    for (const key of [...llmCache.keys()]) if (key.startsWith(`${part.id}:`)) llmCache.delete(key);
    return report;
  } catch (error) {
    await setAnalysisStatus(db, partId, 'failed');
    throw error;
  }
}

/** The last labelled lines of the previous part, so the model knows who was talking. */
async function previousLines(db: StoryDb, story: Story, partId: string) {
  const index = story.partIds.indexOf(partId);
  const previousId = index > 0 ? story.partIds[index - 1] : undefined;
  if (!previousId) return [];
  const [part, analysis] = await Promise.all([
    getPart(db, previousId),
    getAnalysis(db, previousId),
  ]);
  if (!part || !analysis || analysis.textHash !== part.textHash) return [];
  return analysis.segments
    .map((s) => ({ speakerId: s.speakerId, mode: s.mode, text: part.text.slice(s.start, s.end) }))
    .filter((line) => /\p{L}/u.test(line.text))
    .slice(-20);
}

/** How the narrator told the story's other analysed parts (not this one, which may be redone). */
async function narratorStyle(db: StoryDb, story: Story, partId: string) {
  const others = story.partIds.filter((id) => id !== partId);
  const analyses = (await db.analyses.bulkGet(others)).filter(
    (a): a is Analysis => a !== undefined,
  );
  return narratorStyleOf(analyses, story.narratorId);
}

/** An FNV-1a hash of the members' ids and roles in order: what the prompt's cast codes stand for. */
function castSignature(cast: readonly Character[]): string {
  const key = cast.map((c) => `${c.id}:${c.role}`).join(',');
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * The labels for the story's latest cast. A member merged away while the analyser ran is found
 * again by its old name or aliases, which the merge gave to the member it went into; alias
 * additions for a member that is gone are dropped. A character the analyser found that names a
 * member added or renamed meanwhile (the Reader's "New character", a Cast-view edit) is that
 * member, as it would have been had the member been there from the start (see matchProposal).
 */
function forLatestCast(
  labels: LabelResult,
  before: readonly Character[],
  latest: readonly Character[],
): LabelResult {
  const ids = new Set(latest.map((c) => c.id));
  const entries: CastEntry[] = latest.map((c) => ({
    key: c.id,
    name: c.name,
    aliases: [...c.aliases],
    gender: c.gender,
    role: c.role,
  }));
  const moved = new Map<string, string>();
  for (const c of before) {
    if (ids.has(c.id)) continue;
    const into = [c.name, ...c.aliases]
      .map((n) => matchCast(n, entries))
      .find((e) => e !== undefined);
    if (into) moved.set(c.id, into.key);
  }
  const idOf = (id: string) => moved.get(id) ?? id;

  // Members whose names are not what the analyser saw, new members included.
  const names = (c: Character) => [c.name, ...c.aliases].map(normaliseName).sort().join('\n');
  const seen = new Map(before.map((c) => [c.id, names(c)]));
  const changed = new Set(latest.filter((c) => seen.get(c.id) !== names(c)).map((c) => c.id));
  const found = new Map<string, string>();
  const learned: AliasAddition[] = [];
  for (const c of labels.newCharacters) {
    const member = matchProposal(c.name, c.aliases, entries);
    if (!member || !changed.has(member.key)) continue;
    found.set(c.ref, member.key);
    // The member learns its other names, as in a run (a character only: N's names are guarded).
    if (member.role !== 'character') continue;
    for (const n of [c.name, ...c.aliases]) {
      if (!matchCast(n, entries)) learned.push({ characterId: member.key, alias: n });
    }
  }

  return {
    spans: labels.spans.map((s) => {
      const id = s.speaker.kind === 'cast' ? moved.get(s.speaker.id) : found.get(s.speaker.ref);
      return id ? { ...s, speaker: { kind: 'cast' as const, id } } : s;
    }),
    newCharacters: labels.newCharacters.filter((c) => !found.has(c.ref)),
    aliasAdditions: [
      ...labels.aliasAdditions.map((a) => ({ ...a, characterId: idOf(a.characterId) })),
      ...learned,
    ].filter((a) => ids.has(a.characterId)),
  };
}
