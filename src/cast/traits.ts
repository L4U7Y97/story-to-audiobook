import { AGE_GROUPS, GENDERS, SIZES, SPECIES } from '@/format/types';
import type { Gender, Lang, Size, Traits } from '@/format/types';
import { DETERMINERS, POSSESSIVE_DETERMINERS } from '@/analysis/heuristic/lexicon';

/** The traits of a cast member, in the order they are written. */
export const TRAIT_KEYS = ['gender', 'age', 'species', 'size'] as const;

/** Only the valid trait values of `source`, with no undefined keys. */
export function cleanTraits(source: {
  gender?: unknown;
  age?: unknown;
  species?: unknown;
  size?: unknown;
}): Traits {
  const traits: Traits = {};
  const gender = GENDERS.find((value) => value === source.gender);
  const age = AGE_GROUPS.find((value) => value === source.age);
  const species = SPECIES.find((value) => value === source.species);
  const size = SIZES.find((value) => value === source.size);
  if (gender) traits.gender = gender;
  if (age) traits.age = age;
  if (species) traits.species = species;
  if (size) traits.size = size;
  return traits;
}

/** Whether `member` has any valid trait. */
export function hasTraits(member: Traits): boolean {
  return Object.keys(cleanTraits(member)).length > 0;
}

/**
 * A copy of `member` with the given traits set; a key given as undefined (or an invalid value) is
 * removed. Keys not in `changes` are untouched, except that a trait holding an invalid value (a
 * hand-edited import) counts as unset and loses its key, so the copy never has one.
 */
export function withTraits<T extends Traits>(
  member: T,
  changes: { [K in keyof Traits]?: Traits[K] | undefined },
): T {
  const traits = cleanTraits({ ...cleanTraits(member), ...changes });
  const copy = { ...member };
  const held: Traits = copy;
  for (const key of TRAIT_KEYS) if (!(key in traits)) delete held[key];
  // A trait the member already had keeps its place, so an unchanged member is written as it was.
  return Object.assign(copy, traits);
}

/**
 * A copy of `member` with only its missing traits taken from `found` (fill-only). Returns `member`
 * itself when nothing is added.
 */
export function fillTraits<T extends Traits>(member: T, found: Traits): T {
  const held = cleanTraits(member);
  const filled: Traits = { ...cleanTraits(found), ...held };
  return TRAIT_KEYS.every((key) => filled[key] === held[key]) ? member : withTraits(member, filled);
}

/** What a noun tells about the one it names, and how it behaves in a description. */
interface Noun extends Traits {
  /** A family word ("sister", "hermano"): "little" and "big" before it tell the age. */
  kin?: true;
  /** A word for someone young ("boy", "chica"): a child only with "little" or "pequeño". */
  young?: true;
  /** A plain word for an adult ("man", "señora"): elderly with "old" right beside it. */
  grown?: true;
  /** Spanish "viejo", "anciana": someone elderly when the description ends with it. */
  old?: true;
  /** Spanish "viejo", "joven", "gigante": an adjective when another noun follows ("el viejo lobo"). */
  adjective?: true;
  /** Spanish "joven": the article tells the gender. */
  common?: true;
}

/** A table of nouns from groups of space-separated words; a word in several groups has it all. */
function nouns(...groups: Array<readonly [Noun, string]>): ReadonlyMap<string, Noun> {
  const table = new Map<string, Noun>();
  for (const [info, words] of groups) {
    for (const word of words.split(/\s+/u)) {
      if (word) table.set(word, { ...table.get(word), ...info });
    }
  }
  return table;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/u).filter(Boolean));

