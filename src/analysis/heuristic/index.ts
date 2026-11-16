import type { Character } from '@/format/types';
import type { LabelResult } from '../labels';
import type { Unit } from '../units';
import { Attributor } from './attributor';

/** Stored with each analysis. Bump when the same text gets different labels. */
export const HEURISTIC_VERSION = 4;

interface HeuristicInput {
  text: string;
  units: readonly Unit[];
  /** The story's current cast, including the narrator and the unknown speaker. */
  cast: readonly Character[];
}

/**
 * Free, deterministic speaker attribution. Per paragraph with speech:
 * 1. an explicit tag (speech verb + name, descriptor or pronoun, or a first-person verb) in the
 *    narration around the line, or an action beat right before it ("Tom shrugged.");
 * 2. a colon intro in the previous narration paragraph ("Then she said:");
 * 3. turn-taking: the most recent other participant (speakers, people addressed by name, people
 *    named in narration). In a part with speech tagged by the teller or said to them ("I said",
 *    "asked me") the teller takes part, and people who talk in the current scene rank above
 *    earlier speakers and people only mentioned;
 * 4. after a stretch of narration, the one person it introduced; otherwise the "unknown" speaker.
 * Narration, and "I" lines, go to the narrator; the teller flag marks them (see SpanLabel).
 */
export function analyzeHeuristic(input: HeuristicInput): LabelResult {
  return new Attributor(input.text, input.units, input.cast).run();
}
