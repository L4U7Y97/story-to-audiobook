import type { DeviceVoice, SpeechEngine, Utterance } from './engine';

/**
 * In-memory SpeechEngine for tests: "speaks" each utterance as soon as `advance()` is called,
 * so tests control timing explicitly.
 */
export class FakeSpeechEngine implements SpeechEngine {
  readonly spoken: Utterance[] = [];
  paused = false;
  private pending?: {
    queue: Utterance[];
    index: number;
    onStart: (id: string) => void;
    done: () => void;
  };

  constructor(private readonly voices: DeviceVoice[] = []) {}

  async listVoices(): Promise<DeviceVoice[]> {
    return this.voices;
  }

  play(queue: Utterance[], onStart: (utteranceId: string) => void): Promise<void> {
    this.finishPending();
    return new Promise<void>((done) => {
      this.pending = { queue, index: 0, onStart, done };
      this.startCurrent();
    });
  }

  /** Finishes the current utterance and starts the next one. */
  advance(): void {
    const p = this.pending;
    if (!p || this.paused) return;
    p.index++;
    if (p.index >= p.queue.length) this.finishPending();
    else this.startCurrent();
  }

  /** Advances through the rest of the queue. */
  finishAll(): void {
    while (this.pending && !this.paused) this.advance();
  }

  get current(): Utterance | undefined {
    return this.pending?.queue[this.pending.index];
  }

  async pause(): Promise<void> {
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
  }

  async stop(): Promise<void> {
    this.paused = false;
    this.finishPending();
  }

  private startCurrent(): void {
    const p = this.pending!;
    const u = p.queue[p.index]!;
    this.spoken.push(u);
    p.onStart(u.id);
  }

  private finishPending(): void {
    const p = this.pending;
    this.pending = undefined;
    p?.done();
  }
}
