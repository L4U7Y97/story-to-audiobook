import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, getSetting, setSetting } from '@/storage/settings';

beforeEach(() => {
  localStorage.clear();
});

describe('settings', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await getSetting('model')).toBe(DEFAULT_SETTINGS.model);
    expect(await getSetting('effort')).toBe('low');
  });

  it('round-trips values', async () => {
    await setSetting('speed', 1.25);
    await setSetting('theme', 'dark');
    expect(await getSetting('speed')).toBe(1.25);
    expect(await getSetting('theme')).toBe('dark');
  });
});
