import type { DeviceVoice } from './engine';

/**
 * Lists Web Speech voices. Browsers load them asynchronously, so this waits briefly for the
 * `voiceschanged` event when the list starts empty.
 */
export async function listWebVoices(timeoutMs = 1500): Promise<DeviceVoice[]> {
  if (typeof speechSynthesis === 'undefined') return [];
  let voices = speechSynthesis.getVoices();
  if (voices.length === 0) {
    voices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const done = () => resolve(speechSynthesis.getVoices());
      speechSynthesis.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, timeoutMs);
    });
  }
  return voices.map((v) => ({
    name: v.voiceURI,
    lang: v.lang,
    isDefault: v.default,
    network: !v.localService,
  }));
}
