import { describe, expect, it } from 'vitest';
import type { Character } from '@/format/types';
import { pairKey, suggestMerges } from '@/cast/suggestMerges';

const voice = { lang: 'en-US', pitch: 1, rate: 1 };
const member = (name: string, aliases: string[] = [], role: Character['role'] = 'character') => ({
  id: name,
  role,
  name,
  aliases,
  voice,
});
/** Suggestions for a cast of these names, read as "from → into: reason". */
function suggested(names: Array<string | Character>, lines: Record<string, number> = {}) {
  const cast = names.map((n) => (typeof n === 'string' ? member(n) : n));
  return suggestMerges(cast, new Map(Object.entries(lines))).map(
    (s) => `${s.fromId} → ${s.intoId}: ${s.reason}`,
  );
}

describe('suggestMerges', () => {
  it('pairs a name with the same name and a title, but not two titles or a family title', () => {
    expect(suggested(['Mr. Darcy', 'Darcy'], { 'Mr. Darcy': 9, Darcy: 1 })).toEqual([
      'Darcy → Mr. Darcy: “Mr. Darcy” and “Darcy” differ only by a title',
    ]);
    expect(suggested(['Mr. Bennet', 'Mrs. Bennet'])).toEqual([]);
    // "Miss Bingley" may be Bingley's sister.
    expect(suggested(['Bingley', 'Miss Bingley'])).toEqual([]);
  });

  it('knows common nicknames, with or without the rest of the name', () => {
    expect(suggested(['Robert', 'Bob'], { Robert: 5 })).toEqual([
      'Bob → Robert: “Bob” can be short for “Robert”',
    ]);
    expect(suggested(['Elizabeth Bennet', 'Lizzy'], { 'Elizabeth Bennet': 5 })).toEqual([
      'Lizzy → Elizabeth Bennet: “Lizzy” can be short for “Elizabeth Bennet”',
    ]);
    // Another family name is another person.
    expect(suggested(['Robert Smith', 'Bob Jones'])).toEqual([]);
  });

  it('pairs a lone first or last name with a full name, but not two full names', () => {
    expect(suggested(['Jonathan Harker', 'Harker'], { 'Jonathan Harker': 3 })).toEqual([
      'Harker → Jonathan Harker: “Harker” may be “Jonathan Harker”',
    ]);
    expect(suggested(['Jonathan Harker', 'Mina Harker'])).toEqual([]);
  });

  it('catches a one-letter misspelling of a long enough name', () => {
    expect(suggested(['Hermione', 'Hermoine'], { Hermione: 4 })).toEqual([
      'Hermoine → Hermione: “Hermione” and “Hermoine” are spelled almost alike',
    ]);
    expect(suggested(['Bennet', 'Bennett'], { Bennett: 2 })).toEqual([
      'Bennet → Bennett: “Bennet” and “Bennett” are spelled almost alike',
    ]);
    // Short names a letter apart are usually two people.
    expect(suggested(['Jane', 'Jade'])).toEqual([]);
  });

  it('looks at other names too, and merges the less heard into the more heard', () => {
    expect(
      suggested([member('the stranger', ['Mr. Holmes']), 'Holmes'], {
        Holmes: 10,
        'the stranger': 2,
      }),
    ).toEqual(['the stranger → Holmes: “Mr. Holmes” and “Holmes” differ only by a title']);
  });

  it('leaves out the narrator, the unknown speaker and pairs said not to be the same', () => {
    expect(suggested([member('Watson', [], 'narrator'), 'Mr. Watson'])).toEqual([]);
    const cast = [member('Robert'), member('Bob')];
    expect(suggestMerges(cast, new Map(), new Set([pairKey('Bob', 'Robert')]))).toEqual([]);
  });

  it('keeps relatives apart as the analysers do', () => {
    // "Harker" could be Jonathan or Mina: no guess.
    expect(suggested(['Harker', 'Jonathan Harker', 'Mina Harker'], { Harker: 5 })).toEqual([]);
    // "Harker" known as "Jonathan Harker" is not "Mina Harker".
    expect(suggested([member('Harker', ['Jonathan Harker']), 'Mina Harker'])).toEqual([]);
    // "Bennet" is Mr. Bennet's other name: he is not Jane.
    expect(suggested([member('Mr. Bennet', ['Bennet']), 'Jane Bennet'])).toEqual([]);
    // Sisters a letter apart are two people; a shared family name doesn't make the names long.
    expect(suggested(['Jane Bennet', 'Jade Bennet'])).toEqual([]);
    expect(suggested(['John Smith', 'Joan Smith'])).toEqual([]);
  });

  it('catches a misspelling under the same title, or in one long word of a full name', () => {
    expect(suggested(['Mr. Bennet', 'Mr. Bennett'], { 'Mr. Bennet': 3 })).toEqual([
      'Mr. Bennett → Mr. Bennet: “Mr. Bennet” and “Mr. Bennett” are spelled almost alike',
    ]);
    expect(suggested(['Hermione Granger', 'Hermoine Granger'], { 'Hermione Granger': 3 })).toEqual([
      'Hermoine Granger → Hermione Granger: “Hermione Granger” and “Hermoine Granger” are spelled almost alike',
    ]);
  });

  it('takes no word for a nickname that is only an object’s own key', () => {
    expect(suggested(['Constructor', 'Constructor Smith', '__proto__', 'toString'])).toEqual([
      'Constructor Smith → Constructor: “Constructor” may be “Constructor Smith”',
    ]);
  });

  it('lists the pairs of the most heard characters first', () => {
    expect(
      suggested(['Robert', 'Bob', 'Mr. Darcy', 'Darcy'], { Robert: 2, 'Mr. Darcy': 20 }),
    ).toEqual([
      'Darcy → Mr. Darcy: “Mr. Darcy” and “Darcy” differ only by a title',
      'Bob → Robert: “Bob” can be short for “Robert”',
    ]);
  });
});