// Words that are also common first names or nicknames stay out of these lists ("Robin", "Kitty",
// "Paloma"), and so does "kid": a bare word is read as a species (see inferTraits).
const NOUNS: Record<Lang, ReadonlyMap<string, Noun>> = {
  en: nouns(
    [
      { gender: 'male' },
      `man gentleman fellow guy chap bloke boy lad schoolboy father dad daddy papa son brother uncle
       husband nephew grandson stepfather stepbrother godfather boyfriend king prince emperor duke
       lord wizard sorcerer widower monk priest butler waiter landlord policeman fisherman postman
       milkman coachman boatman ferryman footman huntsman nobleman
       grandfather grandpa granddad grandad grandpapa gramps great-grandfather`,
    ],
    [
      { gender: 'female' },
      `woman lady girl lass schoolgirl mother mom mum mommy mummy mama mamma daughter sister aunt
       wife niece granddaughter stepmother stepsister godmother girlfriend queen princess empress
       duchess countess witch sorceress widow nun maid maiden waitress landlady hostess mistress
       governess policewoman noblewoman bride actress shepherdess
       grandmother grandma granny grannie gran grandmama grandmamma great-grandmother`,
    ],
    [
      { kin: true },
      `mother mom mum mommy mummy mama mamma father dad daddy papa son daughter brother sister aunt
       uncle wife husband niece nephew cousin grandson granddaughter stepmother stepfather
       stepsister stepbrother godmother godfather`,
    ],
    [
      { age: 'elder', kin: true },
      `grandmother grandma granny grannie gran grandmama grandmamma great-grandmother
       grandfather grandpa granddad grandad grandpapa gramps great-grandfather`,
    ],
    [{ young: true }, 'boy girl kid lad lass schoolboy schoolgirl child baby toddler infant'],
    [{ age: 'child' }, 'child baby toddler infant'],
    [{ grown: true }, 'man woman lady gentleman'],
    [
      { species: 'animal' },
      `dog puppy hound cat kitten tomcat wolf she-wolf fox vixen bear cub rabbit hare mouse dormouse
       rat horse pony mare stallion foal donkey mule pig piglet hog sow boar cow bull ox calf sheep
       lamb ewe goat lion lioness tiger tigress leopard panther cheetah jaguar lynx monkey ape
       gorilla chimpanzee elephant giraffe zebra camel bird owl crow duck duckling goose gosling
       swan hen chicken rooster cockerel peacock parrot pigeon dove sparrow swallow eagle hawk
       falcon vulture stork heron seagull gull magpie blackbird nightingale lark cuckoo woodpecker
       penguin ostrich pelican flamingo frog toad tadpole snake serpent viper cobra lizard
       chameleon crocodile alligator turtle tortoise fish shark whale dolphin seal walrus crab
       lobster octopus eel jellyfish starfish bee wasp ant fly flea mosquito moth butterfly
       caterpillar beetle ladybird ladybug grasshopper spider worm snail slug squirrel deer stag
       reindeer moose elk buffalo bison hedgehog badger mole otter beaver weasel ferret bat
       hamster shrew vole raccoon skunk porcupine kangaroo koala panda jackal hyena coyote`,
    ],
    [{ gender: 'male' }, 'tomcat stallion bull rooster cockerel stag'],
    [{ gender: 'female' }, 'she-wolf vixen mare sow cow ewe lioness tigress hen'],
    [
      { size: 'small' },
      `mouse dormouse shrew vole hamster sparrow tadpole bee wasp ant fly flea mosquito moth
       butterfly caterpillar beetle ladybird ladybug grasshopper worm snail slug`,
    ],
    [{ size: 'large' }, 'bear elephant whale giraffe gorilla bull ox buffalo bison moose'],
    [
      { species: 'creature' },
      `dragon giant giantess troll ogre ogress goblin hobgoblin elf fairy pixie sprite imp
       leprechaun dwarf gnome ghost phantom spectre specter wraith ghoul monster spirit demon devil
       mermaid merman unicorn vampire werewolf zombie orc centaur cyclops minotaur genie golem
       gargoyle yeti alien`,
    ],
    [{ gender: 'male' }, 'merman'],
    [{ gender: 'female' }, 'mermaid giantess ogress'],
    [{ size: 'small' }, 'fairy pixie sprite imp gnome leprechaun'],
    [{ size: 'large' }, 'giant giantess dragon ogre ogress troll cyclops'],
    [{ species: 'machine' }, 'robot android droid computer machine cyborg automaton'],
  ),
  es: nouns(
    [
      { gender: 'male' },
      `hombre señor caballero niño nene chico muchacho mozo chiquillo chaval padre papá hijo
       hermano tío esposo marido sobrino nieto primo cuñado suegro padrastro hermanastro padrino
       novio rey príncipe emperador duque conde brujo mago hechicero viudo monje criado amigo
       viejo anciano viejecito viejito ancianito abuelo abuelito bisabuelo`,
    ],
    [
      { gender: 'female' },
      `mujer señora señorita dama niña nena chica muchacha moza chiquilla chavala madre mamá hija
       hermana tía esposa sobrina nieta prima cuñada suegra madrastra hermanastra madrina novia
       reina princesa emperatriz duquesa condesa bruja maga hechicera viuda monja criada doncella
       amiga vieja anciana viejecita viejita ancianita abuela abuelita bisabuela`,
    ],
    [
      { kin: true },
      `madre mamá padre papá hijo hija hermano hermana tío tía esposa esposo marido sobrino sobrina
       nieto nieta primo prima cuñado cuñada suegro suegra madrastra padrastro hermanastra
       hermanastro madrina padrino`,
    ],
    [{ age: 'elder', kin: true }, 'abuela abuelita bisabuela abuelo abuelito bisabuelo'],
    [
      { young: true },
      `niño niña nene nena bebé chico chica muchacho muchacha joven mozo moza chiquillo chiquilla
       chaval chavala`,
    ],
    [{ age: 'child' }, 'niño niña nene nena bebé'],
    [{ grown: true }, 'hombre mujer señor señora caballero dama'],
    [
      { old: true },
      'viejo vieja anciano anciana viejecito viejecita viejito viejita ancianito ancianita',
    ],
    [{ adjective: true }, 'viejo vieja anciano anciana joven gigante'],
    [{ common: true }, 'joven'],
    [
      { species: 'animal' },
      `perro perra perrito perrita cachorro gato gata gatito gatita lobo loba lobezno zorro zorra
       oso osa osito osezno conejo coneja conejito liebre ratón ratona ratoncito rata caballo yegua
       potro poni burro burra asno mula cerdo cerda cerdito puerco vaca toro buey ternero oveja
       cordero carnero cabra león leona tigre tigresa leopardo pantera guepardo jaguar lince mono
       mona simio gorila chimpancé elefante jirafa cebra camello hipopótamo rinoceronte pájaro
       pajarito búho lechuza cuervo pato patito ganso oca cisne gallina gallo pollito pavo loro
       águila halcón buitre gorrión golondrina cigüeña gaviota urraca mirlo ruiseñor pingüino
       avestruz rana ranita sapo renacuajo serpiente culebra víbora lagarto lagartija camaleón
       cocodrilo caimán tortuga pez pececito tiburón ballena delfín foca cangrejo pulpo abeja
       avispa hormiga mosca mosquito pulga polilla mariposa oruga escarabajo saltamontes grillo
       cigarra araña gusano lombriz caracol ardilla ciervo cierva venado reno alce búfalo bisonte
       jabalí erizo topo tejón nutria castor comadreja hurón murciélago hámster mapache canguro
       koala panda chacal hiena coyote`,
    ],
    // Only the nouns with a form for each sex; "la liebre" and "el sapo" may be either.
    [
      { gender: 'male' },
      `perro perrito gato gatito lobo zorro oso osito conejo conejito caballo burro cerdo cerdito
       toro buey carnero león tigre mono gallo ciervo`,
    ],
    [
      { gender: 'female' },
      `perra perrita gata gatita loba zorra osa coneja yegua burra cerda vaca leona tigresa mona
       gallina ratona cierva`,
    ],
    [
      { size: 'small' },
      `ratón ratona ratoncito gorrión renacuajo hámster abeja avispa hormiga mosca mosquito pulga
       polilla mariposa oruga escarabajo saltamontes grillo cigarra gusano lombriz caracol`,
    ],
    [
      { size: 'large' },
      'oso osa elefante ballena jirafa gorila hipopótamo rinoceronte toro buey búfalo bisonte alce',
    ],
    [
      { species: 'creature' },
      `dragón gigante giganta trol troll ogro ogra ogresa duende duendecillo trasgo elfo elfa hada
       enano enana gnomo fantasma espectro monstruo espíritu demonio diablo sirena tritón unicornio
       vampiro zombi orco centauro cíclope minotauro genio gólem gárgola yeti alienígena
       extraterrestre`,
    ],
    [{ gender: 'male' }, 'ogro elfo enano tritón'],
    [{ gender: 'female' }, 'giganta ogra ogresa elfa enana sirena'],
    [{ size: 'small' }, 'hada gnomo duende duendecillo trasgo'],
    [{ size: 'large' }, 'gigante giganta dragón ogro ogra ogresa trol troll cíclope'],
    [
      { species: 'machine' },
      'robot androide droide computadora computador ordenador máquina cíborg ciborg autómata',
    ],
  ),
};

