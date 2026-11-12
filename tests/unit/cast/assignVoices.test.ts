import { describe, expect, it } from 'vitest';
import { AGE_GROUPS, GENDERS, SIZES, SPECIES } from '@/format/types';
import type { Character, Traits, VoiceSettings } from '@/format/types';
import { assignVoice, assignVoices, repickVoice } from '@/cast/assignVoices';
import { resolveVoice } from '@/cast/resolveVoice';
import { cleanTraits } from '@/cast/traits';
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

// Real voice names, so that voiceProfile knows how they sound.
const ZIRA = 'Microsoft Zira - English (United States)';
const HAZEL = 'Microsoft Hazel - English (United Kingdom)';
const DAVID = 'Microsoft David - English (United States)';
const ANA = 'Microsoft Ana Online (Natural) - English (United States)';
const GRANDPA = 'com.apple.eloquence.en-US.Grandpa';
const ZARVOX = 'com.apple.speech.synthesis.voice.Zarvox';
const BELLS = 'com.apple.speech.synthesis.voice.Bells';

const en = (name: string, isDefault = false): DeviceVoice => ({
  name,
  lang: 'en-US',
  ...(isDefault ? { isDefault } : {}),
});

type Member = Parameters<typeof assignVoice>[0];
const member = (id: string, traits: Traits = {}): Member => ({ id, role: 'character', ...traits });
const ids = (count: number, prefix = 'id') => Array.from({ length: count }, (_, i) => prefix + i);
const cents = (n: number) => Math.round(n * 100);
const voiceNames = (cast: Character[]) => cast.map((c) => c.voice.voiceName);

/** The voices `count` new members with the same traits get, one after the other. */
const namesFor = (count: number, traits: Traits, deviceVoices: DeviceVoice[]) =>
  voiceNames(
    assignVoices(
      ids(count).map((id) => ({ ...newChar(id), ...traits })),
      baseCast('en'),
      deviceVoices,
      'en-US',
    ),
  );

