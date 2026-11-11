import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Lang, Segment } from '@/format/types';
import { validateSegments } from '@/format/validate';
import { splitUnits, startsParagraph, type Unit } from '@/analysis/units';

/** Unit texts with their provisional kind, for readable assertions. */
function show(text: string, lang: Lang = 'en', hints = []): Array<[string, Unit['kind']]> {
  return splitUnits(text, lang, hints).map((u) => [text.slice(u.start, u.end), u.kind]);
}

describe('splitUnits: quotes', () => {
  it('splits speech, attribution and speech in one paragraph', () => {
    expect(show('“Hi,” she said, “bye.”')).toEqual([
      ['“Hi,”', 'speech'],
      [' she said, ', 'narration'],
      ['“bye.”', 'speech'],
    ]);
  });

  it('handles straight double quotes and guillemets', () => {
    expect(show('He said "yes" and left.')).toEqual([
      ['He said ', 'narration'],
      ['"yes"', 'speech'],
      [' and left.', 'narration'],
    ]);
    expect(show('«Ven», dijo.', 'es')).toEqual([
      ['«Ven»', 'speech'],
      [', dijo.', 'narration'],
    ]);
  });

  it('keeps nested quotes inside the outer speech', () => {
    expect(show('«Me dijo “no” ayer», contó.', 'es')).toEqual([
      ['«Me dijo “no” ayer»', 'speech'],
      [', contó.', 'narration'],
    ]);
  });

  it('treats apostrophes as part of words, not quotes', () => {
    expect(show("I don't know. L'eau, c'est la vie.")).toEqual([
      ["I don't know. L'eau, c'est la vie.", 'narration'],
    ]);
    expect(show('It isn’t raining.')).toEqual([['It isn’t raining.', 'narration']]);
  });

  it('handles single-quote dialogue containing apostrophes', () => {
    expect(show("'I don't know,' she said.")).toEqual([
      ["'I don't know,'", 'speech'],
      [' she said.', 'narration'],
    ]);
    expect(show('‘Don’t go,’ he said.')).toEqual([
      ['‘Don’t go,’', 'speech'],
      [' he said.', 'narration'],
    ]);
  });

  it('closes an unterminated quote at the end of its paragraph', () => {
    const text = '“First paragraph of a long speech.\n\n“Second paragraph,” he said.';
    expect(show(text)).toEqual([
      ['“First paragraph of a long speech.\n\n', 'speech'],
      ['“Second paragraph,”', 'speech'],
      [' he said.', 'narration'],
    ]);
  });

  it('continues a «…» quotation in a paragraph that opens with »', () => {
    const text =
      '«Era tarde», dijo Ana. «Estábamos cansados.\n\n»Entonces llegó la guerra.» Calló.';
    expect(show(text, 'es')).toEqual([
      ['«Era tarde»', 'speech'],
      [', dijo Ana. ', 'narration'],
      ['«Estábamos cansados.\n\n', 'speech'],
      ['»Entonces llegó la guerra.»', 'speech'],
      [' Calló.', 'narration'],
    ]);
    // Only after a quotation left open: otherwise » is an ordinary character.
    expect(show('«Ven».\n\n»Nada.', 'es')).toEqual([
      ['«Ven»', 'speech'],
      ['.\n\n', 'narration'],
      ['»Nada.', 'narration'],
    ]);
  });
});

describe('splitUnits: Spanish dash dialogue', () => {
  it('splits speech, inciso and continued speech', () => {
    expect(show('—Hola —dijo Ana—. ¿Vienes?', 'es')).toEqual([
      ['—Hola ', 'speech'],
      ['—dijo Ana—', 'narration'],
      ['. ¿Vienes?', 'speech'],
    ]);
  });

  it('opens new speech after an inciso that ends with a sentence', () => {
    expect(show('—¿Quién? —preguntó Juan. —Yo.', 'es')).toEqual([
      ['—¿Quién? ', 'speech'],
      ['—preguntó Juan. ', 'narration'],
      ['—Yo.', 'speech'],
    ]);
  });

  it('handles Project Gutenberg double hyphens without spaces', () => {
    expect(show('--No puedo equivocarme--murmuró--. Me dijeron que sí.', 'es')).toEqual([
      ['--No puedo equivocarme', 'speech'],
      ['--murmuró--', 'narration'],
      ['. Me dijeron que sí.', 'speech'],
    ]);
  });

  it('keeps an inciso that runs to the end of the paragraph as narration', () => {
    expect(show('--Vamos--dijo el viajero lleno de gozo.', 'es')).toEqual([
      ['--Vamos', 'speech'],
      ['--dijo el viajero lleno de gozo.', 'narration'],
    ]);
  });

  it('ignores dashes in English and in narration paragraphs', () => {
    expect(show('—Hello —he said.', 'en')).toEqual([['—Hello —he said.', 'narration']]);
    expect(show('Era tarde —muy tarde— y llovía.', 'es')).toEqual([
      ['Era tarde —muy tarde— y llovía.', 'narration'],
    ]);
  });
});

