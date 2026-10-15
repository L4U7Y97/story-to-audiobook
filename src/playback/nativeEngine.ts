import { resolveVoice } from '@/cast/resolveVoice';
import type { DeviceVoice, ExternalState, SpeechEngine, Utterance } from './engine';
import {
  Narrator,
  type NarratorPlugin,
  type NarratorState,
  type NativeUtterance,
} from './nativeBridge';

/**
 * SpeechEngine on the native Narrator plugin (Android): the whole queue is handed to a foreground
 * service that keeps speaking with the screen locked, while this class turns the plugin's events
 * back into the SpeechEngine contract.
 */
export class NativeSpeechEngine implements SpeechEngine {
  private batchCount = 0;
  private current?: { batch: string; onStart: (id: string) => void; done: () => void };
  private voices?: DeviceVoice[];
  private permissionAsked = false;
  private readonly externalListeners = new Set<(state: ExternalState) => void>();

  constructor(private readonly narrator: NarratorPlugin = Narrator) {
    void narrator.addListener('utteranceStart', (e) => {
      if (e.batch === this.current?.batch) this.current.onStart(e.id);
    });
    void narrator.addListener('state', (e) => this.onState(e.batch, e.state));
    // Known before the first play, so missing voices are substituted from the start.
    void this.listVoices().catch(() => undefined);
  }

  async listVoices(): Promise<DeviceVoice[]> {
    const { voices } = await this.narrator.getVoices();
    this.voices = voices.map((v) => ({ name: v.name, lang: v.lang, network: v.network }));
    return this.voices;
  }

  play(queue: Utterance[], onStart: (utteranceId: string) => void): Promise<void> {
    this.finishCurrent();
    const batch = `b${++this.batchCount}`;
    return new Promise<void>((done) => {
      this.current = { batch, onStart, done };
      void this.start(batch, queue).catch(() => {
        if (this.current?.batch === batch) this.finishCurrent();
      });
    });
  }

  async pause(): Promise<void> {
    await this.narrator.pause();
  }

  async resume(): Promise<void> {
    await this.narrator.resume();
  }

  async stop(): Promise<void> {
    this.finishCurrent();
    await this.narrator.stop();
  }

  onExternalState(listener: (state: ExternalState) => void): void {
    this.externalListeners.add(listener);
  }

  async lastSpoken(): Promise<{ utteranceId: string; at: number } | undefined> {
    const { id, at } = await this.narrator.getLastSpoken();
    return id && at ? { utteranceId: id, at } : undefined;
  }

  private async start(batch: string, queue: Utterance[]): Promise<void> {
    if (!this.permissionAsked) {
      // Android 13+ needs permission for the playback notification; playback works without it.
      this.permissionAsked = true;
      await this.narrator.requestPermissions().catch(() => undefined);
      if (this.current?.batch !== batch) return;
    }
    await this.narrator.play({ batch, queue: queue.map((u) => this.toNative(u)) });
  }

  private toNative(u: Utterance): NativeUtterance {
    const resolved = this.voices
      ? resolveVoice(u.voice, this.voices)
      : { voiceName: u.voice.voiceName, lang: u.voice.lang };
    return {
      id: u.id,
      text: u.text,
      ...(resolved.voiceName ? { voiceName: resolved.voiceName } : {}),
      lang: resolved.lang,
      pitch: u.voice.pitch,
      rate: u.voice.rate,
      ...(u.title ? { title: u.title } : {}),
      ...(u.subtitle ? { subtitle: u.subtitle } : {}),
    };
  }

  private onState(batch: string, state: NarratorState): void {
    if (batch !== this.current?.batch) return;
    if (state === 'finished' || state === 'stopped') this.finishCurrent();
    else for (const listener of this.externalListeners) listener(state);
  }

  private finishCurrent(): void {
    const current = this.current;
    this.current = undefined;
    current?.done();
  }
}
