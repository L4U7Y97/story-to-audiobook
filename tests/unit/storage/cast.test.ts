import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Character, Lang, Story } from '@/format/types';
import { assignVoice } from '@/cast/assignVoices';
import type { DeviceVoice } from '@/playback/engine';
import { openStoryDb, type StoryDb } from '@/storage/db';
import {
  matchVoicesInStory,
  repickVoiceInStory,
  setTraitsInStory,
  setVoiceInStory,
} from '@/storage/cast';
import { createStory, getStory, updateStory } from '@/storage/stories';

const ZIRA = 'Microsoft Zira - English (United States)';
const DAVID = 'Microsoft David - English (United States)';
const voices: DeviceVoice[] = [
  { name: 'en-a', lang: 'en-US', isDefault: true },
  { name: DAVID, lang: 'en-US' },
  { name: ZIRA, lang: 'en-US' },
  { name: 'es-a', lang: 'es-ES', isDefault: true },
  { name: 'es-b', lang: 'es-ES' },
];
const byHand = { voiceName: 'en-a', lang: 'en-US', pitch: 1.4, rate: 0.7, manual: true as const };

let db: StoryDb;
let count = 0;
beforeEach(() => {
  db = openStoryDb(`cast-ops-${++count}`);
});
afterEach(async () => {
  await db.delete();
});

const character = (id: string, name: string, more: Partial<Character> = {}): Character => ({
  id,
  role: 'character',
  name,
  aliases: [],
  voice: { lang: 'en-US', pitch: 1, rate: 1 },
  ...more,
});

/** A story whose cast is the narrator, the unknown speaker and `characters`, last updated long ago. */
async function storyWith(characters: Character[], lang: Lang = 'en'): Promise<Story> {
  const story = await createStory(db, { title: 'S', lang });
  await updateStory(db, story.id, { cast: [...story.cast, ...characters] });
  await db.stories.update(story.id, { updatedAt: '2000-01-01T00:00:00.000Z' });
  return (await getStory(db, story.id))!;
}

async function member(storyId: string, id: string): Promise<Character> {
  return (await getStory(db, storyId))!.cast.find((c) => c.id === id)!;
}

/** Makes every write to the stories table fail. */
function breakWrites(): void {
  db.stories.hook('updating', () => {
    throw new Error('disk full');
  });
}

describe('setTraitsInStory', () => {
  it('stores the traits with a voice picked again to match', async () => {
    const story = await storyWith([character('a', 'Alex'), character('b', 'Blake')]);
    const result = await setTraitsInStory(db, story.id, 'a', { gender: 'female' }, voices);
    expect(result).toEqual({ repicked: true });

    const after = (await getStory(db, story.id))!;
    const alex = after.cast.find((c) => c.id === 'a')!;
    expect(alex.gender).toBe('female');
    // The locale is the story language's default one.
    expect(alex.voice).toStrictEqual(assignVoice(alex, story.cast, voices, 'en-US'));
    expect(alex.voice.voiceName).toBe(ZIRA);
    expect(after.cast.filter((c) => c.id !== 'a')).toEqual(story.cast.filter((c) => c.id !== 'a'));
    expect(after.updatedAt > story.updatedAt).toBe(true);
  });

  it('keeps a voice set by hand and reports that it was not picked again', async () => {
    const story = await storyWith([character('a', 'Alex', { voice: byHand })]);
    expect(await setTraitsInStory(db, story.id, 'a', { age: 'child' }, voices)).toEqual({
      repicked: false,
    });
    const alex = await member(story.id, 'a');
    expect(alex.age).toBe('child');
    expect(alex.voice).toStrictEqual(byHand);
  });

  it('clears a trait without leaving its key in the stored member', async () => {
    const story = await storyWith([character('a', 'Alex', { gender: 'male', age: 'elder' })]);
    await setTraitsInStory(db, story.id, 'a', { age: undefined }, voices);
    const alex = await member(story.id, 'a');
    expect(Object.keys(alex)).not.toContain('age');
    expect(alex.gender).toBe('male');
  });

  it('writes nothing when nothing changes', async () => {
    const story = await storyWith([character('a', 'Alex', { gender: 'male' })]);
    expect(await setTraitsInStory(db, story.id, 'a', { gender: 'male' }, voices)).toEqual({
      repicked: false,
    });
    expect(await getStory(db, story.id)).toEqual(story);
  });

  it('uses the voices of the story’s language', async () => {
    const story = await storyWith([character('a', 'Alba')], 'es');
    await setTraitsInStory(db, story.id, 'a', { species: 'animal' }, voices);
    expect((await member(story.id, 'a')).voice).toMatchObject({ voiceName: 'es-b', lang: 'es-ES' });
  });

  it('throws for a missing story, a missing member and the unknown speaker', async () => {
    const story = await storyWith([character('a', 'Alex')]);
    const unknown = story.cast.find((c) => c.role === 'unknown')!;
    await expect(setTraitsInStory(db, 'nope', 'a', { age: 'teen' }, voices)).rejects.toThrow(
      'story nope not found',
    );
    await expect(setTraitsInStory(db, story.id, 'x', { age: 'teen' }, voices)).rejects.toThrow(
      'character not found',
    );
    await expect(
      setTraitsInStory(db, story.id, unknown.id, { age: 'teen' }, voices),
    ).rejects.toThrow();
    expect(await getStory(db, story.id)).toEqual(story);
  });

  it('changes nothing when the write fails', async () => {
    const story = await storyWith([character('a', 'Alex')]);
    breakWrites();
    await expect(setTraitsInStory(db, story.id, 'a', { age: 'teen' }, voices)).rejects.toThrow();
    expect(await getStory(db, story.id)).toEqual(story);
  });
});

