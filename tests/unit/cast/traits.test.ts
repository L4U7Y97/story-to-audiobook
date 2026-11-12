import { describe, expect, it } from 'vitest';
import type { Character, Lang, Traits } from '@/format/types';
import { splitUnits } from '@/analysis/units';
import { analyzeHeuristic } from '@/analysis/heuristic';
import {
  TRAIT_KEYS,
  cleanTraits,
  fillTraits,
  hasTraits,
  inferTraits,
  withTraits,
} from '@/cast/traits';
import { baseCast, loadFixture } from '../../helpers/fixtures';

const voice = { lang: 'en-US', pitch: 1, rate: 1 };
const member = (traits: Traits = {}): Character => ({
  id: 'c1',
  role: 'character',
  name: 'Rose',
  aliases: ['Grandma'],
  ...traits,
  voice,
});

/** A member as a hand-edited import may hold it: trait values of any kind. */
const imported = (traits: Record<string, unknown>) => ({ ...member(), ...traits }) as Character;

describe('TRAIT_KEYS', () => {
  it('lists the four traits', () => {
    expect(TRAIT_KEYS).toEqual(['gender', 'age', 'species', 'size']);
  });
});

describe('cleanTraits', () => {
  it('keeps every valid trait value', () => {
    const all = { gender: 'other', age: 'teen', species: 'machine', size: 'large' };
    expect(cleanTraits(all)).toStrictEqual(all);
    expect(
      cleanTraits({ gender: 'female', age: 'elder', species: 'animal', size: 'small' }),
    ).toStrictEqual({ gender: 'female', age: 'elder', species: 'animal', size: 'small' });
  });

  it('takes only the traits of a cast member', () => {
    expect(cleanTraits(member({ gender: 'female', age: 'elder' }))).toStrictEqual({
      gender: 'female',
      age: 'elder',
    });
    expect(cleanTraits(member())).toStrictEqual({});
  });

  it('drops values outside the enums', () => {
    expect(
      cleanTraits({ gender: 'Female', age: 'elderly', species: 'dragon', size: 'average' }),
    ).toStrictEqual({});
    expect(cleanTraits({ gender: 1, age: null, species: ['animal'], size: true })).toStrictEqual(
      {},
    );
    // Names of Object.prototype members are no trait values either.
    expect(cleanTraits({ gender: 'constructor', size: 'toString' })).toStrictEqual({});
    expect(cleanTraits({ gender: 'male', age: 'old', size: 'small' })).toStrictEqual({
      gender: 'male',
      size: 'small',
    });
  });

  it('writes no undefined keys', () => {
    const cleaned = cleanTraits({
      gender: undefined,
      age: 'child',
      species: undefined,
      size: 'big',
    });
    expect(Object.keys(cleaned)).toEqual(['age']);
    expect(cleaned).toStrictEqual({ age: 'child' });
    expect(Object.keys(cleanTraits({ gender: undefined }))).toEqual([]);
  });
});

describe('hasTraits', () => {
  it('is true with any valid trait', () => {
    expect(hasTraits({ gender: 'male' })).toBe(true);
    expect(hasTraits({ age: 'adult' })).toBe(true);
    expect(hasTraits({ species: 'human' })).toBe(true);
    expect(hasTraits({ size: 'large' })).toBe(true);
    expect(hasTraits(member({ size: 'small' }))).toBe(true);
  });

  it('is false with none, with undefined keys and with invalid values', () => {
    expect(hasTraits({})).toBe(false);
    expect(hasTraits(member())).toBe(false);
    expect(hasTraits({ gender: undefined, age: undefined })).toBe(false);
    expect(hasTraits(imported({ age: 'elderly', size: 'huge' }))).toBe(false);
  });
});

describe('withTraits', () => {
  it('sets the given traits on a copy and keeps everything else', () => {
    const rose = member({ gender: 'female' });
    const changed = withTraits(rose, { age: 'elder', size: 'small' });
    expect(changed).toStrictEqual({ ...rose, age: 'elder', size: 'small' });
    expect(changed).not.toBe(rose);
    expect(rose).toStrictEqual(member({ gender: 'female' }));
  });

  it('replaces a trait that is already set', () => {
    expect(withTraits(member({ gender: 'female', age: 'adult' }), { age: 'elder' })).toStrictEqual(
      member({ gender: 'female', age: 'elder' }),
    );
  });

  it('removes a trait given as undefined', () => {
    const rose = member({ gender: 'female', age: 'elder', species: 'human' });
    const changed = withTraits(rose, { age: undefined, species: undefined });
    expect(changed).toStrictEqual(member({ gender: 'female' }));
    expect(Object.keys(changed)).not.toContain('age');
    expect(Object.keys(changed)).not.toContain('species');
    // The original keeps its traits.
    expect(rose.age).toBe('elder');
  });

  it('writes no undefined key for a trait that was never set', () => {
    const changed = withTraits(member(), { gender: undefined, size: undefined });
    expect(changed).toStrictEqual(member());
    expect(Object.keys(changed)).toEqual(Object.keys(member()));
  });

  it('removes a trait given an invalid value', () => {
    const changes = { age: 'elderly', size: 'small' } as unknown as Traits;
    const changed = withTraits(member({ age: 'adult' }), changes);
    expect(changed).toStrictEqual(member({ size: 'small' }));
    expect(Object.keys(changed)).not.toContain('age');
  });

  it('leaves the traits that are not in the changes untouched', () => {
    const rose = member({ gender: 'female', age: 'elder', species: 'human', size: 'small' });
    expect(withTraits(rose, { size: 'large' })).toStrictEqual({ ...rose, size: 'large' });
    expect(withTraits(rose, {})).toStrictEqual(rose);
  });

  it('returns an equal copy, key for key, when nothing changes', () => {
    const rose = member({ gender: 'female', species: 'human' });
    const same = withTraits(rose, cleanTraits(rose));
    expect(same).not.toBe(rose);
    expect(same).toStrictEqual(rose);
    // Same key order too: an imported story stays byte-identical.
    expect(JSON.stringify(same)).toBe(JSON.stringify(rose));
    expect(JSON.stringify(withTraits(rose, {}))).toBe(JSON.stringify(rose));
  });

  it('drops the invalid and undefined trait values the member already holds', () => {
    const dirty = imported({ gender: 'female', age: 'elderly', species: undefined, size: 7 });
    const cleaned = withTraits(dirty, cleanTraits(dirty));
    expect(cleaned).toStrictEqual(member({ gender: 'female' }));
    expect(Object.keys(cleaned).sort()).toEqual(Object.keys(member({ gender: 'female' })).sort());
    expect(withTraits(dirty, {})).toStrictEqual(member({ gender: 'female' }));
    // A valid value given for such a trait takes its place.
    expect(withTraits(dirty, { age: 'elder' })).toStrictEqual(
      member({ gender: 'female', age: 'elder' }),
    );
  });

  it('works on bare traits too', () => {
    expect(withTraits({ gender: 'male' }, { age: 'child', gender: undefined })).toStrictEqual({
      age: 'child',
    });
  });
});

