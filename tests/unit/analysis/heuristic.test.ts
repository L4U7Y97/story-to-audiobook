import { describe, expect, it } from 'vitest';
import type { Character, Lang } from '@/format/types';
import { splitUnits } from '@/analysis/units';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { findMentions, tokenize } from '@/analysis/heuristic/mentions';
import { matchCast, type CastEntry } from '@/analysis/castMatch';
import type { LabelResult } from '@/analysis/labels';
import { baseCast } from '../../helpers/fixtures';

function analyse(text: string, lang: Lang, cast: Character[] = baseCast(lang)) {
  const result = analyzeHeuristic({ text, lang, units: splitUnits(text, lang), cast });
  return { result, lines: describe_(text, result, cast) };
}

/** "text → speaker [mode, tone]" for each non-narration span. */
function describe_(text: string, result: LabelResult, cast: Character[]): string[] {
  return result.spans
    .filter((s) => s.mode !== 'narration')
    .map((s) => {
      const name =
        s.speaker.kind === 'cast'
          ? cast.find((c) => c.id === (s.speaker as { id: string }).id)!.name
          : result.newCharacters.find((c) => c.ref === (s.speaker as { ref: string }).ref)!.name;
      const extra = [s.mode, s.tone?.label].filter(Boolean).join(', ');
      return `${text.slice(s.start, s.end).trim()} → ${name} [${extra}]`;
    });
}

describe('tokenize / findMentions', () => {
  const names = (text: string, lang: Lang = 'en', known: string[] = []) =>
    findMentions(tokenize(text, lang), lang, (n) => known.includes(n)).map((m) => m.name);

  it('keeps titles with names and ignores capitals at sentence start', () => {
    expect(names('Then Mr. Bennet left. Anne stayed with Mrs. Long.')).toEqual([
      'Mr. Bennet',
      'Mrs. Long',
    ]);
    expect(names('Then Mr. Bennet left. Anne stayed.', 'en', ['Anne'])).toEqual([
      'Mr. Bennet',
      'Anne',
    ]);
  });

  it('finds descriptors, including Spanish contractions and "de" qualifiers', () => {
    expect(names('cried his wife, impatiently', 'en')).toEqual(['his wife']);
    expect(names('sin mirar al doctor, y después una voz de hombre', 'es')).toEqual([
      'el doctor',
      'una voz de hombre',
    ]);
    expect(names('preguntó el misterioso joven', 'es')).toEqual(['el misterioso joven']);
  });

  it('drops the article in "la Nela"', () => {
    expect(names('dijo la Nela', 'es')).toEqual(['Nela']);
  });
});

describe('matchCast', () => {
  const entry = (name: string, aliases: string[] = []): CastEntry => ({
    key: name,
    name,
    aliases,
    role: 'character',
  });

  it('matches exactly, case-insensitively, including aliases', () => {
    const cast = [entry('Elizabeth', ['Lizzy'])];
    expect(matchCast('lizzy', cast)?.key).toBe('Elizabeth');
  });

  it('matches a surname to a unique full name and back', () => {
    expect(matchCast('Golfín', [entry('Teodoro Golfín')])?.key).toBe('Teodoro Golfín');
    expect(matchCast('Teodoro Golfín', [entry('Golfín')])?.key).toBe('Golfín');
  });

  it('never matches titled names partially', () => {
    expect(matchCast('Mr. Bennet', [entry('Mrs. Bennet')])).toBeUndefined();
    expect(matchCast('Bennet', [entry('Mr. Bennet'), entry('Mrs. Bennet')])).toBeUndefined();
  });

  it('ignores the narrator and unknown entries', () => {
    expect(matchCast('Narrator', [{ ...entry('Narrator'), role: 'narrator' }])).toBeUndefined();
  });
});

