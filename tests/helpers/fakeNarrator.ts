import type { PluginListenerHandle } from '@capacitor/core';
import type {
  NarratorPlugin,
  NarratorState,
  NativeUtterance,
  NativeVoice,
  UtteranceEvent,
} from '@/playback/nativeBridge';

type Listener = (e: never) => void;

/**
 * Simulates the Android Narrator plugin and its service: one queue at a time, utterances advance
 * when the test calls advance(), events are emitted synchronously like the native side's.
 * Also exposes the notification controls (pressPause, pressNext…).
 */
export class FakeNarrator implements NarratorPlugin {
  readonly spoken: NativeUtterance[] = [];
  lastSpoken: { id?: string; at?: number } = {};
  private listeners = new Map<string, Set<Listener>>();
  private queue: NativeUtterance[] = [];
  private batch = '';
  private index = 0;
  private playing = false;

  constructor(private readonly voices: NativeVoice[] = []) {}

  get current(): NativeUtterance | undefined {
    return this.playing ? this.queue[this.index] : undefined;
  }

  async play(options: { queue: NativeUtterance[]; startIndex?: number; batch: string }) {
    this.queue = options.queue;
    this.batch = options.batch;
    this.index = options.startIndex ?? 0;
    this.playing = true;
    this.emit('state', { batch: this.batch, state: 'playing' });
    this.startCurrent();
  }

  async pause() {
    if (!this.playing) return;
    this.playing = false;
    this.emit('state', { batch: this.batch, state: 'paused' });
  }

  async resume() {
    if (this.playing || this.index >= this.queue.length) return;
    this.playing = true;
    this.emit('state', { batch: this.batch, state: 'playing' });
    this.startCurrent(); // TTS has no pause: the current utterance starts again
  }

  async stop() {
    if (!this.queue.length) return;
    this.playing = false;
    this.queue = [];
    this.emit('state', { batch: this.batch, state: 'stopped' });
  }

  async getVoices() {
    return { voices: this.voices, ready: true };
  }

  async getLastSpoken() {
    return this.lastSpoken;
  }

  async requestPermissions() {
    return { notifications: 'granted' as PermissionState };
  }

  addListener(event: string, fn: Listener): Promise<PluginListenerHandle> {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return Promise.resolve({ remove: async () => void set.delete(fn) });
  }

  /** The current utterance finishes; the next one starts (or the queue finishes). */
  advance(): void {
    if (!this.playing) return;
    this.emit('utteranceDone', this.event());
    this.index++;
    if (this.index >= this.queue.length) {
      this.playing = false;
      this.emit('state', { batch: this.batch, state: 'finished' });
    } else this.startCurrent();
  }

  finishAll(): void {
    while (this.playing) this.advance();
  }

  /** Notification buttons, handled natively without asking JS. */
  pressToggle(): void {
    if (this.playing) void this.pause();
    else void this.resume();
  }

  pressNext(): void {
    this.index = Math.min(this.index + 1, this.queue.length - 1);
    if (this.playing) this.startCurrent();
  }

  private startCurrent(): void {
    const u = this.queue[this.index]!;
    this.spoken.push(u);
    this.lastSpoken = { id: u.id, at: Date.now() };
    this.emit('utteranceStart', this.event());
  }

  private event(): UtteranceEvent {
    return { batch: this.batch, id: this.queue[this.index]!.id, index: this.index, at: Date.now() };
  }

  private emit(event: string, data: UtteranceEvent | { batch: string; state: NarratorState }) {
    for (const fn of this.listeners.get(event) ?? []) (fn as (e: typeof data) => void)(data);
  }
}
