import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Analysis, Character, Lang, Part, Segment } from '@/format/types';
import {
  castUsage,
  filterCast,
  findNameClash,
  findNameOwner,
  findTypedNameOwner,
  linesOf,
  matchVoicesToTraits,
  mergeCharacters,
  parseAliases,
  partsToldBy,
  renameCharacter,
  repickMember,
  setAliases,
  setTraits,
} from '@/cast/castOps';
import { assignVoice, assignVoices, repickVoice } from '@/cast/assignVoices';
import { resolveVoice } from '@/cast/resolveVoice';
import type { DeviceVoice } from '@/playback/engine';
import { analyzePart } from '@/analysis/analyzer';
import { reassignSegments } from '@/analysis/reassign';
import { NARRATOR_NAME, UNKNOWN_NAME } from '@/analysis/castMatch';
import { validateAnalysis } from '@/format/validate';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { createStory, getStory, updateStory } from '@/storage/stories';
import { addPart, getPart } from '@/storage/parts';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { mergeCharactersInStory } from '@/storage/cast';
import { buildUtterances } from '@/playback/utterances';
import { baseCast, loadFixture } from '../../helpers/fixtures';

const voice = { lang: 'en-US', pitch: 1, rate: 1 };
const character = (id: string, name: string, aliases: string[] = []): Character => ({
  id,
  role: 'character',
  name,
  aliases,
  voice,
});
const analysis = (partId: string, speakers: string[]): Analysis => ({
  partId,
  textHash: 'h',
  analyzer: { kind: 'heuristic', version: 1 },
  createdAt: '',
  segments: speakers.map((speakerId, i) => ({
    start: i,
    end: i + 1,
    speakerId,
    mode: 'speech',
    source: 'heuristic',
  })),
});
const paste = (text: string) => ({ title: 'p', source: { kind: 'paste' as const }, text });

/** The stored segment that covers the start of `quote` in the part's text. */
async function segmentAt(db: StoryDb, part: Part, quote: string) {
  const start = part.text.indexOf(quote);
  const analysis = await getAnalysis(db, part.id);
  return analysis?.segments.find((s) => s.start <= start && start < s.end);
}

describe('mergeCharacters', () => {
  const cast = [
    ...baseCast('en'),
    character('a', 'Elizabeth', ['Lizzy']),
    character('b', 'Miss Bennet', ['Eliza', 'lizzy']),
  ];

  it('moves every line and folds names into aliases', () => {
    const result = mergeCharacters(
      cast,
      [analysis('p1', ['b', 'a', 'narrator']), analysis('p2', ['b'])],
      'b',
      'a',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cast.map((c) => c.id)).toEqual(['narrator', 'unknown', 'a']);
    expect(result.value.cast[2]!.aliases).toEqual(['Lizzy', 'Miss Bennet', 'Eliza']);
    expect(result.value.analyses.map((a) => a.segments.map((s) => s.speakerId))).toEqual([
      ['a', 'a', 'narrator'],
      ['a'],
    ]);
  });

  it('keeps the unknown speaker and narrator in the cast when merging them away', () => {
    const result = mergeCharacters(cast, [analysis('p', ['unknown'])], 'unknown', 'a');
    expect(result.ok && result.value.cast.some((c) => c.id === 'unknown')).toBe(true);
    expect(result.ok && result.value.analyses[0]!.segments[0]!.speakerId).toBe('a');
  });

  it('rejects merging into itself or unknown ids', () => {
    expect(mergeCharacters(cast, [], 'a', 'a')).toMatchObject({ ok: false });
    expect(mergeCharacters(cast, [], 'x', 'a')).toMatchObject({ ok: false });
  });

  it('moves a named narrator’s names to the character and its lines as user corrections', () => {
    const [narrator, unknown] = baseCast('en');
    const named = [
      { ...narrator!, name: 'Watson', aliases: ['Dr. Watson'] },
      unknown!,
      character('x', 'X'),
    ];
    const result = mergeCharacters(
      named,
      [analysis('p', ['narrator', 'x', 'narrator'])],
      'narrator',
      'x',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cast.find((c) => c.id === 'x')!.aliases).toEqual(
      expect.arrayContaining(['Watson', 'Dr. Watson']),
    );
    expect(result.value.cast[0]).toMatchObject({ name: 'Narrator', aliases: [] });
    expect(result.value.analyses[0]!.segments.map((s) => [s.speakerId, s.source])).toEqual([
      ['x', 'user'],
      ['x', 'heuristic'],
      ['x', 'user'],
    ]);
  });

  it('moves the unknown speaker’s lines as user corrections and keeps its names', () => {
    // "a voice" was merged into the unknown speaker, so it stays unattributed in later parts.
    const named = cast.map((c) => (c.id === 'unknown' ? { ...c, aliases: ['a voice'] } : c));
    const result = mergeCharacters(named, [analysis('p', ['unknown', 'a'])], 'unknown', 'a');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.analyses[0]!.segments.map((s) => s.source)).toEqual(['user', 'heuristic']);
    expect(result.value.cast.find((c) => c.id === 'a')!.aliases).toEqual(['Lizzy']);
    expect(result.value.cast.find((c) => c.id === 'unknown')).toMatchObject({
      name: 'Unknown',
      aliases: ['a voice'],
    });
  });

  it('gives a character’s names to the narrator and keeps the moved lines as analysed', () => {
    const result = mergeCharacters(cast, [analysis('p', ['b', 'narrator'])], 'b', 'narrator');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cast[0]).toMatchObject({
      name: 'Narrator',
      aliases: ['Miss Bennet', 'Eliza', 'lizzy'],
    });
    expect(result.value.analyses[0]!.segments.map((s) => [s.speakerId, s.source])).toEqual([
      ['narrator', 'heuristic'],
      ['narrator', 'heuristic'],
    ]);
  });

  describe('traits', () => {
    const [narrator, unknown] = baseCast('en');
    const merge = (into: Character, from: Character) => {
      const cast = [...new Set([narrator!, unknown!, into, from])];
      const result = mergeCharacters(cast, [], from.id, into.id);
      if (!result.ok) throw new Error(result.reason);
      return result.value.cast.find((c) => c.id === into.id)!;
    };

    it('keeps the survivor’s traits and fills the ones it lacks from the merged member', () => {
      const into: Character = { ...character('a', 'Rose'), gender: 'female', size: 'small' };
      const from: Character = {
        ...character('b', 'the old dog'),
        gender: 'male',
        age: 'elder',
        species: 'animal',
        size: 'large',
      };
      expect(merge(into, from)).toStrictEqual({
        ...into,
        aliases: ['the old dog'],
        age: 'elder',
        species: 'animal',
      });
    });

    it('writes no trait key for a trait neither member has', () => {
      const merged = merge(character('a', 'Rose'), { ...character('b', 'Rosie'), age: 'teen' });
      expect(Object.keys(merged)).toEqual(['id', 'role', 'name', 'aliases', 'voice', 'age']);
      const plain = merge(character('a', 'Rose'), character('b', 'Rosie'));
      expect(plain).toStrictEqual({ ...character('a', 'Rose'), aliases: ['Rosie'] });
      expect(Object.keys(plain)).toEqual(['id', 'role', 'name', 'aliases', 'voice']);
    });

    it('takes no trait value outside the format, and keeps the survivor’s voice as it is', () => {
      const into = character('a', 'Rose');
      const from: Character = { ...character('b', 'Rosie'), age: 'elder' };
      Object.assign(from, { gender: 'robot' });
      const merged = merge(into, from);
      expect(merged).toStrictEqual({ ...into, aliases: ['Rosie'], age: 'elder' });
      expect(merged.voice).toBe(into.voice);
    });

    it('fills the narrator’s traits too, but never gives the unknown speaker any', () => {
      const lady: Character = { ...character('b', 'Jane'), gender: 'female', age: 'adult' };
      expect(merge(narrator!, lady)).toMatchObject({ gender: 'female', age: 'adult' });
      expect(Object.keys(merge(unknown!, lady))).toEqual(Object.keys(unknown!));
      // A gender an older version left on the unknown speaker is nobody's.
      const stray: Character = { ...unknown!, gender: 'male' };
      const result = mergeCharacters(
        [narrator!, stray, character('a', 'Rose')],
        [],
        'unknown',
        'a',
      );
      expect(result.ok && Object.keys(result.value.cast[2]!)).toEqual(
        Object.keys(character('a', 'Rose')),
      );
    });
  });
});

