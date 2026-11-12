import type { Character, CharacterRole, Traits, VoiceSettings } from '@/format/types';
import { voicesForLang, type DeviceVoice } from '@/playback/engine';
import { bestVoiceFor, resolveVoice } from '@/cast/resolveVoice';
import { cleanTraits, hasTraits } from '@/cast/traits';
import { voiceProfile, type VoiceProfile } from '@/cast/voiceProfile';

// Pitch and rate are worked out in hundredths (pitch 1.15 is 115), so every sum is exact.

interface PitchRange {
  min: number;
  max: number;
}

const PITCH_STEP = 5;
/** For a member with no age, size or species: the range every member had before traits. */
const PLAIN_PITCH: PitchRange = { min: 75, max: 130 };
const TRAIT_PITCH: PitchRange = { min: 60, max: 160 };
/** The variation by id reaches this far, so the traits stop this short of the range's ends. */
const JITTER = 2 * PITCH_STEP;
const RATE_MIN = 80;
const RATE_MAX = 125;
const RATE_STEP = 4;
/** On the narrator's voice, pitches this near to the narrator's are not used. */
const NARRATOR_GAP = PITCH_STEP;

type Member = Pick<Character, 'id' | 'role'> & Traits;
type VoiceGender = NonNullable<VoiceProfile['gender']>;

/**
 * Picks a voice for a new cast member so that it suits its traits and sounds different from
 * everyone already in the cast. A character gets a device voice of the story language whose name
 * tells the wanted gender and age when there is one (a child is voiced by a woman, a machine by a
 * robot-like voice), the least used first, and stays off the narrator's voice while it can. Pitch
 * and rate follow gender, age, size and species and vary deterministically by id. No two members
 * share the same (voice, pitch, rate), by the voice they have stored or the one they really speak
 * with on this device, and a member takes a pitch nobody has on its voice yet while one within
 * 0.10 of its own is left. The narrator keeps the default voice at neutral pitch and rate unless
 * its traits ask for another. The result is never marked `manual`.
 */