describe('fillTraits', () => {
  it('takes only the missing traits from what was found', () => {
    const rose = member({ gender: 'female', age: 'adult' });
    const filled = fillTraits(rose, {
      gender: 'male',
      age: 'elder',
      species: 'animal',
      size: 'small',
    });
    expect(filled).toStrictEqual({ ...rose, species: 'animal', size: 'small' });
    expect(filled).not.toBe(rose);
    expect(rose).toStrictEqual(member({ gender: 'female', age: 'adult' }));
  });

  it('returns the member itself when nothing is added', () => {
    const rose = member({ gender: 'female', age: 'elder' });
    expect(fillTraits(rose, {})).toBe(rose);
    expect(fillTraits(rose, { gender: 'male', age: 'child' })).toBe(rose);
    expect(fillTraits(rose, { species: undefined, size: undefined })).toBe(rose);
    expect(fillTraits(rose, { species: 'fish' } as unknown as Traits)).toBe(rose);
    const none = member();
    expect(fillTraits(none, {})).toBe(none);
    expect(Object.keys(none)).toEqual(Object.keys(member()));
  });

  it('writes no undefined keys', () => {
    const filled = fillTraits(member(), { gender: undefined, age: 'child', size: undefined });
    expect(filled).toStrictEqual(member({ age: 'child' }));
    expect(Object.keys(filled).sort()).toEqual(Object.keys(member({ age: 'child' })).sort());
  });

  it('counts an invalid value as missing', () => {
    const dirty = imported({ age: 'elderly', gender: 'female' });
    expect(fillTraits(dirty, { age: 'elder', gender: 'male' })).toStrictEqual(
      member({ gender: 'female', age: 'elder' }),
    );
    const undefinedKey = imported({ size: undefined });
    const filled = fillTraits(undefinedKey, { species: 'animal' });
    expect(filled).toStrictEqual(member({ species: 'animal' }));
    expect(Object.keys(filled)).not.toContain('size');
  });

  it('works on bare traits too', () => {
    expect(fillTraits({ gender: 'female' }, { gender: 'male', age: 'elder' })).toStrictEqual({
      gender: 'female',
      age: 'elder',
    });
  });
});

/** Checks the exact object, so an undefined-valued key fails too. */
const expectTraits = (names: string[], lang: Lang, expected: Traits) => {
  const traits = inferTraits(names, lang);
  expect(traits, names.join(' / ')).toStrictEqual(expected);
  expect(Object.keys(traits).sort(), names.join(' / ')).toEqual(Object.keys(expected).sort());
};