describe('setTraits', () => {
  const ZIRA = 'Microsoft Zira - English (United States)';
  const DAVID = 'Microsoft David - English (United States)';
  const voices: DeviceVoice[] = [
    { name: 'en-a', lang: 'en-US', isDefault: true },
    { name: DAVID, lang: 'en-US' },
    { name: ZIRA, lang: 'en-US' },
  ];
  const byHand = { voiceName: 'en-a', lang: 'en-US', pitch: 1.4, rate: 0.7, manual: true as const };
  // The unknown speaker as createStory stores it, a little higher than the narrator: a narrator
  // with traits keeps clear of the voice the unknown speaker is heard with.
  const [narrator, unknown] = baseCast('en');
  const cast: Character[] = [
    narrator!,
    { ...unknown!, voice: { lang: 'en-US', pitch: 1.15, rate: 1 } },
    character('a', 'Alex'),
    { ...character('b', 'Blake'), gender: 'male', age: 'elder', voice: byHand },
  ];
  const run = (id: string, changes: Parameters<typeof setTraits>[2], within = cast) => {
    const result = setTraits(within, id, changes, voices, 'en-US');
    if (!result.ok) throw new Error(result.reason);
    return { ...result.value, member: result.value.cast.find((c) => c.id === id)! };
  };

  it('sets the traits and picks the voice again to match', () => {
    const { cast: after, member, repicked } = run('a', { gender: 'female', age: 'teen' });
    expect(repicked).toBe(true);
    expect(member).toMatchObject({ gender: 'female', age: 'teen' });
    expect(member.voice.voiceName).toBe(ZIRA);
    expect(member.voice).toStrictEqual(assignVoice(member, cast, voices, 'en-US'));
    expect(Object.keys(member.voice)).not.toContain('manual');
    // Everyone else is left as they were.
    expect(after.map((c) => c.id)).toEqual(cast.map((c) => c.id));
    expect(after.filter((c) => c.id !== 'a')).toEqual(cast.filter((c) => c.id !== 'a'));
    expect(after.find((c) => c.id === 'b')).toBe(cast[3]);
  });

  it('keeps a voice set by hand and says that it was not picked again', () => {
    const { member, repicked } = run('b', { gender: 'female', species: 'animal' });
    expect(repicked).toBe(false);
    expect(member).toMatchObject({ gender: 'female', age: 'elder', species: 'animal' });
    expect(member.voice).toStrictEqual(byHand);
  });

  it('returns the same cast when nothing actually changes', () => {
    for (const changes of [{}, { gender: undefined }, { size: undefined, species: undefined }]) {
      const same = run('a', changes);
      expect(same.cast).toBe(cast);
      expect(same.repicked).toBe(false);
    }
    const unchanged = run('b', { gender: 'male', age: 'elder' });
    expect(unchanged.cast).toBe(cast);
    expect(unchanged.repicked).toBe(false);
    // A value outside the format is no trait: setting it where none was changes nothing.
    expect(run('a', { age: 'ancient' as never }).cast).toBe(cast);
  });

  it('clears a trait given as undefined and leaves no key behind', () => {
    const { member, repicked } = run('b', { age: undefined });
    expect(repicked).toBe(false);
    expect(Object.keys(member)).toEqual(['id', 'role', 'name', 'aliases', 'voice', 'gender']);
    const none = run('b', { gender: undefined, age: undefined }).member;
    expect(none).toStrictEqual({ ...character('b', 'Blake'), voice: byHand });
    expect('gender' in none || 'age' in none).toBe(false);
    // An invalid value clears too.
    expect(Object.keys(run('b', { age: 'ancient' as never }).member)).not.toContain('age');
  });

  it('gives the narrator traits, leaving it on “device default” when that voice suits it', () => {
    const { member, repicked } = run('narrator', { gender: 'female' });
    expect(repicked).toBe(true);
    expect(member.gender).toBe('female');
    expect(member.voice).toStrictEqual({ lang: 'en-US', pitch: 1, rate: 1 });
    const old = run('narrator', { age: 'elder' });
    expect(old.member.voice).toStrictEqual({ lang: 'en-US', pitch: 1, rate: 0.88 });
    // A default voice of the other gender gives way to a named one.
    const zira: DeviceVoice[] = [{ name: ZIRA, lang: 'en-US', isDefault: true }, voices[1]!];
    const male = setTraits(cast, 'narrator', { gender: 'male' }, zira, 'en-US');
    expect(male.ok && male.value.cast[0]!.voice).toStrictEqual({
      voiceName: DAVID,
      lang: 'en-US',
      pitch: 1,
      rate: 1,
    });
  });

  it('refuses the unknown speaker, which has no traits, and members that are not there', () => {
    expect(setTraits(cast, 'unknown', { gender: 'male' }, voices, 'en-US')).toMatchObject({
      ok: false,
    });
    expect(setTraits(cast, 'nobody', { gender: 'male' }, voices, 'en-US')).toEqual({
      ok: false,
      reason: 'character not found',
    });
  });
});