describe('repickVoiceInStory', () => {
  it('picks the member’s voice again, also one that was set by hand', async () => {
    const story = await storyWith([character('a', 'Alex', { gender: 'male', voice: byHand })]);
    await repickVoiceInStory(db, story.id, 'a', voices);
    const after = (await getStory(db, story.id))!;
    const alex = after.cast.find((c) => c.id === 'a')!;
    expect(alex.voice).toStrictEqual(assignVoice(alex, story.cast, voices, 'en-US'));
    expect(alex.voice.voiceName).toBe(DAVID);
    expect(Object.keys(alex.voice)).not.toContain('manual');
    expect(after.updatedAt > story.updatedAt).toBe(true);
  });

  it('uses the voices of the story’s language', async () => {
    // Set by hand to the narrator's own voice: the pick moves it to the other Spanish one.
    const story = await storyWith(
      [
        character('a', 'Alba', {
          voice: { voiceName: 'es-a', lang: 'es-ES', pitch: 1.4, rate: 0.7, manual: true },
        }),
      ],
      'es',
    );
    await repickVoiceInStory(db, story.id, 'a', voices);
    const { voice } = await member(story.id, 'a');
    expect(voice).toMatchObject({ voiceName: 'es-b', lang: 'es-ES' });
    expect(Object.keys(voice)).not.toContain('manual');
  });

  it('throws for a missing story or member, and changes nothing when the write fails', async () => {
    const story = await storyWith([character('a', 'Alex')]);
    await expect(repickVoiceInStory(db, 'nope', 'a', voices)).rejects.toThrow(
      'story nope not found',
    );
    await expect(repickVoiceInStory(db, story.id, 'x', voices)).rejects.toThrow(
      'character not found',
    );
    breakWrites();
    await expect(repickVoiceInStory(db, story.id, 'a', voices)).rejects.toThrow('disk full');
    expect(await getStory(db, story.id)).toEqual(story);
  });
});

describe('matchVoicesInStory', () => {
  it('guesses missing traits from the names and picks the voices again, in one write', async () => {
    const story = await storyWith([
      character('man', 'the old man'),
      character('gran', 'Lucy’s grandmother', { voice: byHand }),
      character('ann', 'Ann', { gender: 'female' }),
    ]);
    await matchVoicesInStory(db, story.id, voices);
    const after = (await getStory(db, story.id))!;
    expect(after.cast.map((c) => c.id)).toEqual(story.cast.map((c) => c.id));
    expect(after.cast.slice(0, 2)).toEqual(story.cast.slice(0, 2));
    expect(after.cast[2]).toMatchObject({ gender: 'male', age: 'elder' });
    expect(after.cast[2]!.voice.voiceName).toBe(DAVID);
    expect(after.cast[3]).toMatchObject({ gender: 'female', age: 'elder', voice: byHand });
    expect(after.cast[4]!.voice.voiceName).toBe(ZIRA);
    expect(after.updatedAt > story.updatedAt).toBe(true);
  });

  it('reads the names in the story’s language and uses its voices', async () => {
    const story = await storyWith(
      [character('a', 'mi abuela'), character('b', 'the old man')],
      'es',
    );
    await matchVoicesInStory(db, story.id, voices);
    const [abuela, man] = (await getStory(db, story.id))!.cast.slice(2);
    expect(abuela).toMatchObject({ gender: 'female', age: 'elder' });
    expect(abuela!.voice).toMatchObject({ voiceName: 'es-b', lang: 'es-ES' });
    expect(Object.keys(man!)).toEqual(Object.keys(story.cast[3]!));
  });

  it('throws for a missing story, and changes nothing when the write fails', async () => {
    await expect(matchVoicesInStory(db, 'nope', voices)).rejects.toThrow('story nope not found');
    const story = await storyWith([character('man', 'the old man')]);
    breakWrites();
    await expect(matchVoicesInStory(db, story.id, voices)).rejects.toThrow('disk full');
    expect(await getStory(db, story.id)).toEqual(story);
  });
});

