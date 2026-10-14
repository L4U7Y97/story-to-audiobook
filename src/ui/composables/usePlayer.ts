import { shallowRef, type Ref } from 'vue';
import type { SpeechEngine } from '@/playback/engine';
import { WebSpeechEngine } from '@/playback/webEngine';
import { Player, type PlayerSnapshot } from '@/playback/player';
import { getAppDb } from '@/storage/db';
import { getAnalysis } from '@/storage/analyses';
import { getPart } from '@/storage/parts';
import { getStory, updateStory } from '@/storage/stories';

let engine: SpeechEngine | undefined;
let current: { storyId: string; player: Player; snapshot: Ref<PlayerSnapshot> } | undefined;

export function getEngine(): SpeechEngine {
  engine ??= new WebSpeechEngine();
  return engine;
}

/**
 * The app-wide player for a story. Switching to another story stops the previous one; views of
 * the same story share one player, so playback continues across the reader and the cast view.
 */
export function usePlayer(storyId: string): { player: Player; snapshot: Ref<PlayerSnapshot> } {
  if (current?.storyId === storyId) return current;
  void current?.player.stop();

  const db = getAppDb();
  const player = new Player(getEngine(), {
    story: () => getStory(db, storyId),
    part: async (partId) => {
      const part = await getPart(db, partId);
      return part ? { part, analysis: await getAnalysis(db, partId) } : undefined;
    },
    savePosition: (position) => updateStory(db, storyId, { position }),
  });
  const snapshot = shallowRef<PlayerSnapshot>(player.state);
  player.subscribe((s) => (snapshot.value = s));
  current = { storyId, player, snapshot };
  return current;
}