describe('splitUnits: paragraphs and whitespace', () => {
  it('treats single newlines as hard wraps when the text has blank lines', () => {
    const text = 'A long line that\nwraps here.\n\nNext paragraph.';
    const units = splitUnits(text, 'en');
    expect(units.map((u) => [text.slice(u.start, u.end), u.paragraph])).toEqual([
      ['A long line that\nwraps here.\n\n', 0],
      ['Next paragraph.', 1],
    ]);
  });

  it('treats every newline as a paragraph break when there are no blank lines', () => {
    expect(splitUnits('One.\nTwo.\nThree.', 'en').map((u) => u.paragraph)).toEqual([0, 1, 2]);
  });

  it('never produces whitespace-only units', () => {
    // Blank stretches join a neighbour; quotes separated only by spaces become one speech unit.
    expect(show('\n\n  “Hi.” “Bye.”  \n\nEnd.')).toEqual([
      ['\n\n  “Hi.” “Bye.”  \n\n', 'speech'],
      ['End.', 'narration'],
    ]);
  });

  it('returns one unit for whitespace-only text and none for empty text', () => {
    expect(show(' \n ')).toEqual([[' \n ', 'narration']]);
    expect(splitUnits('', 'en')).toEqual([]);
  });
});

describe('startsParagraph', () => {
  it('finds paragraph starts as splitUnits does, so a hard wrap starts none', () => {
    const wrapped = 'Llovía.\n\n—No sé si vendrá\n—dijo Ana.';
    expect(startsParagraph(wrapped, wrapped.indexOf('—No'))).toBe(true);
    expect(startsParagraph(wrapped, wrapped.indexOf('—dijo'))).toBe(false);
    const lines = 'Ana entró.\n—Hola.';
    expect(startsParagraph(lines, lines.indexOf('—'))).toBe(true);
    expect(startsParagraph('  —Hola.', 2)).toBe(true);
    expect(startsParagraph('—Hola —dijo.', 6)).toBe(false);
  });
});

describe('splitUnits: emphasis hints', () => {
  it('splits narration at multi-word emphasis', () => {
    const text = 'I must go, she thought. Then she left.';
    expect(show(text, 'en', [{ start: 0, end: 9, kind: 'emphasis' }] as never)).toEqual([
      ['I must go', 'emphasis'],
      [', she thought. Then she left.', 'narration'],
    ]);
  });

  it('ignores single-word emphasis', () => {
    const text = 'You want to tell me.';
    expect(show(text, 'en', [{ start: 0, end: 3, kind: 'emphasis' }] as never)).toEqual([
      ['You want to tell me.', 'narration'],
    ]);
  });
});

describe('splitUnits: properties', () => {
  const alphabet = fc.constantFrom(
    'a',
    'B',
    ' ',
    '\n',
    '“',
    '”',
    '"',
    "'",
    '‘',
    '’',
    '«',
    '»',
    '—',
    '-',
    '.',
    ',',
    'é',
    '😀',
  );

  it.each(['en', 'es'] as const)('always tiles the text (%s)', (lang) => {
    fc.assert(
      fc.property(fc.string({ unit: alphabet, maxLength: 80 }), (text) => {
        const units = splitUnits(text, lang);
        const asSegments: Segment[] = units.map((u) => ({
          start: u.start,
          end: u.end,
          speakerId: 'n',
          mode: 'narration',
          source: 'heuristic',
        }));
        expect(validateSegments(text, asSegments, new Set(['n']))).toEqual({ ok: true });
        expect(units.map((u) => u.index)).toEqual(units.map((_, i) => i));
      }),
    );
  });

  it.each(['en', 'es'] as const)('starts paragraphs where startsParagraph says (%s)', (lang) => {
    fc.assert(
      fc.property(fc.string({ unit: alphabet, maxLength: 80 }), (text) => {
        const units = splitUnits(text, lang);
        units.forEach((u, i) => {
          const body = text.slice(u.start, u.end);
          const words = u.end - body.trimStart().length;
          const starts = i === 0 || u.paragraph !== units[i - 1]!.paragraph;
          expect(startsParagraph(text, words)).toBe(starts);
        });
      }),
    );
  });
});