describe('repickMember', () => {
  const ZIRA = 'Microsoft Zira - English (United States)';
  const voices: DeviceVoice[] = [
    { name: 'en-a', lang: 'en-US', isDefault: true },
    { name: 'en-b', lang: 'en-US' },
    { name: ZIRA, lang: 'en-US' },
  ];
  const byHand = { voiceName: 'en-a', lang: 'en-US', pitch: 1.4, rate: 0.7, manual: true as const };
  const cast: Character[] = [
    ...baseCast('en'),
    { ...character('a', 'Alex'), gender: 'female', voice: byHand },
    character('b', 'Blake'),
  ];

  it('picks the member’s voice again, also one that was set by hand', () => {
    const result = repickMember(cast, 'a', voices, 'en-US');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const member = result.value[2]!;
    expect(member.voice).toStrictEqual(assignVoice(member, cast, voices, 'en-US'));
    expect(member.voice.voiceName).toBe(ZIRA);
    expect(Object.keys(member.voice)).toEqual(['voiceName', 'lang', 'pitch', 'rate']);
    expect(member).toMatchObject({ id: 'a', name: 'Alex', gender: 'female' });
    expect(result.value.filter((c) => c.id !== 'a')).toEqual(cast.filter((c) => c.id !== 'a'));
  });

  it('keeps the voice name when the device has no voice for the language', () => {
    const result = repickMember(cast, 'a', [], 'en-US');
    expect(result.ok && result.value[2]!.voice).toMatchObject({ voiceName: 'en-a', lang: 'en-US' });
    expect(result.ok && Object.keys(result.value[2]!.voice)).not.toContain('manual');
  });

  it('gives the same voice again to a member that already has the automatic one', () => {
    const first = assignVoice(character('b', 'Blake'), baseCast('en'), voices, 'en-US');
    const own = [...baseCast('en'), { ...character('b', 'Blake'), voice: first }];
    const result = repickMember(own, 'b', voices, 'en-US');
    expect(result.ok && result.value[2]!.voice).toStrictEqual(first);
  });

  it('rejects a member that is not in the cast', () => {
    expect(repickMember(cast, 'nobody', voices, 'en-US')).toMatchObject({ ok: false });
  });
});

