import type { Analysis, Character } from '@/format/types';
import { validateAnalysis } from '@/format/validate';
import { normaliseName } from '@/analysis/castMatch';
import type { StoryDb } from './db';
import { now } from './ids';

export class AnalysisRejectedError extends Error {
  constructor(
    readonly partId: string,
    readonly reason: string,
  ) {
    super(`analysis for part ${partId} rejected: ${reason}`);
    this.name = 'AnalysisRejectedError';
  }
}

/** Cast changes produced by an analysis, applied to the story's latest cast when saving. */
export interface CastChanges {
  added: Character[];
  aliasAdditions: Array<{ characterId: string; alias: string }>;
}

/**
 * Stores an analysis only if it is valid for the part's current text and the story's cast
 * (after applying `castChanges`). This is the single gate that enforces "the story text never
 * changes" at the storage level. Cast changes and the analysis are written atomically.
 */
export async function saveAnalysis(
  db: StoryDb,
  analysis: Analysis,
  castChanges: CastChanges = { added: [], aliasAdditions: [] },
): Promise<void> {
  await db.transaction('rw', db.stories, db.parts, db.analyses, async () => {
    const part = await db.parts.get(analysis.partId);
    if (!part) throw new AnalysisRejectedError(analysis.partId, 'part not found');
    const story = await db.stories.get(part.storyId);
    if (!story) throw new AnalysisRejectedError(analysis.partId, 'story not found');

    const cast = applyCastChanges(story.cast, castChanges);
    const result = validateAnalysis(part, analysis, new Set(cast.map((c) => c.id)));
    if (!result.ok) throw new AnalysisRejectedError(analysis.partId, result.reason);

    if (cast !== story.cast) await db.stories.update(story.id, { cast, updatedAt: now() });
    await db.analyses.put(analysis);
    await db.parts.update(part.id, { analysisStatus: 'done' });
  });
}

/** Adds new characters, and each new alias a member is not yet known by (see normaliseName). */
function applyCastChanges(cast: Character[], changes: CastChanges): Character[] {
  if (!changes.added.length && !changes.aliasAdditions.length) return cast;
  const updated = cast.map((c) => {
    const known = new Set([c.name, ...c.aliases].map((n) => normaliseName(n)));
    const aliases: string[] = [];
    for (const { characterId, alias } of changes.aliasAdditions) {
      const key = normaliseName(alias);
      if (characterId !== c.id || known.has(key)) continue;
      known.add(key);
      aliases.push(alias);
    }
    return aliases.length ? { ...c, aliases: [...c.aliases, ...aliases] } : c;
  });
  const existing = new Set(updated.map((c) => c.id));
  return [...updated, ...changes.added.filter((c) => !existing.has(c.id))];
}

export async function getAnalysis(db: StoryDb, partId: string): Promise<Analysis | undefined> {
  return db.analyses.get(partId);
}
