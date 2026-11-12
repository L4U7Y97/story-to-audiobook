import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AGE_GROUPS, GENDERS, SIZES, SPECIES } from '@/format/types';
import type { Character } from '@/format/types';
import { assignVoice, assignVoices } from '@/cast/assignVoices';
import { resolveVoice } from '@/cast/resolveVoice';
import { cleanTraits } from '@/cast/traits';
import type { DeviceVoice } from '@/playback/engine';
import { baseCast } from '../../helpers/fixtures';

// Names voiceProfile knows (women, men, a child, elderly, robot-like and novelty voices) and
// names it knows nothing about.
const VOICE_NAMES = [
  'en-a',
  'en-b',
  'en-c',
  'Microsoft Zira - English (United States)',
  'Microsoft Hazel - English (United Kingdom)',
  'Microsoft David - English (United States)',
  'Google UK English Male',
  'Microsoft Ana Online (Natural) - English (United States)',
  'Samantha',
  'Fred',
  'Junior',
  'com.apple.eloquence.en-US.Grandma',
  'com.apple.eloquence.en-US.Grandpa',
  'com.apple.speech.synthesis.voice.Zarvox',
  'com.apple.speech.synthesis.voice.Bells',
  'en-us-x-sfg#male_1-local',
];

const deviceVoices = fc.uniqueArray(
  fc.record(
    {
      name: fc.constantFrom(...VOICE_NAMES),
      lang: fc.constantFrom('en-US', 'en-GB', 'en_AU', 'es-ES'),
      isDefault: fc.boolean(),
      network: fc.boolean(),
    },
    { requiredKeys: ['name', 'lang'] },
  ),
  { maxLength: 6, selector: (v) => v.name },
);

/** A value of the format, one outside it (a hand-edited file), or no key at all. */
const trait = (values: readonly string[]) => fc.constantFrom(...values, 'nonsense');

const newCharacters = fc
  .uniqueArray(
    fc.record(
      {
        id: fc.string({ maxLength: 12 }).filter((id) => id !== 'narrator' && id !== 'unknown'),
        gender: trait(GENDERS),
        age: trait(AGE_GROUPS),
        species: trait(SPECIES),
        size: trait(SIZES),
      },
      { requiredKeys: ['id'] },
    ),
    { minLength: 1, maxLength: 40, selector: (c) => c.id },
  )
  .map(
    (list) =>
      list.map((c) => ({ ...c, role: 'character', name: c.id, aliases: [] })) as Array<
        Omit<Character, 'voice'>
      >,
  );

const CAST_KINDS = ['none', 'fresh', 'voiced', 'pitched'] as const;

/**
 * The cast the new characters join: nobody, a fresh story's cast, one voiced on this device, or
 * that one with a narrator who does not read at pitch 1.
 */
function castBefore(kind: (typeof CAST_KINDS)[number], voices: DeviceVoice[], locale: string) {
  if (kind === 'none') return [];
  const fresh = baseCast('en');
  if (kind === 'fresh') return fresh;
  const voiced = fresh.map((c) => ({ ...c, voice: assignVoice(c, [], voices, locale) }));
  if (kind === 'voiced') return voiced;
  return voiced.map((c) =>
    c.role === 'narrator' ? { ...c, voice: { ...c.voice, pitch: 1.15 } } : c,
  );
}

const combo = (c: Character) => `${c.voice.voiceName}|${c.voice.pitch}|${c.voice.rate}`;
const hundredths = (n: number) => Math.round(n * 100);
/** The voice, pitch and rate a member is really heard with on a device. */
const heard = (c: Character, voices: DeviceVoice[]) =>
  `${resolveVoice(c.voice, voices).voiceName ?? c.voice.voiceName}|${c.voice.pitch}|${c.voice.rate}`;

describe('assignVoices (property)', () => {
  it('gives every new character a distinct, finite voice inside the pitch and rate ranges', () => {
    fc.assert(
      fc.property(
        newCharacters,
        deviceVoices,
        fc.constantFrom(...CAST_KINDS),
        fc.constantFrom('en-US', 'en-GB'),
        (characters, voices, kind, locale) => {
          const cast = castBefore(kind, voices, locale);
          const added = assignVoices(characters, cast, voices, locale);

          // Deterministic, in the order given, and nothing but the voice is added.
          expect(assignVoices(characters, cast, voices, locale)).toEqual(added);
          expect(added).toEqual(characters.map((c, i) => ({ ...c, voice: added[i]!.voice })));

          const english = voices.filter((v) => v.lang.startsWith('en')).map((v) => v.name);
          const taken = new Map<string, number>();
          const takenHere = new Map<string, number>();
          for (const c of [...cast, ...added]) {
            taken.set(combo(c), (taken.get(combo(c)) ?? 0) + 1);
            takenHere.set(heard(c, voices), (takenHere.get(heard(c, voices)) ?? 0) + 1);
          }
          const narrator = cast.find((c) => c.role === 'narrator');
          const narratorPitch = hundredths(narrator?.voice.pitch ?? 1);
          const narratorVoice = resolveVoice(
            narrator?.voice ?? { lang: locale, pitch: 1, rate: 1 },
            voices,
          ).voiceName;

          for (const c of added) {
            const { voiceName, lang, pitch, rate } = c.voice;
            expect(Object.keys(c.voice)).toEqual(
              english.length ? ['voiceName', 'lang', 'pitch', 'rate'] : ['lang', 'pitch', 'rate'],
            );
            if (english.length) expect(english).toContain(voiceName);
            else expect(lang).toBe(locale);

            // No other member, old or new, has the same voice, pitch and rate.
            expect(taken.get(combo(c))).toBe(1);
            // Nor is any other member heard with them here, whatever voice name it has stored.
            expect(takenHere.get(heard(c, voices))).toBe(1);

            expect(Number.isFinite(pitch) && Number.isFinite(rate)).toBe(true);
            expect(pitch).toBe(hundredths(pitch) / 100);
            expect(hundredths(pitch) % 5).toBe(0);
            expect(rate).toBe(hundredths(rate) / 100);
            // Up to 42 members never need the last-resort rates outside the range.
            expect(hundredths(rate)).toBeGreaterThanOrEqual(80);
            expect(hundredths(rate)).toBeLessThanOrEqual(125);
            const { age, size, species } = cleanTraits(c);
            const plain = !age && !size && !species;
            expect(hundredths(pitch)).toBeGreaterThanOrEqual(plain ? 75 : 60);
            expect(hundredths(pitch)).toBeLessThanOrEqual(plain ? 130 : 160);

            // On the narrator's voice a character keeps its distance from the narrator's pitch.
            if (voiceName !== undefined && voiceName === narratorVoice) {
              expect(Math.abs(hundredths(pitch) - narratorPitch)).toBeGreaterThanOrEqual(10);
            }
          }
        },
      ),
    );
  });

  it('gives one member the same voice whatever else it carries, and never the manual mark', () => {
    fc.assert(
      fc.property(newCharacters, deviceVoices, (characters, voices) => {
        const [first, ...rest] = assignVoices(characters, baseCast('en'), voices, 'en-US');
        const cast = [...baseCast('en'), ...rest];
        const { id, role } = first!;
        const again = assignVoice({ id, role, ...cleanTraits(first!) }, cast, voices, 'en-US');
        const marked = { ...first!, voice: { ...first!.voice, manual: true as const } };
        expect(assignVoice(marked, cast, voices, 'en-US')).toStrictEqual(again);
        expect(Object.keys(again)).not.toContain('manual');
      }),
    );
  });
});