/** First words of a description rather than a name ("the old man", "mi abuela"). */
const DETERMINER_WORDS: Record<Lang, ReadonlySet<string>> = {
  en: new Set(Object.keys(DETERMINERS.en)),
  es: new Set([...Object.keys(DETERMINERS.es), 'los', 'las', 'sus', 'mis', 'tu', 'tus']),
};

/**
 * Words that end what a description says about its head: "the king of the giants", "the old man
 * and his wife", "el jinete a caballo".
 */
const STOP_WORDS: Record<Lang, ReadonlySet<string>> = {
  en: words('of with in from who and or on at by called named'),
  es: words('de del con que en y e o u a sobre junto sin tras por para'),
};

const sizes = (small: string, large: string): ReadonlyMap<string, Size> =>
  new Map<string, Size>([
    ...[...words(small)].map((word) => [word, 'small'] as const),
    ...[...words(large)].map((word) => [word, 'large'] as const),
  ]);

/** Adjectives that tell a size. */
const SIZE_WORDS: Record<Lang, ReadonlyMap<string, Size>> = {
  en: sizes('little tiny small', 'big huge giant enormous great large gigantic'),
  es: sizes(
    'pequeño pequeña pequeñito pequeñita diminuto diminuta chiquito chiquita',
    'gran grande enorme gigante gigantesco gigantesca',
  ),
};

