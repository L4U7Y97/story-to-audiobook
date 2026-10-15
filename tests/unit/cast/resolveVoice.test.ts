import { describe, expect, it } from 'vitest';
import { resolveVoice } from '@/cast/resolveVoice';
import type { DeviceVoice } from '@/playback/engine';

const desktop: DeviceVoice[] = [
  { name: 'Microsoft Helena - Spanish (Spain)', lang: 'es-ES' },
  { name: 'Google español de Estados Unidos', lang: 'es-US', network: true },
  { name: 'Microsoft Sabina - Spanish (Mexico)', lang: 'es-MX', isDefault: true },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
];
const voice = { voiceName: 'es-es-x-eee-local', lang: 'es-ES', pitch: 0.85, rate: 1.1 };

describe('resolveVoice', () => {
  it('uses the chosen voice when the device has it', () => {
    expect(
      resolveVoice({ ...voice, voiceName: 'Microsoft Zira - English (United States)' }, desktop),
    ).toEqual({
      voiceName: 'Microsoft Zira - English (United States)',
      lang: 'es-ES',
      substituted: false,
    });
  });

  it('substitutes a missing voice with the best one for the same locale', () => {
    // An Android voice name on a desktop browser: same locale (es-ES) beats the default es-MX.
    expect(resolveVoice(voice, desktop)).toEqual({
      voiceName: 'Microsoft Helena - Spanish (Spain)',
      lang: 'es-ES',
      substituted: true,
    });
  });

  it('falls back to the same language, preferring the default and offline voices', () => {
    expect(resolveVoice({ ...voice, lang: 'es-AR' }, desktop).voiceName).toBe(
      'Microsoft Sabina - Spanish (Mexico)',
    );
    const noDefault = desktop.map((v) => ({ ...v, isDefault: false }));
    expect(resolveVoice({ ...voice, lang: 'es_AR' }, noDefault).voiceName).toBe(
      'Microsoft Helena - Spanish (Spain)',
    );
  });

  it('leaves the language to the engine when no voice matches, still flagging the substitution', () => {
    expect(resolveVoice({ ...voice, lang: 'fr-FR' }, desktop)).toEqual({
      lang: 'fr-FR',
      substituted: true,
    });
  });

  it('does not report a substitution for "device default" voices or an unknown voice list', () => {
    expect(resolveVoice({ ...voice, voiceName: undefined }, desktop).substituted).toBe(false);
    expect(resolveVoice(voice, [])).toEqual({ lang: 'es-ES', substituted: false });
  });
});
