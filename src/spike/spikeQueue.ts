// Throwaway: builds a long test queue for the Android background-playback spike (Task 2).
import type { NativeUtterance } from '@/playback/nativeBridge';

const SENTENCES = [
  'The rain had not stopped for three days, and the river was rising.',
  '"We should leave before nightfall," said the old man, looking at the sky.',
  'She did not answer; she was counting the boats that drifted past the window.',
  '"Nobody is leaving," replied the captain, slamming the door behind him.',
];

const VOICES: Array<Pick<NativeUtterance, 'pitch' | 'rate'>> = [
  { pitch: 1.0, rate: 1.0 }, // narrator
  { pitch: 0.8, rate: 0.95 },
  { pitch: 1.0, rate: 1.0 },
  { pitch: 1.3, rate: 1.05 },
];

/** About 13 words per utterance; ~400 utterances is roughly 30 minutes at normal speed. */
export function buildSpikeQueue(count: number, lang = 'en-US'): NativeUtterance[] {
  return Array.from({ length: count }, (_, i) => {
    const k = i % SENTENCES.length;
    return {
      id: `u${i}`,
      text: `${i + 1}. ${SENTENCES[k]}`,
      lang,
      ...VOICES[k]!,
    };
  });
}

export interface GapStats {
  done: number;
  maxGapMs: number;
  gapsOver3s: number;
}

/** Gaps between one utterance finishing and the next starting, from native timestamps. */
export function gapStats(events: Array<{ kind: 'start' | 'done'; at: number }>): GapStats {
  let lastDone: number | null = null;
  let maxGapMs = 0;
  let gapsOver3s = 0;
  let done = 0;
  for (const e of events) {
    if (e.kind === 'done') {
      done++;
      lastDone = e.at;
    } else if (lastDone !== null) {
      const gap = e.at - lastDone;
      maxGapMs = Math.max(maxGapMs, gap);
      if (gap > 3000) gapsOver3s++;
      lastDone = null;
    }
  }
  return { done, maxGapMs, gapsOver3s };
}