describe('a narrator picked again (setTraits, repickMember)', () => {
  const DAVID = 'Microsoft David - English (United States)';
  const ZIRA = 'Microsoft Zira - English (United States)';
  const MARK = 'Microsoft Mark - English (United States)';
  const HAZEL = 'Microsoft Hazel - English (United Kingdom)';
  const windows: DeviceVoice[] = [
    { name: DAVID, lang: 'en-US', isDefault: true },
    { name: ZIRA, lang: 'en-US' },
    { name: MARK, lang: 'en-US' },
  ];
  /** A new story's cast as createStory stores it: both on the device's default voice. */
  const fresh = (): Character[] => {
    const [narrator, unknown] = baseCast('en');
    return [narrator!, { ...unknown!, voice: { lang: 'en-US', pitch: 1.15, rate: 1 } }];
  };
  const cents = (n: number) => Math.round(n * 100);
  const on = (voiceName: string, pitch: number, rate: number) => ({
    voiceName,
    lang: 'en-US',
    pitch,
    rate,
  });
  /** The voice, pitch and rate a member is really heard with on the device. */
  const heard = (c: Character, deviceVoices: DeviceVoice[]) =>
    `${resolveVoice(c.voice, deviceVoices).voiceName}|${cents(c.voice.pitch)}|${cents(c.voice.rate)}`;
  /** The characters on the voice the narrator speaks with, within 0.05 of its pitch. */
  const nearNarrator = (cast: readonly Character[], deviceVoices: DeviceVoice[]) => {
    const narrator = cast.find((c) => c.role === 'narrator')!;
    const voiceOf = (c: Character) => resolveVoice(c.voice, deviceVoices).voiceName;
    return cast
      .filter(
        (c) =>
          c.role === 'character' &&
          voiceOf(c) === voiceOf(narrator) &&
          Math.abs(cents(c.voice.pitch) - cents(narrator.voice.pitch)) <= 5,
      )
      .map((c) => c.id);
  };
  const traitsSet = (
    cast: Character[],
    changes: Parameters<typeof setTraits>[2],
    deviceVoices: DeviceVoice[],
  ) => {
    const result = setTraits(cast, 'narrator', changes, deviceVoices, 'en-US');
    if (!result.ok) throw new Error(result.reason);
    return result.value.cast;
  };
  const repicked = (cast: Character[], deviceVoices: DeviceVoice[]) => {
    const result = repickMember(cast, 'narrator', deviceVoices, 'en-US');
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  };
  const woman = (id: string): Omit<Character, 'voice'> => ({
    id,
    role: 'character',
    name: id,
    aliases: [],
    gender: 'female',
  });

  it('moves the characters its new voice brings too near, in cast order, each seeing the ones before', () => {
    const women = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'].map(woman);
    const cast = [...fresh(), ...assignVoices(women, fresh(), windows, 'en-US')];
    // Every woman is on the only woman's voice, which the narrator is about to take.
    expect(cast.slice(2).every((c) => c.voice.voiceName === ZIRA)).toBe(true);
    const narrator: Character = { ...cast[0]!, gender: 'female', voice: on(ZIRA, 1, 1) };
    const clashing = nearNarrator([narrator, ...cast.slice(1)], windows);
    expect(clashing.length).toBeGreaterThan(1);

    const after = traitsSet(cast, { gender: 'female' }, windows);
    expect(after[0]).toStrictEqual(narrator);
    expect(nearNarrator(after, windows)).toEqual([]);
    expect(new Set(after.map((c) => heard(c, windows))).size).toBe(after.length);

    // Only the clashing ones moved; each pick saw the new narrator and the picks before it.
    const expected: Character[] = [narrator, ...cast.slice(1)];
    for (const [i, c] of expected.entries()) {
      if (clashing.includes(c.id)) {
        expected[i] = { ...c, voice: repickVoice(c, expected, windows, 'en-US') };
      }
    }
    expect(after).toStrictEqual(expected);
    for (const [i, c] of cast.entries()) {
      if (i > 0 && !clashing.includes(c.id)) expect(after[i]).toBe(c);
    }
  });

  it('moves a character that would be heard exactly as the re-picked narrator', () => {
    const [narrator, unknown] = fresh();
    const byHand: Character = { ...narrator!, voice: { ...on(ZIRA, 1, 1), manual: true } };
    const bear: Omit<Character, 'voice'> = {
      id: 'c4',
      role: 'character',
      name: 'Bruin',
      aliases: [],
      species: 'animal',
      size: 'large',
    };
    const cast = [byHand, unknown!, ...assignVoices([bear], [byHand, unknown!], windows, 'en-US')];
    // With the narrator on Zira, the bear was free to read as the default voice does.
    expect(cast[2]!.voice).toStrictEqual(on(DAVID, 1, 1));

    const after = repicked(cast, windows);
    expect(after[0]!.voice).toStrictEqual({ lang: 'en-US', pitch: 1, rate: 1 });
    expect(nearNarrator(after, windows)).toEqual([]);
    expect(heard(after[2]!, windows)).not.toBe(heard(after[0]!, windows));
    expect(after[2]!.voice).toStrictEqual(repickVoice(cast[2]!, after, windows, 'en-US'));
    expect(after[1]).toBe(unknown);
  });

  it('does the same when clearing the narrator’s last trait sends it back to the default voice', () => {
    const lady = traitsSet(fresh(), { gender: 'female' }, windows);
    expect(lady[0]!.voice.voiceName).toBe(ZIRA);
    const bear: Character = { ...character('c4', 'Bruin'), species: 'animal', size: 'large' };
    const cast = [...lady, ...assignVoices([bear], lady, windows, 'en-US')];
    expect(cast[2]!.voice).toStrictEqual(on(DAVID, 1, 1));

    const after = traitsSet(cast, { gender: undefined }, windows);
    expect(after[0]!.voice).toStrictEqual({ lang: 'en-US', pitch: 1, rate: 1 });
    expect(nearNarrator(after, windows)).toEqual([]);
    expect(after[2]).toMatchObject({ species: 'animal', size: 'large' });
  });

  it('leaves hand-set voices and characters far enough in pitch alone, and guesses no traits', () => {
    const voices: DeviceVoice[] = [
      { name: DAVID, lang: 'en-US', isDefault: true },
      { name: ZIRA, lang: 'en-US' },
      { name: HAZEL, lang: 'en-GB' },
    ];
    const byHand = { ...on(ZIRA, 1, 1.1), manual: true as const };
    const cast: Character[] = [
      ...fresh(),
      { ...character('holmes', 'Holmes'), voice: on(ZIRA, 1.1, 1.07) },
      { ...character('watson', 'Watson'), voice: on(HAZEL, 0.95, 0.95) },
      { ...character('hudson', 'Mrs Hudson'), voice: on(ZIRA, 0.95, 0.99) },
      { ...character('lestrade', 'Lestrade'), voice: on(HAZEL, 1.1, 1.07) },
      { ...character('adler', 'Irene Adler'), voice: byHand },
    ];
    const after = traitsSet(cast, { gender: 'female' }, voices);
    const get = (id: string) => after.find((c) => c.id === id)!;
    expect(after[0]!.voice).toStrictEqual(on(ZIRA, 1, 1));
    // Mrs Hudson was 0.05 below the narrator's pitch on its new voice.
    expect(get('hudson').voice.voiceName).not.toBe(ZIRA);
    expect(get('hudson').voice).toStrictEqual(
      repickVoice(cast[4]!, [after[0]!, ...cast.slice(1)], voices, 'en-US'),
    );
    // "Mrs" would make her a woman, who belongs on Zira: only the voice changes here.
    expect(Object.keys(get('hudson'))).toEqual(['id', 'role', 'name', 'aliases', 'voice']);
    // Holmes shares the voice 0.10 above the narrator, which is far enough.
    for (const id of ['unknown', 'holmes', 'watson', 'lestrade', 'adler']) {
      expect(get(id)).toBe(cast.find((c) => c.id === id));
    }
    expect(nearNarrator(after, voices)).toEqual(['adler']);
  });

  it('moves them too when only the narrator’s pitch changes on the voice they share', () => {
    const only: DeviceVoice[] = [{ name: DAVID, lang: 'en-US', isDefault: true }];
    const women = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5'].map(woman);
    const cast = [...fresh(), ...assignVoices(women, fresh(), only, 'en-US')];
    const pitches = cast.slice(2).map((c) => cents(c.voice.pitch));
    expect(pitches.some((pitch) => pitch >= 105 && pitch <= 115)).toBe(true);

    // A woman reading with a man's voice is pitched up, into the middle of the women.
    const after = traitsSet(cast, { gender: 'female' }, only);
    expect(after[0]!.voice).toStrictEqual({ lang: 'en-US', pitch: 1.1, rate: 1 });
    expect(nearNarrator(after, only)).toEqual([]);
    expect(new Set(after.map((c) => heard(c, only))).size).toBe(after.length);
    expect(after.slice(2).every((c) => c.voice.voiceName === DAVID)).toBe(true);
    // The unknown speaker, now 0.05 above the narrator, is not a character: it stays.
    expect(after[1]).toBe(cast[1]);
  });

  it('leaves everyone as they were when the narrator keeps its voice and pitch', () => {
    // Stored before the rule existed: a character that reads exactly as the narrator does.
    const twin = { ...character('twin', 'Twin'), voice: on(DAVID, 1, 1) };
    const cast = [...fresh(), twin];
    const slower = traitsSet(cast, { age: 'elder' }, windows);
    expect(slower[0]!.voice).toStrictEqual({ lang: 'en-US', pitch: 1, rate: 0.88 });
    expect(slower[2]).toBe(twin);
    const again = repicked(cast, windows);
    expect(again[0]!.voice).toStrictEqual({ lang: 'en-US', pitch: 1, rate: 1 });
    expect(again[2]).toBe(twin);
  });

  it('tells an identical character from the narrator on a device with no voice for the language', () => {
    const [narrator, unknown] = fresh();
    const byHand: Character = {
      ...narrator!,
      voice: { lang: 'en-US', pitch: 1.2, rate: 0.9, manual: true },
    };
    const twin = { ...character('twin', 'Twin'), voice: { lang: 'en-US', pitch: 1, rate: 1 } };
    const after = repicked([byHand, unknown!, twin], []);
    expect(after[0]!.voice).toStrictEqual({ lang: 'en-US', pitch: 1, rate: 1 });
    expect(after[2]!.voice).not.toMatchObject({ pitch: 1, rate: 1 });
    expect(after[2]!.voice).toStrictEqual(repickVoice(twin, after, [], 'en-US'));
    // With no voice name to compare, a different rate is enough: nothing is too near.
    const slow = { ...twin, voice: { lang: 'en-US', pitch: 1, rate: 0.95 } };
    expect(repicked([byHand, unknown!, slow], [])[2]).toBe(slow);
  });
});