/** "the great king", "el gran rey": of a person these mean famous, not large. */
const GREAT = words('great gran');

/** The one adjective that makes a child of a boy or a girl. */
const LITTLE: Record<Lang, ReadonlySet<string>> = {
  en: words('little'),
  es: words('pequeño pequeña pequeñito pequeñita'),
};

/** Adjectives for the young of a kind: "the baby bear" is not as large as a bear. */
const YOUNG_ONE: Record<Lang, ReadonlySet<string>> = {
  en: words('baby young newborn infant'),
  es: words('bebé joven'),
};

/** Adjectives that make an elder of a man or a woman; not "aged", as in "the middle aged man". */
const OLD: Record<Lang, ReadonlySet<string>> = {
  en: words('old elderly'),
  es: words('viejo vieja anciano anciana'),
};

/** A unit of age, alone or at the end of a compound: "forty year old", "forty-year old". */
const AGE_UNIT = /(^|-)(years?|months?|weeks?|days?)$/u;

/** A description taken apart: its head noun and what stands around it. */
interface Phrase {
  /** The head, when it is a noun of the table. */
  noun: Noun | undefined;
  /** The other words about the head. */
  adjectives: readonly string[];
  /** The words right beside the head. */
  beside: readonly string[];
  /** The description ends with its head. */
  last: boolean;
  /** "my old man", "su vieja", "the boy’s mother": it says whose the person is. */
  owned: boolean;
  /** The gender of a Spanish article. */
  article?: Gender | undefined;
}

/**
 * The words of `name` without the quotes and commas around them; ’ and ' are the same. A full
 * stop stays, so the initial of "A. Bear" is no article.
 */
function wordsOf(name: string): string[] {
  return (
    name
      .replace(/[’ʼ]/gu, "'")
      .split(/\s+/u)
      // The lookbehind lets the end of a word be tried once for each run of punctuation, not once
      // for each of its characters: a long run inside a word would take quadratic time.
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|(?<![^\p{L}\p{N}.])[^\p{L}\p{N}.]+$/gu, ''))
      .filter(Boolean)
  );
}

