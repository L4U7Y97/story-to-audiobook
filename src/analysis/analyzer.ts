import type { Analysis, Character } from '@/format/types';
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

export interface AnalyzeOptions {
  /** Device voices used to give new characters distinct voices. */
  voices: readonly DeviceVoice[];
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Analyses a part and stores the result with any new characters. Runs one analysis at a time so
 * that parts analysed in parallel see each other's characters.
 */
export function analyzePart(db: StoryDb, partId: string, options: AnalyzeOptions): Promise<void> {
  const run = queue.then(() => runAnalysis(db, partId, options));
  queue = run.catch(() => undefined);
  return run;
}

async function runAnalysis(db: StoryDb, partId: string, options: AnalyzeOptions): Promise<void> {
  const part = await getPart(db, partId);
  if (!part) return;
  const story = await getStory(db, part.storyId);
  if (!story) return;

  await setAnalysisStatus(db, partId, 'running');
  try {
    const units = splitUnits(part.text, story.lang, part.hints);
    const labels = analyzeHeuristic({ text: part.text, lang: story.lang, units, cast: story.cast });
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
      analyzer: { kind: 'heuristic', version: HEURISTIC_VERSION },
      createdAt: now(),
      segments,
    };
    await saveAnalysis(db, analysis, {
      added: voiced,
      aliasAdditions: labels.aliasAdditions,
    });
  } catch (error) {
    await setAnalysisStatus(db, partId, 'failed');
    throw error;
  }
}
