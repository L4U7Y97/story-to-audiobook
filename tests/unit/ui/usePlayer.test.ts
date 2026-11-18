import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeSpeechEngine } from '@/playback/fakeEngine';
import { batchUtteranceId } from '@/playback/utterances';
import { getSetting } from '@/storage/settings';
import { getStory, updateStory } from '@/storage/stories';
import { existingPlayer, getEngine, restorePlace, usePlayer } from '@/ui/composables/usePlayer';
import { db, storeStory, until } from '../../helpers/ui';

// The browser's engine, as one that speaks nothing and lets a test see what it was given.
vi.mock('@/playback/webEngine', async () => ({
  WebSpeechEngine: (await import('@/playback/fakeEngine')).FakeSpeechEngine,
}));
vi.mock('@/storage/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/settings')>();
  return { ...actual, getSetting: vi.fn(actual.getSetting) };
});

/** The story of the test running; afterEach stops its player. */
let storyId = '';

afterEach(async () => {
  await existingPlayer(storyId)?.player.stop();
  delete getEngine().lastSpoken;
});

/** As the Android engine says after the app was killed: it had started this line of the part. */
const reached = (partId: string, segmentIndex: number) => async () => ({
  utteranceId: batchUtteranceId(partId, String(segmentIndex)),
  at: Date.now() + 60_000,
});

describe('usePlayer', () => {
  it('starts the first play at the saved speed, instead of starting again once it is read', async () => {
    const stored = await storeStory([
      ['One line. ', 'N', 'narration'],
      ['Another.', 'N', 'narration'],
    ]);
    storyId = stored.storyId;
    let readSpeed: (speed: number) => void = () => undefined;
    vi.mocked(getSetting).mockImplementationOnce(
      () => new Promise((resolve) => (readSpeed = resolve)) as ReturnType<typeof getSetting>,
    );
    const engine = getEngine() as FakeSpeechEngine;
    const before = engine.spoken.length;

    // As the story page's Continue does: make the player and play at once.
    void usePlayer(storyId).player.play();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.spoken.length).toBe(before);

    readSpeed(1.5);
    await until(() => engine.spoken.length > before, 'the first line');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.spoken.slice(before).map((u) => [u.text, u.voice.rate])).toEqual([
      ['One line.', 1.5],
    ]);
  });

  it('plays at the usual speed when the saved speed cannot be read', async () => {
    const stored = await storeStory([
      ['One line. ', 'N', 'narration'],
      ['Another.', 'N', 'narration'],
    ]);
    storyId = stored.storyId;
    vi.mocked(getSetting).mockRejectedValueOnce(new Error('The database is closed.'));
    const engine = getEngine() as FakeSpeechEngine;
    const before = engine.spoken.length;

    void usePlayer(storyId).player.play();
    await until(() => engine.spoken.length > before, 'the first line');
    expect(engine.spoken.slice(before).map((u) => [u.text, u.voice.rate])).toEqual([
      ['One line.', 1],
    ]);
  });

  it('saves the end of the story once listening reaches it, until it saves another place', async () => {
    const stored = await storeStory([
      ['One. ', 'N', 'narration'],
      ['Two.', 'N', 'narration'],
    ]);
    storyId = stored.storyId;
    const engine = getEngine() as FakeSpeechEngine;
    const { player } = usePlayer(storyId);
    const saved = () => getStory(db, storyId);

    void player.play({ partId: stored.partId, segmentIndex: 0 });
    await until(() => engine.current?.text === 'One.', 'the first line');
    engine.finishAll();
    await until(async () => (await saved())?.ended, 'the end saved');
    expect((await saved())!.position).toEqual({ partId: stored.partId, segmentIndex: 1 });

    await player.jump({ partId: stored.partId, segmentIndex: 0 });
    expect('ended' in (await saved())!).toBe(false);
  });
});

describe('a play right after the app was killed mid-story', () => {
  const threeLines = () =>
    storeStory([
      ['One. ', 'N', 'narration'],
      ['Two. ', 'N', 'narration'],
      ['Three.', 'N', 'narration'],
    ]);

  /** The lines the engine starts from now on, once it has started one. */
  async function heard(): Promise<string[]> {
    const engine = getEngine() as FakeSpeechEngine;
    const before = engine.spoken.length;
    await until(() => engine.spoken.length > before, 'a line spoken');
    return engine.spoken.slice(before).map((u) => u.text);
  }

  it('starts from the place the engine reached, not the older one saved', async () => {
    const stored = await threeLines();
    storyId = stored.storyId;
    getEngine().lastSpoken = reached(stored.partId, 2);

    const spoken = heard();
    void usePlayer(storyId).player.play();
    expect(await spoken).toEqual(['Three.']);
  });

  it('starts there too while the story page is still restoring that place', async () => {
    const stored = await threeLines();
    storyId = stored.storyId;
    getEngine().lastSpoken = reached(stored.partId, 2);

    // The story page restores on opening; Continue is tapped at once.
    const page = restorePlace(storyId);
    const spoken = heard();
    void usePlayer(storyId).player.play();
    await page;
    expect(await spoken).toEqual(['Three.']);
  });
});

describe('restorePlace', () => {
  it('saves the place the engine reached, unless the story has a player', async () => {
    const stored = await storeStory([
      ['One. ', 'N', 'narration'],
      ['Two. ', 'N', 'narration'],
      ['Three.', 'N', 'narration'],
    ]);
    storyId = stored.storyId;
    const lastSpoken = vi.fn(reached(stored.partId, 1));
    getEngine().lastSpoken = lastSpoken;

    await restorePlace(storyId);
    expect((await getStory(db, storyId))?.position).toEqual({
      partId: stored.partId,
      segmentIndex: 1,
    });

    // A new player takes up the engine's place too; once it has, its place is the player's.
    usePlayer(storyId);
    await until(() => lastSpoken.mock.calls.length === 2, 'the player taking up the place');
    getEngine().lastSpoken = reached(stored.partId, 2);
    await restorePlace(storyId);
    expect((await getStory(db, storyId))?.position).toEqual({
      partId: stored.partId,
      segmentIndex: 1,
    });
  });

  it('drops an end saved before, since listening went on after it', async () => {
    const stored = await storeStory([
      ['One. ', 'N', 'narration'],
      ['Two.', 'N', 'narration'],
    ]);
    storyId = stored.storyId;
    await updateStory(db, storyId, {
      position: { partId: stored.partId, segmentIndex: 1 },
      ended: true,
    });
    // Listened to again from the start; the app was killed before the player saved a place.
    getEngine().lastSpoken = reached(stored.partId, 0);

    await restorePlace(storyId);
    const story = (await getStory(db, storyId))!;
    expect(story.position).toEqual({ partId: stored.partId, segmentIndex: 0 });
    expect(story.ended).toBeUndefined();
  });
});