describe('matchVoicesToTraits', () => {
  const ZIRA = 'Microsoft Zira - English (United States)';
  const DAVID = 'Microsoft David - English (United States)';
  const voices: DeviceVoice[] = [
    { name: 'en-a', lang: 'en-US', isDefault: true },
    { name: DAVID, lang: 'en-US' },
    { name: ZIRA, lang: 'en-US' },
    { name: 'es-a', lang: 'es-ES' },
  ];
  const byHand = { voiceName: 'en-a', lang: 'en-US', pitch: 1.4, rate: 0.7, manual: true as const };
  const [narrator, unknown] = baseCast('en');
  const cast: Character[] = [
    character('man', 'the old man'),
    { ...narrator!, gender: 'female', name: 'Grandma Rose' },
    { ...character('gran', 'Lucy’s grandmother'), voice: byHand },
    { ...unknown!, aliases: ['the little girl'] },
    { ...character('tom', 'Tom', ['the little boy']), gender: 'other' },
    { ...character('ann', 'Ann'), gender: 'female' },
    { ...character('eve', 'Eve'), gender: 'female' },
  ];
  const matched = matchVoicesToTraits(cast, voices, 'en-US', 'en');
  const get = (id: string) => matched.find((c) => c.id === id)!;

  it('keeps the cast in order and leaves the narrator and the unknown speaker untouched', () => {
    expect(matched.map((c) => c.id)).toEqual(cast.map((c) => c.id));
    expect(matched[1]).toBe(cast[1]);
    expect(matched[3]).toBe(cast[3]);
  });

  it('guesses the traits a character lacks from its name and other names, filling only', () => {
    expect(get('man')).toMatchObject({ gender: 'male', age: 'elder' });
    expect(get('gran')).toMatchObject({ gender: 'female', age: 'elder' });
    // The gender set by hand stays; the age comes from "the little boy".
    expect(get('tom')).toMatchObject({ gender: 'other', age: 'child' });
    expect(Object.keys(get('ann'))).toEqual(Object.keys(cast[5]!));
  });

  it('picks every voice again to match, except the ones set by hand', () => {
    expect(get('man').voice.voiceName).toBe(DAVID);
    expect(get('gran').voice).toStrictEqual(byHand);
    expect(get('tom').voice.voiceName).toBe(ZIRA);
    expect(get('ann').voice.voiceName).toBe(ZIRA);
    expect(get('eve').voice.voiceName).toBe(ZIRA);
    for (const c of matched.filter((m) => m.role === 'character')) {
      expect(Object.keys(c.voice).includes('manual')).toBe(c.id === 'gran');
    }
  });

  it('picks each voice seeing the narrator, the unknown speaker, hand-set voices and earlier picks', () => {
    // Each pick is what assignVoice gives with the members handled before it and the fixed ones.
    const fixed = [cast[1]!, cast[2]!, cast[3]!];
    const seen = (...earlier: string[]) => [...fixed, ...earlier.map(get)];
    expect(get('man').voice).toStrictEqual(assignVoice(get('man'), seen(), voices, 'en-US'));
    expect(get('tom').voice).toStrictEqual(assignVoice(get('tom'), seen('man'), voices, 'en-US'));
    expect(get('ann').voice).toStrictEqual(
      assignVoice(get('ann'), seen('man', 'tom'), voices, 'en-US'),
    );
    expect(get('eve').voice).toStrictEqual(
      assignVoice(get('eve'), seen('man', 'tom', 'ann'), voices, 'en-US'),
    );
    const combos = matched
      .filter((c) => c.role === 'character')
      .map((c) => `${c.voice.voiceName}|${c.voice.pitch}|${c.voice.rate}`);
    expect(new Set(combos).size).toBe(5);
  });

  it('shares the voices out again, counting the hand-set ones and not the voices being replaced', () => {
    const plain: DeviceVoice[] = [
      { name: 'en-a', lang: 'en-US', isDefault: true },
      { name: 'en-b', lang: 'en-US' },
      { name: 'en-c', lang: 'en-US' },
    ];
    const on = (voiceName: string) => ({ voiceName, lang: 'en-US', pitch: 1, rate: 1 });
    const crowd: Character[] = [
      ...baseCast('en'),
      { ...character('h', 'Hal'), voice: { ...on('en-b'), manual: true } },
      { ...character('x', 'Xu'), voice: on('en-c') },
      { ...character('y', 'Yo'), voice: on('en-c') },
      { ...character('z', 'Zed'), voice: on('en-c') },
    ];
    const shared = matchVoicesToTraits(crowd, plain, 'en-US', 'en');
    expect(shared.slice(2).map((c) => c.voice.voiceName)).toEqual(['en-b', 'en-c', 'en-b', 'en-c']);
  });

  it('reads the names in the story’s language', () => {
    const es = matchVoicesToTraits(
      [...baseCast('es'), character('a', 'mi abuela'), character('b', 'the old man')],
      voices,
      'es-ES',
      'es',
    );
    expect(es[2]).toMatchObject({ gender: 'female', age: 'elder' });
    expect(es[2]!.voice).toMatchObject({ voiceName: 'es-a', lang: 'es-ES' });
    expect(Object.keys(es[3]!)).toEqual(['id', 'role', 'name', 'aliases', 'voice']);
  });
});

describe('renameCharacter / aliases', () => {
  const cast = [...baseCast('en'), character('a', 'his wife')];

  it('keeps the old name as an alias', () => {
    const result = renameCharacter(cast, 'a', '  Mrs.   Bennet ');
    expect(result.ok && result.value[2]).toMatchObject({
      name: 'Mrs. Bennet',
      aliases: ['his wife'],
    });
  });

  it('does not alias the narrator’s old name', () => {
    const result = renameCharacter(cast, 'narrator', 'Ishmael');
    expect(result.ok && result.value[0]).toMatchObject({ name: 'Ishmael', aliases: [] });
  });

  it('keeps a named narrator’s old name as an alias', () => {
    const named = cast.map((c) => (c.id === 'narrator' ? { ...c, name: 'Watson' } : c));
    const result = renameCharacter(named, 'narrator', 'John Watson');
    expect(result.ok && result.value[0]).toMatchObject({
      name: 'John Watson',
      aliases: ['Watson'],
    });
  });

  it('does not alias a default name or the same name written differently', () => {
    const unnamed = cast.map((c) => (c.id === 'unknown' ? { ...c, name: UNKNOWN_NAME.es } : c));
    const unknown = renameCharacter(unnamed, 'unknown', 'Una voz');
    expect(unknown.ok && unknown.value[1]).toMatchObject({ name: 'Una voz', aliases: [] });
    const respelled = renameCharacter([...cast, character('o', "O'Brien")], 'o', 'O’Brien');
    expect(respelled.ok && respelled.value[3]).toMatchObject({ name: 'O’Brien', aliases: [] });
  });

  it('un-names a narrator renamed back to its default name, keeping only the listed names', () => {
    const nick = cast.map((c) => (c.id === 'narrator' ? { ...c, name: 'Nick' } : c));
    const unnamed = renameCharacter(nick, 'narrator', 'Narrator');
    expect(unnamed.ok && unnamed.value[0]).toMatchObject({ name: 'Narrator', aliases: [] });
    const ines = cast.map((c) => (c.id === 'narrator' ? { ...c, name: 'Inés' } : c));
    const es = renameCharacter(ines, 'narrator', NARRATOR_NAME.es);
    expect(es.ok && es.value[0]).toMatchObject({ name: 'Narrador', aliases: [] });
    const listed = cast.map((c) => (c.id === 'narrator' ? { ...c, aliases: ['Nick'] } : c));
    const again = renameCharacter(listed, 'narrator', 'Narrator');
    expect(again.ok && again.value[0]).toMatchObject({ name: 'Narrator', aliases: ['Nick'] });
  });

  it('keeps no old names for the unknown speaker, only the names merged into it', () => {
    const named = cast.map((c) => (c.id === 'unknown' ? { ...c, name: 'Una voz' } : c));
    const renamed = renameCharacter(named, 'unknown', 'Voces');
    expect(renamed.ok && renamed.value[1]).toMatchObject({ name: 'Voces', aliases: [] });
    const merged = cast.map((c) => (c.id === 'unknown' ? { ...c, aliases: ['una voz'] } : c));
    const kept = renameCharacter(merged, 'unknown', 'Voces');
    expect(kept.ok && kept.value[1]).toMatchObject({ name: 'Voces', aliases: ['una voz'] });
  });

  it('rejects empty names', () => {
    expect(renameCharacter(cast, 'a', '  ')).toMatchObject({ ok: false });
  });

  it('parses alias lists without duplicates or the name itself', () => {
    expect(parseAliases('Liz, lizzy , Lizzy,, Elizabeth', 'Elizabeth')).toEqual(['Liz', 'lizzy']);
    const result = setAliases(cast, 'a', ['Mrs. B']);
    expect(result.ok && result.value[2]!.aliases).toEqual(['Mrs. B']);
  });
});

