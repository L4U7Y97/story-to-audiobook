import { describe, expect, it } from 'vitest';
import { mergeLabels } from '@/analysis/merge';
import type { LabelResult, NewCharacter, SpanLabel } from '@/analysis/labels';
import { baseCast } from '../../helpers/fixtures';

const narrator = { kind: 'cast', id: 'narrator' } as const;
const span = (start: number, end: number, extra: Partial<SpanLabel> = {}): SpanLabel => ({
  start,
  end,
  speaker: narrator,
  mode: 'narration',
  source: 'heuristic',
  ...extra,
});

let n = 0;
const ids = () => `id${++n}`;

describe('mergeLabels', () => {
  it('gives new characters ids and maps their spans', () => {
    n = 0;
    const result: LabelResult = {
      spans: [span(0, 5, { speaker: { kind: 'new', ref: 'new:1' }, mode: 'speech' }), span(5, 9)],
      newCharacters: [{ ref: 'new:1', name: 'Anne', aliases: ['Anne', 'Annie'], gender: 'female' }],
      aliasAdditions: [],
    };
    const merged = mergeLabels('“Hi” ok.', result, baseCast('en'), 'p1', ids);
    expect(merged.newCharacterIds).toEqual(['id1']);
    expect(merged.cast.at(-1)).toEqual({
      id: 'id1',
      role: 'character',
      name: 'Anne',
      aliases: ['Annie'],
      gender: 'female',
      firstSeenPartId: 'p1',
    });
    expect(merged.segments.map((s) => s.speakerId)).toEqual(['id1', 'narrator']);
  });

  it('copies the traits of a new character, in a fixed order', () => {
    n = 0;
    const result: LabelResult = {
      spans: [span(0, 5, { speaker: { kind: 'new', ref: 'new:1' }, mode: 'speech' }), span(5, 9)],
      newCharacters: [
        {
          ref: 'new:1',
          name: 'Pip',
          aliases: [],
          size: 'small',
          species: 'animal',
          age: 'child',
          gender: 'male',
          description: 'a mouse',
        },
      ],
      aliasAdditions: [],
    };
    const created = mergeLabels('“Hi” ok.', result, baseCast('en'), 'p1', ids).cast.at(-1)!;
    expect(created).toStrictEqual({
      id: 'id1',
      role: 'character',
      name: 'Pip',
      aliases: [],
      gender: 'male',
      age: 'child',
      species: 'animal',
      size: 'small',
      description: 'a mouse',
      firstSeenPartId: 'p1',
    });
    expect(Object.keys(created)).toEqual([
      'id',
      'role',
      'name',
      'aliases',
      'gender',
      'age',
      'species',
      'size',
      'description',
      'firstSeenPartId',
    ]);
  });

  it('writes no trait key for a trait that is missing, undefined or not a known value', () => {
    n = 0;
    const result: LabelResult = {
      spans: [
        span(0, 5, { speaker: { kind: 'new', ref: 'a' }, mode: 'speech' }),
        span(5, 10, { speaker: { kind: 'new', ref: 'b' }, mode: 'speech' }),
        span(10, 13, { speaker: { kind: 'new', ref: 'c' }, mode: 'speech' }),
      ],
      newCharacters: [
        { ref: 'a', name: 'Anne', aliases: [] },
        {
          ref: 'b',
          name: 'Tom',
          aliases: [],
          gender: undefined,
          age: undefined,
          species: 'machine',
          size: undefined,
        },
        // Values outside the format's lists count as unset, wherever they come from.
        {
          ref: 'c',
          name: 'Rex',
          aliases: [],
          age: 'elderly',
          size: 'medium',
        } as unknown as NewCharacter,
      ],
      aliasAdditions: [],
    };
    const merged = mergeLabels('“Hi” “Yo” “R”', result, baseCast('en'), 'p1', ids);
    const [anne, tom, rex] = merged.cast.slice(-3);
    const plain = ['id', 'role', 'name', 'aliases', 'firstSeenPartId'];
    expect(Object.keys(anne!)).toEqual(plain);
    expect(Object.keys(tom!)).toEqual([
      'id',
      'role',
      'name',
      'aliases',
      'species',
      'firstSeenPartId',
    ]);
    expect(tom).toStrictEqual({
      id: 'id2',
      role: 'character',
      name: 'Tom',
      aliases: [],
      species: 'machine',
      firstSeenPartId: 'p1',
    });
    expect(Object.keys(rex!)).toEqual(plain);
  });

  it('joins adjacent spans with the same voice within a paragraph only', () => {
    const text = 'One. Two.\n\nThree.';
    const result: LabelResult = {
      spans: [span(0, 5), span(5, 11), span(11, 17)],
      newCharacters: [],
      aliasAdditions: [],
    };
    const merged = mergeLabels(text, result, baseCast('en'), 'p1', ids);
    expect(merged.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 11],
      [11, 17],
    ]);
  });

  it('keeps spans apart when tone or mode differ', () => {
    const result: LabelResult = {
      spans: [
        span(0, 3, { mode: 'speech' }),
        span(3, 6, { mode: 'speech', tone: { label: 'shout' } }),
        span(6, 9, { mode: 'thought', tone: { label: 'shout' } }),
      ],
      newCharacters: [],
      aliasAdditions: [],
    };
    expect(mergeLabels('abcdefghi', result, baseCast('en'), 'p1', ids).segments).toHaveLength(3);
  });

  it('never stores the internal teller flag', () => {
    const result: LabelResult = {
      spans: [span(0, 5, { teller: true }), span(5, 9, { mode: 'speech', teller: true })],
      newCharacters: [],
      aliasAdditions: [],
    };
    const { segments } = mergeLabels('Then “Hi”', result, baseCast('en'), 'p1', ids);
    expect(segments).toHaveLength(2);
    expect(segments.filter((s) => 'teller' in s)).toEqual([]);
  });

  it('adds new aliases to existing characters once', () => {
    const cast = [
      ...baseCast('es'),
      {
        id: 'g',
        role: 'character' as const,
        name: 'Teodoro Golfín',
        aliases: ['el doctor'],
        voice: { lang: 'es-ES', pitch: 1, rate: 1 },
      },
    ];
    const result: LabelResult = {
      spans: [span(0, 1)],
      newCharacters: [],
      aliasAdditions: [
        { characterId: 'g', alias: 'Golfín' },
        { characterId: 'g', alias: 'Golfín' },
        { characterId: 'g', alias: 'el doctor' },
      ],
    };
    const merged = mergeLabels('a', result, cast, 'p1', ids);
    expect(merged.cast.find((c) => c.id === 'g')!.aliases).toEqual(['el doctor', 'Golfín']);
  });
});
