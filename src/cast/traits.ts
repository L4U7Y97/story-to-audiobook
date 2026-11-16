import { AGE_GROUPS, GENDERS, SIZES, SPECIES } from '@/format/types';
import type { Size, Traits } from '@/format/types';
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
  /** A family word ("sister"): "little" and "big" before it tell the age. */
  kin?: true;
  /** A word for someone young ("boy"): a child only with "little". */
  young?: true;
  /** A plain word for an adult ("man"): elderly with "old" right beside it. */
  grown?: true;
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

// Words that are also common first names or nicknames stay out of these lists ("Robin", "Kitty"),
// and so does "kid": a bare word is read as a species (see inferTraits).
const NOUNS = nouns(
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
);

/** First words of a description rather than a name ("the old man"). */
const DETERMINER_WORDS: ReadonlySet<string> = DETERMINERS;

/**
 * Words that end what a description says about its head: "the king of the giants", "the old man
 * and his wife".
 */
const STOP_WORDS = words('of with in from who and or on at by called named');

const sizes = (small: string, large: string): ReadonlyMap<string, Size> =>
  new Map<string, Size>([
    ...[...words(small)].map((word) => [word, 'small'] as const),
    ...[...words(large)].map((word) => [word, 'large'] as const),
  ]);

/** Adjectives that tell a size. */
const SIZE_WORDS = sizes('little tiny small', 'big huge giant enormous great large gigantic');

/** "the great king": of a person it means famous, not large. */
const GREAT = words('great');

/** The one adjective that makes a child of a boy or a girl. */
const LITTLE = words('little');

/** Adjectives for the young of a kind: "the baby bear" is not as large as a bear. */
const YOUNG_ONE = words('baby young newborn infant');

/** Adjectives that make an elder of a man or a woman; not "aged", as in "the middle aged man". */
const OLD = words('old elderly');

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
  /** "my old man", "the boy’s mother": it says whose the person is. */
  owned: boolean;
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
function endsDescription(word: string): boolean {
  // A second article starts someone or something else: "the man holding the baby".
  return STOP_WORDS.has(word) || DETERMINER_WORDS.has(word);
}

/** The words about the head, given those after the determiner or the possessive. */
function untilStop(tokens: readonly string[]): readonly string[] {
  const stop = tokens.findIndex((word) => endsDescription(word));
  return stop < 0 ? tokens : tokens.slice(0, stop);
}

/**
 * "the little old man", "his friend’s mother", "Lucy’s grandmother": the head is the last word,
 * after any possessive and before a stop word ("of", "with", "and", "on"…) or a second article.
 */
function englishPhrase(tokens: readonly string[]): Phrase | undefined {
  const determiner = DETERMINER_WORDS.has(tokens[0]!);
  const owner = tokens.map((word) => word.endsWith("'s")).lastIndexOf(true);
  if (!determiner && owner < 0) return undefined;
  const rest = untilStop(tokens.slice(Math.max(owner, 0) + 1));
  const head = rest[rest.length - 1];
  const noun = head === undefined ? undefined : NOUNS.get(head);
  // "Lucy’s grandmother" describes someone; "Lucy’s Dog" or "Devil’s Child" may be anything.
  if (!determiner && (rest.length !== 1 || !noun?.kin)) return undefined;
  const adjectives = rest.slice(0, -1);
  // "the forty year old man": the "old" after a count of years tells how old, not that he is old.
  const measured = AGE_UNIT.test(adjectives[adjectives.length - 2] ?? '');
  return {
    noun,
    adjectives,
    beside: measured ? [] : adjectives.slice(-1),
    owned: owner >= 0 || POSSESSIVE_DETERMINERS.has(tokens[0]!),
  };
}

/** The traits a description gives: those of its head noun, and what the words around it add. */
function phraseTraits({ noun, adjectives, beside, owned }: Phrase): Traits {
  let age = noun?.age;
  if (noun?.young && adjectives.some((word) => LITTLE.has(word))) age = 'child';
  const elderly = noun?.grown && beside.some((word) => OLD.has(word));
  // "my old man" is a father.
  if (elderly && !owned) age = 'elder';

  // "his little sister", "the big boy": there they tell the age, not the size.
  const sized = !noun?.kin && !noun?.young;
  const stated = adjectives
    .filter((word) => noun?.species !== undefined || !GREAT.has(word))
    .map((word) => SIZE_WORDS.get(word))
    .find((size) => size !== undefined);
  // "the baby bear": not large like its kind; a stated size still counts.
  const youngOne = adjectives.some((word) => YOUNG_ONE.has(word));
  const implied = youngOne && noun?.size === 'large' ? undefined : noun?.size;

  return cleanTraits({
    gender: noun?.gender,
    age,
    species: noun?.species,
    size: sized ? (stated ?? implied) : undefined,
  });
}

/** What one name gives away. */
function nameTraits(name: string): Traits {
  const tokens = tokenise(name);
  const first = NOUNS.get(tokens[0] ?? '');
  if (tokens.length < 2) {
    // "Rabbit", "Grandma". "Kid", "Baby", "Bear" and "Mouse" are common nicknames, so a bare word
    // gives no child and no size.
    if (first?.species) return cleanTraits({ gender: first.gender, species: first.species });
    return first?.age === 'elder' ? cleanTraits({ gender: first.gender, age: 'elder' }) : {};
  }
  const phrase = englishPhrase(tokens);
  if (phrase) return phraseTraits(phrase);
  // "Grandma Rose"; not "Grandma Rose’s cat".
  const owned = tokens.some((word) => word.endsWith("'s"));
  return first?.age === 'elder' && !owned
    ? cleanTraits({ gender: first.gender, age: 'elder' })
    : {};
}

/**
 * Traits a character's names give away ("the old man", "Rabbit"). Each trait comes from the first
 * name that gives it. Only a description is read in full: a name that starts with a determiner
 * ("the little girl") or is "Name’s" and a kin noun ("Lucy’s grandmother"). A bare single word
 * gives a species or a grandparent ("Rabbit", "Grandma"), and a name led by a word for a
 * grandparent an elder ("Grandma Rose"). Any other name gives nothing ("Mr. Fox", "Michael Wolf"),
 * and neither does a single word that is a word of another such name in the list ("Fox" beside
 * "Mr. Fox"). Words are compared whole, in lower case.
 */
export function inferTraits(names: readonly string[]): Traits {
  const tokenised = names.map(tokenise);
  // "Lamb" beside "Jackson Lamb": a surname or a first name said alone, not a species. A
  // description is no such name: "Rabbit" beside "the little rabbit".
  const partOfName = (word: string): boolean =>
    tokenised.some(
      (other) => other.length > 1 && !DETERMINER_WORDS.has(other[0]!) && other.includes(word),
    );
  let traits: Traits = {};
  names.forEach((name, i) => {
    const tokens = tokenised[i]!;
    if (tokens.length === 1 && partOfName(tokens[0]!)) return;
    traits = fillTraits(traits, nameTraits(name));
  });
  return traits;
}