describe('analyzeHeuristic', () => {
  it('attributes tagged speech with tone from the verb', () => {
    const { lines } = analyse('“Run!” shouted Anne. “Why?” whispered Tom.', 'en');
    expect(lines).toEqual(['“Run!” → Anne [speech, shout]', '“Why?” → Tom [speech, whisper]']);
  });

  it('marks thoughts from thought verbs and from emphasised narration', () => {
    expect(analyse('“I must go,” thought Anne.', 'en').lines).toEqual([
      '“I must go,” → Anne [thought]',
    ]);
    const text = 'I must go, Anne thought.';
    const result = analyzeHeuristic({
      text,
      lang: 'en',
      units: splitUnits(text, 'en', [{ start: 0, end: 9, kind: 'emphasis' }]),
      cast: baseCast('en'),
    });
    expect(describe_(text, result, baseCast('en'))).toEqual(['I must go → Anne [thought]']);
  });

  it('gives first-person tags to the narrator', () => {
    expect(analyse('“Hello,” I said.', 'en').lines).toEqual(['“Hello,” → Narrator [speech]']);
    expect(analyse('—Hola —dije yo.', 'es').lines).toEqual(['—Hola → Narrator [speech]']);
  });

  it('alternates between two speakers in untagged dialogue', () => {
    const text = '“Hi,” said Anne.\n\n“Hello,” said Tom.\n\n“How are you?”\n\n“Fine.”';
    expect(analyse(text, 'en').lines).toEqual([
      '“Hi,” → Anne [speech]',
      '“Hello,” → Tom [speech]',
      '“How are you?” → Anne [speech]',
      '“Fine.” → Tom [speech]',
    ]);
  });

  it('resolves pronouns by gender', () => {
    const text = '“Hi,” said Mr. Smith.\n\n“Hello,” said Mrs. Jones.\n\n“Well,” he replied.';
    expect(analyse(text, 'en').lines.at(-1)).toBe('“Well,” → Mr. Smith [speech]');
  });

  it('uses the subject of a colon intro', () => {
    const text = 'Después llegó una voz de hombre, que dijo:\n\n—Ven aquí.';
    expect(analyse(text, 'es').lines).toEqual(['—Ven aquí. → una voz de hombre [speech]']);
  });

  it('keeps the speaker for speech continued over several paragraphs', () => {
    const text = '“It began long ago,” said Anne. “We were young.\n\n“Then the war came.”';
    expect(analyse(text, 'en').lines.at(-1)).toBe('“Then the war came.” → Anne [speech]');
  });

  it('falls back to the unknown speaker after a long stretch of narration', () => {
    const text = '“Hi,” said Anne.\n\nTime passed.\n\nYears went by.\n\n“Who is there?”';
    expect(analyse(text, 'en').lines.at(-1)).toBe('“Who is there?” → Unknown [speech]');
  });

  it('reuses characters from earlier parts and records new aliases', () => {
    const cast: Character[] = [
      ...baseCast('es'),
      {
        id: 'golfin',
        role: 'character',
        name: 'Teodoro Golfín',
        aliases: [],
        voice: { lang: 'es-ES', pitch: 0.9, rate: 1 },
      },
    ];
    const { result, lines } = analyse('—Vamos —dijo Golfín—. Adelante.', 'es', cast);
    expect(lines).toEqual([
      '—Vamos → Teodoro Golfín [speech]',
      '. Adelante. → Teodoro Golfín [speech]',
    ]);
    expect(result.newCharacters).toEqual([]);
    expect(result.aliasAdditions).toEqual([{ characterId: 'golfin', alias: 'Golfín' }]);
  });

  it('labels narration with the narrator and tiles the text', () => {
    const text = 'It was late.\n\n“Go,” said Anne.';
    const { result } = analyse(text, 'en');
    expect(result.spans.map((s) => [s.start, s.end, s.mode])).toEqual([
      [0, 14, 'narration'],
      [14, 19, 'speech'],
      [19, text.length, 'narration'],
    ]);
    expect(result.spans.every((s) => s.source === 'heuristic')).toBe(true);
  });
});