describe('findNameOwner', () => {
  const [narrator, unknown] = baseCast('en');
  const cast: Character[] = [
    { ...narrator!, aliases: ['Watson'] },
    { ...unknown!, name: UNKNOWN_NAME.en },
    character('jane', 'Jane', ['Miss Bennet']),
    character('obrien', 'Mr. O’Brien'),
  ];

  it('finds the member called that, except the one being edited', () => {
    expect(findNameOwner(cast, 'jane')?.id).toBe('jane');
    expect(findNameOwner(cast, 'jane', 'jane')).toBeUndefined();
    expect(findNameOwner(cast, ' miss  bennet ')?.id).toBe('jane');
    expect(findNameOwner(cast, "Mr O'Brien")?.id).toBe('obrien');
    expect(findNameOwner(cast, 'Watson')?.id).toBe('narrator');
  });

  it('treats default names as nobody’s', () => {
    expect(findNameOwner(cast, 'Narrator')).toBeUndefined();
    expect(findNameOwner(cast, 'Unknown speaker')).toBeUndefined();
    expect(findNameOwner(cast, '  ')).toBeUndefined();
  });
});

describe('findTypedNameOwner', () => {
  const [narrator, unknown] = baseCast('en');
  const tom = character('tom', 'Tom', ['Tommy']);
  const cast: Character[] = [narrator!, { ...unknown!, name: UNKNOWN_NAME.en }, tom];
  const es: Character[] = [
    { ...narrator!, name: NARRATOR_NAME.es },
    { ...unknown!, name: UNKNOWN_NAME.es },
    tom,
  ];

  it('reads the narrator’s default name as the narrator, named or not', () => {
    expect(findTypedNameOwner(cast, 'narrator', 'narrator')?.id).toBe('narrator');
    expect(findTypedNameOwner(es, 'Narrador', 'narrator')?.id).toBe('narrator');
    const watson = cast.map((c) => (c.id === 'narrator' ? { ...c, name: 'Watson' } : c));
    expect(findTypedNameOwner(watson, 'Narrator', 'narrator')?.id).toBe('narrator');
    expect(findTypedNameOwner(cast, 'tommy', 'narrator')?.id).toBe('tom');
  });

  it('leaves the unknown speaker’s default name free, and the narrator’s on its own card', () => {
    expect(findTypedNameOwner(es, 'Desconocido', 'narrator')).toBeUndefined();
    expect(findTypedNameOwner(cast, 'Narrator', 'narrator', 'narrator')).toBeUndefined();
  });
});

describe('findNameClash', () => {
  const [narrator, unknown] = baseCast('en');
  const cast: Character[] = [
    narrator!,
    { ...unknown!, name: UNKNOWN_NAME.en },
    character('elizabeth', 'Elizabeth', ['Lizzy']),
    character('jane', 'Jane'),
    character('kit', 'Kit'),
    character('watson', 'Watson'),
  ];
  /** The clashing name and who has it, for an edit of member `id`. */
  const clash = (id: string, name: string, aliases: string[] = [], within = cast) => {
    const found = findNameClash(within, id, { name, aliases }, 'narrator');
    return found && [found.name, found.owner.id];
  };
  const withAliases = (id: string, aliases: string[]) =>
    cast.map((c) => (c.id === id ? { ...c, aliases } : c));

  it('refuses another member’s name, as the new name or as one of the other names', () => {
    expect(clash('elizabeth', 'Jane')).toEqual(['Jane', 'jane']);
    expect(clash('jane', 'lizzy')).toEqual(['lizzy', 'elizabeth']);
    expect(clash('elizabeth', 'Elizabeth', ['Lizzy', 'Jane'])).toEqual(['Jane', 'jane']);
    expect(clash('narrator', 'Narrator', ['Watson'])).toEqual(['Watson', 'watson']);
    expect(clash('narrator', 'Narrator', [' kit '])).toEqual([' kit ', 'kit']);
    // Typed as a name, "Narrator" means the narrator.
    expect(clash('jane', 'Narrator')).toEqual(['Narrator', 'narrator']);
  });

  it('skips its current name and the other names it has, so a clash saved earlier never blocks an edit', () => {
    const jane = withAliases('elizabeth', ['jane']);
    expect(clash('elizabeth', 'Elizabeth', ['Jane', 'Lizzy'], jane)).toBeUndefined();
    const twoJanes = cast.map((c) => (c.id === 'elizabeth' ? { ...c, name: 'jane' } : c));
    expect(clash('elizabeth', 'Jane', ['Lizzy'], twoJanes)).toBeUndefined();
    const kit = withAliases('narrator', ['Kit']);
    expect(clash('narrator', 'Narrator', ['Kit', 'Kitty'], kit)).toBeUndefined();
    expect(clash('kit', 'Christopher', ['Kit'], kit)).toBeUndefined();
    expect(clash('watson', 'John Watson', ['Watson'])).toBeUndefined();
  });

  it('refuses one of its other names as its new name while another member has it', () => {
    // Other names saved before the check: made the name, two members would be called the same.
    const kit = withAliases('narrator', ['Kit']);
    expect(clash('narrator', 'Kit', [], kit)).toEqual(['Kit', 'kit']);
    const jane = withAliases('elizabeth', ['Lizzy', 'jane']);
    expect(clash('elizabeth', 'Jane', ['Lizzy'], jane)).toEqual(['Jane', 'jane']);
    // "Narrator" is free as an other name, but typed as a name it means the narrator.
    const narratorAlias = withAliases('jane', ['Narrator']);
    expect(clash('jane', 'Narrator', [], narratorAlias)).toEqual(['Narrator', 'narrator']);
    // An other name nobody else has can still become the name.
    expect(clash('elizabeth', 'Lizzy', ['Elizabeth'])).toBeUndefined();
  });

  it('leaves default names typed as other names free, and the narrator’s own default name', () => {
    expect(clash('jane', 'Jane', ['Narrator', 'Unknown speaker'])).toBeUndefined();
    const named = cast.map((c) => (c.id === 'narrator' ? { ...c, name: 'Nick' } : c));
    expect(clash('narrator', 'Narrator', [], named)).toBeUndefined();
  });

  it('refuses the names the user gave the unknown speaker, never its default names', () => {
    // A member merged into it, or a name it was renamed to: CastView sends the user to its card.
    const merged = mergeCharacters(cast, [], 'kit', 'unknown');
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(clash('jane', 'Jane', ['kit'], merged.value.cast)).toEqual(['kit', 'unknown']);
    expect(clash('narrator', 'Kit', [], merged.value.cast)).toEqual(['Kit', 'unknown']);
    const crowd = cast.map((c) => (c.id === 'unknown' ? { ...c, name: 'Crowd' } : c));
    expect(clash('jane', 'crowd', [], crowd)).toEqual(['crowd', 'unknown']);
    expect(clash('jane', 'Unknown speaker')).toBeUndefined();
    const es = cast.map((c) => (c.id === 'unknown' ? { ...c, name: UNKNOWN_NAME.es } : c));
    expect(clash('jane', 'Desconocido', ['Unknown speaker'], es)).toBeUndefined();
  });
});

