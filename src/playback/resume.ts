import type { Story } from '@/format/types';
import type { SpeechEngine } from './engine';
import type { PlayerPosition } from './player';
import { parseBatchUtteranceId } from './utterances';

/**
 * Where to resume a story after the app was killed. The native service saves every utterance it
 * starts, even while the WebView is asleep, so its record can be newer than the position the
 * player last saved. Returns that position when it belongs to this story and is newer than the
 * story's last update; otherwise undefined (keep the saved position).
 */
export async function newerEnginePosition(
  engine: SpeechEngine,
  story: Pick<Story, 'partIds' | 'updatedAt' | 'position'>,
): Promise<PlayerPosition | undefined> {
  const last = await engine.lastSpoken?.().catch(() => undefined);
  if (!last) return undefined;
  const at = parseBatchUtteranceId(last.utteranceId);
  if (!at || !story.partIds.includes(at.partId)) return undefined;
  if (last.at <= Date.parse(story.updatedAt)) return undefined;
  const saved = story.position;
  if (saved?.partId === at.partId && saved.segmentIndex === at.segmentIndex) return undefined;
  return at;
}
