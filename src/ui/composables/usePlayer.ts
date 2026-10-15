import { shallowRef, type Ref } from 'vue';
import { Capacitor } from '@capacitor/core';
import type { SpeechEngine } from '@/playback/engine';
import { NativeSpeechEngine } from '@/playback/nativeEngine';
import { newerEnginePosition } from '@/playback/resume';
import { WebSpeechEngine } from '@/playback/webEngine';
import { Player, type PlayerSnapshot } from '@/playback/player';
import { getAppDb } from '@/storage/db';
import { getAnalysis } from '@/storage/analyses';
import { getPart } from '@/storage/parts';
import { getStory, updateStory } from '@/storage/stories';
import { getSetting } from '@/storage/settings';

let engine: SpeechEngine | undefined;
let current: { storyId: string; player: Player; snapshot: Ref<PlayerSnapshot> } | undefined;

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
 * The app-wide player for a story. Switching to another story stops the previous one; views of
 * the same story share one player, so playback continues across the reader and the cast view.
 */
export function usePlayer(storyId: string): { player: Player; snapshot: Ref<PlayerSnapshot> } {
  if (current?.storyId === storyId) return current;
  void current?.player.stop();

  const db = getAppDb();
  // After the app was killed mid-story, the engine may know a later position than the one saved.
  const restored = (async () => {
    const story = await getStory(db, storyId);
    const position = story && (await newerEnginePosition(getEngine(), story));
    if (position) await updateStory(db, storyId, { position });
  })().catch(() => undefined);

  const player = new Player(getEngine(), {
    story: async () => {
      await restored;
      return getStory(db, storyId);
    },
    part: async (partId) => {
      const part = await getPart(db, partId);
      return part ? { part, analysis: await getAnalysis(db, partId) } : undefined;
    },
    savePosition: (position) => updateStory(db, storyId, { position }),
  });
  const snapshot = shallowRef<PlayerSnapshot>(player.state);
  player.subscribe((s) => (snapshot.value = s));
  void getSetting('speed').then((speed) => player.setSpeed(speed));
  current = { storyId, player, snapshot };
  return current;
}
