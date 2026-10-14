import Dexie, { type EntityTable } from 'dexie';
import type { Analysis, Part, Story } from '@/format/types';

export type StoryDb = Dexie & {
  stories: EntityTable<Story, 'id'>;
  parts: EntityTable<Part, 'id'>;
  analyses: EntityTable<Analysis, 'partId'>;
};

export function openStoryDb(name = 'story-to-audiobook'): StoryDb {
  const db = new Dexie(name) as StoryDb;
  db.version(1).stores({
    stories: 'id, updatedAt',
    parts: 'id, storyId',
    analyses: 'partId',
  });
  return db;
}

let appDb: StoryDb | undefined;

/** The app's shared database. Tests open their own with openStoryDb(uniqueName). */
export function getAppDb(): StoryDb {
  appDb ??= openStoryDb();
  return appDb;
}

/** Asks the browser not to evict our data under storage pressure (spec risk R5). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
