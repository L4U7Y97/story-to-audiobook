import { Preferences } from '@capacitor/preferences';

/**
 * The character pairs a user said are not the same person (pairKey), per story, so the Cast page
 * stops suggesting merging them. Kept on this device with the settings, out of story exports:
 * it only quiets suggestions, so losing it on another device costs nothing.
 */
const key = (storyId: string) => `cast-not-same:${storyId}`;

export async function getNotSame(storyId: string): Promise<Set<string>> {
  const { value } = await Preferences.get({ key: key(storyId) });
  if (!value) return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    return new Set(Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : []);
  } catch {
    return new Set();
  }
}

export async function addNotSame(storyId: string, pair: string): Promise<Set<string>> {
  const pairs = await getNotSame(storyId);
  pairs.add(pair);
  await Preferences.set({ key: key(storyId), value: JSON.stringify([...pairs]) });
  return pairs;
}

/** Takes back a "Not the same" (its Undo). */
export async function removeNotSame(storyId: string, pair: string): Promise<Set<string>> {
  const pairs = await getNotSame(storyId);
  pairs.delete(pair);
  await Preferences.set({ key: key(storyId), value: JSON.stringify([...pairs]) });
  return pairs;
}
