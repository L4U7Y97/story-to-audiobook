import type { VoiceSettings } from '@/format/types';
import type { DeviceVoice } from '@/playback/engine';
import { voiceProfile } from '@/cast/voiceProfile';

export interface ResolvedVoice {
  /** The device voice to use; undefined means the engine's default for `lang`. */
  voiceName?: string;
  lang: string;
  /** The character's chosen voice isn't on this device, so another one stands in for it. */
  substituted: boolean;
}

const normaliseLocale = (locale: string) => locale.replace('_', '-').toLowerCase();
const language = (locale: string) => normaliseLocale(locale).split('-')[0]!;

/**
 * The best of the `available` voices for a locale: a voice of the same language, of the same
 * locale first, then the system default, then voices that work offline. Equally good voices keep
 * the device's order.
 */
export function bestVoiceFor(
  lang: string,
  available: readonly DeviceVoice[],
): DeviceVoice | undefined {
  const locale = normaliseLocale(lang);
  const rank = (v: DeviceVoice) =>
    (normaliseLocale(v.lang) === locale ? 0 : 4) + (v.isDefault ? 0 : 2) + (v.network ? 1 : 0);
  return available
    .filter((v) => language(v.lang) === language(lang))
    .sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Picks the device voice for a character's voice settings. The chosen voice is used when it is
 * installed. Otherwise the best voice for the same language stands in (bestVoiceFor), one of the
 * missing voice's gender when its name tells it and the device has such a voice, and pitch and
 * rate stay as they are.
 */
export function resolveVoice(
  voice: VoiceSettings,
  available: readonly DeviceVoice[],
): ResolvedVoice {
  if (voice.voiceName && available.some((v) => v.name === voice.voiceName)) {
    return { voiceName: voice.voiceName, lang: voice.lang, substituted: false };
  }

  // A woman's voice from another device is better replaced by a woman's voice here.
  const gender = voice.voiceName
    ? voiceProfile({ name: voice.voiceName, lang: voice.lang }).gender
    : undefined;
  const candidates = available.filter((v) => language(v.lang) === language(voice.lang));
  const alike = gender ? candidates.filter((v) => voiceProfile(v).gender === gender) : [];
  const best = bestVoiceFor(voice.lang, alike) ?? bestVoiceFor(voice.lang, candidates);

  // Without a voice list nothing can be checked, so nothing is reported as substituted.
  const substituted = Boolean(voice.voiceName) && available.length > 0;
  return best
    ? { voiceName: best.name, lang: best.lang, substituted }
    : { lang: voice.lang, substituted };
}
