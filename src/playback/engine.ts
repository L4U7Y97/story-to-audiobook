import type { VoiceSettings } from '@/format/types';

/** A voice installed on the device (Web Speech API or Android TextToSpeech). */
export interface DeviceVoice {
  /** Unique id: SpeechSynthesisVoice.voiceURI on the web, Voice.getName() on Android. */
  name: string;
  /** BCP-47, e.g. "es-ES". */
  lang: string;
  isDefault?: boolean;
  /** Needs a network connection to speak (cloud voices). */
  network?: boolean;
}

export interface Utterance {
  /** Caller's id, echoed back in progress events (e.g. "partId:segmentIndex"). */
  id: string;
  text: string;
  voice: VoiceSettings;
}

export interface SpeechEngine {
  listVoices(): Promise<DeviceVoice[]>;
  /**
   * Speaks the queue in order, calling onStart as each utterance begins. Resolves when the queue
   * is finished or stop() is called.
   */
  play(queue: Utterance[], onStart: (utteranceId: string) => void): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

/** Voices whose language matches a locale's language ("es" matches "es-AR"). */
export function voicesForLang(voices: readonly DeviceVoice[], locale: string): DeviceVoice[] {
  const lang = locale.split('-')[0]!.toLowerCase();
  return voices.filter((v) => v.lang.toLowerCase().split(/[-_]/)[0] === lang);
}
