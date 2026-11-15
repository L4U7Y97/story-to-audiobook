import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Segment } from '@/format/types';
import { validateSegments } from '@/format/validate';
import { splitUnits, type Unit } from '@/analysis/units';

/** Unit texts with their provisional kind, for readable assertions. */
function show(text: string, hints = []): Array<[string, Unit['kind']]> {
  return splitUnits(text, hints).map((u) => [text.slice(u.start, u.end), u.kind]);
}

describe('splitUnits: quotes', () => {
  it('splits speech, attribution and speech in one paragraph', () => {
    expect(show('“Hi,” she said, “bye.”')).toEqual([
      ['“Hi,”', 'speech'],
      [' she said, ', 'narration'],
      ['“bye.”', 'speech'],
    ]);
  });

  it('handles straight double quotes', () => {
    expect(show('He said "yes" and left.')).toEqual([
      ['He said ', 'narration'],
      ['"yes"', 'speech'],
      [' and left.', 'narration'],
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
});

describe('splitUnits: single quotes', () => {
  it('leaves a single-quoted word inside a sentence to the narration', () => {
    expect(show('It had been, she decided, a ‘quiet’ morning.')).toEqual([
      ['It had been, she decided, a ‘quiet’ morning.', 'narration'],
    ]);
    expect(show("He called it a 'sign' of better things to come.")).toEqual([
      ["He called it a 'sign' of better things to come.", 'narration'],
    ]);
    expect(show('It rained.\n\nThe word ‘noon’ was barely there.')).toEqual([
      ['It rained.\n\n', 'narration'],
      ['The word ‘noon’ was barely there.', 'narration'],
    ]);
    // Even with a tag after it, a quote inside a sentence is the teller's.
    expect(show('She always called the farm ‘the old place,’ Tom said.')).toEqual([
      ['She always called the farm ‘the old place,’ Tom said.', 'narration'],
    ]);
  });

  it('opens speech with a single quote that starts its paragraph', () => {
    expect(show('It rained.\n\n‘You are late,’ the crow said.')).toEqual([
      ['It rained.\n\n', 'narration'],
      ['‘You are late,’', 'speech'],
      [' the crow said.', 'narration'],
    ]);
  });

  it('opens speech at the start of a sentence only when a tag follows the line', () => {
    expect(show('She laughed. ‘Of course he is,’ she thought.')).toEqual([
      ['She laughed. ', 'narration'],
      ['‘Of course he is,’', 'speech'],
      [' she thought.', 'narration'],
    ]);
    expect(show('He bowed. ‘Shall we begin?’ Bi De asked.')).toEqual([
      ['He bowed. ', 'narration'],
      ['‘Shall we begin?’', 'speech'],
      [' Bi De asked.', 'narration'],
    ]);
    expect(show("She paused. 'Fine,' said the old man.")).toEqual([
      ['She paused. ', 'narration'],
      ["'Fine,'", 'speech'],
      [' said the old man.', 'narration'],
    ]);
    // A note, a sign or a thought with no tag is the teller's.
    expect(show('Tobin read the note. ‘Back by noon.’ The ink had run.')).toEqual([
      ['Tobin read the note. ‘Back by noon.’ The ink had run.', 'narration'],
    ]);
  });

  it('opens speech right after a speech verb and a comma or colon', () => {
    expect(show('‘This one does,’ Pip told her, ‘and this one is hungry.’')).toEqual([
      ['‘This one does,’', 'speech'],
      [' Pip told her, ', 'narration'],
      ['‘and this one is hungry.’', 'speech'],
    ]);
    expect(show('From the roof he declared: ‘Fine bread. Poor company.’')).toEqual([
      ['From the roof he declared: ', 'narration'],
      ['‘Fine bread. Poor company.’', 'speech'],
    ]);
    expect(show('Then he went on, ‘and that is all.’')).toEqual([
      ['Then he went on, ', 'narration'],
      ['‘and that is all.’', 'speech'],
    ]);
    // In a paragraph a single-quoted line opens, the rest of the line may follow a longer tag.
    // The two paragraphs before it put the text's dialogue in double quotes.
    const talk = '“Hi,” said Tom.\n\n“Hello,” said Ann.\n\n';
    expect(show(`${talk}‘Yes,’ said the old man, ‘and no.’`).slice(4)).toEqual([
      ['‘Yes,’', 'speech'],
      [' said the old man, ', 'narration'],
      ['‘and no.’', 'speech'],
    ]);
  });

  it('leaves a single quote after a verb and more words to the narration', () => {
    expect(show('He went home, ‘tired’ but happy.')).toEqual([
      ['He went home, ‘tired’ but happy.', 'narration'],
    ]);
    expect(show('Tom said nothing for a while, ‘sulking’ as his mother called it.')).toEqual([
      ['Tom said nothing for a while, ‘sulking’ as his mother called it.', 'narration'],
    ]);
  });

  it('reads single quotes as speech wherever they open when the text writes dialogue in them', () => {
    const text = '‘Hello,’ she said. ‘How are you?’\n\n‘Well,’ he said. He smiled. ‘And you?’';
    expect(show(text)).toEqual([
      ['‘Hello,’', 'speech'],
      [' she said. ', 'narration'],
      ['‘How are you?’\n\n', 'speech'],
      ['‘Well,’', 'speech'],
      [' he said. He smiled. ', 'narration'],
      ['‘And you?’', 'speech'],
    ]);
  });

  it('keeps quotes nested in a line inside that line', () => {
    expect(show('“She said ‘never’ to me,” he said.')).toEqual([
      ['“She said ‘never’ to me,”', 'speech'],
      [' he said.', 'narration'],
    ]);
  });
});

describe('splitUnits: dashes', () => {
  it('reads dash dialogue as narration', () => {
    expect(show('—Hello —he said.')).toEqual([['—Hello —he said.', 'narration']]);
  });
});

describe('splitUnits: paragraphs and whitespace', () => {
  it('treats single newlines as hard wraps when the text has blank lines', () => {
    const text = 'A long line that\nwraps here.\n\nNext paragraph.';
    const units = splitUnits(text);
    expect(units.map((u) => [text.slice(u.start, u.end), u.paragraph])).toEqual([
      ['A long line that\nwraps here.\n\n', 0],
      ['Next paragraph.', 1],
    ]);
  });

  it('treats every newline as a paragraph break when there are no blank lines', () => {
    expect(splitUnits('One.\nTwo.\nThree.').map((u) => u.paragraph)).toEqual([0, 1, 2]);
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
    expect(splitUnits('')).toEqual([]);
  });
});

// The tests' own oracle for where splitUnits starts paragraphs (the app no longer needs one).
const WHITESPACE = /\s/u;
/** A text with a blank line in it separates paragraphs only by blank lines. */
const BLANK_LINE = /\n[^\S\n]*\n/;

/**
 * Whether a paragraph starts at `offset`, as splitUnits splits them: only whitespace lies before
 * it, back to the start of the text or to a paragraph break (a hard wrap is not one).
 */
function startsParagraph(text: string, offset: number): boolean {
  let from = offset;
  while (from > 0 && WHITESPACE.test(text[from - 1]!)) from--;
  if (from === 0) return true;
  const gap = text.slice(from, offset);
  return BLANK_LINE.test(text) ? BLANK_LINE.test(gap) : gap.includes('\n');
}

describe('startsParagraph', () => {
  it('finds paragraph starts as splitUnits does, so a hard wrap starts none', () => {
    const wrapped = 'It rained.\n\n“I don’t know if she’ll come,”\nsaid Anne.';
    expect(startsParagraph(wrapped, wrapped.indexOf('“I'))).toBe(true);
    expect(startsParagraph(wrapped, wrapped.indexOf('said'))).toBe(false);
    const lines = 'Anne came in.\n“Hello.”';
    expect(startsParagraph(lines, lines.indexOf('“'))).toBe(true);
    expect(startsParagraph('  “Hello.”', 2)).toBe(true);
    expect(startsParagraph('“Hello,” she said.', 9)).toBe(false);
  });
});

describe('splitUnits: emphasis hints', () => {
  it('splits narration at multi-word emphasis', () => {
    const text = 'I must go, she thought. Then she left.';
    expect(show(text, [{ start: 0, end: 9, kind: 'emphasis' }] as never)).toEqual([
      ['I must go', 'emphasis'],
      [', she thought. Then she left.', 'narration'],
    ]);
  });

  it('ignores single-word emphasis', () => {
    const text = 'You want to tell me.';
    expect(show(text, [{ start: 0, end: 3, kind: 'emphasis' }] as never)).toEqual([
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
    '—',
    '-',
    '.',
    ',',
    'é',
    '😀',
  );

  it('always tiles the text', () => {
    fc.assert(
      fc.property(fc.string({ unit: alphabet, maxLength: 80 }), (text) => {
        const units = splitUnits(text);
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

  it('starts paragraphs where startsParagraph says', () => {
    fc.assert(
      fc.property(fc.string({ unit: alphabet, maxLength: 80 }), (text) => {
        const units = splitUnits(text);
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