describe('assignVoice with traits: the voice', () => {
  const mixed = [en('en-a', true), en('en-b'), en(DAVID), en(ZIRA)];

  it('gives a character a voice of its gender rather than an unknown or opposite one', () => {
    const cast = baseCast('en');
    expect(assignVoice(member('f', { gender: 'female' }), cast, mixed, 'en-US').voiceName).toBe(
      ZIRA,
    );
    expect(assignVoice(member('m', { gender: 'male' }), cast, mixed, 'en-US').voiceName).toBe(
      DAVID,
    );
    expect(assignVoice(member('o', { gender: 'other' }), cast, mixed, 'en-US').voiceName).toBe(
      'en-b',
    );
  });

  it('spills over to a voice of unknown gender once the matching one is two busier', () => {
    const voices = [en('en-a', true), en(ZIRA), en('en-b')];
    expect(namesFor(5, { gender: 'female' }, voices)).toEqual([ZIRA, ZIRA, ZIRA, 'en-b', ZIRA]);
  });

  it('never uses a voice of the other gender while another one is left', () => {
    const voices = [en('en-a', true), en(DAVID), en('en-b')];
    expect(namesFor(6, { gender: 'female' }, voices).every((name) => name === 'en-b')).toBe(true);
    // With nothing else on the device, the other gender has to do.
    expect(namesFor(2, { gender: 'female' }, [en(DAVID)])).toEqual([DAVID, DAVID]);
  });

  it('keeps characters off the narrator’s voice when it is not of their gender', () => {
    const voices = [en(ZIRA, true), en('en-b')];
    expect(namesFor(4, { gender: 'male' }, voices).every((name) => name === 'en-b')).toBe(true);
    expect(namesFor(4, {}, voices).every((name) => name === 'en-b')).toBe(true);
  });

  it('uses the narrator’s voice when it is the only one of the character’s gender, well away in pitch', () => {
    const voices = [en(ZIRA, true), en(DAVID)];
    const women = assignVoices(
      ids(8).map((id) => newChar(id, 'female')),
      baseCast('en'),
      voices,
      'en-US',
    );
    expect(voiceNames(women).every((name) => name === ZIRA)).toBe(true);
    // The narrator reads at pitch 1.
    expect(women.every((c) => Math.abs(cents(c.voice.pitch) - 100) >= 10)).toBe(true);
    // There a woman is pitched as on an unknown voice (1.15), not nearer to neutral (1.10).
    const alone = ids(30).map((id) =>
      assignVoice(member(id, { gender: 'female' }), baseCast('en'), voices, 'en-US'),
    );
    expect(Math.max(...alone.map((v) => v.pitch))).toBe(1.25);
    expect(
      assignVoice(member('m', { gender: 'male' }), baseCast('en'), voices, 'en-US'),
    ).toMatchObject({ voiceName: DAVID });
  });

  it('keeps its distance from a narrator who does not read at pitch 1', () => {
    const [narrator, unknown] = baseCast('en');
    const cast = [
      { ...narrator!, voice: { voiceName: ZIRA, lang: 'en-US', pitch: 1.15, rate: 1 } },
      unknown!,
    ];
    for (const id of ids(30)) {
      const v = assignVoice(member(id, { gender: 'female' }), cast, [en(ZIRA, true)], 'en-US');
      expect(v.voiceName).toBe(ZIRA);
      expect(Math.abs(cents(v.pitch) - 115)).toBeGreaterThanOrEqual(10);
    }
    // Several at once too, each also keeping clear of the ones before her.
    const women = assignVoices(
      ids(8).map((id) => newChar(id, 'female')),
      cast,
      [en(ZIRA, true)],
      'en-US',
    );
    expect(women.every((c) => Math.abs(cents(c.voice.pitch) - 115) >= 10)).toBe(true);
    expect(new Set(women.map(combo)).size).toBe(8);
  });

  it('prefers another voice of that gender to the narrator’s until it is three busier', () => {
    const voices = [en(ZIRA, true), en(HAZEL)];
    expect(namesFor(5, { gender: 'female' }, voices)).toEqual([HAZEL, HAZEL, HAZEL, HAZEL, ZIRA]);
  });

  it('reads the narrator’s voice from the cast, substituted as on playback', () => {
    const [narrator, unknown] = baseCast('en');
    const voices = [en('en-a', true), en('en-b'), en('en-c')];
    const onB = [{ ...narrator!, voice: { ...narrator!.voice, voiceName: 'en-b' } }, unknown!];
    expect(assignVoice(member('c'), onB, voices, 'en-US').voiceName).toBe('en-a');
    // A narrator voice from another device is replaced by the default one here.
    const elsewhere = [
      { ...narrator!, voice: { ...narrator!.voice, voiceName: 'gone' } },
      unknown!,
    ];
    expect(assignVoice(member('c'), elsewhere, voices, 'en-US').voiceName).toBe('en-b');
  });

  it('voices a child with a woman’s voice, also a boy', () => {
    const voices = [en('en-a', true), en(DAVID), en(ZIRA)];
    const boy = assignVoice(
      member('boy', { gender: 'male', age: 'child' }),
      baseCast('en'),
      voices,
      'en-US',
    );
    expect(boy.voiceName).toBe(ZIRA);
    // 1.15 for a boy on a woman's voice, give or take the usual variation.
    expect(boy.pitch).toBeGreaterThanOrEqual(1.05);
    expect(boy.pitch).toBeLessThanOrEqual(1.25);
    expect(namesFor(3, { age: 'child' }, voices)).toEqual([ZIRA, ZIRA, ZIRA]);
  });

  it('gives a child a child’s voice when the device has one, and keeps adults off it', () => {
    const voices = [en('en-a', true), en(ZIRA), en(ANA)];
    expect(namesFor(3, { gender: 'male', age: 'child' }, voices)).toEqual([ANA, ANA, ANA]);
    expect(namesFor(4, { gender: 'female' }, voices)).toEqual([ZIRA, ZIRA, ZIRA, ZIRA]);
    expect(namesFor(4, { gender: 'female', age: 'elder' }, voices)).not.toContain(ANA);
    // A child's voice is better than none.
    expect(namesFor(1, { gender: 'female' }, [en(ANA)])).toEqual([ANA]);
  });

  it('gives an elderly character an elderly voice when the device has one', () => {
    const voices = [en('en-a', true), en(DAVID), en(GRANDPA)];
    expect(namesFor(2, { gender: 'male', age: 'elder' }, voices)).toEqual([GRANDPA, GRANDPA]);
    expect(namesFor(2, { gender: 'male' }, voices)).toEqual([DAVID, DAVID]);
  });

  it('gives a machine a robot-like voice, and nobody else', () => {
    const voices = [en('en-a', true), en('en-b'), en(ZARVOX)];
    expect(namesFor(3, { species: 'machine' }, voices)).toEqual([ZARVOX, ZARVOX, ZARVOX]);
    expect(namesFor(3, { species: 'machine', gender: 'female' }, voices)).toEqual([
      ZARVOX,
      ZARVOX,
      ZARVOX,
    ]);
    expect(namesFor(6, { species: 'creature' }, voices)).not.toContain(ZARVOX);
    // Without one, a machine speaks with an ordinary voice.
    expect(namesFor(1, { species: 'machine' }, [en('en-a', true), en('en-b')])).toEqual(['en-b']);
  });

  it('never picks a novelty voice by itself, unless the device has nothing else', () => {
    const voices = [en('en-a', true), en(BELLS), en('en-b'), en(ZARVOX)];
    const everyone = [
      ...namesFor(6, {}, voices),
      ...namesFor(6, { gender: 'male', species: 'animal', size: 'small' }, voices),
      ...namesFor(6, { age: 'child' }, voices),
    ];
    expect(new Set(everyone)).toEqual(new Set(['en-b']));
    expect(
      assignVoice({ id: 'n', role: 'narrator' }, [], [en(BELLS, true), en('en-b')], 'en-US'),
    ).toMatchObject({ voiceName: 'en-b' });
    expect(namesFor(2, {}, [en(BELLS)])).toEqual([BELLS, BELLS]);
  });

  it('ignores the traits of the unknown speaker', () => {
    const unknown = { id: 'u', role: 'unknown' as const };
    const traits: Traits = { gender: 'female', age: 'child', species: 'machine', size: 'small' };
    const voices = [en('en-a', true), en('en-b'), en(ZIRA), en(ZARVOX)];
    expect(assignVoice({ ...unknown, ...traits }, baseCast('en'), voices, 'en-US')).toEqual(
      assignVoice(unknown, baseCast('en'), voices, 'en-US'),
    );
    // It stays a little above neutral (1.1), as it always was.
    const pitches = ids(30).map((id) =>
      cents(assignVoice({ id, role: 'unknown' }, [], [], 'en-US').pitch),
    );
    expect([Math.min(...pitches), Math.max(...pitches)]).toEqual([100, 120]);
  });
});