describe('setVoiceInStory', () => {
  it('merges the changes into the member’s voice and marks it as set by hand', async () => {
    const story = await storyWith([
      character('a', 'Alex', { voice: { voiceName: ZIRA, lang: 'en-US', pitch: 1.1, rate: 0.95 } }),
      character('b', 'Blake'),
    ]);
    await setVoiceInStory(db, story.id, 'a', { pitch: 1.3 });
    expect((await member(story.id, 'a')).voice).toStrictEqual({
      voiceName: ZIRA,
      lang: 'en-US',
      pitch: 1.3,
      rate: 0.95,
      manual: true,
    });
    await setVoiceInStory(db, story.id, 'a', { voiceName: DAVID, lang: 'en-GB', rate: 1.2 });
    const after = (await getStory(db, story.id))!;
    expect(after.cast.find((c) => c.id === 'a')!.voice).toStrictEqual({
      voiceName: DAVID,
      lang: 'en-GB',
      pitch: 1.3,
      rate: 1.2,
      manual: true,
    });
    expect(after.cast.filter((c) => c.id !== 'a')).toEqual(story.cast.filter((c) => c.id !== 'a'));
    expect(after.updatedAt > story.updatedAt).toBe(true);
  });

  it('removes the voice name for “device default”, leaving no key', async () => {
    const story = await storyWith([
      character('a', 'Alex', { voice: { voiceName: ZIRA, lang: 'en-US', pitch: 1.1, rate: 0.95 } }),
    ]);
    await setVoiceInStory(db, story.id, 'a', { voiceName: undefined });
    const voice = (await member(story.id, 'a')).voice;
    expect(voice).toStrictEqual({ lang: 'en-US', pitch: 1.1, rate: 0.95, manual: true });
    expect(Object.keys(voice)).not.toContain('voiceName');
  });

  it('ignores other changes given as undefined, and works on the narrator and unknown speaker', async () => {
    const story = await storyWith([]);
    const [narrator, unknown] = story.cast;
    await setVoiceInStory(db, story.id, narrator!.id, { pitch: undefined, rate: 1.1 });
    await setVoiceInStory(db, story.id, unknown!.id, { voiceName: 'en-a' });
    expect((await member(story.id, narrator!.id)).voice).toStrictEqual({
      ...narrator!.voice,
      rate: 1.1,
      manual: true,
    });
    expect((await member(story.id, unknown!.id)).voice).toStrictEqual({
      ...unknown!.voice,
      voiceName: 'en-a',
      manual: true,
    });
  });

  it('is left alone by the next automatic pick, until the member is picked again by hand', async () => {
    const story = await storyWith([character('a', 'Alex')]);
    await setVoiceInStory(db, story.id, 'a', { voiceName: 'en-a', pitch: 0.6 });
    const set = (await member(story.id, 'a')).voice;
    expect(await setTraitsInStory(db, story.id, 'a', { gender: 'female' }, voices)).toEqual({
      repicked: false,
    });
    await matchVoicesInStory(db, story.id, voices);
    expect((await member(story.id, 'a')).voice).toStrictEqual(set);
    await repickVoiceInStory(db, story.id, 'a', voices);
    expect((await member(story.id, 'a')).voice.voiceName).toBe(ZIRA);
  });

  it('throws for a missing story or member, and changes nothing when the write fails', async () => {
    const story = await storyWith([character('a', 'Alex')]);
    await expect(setVoiceInStory(db, 'nope', 'a', { pitch: 1.2 })).rejects.toThrow(
      'story nope not found',
    );
    await expect(setVoiceInStory(db, story.id, 'x', { pitch: 1.2 })).rejects.toThrow(
      'character not found',
    );
    breakWrites();
    await expect(setVoiceInStory(db, story.id, 'a', { pitch: 1.2 })).rejects.toThrow('disk full');
    expect(await getStory(db, story.id)).toEqual(story);
  });
});
