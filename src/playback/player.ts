import type { Analysis, Part, Story, VoiceSettings } from '@/format/types';
import type { ExternalState, SpeechEngine } from './engine';
import {
  batchUtteranceId,
  buildUtterances,
  paragraphStarts,
  parseBatchUtteranceId,
} from './utterances';

export type PlayerState = 'idle' | 'playing' | 'paused' | 'blocked';

export interface PlayerPosition {
  partId: string;
  segmentIndex: number;
}

/** Where the player reads from and saves to (IndexedDB in the app, memory in tests). */
export interface PlayerSource {
  story(): Promise<Story | undefined>;
  part(partId: string): Promise<{ part: Part; analysis?: Analysis } | undefined>;
  savePosition(position: PlayerPosition): Promise<void>;
}

export interface PlayerSnapshot {
  state: PlayerState;
  position?: PlayerPosition;
  speed: number;
  /** Why playback stopped on its own (e.g. the next part is not analysed). */
  message?: string;
}

export interface PlayerOptions {
  /** Minimum time between position saves while playing. */
  saveIntervalMs?: number;
  now?: () => number;
}

/**
 * Plays a story part by part, segment by segment, through a SpeechEngine. Framework-free: the UI
 * subscribes to snapshots. Each run of the engine is a "session"; skipping or changing voices
 * stops the current session and starts a new one.
 */
