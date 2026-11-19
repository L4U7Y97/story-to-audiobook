import { ref, shallowRef, type Ref } from 'vue';
import { Capacitor } from '@capacitor/core';
import type { SpeechEngine } from '@/playback/engine';
import { NativeSpeechEngine } from '@/playback/nativeEngine';
import { newerEnginePosition } from '@/playback/resume';
import { WebSpeechEngine } from '@/playback/webEngine';
import { Player, stillListening, type PlayerSnapshot } from '@/playback/player';
import { getAppDb } from '@/storage/db';
import { getAnalysis } from '@/storage/analyses';
import { getPart } from '@/storage/parts';
import { getStory, updateStory } from '@/storage/stories';
import { getSetting } from '@/storage/settings';

/**
 * A story's player, its latest snapshot, and whether its place is one being listened to
 * (stillListening), which the reader clears when it moves the place to a part's start.
 */
export interface StoryPlayer {
  player: Player;
  snapshot: Ref<PlayerSnapshot>;
  listening: Ref<boolean>;
}

let engine: SpeechEngine | undefined;
let current: (StoryPlayer & { storyId: string }) | undefined;

/** The native Android engine in the app, Web Speech in a browser. */
export function getEngine(): SpeechEngine {
  engine ??= Capacitor.isNativePlatform() ? new NativeSpeechEngine() : new WebSpeechEngine();
  return engine;
}

/** The player for a story if one exists, without creating it (or stopping another story). */
export function existingPlayer(storyId: string) {
  return current?.storyId === storyId ? current : undefined;
}

/**
 * Saves the place the engine reached when the app was killed mid-story: it may know a later one
 * than the place saved (so listening went on after any end saved). A story with a player is left
 * alone; its place is the player's.
 */
export async function restorePlace(storyId: string): Promise<void> {
  if (existingPlayer(storyId)) return;
  const db = getAppDb();
  const story = await getStory(db, storyId);
  const position = story && (await newerEnginePosition(getEngine(), story));
  if (position) await updateStory(db, storyId, { position, ended: undefined });
}

/**
 * The app-wide player for a story. Switching to another story stops the previous one; views of
 * the same story share one player, so playback continues across the reader and the cast view.
 */
export function usePlayer(storyId: string): StoryPlayer {
  if (current?.storyId === storyId) return current;
  void current?.player.stop();

  const db = getAppDb();
  const restored = restorePlace(storyId).catch(() => undefined);
  /** Settles once the player may start: the place restored and the saved speed set. */
  let ready: Promise<unknown> = restored;

  const player = new Player(getEngine(), {
    story: async () => {
      await ready;
      return getStory(db, storyId);
    },
    part: async (partId) => {
      const part = await getPart(db, partId);
      return part ? { part, analysis: await getAnalysis(db, partId) } : undefined;
    },
    savePosition: (position, ended) =>
      updateStory(db, storyId, { position, ended: ended || undefined }),
  });
  const snapshot = shallowRef<PlayerSnapshot>(player.state);
  const listening = ref(false);
  player.subscribe((s) => {
    snapshot.value = s;
    listening.value = stillListening(listening.value, s);
  });
  // A play right after this (the story page's Continue) waits for the speed: started at 1×, it
  // would start again at once.
  ready = Promise.all([
    restored,
    getSetting('speed')
      .then((speed) => player.setSpeed(speed))
      .catch(() => undefined),
  ]);
  current = { storyId, player, snapshot, listening };
  return current;
}