describe('inferTraits, English', () => {
  it.each<[string, Traits]>([
    // Pinned by the design.
    ['the old man', { gender: 'male', age: 'elder' }],
    ['the boy’s mother', { gender: 'female' }],
    ['my old friend', {}],
    ['the little girl', { gender: 'female', age: 'child' }],
    ['the girl', { gender: 'female' }],
    ['Lucy’s grandmother', { gender: 'female', age: 'elder' }],
    ['Mr. Fox', {}],
    ['Michael Wolf', {}],
    ['Kid', {}],
    ['Baby', {}],
    ['León Felipe', {}],
    ['Bear', { species: 'animal' }],
    ['Rabbit', { species: 'animal' }],
    ['Grandma', { gender: 'female', age: 'elder' }],
    ['Grandma Rose', { gender: 'female', age: 'elder' }],
    ['Granny Smith', { gender: 'female', age: 'elder' }],
  ])('pins “%s”', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each<[string, Traits]>([
    ['the old woman', { gender: 'female', age: 'elder' }],
    ['the old lady', { gender: 'female', age: 'elder' }],
    ['an old gentleman', { gender: 'male', age: 'elder' }],
    ['the elderly lady', { gender: 'female', age: 'elder' }],
    ['that old man', { gender: 'male', age: 'elder' }],
    ['the man', { gender: 'male' }],
    ['the woman', { gender: 'female' }],
    // "old" tells an age only right before man, woman, lady or gentleman.
    ['the old king', { gender: 'male' }],
    ['the old tall man', { gender: 'male' }],
    ['the old doctor', {}],
    // "my old man" is a father, "his old lady" a wife or a mother.
    ['my old man', { gender: 'male' }],
    ['his old lady', { gender: 'female' }],
    ['the boy’s old man', { gender: 'male' }],
    ['my grandmother', { gender: 'female', age: 'elder' }],
    ['his grandfather', { gender: 'male', age: 'elder' }],
    ['the grandmother', { gender: 'female', age: 'elder' }],
    ['Grandpa', { gender: 'male', age: 'elder' }],
    ['granny', { gender: 'female', age: 'elder' }],
    ['Grandpa Joe', { gender: 'male', age: 'elder' }],
    ['Granddad', { gender: 'male', age: 'elder' }],
  ])('reads the elderly in “%s”', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each<[string, Traits]>([
    ['the child', { age: 'child' }],
    ['the baby', { age: 'child' }],
    ['a toddler', { age: 'child' }],
    ['the infant', { age: 'child' }],
    // Words for teenagers and young adults too: gender only.
    ['the boy', { gender: 'male' }],
    ['the kid', {}],
    ['the lad', { gender: 'male' }],
    ['the lass', { gender: 'female' }],
    // Only "little" makes a child of them.
    ['the little boy', { gender: 'male', age: 'child' }],
    ['the poor little girl', { gender: 'female', age: 'child' }],
    ['the little match girl', { gender: 'female', age: 'child' }],
    ['the little kid', { age: 'child' }],
    ['a small boy', { gender: 'male' }],
    ['the young girl', { gender: 'female' }],
    ['the big boy', { gender: 'male' }],
    // A little child is a young one, not a small one.
    ['the little child', { age: 'child' }],
    ['the tiny baby', { age: 'child' }],
  ])('reads children in “%s”', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each<[string, Traits]>([
    ['the boy’s mother', { gender: 'female' }],
    ["the boy's mother", { gender: 'female' }],
    ['Lucy’s grandmother', { gender: 'female', age: 'elder' }],
    ["Lucy's grandmother", { gender: 'female', age: 'elder' }],
    ['Mrs. Bennet’s daughter', { gender: 'female' }],
    ['Tom’s father', { gender: 'male' }],
    ['his friend’s mother', { gender: 'female' }],
    ['the old man’s wife', { gender: 'female' }],
    ['the king of Spain’s daughter', { gender: 'female' }],
    // Whose it is says nothing about the one named.
    ['the giant’s wife', { gender: 'female' }],
    ['the old man’s dog', { species: 'animal' }],
    // "Name’s …" is a description only before a kin noun.
    ['Lucy’s dog', {}],
    ['Lucy’s old friend', {}],
    ['Lucy’s little girl', {}],
    ['Devil’s Child', {}],
    ['Lucy’s', {}],
  ])('reads past a possessive in “%s”', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each<[string, Traits]>([
    // In a kin phrase "little" and "big" tell the age, not the size.
    ['his little sister', { gender: 'female' }],
    ['her big brother', { gender: 'male' }],
    ['my little brother', { gender: 'male' }],
    ['the mother', { gender: 'female' }],
    ['his wife', { gender: 'female' }],
    ['her husband', { gender: 'male' }],
    ['the king', { gender: 'male' }],
    ['the princess', { gender: 'female' }],
    // A witch is human.
    ['the witch', { gender: 'female' }],
    ['the stranger', {}],
    ['the doctor', {}],
  ])('reads the gender of “%s”', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each<[string, Traits]>([
    ['the dog', { species: 'animal' }],
    ['a fox', { species: 'animal' }],
    ['the mouse', { species: 'animal', size: 'small' }],
    ['the bear', { species: 'animal', size: 'large' }],
    ['the elephant', { species: 'animal', size: 'large' }],
    ['the bee', { species: 'animal', size: 'small' }],
    ['the hen', { species: 'animal', gender: 'female' }],
    ['the rooster', { species: 'animal', gender: 'male' }],
    ['the dragon', { species: 'creature', size: 'large' }],
    ['the giant', { species: 'creature', size: 'large' }],
    ['the fairy', { species: 'creature', size: 'small' }],
    ['the gnome', { species: 'creature', size: 'small' }],
    ['the ghost', { species: 'creature' }],
    ['the mermaid', { species: 'creature', gender: 'female' }],
    ['the unicorn', { species: 'creature' }],
    ['the robot', { species: 'machine' }],
    ['the android', { species: 'machine' }],
    ['the computer', { species: 'machine' }],
    // The words after "of", "with", "in", "from" and "who" describe someone else.
    ['the king of the giants', { gender: 'male' }],
    ['the mouse with the big ears', { species: 'animal', size: 'small' }],
    ['the girl from the dragon cave', { gender: 'female' }],
    ['the man who feeds the bear', { gender: 'male' }],
  ])('reads the species of “%s”', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each<[string, Traits]>([
    ['the little mouse', { species: 'animal', size: 'small' }],
    ['the big mouse', { species: 'animal', size: 'large' }],
    ['the little bear', { species: 'animal', size: 'small' }],
    ['the huge dog', { species: 'animal', size: 'large' }],
    ['the tiny dragon', { species: 'creature', size: 'small' }],
    ['the great dragon', { species: 'creature', size: 'large' }],
    ['the giant spider', { species: 'animal', size: 'large' }],
    ['the enormous robot', { species: 'machine', size: 'large' }],
    ['the big man', { gender: 'male', size: 'large' }],
    ['the tiny woman', { gender: 'female', size: 'small' }],
    ['the little old man', { gender: 'male', age: 'elder', size: 'small' }],
    ['the little fellow', { gender: 'male', size: 'small' }],
    ['the little stranger', { size: 'small' }],
    ['a small voice', { size: 'small' }],
    // A great king is a famous one.
    ['the great king', { gender: 'male' }],
    ['the great detective', {}],
  ])('reads the size of “%s”', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each<[string, Traits]>([
    ['Dragon', { species: 'creature' }],
    ['Giant', { species: 'creature' }],
    ['Mouse', { species: 'animal' }],
    ['Fox', { species: 'animal' }],
    ['rabbit', { species: 'animal' }],
    ['Hen', { species: 'animal', gender: 'female' }],
    ['Mermaid', { species: 'creature', gender: 'female' }],
    ['Robot', { species: 'machine' }],
    // Never an age or a size from a nickname, and no gender from a word for a person.
    ['Child', {}],
    ['Toddler', {}],
    ['Boy', {}],
    ['Girl', {}],
    ['Man', {}],
    ['Witch', {}],
    ['King', {}],
    ['Little', {}],
    ['Lucy', {}],
    ['The', {}],
  ])('reads only a species or a grandparent from the bare word “%s”', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each([
    'Mr. Fox',
    'Mrs. Bear',
    'Michael Wolf',
    'Peter Rabbit',
    'Mother Bear',
    'Baby Bear',
    'Little Bear',
    'Old Tom',
    'Old Mother Hubbard',
    'Lady Catherine',
    'Kid Curry',
    'Fox Mulder',
    'Rose Grandma',
    'Grandma Rose’s cat',
    'León Felipe',
    // An initial is no article.
    'A. Bear',
    '',
    '   ',
  ])('reads nothing from the name “%s”', (name) => {
    expectTraits([name], 'en', {});
  });

  it.each<[string, Traits]>([
    ['The Big Friendly Giant', { species: 'creature', size: 'large' }],
    ['The Mouse', { species: 'animal', size: 'small' }],
    ['the Devil', { species: 'creature' }],
    ['My Fair Lady', { gender: 'female' }],
    ['the Grinch', {}],
  ])('reads a capitalised description like “%s”', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each<[string, Traits]>([
    // What follows "and", "on", "at", "by" or "called" is about someone or something else.
    ['the old man and his wife', { gender: 'male', age: 'elder' }],
    ['the king and queen', { gender: 'male' }],
    ['the girl and her dog', { gender: 'female' }],
    ['the man on the horse', { gender: 'male' }],
    ['the man at the door', { gender: 'male' }],
    ['the old woman at the window', { gender: 'female', age: 'elder' }],
    ['the woman by the old man', { gender: 'female' }],
    ['a man called Horse', { gender: 'male' }],
    ['the knight on the horse', {}],
    // A second article ends the description too: the head is then a word nobody knows.
    ['the man holding the baby', {}],
    ['the woman carrying a child', {}],
    ['the nurse holding the baby', {}],
    ['the boy riding the dragon', {}],
    ['the man beside the old lady', {}],
  ])('stops at the end of what “%s” says about its head', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each<[string, Traits]>([
    // A young one of a large kind is not large.
    ['the baby bear', { species: 'animal' }],
    ['the baby elephant', { species: 'animal' }],
    ['the baby dragon', { species: 'creature' }],
    ['the young giant', { species: 'creature' }],
    ['the newborn whale', { species: 'animal' }],
    // A size that is stated still counts, and so does a small kind.
    ['the big baby bear', { species: 'animal', size: 'large' }],
    ['the little baby bear', { species: 'animal', size: 'small' }],
    ['the baby mouse', { species: 'animal', size: 'small' }],
    ['the little bear', { species: 'animal', size: 'small' }],
    ['the bear', { species: 'animal', size: 'large' }],
  ])('gives the young one in “%s” no size of its kind', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it.each<[string, Traits]>([
    ['the middle aged man', { gender: 'male' }],
    ['the middle-aged man', { gender: 'male' }],
    ['the aged man', { gender: 'male' }],
    // "old" after a count of years tells how old, not that someone is old.
    ['the forty year old man', { gender: 'male' }],
    ['the forty-year old man', { gender: 'male' }],
    ['the forty-year-old man', { gender: 'male' }],
    ['a thirty years old woman', { gender: 'female' }],
    ['the six month old lady', { gender: 'female' }],
    ['the old man', { gender: 'male', age: 'elder' }],
    ['the little old man', { gender: 'male', age: 'elder', size: 'small' }],
  ])('reads no elder from an age in years in “%s”', (name, expected) => {
    expectTraits([name], 'en', expected);
  });

  it('compares whole words in lower case, whatever the spacing and punctuation', () => {
    expectTraits(['The Old Man'], 'en', { gender: 'male', age: 'elder' });
    expectTraits(['THE LITTLE GIRL'], 'en', { gender: 'female', age: 'child' });
    expectTraits(['  the   old  man '], 'en', { gender: 'male', age: 'elder' });
    expectTraits(['“the old man,”'], 'en', { gender: 'male', age: 'elder' });
    expectTraits(['GRANDMA'], 'en', { gender: 'female', age: 'elder' });
    // No stemming and no partial words.
    expectTraits(['the dogs'], 'en', {});
    expectTraits(['the catfish'], 'en', {});
    expectTraits(['the mans'], 'en', {});
    expectTraits(['Grandmaster'], 'en', {});
  });

  it('reads the curly and the straight apostrophe alike', () => {
    for (const apostrophe of ['’', "'"]) {
      expectTraits([`Lucy${apostrophe}s grandmother`], 'en', { gender: 'female', age: 'elder' });
      expectTraits([`the boy${apostrophe}s mother`], 'en', { gender: 'female' });
      expectTraits([`the witch${apostrophe}s cat`], 'en', { species: 'animal' });
    }
  });

  it('does not read Spanish descriptions in an English story', () => {
    expectTraits(['la abuela'], 'en', {});
    expectTraits(['Abuela'], 'en', {});
    expectTraits(['el lobo'], 'en', {});
  });
});

describe('inferTraits, Spanish', () => {
  it.each<[string, Traits]>([
    // Pinned by the design.
    ['la abuela', { gender: 'female', age: 'elder' }],
    ['mi abuela', { gender: 'female', age: 'elder' }],
    ['mi viejo', { gender: 'male' }],
    ['Abuela', { gender: 'female', age: 'elder' }],
    ['Abuela Rosa', { gender: 'female', age: 'elder' }],
    ['Dragón', { species: 'creature' }],
    ['León Felipe', {}],
  ])('pins “%s”', (name, expected) => {
    expectTraits([name], 'es', expected);
  });

  it.each<[string, Traits]>([
    ['el abuelo', { gender: 'male', age: 'elder' }],
    ['su abuelo', { gender: 'male', age: 'elder' }],
    ['la abuelita', { gender: 'female', age: 'elder' }],
    ['abuelito', { gender: 'male', age: 'elder' }],
    ['la abuela Rosa', { gender: 'female', age: 'elder' }],
    ['la abuela de Lucía', { gender: 'female', age: 'elder' }],
    ['Abuelo Paco', { gender: 'male', age: 'elder' }],
    ['el viejo', { gender: 'male', age: 'elder' }],
    ['la vieja', { gender: 'female', age: 'elder' }],
    ['un anciano', { gender: 'male', age: 'elder' }],
    ['la anciana', { gender: 'female', age: 'elder' }],
    ['una anciana', { gender: 'female', age: 'elder' }],
    ['el pobre viejo', { gender: 'male', age: 'elder' }],
    ['el viejo de la montaña', { gender: 'male', age: 'elder' }],
    // "mi viejo" and "su vieja" are a father and a mother.
    ['su vieja', { gender: 'female' }],
    ['mi anciano', { gender: 'male' }],
    // "un viejo amigo" has known someone for long.
    ['un viejo amigo', { gender: 'male' }],
    ['el viejo pescador', { gender: 'male' }],
    // Old right before or after hombre, mujer, señor or señora.
    ['el hombre viejo', { gender: 'male', age: 'elder' }],
    ['el viejo hombre', { gender: 'male', age: 'elder' }],
    ['la anciana señora', { gender: 'female', age: 'elder' }],
    ['la mujer anciana', { gender: 'female', age: 'elder' }],
    ['el señor', { gender: 'male' }],
    ['la mujer', { gender: 'female' }],
    // Not before other nouns: the noun after it is the person.
    ['la vieja bruja', { gender: 'female' }],
    ['el anciano rey', { gender: 'male' }],
    ['el viejo lobo', { gender: 'male', species: 'animal' }],
    // A bare word is a grandparent, never just someone old.
    ['Viejo', {}],
    ['Anciana', {}],
  ])('reads the elderly in “%s”', (name, expected) => {
    expectTraits([name], 'es', expected);
  });

  it.each<[string, Traits]>([
    ['el niño', { gender: 'male', age: 'child' }],
    ['la niña', { gender: 'female', age: 'child' }],
    ['la nena', { gender: 'female', age: 'child' }],
    ['el nene', { gender: 'male', age: 'child' }],
    ['el bebé', { age: 'child' }],
    ['la niña pequeña', { gender: 'female', age: 'child' }],
    ['la niña del dragón', { gender: 'female', age: 'child' }],
    // Words for teenagers and young adults too: gender only.
    ['el chico', { gender: 'male' }],
    ['la chica', { gender: 'female' }],
    ['el muchacho', { gender: 'male' }],
    ['la muchacha', { gender: 'female' }],
    ['el mozo', { gender: 'male' }],
    ['la moza', { gender: 'female' }],
    // "joven" takes its gender from the article.
    ['el joven', { gender: 'male' }],
    ['la joven', { gender: 'female' }],
    ['una joven', { gender: 'female' }],
    ['mi joven', {}],
    ['la joven princesa', { gender: 'female' }],
    // Only "pequeño" makes a child of them.
    ['la pequeña muchacha', { gender: 'female', age: 'child' }],
    ['el chico pequeño', { gender: 'male', age: 'child' }],
    ['el chico grande', { gender: 'male' }],
    // Never from a nickname.
    ['Niño', {}],
    ['Nena', {}],
    ['Bebé', {}],
    ['Chico', {}],
  ])('reads children in “%s”', (name, expected) => {
    expectTraits([name], 'es', expected);
  });

  it.each<[string, Traits]>([
    ['el lobo', { gender: 'male', species: 'animal' }],
    ['la loba', { gender: 'female', species: 'animal' }],
    ['la zorra', { gender: 'female', species: 'animal' }],
    ['el gato', { gender: 'male', species: 'animal' }],
    ['la gallina', { gender: 'female', species: 'animal' }],
    ['el gallo', { gender: 'male', species: 'animal' }],
    ['la yegua', { gender: 'female', species: 'animal' }],
    // A noun with one form for both sexes gives no gender, whatever its article.
    ['la liebre', { species: 'animal' }],
    ['la rana', { species: 'animal' }],
    ['el sapo', { species: 'animal' }],
    ['la serpiente', { species: 'animal' }],
    ['el ratón', { species: 'animal', size: 'small' }],
    ['la hormiga', { species: 'animal', size: 'small' }],
    ['el oso', { gender: 'male', species: 'animal', size: 'large' }],
    ['el elefante', { species: 'animal', size: 'large' }],
    ['el dragón', { species: 'creature', size: 'large' }],
    ['el gigante', { species: 'creature', size: 'large' }],
    ['el gigante egoísta', { species: 'creature', size: 'large' }],
    ['el hada', { species: 'creature', size: 'small' }],
    ['el fantasma', { species: 'creature' }],
    ['la sirena', { gender: 'female', species: 'creature' }],
    ['el unicornio', { species: 'creature' }],
    ['el robot', { species: 'machine' }],
    ['la máquina', { species: 'machine' }],
    ['el ordenador', { species: 'machine' }],
    // The words after "de", "del", "con", "que" and "en" describe someone else.
    ['el rey de los gigantes', { gender: 'male' }],
    ['la mujer del oso', { gender: 'female' }],
    ['el hombre que cuida al león', { gender: 'male' }],
    ['la niña con el perro', { gender: 'female', age: 'child' }],
    // A witch is human.
    ['la bruja', { gender: 'female' }],
  ])('reads the species of “%s”', (name, expected) => {
    expectTraits([name], 'es', expected);
  });

  it.each<[string, Traits]>([
    ['el perro pequeño', { gender: 'male', species: 'animal', size: 'small' }],
    ['el pequeño perro', { gender: 'male', species: 'animal', size: 'small' }],
    ['el ratón enorme', { species: 'animal', size: 'large' }],
    ['el gran oso', { gender: 'male', species: 'animal', size: 'large' }],
    ['el lobo grande', { gender: 'male', species: 'animal', size: 'large' }],
    ['el dragón diminuto', { species: 'creature', size: 'small' }],
    ['el oso gigante', { gender: 'male', species: 'animal', size: 'large' }],
    ['el hombre enorme', { gender: 'male', size: 'large' }],
    ['la mujer diminuta', { gender: 'female', size: 'small' }],
    // "gran" before a person is "great".
    ['el gran rey', { gender: 'male' }],
    ['la gran señora', { gender: 'female' }],
    // With a brother or a sister "pequeño" tells the age.
    ['su hermana pequeña', { gender: 'female' }],
    ['mi hermano grande', { gender: 'male' }],
  ])('reads the size of “%s”', (name, expected) => {
    expectTraits([name], 'es', expected);
  });

  it.each<[string, Traits]>([
    ['Gata', { gender: 'female', species: 'animal' }],
    ['Lobo', { gender: 'male', species: 'animal' }],
    ['Conejo', { gender: 'male', species: 'animal' }],
    ['Liebre', { species: 'animal' }],
    // No size from a nickname.
    ['Ratón', { species: 'animal' }],
    ['Oso', { gender: 'male', species: 'animal' }],
    ['Gigante', { species: 'creature' }],
    ['Hada', { species: 'creature' }],
    ['Sirena', { gender: 'female', species: 'creature' }],
    ['Robot', { species: 'machine' }],
    ['Bruja', {}],
    ['Rey', {}],
    ['Remedios', {}],
  ])('reads only a species or a grandparent from the bare word “%s”', (name, expected) => {
    expectTraits([name], 'es', expected);
  });

  it.each([
    'León Felipe',
    'Don León',
    'doña Remedios',
    'Julián',
    'la Nela',
    'Lobo Pérez',
    'Tío Conejo',
    'Rosa Abuela',
    '',
  ])('reads nothing from the name “%s”', (name) => {
    expectTraits([name], 'es', {});
  });

  it.each<[string, Traits]>([
    // What follows "y", "a", "junto a" or "sobre" is about someone or something else.
    ['la vieja y el lobo', { gender: 'female', age: 'elder' }],
    ['el viejo y la niña', { gender: 'male', age: 'elder' }],
    ['el niño y su perro', { gender: 'male', age: 'child' }],
    ['el hombre sobre el caballo', { gender: 'male' }],
    ['la mujer junto al niño', { gender: 'female' }],
    // The head is a word nobody knows, so the noun after it is not taken for it.
    ['el guardia junto a la niña', {}],
    ['la enfermera junto al bebé', {}],
    ['el jinete a caballo', {}],
    ['el desconocido sobre el caballo', {}],
    ['el soldado sobre el dragón', {}],
    ['el pastor y su perro', {}],
    ['el capitán y su perro', {}],
  ])('stops at the end of what “%s” says about its head', (name, expected) => {
    expectTraits([name], 'es', expected);
  });

  it.each<[string, Traits]>([
    // A capital after the article marks a nickname or an honorific: no child and no size.
    ['El Nene', { gender: 'male' }],
    ['la Nena', { gender: 'female' }],
    ['El Niño', { gender: 'male' }],
    ['la niña Chole', { gender: 'female' }],
    ['el niño Goyito', { gender: 'male' }],
    ['“la Nena”', { gender: 'female' }],
    ['El Oso', { gender: 'male', species: 'animal' }],
    ['el Ratón', { species: 'animal' }],
    ['el Gigante', { species: 'creature' }],
    // An elder stays one.
    ['la abuela Rosa', { gender: 'female', age: 'elder' }],
    ['La Abuela', { gender: 'female', age: 'elder' }],
    ['el Viejo', { gender: 'male', age: 'elder' }],
    // Lower-case words are a description, and so is a capital after "de".
    ['El niño', { gender: 'male', age: 'child' }],
    ['la nena', { gender: 'female', age: 'child' }],
    ['la niña pequeña', { gender: 'female', age: 'child' }],
    ['la niña de Lucía', { gender: 'female', age: 'child' }],
    ['el oso', { gender: 'male', species: 'animal', size: 'large' }],
    // A name in capitals throughout tells nothing about its words.
    ['EL NIÑO', { gender: 'male', age: 'child' }],
    ['EL OSO', { gender: 'male', species: 'animal', size: 'large' }],
  ])('reads a capitalised word after the article in “%s” as a nickname', (name, expected) => {
    expectTraits([name], 'es', expected);
  });

  it('reads a title-cased description in English as before', () => {
    expectTraits(['The Little Girl'], 'en', { gender: 'female', age: 'child' });
    expectTraits(['The Bear'], 'en', { species: 'animal', size: 'large' });
  });

  it.each<[string, Traits]>([
    ['el oso bebé', { gender: 'male', species: 'animal' }],
    ['el joven oso', { gender: 'male', species: 'animal' }],
    ['el elefante bebé', { species: 'animal' }],
    ['el joven dragón', { species: 'creature' }],
    ['el gran oso bebé', { gender: 'male', species: 'animal', size: 'large' }],
    ['el ratón bebé', { species: 'animal', size: 'small' }],
    ['el oso', { gender: 'male', species: 'animal', size: 'large' }],
  ])('gives the young one in “%s” no size of its kind', (name, expected) => {
    expectTraits([name], 'es', expected);
  });

  it('reads decomposed (NFD) letters like composed ones', () => {
    // Built here, so no editor or formatter can compose the letters again.
    const nfd = (name: string) => name.normalize('NFD');
    expect(nfd('niño')).not.toBe('niño');
    expect(nfd('niño')).toHaveLength(5);
    expectTraits([nfd('el niño')], 'es', { gender: 'male', age: 'child' });
    expectTraits([nfd('la niña')], 'es', { gender: 'female', age: 'child' });
    expectTraits([nfd('Dragón')], 'es', { species: 'creature' });
    expectTraits([nfd('el ratón')], 'es', { species: 'animal', size: 'small' });
    expectTraits([nfd('la máquina')], 'es', { species: 'machine' });
    expectTraits([nfd('Abuela Lucía'), nfd('el perro pequeño')], 'es', {
      gender: 'female',
      age: 'elder',
      species: 'animal',
      size: 'small',
    });
    expectTraits([nfd('León Felipe')], 'es', {});
  });

  it('compares whole words in lower case', () => {
    expectTraits(['La Abuela'], 'es', { gender: 'female', age: 'elder' });
    expectTraits(['EL NIÑO'], 'es', { gender: 'male', age: 'child' });
    expectTraits(['ABUELA'], 'es', { gender: 'female', age: 'elder' });
    // "al" and "del" are articles too.
    expectTraits(['al anciano'], 'es', { gender: 'male', age: 'elder' });
    // No stemming and no partial words.
    expectTraits(['los lobos'], 'es', {});
    expectTraits(['la abuelastra'], 'es', {});
    // An unaccented "raton" is another word.
    expectTraits(['el raton'], 'es', {});
  });

  it('does not read English descriptions in a Spanish story', () => {
    expectTraits(['the old man'], 'es', {});
    expectTraits(['Grandma'], 'es', {});
    expectTraits(['Rabbit'], 'es', {});
  });
});

describe('inferTraits over several names', () => {
  it('reads nothing from no names', () => {
    expectTraits([], 'en', {});
    expectTraits([], 'es', {});
  });

  it('takes each trait from the first name that gives it', () => {
    expectTraits(['Rose', 'the old woman'], 'en', { gender: 'female', age: 'elder' });
    expectTraits(['the girl', 'the old man'], 'en', { gender: 'female', age: 'elder' });
    expectTraits(['the old man', 'the little girl'], 'en', { gender: 'male', age: 'elder' });
    expectTraits(['Rabbit', 'the little rabbit', 'the big rabbit'], 'en', {
      species: 'animal',
      size: 'small',
    });
    expectTraits(['Remedios', 'doña Remedios', 'la abuela', 'el viejo'], 'es', {
      gender: 'female',
      age: 'elder',
    });
    expectTraits(['Dragón', 'el lobo'], 'es', { gender: 'male', species: 'creature' });
  });

  it.each<[string[], Lang]>([
    [['Jackson Lamb', 'Lamb'], 'en'],
    [['Mr. Fox', 'Fox'], 'en'],
    [['Michael Wolf', 'Wolf'], 'en'],
    [['Dr. Lamb', 'Lamb'], 'en'],
    [['Fox', 'Mr. Fox'], 'en'],
    [['Fox Mulder', 'Fox', 'FOX'], 'en'],
    [['Mr. Fox', '“Fox,”'], 'en'],
    [['Teodoro León', 'León'], 'es'],
    [['don León', 'León'], 'es'],
    [['Pedro Cordero', 'Cordero'], 'es'],
    [['Teodoro León'.normalize('NFD'), 'León'], 'es'],
  ])('reads no species from a word of a longer name said alone: %j', (names, lang) => {
    expectTraits(names, lang, {});
  });

  it('still reads a bare word beside a description or an unrelated name', () => {
    expectTraits(['Fox'], 'en', { species: 'animal' });
    expectTraits(['Rabbit', 'the little rabbit'], 'en', { species: 'animal', size: 'small' });
    expectTraits(['Bear', 'the bear'], 'en', { species: 'animal', size: 'large' });
    expectTraits(['the old fox', 'Fox'], 'en', { species: 'animal' });
    // "Bear" is read: the description is no name it could be part of.
    expectTraits(['Bear', 'the bear’s friend'], 'en', { species: 'animal' });
    expectTraits(['Rose', 'Grandma'], 'en', { gender: 'female', age: 'elder' });
    expectTraits(['Grandma Rose', 'Grandma'], 'en', { gender: 'female', age: 'elder' });
    expectTraits(['Fox', 'Reynard', 'Mr. Reynard'], 'en', { species: 'animal' });
    expectTraits(['Lobo', 'el lobo feroz'], 'es', { gender: 'male', species: 'animal' });
    expectTraits(['Abuela Rosa', 'Abuela'], 'es', { gender: 'female', age: 'elder' });
    expectTraits(['León', 'el león'], 'es', { gender: 'male', species: 'animal' });
  });

  it('accepts a read-only list and leaves it alone', () => {
    const names = Object.freeze(['Bear', 'the bear']);
    expect(inferTraits(names, 'en')).toStrictEqual({ species: 'animal', size: 'large' });
    expect(names).toEqual(['Bear', 'the bear']);
  });

  it('returns only valid traits', () => {
    const traits = inferTraits(['the little old man', 'the dragon'], 'en');
    expect(cleanTraits(traits)).toStrictEqual(traits);
    expect(hasTraits(traits)).toBe(true);
    expect(hasTraits(inferTraits(['Mr. Fox'], 'en'))).toBe(false);
  });
});

describe('inferTraits on a very long name', () => {
  /** The time `run` takes, in milliseconds. */
  const timed = (run: () => void): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };

  it.each<[string, string, Lang, Traits]>([
    ['punctuation inside one word', `a${'!'.repeat(50_000)}a`, 'en', {}],
    ['punctuation inside a word of a description', `the bear${'!'.repeat(50_000)}s`, 'en', {}],
    ['punctuation and full stops', `la ${'!.'.repeat(25_000)}a`, 'es', {}],
    [
      'quotes around a description',
      `${'“'.repeat(25_000)}the old man${'”'.repeat(25_000)}`,
      'en',
      { gender: 'male', age: 'elder' },
    ],
    [
      'quotes around a nickname',
      `${'¡'.repeat(25_000)}El Nene${'!'.repeat(25_000)}`,
      'es',
      { gender: 'male' },
    ],
    ['many words', 'the old man '.repeat(4_000), 'en', { gender: 'male', age: 'elder' }],
  ])('reads %s of 50,000 characters in well under half a second', (_, name, lang, expected) => {
    expect(name.length).toBeGreaterThanOrEqual(48_000);
    let traits: Traits | undefined;
    const elapsed = timed(() => {
      traits = inferTraits([name], lang);
    });
    expect(traits).toStrictEqual(expected);
    expect(elapsed).toBeLessThan(500);
  });

  it('strips the same punctuation as before', () => {
    expectTraits(['“the old man,”'], 'en', { gender: 'male', age: 'elder' });
    expectTraits(['(the bear!)'], 'en', { species: 'animal', size: 'large' });
    expectTraits(['the bear!?…'], 'en', { species: 'animal', size: 'large' });
    expectTraits(['¡Dragón!'], 'es', { species: 'creature' });
    expectTraits(['«la abuela»'], 'es', { gender: 'female', age: 'elder' });
    // Punctuation inside a word keeps it another word, and a full stop stays at its end.
    expectTraits(['the be!ar'], 'en', {});
    expectTraits(['Bear.'], 'en', {});
    expectTraits(['A. Bear'], 'en', {});
    expectTraits(['the bear.!'], 'en', {});
    expectTraits(['!', '...', '’', '“”'], 'en', {});
  });
});

describe('inferTraits on the names the free analyser gives', () => {
  it('reads the grandmother of the first-person Spanish fixture', () => {
    const { text, labels } = loadFixture('es/abuela');
    const result = analyzeHeuristic({
      text,
      lang: labels.lang,
      units: splitUnits(text, labels.lang),
      cast: baseCast(labels.lang),
    });
    const traits = Object.fromEntries(
      result.newCharacters.map((c) => [c.name, inferTraits([c.name, ...c.aliases], labels.lang)]),
    );
    expect(traits).toStrictEqual({
      'una voz': {},
      'Doña Remedios': {},
      Julián: {},
      'mi abuela': { gender: 'female', age: 'elder' },
    });
  });

  it('reads the unnamed speakers of an English passage', () => {
    const text =
      '“Who is there?” asked the old man.\n\n' +
      '“Only me,” said the little girl.\n\n' +
      '“Come in, then,” said the old man.\n\n' +
      '“Thank you,” said the little girl.\n';
    const result = analyzeHeuristic({
      text,
      lang: 'en',
      units: splitUnits(text, 'en'),
      cast: baseCast('en'),
    });
    const traits = Object.fromEntries(
      result.newCharacters.map((c) => [c.name, inferTraits([c.name, ...c.aliases], 'en')]),
    );
    expect(traits).toStrictEqual({
      'the old man': { gender: 'male', age: 'elder' },
      'the little girl': { gender: 'female', age: 'child' },
    });
  });
});
