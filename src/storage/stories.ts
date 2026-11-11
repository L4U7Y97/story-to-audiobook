import { SCHEMA_VERSION, type Character, type Lang, type Story } from '@/format/types';
import { NARRATOR_NAME, UNKNOWN_NAME } from '@/analysis/castMatch';
import type { StoryDb } from './db';
import { newId, now } from './ids';

const DEFAULT_LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-ES' };

export function defaultLocale(lang: Lang): string {
  return DEFAULT_LOCALE[lang];
}

/** Creates a story with its two built-in characters: the narrator and the "unknown" speaker. */
export async function createStory(
  db: StoryDb,
  input: { title: string; lang: Lang },
): Promise<Story> {
  const locale = defaultLocale(input.lang);
  const narrator: Character = {
    id: newId(),
    role: 'narrator',
    name: NARRATOR_NAME[input.lang],
    aliases: [],
    voice: { lang: locale, pitch: 1, rate: 1 },
  };
  const unknown: Character = {
    id: newId(),
    role: 'unknown',
    name: UNKNOWN_NAME[input.lang],
    aliases: [],
    voice: { lang: locale, pitch: 1.15, rate: 1 },
  };
  const timestamp = now();
  const story: Story = {
    id: newId(),
    schemaVersion: SCHEMA_VERSION,
    title: input.title.trim() || (input.lang === 'es' ? 'Sin título' : 'Untitled'),
    lang: input.lang,
    partIds: [],
    cast: [narrator, unknown],
    narratorId: narrator.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await db.stories.add(story);
  return story;
}

export async function getStory(db: StoryDb, id: string): Promise<Story | undefined> {
  return db.stories.get(id);
}

/** Most recently updated first. */
export async function listStories(db: StoryDb): Promise<Story[]> {
  return db.stories.orderBy('updatedAt').reverse().toArray();
}

export type StoryChanges = Partial<Pick<Story, 'title' | 'lang' | 'cast' | 'position'>>;

export async function updateStory(db: StoryDb, id: string, changes: StoryChanges): Promise<void> {
  const updated = await db.stories.update(id, { ...changes, updatedAt: now() });
  if (!updated) throw new Error(`story ${id} not found`);
}

/** Deletes a story with all its parts and analyses. */
export async function deleteStory(db: StoryDb, id: string): Promise<void> {
  await db.transaction('rw', db.stories, db.parts, db.analyses, async () => {
    const partIds = await db.parts.where('storyId').equals(id).primaryKeys();
    await db.analyses.bulkDelete(partIds);
    await db.parts.bulkDelete(partIds);
    await db.stories.delete(id);
  });
}
