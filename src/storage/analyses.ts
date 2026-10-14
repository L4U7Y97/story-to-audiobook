import type { Analysis } from '@/format/types';
import { validateAnalysis } from '@/format/validate';
import type { StoryDb } from './db';

export class AnalysisRejectedError extends Error {
  constructor(
    readonly partId: string,
    readonly reason: string,
  ) {
    super(`analysis for part ${partId} rejected: ${reason}`);
    this.name = 'AnalysisRejectedError';
  }
}

/**
 * Stores an analysis only if it is valid for the part's current text and the story's cast.
 * This is the single gate that enforces "the story text never changes" at the storage level.
 */
export async function saveAnalysis(db: StoryDb, analysis: Analysis): Promise<void> {
  await db.transaction('rw', db.stories, db.parts, db.analyses, async () => {
    const part = await db.parts.get(analysis.partId);
    if (!part) throw new AnalysisRejectedError(analysis.partId, 'part not found');
    const story = await db.stories.get(part.storyId);
    if (!story) throw new AnalysisRejectedError(analysis.partId, 'story not found');

    const result = validateAnalysis(part, analysis, new Set(story.cast.map((c) => c.id)));
    if (!result.ok) throw new AnalysisRejectedError(analysis.partId, result.reason);

    await db.analyses.put(analysis);
    await db.parts.update(part.id, { analysisStatus: 'done' });
  });
}

export async function getAnalysis(db: StoryDb, partId: string): Promise<Analysis | undefined> {
  return db.analyses.get(partId);
}