describe('castUsage', () => {
  it('counts lines per speaker', () => {
    const usage = castUsage([analysis('p', ['a', 'a', 'b']), undefined]);
    expect(Object.fromEntries(usage)).toEqual({ a: 2, b: 1 });
  });
});

describe('linesOf', () => {
  it('lists a speaker’s lines in story order, with their part and index', () => {
    const lines = linesOf([analysis('p1', ['a', 'b', 'a']), undefined, analysis('p2', ['a'])], 'a');
    expect(lines.map(({ partId, index }) => [partId, index])).toEqual([
      ['p1', 0],
      ['p1', 2],
      ['p2', 0],
    ]);
    expect(lines[1]!.segment.start).toBe(2);
    expect(linesOf([analysis('p1', ['b'])], 'a')).toEqual([]);
  });
});

describe('saveAnalysis alias additions', () => {
  let db: StoryDb | undefined;
  afterEach(async () => {
    await db?.delete();
  });

  it('adds each new alias once and never a name the member already has', async () => {
    db = openStoryDb(`cast-${Math.random()}`);
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const obrien = character('obrien', 'Mr. O’Brien', ['Tom']);
    await updateStory(db, story.id, { cast: [...story.cast, obrien] });
    const part = await addPart(db, story.id, paste('Hello.'));
    const narrated: Analysis = {
      partId: part.id,
      textHash: part.textHash,
      analyzer: { kind: 'heuristic', version: 1 },
      createdAt: '',
      segments: [
        {
          start: 0,
          end: part.text.length,
          speakerId: story.narratorId,
          mode: 'narration',
          source: 'heuristic',
        },
      ],
    };
    await saveAnalysis(db, narrated, {
      added: [],
      aliasAdditions: [
        { characterId: 'obrien', alias: "Mr O'Brien" },
        { characterId: 'obrien', alias: 'tom' },
        { characterId: 'obrien', alias: 'O’Brien' },
        { characterId: 'obrien', alias: "o'brien" },
      ],
    });
    const after = (await getStory(db, story.id))!.cast.find((c) => c.id === 'obrien')!;
    expect(after.aliases).toEqual(['Tom', 'O’Brien']);
  });
});

describe('mergeCharactersInStory', () => {
  let db: StoryDb | undefined;
  afterEach(async () => {
    await db?.delete();
  });

  async function marianela() {
    db = openStoryDb(`cast-${Math.random()}`);
    const { text } = loadFixture('es/marianela-ch1');
    const story = await createStory(db, { title: 'Marianela', lang: 'es' });
    const cut = text.indexOf('--¿Va usted al establecimiento?');
    const one = await addPart(db, story.id, paste(text.slice(0, cut)));
    const two = await addPart(db, story.id, paste(text.slice(cut)));
    await analyzePart(db, one.id, { voices: [] });
    await analyzePart(db, two.id, { voices: [] });
    const cast = (await getStory(db, story.id))!.cast;
    const id = (name: string) => cast.find((c) => c.name === name)!.id;
    return { db, story, parts: [one, two], id };
  }

  async function emptyStory(lang: Lang) {
    db = openStoryDb(`cast-${Math.random()}`);
    return { db, story: await createStory(db, { title: 'S', lang }) };
  }

  it('rewrites every part and keeps all analyses valid', async () => {
    const { db, story, parts, id } = await marianela();
    const doctor = id('el doctor');
    const golfin = id('Golfín');
    // Where "el doctor" spoke before the merge, per part (segment start offsets).
    const doctorLines = new Map<string, number[]>();
    for (const p of parts) {
      const a = (await getAnalysis(db, p.id))!;
      doctorLines.set(
        p.id,
        a.segments.filter((s) => s.speakerId === doctor).map((s) => s.start),
      );
    }
    expect([...doctorLines.values()].flat().length).toBeGreaterThan(0);
    await mergeCharactersInStory(db, story.id, doctor, golfin);

    const after = (await getStory(db, story.id))!;
    expect(after.cast.some((c) => c.id === doctor)).toBe(false);
    expect(after.cast.find((c) => c.id === golfin)!.aliases).toContain('el doctor');
    const ids = new Set(after.cast.map((c) => c.id));
    for (const p of parts) {
      const a = (await getAnalysis(db, p.id))!;
      expect(a.segments.some((s) => s.speakerId === doctor)).toBe(false);
      expect(validateAnalysis((await getPart(db, p.id))!, a, ids)).toEqual({ ok: true });

      // Playback reads those lines with the surviving character's voice.
      const part = (await getPart(db, p.id))!;
      const queue = buildUtterances(part, a, after.cast, 0, 1);
      const golfinVoice = after.cast.find((c) => c.id === golfin)!.voice;
      for (const start of doctorLines.get(p.id)!) {
        const index = a.segments.findIndex((s) => s.start <= start && start < s.end);
        const spoken = queue.filter((u) => u.segmentIndex === index);
        expect(spoken.length).toBeGreaterThan(0);
        for (const u of spoken) expect(u.voice).toEqual(golfinVoice);
      }
    }
  });

  it('rolls back completely when writing an analysis fails', async () => {
    const { db, story, id } = await marianela();
    const before = await getStory(db, story.id);
    const analysesBefore = await db.analyses.toArray();
    db.analyses.hook('creating', () => {
      throw new Error('disk full');
    });
    db.analyses.hook('updating', () => {
      throw new Error('disk full');
    });
    await expect(
      mergeCharactersInStory(db, story.id, id('el doctor'), id('Golfín')),
    ).rejects.toThrow();
    expect(await getStory(db, story.id)).toEqual(before);
    expect(await db.analyses.toArray()).toEqual(analysesBefore);
  });

  it('gives later lines to the narrator a duplicate was merged into', async () => {
    const { db, story } = await emptyStory('en');
    const one = await addPart(db, story.id, paste('“Come here, Kit,” said Abel.\n\n“Coming.”'));
    await analyzePart(db, one.id, { voices: [] });
    const kit = (await getStory(db, story.id))!.cast.find((c) => c.name === 'Kit');
    expect(kit).toBeDefined();

    await mergeCharactersInStory(db, story.id, kit!.id, story.narratorId);
    const merged = (await getStory(db, story.id))!.cast;
    expect(merged.find((c) => c.id === story.narratorId)!.aliases).toEqual(['Kit']);

    const two = await addPart(db, story.id, paste('“Late again, Kit,” said Abel.\n\n“Sorry.”'));
    await analyzePart(db, two.id, { voices: [] });
    expect((await segmentAt(db, two, '“Sorry.”'))?.speakerId).toBe(story.narratorId);
    const after = (await getStory(db, story.id))!.cast;
    expect(after.map((c) => c.id)).toEqual(merged.map((c) => c.id));
  });

  it('keeps lines merged off the unknown speaker when the part is analysed again', async () => {
    const { db, story } = await emptyStory('en');
    const unknown = story.cast.find((c) => c.role === 'unknown')!.id;
    const part = await addPart(
      db,
      story.id,
      paste(
        'The door creaked open.\n\n“Who goes there?”\n\nNobody answered.\n\n' +
          '“Only the wind,” said Mr. Rochester at last.',
      ),
    );
    await analyzePart(db, part.id, { voices: [] });
    expect((await segmentAt(db, part, '“Who goes there?”'))?.speakerId).toBe(unknown);
    const rochester = (await getStory(db, story.id))!.cast.find((c) => c.name === 'Mr. Rochester');
    expect(rochester).toBeDefined();

    await mergeCharactersInStory(db, story.id, unknown, rochester!.id);
    expect(await segmentAt(db, part, '“Who goes there?”')).toMatchObject({
      speakerId: rochester!.id,
      source: 'user',
    });
    await analyzePart(db, part.id, { voices: [] });
    expect((await segmentAt(db, part, '“Who goes there?”'))?.speakerId).toBe(rochester!.id);
  });

  it('gives the narrator back the default name of the story’s language', async () => {
    const { db, story } = await emptyStory('es');
    const named = story.cast.map((c) => (c.id === story.narratorId ? { ...c, name: 'Inés' } : c));
    await updateStory(db, story.id, { cast: [...named, character('julian', 'Julián')] });
    await mergeCharactersInStory(db, story.id, story.narratorId, 'julian');
    const after = (await getStory(db, story.id))!.cast;
    expect(after.find((c) => c.id === story.narratorId)).toMatchObject({
      name: 'Narrador',
      aliases: [],
    });
    expect(after.find((c) => c.id === 'julian')!.aliases).toEqual(['Inés']);
  });
});

