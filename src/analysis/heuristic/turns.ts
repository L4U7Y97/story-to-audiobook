/** Turn-taking: who takes part in the talk and whose turn it is. */

import type { Gender } from '@/format/types';
import type { Cast } from './cast';
import type { VerbInfo } from './lexicon';
import type { Mention } from './tokens';

export class Turns {
  private readonly lastActive = new Map<string, number>();
  /** When each participant last spoke. */
  readonly spoke = new Map<string, number>();
  /** Characters whose gender byGender guessed in this part, which rules nobody out. */
  private readonly guessed = new Set<string>();
  clock = 0;

  /** Some speech in this part is tagged by the teller or said to them, so the teller takes part. */
  tellerSpeaks = false;
  lastSpeaker?: string;
  narrationGap = Infinity;
  /** Characters the last narration paragraph brought in (not after a preposition). */
  entrants: string[] = [];
  /** People the last speech paragraph was said to. */
  private addressed: string[] = [];
  /** When the current scene began: people who spoke before it have left the conversation. */
  sceneStart = 0;

  constructor(private readonly cast: Cast) {}

  /**
   * The most recent character of a gender, never the teller ("he"/"she" is not "I"). `named`:
   * people named earlier in the paragraph, who come first. A reply is not by the person it
   * answers; a continuation ("he added") is by the last speaker.
   */
  byGender(
    gender: Gender,
    exclude: ReadonlySet<string>,
    verb?: VerbInfo,
    named: string[] = [],
  ): string | undefined {
    const recent = [
      ...named,
      ...this.recentParticipants().filter((k) => !named.includes(k)),
    ].filter((k) => this.cast.entry(k).role === 'character' && !exclude.has(k));
    const matches = recent.filter((k) => this.cast.entry(k).gender === gender);
    if (matches.length > 0) {
      return verb?.reply && matches[0] === this.lastSpeaker && matches[1] ? matches[1] : matches[0];
    }
    // Someone with no known gender: not the last speaker, unless the verb continues their turn.
    const ungendered = recent.filter((k) => !this.cast.entry(k).gender);
    const last = this.lastSpeaker;
    const pick =
      verb?.continues && last && ungendered.includes(last)
        ? last
        : (ungendered.find((k) => k !== last) ?? ungendered[0]);
    // Learn the gender only when the guess had no rival.
    if (pick && ungendered.length === 1) {
      this.cast.learnGender(pick, gender);
      this.guessed.add(pick);
    }
    return pick;
  }

  /**
   * Characters with a known gender other than `gender`, who never say a "he" or "she" line:
   * byGender never picks them, and nothing else may when it finds nobody. A gender byGender only
   * guessed is not known ("Tom walked in. / “Cold?” she asked." may be someone else's line).
   */
  otherGender(gender: Gender): string[] {
    return this.cast.entries
      .filter(
        (e) =>
          e.role === 'character' &&
          e.gender !== undefined &&
          e.gender !== gender &&
          !this.guessed.has(e.key),
      )
      .map((e) => e.key);
  }

  alternate(exclude: ReadonlySet<string>): string {
    if (this.narrationGap > 1 || !this.lastSpeaker) {
      // A line an unknown voice said to someone, right before, is answered by them.
      if (this.tellerSpeaks && this.narrationGap === 0) {
        const answer = this.addressed.find((k) => !exclude.has(k));
        if (answer) return answer;
      }
      const [entrant, ...rest] = this.entrants;
      return entrant && rest.length === 0 && !exclude.has(entrant) ? entrant : this.cast.unknownKey;
    }
    const last = this.lastSpeaker;
    const others = this.recentParticipants().filter((k) => k !== last);
    let ranked = others;
    if (this.tellerSpeaks) {
      // A first-person conversation is between people who talk, the teller included: people
      // the narration just brought in and people the last line was said to come first, then
      // people who have spoken in this scene, then the teller, then earlier speakers; people
      // only mentioned come last.
      const first = [
        ...others.filter((k) => this.entrants.includes(k)),
        ...this.addressed.filter((k) => k !== last && !this.entrants.includes(k)),
      ];
      const speakers = others
        .filter((k) => this.spoke.has(k) && !first.includes(k))
        .sort((a, b) => this.spoke.get(b)! - this.spoke.get(a)!);
      const ahead = [...first, ...speakers.filter((k) => this.spoke.get(k)! >= this.sceneStart)];
      if (last !== this.cast.narratorKey && !ahead.includes(this.cast.narratorKey)) {
        ahead.push(this.cast.narratorKey);
      }
      ahead.push(...speakers.filter((k) => !ahead.includes(k)));
      ranked = [...ahead, ...others.filter((k) => !ahead.includes(k))];
    }
    const natural = ranked[0];
    if (natural && !exclude.has(natural)) return natural;
    // The person a line is said to never says it: the last speaker goes on, or someone else.
    if (natural && !exclude.has(last)) return last;
    return ranked.find((k) => !exclude.has(k)) ?? this.cast.unknownKey;
  }

  private recentParticipants(): string[] {
    return [...this.lastActive.entries()]
      .filter(([k]) => this.cast.entry(k).role !== 'unknown')
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  }

  /** Whether a mention names someone who has spoken in this part. */
  readonly hasSpoken = (m: Mention): boolean => {
    const k = this.cast.match(m.name)?.key;
    return k !== undefined && this.spoke.has(k);
  };

  touchVocatives(addressed: Mention[], speaker: string): void {
    for (const m of addressed) {
      // In a first-person part, an unknown name said to someone is often the teller's own: it
      // must not become a second voice that could take the teller's lines.
      if (this.tellerSpeaks && !this.cast.match(m.name)) continue;
      const key = this.cast.resolve(m);
      if (key !== speaker) this.touch(key);
    }
  }

  touch(key: string): void {
    this.lastActive.set(key, ++this.clock);
  }

  /** `key` says a line: the most recent participant and the last speaker. */
  speaks(key: string): void {
    this.touch(key);
    this.spoke.set(key, this.clock);
    this.lastSpeaker = key;
  }

  /** After a paragraph of speech said to `addressed`: no narration yet, and nobody brought in. */
  afterSpeech(addressed: string[]): void {
    this.narrationGap = 0;
    this.entrants = [];
    this.addressed = addressed;
  }

  /** One more paragraph of narration since the last line, which brings in its own entrants. */
  afterNarration(): void {
    this.narrationGap++;
    this.entrants = [];
  }
}
