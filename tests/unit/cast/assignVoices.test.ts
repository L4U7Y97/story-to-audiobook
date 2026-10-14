import { describe, expect, it } from 'vitest';
import type { Character } from '@/format/types';
import { assignVoice, assignVoices } from '@/cast/assignVoices';
import type { DeviceVoice } from '@/playback/engine';
import { baseCast } from '../../helpers/fixtures';

const voices: DeviceVoice[] = [
  { name: 'es-default', lang: 'es-ES', isDefault: true },
  { name: 'es-two', lang: 'es-US' },
  { name: 'es-cloud', lang: 'es-ES', network: true },
  { name: 'en-one', lang: 'en-GB' },
];

const newChar = (id: string, gender?: Character['gender']) => ({
  id,
  role: 'character' as const,
  name: id,
  aliases: [],
  ...(gender ? { gender } : {}),
});

const combo = (c: Character) => `${c.voice.voiceName}|${c.voice.pitch}|${c.voice.rate}`;

describe('assignVoice', () => {
  it('gives the narrator the default voice at neutral pitch and rate', () => {
    expect(assignVoice({ id: 'n', role: 'narrator' }, [], voices, 'es-ES')).toEqual({
      voiceName: 'es-default',
      lang: 'es-ES',
      pitch: 1,
      rate: 1,
    });
  });

  it('gives characters an offline voice of the story language other than the narrator’s', () => {
    const v = assignVoice({ id: 'c', role: 'character' }, [], voices, 'es-ES');
    expect(v.voiceName).toBe('es-two');
    expect(v.lang).toBe('es-US');
  });

  it('falls back to the story locale with no matching voices', () => {
    const v = assignVoice({ id: 'c', role: 'character' }, [], [], 'es-ES');
    expect(v.voiceName).toBeUndefined();
    expect(v.lang).toBe('es-ES');
  });

  it('pitches female characters higher than male ones on average', () => {
    const pitch = (gender: 'male' | 'female') =>
      Array.from(
        { length: 20 },
        (_, i) =>
          assignVoice({ id: `${gender}${i}`, role: 'character', gender }, [], [], 'en-US').pitch,
      ).reduce((a, b) => a + b) / 20;
    expect(pitch('female')).toBeGreaterThan(pitch('male'));
  });

  it('is deterministic', () => {
    const a = assignVoice({ id: 'x', role: 'character' }, [], voices, 'es-ES');
    expect(assignVoice({ id: 'x', role: 'character' }, [], voices, 'es-ES')).toEqual(a);
  });
});

describe('assignVoices', () => {
  it('keeps every (voice, pitch, rate) distinct with one device voice and ten characters', () => {
    const oneVoice: DeviceVoice[] = [{ name: 'only', lang: 'en-US', isDefault: true }];
    const cast = baseCast('en').map((c) => ({
      ...c,
      voice: assignVoice(c, [], oneVoice, 'en-US'),
    }));
    const added = assignVoices(
      Array.from({ length: 10 }, (_, i) => newChar(`c${i}`, i % 2 ? 'male' : 'female')),
      cast,
      oneVoice,
      'en-US',
    );
    const all = [...cast, ...added];
    expect(all).toHaveLength(12);
    expect(new Set(all.map(combo)).size).toBe(12);
    expect(all.every((c) => c.voice.pitch >= 0.75 && c.voice.pitch <= 1.3)).toBe(true);
  });

  it('rotates characters through the available voices', () => {
    const added = assignVoices(
      [newChar('a'), newChar('b'), newChar('c')],
      baseCast('es'),
      [...voices, { name: 'es-three', lang: 'es-MX' }],
      'es-ES',
    );
    expect(added.map((c) => c.voice.voiceName)).toEqual(['es-two', 'es-three', 'es-two']);
  });
});
