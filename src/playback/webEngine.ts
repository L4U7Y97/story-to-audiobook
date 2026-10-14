import type { DeviceVoice, SpeechEngine, Utterance } from './engine';
import { listWebVoices } from './webVoices';

/** SpeechEngine on the Web Speech API (desktop browsers). */
export class WebSpeechEngine implements SpeechEngine {
  private generation = 0;
  private finish?: () => void;

  listVoices(): Promise<DeviceVoice[]> {
    return listWebVoices();
  }

  async play(queue: Utterance[], onStart: (utteranceId: string) => void): Promise<void> {
    await this.stop();
    const generation = ++this.generation;
    const voices = speechSynthesis.getVoices();

    for (const item of queue) {
      if (generation !== this.generation) return;
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(item.text);
        const voice =
          voices.find((v) => v.voiceURI === item.voice.voiceName) ??
          voices.find((v) => v.lang === item.voice.lang) ??
          voices.find((v) => v.lang.startsWith(item.voice.lang.split('-')[0]!));
        if (voice) u.voice = voice;
        u.lang = voice?.lang ?? item.voice.lang;
        u.pitch = item.voice.pitch;
        u.rate = item.voice.rate;
        u.onstart = () => {
          if (generation === this.generation) onStart(item.id);
        };
        // 'interrupted'/'canceled' errors come from stop(); either way move on.
        u.onend = u.onerror = () => resolve();
        this.finish = resolve;
        speechSynthesis.speak(u);
      });
    }
  }

  async pause(): Promise<void> {
    speechSynthesis.pause();
  }

  async resume(): Promise<void> {
    speechSynthesis.resume();
  }

  async stop(): Promise<void> {
    this.generation++;
    speechSynthesis.cancel();
    this.finish?.();
    this.finish = undefined;
  }
}