describe('partsToldBy', () => {
  /** An analysis of consecutive narration spans, each [speakerId, length]. */
  const narrated = (partId: string, spans: Array<[string, number]>): Analysis => {
    let start = 0;
    const segments = spans.map(([speakerId, length]): Segment => {
      start += length;
      return { start: start - length, end: start, speakerId, mode: 'narration', source: 'llm' };
    });
    return { ...analysis(partId, []), segments };
  };

  it('counts the parts whose narration a member reads most of', () => {
    const analyses = [
      narrated('p1', [
        ['amy', 10],
        ['narrator', 5],
      ]),
      narrated('p2', [['narrator', 8]]),
      narrated('p3', [
        ['amy', 4],
        ['narrator', 4],
      ]),
      analysis('p4', ['amy', 'amy']),
      undefined,
    ];
    expect(partsToldBy(analyses, 'amy', 'narrator')).toBe(1);
    expect(partsToldBy(analyses, 'narrator', 'narrator')).toBe(3);
    expect(partsToldBy(analyses, 'nick', 'narrator')).toBe(0);
  });

  it('counts a part once “Told by” gives its narration to a character', () => {
    const text = 'AMY\n\n“Hi,” I said.';
    const before: Analysis = {
      ...analysis('p', []),
      segments: [
        { start: 0, end: 5, speakerId: 'narrator', mode: 'narration', source: 'heuristic' },
        { start: 5, end: 10, speakerId: 'narrator', mode: 'speech', source: 'heuristic' },
        { start: 10, end: 18, speakerId: 'narrator', mode: 'narration', source: 'heuristic' },
      ],
    };
    expect(partsToldBy([before], 'amy', 'narrator')).toBe(0);
    const segments = reassignSegments(text, before.segments, 0, 'amy', {
      narratorId: 'narrator',
      scope: 'part',
    });
    expect(partsToldBy([{ ...before, segments }], 'amy', 'narrator')).toBe(1);
    expect(partsToldBy([{ ...before, segments }], 'narrator', 'narrator')).toBe(0);
  });
});

describe('filterCast', () => {
  const cast: Character[] = [
    { ...character('n', 'Narrator'), role: 'narrator' },
    character('j', 'José Arcadio', ['the colonel']),
    character('o', 'Mrs. O’Brien'),
    character('d', 'Mr Darcy'),
  ];
  const names = (query: string) => filterCast(cast, query).map((c) => c.name);

  it('finds the member a typed name means when no name contains it', () => {
    expect(names('Mr. Darcy')).toEqual(['Mr Darcy']);
    expect(names('Mister Darcy')).toEqual(['Mr Darcy']);
    expect(names('Mr. Darcy’s')).toEqual(['Mr Darcy']);
    const renamed = cast.map((c) => (c.id === 'n' ? { ...c, name: 'Ishmael' } : c));
    expect(filterCast(renamed, 'narrator', 'n').map((c) => c.name)).toEqual(['Ishmael']);
  });

  it('keeps everyone, in order, for a blank query', () => {
    const everyone = ['Narrator', 'José Arcadio', 'Mrs. O’Brien', 'Mr Darcy'];
    expect(names('')).toEqual(everyone);
    expect(names('   ')).toEqual(everyone);
  });

  it('matches part of a name, ignoring case and accents', () => {
    expect(names('jose')).toEqual(['José Arcadio']);
    expect(names('ARCA')).toEqual(['José Arcadio']);
  });

  it('matches other names, and straight or curly apostrophes alike', () => {
    expect(names('colonel')).toEqual(['José Arcadio']);
    expect(names("o'bri")).toEqual(['Mrs. O’Brien']);
  });

  it('finds nobody for a name no one has', () => {
    expect(names('Aureliano')).toEqual([]);
  });
});
