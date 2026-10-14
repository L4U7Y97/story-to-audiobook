import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** Utterance as sent to the native Narrator plugin (android/.../narrator/Utterance.java). */
export interface NativeUtterance {
  id: string;
  text: string;
  voiceName?: string;
  lang?: string;
  pitch: number;
  rate: number;
}

export interface NativeVoice {
  name: string;
  lang: string;
  network: boolean;
  quality: number;
}

export interface UtteranceEvent {
  id: string;
  index: number;
  at: number; // native wall-clock ms, reliable even when the WebView was paused
}

export type NarratorState = 'playing' | 'paused' | 'stopped' | 'finished';

export interface NarratorPlugin {
  play(options: { queue: NativeUtterance[]; startIndex?: number }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  getVoices(): Promise<{ voices: NativeVoice[]; ready: boolean }>;
  requestPermissions(): Promise<{ notifications: PermissionState }>;
  addListener(
    event: 'utteranceStart' | 'utteranceDone',
    fn: (e: UtteranceEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'state',
    fn: (e: { state: NarratorState }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: 'error', fn: (e: { message: string }) => void): Promise<PluginListenerHandle>;
}

export const Narrator = registerPlugin<NarratorPlugin>('Narrator');
