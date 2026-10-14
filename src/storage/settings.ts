import { Preferences } from '@capacitor/preferences';

/**
 * Small app settings, kept out of IndexedDB so they never end up in story exports.
 * On Android this is SharedPreferences; on the web, localStorage.
 */
export interface Settings {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  speed: number;
  theme: 'system' | 'light' | 'dark';
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'claude-haiku-5-5',
  effort: 'low',
  speed: 1,
  theme: 'system',
};

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  const { value } = await Preferences.get({ key });
  if (value === null) return DEFAULT_SETTINGS[key];
  try {
    return JSON.parse(value) as Settings[K];
  } catch {
    return DEFAULT_SETTINGS[key];
  }
}

export async function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<void> {
  await Preferences.set({ key, value: JSON.stringify(value) });
}

export async function getAllSettings(): Promise<Settings> {
  const keys = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>;
  const values = await Promise.all(keys.map((k) => getSetting(k)));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as unknown as Settings;
}
