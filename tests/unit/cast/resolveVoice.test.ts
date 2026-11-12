import { describe, expect, it } from 'vitest';
import { bestVoiceFor, resolveVoice } from '@/cast/resolveVoice';
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

  describe('with a missing voice whose name tells its gender', () => {
    const zira = 'Microsoft Zira - English (United States)';
    const david = 'Microsoft David - English (United States)';
    const english: DeviceVoice[] = [
      { name: zira, lang: 'en-US', isDefault: true },
      { name: 'Google UK English Male', lang: 'en-GB', network: true },
      { name: 'en-plain', lang: 'en-US' },
    ];
    const missing = (voiceName: string) => ({ voiceName, lang: 'en-US', pitch: 1, rate: 1 });

    it('substitutes a voice of the same gender before a better-ranked one', () => {
      // A male voice saved on another device: the British network man beats the local default.
      expect(resolveVoice(missing(david), english)).toEqual({
        voiceName: 'Google UK English Male',
        lang: 'en-GB',
        substituted: true,
      });
      expect(resolveVoice(missing('Samantha'), english).voiceName).toBe(zira);
    });

    it('ranks the voices of that gender as before: locale, then default, then offline', () => {
      const men: DeviceVoice[] = [
        ...english,
        { name: 'Microsoft George - English (United Kingdom)', lang: 'en-GB' },
        { name: 'Microsoft Mark - English (United States)', lang: 'en-US', network: true },
      ];
      expect(resolveVoice(missing(david), men).voiceName).toBe(
        'Microsoft Mark - English (United States)',
      );
    });

    it('falls back to the best voice when none has that gender, or the gender is unknown', () => {
      const women = english.filter((v) => v.name !== 'Google UK English Male');
      expect(resolveVoice(missing(david), women).voiceName).toBe(zira);
      expect(resolveVoice(missing('en-other-device'), english).voiceName).toBe(zira);
    });

    it('never looks at the gender of a voice the device has', () => {
      expect(resolveVoice(missing('en-plain'), english)).toEqual({
        voiceName: 'en-plain',
        lang: 'en-US',
        substituted: false,
      });
    });
  });
});

describe('bestVoiceFor', () => {
  it('prefers the same locale, then the system default, then offline voices', () => {
    expect(bestVoiceFor('es-ES', desktop)?.name).toBe('Microsoft Helena - Spanish (Spain)');
    expect(bestVoiceFor('es-AR', desktop)?.name).toBe('Microsoft Sabina - Spanish (Mexico)');
    expect(bestVoiceFor('es_US', desktop)?.name).toBe('Google español de Estados Unidos');
    const offlineFirst: DeviceVoice[] = [
      { name: 'cloud', lang: 'es-CL', network: true },
      { name: 'local', lang: 'es-CO' },
    ];
    expect(bestVoiceFor('es-ES', offlineFirst)?.name).toBe('local');
  });

  it('keeps the device order among equally good voices', () => {
    const equal: DeviceVoice[] = [
      { name: 'first', lang: 'en-GB' },
      { name: 'second', lang: 'en-GB' },
    ];
    expect(bestVoiceFor('en-GB', equal)?.name).toBe('first');
  });

  it('finds nothing without a voice of the language', () => {
    expect(bestVoiceFor('fr-FR', desktop)).toBeUndefined();
    expect(bestVoiceFor('es-ES', [])).toBeUndefined();
  });
});
