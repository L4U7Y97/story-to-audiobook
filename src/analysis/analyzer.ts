import type { Analysis, Character, Story } from '@/format/types';
import { assignVoices } from '@/cast/assignVoices';
import type { DeviceVoice } from '@/playback/engine';
import type { StoryDb } from '@/storage/db';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { getPart, setAnalysisStatus } from '@/storage/parts';
import { defaultLocale, getStory } from '@/storage/stories';
import { newId, now } from '@/storage/ids';
import { analyzeHeuristic, HEURISTIC_VERSION } from './heuristic';
import { mergeLabels } from './merge';
import { applyUserCorrections } from './reassign';
import { splitUnits } from './units';
import type { Effort, LlmResponse, LlmTransport } from './llm/client';
import { analyzeLlm, LLM_VERSION } from './llm';

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
    const cacheKey = llm && `${part.textHash}:${llm.model}:${llm.effort}`;
    if (llm) {
      const result = await analyzeLlm({
        text: part.text,
        lang: story.lang,
        units,
        cast: story.cast,
        heuristic,
        previous: await previousLines(db, story, partId),
        ...llm,
        cache: llmCache,
        cacheKey,
        onProgress: options.onProgress,
      });
      labels = result.labels;
      const kind = result.fallbackUnits > 0 ? 'mixed' : 'llm';
      analyzer = { kind, model: llm.model, version: LLM_VERSION };
      report = { kind, fallbackUnits: result.fallbackUnits, usage: result.usage };
    }

    const merged = mergeLabels(part.text, labels, story.cast, part.id, newId);
    const added = merged.cast.filter((c) => merged.newCharacterIds.includes(c.id));
    const voiced: Character[] = assignVoices(
      added,
      story.cast,
      options.voices,
      defaultLocale(story.lang),
    );

    // Manual speaker corrections survive a re-analysis of the same text.
    const previous = await getAnalysis(db, partId);
    const speakers = new Set([...story.cast, ...voiced].map((c) => c.id));
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
    if (cacheKey) {
      for (const key of [...llmCache.keys()]) if (key.startsWith(cacheKey)) llmCache.delete(key);
    }
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
