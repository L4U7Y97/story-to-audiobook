import { describe, expect, it } from 'vitest';
import { bestVoiceFor, resolveVoice } from '@/cast/resolveVoice';
import type { DeviceVoice } from '@/playback/engine';

const desktop: DeviceVoice[] = [
  { name: 'Microsoft Hazel - English (Great Britain)', lang: 'en-GB' },
  { name: 'Google US English', lang: 'en-US', network: true },
  { name: 'Microsoft Catherine - English (Australia)', lang: 'en-AU', isDefault: true },
  { name: 'Microsoft Hedda - German (Germany)', lang: 'de-DE' },
];
const voice = { voiceName: 'en-gb-x-gba-local', lang: 'en-GB', pitch: 0.85, rate: 1.1 };

describe('resolveVoice', () => {
  it('uses the chosen voice when the device has it', () => {
    expect(
      resolveVoice({ ...voice, voiceName: 'Microsoft Hedda - German (Germany)' }, desktop),
    ).toEqual({
      voiceName: 'Microsoft Hedda - German (Germany)',
      lang: 'en-GB',
      substituted: false,
    });
  });

  it('substitutes a missing voice with the best one for the same locale', () => {
    // An Android voice name on a desktop browser: same locale (en-GB) beats the default en-AU.
    expect(resolveVoice(voice, desktop)).toEqual({
      voiceName: 'Microsoft Hazel - English (Great Britain)',
      lang: 'en-GB',
      substituted: true,
    });
  });

  it('falls back to the same language, preferring the default and offline voices', () => {
    expect(resolveVoice({ ...voice, lang: 'en-NZ' }, desktop).voiceName).toBe(
      'Microsoft Catherine - English (Australia)',
    );
    const noDefault = desktop.map((v) => ({ ...v, isDefault: false }));
    expect(resolveVoice({ ...voice, lang: 'en_NZ' }, noDefault).voiceName).toBe(
      'Microsoft Hazel - English (Great Britain)',
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
    expect(resolveVoice(voice, [])).toEqual({ lang: 'en-GB', substituted: false });
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
    expect(bestVoiceFor('en-GB', desktop)?.name).toBe('Microsoft Hazel - English (Great Britain)');
    expect(bestVoiceFor('en-NZ', desktop)?.name).toBe('Microsoft Catherine - English (Australia)');
    expect(bestVoiceFor('en_US', desktop)?.name).toBe('Google US English');
    const offlineFirst: DeviceVoice[] = [
      { name: 'cloud', lang: 'en-IE', network: true },
      { name: 'local', lang: 'en-CA' },
    ];
    expect(bestVoiceFor('en-GB', offlineFirst)?.name).toBe('local');
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
    expect(bestVoiceFor('en-GB', [])).toBeUndefined();
  });
});
