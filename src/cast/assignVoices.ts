import type { Character, Gender, VoiceSettings } from '@/format/types';
import { voicesForLang, type DeviceVoice } from '@/playback/engine';

const PITCH_MIN = 0.75;
const PITCH_MAX = 1.3;
const PITCH_STEP = 0.05;
const BASE_PITCH: Record<Gender | 'none', number> = {
  male: 0.85,
  female: 1.15,
  other: 1,
  none: 1,
};

/**
 * Picks a voice for a new character so that it sounds different from everyone already in the
 * cast: characters rotate through the device voices for the story language (the narrator keeps
 * the default one), and pitch/rate vary deterministically by character id and gender. No two
 * characters share the same (voice, pitch, rate).
 */
export function assignVoice(
  character: Pick<Character, 'id' | 'role' | 'gender'>,
  cast: readonly Character[],
  deviceVoices: readonly DeviceVoice[],
  locale: string,
): VoiceSettings {
  const voices = voicesForLang(deviceVoices, locale).filter((v) => !v.network);
  const fallback = voicesForLang(deviceVoices, locale);
  const pool = voices.length ? voices : fallback;
  const defaultVoice = pool.find((v) => v.isDefault) ?? pool[0];

  if (character.role === 'narrator') {
    return withVoice(defaultVoice, locale, 1, 1);
  }

  const others = cast.filter((c) => c.id !== character.id);
  const characterCount = others.filter((c) => c.role === 'character').length;
  // Characters avoid the narrator's voice when there is any other choice.
  const choices = pool.length > 1 ? pool.filter((v) => v !== defaultVoice) : pool;
  const voice = choices.length ? choices[characterCount % choices.length] : undefined;

  const h = hash(character.id);
  const base = character.role === 'unknown' ? 1.1 : BASE_PITCH[character.gender ?? 'none'];
  let pitch = clamp(round(base + ((h % 5) - 2) * PITCH_STEP), PITCH_MIN, PITCH_MAX);
  const rate = round(0.95 + (Math.floor(h / 5) % 4) * 0.04);

  const taken = new Set(others.map((c) => key(c.voice.voiceName, c.voice.pitch, c.voice.rate)));
  const slots = Math.round((PITCH_MAX - PITCH_MIN) / PITCH_STEP) + 1;
  for (let i = 0; i < slots && taken.has(key(voice?.name, pitch, rate)); i++) {
    pitch = round(pitch + PITCH_STEP);
    if (pitch > PITCH_MAX) pitch = PITCH_MIN;
  }
  return withVoice(voice, locale, pitch, rate);
}

/** Assigns voices to several new characters in order, each seeing the ones before it. */
export function assignVoices(
  newCharacters: ReadonlyArray<Omit<Character, 'voice'>>,
  cast: readonly Character[],
  deviceVoices: readonly DeviceVoice[],
  locale: string,
): Character[] {
  const all = [...cast];
  const out: Character[] = [];
  for (const c of newCharacters) {
    const withVoiceSettings: Character = {
      ...c,
      voice: assignVoice(c, all, deviceVoices, locale),
    };
    all.push(withVoiceSettings);
    out.push(withVoiceSettings);
  }
  return out;
}

function withVoice(
  voice: DeviceVoice | undefined,
  locale: string,
  pitch: number,
  rate: number,
): VoiceSettings {
  return voice
    ? { voiceName: voice.name, lang: voice.lang, pitch, rate }
    : { lang: locale, pitch, rate };
}

function key(voiceName: string | undefined, pitch: number, rate: number): string {
  return `${voiceName ?? ''}|${pitch.toFixed(2)}|${rate.toFixed(2)}`;
}

/** Small deterministic string hash (FNV-1a). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