describe('assignVoice with traits: the narrator', () => {
  const narrator = (traits: Traits = {}): Member => ({ id: 'n', role: 'narrator', ...traits });

  it('gives a narrator without traits the voice playback would use for the locale', () => {
    // The same locale comes before the system default, as when a voice is substituted.
    const voices: DeviceVoice[] = [{ name: 'en-uk', lang: 'en-GB', isDefault: true }, en('en-us')];
    expect(assignVoice(narrator(), [], voices, 'en-US')).toStrictEqual({
      voiceName: 'en-us',
      lang: 'en-US',
      pitch: 1,
      rate: 1,
    });
    expect(assignVoice(member('c'), [], voices, 'en-US').voiceName).toBe('en-uk');
  });

  it('gives a narrator with a gender a voice of that gender at neutral pitch and rate', () => {
    expect(
      assignVoice(narrator({ gender: 'female' }), [], [en(DAVID, true), en(ZIRA)], 'en-US'),
    ).toStrictEqual({ voiceName: ZIRA, lang: 'en-US', pitch: 1, rate: 1 });
  });

  it('keeps the default voice when it suits the narrator', () => {
    const voices = [en('en-b'), en(ZIRA), en('en-a', true), en(HAZEL)];
    expect(assignVoice(narrator({ gender: 'female' }), [], voices, 'en-US').voiceName).toBe('en-a');
    expect(assignVoice(narrator({ age: 'adult' }), [], voices, 'en-US').voiceName).toBe('en-a');
  });

  it('shifts the pitch a little only on a voice of the other gender', () => {
    expect(assignVoice(narrator({ gender: 'female' }), [], [en(DAVID)], 'en-US').pitch).toBe(1.1);
    expect(assignVoice(narrator({ gender: 'male' }), [], [en(ZIRA)], 'en-US').pitch).toBe(0.9);
    expect(assignVoice(narrator({ gender: 'male' }), [], [en('en-a')], 'en-US').pitch).toBe(1);
    expect(assignVoice(narrator({ gender: 'male' }), [], [], 'en-US').pitch).toBe(1);
  });

  it('applies the other traits without any variation by id', () => {
    const old = (id: string) =>
      assignVoice({ ...narrator({ age: 'elder', size: 'large' }), id }, [], [], 'en-US');
    expect(old('a')).toStrictEqual({ lang: 'en-US', pitch: 0.8, rate: 0.81 });
    expect(old('b')).toStrictEqual(old('a'));
    expect(assignVoice(narrator({ age: 'child' }), [], [], 'en-US')).toMatchObject({
      pitch: 1.3,
      rate: 1.04,
    });
  });
});

