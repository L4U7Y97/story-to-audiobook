import type { DeviceVoice } from '@/playback/engine';

/** What the name of a device voice gives away about how it sounds. */
export interface VoiceProfile {
  gender?: 'male' | 'female';
  age?: 'child' | 'elder';
  /** Robot-like (macOS Zarvox, Trinoids). */
  robotic?: boolean;
  /** Singing, joke and effect voices; robotic voices are novelty too. */
  novelty?: boolean;
}

type VoiceGender = NonNullable<VoiceProfile['gender']>;

interface KnownName {
  gender: VoiceGender;
  age?: VoiceProfile['age'];
  /** The name means this voice only among voices of this language. */
  lang?: string;
}

const words = (list: string) => list.split(' ').filter(Boolean);

// Every table below holds only what the voice research confirmed (official documentation, or
// device-tested lists that agree). A voice that is not here gets an empty profile: a wrong gender
// is worse than none.

const GENDER_WORDS = new Map<string, VoiceGender>([
  ...words('female woman mujer femenina femenino').map((w) => [w, 'female'] as const),
  ...words('male man hombre masculino masculina').map((w) => [w, 'male'] as const),
]);

function androidVoices(locale: string, female: string, male: string): Array<[string, VoiceGender]> {
  return [
    // The default voice of each of these locales is its first female one.
    [`${locale}-language`, 'female'],
    ...words(female).map((code): [string, VoiceGender] => [`${locale}-x-${code}`, 'female']),
    ...words(male).map((code): [string, VoiceGender] => [`${locale}-x-${code}`, 'male']),
  ];
}

/** Google's Android voices, as "locale-x-code" or "locale-language". No es-MX voice is known. */
const ANDROID_VOICES = new Map<string, VoiceGender>([
  ...androidVoices('en-us', 'tpc iob iog tpf sfg', 'iom iol tpd'),
  ...androidVoices('en-gb', 'gba gbc gbg fis', 'rjs gbb gbd'),
  ...androidVoices('en-au', 'aua auc afh', 'aub aud'),
  ...androidVoices('en-in', 'ena enc ahp cxx', 'end ene'),
  ...androidVoices('en-ng', 'tfn', ''),
  ...androidVoices('es-es', 'eee eea eec ana', 'eed eef'),
  ...androidVoices('es-us', 'esc sfb', 'esd esf'),
]);

