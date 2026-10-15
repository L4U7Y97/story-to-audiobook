import type { VoiceSettings } from '@/format/types';
import type { DeviceVoice } from '@/playback/engine';

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
 * Picks the device voice for a character's voice settings. The chosen voice is used when it is
 * installed. Otherwise the best voice for the same language stands in (same locale first, then
 * the system default, then voices that work offline), and pitch and rate stay as they are.
 */
export function resolveVoice(
  voice: VoiceSettings,
  available: readonly DeviceVoice[],
): ResolvedVoice {
  if (voice.voiceName && available.some((v) => v.name === voice.voiceName)) {
    return { voiceName: voice.voiceName, lang: voice.lang, substituted: false };
  }

  const locale = normaliseLocale(voice.lang);
  const rank = (v: DeviceVoice) =>
    (normaliseLocale(v.lang) === locale ? 0 : 4) + (v.isDefault ? 0 : 2) + (v.network ? 1 : 0);
  const best = available
    .filter((v) => language(v.lang) === language(voice.lang))
    .sort((a, b) => rank(a) - rank(b))[0];

  // Without a voice list nothing can be checked, so nothing is reported as substituted.
  const substituted = Boolean(voice.voiceName) && available.length > 0;
  return best
    ? { voiceName: best.name, lang: best.lang, substituted }
    : { lang: voice.lang, substituted };
}