describe('assignVoice with traits: pitch and rate', () => {
  /** Alone in the cast and with no device voices, so nothing but the traits moves the result. */
  const alone = (id: string, traits: Traits = {}) =>
    assignVoice(member(id, traits), [], [], 'en-US');
  // The narrator reads with a cloud voice, which characters never get: `on` is free of it.
  const cloud: DeviceVoice = { name: 'en-cloud', lang: 'en-US', network: true };
  const narratorOnCloud: Character[] = [
    { ...baseCast('en')[0]!, voice: { voiceName: cloud.name, lang: 'en-US', pitch: 1, rate: 1 } },
  ];
  /** The same, on the only offline voice of a device. */
  const on = (voice: string, id: string, traits: Traits = {}) =>
    assignVoice(member(id, traits), narratorOnCloud, [cloud, en(voice)], 'en-US');
  const pitches = (voices: VoiceSettings[]) =>
    [...new Set(voices.map((v) => cents(v.pitch)))].sort((a, b) => a - b);

  it('keeps the pitch and rate a character without age, size or species always had', () => {
    // From the FNV-1a hash of the id, as in stories analysed before traits existed.
    expect(alone('anne')).toStrictEqual({ lang: 'en-US', pitch: 0.9, rate: 1.07 });
    expect(alone('tom', { gender: 'male' })).toStrictEqual({
      lang: 'en-US',
      pitch: 0.95,
      rate: 1.07,
    });
    expect(alone('eve', { gender: 'female' })).toStrictEqual({
      lang: 'en-US',
      pitch: 1.2,
      rate: 1.03,
    });
    expect(on('en-a', 'tom', { gender: 'male' })).toStrictEqual({
      voiceName: 'en-a',
      lang: 'en-US',
      pitch: 0.95,
      rate: 1.07,
    });
  });

  it('centres a gendered character nearer to neutral on a voice of its gender', () => {
    const many = ids(30);
    expect(pitches(many.map((id) => on('en-a', id, { gender: 'male' })))).toEqual([
      75, 80, 85, 90, 95,
    ]);
    expect(pitches(many.map((id) => on(DAVID, id, { gender: 'male' })))).toEqual([
      80, 85, 90, 95, 100,
    ]);
    expect(pitches(many.map((id) => on(ZIRA, id, { gender: 'female' })))).toEqual([
      100, 105, 110, 115, 120,
    ]);
    expect(pitches(many.map((id) => on(DAVID, id, { gender: 'female' })))).toEqual([
      110, 115, 120, 125, 130,
    ]);
  });

  it.each<[string, Traits, number, number]>([
    ['a teenager', { age: 'teen' }, 10, 2],
    ['an adult', { age: 'adult' }, 0, 0],
    ['an elderly character', { age: 'elder' }, 0, -12],
    ['a small character', { size: 'small' }, 20, 5],
    ['a large character', { size: 'large' }, -20, -7],
    ['a human', { species: 'human' }, 0, 0],
    ['an animal', { species: 'animal' }, 10, 4],
    ['a fantasy creature', { species: 'creature' }, -10, -4],
    ['a large old creature', { age: 'elder', size: 'large', species: 'creature' }, -30, -23],
    ['a small young animal', { age: 'teen', size: 'small', species: 'animal' }, 40, 11],
  ])('moves %s by its traits', (_, traits, pitch, rate) => {
    for (const id of ids(10)) {
      const plain = alone(id);
      const shifted = alone(id, traits);
      expect(cents(shifted.pitch) - cents(plain.pitch)).toBe(pitch);
      expect(cents(shifted.rate) - cents(plain.rate)).toBe(Math.max(rate, 80 - cents(plain.rate)));
    }
  });

  it('pitches a child by the voice it got: least on a child’s voice, most on a man’s', () => {
    const many = ids(30);
    const centre = (voice: string, traits: Traits) => {
      const all = pitches(many.map((id) => on(voice, id, { age: 'child', ...traits })));
      expect(all).toHaveLength(5);
      return all[2];
    };
    expect([
      centre(ANA, { gender: 'male' }),
      centre(ANA, { gender: 'female' }),
      centre(ANA, {}),
    ]).toEqual([95, 105, 100]);
    expect([
      centre(ZIRA, { gender: 'male' }),
      centre(ZIRA, { gender: 'female' }),
      centre(ZIRA, {}),
    ]).toEqual([115, 125, 120]);
    expect([
      centre('en-a', { gender: 'male' }),
      centre('en-a', { gender: 'female' }),
      centre('en-a', {}),
    ]).toEqual([125, 135, 130]);
    expect([
      centre(DAVID, { gender: 'male' }),
      centre(DAVID, { gender: 'female' }),
      centre(DAVID, {}),
    ]).toEqual([135, 145, 140]);
    // Children also speak a little faster, and size moves them half as much.
    expect(cents(alone('kid', { age: 'child' }).rate) - cents(alone('kid').rate)).toBe(4);
    expect(centre('en-a', { size: 'small' })).toBe(140);
    expect(centre('en-a', { size: 'large' })).toBe(120);
  });

  it('makes an elderly character slower than any adult of the same kind, at the same pitch', () => {
    const many = ids(40);
    const adults = many.map((id) => alone(id, { gender: 'male', age: 'adult' }));
    const elders = many.map((id) => alone(id, { gender: 'male', age: 'elder' }));
    elders.forEach((elder, i) => {
      expect(cents(elder.rate)).toBe(cents(adults[i]!.rate) - 12);
      expect(elder.pitch).toBe(adults[i]!.pitch);
    });
    const slowestAdult = Math.min(...adults.map((v) => v.rate));
    expect(Math.max(...elders.map((v) => v.rate))).toBeLessThanOrEqual(slowestAdult);
    // An elderly voice already sounds old, so it is slowed half as much.
    const grandpa = on(GRANDPA, 'id0', { gender: 'male', age: 'elder' });
    expect(cents(grandpa.rate)).toBe(cents(adults[0]!.rate) - 6);
  });

  it('gives a machine a flat pitch and slow speech, at normal speed on a robot-like voice', () => {
    const many = ids(20);
    const machines = many.map((id) => alone(id, { species: 'machine' }));
    expect(pitches(machines)).toEqual([100]);
    expect(pitches(many.map((id) => alone(id, { species: 'machine', gender: 'female' })))).toEqual([
      115,
    ]);
    machines.forEach((machine, i) => {
      expect(cents(machine.rate)).toBe(cents(alone(many[i]!).rate) - 8);
    });
    const robot = on(ZARVOX, 'id0', { species: 'machine' });
    expect(robot).toMatchObject({ voiceName: ZARVOX, pitch: 1, rate: alone('id0').rate });
  });

  it('clamps what the traits add, so characters with the same traits still differ in pitch', () => {
    const many = ids(40);
    // 1.45 + 0.10 + 0.10 would leave no room above; 0.85 - 0.20 - 0.10 none below.
    const high: Traits = { gender: 'female', age: 'child', size: 'small', species: 'animal' };
    const low: Traits = { gender: 'male', size: 'large', species: 'creature' };
    expect(pitches(many.map((id) => on(DAVID, id, high)))).toEqual([140, 145, 150, 155, 160]);
    expect(pitches(many.map((id) => on('en-a', id, low)))).toEqual([60, 65, 70, 75, 80]);
    const five = assignVoices(
      ['id0', 'id1', 'id2', 'id3', 'id4'].map((id) => ({ ...newChar(id), ...high })),
      [],
      [en(DAVID)],
      'en-US',
    );
    expect(pitches(five.map((c) => c.voice))).toHaveLength(5);
  });

  it('opens the wide pitch range for species alone', () => {
    const many = ids(30);
    expect(pitches(many.map((id) => alone(id, { gender: 'male', species: 'creature' })))).toEqual([
      65, 70, 75, 80, 85,
    ]);
    expect(pitches(many.map((id) => alone(id, { gender: 'female', species: 'animal' })))).toEqual([
      115, 120, 125, 130, 135,
    ]);
  });

  it('keeps members without age, size or species inside 0.75–1.3, however many there are', () => {
    const crowd = assignVoices(
      ids(60).map((id, i) => newChar(id, (['male', 'female', 'other', undefined] as const)[i % 4])),
      baseCast('en'),
      [en(ZIRA, true)],
      'en-US',
    );
    expect(new Set(crowd.map(combo)).size).toBe(60);
    const used = pitches(crowd.map((c) => c.voice));
    expect(used.at(0)).toBeGreaterThanOrEqual(75);
    expect(used.at(-1)).toBeLessThanOrEqual(130);
    // On the narrator's voice nobody comes within 0.05 of the narrator's pitch.
    expect(used.filter((pitch) => pitch >= 95 && pitch <= 105)).toEqual([]);
  });

  it('keeps every pitch on the 0.05 grid and every rate inside 0.8–1.25', () => {
    const all: Traits[] = [];
    for (const gender of [undefined, ...GENDERS]) {
      for (const age of [undefined, ...AGE_GROUPS]) {
        for (const species of [undefined, ...SPECIES]) {
          for (const size of [undefined, ...SIZES])
            all.push(cleanTraits({ gender, age, species, size }));
        }
      }
    }
    const voices = [en('en-a', true), en(ZIRA), en(DAVID), en(ANA), en(GRANDPA), en(ZARVOX)];
    const cast = assignVoices(
      all.map((traits, i) => ({ ...newChar(`t${i}`), ...traits })),
      baseCast('en'),
      voices,
      'en-US',
    );
    expect(cast).toHaveLength(300);
    expect(new Set(cast.map(combo)).size).toBe(300);
    for (const { voice } of cast) {
      expect(cents(voice.pitch) % 5).toBe(0);
      expect(voice.pitch).toBe(cents(voice.pitch) / 100);
      expect(voice.pitch).toBeGreaterThanOrEqual(0.6);
      expect(voice.pitch).toBeLessThanOrEqual(1.6);
      expect(voice.rate).toBe(cents(voice.rate) / 100);
      expect(voice.rate).toBeGreaterThanOrEqual(0.8);
      expect(voice.rate).toBeLessThanOrEqual(1.25);
    }
  });

  it('reads trait values outside the format as not set', () => {
    const odd = { gender: 'robot', age: 'ancient', species: 'alien', size: 7 } as unknown as Traits;
    const voices = [en('en-a', true), en('en-b'), en(ZIRA), en(ZARVOX)];
    for (const id of ids(5)) {
      const voice = assignVoice(member(id, odd), baseCast('en'), voices, 'en-US');
      expect(voice).toStrictEqual(assignVoice(member(id), baseCast('en'), voices, 'en-US'));
      expect(Number.isNaN(voice.pitch) || Number.isNaN(voice.rate)).toBe(false);
    }
    // One good value among bad ones still counts.
    const mixed = { ...odd, gender: 'female' } as Traits;
    expect(assignVoice(member('x', mixed), baseCast('en'), voices, 'en-US').voiceName).toBe(ZIRA);
    // A bad age does not widen the pitch range as a real one would.
    const ancient = { gender: 'male', age: 'ancient' } as unknown as Traits;
    for (const id of ids(10)) {
      expect(on(ZIRA, id, ancient)).toStrictEqual(on(ZIRA, id, { gender: 'male' }));
    }
  });

  it('moves further in pitch before it leaves the usual rate steps', () => {
    // Everything within 0.10 of the pitch of "anne" (0.9) is taken at every rate 0.04 from hers.
    const taken: Character[] = [];
    for (let rate = 83; rate <= 123; rate += 4) {
      for (let pitch = 80; pitch <= 100; pitch += 5) {
        const voice = { lang: 'en-US', pitch: pitch / 100, rate: rate / 100 };
        taken.push({ ...newChar(`${pitch}-${rate}`), voice });
      }
    }
    expect(assignVoice(member('anne'), taken, [], 'en-US')).toStrictEqual({
      lang: 'en-US',
      pitch: 1.05,
      rate: 1.07,
    });
  });

  it('never returns the manual mark', () => {
    const marked = { ...member('c'), voice: { lang: 'en-US', pitch: 1, rate: 1, manual: true } };
    expect(Object.keys(assignVoice(marked, [], [en('en-a')], 'en-US'))).toEqual([
      'voiceName',
      'lang',
      'pitch',
      'rate',
    ]);
  });

  describe('a pitch nobody has on the voice yet', () => {
    const join = (list: Array<Omit<Character, 'voice'>>, deviceVoices: DeviceVoice[]) =>
      assignVoices(list, narratorOnCloud, [cloud, ...deviceVoices], 'en-US');

    it('gives two men on the only man’s voice different pitches, not just different rates', () => {
      const men = ids(12);
      const natural = (id: string) => on(DAVID, id, { gender: 'male' });
      // Some of them have the same pitch by id, and so differed only in rate.
      expect(new Set(men.map((id) => natural(id).pitch)).size).toBeLessThan(men.length);
      for (const a of men) {
        for (const b of men.filter((id) => id !== a)) {
          const [first, second] = join(
            [newChar(a, 'male'), newChar(b, 'male')],
            [en(DAVID), en(ZIRA)],
          );
          expect(first!.voice).toStrictEqual(natural(a));
          expect(second!.voice.voiceName).toBe(DAVID);
          expect(second!.voice.pitch).not.toBe(first!.voice.pitch);
          // The nearest pitch that is not the first man's, at the rate the id gives.
          const shift = cents(second!.voice.pitch) - cents(natural(b).pitch);
          expect(shift).toBe(natural(b).pitch === first!.voice.pitch ? 5 : 0);
          expect(second!.voice.rate).toBe(natural(b).rate);
        }
      }
    });

    it('does so on the narrator’s voice too, still away from the narrator’s pitch', () => {
      // Windows with its two voices: the narrator reads with David, the only man's voice.
      const windows = [en(DAVID, true), en(ZIRA)];
      const men = ids(12);
      for (const a of men) {
        for (const b of men.filter((id) => id !== a)) {
          const pair = assignVoices(
            [newChar(a, 'male'), newChar(b, 'male')],
            baseCast('en'),
            windows,
            'en-US',
          );
          expect(voiceNames(pair)).toEqual([DAVID, DAVID]);
          expect(pair[1]!.voice.pitch).not.toBe(pair[0]!.voice.pitch);
          expect(pair.every((c) => cents(c.voice.pitch) <= 90)).toBe(true);
        }
      }
    });

    it('gives five characters with the same traits on one voice five different pitches', () => {
      const all = ids(12);
      for (let from = 0; from + 5 <= all.length; from++) {
        const group = all.slice(from, from + 5);
        const women = join(
          group.map((id) => newChar(id, 'female')),
          [en(ZIRA)],
        );
        expect(pitches(women.map((c) => c.voice))).toHaveLength(5);
        // Each within 0.10 of the pitch its id gives, at the rate its id gives.
        women.forEach((c, i) => {
          const natural = on(ZIRA, group[i]!, { gender: 'female' });
          expect(Math.abs(cents(c.voice.pitch) - cents(natural.pitch))).toBeLessThanOrEqual(10);
          expect(c.voice.rate).toBe(natural.rate);
        });
      }
    });

    it('lets the sixth share a pitch, at another rate than the one who has it', () => {
      // Machines do not vary in pitch by id: all six would read at 1.
      const machine = (id: string) => ({ ...newChar(id), species: 'machine' as const });
      const six = join(ids(6).map(machine), [en('en-a')]);
      const rates = ids(6).map((id) => on('en-a', id, { species: 'machine' }).rate);
      expect(six.map((c) => c.voice.rate)).toEqual(rates);
      expect(six.slice(0, 5).map((c) => cents(c.voice.pitch))).toEqual([100, 105, 95, 110, 90]);
      // The nearest of those five pitches whose owner speaks at another rate.
      const owner = six.slice(0, 5).find((c) => c.voice.rate !== rates[5])!;
      expect(six[5]!.voice.pitch).toBe(owner.voice.pitch);
      expect(new Set(six.map(combo)).size).toBe(6);
    });

    it('counts the pitch of a member who is only heard with the voice on this device', () => {
      const anne = on('en-a', 'anne');
      expect(anne).toMatchObject({ pitch: 0.9, rate: 1.07 });
      // Saved on another device: here "gone" is replaced by the only voice there is.
      const elsewhere = (id: string, pitch: number, rate: number): Character => ({
        ...newChar(id),
        voice: { voiceName: 'gone', lang: 'en-US', pitch, rate },
      });
      const deviceVoices = [cloud, en('en-a', true)];
      const pick = (cast: Character[]) =>
        assignVoice(member('anne'), [...narratorOnCloud, ...cast], deviceVoices, 'en-US');
      expect(pick([elsewhere('x', 0.9, 0.99)])).toStrictEqual({ ...anne, pitch: 0.95 });
      // With every near pitch heard there, her own combination must still be nobody's.
      const crowd = [
        elsewhere('x', 0.9, 1.07),
        ...[0.95, 0.85, 1, 0.8].map((pitch, i) => elsewhere(`y${i}`, pitch, 1.03)),
      ];
      expect(pick(crowd)).toStrictEqual({ ...anne, pitch: 0.95 });
      expect(pick(crowd.slice(1))).toStrictEqual(anne);
    });

    it('keeps the narrator’s pitch as its traits give it, whoever shares the voice', () => {
      const twin: Character = {
        ...newChar('twin'),
        voice: { voiceName: ZIRA, lang: 'en-US', pitch: 1, rate: 1.03 },
      };
      const narrator: Member = { id: 'n', role: 'narrator', gender: 'female' };
      expect(assignVoice(narrator, [twin], [en(ZIRA)], 'en-US')).toStrictEqual({
        voiceName: ZIRA,
        lang: 'en-US',
        pitch: 1,
        rate: 1,
      });
    });
  });

  it('never gives a character the very voice, pitch and rate the unknown speaker is heard with', () => {
    // As createStory stores them: no voice name, so both speak with the device's best voice.
    const [narrator, unknown] = baseCast('es');
    const cast = [narrator!, { ...unknown!, voice: { lang: 'es-ES', pitch: 1.15, rate: 1 } }];
    const android: DeviceVoice[] = [
      { name: 'es-es-x-eee-local', lang: 'es-ES' },
      { name: 'es-es-x-eed-local', lang: 'es-ES' },
    ];
    const heardAs = resolveVoice(cast[1]!.voice, android).voiceName;
    expect(heardAs).toBe('es-es-x-eee-local');
    // "la osa": slower for her size, faster for her kind, which can add up to rate 1.
    const bear: Traits = { gender: 'female', species: 'animal', size: 'large' };
    const picks = ids(200, 'c').map((id) => assignVoice(member(id, bear), cast, android, 'es-ES'));
    expect(picks.every((v) => v.voiceName === heardAs)).toBe(true);
    expect(picks.filter((v) => cents(v.pitch) === 115 && cents(v.rate) === 100)).toEqual([]);
  });

  it('never gives the narrator the very voice, pitch and rate the unknown speaker is heard with', () => {
    // As createStory stores them: no voice name, so the unknown speaker has the default voice.
    const [narrator, unknown] = baseCast('en');
    const cast = [narrator!, { ...unknown!, voice: { lang: 'en-US', pitch: 1.15, rate: 1 } }];
    const deviceVoices = [en(ZIRA, true)];
    // A girl of a fantasy kind on a woman's voice: 1.25 for the child, 0.10 lower for her kind.
    const traits: Traits = { gender: 'female', age: 'child', species: 'creature' };
    const picked = assignVoice(
      { id: 'narrator', role: 'narrator', ...traits },
      cast,
      deviceVoices,
      'en-US',
    );
    expect(picked.voiceName).toBe(ZIRA);
    expect([cents(picked.pitch), cents(picked.rate)]).not.toEqual([115, 100]);
    // The unknown speaker is never picked again, so the narrator is the one to keep clear of it.
    const character = {
      ...newChar('c'),
      voice: { voiceName: ZIRA, lang: 'en-US', pitch: 1.1, rate: 1 },
    };
    const dodging = assignVoice(
      { id: 'narrator', role: 'narrator', gender: 'female', age: 'teen' },
      [...cast, character],
      deviceVoices,
      'en-US',
    );
    expect([cents(dodging.pitch), cents(dodging.rate)]).not.toEqual([115, 100]);
  });

  it('finds a free combination even when a voice is far busier than its pitches and rates allow', () => {
    // 12 pitches by 46 rates: the last members can only differ by a rate outside the usual range.
    const crowd = assignVoices(
      ids(600).map((id) => newChar(id)),
      [],
      [],
      'en-US',
    );
    expect(new Set(crowd.map(combo)).size).toBe(600);
    expect(crowd.slice(0, 500).every((c) => c.voice.rate >= 0.8 && c.voice.rate <= 1.25)).toBe(
      true,
    );
    expect(crowd.every((c) => c.voice.pitch >= 0.75 && c.voice.pitch <= 1.3)).toBe(true);
  });
});