export function assignVoice(
  character: Member,
  cast: readonly Character[],
  deviceVoices: readonly DeviceVoice[],
  locale: string,
): VoiceSettings {
  return pickVoice(character, cast, deviceVoices, locale);
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

/**
 * Picks a member's voice again from its traits (never `manual`). With no device voice for the
 * language the current voiceName and lang are kept and only pitch and rate change. For the
 * narrator, when the pick is the device's own default for the locale (bestVoiceFor), voiceName
 * stays unset ({ lang: locale, … }) so another device shows no "substituted" badge.
 */
export function repickVoice(
  character: Character,
  cast: readonly Character[],
  deviceVoices: readonly DeviceVoice[],
  locale: string,
): VoiceSettings {
  const picked = pickVoice(character, cast, deviceVoices, locale, character.voice);
  const isDeviceDefault =
    picked.voiceName !== undefined && picked.voiceName === bestVoiceFor(locale, deviceVoices)?.name;
  return character.role === 'narrator' && isDeviceDefault
    ? { lang: locale, pitch: picked.pitch, rate: picked.rate }
    : picked;
}

/**
 * The voice a member really speaks with on this device: its own when it is installed, else the
 * one playback puts in its place (resolveVoice). With no device voice for the language, the name
 * it has stored.
 */
export function spokenVoiceName(
  voice: VoiceSettings,
  deviceVoices: readonly DeviceVoice[],
): string | undefined {
  return resolveVoice(voice, deviceVoices).voiceName ?? voice.voiceName;
}

/**
 * Whether a character with `voice` cannot be told from the narrator on this device: it speaks
 * with the narrator's voice (spokenVoiceName) at a pitch within 0.05 of the narrator's, or with
 * the very same voice, pitch and rate. These are the combinations a pick never gives a character.
 */
export function clashesWithNarrator(
  voice: VoiceSettings,
  narratorVoice: VoiceSettings,
  deviceVoices: readonly DeviceVoice[],
): boolean {
  const name = spokenVoiceName(voice, deviceVoices);
  if (name !== spokenVoiceName(narratorVoice, deviceVoices)) return false;
  const apart = Math.abs(hundredths(voice.pitch) - hundredths(narratorVoice.pitch));
  // Without a voice name there is no saying the two share a voice, so only a twin clashes.
  if (name !== undefined && apart <= NARRATOR_GAP) return true;
  return apart === 0 && hundredths(voice.rate) === hundredths(narratorVoice.rate);
}

function pickVoice(
  character: Member,
  cast: readonly Character[],
  deviceVoices: readonly DeviceVoice[],
  locale: string,
  current?: VoiceSettings,
): VoiceSettings {
  const isNarrator = character.role === 'narrator';
  // The unknown speaker has no traits, and values outside the format count as not set.
  const traits = character.role === 'unknown' ? {} : cleanTraits(character);
  const others = cast.filter((c) => c.id !== character.id);
  const narrator = isNarrator ? undefined : others.find((c) => c.role === 'narrator');
  const narratorVoice = isNarrator
    ? undefined
    : spokenVoiceName(narrator?.voice ?? { lang: locale, pitch: 1, rate: 1 }, deviceVoices);

  const voice = chooseVoice(character.role, traits, others, deviceVoices, locale, narratorVoice);
  // With no device voice for the language, a voice the member already has is kept.
  const voiceName = voice?.name ?? current?.voiceName;
  const lang = voice?.lang ?? current?.lang ?? locale;
  const settings = (pitch: number, rate: number): VoiceSettings =>
    voiceName === undefined
      ? { lang, pitch: pitch / 100, rate: rate / 100 }
      : { voiceName, lang, pitch: pitch / 100, rate: rate / 100 };
  if (isNarrator && !hasTraits(traits)) return settings(100, 100);

  const profile = voiceName === undefined ? {} : voiceProfile({ name: voiceName, lang });
  const onNarratorVoice = voiceName !== undefined && voiceName === narratorVoice;
  const natural = naturalTuning(character, traits, profile, onNarratorVoice);

  const narratorPitch = hundredths(narrator?.voice.pitch ?? 1);
  // The others count under the name they have stored and under the voice they really speak with
  // (a member with no voice name speaks with the device's default one). The narrator's own pick
  // goes by the stored names of the characters: it keeps the default voice, whoever else speaks
  // with it, and they are moved away from it afterwards. The unknown speaker never moves, so the
  // narrator keeps clear of the voice it is heard with.
  const spoken = others.map((c) =>
    isNarrator && c.role !== 'unknown' ? c.voice.voiceName : spokenVoiceName(c.voice, deviceVoices),
  );
  const taken = new Set(
    others.flatMap((c, i) =>
      [c.voice.voiceName, spoken[i]].map((name) =>
        key(name, hundredths(c.voice.pitch), hundredths(c.voice.rate)),
      ),
    ),
  );
  const isFree = (pitch: number, rate: number) =>
    !(onNarratorVoice && Math.abs(pitch - narratorPitch) <= NARRATOR_GAP) &&
    !taken.has(key(voiceName, pitch, rate));
  // The pitches already heard on the chosen voice, at whatever rate. The narrator's pitch is
  // what its traits give, so for its own pick none counts.
  const heard = new Set(
    others
      .filter((_, i) => !isNarrator && spoken[i] === voiceName)
      .map((c) => hundredths(c.voice.pitch)),
  );
  const free = freeCombination(
    natural.pitch,
    natural.rate,
    natural.range,
    isFree,
    (pitch) => !heard.has(pitch),
  );
  return settings(free.pitch, free.rate);
}

/** The device voice that suits the member best, if the device has any for the language. */
function chooseVoice(
  role: CharacterRole,
  traits: Traits,
  others: readonly Character[],
  deviceVoices: readonly DeviceVoice[],
  locale: string,
  narratorVoice: string | undefined,
): DeviceVoice | undefined {
  const forLang = voicesForLang(deviceVoices, locale);
  const pool = someOf(forLang, (v) => !v.network);
  const profiles = new Map(pool.map((v) => [v, voiceProfile(v)]));
  const profile = (v: DeviceVoice): VoiceProfile => profiles.get(v) ?? {};
  // Singing and effect voices are for the user to choose, never picked automatically.
  const usable = someOf(pool, (v) => !profile(v).novelty);
  const defaultVoice = bestVoiceFor(locale, usable) ?? usable[0];
  if (role === 'narrator' && !hasTraits(traits)) return defaultVoice;

  // A child is voiced by a woman, boys too: a man's voice pitched up sounds like a sped-up man.
  const wanted = traits.age === 'child' ? 'female' : binaryGender(traits);
  let candidates = usable;
  if (wanted) candidates = someOf(candidates, (v) => (profile(v).gender ?? wanted) === wanted);
  // A child's or an elderly voice is for a child or an elderly member only, and best for them.
  candidates = someOf(candidates, (v) => (profile(v).age ?? traits.age) === traits.age);
  candidates = someOf(candidates, (v) => !!traits.age && profile(v).age === traits.age);
  // Robot-like voices count as novelty voices, so they are looked for in the whole pool.
  const robots = pool.filter((v) => profile(v).robotic);
  if (traits.species === 'machine' && robots.length) candidates = robots;

  // The default voice when it suits the narrator: it ranks first among any voices it is in.
  if (role === 'narrator') return bestVoiceFor(locale, candidates);

  const matches = (v: DeviceVoice) => wanted !== undefined && profile(v).gender === wanted;
  // The narrator's voice is left to the narrator, unless it is of the wanted gender.
  const choices = someOf(candidates, (v) => v.name !== narratorVoice || matches(v));
  const uses = new Map<string, number>();
  for (const { voice } of others) {
    if (voice.voiceName) uses.set(voice.voiceName, (uses.get(voice.voiceName) ?? 0) + 1);
  }
  const cost = (v: DeviceVoice) =>
    (uses.get(v.name) ?? 0) + (v.name === narratorVoice ? 3 : wanted && !matches(v) ? 2 : 0);

  let best: DeviceVoice | undefined;
  let lowest = Infinity;
  for (const v of choices) {
    const c = cost(v);
    // Equally busy voices keep the device's order, but the narrator's voice loses a tie.
    if (c < lowest || (c === lowest && best?.name === narratorVoice)) {
      best = v;
      lowest = c;
    }
  }
  return best;
}

/** Pitch and rate as the traits and the id alone give them, and the pitch range of the member. */
function naturalTuning(
  character: Member,
  traits: Traits,
  profile: VoiceProfile,
  onNarratorVoice: boolean,
): { pitch: number; rate: number; range: PitchRange } {
  const isNarrator = character.role === 'narrator';
  const h = hash(character.id);
  const child = traits.age === 'child';
  const machine = traits.species === 'machine';

  let pitch = basePitch(character.role, traits, profile, onNarratorVoice);
  let rate = isNarrator ? 100 : 95 + (Math.floor(h / 5) % 4) * RATE_STEP;

  if (child) rate += 4;
  if (traits.age === 'teen') {
    pitch += 10;
    rate += 2;
  }
  // Slow speech is what makes a voice sound old; an elderly voice needs less of it.
  if (traits.age === 'elder') rate -= profile.age === 'elder' ? 6 : 12;

  // A child is already pitched high, so its size moves it half as much.
  const sizePitch = child ? 10 : 20;
  if (traits.size === 'small') {
    pitch += sizePitch;
    rate += 5;
  }
  if (traits.size === 'large') {
    pitch -= sizePitch;
    rate -= 7;
  }

  if (traits.species === 'animal') {
    pitch += 10;
    rate += 4;
  }
  if (traits.species === 'creature') {
    pitch -= 10;
    rate -= 4;
  }
  // A robot-like voice is slow and flat enough as it is.
  if (machine && !profile.robotic) rate -= 8;

  const range = traits.age || traits.size || traits.species ? TRAIT_PITCH : PLAIN_PITCH;
  // A machine speaks in a flat register, and the narrator does not vary by id.
  const jitter = isNarrator || machine ? 0 : ((h % 5) - 2) * PITCH_STEP;
  return {
    pitch: clamp(pitch, range.min + JITTER, range.max - JITTER) + jitter,
    rate: clamp(rate, RATE_MIN, RATE_MAX),
    range,
  };
}

/** The pitch gender and childhood give on the chosen voice, before the other traits. */
function basePitch(
  role: CharacterRole,
  traits: Traits,
  profile: VoiceProfile,
  onNarratorVoice: boolean,
): number {
  const gender = binaryGender(traits);
  const lean = gender === 'male' ? -1 : gender === 'female' ? 1 : 0;
  if (traits.age === 'child') {
    // The less childlike the voice, the more pitch it takes: least on a child's, most on a man's.
    const centre =
      profile.age === 'child'
        ? 100
        : profile.gender === 'female'
          ? 120
          : profile.gender === 'male'
            ? 140
            : 130;
    return centre + lean * 5;
  }
  if (role === 'unknown') return 110;
  if (!gender) return 100;
  if (role === 'narrator') {
    return profile.gender && profile.gender !== gender ? 100 + lean * 10 : 100;
  }
  // On the narrator's voice a character keeps the full distance, whatever the voice's gender.
  const voiceGender = onNarratorVoice ? undefined : profile.gender;
  const distance = !voiceGender ? 15 : voiceGender === gender ? 10 : 20;
  return 100 + lean * distance;
}

/**
 * The free (pitch, rate) nearest to the natural one. First a near pitch that is free at the
 * natural rate and `isUnheard` on the voice: two members who differ only in rate are hard to tell
 * apart by ear. With every near pitch heard there, one is shared at another rate: the same rate
 * first, then rates further and further away, and for each rate the nearest pitches first.
 */
function freeCombination(
  pitch: number,
  rate: number,
  range: PitchRange,
  isFree: (pitch: number, rate: number) => boolean,
  isUnheard: (pitch: number) => boolean,
): { pitch: number; rate: number } {
  const pitches = spread(pitch, PITCH_STEP, range.min, range.max);
  const near = pitches.filter((p) => Math.abs(p - pitch) <= 2 * PITCH_STEP);
  const unheard = near.find((candidate) => isUnheard(candidate) && isFree(candidate, rate));
  if (unheard !== undefined) return { pitch: unheard, rate };
  const rates = spread(rate, RATE_STEP, RATE_MIN, RATE_MAX);
  for (const tried of [near, pitches]) {
    for (const r of rates) {
      const p = tried.find((candidate) => isFree(candidate, r));
      if (p !== undefined) return { pitch: p, rate: r };
    }
  }
  // Only a cast far larger than any story's gets here. Every other rate of the range is tried,
  // then rates above it: the cast is finite, so one of them is free.
  const span = RATE_MAX - RATE_MIN + 1;
  for (let step = 1; ; step++) {
    const r =
      step < span ? RATE_MIN + ((rate - RATE_MIN + step) % span) : RATE_MAX + step - span + 1;
    const p = pitches.find((candidate) => isFree(candidate, r));
    if (p !== undefined) return { pitch: p, rate: r };
  }
}

/** `start`, then the values `step` apart on both sides of it, nearest first, within min–max. */
function spread(start: number, step: number, min: number, max: number): number[] {
  const out = [start];
  for (let d = step; start + d <= max || start - d >= min; d += step) {
    if (start + d <= max) out.push(start + d);
    if (start - d >= min) out.push(start - d);
  }
  return out;
}

/** The items of `list` worth keeping, or the whole list when none is: a filter never empties it. */
function someOf<T>(list: readonly T[], keep: (item: T) => boolean): readonly T[] {
  const kept = list.filter(keep);
  return kept.length ? kept : list;
}

function binaryGender(traits: Traits): VoiceGender | undefined {
  return traits.gender === 'male' || traits.gender === 'female' ? traits.gender : undefined;
}

function key(voiceName: string | undefined, pitch: number, rate: number): string {
  return `${voiceName ?? ''}|${pitch}|${rate}`;
}

function hundredths(n: number): number {
  return Math.round(n * 100);
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

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