export class Player {
  private snapshot: PlayerSnapshot = { state: 'idle', speed: 1 };
  private readonly listeners = new Set<(s: PlayerSnapshot) => void>();
  private session = 0;
  private lastSave = -Infinity;
  private castDirty = false;
  private loaded?: { part: Part; analysis: Analysis; story: Story };
  /** The parts in the engine's current queue, by id. */
  private batch = new Map<string, { part: Part; analysis: Analysis; story: Story }>();
  private readonly saveIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly engine: SpeechEngine,
    private readonly source: PlayerSource,
    options: PlayerOptions = {},
  ) {
    this.saveIntervalMs = options.saveIntervalMs ?? 2000;
    this.now = options.now ?? (() => Date.now());
    engine.onExternalState?.((state) => this.onExternalState(state));
  }

  get state(): PlayerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (s: PlayerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  /** Starts playing from a position, the saved position, or the story's beginning. */
  async play(from?: PlayerPosition): Promise<void> {
    const story = await this.source.story();
    const start = from ?? story?.position ?? firstPosition(story);
    if (!start) return this.block('This story has no parts yet.');
    await this.restart(start);
  }

  async pause(): Promise<void> {
    if (this.snapshot.state !== 'playing') return;
    // State first, so the engine echoing the pause (onExternalState) is a no-op.
    this.update({ state: 'paused' });
    await this.engine.pause();
    await this.save(true);
  }

  async resume(): Promise<void> {
    if (this.snapshot.state !== 'paused') return;
    this.update({ state: 'playing' });
    await this.engine.resume();
  }

  async stop(): Promise<void> {
    this.session++;
    await this.engine.stop();
    if (this.snapshot.state !== 'idle') this.update({ state: 'idle' });
    await this.save(true);
  }

  async setSpeed(speed: number): Promise<void> {
    this.update({ speed });
    if (this.snapshot.state === 'playing' && this.snapshot.position) {
      await this.restart(this.snapshot.position);
    }
  }

  /** Stops playback (keeping the position) and speaks a sample line, e.g. to try a voice. */
  async preview(text: string, voice: VoiceSettings): Promise<void> {
    await this.stop();
    await this.engine.play([{ id: 'preview', text, voice }], () => {});
  }

  /** Call after the cast changes: new voices apply from the next segment that starts. */
  castChanged(): void {
    this.castDirty = true;
  }

  async skipSegment(delta: number): Promise<void> {
    const at = this.snapshot.position;
    if (!at || !this.loaded) return;
    const count = this.loaded.analysis.segments.length;
    await this.jump({ ...at, segmentIndex: clamp(at.segmentIndex + delta, 0, count - 1) });
  }

  async skipParagraph(delta: number): Promise<void> {
    const at = this.snapshot.position;
    if (!at || !this.loaded) return;
    const starts = paragraphStarts(this.loaded.part.text, this.loaded.analysis.segments)
      .map((isStart, i) => (isStart ? i : -1))
      .filter((i) => i >= 0);
    const current = starts.filter((i) => i <= at.segmentIndex).length - 1;
    // Going back from the middle of a paragraph first returns to its start.
    const atStart = starts[current] === at.segmentIndex;
    const target = delta < 0 && !atStart ? current : current + delta;
    await this.jump({ ...at, segmentIndex: starts[clamp(target, 0, starts.length - 1)]! });
  }

  async skipPart(delta: number): Promise<void> {
    const at = this.snapshot.position;
    const story = await this.source.story();
    if (!at || !story) return;
    const index = story.partIds.indexOf(at.partId) + delta;
    if (index < 0 || index >= story.partIds.length) return;
    await this.jump({ partId: story.partIds[index]!, segmentIndex: 0 });
  }

  /** Moves to a position; keeps playing if playing, otherwise just selects it. */
  async jump(to: PlayerPosition): Promise<void> {
    if (this.snapshot.state === 'playing') return this.restart(to);
    this.session++;
    await this.engine.stop();
    this.update({ position: to, state: 'idle' });
    await this.save(true);
  }

  private async restart(from: PlayerPosition): Promise<void> {
    const session = ++this.session;
    await this.engine.stop();
    if (session !== this.session) return;
    this.update({ state: 'playing', position: from, message: undefined });
    void this.run(session, from);
  }

  private async run(session: number, from: PlayerPosition): Promise<void> {
    let position = from;
    while (session === this.session) {
      const story = await this.source.story();
      const loaded = await this.source.part(position.partId);
      if (session !== this.session) return;
      if (!story || !loaded) return this.block('This part no longer exists.');
      const { part, analysis } = loaded;
      if (!analysis || analysis.textHash !== part.textHash) {
        return this.block(`“${part.title}” has not been analysed yet.`);
      }
      this.loaded = { part, analysis, story };
      this.castDirty = false;

      // One batch holds the rest of this part and the next part when it is analysed, so an
      // engine that runs outside the WebView (Android) crosses into the next part by itself.
      const batch = [{ part, analysis }];
      const following = await this.analysedPart(story.partIds[story.partIds.indexOf(part.id) + 1]);
      if (session !== this.session) return;
      if (following) batch.push(following);
      this.batch = new Map(batch.map((b) => [b.part.id, { ...b, story }]));

      const queue = batch.flatMap((b, k) =>
        buildUtterances(
          b.part,
          b.analysis,
          story.cast,
          k === 0 ? position.segmentIndex : 0,
          this.snapshot.speed,
        ).map((u) => ({
          ...u,
          id: batchUtteranceId(b.part.id, u.id),
          title: story.title,
          subtitle: b.part.title,
        })),
      );
      await this.engine.play(queue, (id) => {
        const at = parseBatchUtteranceId(id);
        if (at) this.onStart(session, at.partId, at.segmentIndex);
      });
      if (session !== this.session) return;

      const lastId = batch.at(-1)!.part.id;
      const next = story.partIds[story.partIds.indexOf(lastId) + 1];
      if (!next) {
        this.update({ state: 'idle', message: 'End of the story.' });
        await this.save(true);
        return;
      }
      position = { partId: next, segmentIndex: 0 };
      this.update({ position });
    }
  }

  /** A part with a current analysis, or undefined (missing, not analysed, or stale). */
  private async analysedPart(
    partId: string | undefined,
  ): Promise<{ part: Part; analysis: Analysis } | undefined> {
    if (!partId) return undefined;
    const loaded = await this.source.part(partId);
    if (!loaded?.analysis || loaded.analysis.textHash !== loaded.part.textHash) return undefined;
    return { part: loaded.part, analysis: loaded.analysis };
  }

  /** Pause or play pressed in the engine's own controls (notification, headset). */
  private onExternalState(state: ExternalState): void {
    if (state === 'paused' && this.snapshot.state === 'playing') {
      this.update({ state: 'paused' });
      void this.save(true);
    } else if (state === 'playing' && this.snapshot.state === 'paused') {
      this.update({ state: 'playing' });
    }
  }

  private onStart(session: number, partId: string, segmentIndex: number): void {
    if (session !== this.session) return;
    const entered = this.batch.get(partId);
    if (entered && this.loaded?.part.id !== partId) this.loaded = entered;
    const previous = this.snapshot.position;
    const isNewSegment = previous?.partId !== partId || previous.segmentIndex !== segmentIndex;
    if (this.castDirty && isNewSegment) {
      // Re-voice from this segment with the updated cast.
      void this.restart({ partId, segmentIndex });
      return;
    }
    this.update({ position: { partId, segmentIndex } });
    if (isNewSegment) void this.save(false);
  }

  private async block(message: string): Promise<void> {
    this.session++;
    await this.engine.stop();
    this.update({ state: 'blocked', message });
  }

  private async save(force: boolean): Promise<void> {
    const position = this.snapshot.position;
    if (!position) return;
    const t = this.now();
    if (!force && t - this.lastSave < this.saveIntervalMs) return;
    this.lastSave = t;
    await this.source.savePosition(position);
  }

  private update(changes: Partial<PlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const l of this.listeners) l(this.snapshot);
  }
}

function firstPosition(story: Story | undefined): PlayerPosition | undefined {
  const partId = story?.partIds[0];
  return partId ? { partId, segmentIndex: 0 } : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