/** The words of `name` in NFC and lower case (see wordsOf). */
function tokenise(name: string): string[] {
  return wordsOf(name.normalize('NFC').toLowerCase());
}

/** Whether `word`, in lower case, ends what a description says about its head. */
function endsDescription(word: string, lang: Lang): boolean {
  // A second article starts someone or something else: "the man holding the baby".
  return STOP_WORDS[lang].has(word) || DETERMINER_WORDS[lang].has(word);
}

/** The words about the head, given those after the determiner or the possessive. */
function untilStop(tokens: readonly string[], lang: Lang): readonly string[] {
  const stop = tokens.findIndex((word) => endsDescription(word, lang));
  return stop < 0 ? tokens : tokens.slice(0, stop);
}

/**
 * "El Nene", "la niña Chole": in Spanish a common noun takes no capital, so one after the article
 * marks a nickname, an honorific or a proper name. English is left alone: "The Little Girl" may be
 * a description in title case.
 */
function spanishNickname(name: string): boolean {
  // "EL NIÑO" in capitals throughout tells nothing about its words.
  if (!/\p{Ll}/u.test(name)) return false;
  const described = wordsOf(name.normalize('NFC')).slice(1);
  const stop = described.findIndex((word) => endsDescription(word.toLowerCase(), 'es'));
  return (stop < 0 ? described : described.slice(0, stop)).some((word) => /^\p{Lu}/u.test(word));
}

/**
 * "the little old man", "his friend’s mother", "Lucy’s grandmother": the head is the last word,
 * after any possessive and before a stop word ("of", "with", "and", "on"…) or a second article.
 */
function englishPhrase(tokens: readonly string[]): Phrase | undefined {
  const determiner = DETERMINER_WORDS.en.has(tokens[0]!);
  const owner = tokens.map((word) => word.endsWith("'s")).lastIndexOf(true);
  if (!determiner && owner < 0) return undefined;
  const rest = untilStop(tokens.slice(Math.max(owner, 0) + 1), 'en');
  const head = rest[rest.length - 1];
  const noun = head === undefined ? undefined : NOUNS.en.get(head);
  // "Lucy’s grandmother" describes someone; "Lucy’s Dog" or "Devil’s Child" may be anything.
  if (!determiner && (rest.length !== 1 || !noun?.kin)) return undefined;
  const adjectives = rest.slice(0, -1);
  // "the forty year old man": the "old" after a count of years tells how old, not that he is old.
  const measured = AGE_UNIT.test(adjectives[adjectives.length - 2] ?? '');
  return {
    noun,
    adjectives,
    beside: measured ? [] : adjectives.slice(-1),
    last: true,
    owned: owner >= 0 || POSSESSIVE_DETERMINERS.en.has(tokens[0]!),
  };
}

/**
 * "la abuela", "el viejo lobo", "la niña pequeña": the head is the first noun of the table after
 * the determiner and before a stop word ("de", "con", "y", "sobre"…) or a second article.
 */
function spanishPhrase(tokens: readonly string[]): Phrase | undefined {
  const determiner = tokens[0]!;
  if (!DETERMINER_WORDS.es.has(determiner)) return undefined;
  const rest = untilStop(tokens.slice(1), 'es');
  const found = rest.map((word) => NOUNS.es.get(word));
  // "el viejo lobo", "la joven princesa": the noun after such a word is the one described.
  let at = found.findIndex((noun) => noun && !noun.adjective);
  if (at < 0) at = found.findIndex((noun) => noun);
  const beside = at < 0 ? [] : [rest[at - 1], rest[at + 1]];
  return {
    noun: found[at],
    adjectives: rest.filter((_, i) => i !== at),
    beside: beside.filter((word) => word !== undefined),
    last: at === rest.length - 1,
    owned: POSSESSIVE_DETERMINERS.es.has(determiner),
    article: DETERMINERS.es[determiner],
  };
}

