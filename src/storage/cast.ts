import type { Analysis } from '@/format/types';
import { validateAnalysis } from '@/format/validate';
import { mergeCharacters } from '@/cast/castOps';
import type { StoryDb } from './db';
import { now } from './ids';

/**
 * Merges one character into another across the whole story in a single transaction: the cast and
 * every affected analysis are rewritten and re-validated, or nothing changes.
 */
export async function mergeCharactersInStory(
  db: StoryDb,
  storyId: string,
  fromId: string,
  intoId: string,
): Promise<void> {
  await db.transaction('rw', db.stories, db.parts, db.analyses, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw new Error(`story ${storyId} not found`);
    const analyses = (await db.analyses.bulkGet(story.partIds)).filter(
      (a): a is Analysis => a !== undefined,
    );

    const result = mergeCharacters(story.cast, analyses, fromId, intoId);
    if (!result.ok) throw new Error(result.reason);
    const { cast, analyses: updated } = result.value;

    const castIds = new Set(cast.map((c) => c.id));
    const changed = updated.filter((a, i) => a !== analyses[i]);
    for (const analysis of changed) {
      const part = await db.parts.get(analysis.partId);
      const check = part ? validateAnalysis(part, analysis, castIds) : { ok: true as const };
      if (!check.ok) throw new Error(`merge would break part ${analysis.partId}: ${check.reason}`);
    }

    await db.stories.update(storyId, { cast, updatedAt: now() });
    await db.analyses.bulkPut(changed);
  });
}
