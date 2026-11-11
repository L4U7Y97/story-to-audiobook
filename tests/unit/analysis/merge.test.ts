import { describe, expect, it } from 'vitest';
import { mergeLabels } from '@/analysis/merge';
import type { LabelResult, SpanLabel } from '@/analysis/labels';
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