/** The traits a description gives: those of its head noun, and what the words around it add. */
function phraseTraits(
  { noun, adjectives, beside, last, owned, article }: Phrase,
  lang: Lang,
): Traits {
  let age = noun?.age;
  if (noun?.young && adjectives.some((word) => LITTLE[lang].has(word))) age = 'child';
  const elderly =
    (noun?.grown && beside.some((word) => OLD[lang].has(word))) ||
    // "un viejo amigo" has been a friend for long.
    (noun?.old && last);
  // "my old man" is a father, "mi vieja" a mother.
  if (elderly && !owned) age = 'elder';

  // "his little sister", "the big boy", "la niña pequeña": there they tell the age, not the size.
  const sized = !noun?.kin && !noun?.young;
  const stated = adjectives
    .filter((word) => noun?.species !== undefined || !GREAT.has(word))
    .map((word) => SIZE_WORDS[lang].get(word))
    .find((size) => size !== undefined);
  // "the baby bear", "el oso bebé": not large like its kind; a stated size still counts.
  const youngOne = adjectives.some((word) => YOUNG_ONE[lang].has(word));
  const implied = youngOne && noun?.size === 'large' ? undefined : noun?.size;

  return cleanTraits({
    gender: noun?.gender ?? (noun?.common ? article : undefined),
    age,
    species: noun?.species,
    size: sized ? (stated ?? implied) : undefined,
  });
}

/** What one name gives away. */
function nameTraits(name: string, lang: Lang): Traits {
  const tokens = tokenise(name);
  const first = NOUNS[lang].get(tokens[0] ?? '');
  if (tokens.length < 2) {
    // "Rabbit", "Dragón", "Grandma". "Kid", "Baby", "Bear" and "Mouse" are common nicknames, so
    // a bare word gives no child and no size.
    if (first?.species) return cleanTraits({ gender: first.gender, species: first.species });
    return first?.age === 'elder' ? cleanTraits({ gender: first.gender, age: 'elder' }) : {};
  }
  const phrase = lang === 'en' ? englishPhrase(tokens) : spanishPhrase(tokens);
  if (phrase) {
    const described = phraseTraits(phrase, lang);
    if (lang !== 'es' || !spanishNickname(name)) return described;
    // Like a bare word: "El Nene" may be a grown man, so no child and no size; an elder stays one.
    const age = described.age === 'elder' ? 'elder' : undefined;
    return cleanTraits({ gender: described.gender, species: described.species, age });
  }
  // "Grandma Rose", "Abuela Rosa"; not "Grandma Rose’s cat".
  const owned = tokens.some((word) => word.endsWith("'s"));
  return first?.age === 'elder' && !owned
    ? cleanTraits({ gender: first.gender, age: 'elder' })
    : {};
}

/**
 * Traits a character's names give away ("the old man", "la abuela", "Rabbit"). Each trait comes
 * from the first name that gives it. Only a description is read in full: a name that starts with
 * a determiner ("the little girl", "mi abuela") or is "Name’s" and a kin noun ("Lucy’s
 * grandmother"). A bare single word gives a species or a grandparent ("Rabbit", "Abuela"), and a
 * name led by a word for a grandparent an elder ("Grandma Rose"). Any other name gives nothing
 * ("Mr. Fox", "Michael Wolf", "León Felipe"), and neither does a single word that is a word of
 * another such name in the list ("Fox" beside "Mr. Fox"). In Spanish a capitalised word after the
 * article marks a nickname ("El Nene"), which gives no child and no size. Words are compared
 * whole, in lower case.
 */
export function inferTraits(names: readonly string[], lang: Lang): Traits {
  const tokenised = names.map(tokenise);
  // "Lamb" beside "Jackson Lamb", "León" beside "Teodoro León": a surname or a first name said
  // alone, not a species. A description is no such name: "Rabbit" beside "the little rabbit".
  const partOfName = (word: string): boolean =>
    tokenised.some(
      (other) => other.length > 1 && !DETERMINER_WORDS[lang].has(other[0]!) && other.includes(word),
    );
  let traits: Traits = {};
  names.forEach((name, i) => {
    const tokens = tokenised[i]!;
    if (tokens.length === 1 && partOfName(tokens[0]!)) return;
    traits = fillTraits(traits, nameTraits(name, lang));
  });
  return traits;
}