describe('repickVoice', () => {
  const stored = (traits: Traits, voice: VoiceSettings, role: Character['role'] = 'character') =>
    ({ id: 'c', role, name: 'C', aliases: [], ...traits, voice }) satisfies Character;

  it('picks the voice again from the traits, dropping the manual mark', () => {
    const lady = stored(
      { gender: 'female' },
      { voiceName: DAVID, lang: 'en-US', pitch: 2, rate: 2, manual: true },
    );
    const voice = repickVoice(
      lady,
      [...baseCast('en'), lady],
      [en('en-a', true), en(DAVID), en(ZIRA)],
      'en-US',
    );
    expect(voice).toStrictEqual(
      assignVoice(lady, baseCast('en'), [en('en-a', true), en(DAVID), en(ZIRA)], 'en-US'),
    );
    expect(voice.voiceName).toBe(ZIRA);
    expect(Object.keys(voice)).not.toContain('manual');
  });

  it('keeps the voice name and language when the device has no voice for the language', () => {
    const lady = stored(
      { gender: 'female' },
      { voiceName: ZIRA, lang: 'en-GB', pitch: 2, rate: 2, manual: true },
    );
    for (const deviceVoices of [[], [{ name: 'es-x', lang: 'es-ES' }]]) {
      const voice = repickVoice(lady, [lady], deviceVoices, 'en-US');
      expect(Object.keys(voice)).toEqual(['voiceName', 'lang', 'pitch', 'rate']);
      expect(voice).toMatchObject({ voiceName: ZIRA, lang: 'en-GB' });
      // Pitched as a woman on a woman's voice.
      expect(voice.pitch).toBeGreaterThanOrEqual(1);
      expect(voice.pitch).toBeLessThanOrEqual(1.2);
      expect(voice.rate).toBeLessThan(1.1);
    }
    const unnamed = stored({}, { lang: 'en-GB', pitch: 2, rate: 2 });
    expect(Object.keys(repickVoice(unnamed, [unnamed], [], 'en-US'))).toEqual([
      'lang',
      'pitch',
      'rate',
    ]);
    expect(repickVoice(unnamed, [unnamed], [], 'en-US').lang).toBe('en-GB');
  });

  it('keeps a kept voice away from a narrator saved with the same voice name', () => {
    const zira = { voiceName: ZIRA, lang: 'en-US', pitch: 1, rate: 1 };
    const narrator = { ...stored({}, zira, 'narrator'), id: 'n' };
    for (const id of ids(10)) {
      const lady = { ...stored({ gender: 'female' }, zira), id };
      const voice = repickVoice(lady, [narrator, lady], [], 'en-US');
      expect(Math.abs(cents(voice.pitch) - 100)).toBeGreaterThanOrEqual(10);
    }
  });

  it('leaves the narrator on “device default” when the pick is the device’s own default', () => {
    const narrator = stored(
      { gender: 'female' },
      { voiceName: 'gone', lang: 'en-GB', pitch: 1.2, rate: 0.9 },
      'narrator',
    );
    expect(repickVoice(narrator, [narrator], [en(DAVID), en(ZIRA, true)], 'en-US')).toStrictEqual({
      lang: 'en-US',
      pitch: 1,
      rate: 1,
    });
    // Another voice than the default has to be named.
    expect(repickVoice(narrator, [narrator], [en(DAVID, true), en(ZIRA)], 'en-US')).toStrictEqual({
      voiceName: ZIRA,
      lang: 'en-US',
      pitch: 1,
      rate: 1,
    });
    const plain = stored(
      {},
      { voiceName: 'gone', lang: 'en-GB', pitch: 1.2, rate: 0.9 },
      'narrator',
    );
    expect(repickVoice(plain, [plain], [en(DAVID), en(ZIRA, true)], 'en-US')).toStrictEqual({
      lang: 'en-US',
      pitch: 1,
      rate: 1,
    });
  });

  it('names a character’s voice even when it is the device default', () => {
    const lady = stored({ gender: 'female' }, { lang: 'en-US', pitch: 1, rate: 1 });
    expect(repickVoice(lady, [lady], [en(ZIRA, true)], 'en-US').voiceName).toBe(ZIRA);
  });

  it('ignores the member’s own current voice', () => {
    const deviceVoices = [en('en-a', true), en('en-b'), en('en-c')];
    for (const id of ids(10)) {
      const first = assignVoice({ id, role: 'character' }, baseCast('en'), deviceVoices, 'en-US');
      const c: Character = { id, role: 'character', name: 'C', aliases: [], voice: first };
      expect(repickVoice(c, [...baseCast('en'), c], deviceVoices, 'en-US')).toStrictEqual(first);
    }
  });

  it('keeps a narrator without traits at neutral pitch and rate even when a character holds them', () => {
    const [narrator, unknown] = baseCast('en');
    const twin = { ...newChar('twin'), voice: { lang: 'en-US', pitch: 1, rate: 1 } };
    expect(repickVoice(narrator!, [narrator!, unknown!, twin], [], 'en-US')).toStrictEqual({
      lang: 'en-US',
      pitch: 1,
      rate: 1,
    });
  });
});