// The name may follow an engine name ("… from Google en-us-x-tpc-network", Chrome OS), and older
// engines put a "#male_1" variant between the code and "-local".
const ANDROID_NAME =
  /(?:^|\s)([a-z]{2,3}-[a-z]{2}-(?:x-[a-z0-9]+|language))(?:#[a-z]+_\d+)?(?:-(?:local|network))?$/;

function numbered(
  base: string,
  female: readonly number[],
  male: readonly number[],
): Array<[string, VoiceGender]> {
  return [
    ...female.map((n): [string, VoiceGender] => [`${base} ${n}`, 'female']),
    ...male.map((n): [string, VoiceGender] => [`${base} ${n}`, 'male']),
  ];
}

/** Chrome's own "Google …" voices and their numbered Chrome OS aliases, accents removed. */
const CHROME_VOICES = new Map<string, VoiceGender>([
  ['google us english', 'female'],
  ['google uk english female', 'female'],
  ['google uk english male', 'male'],
  ['google espanol', 'male'],
  ['google espanol de estados unidos', 'female'],
  ...numbered('google us english', [1, 2, 5, 7], [3, 4, 6]),
  ...numbered('chrome os us english', [1, 2, 5, 7, 8], [3, 4, 6]),
  ...numbered('google uk english', [2, 4, 6], [1, 3, 5]),
  ...numbered('chrome os uk english', [7], []),
  ...numbered('google australian english', [1, 3], [2, 4]),
  ...numbered('chrome os australian english', [], [5]),
  ...numbered('google espanol', [1, 2, 4], [3, 5]),
  ...numbered('google espanol de estados unidos', [1, 2], [3, 4]),
]);

// First names of Microsoft (classic and "Online (Natural)") and Apple (standard, Siri, legacy
// MacinTalk, Eloquence) voices for English and Spanish, accents removed. A name several engines
// use has the same gender in all of them.
const FEMALE_NAMES =
  'zira hazel susan catherine linda heera helena laura sabina hayley heather hilda ' +
  'aria jenny michelle emma ava sonia libby natasha clara neerja emily leah molly yan luna ' +
  'asilia ezinne rosa imani elvira dalia paloma elena sofia catalina salome ximena maria ' +
  'belkys ramona andrea lorena teresa marta karla yolanda margarita tania camila karina ' +
  'valentina paola samantha allison nicky zoe victoria vicki agnes kate serena martha ' +
  'stephanie fiona karen matilda moira tessa veena isha sangeeta tara monica marisol ' +
  'paulina angelica isabela francisca soledad jimena kathy shelley flo sandy';
const MALE_NAMES =
  'david mark george james richard ravi sean pablo raul guy eric steffan christopher roger ' +
  'andrew brian ryan thomas william liam prabhat connor luke mitchell sam wayne chilemba ' +
  'abeo elimu alvaro jorge alonso tomas marcelo lorenzo gonzalo juan manuel emilio luis ' +
  'rodrigo javier andres carlos federico roberto mario alex victor mateo sebastian tom ' +
  'aaron evan nathan bruce daniel oliver arthur jamie lee gordon rishi aman diego fred ' +
  'ralph reed eddy rocko';

const KNOWN_NAMES = new Map<string, KnownName>([
  ...words(FEMALE_NAMES).map((name): [string, KnownName] => [name, { gender: 'female' }]),
  ...words(MALE_NAMES).map((name): [string, KnownName] => [name, { gender: 'male' }]),
  // Ana is Microsoft's en-US child voice; on a Spanish voice it is just a common woman's name.
  ['ana', { gender: 'female', age: 'child', lang: 'en' }],
  ['maisie', { gender: 'female', age: 'child' }],
  ['joelle', { gender: 'female', age: 'child' }],
  ['junior', { gender: 'male', age: 'child' }],
  ['grandma', { gender: 'female', age: 'elder' }],
  ['grandpa', { gender: 'male', age: 'elder' }],
]);

// Edge names some voices "AndrewMultilingual".
const MULTILINGUAL = 'multilingual';

/**
 * The macOS novelty voices with letters only: English and Spanish display names, former names
 * (Pipe Organ, Princess) and the identifier suffixes that differ from the name (Deranged is
 * Wobble, Hysterical is Jester). None of them is treated as a gendered voice.
 */
const NOVELTY_VOICES = new Set(
  words(
    'zarvox trinoids cellos violonchelos goodnews buenasnoticias badnews malasnoticias organ ' +
      'organo pipeorgan bells campanas boing bubbles burbujas bahh wobble deranged whisper ' +
      'susurro albert jester bufon hysterical superstar superestrella princess',
  ),
);
const ROBOTIC_VOICES = new Set(['zarvox', 'trinoids']);

/**
 * What a device voice's name gives away: gender, a child or elderly voice, a robot-like or
 * novelty voice. `voice.name` is the Web Speech voiceURI (a display name in Chrome and Edge, an
 * identifier in Safari and Firefox) or the Android voice name. Unknown names give `{}`.
 */
export function voiceProfile(voice: Pick<DeviceVoice, 'name' | 'lang'>): VoiceProfile {
  const name = fold(voice.name);

  const novelty = wholeName(name);
  if (NOVELTY_VOICES.has(novelty)) {
    return ROBOTIC_VOICES.has(novelty) ? { robotic: true, novelty: true } : { novelty: true };
  }

  // Tokens are runs of letters, so "female" is one token and never reads as "male".
  const tokens = name.split(/[^\p{L}]+/u).filter(Boolean);
  const android = ANDROID_NAME.exec(name)?.[1];
  // An Android name is made of codes, not words: "es-es-x-ana-local" is not the voice Ana.
  const known = android ? undefined : knownName(tokens, language(voice.lang));
  const gender =
    explicitGender(name, tokens) ??
    (android ? ANDROID_VOICES.get(android) : (chromeGender(name) ?? known?.gender));

  const profile: VoiceProfile = {};
  if (gender) profile.gender = gender;
  if (known?.age) profile.age = known.age;
  return profile;
}

/** Lower-case and without accents, so that "Mónica" and "Monica" are the same name. */
function fold(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();
}

function language(locale: string): string {
  return locale.toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * The letters of the voice's own name: the last part of an Apple identifier, or a display name
 * without the language in brackets ("Bad News (English (United States))").
 */
function wholeName(name: string): string {
  const own = name.includes('com.apple.')
    ? name.slice(name.lastIndexOf('.') + 1)
    : name.replace(/\(.*$/, '');
  return own.replace(/[^\p{L}]+/gu, '');
}

function explicitGender(name: string, tokens: readonly string[]): VoiceGender | undefined {
  // The variant suffix comes first: it can contradict the code before it ("rjs#female_1").
  const suffix = /#(female|male)_\d+/.exec(name);
  if (suffix) return suffix[1] === 'female' ? 'female' : 'male';
  for (const token of tokens) {
    const gender = GENDER_WORDS.get(token);
    if (gender) return gender;
  }
  return undefined;
}

function chromeGender(name: string): VoiceGender | undefined {
  const plain = name
    .replace(/\s*\(natural\)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // A numbered voice is looked up as such first: "Google español 4" is female, "Google español"
  // male. A number the table lacks is read as the unnumbered voice.
  return CHROME_VOICES.get(plain) ?? CHROME_VOICES.get(plain.replace(/ \d+$/, ''));
}

function knownName(tokens: readonly string[], lang: string): KnownName | undefined {
  for (const token of tokens) {
    const known =
      KNOWN_NAMES.get(token) ??
      (token.endsWith(MULTILINGUAL)
        ? KNOWN_NAMES.get(token.slice(0, -MULTILINGUAL.length))
        : undefined);
    if (known && (!known.lang || known.lang === lang)) return known;
  }
  return undefined;
}
