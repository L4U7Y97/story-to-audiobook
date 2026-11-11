import { describe, expect, it } from 'vitest';
import type { Character, Gender, Lang } from '@/format/types';
import { splitUnits } from '@/analysis/units';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { findMentions, tokenize, verbAt } from '@/analysis/heuristic/mentions';
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

const voice = { lang: 'en-US', pitch: 1, rate: 1 };
/** The base cast plus characters given as [id, name, gender?, aliases?]. */
function castWith(lang: Lang, people: Array<[string, string, Gender?, string[]?]>): Character[] {
  return [
    ...baseCast(lang),
    ...people.map(([id, name, gender, aliases = []]) => ({
      id,
      role: 'character' as const,
      name,
      aliases,
      ...(gender ? { gender } : {}),
      voice,
    })),
  ];
}
/** "speaker [mode, tone]" for each non-narration span. */
const speakers = (text: string, lang: Lang, cast?: Character[]) =>
  analyse(text, lang, cast).lines.map((l) => l.split(' → ')[1]);
const newNames = (text: string, lang: Lang, cast?: Character[]) =>
  analyse(text, lang, cast).result.newCharacters.map((c) => c.name);

describe('matchCast: narrator, unknown speaker and name variants', () => {
  const entry = (
    name: string,
    aliases: string[] = [],
    role: CastEntry['role'] = 'character',
  ): CastEntry => ({ key: name, name, aliases, role });
  const match = (name: string, cast: CastEntry[]) => matchCast(name, cast)?.key;

  it('matches the narrator by its own name and aliases, never by its default name', () => {
    expect(match('Watson', [entry('Narrator', ['Watson'], 'narrator')])).toBe('Narrator');
    expect(match('Watson', [entry('John Watson', [], 'narrator')])).toBe('John Watson');
    expect(match('Narrator', [entry('Narrator', [], 'narrator')])).toBeUndefined();
    expect(match('Narrador', [entry('Narrador', [], 'narrator')])).toBeUndefined();
  });

  it('matches the unknown speaker only by an exact alias', () => {
    const unknown = entry('Unknown speaker', ['a voice'], 'unknown');
    expect(match('a voice', [unknown])).toBe('Unknown speaker');
    expect(match('Unknown speaker', [unknown])).toBeUndefined();
  });

  it('matches a name with and without its title, never across titles', () => {
    expect(match('Darcy', [entry('Mr. Darcy')])).toBe('Mr. Darcy');
    expect(match('Mr. Darcy', [entry('Darcy')])).toBe('Darcy');
    expect(match('Mr Darcy', [entry('Mr. Darcy')])).toBe('Mr. Darcy');
    expect(match('Pablo', [entry('Don Pablo')])).toBe('Don Pablo');
    expect(match('don Pablo', [entry('Pablo')])).toBe('Pablo');
    expect(match('Bennet', [entry('Mr. Bennet'), entry('Mrs. Bennet')])).toBeUndefined();
    expect(match('Miss Bennet', [entry('Mrs. Bennet')])).toBeUndefined();
    expect(match('Mr. Bennet', [entry('Mrs. Bennet')])).toBeUndefined();
    expect(match('Mister Smith', [entry('Mr. Smith')])).toBe('Mr. Smith');
    expect(match('Master', [entry('Master Bates')])).toBeUndefined();
  });

  it('never takes a woman’s family title for the bare name, which may be her brother’s', () => {
    expect(match('Bingley', [entry('Miss Bingley')])).toBeUndefined();
    expect(match('Joe', [entry('Mrs. Joe')])).toBeUndefined();
    expect(match('Mrs. Joe', [entry('Joe')])).toBeUndefined();
    expect(match('Miss Bingley', [entry('Mr. Bingley', ['Bingley'])])).toBeUndefined();
    expect(match('Bingley', [entry('Miss Bingley'), entry('Charles Bingley')])).toBe(
      'Charles Bingley',
    );
    expect(match('Mina Murray', [entry('Miss Mina Murray')])).toBe('Miss Mina Murray');
    expect(match('Miss Mina Murray', [entry('Mina Murray')])).toBe('Mina Murray');
  });

  it('matches first names and surnames unless a known full name disagrees', () => {
    expect(match('Amy', [entry('Amy Elliott')])).toBe('Amy Elliott');
    expect(match('Amy Elliott', [entry('Amy')])).toBe('Amy');
    expect(match('Teodoro Golfín', [entry('Golfín')])).toBe('Golfín');
    expect(match('Carlos Golfín', [entry('Golfín', ['Teodoro Golfín'])])).toBeUndefined();
  });

  it('ignores apostrophe style and a possessive ’s', () => {
    expect(match("O'Brien", [entry('O’Brien')])).toBe('O’Brien');
    expect(match('Harker’s', [entry('Harker')])).toBe('Harker');
  });
});

describe('tokenize / findMentions: words that are not people', () => {
  const mentions = (text: string, lang: Lang = 'en', known: string[] = []) =>
    findMentions(tokenize(text, lang), lang, (n) => known.includes(n));
  const names = (text: string, lang: Lang = 'en', known: string[] = []) =>
    mentions(text, lang, known).map((m) => m.name);

  it('skips an unknown capitalised run at a sentence start, or in capitals, whole', () => {
    expect(names('Elizabeth Bennet smiled.')).toEqual([]);
    expect(names('CHAPTER II')).toEqual([]);
    expect(names('NICK DUNNE')).toEqual([]);
    expect(names('Jane Bennet smiled.', 'en', ['Jane'])).toEqual(['Jane']);
  });

  it('reads the name after a capitalised sentence opener', () => {
    expect(names('Even Mr. Darcy smiled.', 'en', ['Mr. Darcy'])).toEqual(['Mr. Darcy']);
    expect(names('Even Mr. Collins smiled.')).toEqual(['Mr. Collins']);
    expect(names('Poor Mrs. Bennet sighed.')).toEqual(['Mrs. Bennet']);
    expect(names('Pobre Don Pablo suspiró.', 'es')).toEqual(['Don Pablo']);
    expect(names('Suddenly Anna felt tired.')).toEqual(['Anna']);
    // "St." and "D." sit inside a full name, so the run is still skipped whole.
    expect(names('Elizabeth St. Clair smiled.')).toEqual([]);
    expect(names('Juan D. Pérez llegó.', 'es')).toEqual([]);
  });

  it('never takes I-contractions for names', () => {
    expect(names('He knew I’d come, and I’m glad.')).toEqual([]);
    expect(names("He knew I'd come, and I'm glad.")).toEqual([]);
  });

  it('reads possessives as the name, never as a subject', () => {
    const found = mentions('Jane took Elizabeth’s hand.', 'en', ['Jane']);
    expect(found.map((m) => [m.name, m.possessive ?? false])).toEqual([
      ['Jane', false],
      ['Elizabeth', true],
    ]);
    expect(names('“No,” said Lucy’s mother.')).toEqual(['Lucy’s mother']);
  });

  it('keeps decomposed accents and hyphenated names in one word', () => {
    const tokens = tokenize('dijo Golfín'.normalize('NFD'), 'es');
    expect(tokens.map((t) => t.text)).toEqual(['dijo', 'Golfín'.normalize('NFD')]);
    expect(tokenize('dijo Anne-Marie', 'en').map((t) => t.text)).toEqual(['dijo', 'Anne-Marie']);
  });

  it('ends descriptors at another determiner or a speech verb', () => {
    expect(names('She knew that her mother was right.')).toEqual(['her mother']);
    expect(names('—la interrumpió el doctor.', 'es')).toEqual(['el doctor']);
  });

  it('ignores owned voices and gives epicene nouns no gender', () => {
    expect(names('said Tom, his voice low')).toEqual(['Tom']);
    const [voz] = mentions('gritó una voz', 'es');
    expect([voz?.name, voz?.gender]).toEqual(['una voz', undefined]);
  });

  it('names the person a descriptor introduces', () => {
    const [jane] = mentions('said her sister Jane');
    expect([jane?.name, jane?.gender]).toEqual(['Jane', 'female']);
  });
});

describe('analyzeHeuristic: first-person narrators', () => {
  it('never splits the narrator into a character others address by name', () => {
    const text =
      'My uncle was in the kitchen, mending a net by the fire.\n\n' +
      '“You’re late, Kit,” said Uncle Abel, without looking up.\n\n' +
      '“The tide was against me,” I said.\n\n' +
      '“The tide is always against you, Kit.”\n\n' +
      '“Then I shall have to row harder.”';
    expect(speakers(text, 'en')).toEqual([
      'Uncle Abel [speech]',
      'Narrator [speech]',
      'Uncle Abel [speech]',
      'Narrator [speech]',
    ]);
    expect(newNames(text, 'en')).toEqual(['Uncle Abel']);
  });

  it('lets the narrator take turns in untagged dialogue', () => {
    const text =
      'I found Holmes in his chair by the fire.\n\n' +
      '“Watson, come here,” said Holmes.\n\n' +
      '“What is it?”\n\n' +
      '“A summons from Lestrade. Read it.”\n\n' +
      'I took the letter and read it twice.\n\n' +
      '“It is very short,” I said.\n\n' +
      '“Short and frightened. He wants us at once.”\n\n' +
      '“Then we had better go.”';
    expect(speakers(text, 'en')).toEqual([
      'Holmes [speech]',
      'Narrator [speech]',
      'Holmes [speech]',
      'Narrator [speech]',
      'Holmes [speech]',
      'Narrator [speech]',
    ]);
  });

  it('leaves earlier speakers out once a newcomer’s own line starts a scene', () => {
    const en =
      'I met Tom at the station.\n\n“You’re late,” said Tom.\n\n“The train was slow,” I said.\n\n' +
      '“It always is.”\n\nTom drove me home and left. In the evening Anne came to see me.\n\n' +
      '“How was the trip?” asked Anne.\n\n“Long.”\n\n“Did Tom meet you?”\n\n“He did.”';
    expect(speakers(en, 'en').slice(-4)).toEqual([
      'Anne [speech]',
      'Narrator [speech]',
      'Anne [speech]',
      'Narrator [speech]',
    ]);
    const es =
      'Me encontré con Tomás en la estación.\n\n—Llegas tarde —dijo Tomás.\n\n' +
      '—El tren iba lento —dije.\n\n—Siempre va lento.\n\n' +
      'Tomás me llevó a casa y se fue. Por la tarde vino Ana a verme.\n\n' +
      '—¿Qué tal el viaje? —preguntó Ana.\n\n—Largo.\n\n—¿Te recogió Tomás?\n\n—Sí.';
    expect(speakers(es, 'es').slice(-4)).toEqual([
      'Ana [speech]',
      'Narrator [speech]',
      'Ana [speech]',
      'Narrator [speech]',
    ]);
    // Spanish may leave out who leaves.
    for (const left of ['Se fue.', 'Al rato se fue.']) {
      const text = es.replace('Tomás me llevó a casa y se fue. Por la tarde', `${left} Entonces`);
      expect(speakers(text, 'es').slice(-4)).toEqual([
        'Ana [speech]',
        'Narrator [speech]',
        'Ana [speech]',
        'Narrator [speech]',
      ]);
    }
    // Leaving and time passing end the scene even when it ended on a question.
    const asked = en.replace('“It always is.”', '“Will you be all right?”');
    expect(speakers(asked, 'en').slice(-4)).toEqual([
      'Anne [speech]',
      'Narrator [speech]',
      'Anne [speech]',
      'Narrator [speech]',
    ]);
    // Someone only remembered, who never speaks, starts no scene: the driver keeps his lines.
    const driver =
      '“Where to?” asked the driver.\n\n“The station,” I said.\n\n“Long trip?”\n\n' +
      'I remembered Anne, waiting on the cold platform.\n\n“Long enough.”\n\n' +
      '“Rain’s coming.”\n\n“I know.”\n\n“Bring a coat.”';
    // Nor does a beat for them with no scene change before it, after a question or not.
    const laughed = driver.replace('“Long enough', 'She would have laughed. “Long enough');
    const statement = laughed.replace('“Long trip?”', '“Bad night for a trip.”');
    // A cue after the person remembered is no scene change either.
    const memories = [
      'I remembered Anne, waiting on the cold platform that night.',
      'I remembered Anne, who used to wait for me on the platform in the evening.',
      'I remembered Anne on the platform the day she left.',
    ].map((memory) => laughed.replace('I remembered Anne, waiting on the cold platform.', memory));
    for (const text of [driver, laughed, statement, ...memories]) {
      const turns = speakers(text, 'en');
      expect([turns[4], turns[6]]).toEqual(['the driver [speech]', 'the driver [speech]']);
    }
    // Someone who comes in joins the talk: the old speaker may go on. A short pause, a cue after
    // the newcomer, or a word that only looks like a cue ("on my left", "no butter left", "later
    // than usual", "she had left") ends no scene.
    const net =
      'Tom was mending the net when I came in.\n\n“You’re late,” said Tom.\n\n' +
      '“The tide was against me,” I said.\n\n“It always is.”\n\n' +
      'Then Anne came in with the bread.\n\n“Morning,” said Anne.\n\n' +
      '“As I was saying, the boat needs a new mast.”\n\n' +
      '“How long will that take?”\n\n“A month, if the wood comes.”';
    for (const entrance of [
      'Then Anne came in with the bread.',
      'A moment later Anne came in with the bread.',
      'Then Anne came in and sat down on my left.',
      'Then Anne came in with the bread. There was no butter left.',
      'Then Anne came downstairs with the bread.',
      'Then Anne joined me at the table.',
      'Then Anne came in, later than usual, with the bread.',
      'Then Anne came in with the bread. Later I would remember how pale she looked.',
      'Then Anne came in with the bread.\n\nLater I would remember how pale Anne looked.',
      'Then Anne came in, still in the coat she had worn that night.',
      'Then Anne came back in for the scarf she had left.',
      'Later than usual, Anne came in with the bread.',
      'The boy had left. Then Anne came in with the bread.',
    ]) {
      expect(
        speakers(net.replace('Then Anne came in with the bread.', entrance), 'en').slice(-3),
      ).toEqual(['Tom [speech]', 'Anne [speech]', 'Tom [speech]']);
    }
    const red =
      'Tomás remendaba la red cuando entré.\n\n—Llegas tarde —dijo Tomás.\n\n' +
      '—La marea venía en contra —respondí.\n\n—Siempre viene en contra.\n\n' +
      'Entonces entró Ana con el pan.\n\n—Buenos días —dijo Ana.\n\n' +
      '—Como te decía, el barco necesita un mástil nuevo.';
    for (const entrance of [
      'Entonces entró Ana con el pan.',
      'Poco más tarde entró Ana.',
      'Entonces entró Ana con el pan, más tarde que de costumbre.',
      'Entonces entró Ana con el pan. Más tarde supe que había llorado.',
      'Entonces entró Ana con el pan que había comprado por la tarde.',
      'Entonces entró Ana con el pan para la cena de esa noche.',
      'Entonces entró Ana a buscar la bufanda que olvidó cuando se fue.',
      'Entonces entró Ana con el pan, y el gato salió.',
      'Más tarde que de costumbre, entró Ana con el pan.',
      'El gato salió. Entonces entró Ana con el pan.',
      'Tomás no se fue. Entonces entró Ana con el pan.',
    ]) {
      const text = red.replace('Entonces entró Ana con el pan.', entrance);
      expect(speakers(text, 'es').at(-1)).toBe('Tomás [speech]');
    }
  });

  it('starts a scene after a scene break, a speaker leaving or time in the newcomer’s own clause', () => {
    const scene = ['Anne [speech]', 'Narrator [speech]', 'Anne [speech]', 'Narrator [speech]'];
    const en = (bridge: string) =>
      'I met Tom at the station.\n\n“You’re late,” said Tom.\n\n“The train was slow,” I said.\n\n' +
      `“It always is.”\n\n${bridge}\n\n` +
      '“How was the trip?” asked Anne.\n\n“Long.”\n\n“Did Tom meet you?”\n\n“He did.”';
    for (const bridge of [
      'I hoped Anne would come.\n\n* * *\n\nShe came to see me after supper.',
      'Then Anne came in, and Tom left.',
      'By the time I woke, Tom had left, and Anne was making coffee.',
      'Then Anne came to see me that evening.',
      'Then Anne arrived the next morning.',
    ]) {
      expect(speakers(en(bridge), 'en').slice(-4)).toEqual(scene);
    }
    const es = (bridge: string) =>
      'Me encontré con Tomás en la estación.\n\n—Llegas tarde —dijo Tomás.\n\n' +
      `—El tren iba lento —dije.\n\n—Siempre va lento.\n\n${bridge}\n\n` +
      '—¿Qué tal el viaje? —preguntó Ana.\n\n—Largo.\n\n—¿Te recogió Tomás?\n\n—Sí.';
    // A time, or a phrase after a preposition, is no subject of "se fue".
    for (const bridge of [
      'Tomás se quedó a cenar. Después de la cena se fue. Entonces vino Ana a verme.',
      'Tomás se quedó un rato. Esa tarde se fue. Entonces vino Ana a verme.',
      'Entonces vino Ana, y Tomás se fue.',
    ]) {
      expect(speakers(es(bridge), 'es').slice(-4)).toEqual(
        scene.map((s) => s.replace('Anne', 'Ana')),
      );
    }
    // Someone only named before a time cue that opens a sentence about her comes in after it,
    // unlike someone who came in before it ("Then Anne came in. Later I would remember…").
    const month = en('I had not seen Anne for a month. In the evening she came to see me.');
    expect(speakers(month, 'en').slice(-4)).toEqual(scene);
  });

  it('starts a scene for someone named before a time cue about them, or in its clause', () => {
    const scene = ['Anne [speech]', 'Narrator [speech]', 'Anne [speech]', 'Narrator [speech]'];
    const en = (bridge: string) =>
      'I met Tom at the station.\n\n“You’re late,” said Tom.\n\n“The train was slow,” I said.\n\n' +
      `“It always is.”\n\n${bridge}\n\n` +
      '“How was the trip?” asked Anne.\n\n“Long.”\n\n“Did Tom meet you?”\n\n“He did.”';
    for (const bridge of [
      'I had not seen Anne for a month.\n\nIn the evening she came to see me.',
      'I had not seen Anne for a month. In the evening Anne came to see me.',
      'I knew Anne would come.\n\nIn the evening Anne came to see me.',
      'I had written to Anne, and Anne had promised to come. That night she knocked on my door.',
      'Then Anne came to see me, hours later.',
      'Then Anne, who had heard the news, came to see me that evening.',
      'Then Anne came to see me, as she had promised, that evening.',
      'Then Anne came in that evening with a basket of eggs.',
      'Then Anne came in later.',
      'I went to see Anne the next day.',
      'I saw Anne again that evening.',
      'When I came back, everyone had left, and Anne was sitting alone by the fire.',
      'When I woke up, Tom’d left, and Anne was making coffee.',
      // A cue later in a sentence about her, or after three lead words, "until" or "and".
      'I had asked Anne to come. She arrived that evening.',
      'I had invited Anne for supper. She knocked on my door that evening.',
      'I had asked Anne to come.\n\nShe arrived the next morning, out of breath.',
      'I had asked Anne to come. A few days later she arrived.',
      'I did not see Anne until the next day.',
      'Then Anne and her mother came to see me that evening.',
      // Arriving, however the sentence goes on.
      'I had asked Anne to come. She arrived late that evening, as always.',
      'I had asked Anne to come. She appeared at the gate that evening.',
      'I had asked Anne to come. She knocked twice that evening.',
      'I had asked Anne to come. She appeared the next morning.',
      'I had asked Anne to come. She knocked a little after nine that evening.',
      'I had asked Anne to come. She came with her mother that evening.',
      'I had asked Anne to come. She came round to see how I was that evening.',
      'I had asked Anne to come. She came back the next day, I thought.',
      'I had asked Anne to come. She arrived that evening, as I said, soaked to the skin.',
      // Someone sent away who comes back, and someone whose news stopped before the cue.
      'Tom stayed with the horses. I had sent Anne to the village. She returned that evening.',
      'Suddenly Anne stopped writing. Months later, she knocked on my door.',
    ]) {
      expect(speakers(en(bridge), 'en').slice(-4)).toEqual(scene);
    }
    // A name at a sentence start is a mention only once the cast knows it.
    const tomAnne = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    for (const bridge of [
      'I had asked Anne to come. Anne only arrived the next morning.',
      'Anne was not back until that evening.',
      'Anne did not even come down until that evening.',
      'Anne didn’t make it back until the next morning.',
    ]) {
      expect(speakers(en(bridge), 'en', tomAnne).slice(-4)).toEqual(scene);
    }
    const es = (bridge: string) =>
      'Encontré a Tomás en la estación.\n\n—Llegas tarde —dijo Tomás.\n\n' +
      `—El tren venía lento —respondí.\n\n—Siempre viene lento.\n\n${bridge}\n\n` +
      '—¿Qué tal el viaje? —preguntó Ana.\n\n—Largo.\n\n—¿Comiste algo?\n\n—No.';
    for (const bridge of [
      'Hacía un mes que no veía a Ana. Por la tarde vino a verme.',
      'Sabía que Ana vendría.\n\nPor la tarde Ana vino a verme.',
      'Entonces vino Ana a verme por la tarde.',
      'Entonces Ana, que se había enterado, vino a verme esa noche.',
      'Fui a ver a Ana al día siguiente.',
      'Le pedí a Ana que viniera. Llegó por la tarde.',
      'Le había escrito a Ana. Vino a verme al día siguiente.',
      'No vi a Ana hasta esa noche.',
      'Entonces Ana y su madre vinieron a verme esa noche.',
      'Le pedí a Ana que viniera. Volvió a casa esa noche.',
      'Le pedí a Ana que viniera. Llamó a la puerta esa noche.',
      'Le pedí a Ana que viniera. Se presentó una hora más tarde.',
      'Le pedí a Ana que viniera. Apareció el domingo por la tarde.',
      'Le pedí a Ana que viniera. Volvió con su hermano al día siguiente.',
    ]) {
      expect(speakers(es(bridge), 'es').slice(-4)).toEqual(
        scene.map((s) => s.replace('Anne', 'Ana')),
      );
    }
    const tomasAna = castWith('es', [
      ['tomas', 'Tomás', 'male'],
      ['ana', 'Ana', 'female'],
    ]);
    for (const bridge of [
      'Ana había dejado sus cosas en mi casa. Regresó a recogerlas al día siguiente.',
      'Ana no bajó hasta esa noche.',
      'A Ana no la vi hasta esa noche.',
      'No vi a Ana hasta el día siguiente.',
    ]) {
      expect(speakers(es(bridge), 'es', tomasAna).slice(-4)).toEqual(
        scene.map((s) => s.replace('Anne', 'Ana')),
      );
    }
    // Twins: someone who came in before the cue joins the talk, and Tom goes on.
    const net =
      'Tom was mending the net when I came in.\n\n“You’re late,” said Tom.\n\n' +
      '“The tide was against me,” I said.\n\n“It always is.”\n\n' +
      'Then Anne came in with the bread.\n\n“Morning,” said Anne.\n\n' +
      '“As I was saying, the boat needs a new mast.”';
    for (const entrance of [
      'Then Anne came in with the bread. Later she told me she had been crying.',
      'Then Anne came in with the bread. That night she cried herself to sleep.',
      // What she did or was going to do, not her arriving, and a cue three words in.
      'Just then Anne came in with the bread. She usually baked it in the evening.',
      'Suddenly Anne came in with the bread. She was leaving for London the next day.',
      'Just then Anne came in with the bread. I found out later she had been crying.',
      'Suddenly Anne came in with the bread. She returned to London the next day.',
      'Just then Anne came in with the bread. She usually came in the evening.',
    ]) {
      const text = net.replace('Then Anne came in with the bread.', entrance);
      expect(speakers(text, 'en').at(-1)).toBe('Tom [speech]');
    }
    // Nor does time passing in a sentence about something else or a wait that is no arrival.
    const fire = (bridge: string) =>
      'Tom was mending the net when I came in.\n\n“You’re late,” said Tom.\n\n' +
      `“The tide was against me,” I said.\n\n“It always is.”\n\n${bridge}\n\n` +
      '“Good evening,” said Anne.\n\n“Sit down, girl. Your brother has news.”\n\n“What news?”';
    for (const bridge of [
      'I saw Anne by the fire. She worked late that night, as she did every night.',
      'I saw Anne by the fire. She said she was leaving the next day.',
      'Tom’s daughter Anne had been in bed with a fever until that evening.',
      // A verb of arriving in another sense, a habit, a look ahead, another clause's time or
      // someone else's report.
      'I saw Anne by the fire. She appeared tired after the long walk that evening.',
      'I saw Anne by the fire. She returned to Leeds the next day.',
      'I saw Anne by the fire. She knocked the ash from her pipe that evening.',
      'I saw Anne by the fire. She showed no sign of it that evening.',
      'I saw Anne by the fire. She usually came in the evening, after the milking.',
      'I saw Anne by the fire. She only came down in the evening.',
      'I saw Anne by the fire. She came to tell me what had happened that night.',
      'I saw Anne by the fire. She came that evening, Tom said, because her house was cold.',
      'I saw Anne by the fire. A few weeks later she would be married and gone.',
      'I saw Anne by the fire. She appeared in better spirits that evening.',
      'I saw Anne by the fire. She knocked back a glass of brandy that evening.',
      'I saw Anne by the fire. She showed off her new shawl that evening.',
      'I saw Anne by the fire. She returned my letter unopened the next day.',
      'I saw Anne by the fire. She came to a decision that evening.',
      'I saw Anne by the fire. She came every day in the evening.',
      // Her own wait, someone who has spoken coming with her, or coming back.
      'Tom’s daughter Anne did not leave her bed until that evening.',
      'Tom’s daughter Anne said nothing until that evening.',
      'Tom went out to meet his daughter at the gate. Then Anne and Tom came in together that evening.',
      'I saw Anne by the fire. Tom went out to the boat. He came back later with the lamp.',
    ]) {
      expect(speakers(fire(bridge), 'en').slice(-3)).toEqual([
        'Anne [speech]',
        'Tom [speech]',
        'Anne [speech]',
      ]);
    }
    const fuego = (bridge: string) =>
      'Tomás remendaba la red cuando entré.\n\n—Llegas tarde —dijo Tomás.\n\n' +
      `—La marea venía en contra —respondí.\n\n—Siempre viene en contra.\n\n${bridge}\n\n` +
      '—Buenas noches —dijo Ana.\n\n—Siéntate, hija, que tu hermano trae noticias.\n\n' +
      '—¿Qué noticias?';
    for (const bridge of [
      'Allí estaba Ana, junto al fuego. Hacía frío esa noche.',
      'Vi a Ana junto al fuego. Solía coser por la noche.',
      'Vi a Ana junto al fuego. Nadie quería salir esa noche.',
      'Vi a Ana junto al fuego. Volvió a Madrid al día siguiente.',
      'Allí estaba Ana, junto al fuego. Volvió a llover esa noche.',
      'Vi a Ana junto al fuego. Llegó a pensar esa noche que no la quería nadie.',
      'Vi a Ana junto al fuego. Llamó a su madre esa noche, pero no contestó nadie.',
      'Allí estaba Ana, junto al fuego. Llegó la tormenta por la noche y nadie quiso salir.',
      'Vi a Ana junto al fuego. Unas pocas semanas más tarde se casaría con el maestro.',
      'Vi a Ana junto al fuego. ¿Vino a cenar al día siguiente? No lo recuerdo.',
      'Ana no salió de su cuarto hasta esa noche.',
      'La hija de Tomás, Ana, no se fue hasta esa noche.',
      'Vi a Ana junto al fuego. Tomás bajó a ver la barca. Volvió empapado más tarde.',
      'Vi a Ana junto al fuego. Volvió a hablarme de la guerra esa noche.',
      'Vi a Ana junto al fuego. Llegó a odiarme más tarde.',
      'Vi a Ana junto al fuego. Entró en razón esa noche.',
      'Vi a Ana junto al fuego. Volvió en sí esa noche.',
    ]) {
      expect(speakers(fuego(bridge), 'es').slice(-3)).toEqual([
        'Ana [speech]',
        'Tomás [speech]',
        'Ana [speech]',
      ]);
    }
    // "my friend had left" reads like "The boy had left.", someone who never spoke leaving, which
    // ends no talk: Tom goes on.
    const friend = en('When I came back, my friend had left, and Anne was waiting.');
    expect(speakers(friend, 'en').slice(-4)).toEqual([
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
      'Tom [speech]',
    ]);
  });

  it('starts a scene once someone the teller waited for arrives, also after a plan to come', () => {
    const scene = ['Anne [speech]', 'Narrator [speech]', 'Anne [speech]', 'Narrator [speech]'];
    const en = (bridge: string) =>
      'I met Tom at the station.\n\n“You’re late,” said Tom.\n\n“The train was slow,” I said.\n\n' +
      `“It always is.”\n\n${bridge}\n\n` +
      '“How was the trip?” asked Anne.\n\n“Long.”\n\n“Did Tom meet you?”\n\n“He did.”';
    const tomAnne = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    // A plan to come is no coming in when the narration goes on to tell of the arrival, in the
    // same paragraph or a later one.
    for (const bridge of [
      'I had written to Anne. Then Anne agreed to come. She arrived that evening.',
      'I wrote to the farm. Then Anne agreed to come.\n\nShe arrived the next morning.',
    ]) {
      expect(speakers(en(bridge), 'en').slice(-4)).toEqual(scene);
      expect(speakers(en(bridge), 'en', tomAnne).slice(-4)).toEqual(scene);
    }
    // Having driven or walked over, back or round counts as arriving.
    expect(speakers(en('Anne had driven over that evening.'), 'en', tomAnne).slice(-4)).toEqual(
      scene,
    );
    // A name that is also a month or a modal verb arrives like any other.
    const tomMay = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['may', 'May', 'female'],
    ]);
    const may = en('I had written to May. A few weeks later May knocked on my door.').replace(
      'asked Anne',
      'asked May',
    );
    expect(speakers(may, 'en', tomMay).slice(-4)).toEqual(
      scene.map((s) => s.replace('Anne', 'May')),
    );
    // Someone already there who comes over to show something starts no scene, even when the
    // narration says what she told the teller later.
    const net =
      'Tom was mending the net when I came in.\n\n“You’re late,” said Tom.\n\n' +
      '“The tide was against me,” I said.\n\n“It always is.”\n\n' +
      'Then Anne came to show me the letter. Later she told me Tom returned it to her unopened.\n\n' +
      '“Good evening,” said Anne.\n\n“Sit down, girl. Your brother has news.”\n\n“What news?”';
    expect(speakers(net, 'en', tomAnne).slice(-3)).toEqual([
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
    ]);
  });

  it('matches a named narrator by its name and aliases', () => {
    const aliased = baseCast('en').map((c) =>
      c.role === 'narrator' ? { ...c, aliases: ['Watson'] } : c,
    );
    const first = '“You look tired, Watson,” said Holmes.\n\n“I slept badly.”\n\n“So did I.”';
    expect(speakers(first, 'en', aliased)).toEqual([
      'Holmes [speech]',
      'Narrator [speech]',
      'Holmes [speech]',
    ]);
    expect(newNames(first, 'en', aliased)).toEqual(['Holmes']);

    const renamed = baseCast('en').map((c) =>
      c.role === 'narrator' ? { ...c, name: 'John Watson' } : c,
    );
    const second = '“Sit down, Watson,” said Holmes.\n\n“Thank you.”\n\n“Hello,” said Watson.';
    expect(speakers(second, 'en', renamed)).toEqual([
      'Holmes [speech]',
      'John Watson [speech]',
      'John Watson [speech]',
    ]);
    expect(newNames(second, 'en', renamed)).toEqual(['Holmes']);
  });

  it('gives Spanish pro-drop first-person tags to the narrator', () => {
    const text =
      '—¿Eres tú, Inés? —preguntó Doña Remedios desde la cocina.\n\n' +
      '—Soy yo, abuela —respondí.\n\n' +
      '—Llegas tarde.\n\n' +
      '—El autobús se rompió en la cuesta.\n\n' +
      'Dejé la maleta junto a la escalera.\n\n' +
      '—¿Te quedas todo el verano? —le pregunté a Julián.\n\n' +
      '—Eso depende —dijo Julián.\n\n' +
      '—Hola —dije.';
    expect(speakers(text, 'es')).toEqual([
      'Doña Remedios [speech]',
      'Narrator [speech]',
      'Doña Remedios [speech]',
      'Narrator [speech]',
      'Narrator [speech]',
      'Julián [speech]',
      'Narrator [speech]',
    ]);
    expect(newNames(text, 'es')).not.toContain('Inés');
  });

  it('reads Spanish first-person forms, and lines said to the narrator', () => {
    const text =
      '—¿Te quedas? —le pregunté a Julián.\n\n' +
      '—Eso depende —dijo Julián.\n\n' +
      'Se quedó callado un momento.\n\n' +
      '—De ti —me dijo.';
    expect(speakers(text, 'es')).toEqual([
      'Narrator [speech]',
      'Julián [speech]',
      'Julián [speech]',
    ]);
    expect(speakers('—¿Qué haces aquí? —pregunto.', 'es')).toEqual(['Narrator [speech]']);
    expect(speakers('—Miente —pensé.', 'es')).toEqual(['Narrator [thought]']);
    expect(speakers('—¡Fuera! —grité.', 'es')).toEqual(['Narrator [speech, shout]']);
    // "grito" is a noun here, not "I shout".
    expect(speakers('—¡Fuego! —un grito llegó desde la cocina.', 'es')).toEqual([
      'Unknown [speech]',
    ]);
  });

  it('never gives "he" or "she" to the narrator', () => {
    expect(speakers('“I am here,” I said.\n\n“Good,” she said.', 'en')).toEqual([
      'Narrator [speech]',
      'Unknown [speech]',
    ]);
    expect(speakers('“Hi,” I said. “Hello,” she said.', 'en')).toEqual([
      'Narrator [speech]',
      'Unknown [speech]',
    ]);
    const tom = castWith('en', [['tom', 'Tom', 'male']]);
    const morning = '“Morning,” I said.\n\n“Morning,” said Tom.\n\n';
    for (const line of ['“Is it going to rain?” she asked.', '“Rain later,” someone said.']) {
      expect(speakers(morning + line, 'en', tom).at(-1)).not.toBe('Narrator [speech]');
    }
    // A self-introduction makes the narrator present, but still not "she".
    const kit =
      'My name is Kit. I keep the lighthouse.\n\n“Morning,” said Tom.\n\n' +
      '“Is it going to rain?” she asked.';
    expect(speakers(kit, 'en', tom).at(-1)).not.toBe('Narrator [speech]');
  });

  it('never gives a Spanish third-person tag to the narrator', () => {
    const lucia =
      'Cuando abrí la puerta, Lucía estaba sentada en la escalera.\n\n' +
      '—¿Qué haces aquí? —le pregunté.\n\n—Esperarte.\n\n—¿Desde cuándo?\n\n—Desde las seis.\n\n' +
      'Me senté a su lado. Olía a lluvia y a tabaco.\n\n' +
      '—Han echado a mi padre del trabajo —dijo por fin.\n\n—Lo siento.\n\n—No lo sientas.';
    expect(speakers(lucia, 'es')).toEqual([
      'Narrator [speech]',
      'Lucía [speech]',
      'Narrator [speech]',
      'Lucía [speech]',
      'Lucía [speech]',
      'Narrator [speech]',
      'Lucía [speech]',
    ]);
    const julian =
      '—¿Te quedas? —le pregunté a Julián.\n\n—Eso depende —dijo Julián.\n\n' +
      'Se quedó callado un momento.\n\n—De ti —dijo.';
    expect(speakers(julian, 'es').at(-1)).toBe('Julián [speech]');
    const added = '—Hola —dijo Ana.\n\n—Hola —respondí.\n\n—Y hace frío —añadió.';
    expect(speakers(added, 'es').at(-1)).toBe('Ana [speech]');
    const colon =
      '—Hola —dije.\n\n—Hola —respondió Ana.\n\nSe volvió hacia mí y dijo:\n\n—Hace frío.';
    expect(speakers(colon, 'es').at(-1)).toBe('Ana [speech]');
    const abuela =
      '—¿Eres tú, Inés? —preguntó una voz desde la cocina.\n\n—Soy yo, abuela —respondí.\n\n' +
      'Fui a buscarla. Estaba de pie junto al fogón.\n\n—Estás más flaca —dijo al fin.\n\n' +
      '—Estoy igual.';
    expect(speakers(abuela, 'es').slice(-2)).toEqual(['una voz [speech]', 'Narrator [speech]']);
    // Only in a first-person part: elsewhere "—dijo" may be a narrator the user named Nick.
    const nick = castWith('es', [['amy', 'Amy', 'female']]).map((c) =>
      c.role === 'narrator' ? { ...c, name: 'Nick' } : c,
    );
    const silence =
      '—Hola —dijo Amy.\n\n—Hola —respondió Nick.\n\n—¿Qué tal? —dijo Amy.\n\n' +
      'Hubo un silencio largo.\n\n—Bien —dijo.';
    expect(speakers(silence, 'es', nick).at(-1)).toBe('Nick [speech]');
  });

  it('keeps imperfect tags, which may be the narrator’s own', () => {
    const father =
      '—Ya estoy en casa —le dije a mi padre aquella primera noche.\n\n' +
      'Desde entonces mi padre me esperaba siempre en la cocina.\n\n' +
      '—¿Cómo te ha ido? —me preguntaba.\n\n—Bien —respondía.';
    expect(speakers(father, 'es')).toEqual([
      'Narrator [speech]',
      'mi padre [speech]',
      'Narrator [speech]',
    ]);
    const hope =
      '—¿Vienes mañana? —le pregunté a Ana.\n\n—No lo sé —respondió Ana.\n\n' +
      'Me quedé mirando la ventana.\n\n«Ojalá venga», pensaba.';
    expect(speakers(hope, 'es').at(-1)).toBe('Narrator [thought]');
    const story =
      '—Abuela, cuéntame otro —le dije la primera noche.\n\n—Mañana —respondió mi abuela.\n\n' +
      'Desde entonces, cada noche, yo no me daba por vencida.\n\n—Uno cortito —decía.';
    expect(speakers(story, 'es').at(-1)).toBe('Narrator [speech]');
  });

  it('reads English first-person tags in their usual shapes', () => {
    for (const text of ['“No,” I’d said.', "“No,” I'd said."]) {
      expect(speakers(text, 'en')).toEqual(['Narrator [speech]']);
      expect(newNames(text, 'en')).toEqual([]);
    }
    expect(speakers('“Where are you going?” I asked Holmes.\n\n“Out.”', 'en')).toEqual([
      'Narrator [speech]',
      'Holmes [speech]',
    ]);
    expect(speakers('“Where?” asked Anne.\n\nI turned to her and said, “Home.”', 'en')).toEqual([
      'Anne [speech]',
      'Narrator [speech]',
    ]);
    expect(
      speakers('“No,” I had said.\n\n“No,” I would say.\n\n“No,” I finally said.', 'en'),
    ).toEqual(['Narrator [speech]', 'Narrator [speech]', 'Narrator [speech]']);
    expect(speakers('I turned to Anne and said:\n\n“Go.”', 'en')).toEqual(['Narrator [speech]']);
    expect(speakers('“Where?” I ask.', 'en')).toEqual(['Narrator [speech]']);
  });

  it('turns first-person rules on for intros and colon intros by the narrator', () => {
    const kit = (middle: string) =>
      'My uncle was in the kitchen, mending a net by the fire.\n\n' +
      `“You’re late, Kit,” said Uncle Abel.\n\n${middle}\n\n` +
      '“The tide is always against you, Kit.”\n\n“Then I shall have to row harder.”';
    for (const middle of [
      'I shut the door behind me and said, “The tide was against me.”',
      'I said to him, as I hung my wet coat on the hook by the door, “The tide was against me.”',
      'I shut the door behind me and said:\n\n“The tide was against me.”',
      'Then I said:\n\n“The tide was against me.”',
      // Someone the narrator acts on is no subject of the "and said".
      'I hugged my uncle and said, “The tide was against me.”',
      'I gave my uncle the fish and said, “The tide was against me.”',
      // Nor is a relative clause the commas close, and a past verb or a second "I" is the
      // narrator's own.
      'I turned to Uncle Abel, who was mending the net, and said, “The tide was against me.”',
      'I thought for a moment and said, “The tide was against me.”',
      'I think I sighed and said, “The tide was against me.”',
    ]) {
      expect(speakers(kit(middle), 'en').at(-1)).toBe('Narrator [speech]');
      expect(newNames(kit(middle), 'en')).toEqual(['Uncle Abel']);
    }
    const ines = (middle: string) =>
      'Mi abuela estaba en la cocina, junto al fuego.\n\n—Llegas tarde, Inés —dijo Rosa.\n\n' +
      `${middle}\n\n—La marea estaba en contra.\n\n` +
      '—La marea siempre está en contra, Inés.\n\n—Entonces remaré más fuerte.';
    for (const middle of ['Cerré la puerta y le dije:', 'Me volví como si nada y le decía:']) {
      expect(speakers(ines(middle), 'es').at(-1)).toBe('Narrator [speech]');
      expect(newNames(ines(middle), 'es')).toEqual(['Rosa']);
    }
  });

  it('turns first-person rules on for a coordinated "I" in the present, with a modal or an aside', () => {
    const line = '“The tide was against me.”';
    const now = (middle: string) =>
      'My uncle is in the kitchen, mending a net by the fire.\n\n' +
      `“You’re late, Kit,” says Uncle Abel.\n\n${middle}\n\n` +
      '“The tide is always against you, Kit.”\n\n“Then I’ll have to row harder.”';
    const then = (middle: string) =>
      'My uncle was in the kitchen, mending a net by the fire.\n\n' +
      `“You’re late, Kit,” said Uncle Abel.\n\n${middle}\n\n` +
      '“The tide is always against you, Kit.”\n\n“Then I shall have to row harder.”';
    for (const text of [
      now(`I feel my face go hot and say, ${line}`),
      now(`I can’t meet his eyes and say, ${line}`),
      now(`I’m soaked to the skin and say, ${line}`),
      then(`I must have blushed and said, ${line}`),
      then(`I would always hang my coat by the door and say, ${line}`),
      then(`I laughed, I think, and said, ${line}`),
      then(`I went to my uncle, for he had called me, and said, ${line}`),
    ]) {
      expect(speakers(text, 'en').at(-1)).toBe('Narrator [speech]');
      expect(newNames(text, 'en')).not.toContain('Kit');
    }
    const ines = (middle: string) =>
      'Mi abuela estaba en la cocina, junto al fuego.\n\n—Llegas tarde, Inés —dijo Rosa.\n\n' +
      `${middle}\n\n—La marea estaba en contra.\n\n` +
      '—La marea siempre está en contra, Inés.\n\n—Entonces remaré más fuerte.';
    for (const middle of [
      'Yo me asomaba a ver si llovía y le decía:',
      'Yo me senté a su lado por si acaso y le decía:',
      'Yo me reía como cuando era niña y le decía:',
    ]) {
      expect(speakers(ines(middle), 'es').at(-1)).toBe('Narrator [speech]');
      expect(newNames(ines(middle), 'es')).toEqual(['Rosa']);
    }
    // Twins: after "si" or "como cuando" a subject that shows says the verb, in a third-person part.
    const rosa = (intro: string) =>
      `La señora Rosa estaba junto a la ventana.\n\n${intro}\n\n—Ya ha llegado el chico.\n\n` +
      '—Ven aquí, Davy —dijo Rosa.\n\n—Sí, señora.\n\n—Y trae la cesta.';
    for (const intro of [
      'Yo no sé si la cocinera suspiraba y le decía:',
      'Yo la recuerdo como cuando la cocinera suspiraba y le decía:',
    ]) {
      expect(speakers(rosa(intro), 'es').at(-2)).toBe('Davy [speech]');
    }
  });

  it('turns first-person rules on for a later "I", a past "would" or "si" before a thing', () => {
    const line = '“The tide was against me.”';
    const then = (middle: string) =>
      'My uncle was in the kitchen, mending a net by the fire.\n\n' +
      `“You’re late, Kit,” said Uncle Abel.\n\n${middle}\n\n` +
      '“The tide is always against you, Kit.”\n\n“Then I shall have to row harder.”';
    for (const middle of [
      `I think I sighed, and said, ${line}`,
      `I’m afraid I laughed, and said, ${line}`,
      `I should not have laughed, but I did, and said, ${line}`,
      `I think I sighed, and said:\n\n${line}`,
      `I turned to Uncle Abel, who I suppose had heard it all before, and said, ${line}`,
      `I wouldn’t hear of it and said, ${line}`,
      `I would not let him carry the nets and said, ${line}`,
      `I must not have heard him properly, and said, ${line}`,
      // An aside's own past verb is the one "and said" joins, and an "I" after "when" says it
      // when its clause runs on into the verb.
      `I need a drink, I thought, and said, ${line}`,
      `I will not cry, I told myself, and said, ${line}`,
      `I’m late, I realised, and said, ${line}`,
      `I remember the night when I turned to him and said, ${line}`,
      `I suppose that was when I turned to him and said, ${line}`,
    ]) {
      expect(speakers(then(middle), 'en').at(-1)).toBe('Narrator [speech]');
      expect(newNames(then(middle), 'en')).not.toContain('Kit');
    }
    const ines = (middle: string) =>
      'Mi abuela estaba en la cocina, junto al fuego.\n\n—Llegas tarde, Inés —dijo Rosa.\n\n' +
      `${middle}\n\n—La marea estaba en contra.\n\n` +
      '—La marea siempre está en contra, Inés.\n\n—Entonces remaré más fuerte.';
    for (const middle of [
      'Yo la miraba como si la viera por primera vez y le decía:',
      'Yo los miraba como si los viera por primera vez y les decía:',
      'Yo no sabía si la volvería a ver y le decía:',
      'Yo me asomaba a ver si la sopa estaba lista y le decía:',
      'Yo no sabía si las redes aguantarían y le preguntaba:',
      'Yo seguía remando como si el viento no existiera y le decía:',
    ]) {
      expect(speakers(ines(middle), 'es').at(-1)).toBe('Narrator [speech]');
      expect(newNames(ines(middle), 'es')).toEqual(['Rosa']);
    }
    // Twins: an "I" in an aside or in a clause "when" opens does not say the verb, nor does the
    // teller when someone else may: "I would add that…", "si su criada…" (third person: Davy).
    const rosa = (intro: string) =>
      `Mrs. Rosa was at the window.\n\n${intro}\n\n“The boy is here.”\n\n` +
      '“Come here, Davy,” said Mrs. Rosa.\n\n“Yes, ma’am.”\n\n“And bring the basket.”';
    for (const intro of [
      'I suppose, as I said, the cook sighed and said:',
      'I think, when I was young, the cook sighed and said:',
      'I would add that the cook sighed and said:',
    ]) {
      expect(speakers(rosa(intro), 'en').at(-2)).toBe('Davy [speech]');
    }
    const senora = (intro: string) =>
      `La señora Rosa estaba junto a la ventana.\n\n${intro}\n\n—Ya ha llegado el chico.\n\n` +
      '—Ven aquí, Davy —dijo Rosa.\n\n—Sí, señora.\n\n—Y trae la cesta.';
    expect(speakers(senora('Yo no sé si su criada suspiraba y le decía:'), 'es').at(-2)).toBe(
      'Davy [speech]',
    );
    // "como cuando" before a reflexive "se" is someone else's clause: the teller would say "me
    // volvía". With no subject at all it is read as the teller's, as in "Yo me reía como cuando era
    // niña y le decía:", though "Yo la recuerdo como cuando suspiraba y le decía:" is Rosa's: the
    // two read alike.
    for (const intro of [
      'Yo la recuerdo como cuando se volvía hacia su marido y le decía:',
      'Yo la recuerdo como cuando se sentaba junto al fuego y le decía:',
      'Yo la veía como que se enfadaba y le decía:',
    ]) {
      expect(speakers(senora(intro), 'es').at(-2)).toBe('Davy [speech]');
    }
    const suspiraba = senora('Yo la recuerdo como cuando suspiraba y le decía:');
    expect(speakers(suspiraba, 'es').at(-2)).toBe('Narrator [speech]');
    // A "se" before another clitic is the teller's own: "se me olvidaba", "se lo contaba". So is
    // one before a present form, which is nobody's: "como cuando se reza en misa".
    for (const middle of [
      'Yo hacía como que se me olvidaba y le decía:',
      'Yo me reía como cuando se lo contaba a mi madre y le decía:',
      'Yo me quedaba callada, como cuando se reza en misa, y luego le decía:',
      'Yo sonreía como cuando se recibe una buena noticia y le decía:',
    ]) {
      expect(speakers(ines(middle), 'es').at(-1)).toBe('Narrator [speech]');
      expect(newNames(ines(middle), 'es')).toEqual(['Rosa']);
    }
  });

  it('turns first-person rules on for lines said to the narrator', () => {
    const abuela =
      'Mi abuela estaba en la cocina.\n\n—Llegas tarde, Inés —me dijo sin volverse.\n\n' +
      '—El autobús se rompió.\n\n—Siempre se rompe algo, Inés.\n\n—Esta vez es verdad.';
    expect(speakers(abuela, 'es')).toEqual([
      'mi abuela [speech]',
      'Narrator [speech]',
      'mi abuela [speech]',
      'Narrator [speech]',
    ]);
    expect(newNames(abuela, 'es')).toEqual(['mi abuela']);
    const kit = (tag: string) =>
      `My uncle was in the kitchen.\n\n“You’re late, Kit,” ${tag}.\n\n` +
      '“The tide was against me.”\n\n“The tide is always against you, Kit.”\n\n“Then I row.”';
    for (const tag of ['he told me', 'my uncle said to me', 'my uncle asked me']) {
      expect(speakers(kit(tag), 'en').at(-1)).toBe('Narrator [speech]');
      expect(newNames(kit(tag), 'en')).toEqual(['my uncle']);
    }
    const clerk =
      'The clerk looked up from his ledger.\n\n“Late again, Kit?” I was asked.\n\n' +
      '“The tide was against me.”\n\n“Sign here, Kit.”\n\n“Yes, sir.”';
    expect(speakers(clerk, 'en')).toEqual([
      'the clerk [speech]',
      'Narrator [speech]',
      'the clerk [speech]',
      'Narrator [speech]',
    ]);
    expect(newNames(clerk, 'en')).toEqual(['the clerk']);
  });

  it('reads present-tense tags with a name, "to" someone, "myself" or an adverb', () => {
    const text =
      '“You’re up early,” said Mom.\n\n“I couldn’t sleep,” I answer quietly.\n\n' +
      '“Bad dreams?”\n\n“Not really,” I tell Mom.\n\n“Okay.”';
    expect(speakers(text, 'en')).toEqual([
      'Mom [speech]',
      'Narrator [speech, whisper]',
      'Mom [speech]',
      'Narrator [speech]',
      'Mom [speech]',
    ]);
    expect(speakers('“Shh,” I whisper to her.', 'en')).toEqual(['Narrator [speech, whisper]']);
    expect(speakers('“Nearly,” I tell Mrs. Pruett.\n\n“Good.”', 'en')).toEqual([
      'Narrator [speech]',
      'Mrs. Pruett [speech]',
    ]);
    expect(speakers('“Again?” I ask Mom again.', 'en')).toEqual(['Narrator [speech]']);
    expect(speakers('“Calm down,” I tell myself.', 'en')).toEqual(['Narrator [thought]']);
    // Thinking stays strict: what follows is a clause, not someone spoken to.
    expect(speakers('“Hello.” I think Mom knew.', 'en')).toEqual(['Unknown [speech]']);
    // A question with "I" after its auxiliary is no tag, in either tense.
    const mom = castWith('en', [['mom', 'Mom', 'female']]);
    const turns = ['Mom [speech]', 'Narrator [speech]', 'Mom [speech]'];
    const dad =
      'Mom set down her fork. “Is something wrong?” Should I tell Dad? I couldn’t.\n\n' +
      '“Nothing,” I said.\n\n“Okay.”';
    expect(speakers(dad, 'en', mom)).toEqual(turns);
    expect(newNames(dad, 'en', mom)).toEqual([]);
    const again =
      'Mom grabs her keys. “Ready?” Can I ask again? Better not.\n\n“Yes,” I say.\n\n“Go.”';
    expect(speakers(again, 'en', mom)).toEqual(turns);
    expect(speakers(dad.replace('Should', 'Shouldn’t'), 'en', mom)).toEqual(turns);
    // An order that only stresses ("Only then did I tell him.") is still a tag.
    const nor = '“No,” Mom says.\n\n“Please?” Nor do I reply.\n\n“No.”';
    expect(speakers(nor, 'en', mom)).toEqual(turns);
    const parents = castWith('en', [
      ['dad', 'Dad', 'male'],
      ['mom', 'Mom', 'female'],
    ]);
    const then =
      '“Morning,” said Dad.\n\n“Morning,” I said.\n\n“Sleep well?”\n\n“Not really.”\n\n' +
      'He poured the coffee and waited. Only then did I tell him. “Mom called.”\n\n“When?”';
    expect(speakers(then, 'en', parents).slice(-2)).toEqual(['Narrator [speech]', 'Dad [speech]']);
    // Someone's reaction after the narrator's clause tags the line, in either tense.
    const family = castWith('en', [
      ['mom', 'Mom', 'female'],
      ['jonah', 'Jonah', 'male'],
    ]);
    const laughs =
      '“Morning,” says Jonah.\n\n“Morning,” I say.\n\n' +
      'I whisper to Mom, and Jonah laughs. “I heard that.”';
    expect(speakers(laughs, 'en', family).at(-1)).toBe('Jonah [speech, happy]');
    // After "the" or a possessive such a form is a noun, so the beat still names the speaker.
    const gulls = '“Hi,” said Jonah.\n\nMom heard the cries of the gulls. “Listen.”';
    expect(speakers(gulls, 'en', family)).toEqual(['Jonah [speech]', 'Mom [speech]']);
  });

  it('reads "I was asked" and "I’m told" as said to the narrator', () => {
    const clerk =
      '“Morning,” I said.\n\nThe clerk looked up from his ledger.\n\n“Name?” I was asked.\n\n' +
      '“Kit Morrow.”\n\n“Business?”\n\n“Family.”';
    const turns = [
      'Narrator [speech]',
      'the clerk [speech]',
      'Narrator [speech]',
      'the clerk [speech]',
      'Narrator [speech]',
    ];
    expect(speakers(clerk, 'en')).toEqual(turns);
    const present =
      '“Morning,” I say.\n\nThe clerk looks up from his ledger.\n\n“Name?” I’m asked.\n\n' +
      '“Kit Morrow.”\n\n“Business?”\n\n“Family.”';
    expect(speakers(present, 'en')).toEqual(turns);
    const anne = castWith('en', [['anne', 'Anne', 'female']]);
    const saidToMe =
      '“Morning,” I said.\n\n“Good morning,” Anne said to me.\n\n' +
      '“Where are you from?” I was asked.\n\n“Leeds.”';
    expect(speakers(saidToMe, 'en', anne)).toEqual([
      'Narrator [speech]',
      'Anne [speech]',
      'Anne [speech]',
      'Narrator [speech]',
    ]);
    expect(speakers('“Name?” I was asked.', 'en')).toEqual(['Unknown [speech]']);
    expect(speakers('“Name?” I’m also asked.', 'en')).toEqual(['Unknown [speech]']);
    const colon = 'The clerk looked up from his ledger. Then I was asked:\n\n“Name?”';
    expect(speakers(colon, 'en')).toEqual(['the clerk [speech]']);
  });

  it('reads hearsay about a line by the verb it reports ("I was told I said")', () => {
    const tom = castWith('en', [['tom', 'Tom', 'male']]);
    expect(speakers('“Hello,” said Tom.\n\n“Yes,” I was told I answered.', 'en', tom)).toEqual([
      'Tom [speech]',
      'Narrator [speech]',
    ]);
    const said = '“Morning,” I said.\n\n“Hello,” said Tom.\n\n“Yes,” I’m told I said.';
    expect(speakers(said, 'en', tom)).toEqual([
      'Narrator [speech]',
      'Tom [speech]',
      'Narrator [speech]',
    ]);
    expect(speakers('“I love you,” I’m told I whispered.', 'en')).toEqual([
      'Narrator [speech, whisper]',
    ]);
    expect(speakers('“Yes,” so I was told I had said.', 'en')).toEqual(['Narrator [speech]']);
    // Without a reported speech verb the line is still said to the narrator.
    expect(speakers('“Sit,” I was told I could.', 'en')).toEqual(['Unknown [speech]']);
  });

  it('gives the narrator the answer to what an unknown voice asked them', () => {
    const turns = [
      'Unknown [speech]',
      'Narrator [speech]',
      'Unknown [speech]',
      'Narrator [speech]',
    ];
    const es =
      '—¿Cómo te llamas? —me preguntó.\n\n—Inés.\n\n—¿Y de dónde vienes?\n\n' +
      '—De la capital —respondí.';
    expect(speakers(es, 'es')).toEqual(turns);
    const en =
      '“What’s your name?” somebody asked me.\n\n“Kit.”\n\n“Where from?”\n\n' +
      '“The lighthouse,” I said.';
    expect(speakers(en, 'en')).toEqual(turns);
    // Only the very next line answers: not after a scene break.
    expect(speakers('—Adiós —me dijo.\n\n* * *\n\n—¿Quién anda ahí?', 'es')).toEqual([
      'Unknown [speech]',
      'Unknown [speech]',
    ]);
    // Third-person parts keep their turn-taking: there the unknown voice is not answered.
    const anne = castWith('en', [['anne', 'Anne', 'female']]);
    expect(speakers('“Where are you going, Anne?” somebody asked.\n\n“Home.”', 'en', anne)).toEqual(
      ['Unknown [speech]', 'Unknown [speech]'],
    );
  });

  it('reads talking to oneself as thought', () => {
    expect(speakers('“Fool,” I told myself.', 'en')).toEqual(['Narrator [thought]']);
    expect(speakers('“Hello.” I think she was lying.', 'en')).toEqual(['Unknown [speech]']);
    expect(speakers('—¿Dónde estará? —se preguntó Ana.', 'es')).toEqual(['Ana [thought]']);
    expect(speakers('«Ya vendrá», pensaba Ana.', 'es')).toEqual(['Ana [thought]']);
    // "se rió" is laughing, not talking to oneself.
    expect(speakers('—Ya —se rió Ana.', 'es')).toEqual(['Ana [speech, happy]']);
  });

  it('lets the narrator answer in a two-person first-person exchange', () => {
    expect(
      speakers('“Hi,” I said.\n\n“Where were you?” asked Anne.\n\nI shrugged.\n\n“Nowhere.”', 'en'),
    ).toEqual(['Narrator [speech]', 'Anne [speech]', 'Narrator [speech]']);
    expect(
      speakers(
        '—Hola —dije.\n\n—¿Dónde estabas? —preguntó Ana.\n\nMe encogí de hombros.\n\n—En ningún sitio.',
        'es',
      ),
    ).toEqual(['Narrator [speech]', 'Ana [speech]', 'Narrator [speech]']);
  });

  it('gives the narrator the line after a first-person beat', () => {
    // Turn-taking alone would give the last line to Anne, who spoke before Tom.
    const en =
      '“Hi,” I said.\n\n“Where were you?” asked Anne.\n\n“Out,” said Tom.\n\n' +
      'I shrugged. “Nowhere.”';
    expect(speakers(en, 'en')).toEqual([
      'Narrator [speech]',
      'Anne [speech]',
      'Tom [speech]',
      'Narrator [speech]',
    ]);
    const es =
      '—Hola —dije.\n\n—¿Dónde estabas? —preguntó Ana.\n\n—Fuera —dijo Tomás.\n\n' +
      '—Nada —me encogí de hombros—. En ningún sitio.';
    expect(speakers(es, 'es')).toEqual([
      'Narrator [speech]',
      'Ana [speech]',
      'Tomás [speech]',
      'Narrator [speech]',
      'Narrator [speech]',
    ]);
  });

  it('never makes a character of the narrator’s own name', () => {
    const text = 'My name is Ishmael.\n\n“Where are you going?” asked the captain.\n\n“To sea.”';
    expect(speakers(text, 'en')).toEqual(['the captain [speech]', 'Narrator [speech]']);
    expect(newNames(text, 'en')).toEqual(['the captain']);
  });

  it('never makes a character of the name others call the narrator', () => {
    const kit =
      'Everyone in the village called me Kit.\n\n“Kit!” shouted my uncle.\n\n“Coming!” I said.\n\n' +
      '“Hurry, Kit.”\n\n“I am hurrying.”';
    expect(speakers(kit, 'en').at(-1)).toBe('Narrator [speech]');
    expect(newNames(kit, 'en')).toEqual(['my uncle']);
    const nena =
      'En el pueblo todos me decían Nena.\n\n—¡Nena! —gritó mi madre.\n\n—Ya voy —respondí.\n\n' +
      '—Date prisa, Nena.\n\n—Ya voy, ya voy.';
    expect(speakers(nena, 'es').at(-1)).toBe('Narrator [speech]');
    expect(newNames(nena, 'es')).toEqual(['mi madre']);
    const ines = 'Mi nombre era Inés, aunque nadie lo usaba.\n\n—¡Inés!\n\n—Ya voy —respondí.';
    expect(newNames(ines, 'es')).toEqual([]);
    const llamaba = 'Me llamaba Inés y tenía doce años.\n\n—¡Inés!\n\n—Ya voy —respondí.';
    expect(newNames(llamaba, 'es')).toEqual([]);
    // The narrator then answers to that name, also after a pause ("…"), which is no comma.
    const called = (intro: string, name: string, lang: Lang) =>
      lang === 'en'
        ? `${intro}\n\n“${name}!” shouted my uncle.\n\n“Coming!” I said.\n\n` +
          `“Hurry, ${name}.”\n\n“I am hurrying.”`
        : `${intro}\n\n—¡${name}! —gritó mi madre.\n\n—Ya voy —respondí.\n\n` +
          `—Date prisa, ${name}.\n\n—Ya voy, ya voy.`;
    for (const [intro, name, lang, other] of [
      ['My uncle calls me Kit.', 'Kit', 'en', 'my uncle'],
      ['They named me Kit.', 'Kit', 'en', 'my uncle'],
      ['My name is… Kit.', 'Kit', 'en', 'my uncle'],
      ['Mi nombre era Inés, aunque nadie lo usaba.', 'Inés', 'es', 'mi madre'],
      ['Me llamaba Inés y tenía doce años.', 'Inés', 'es', 'mi madre'],
      ['En casa me llamaron Inés.', 'Inés', 'es', 'mi madre'],
      ['Todos me dicen Inés.', 'Inés', 'es', 'mi madre'],
      ['Me llamo… Inés.', 'Inés', 'es', 'mi madre'],
    ] as const) {
      expect(speakers(called(intro, name, lang), lang).at(-1)).toBe('Narrator [speech]');
      expect(newNames(called(intro, name, lang), lang)).toEqual([other]);
    }
    // A name after a comma, or a possessive, is someone else: the one person brought in.
    const tom = (sentence: string) =>
      `“Morning,” I said.\n\nThe sun was up.\n\n${sentence}\n\n“Ready?”`;
    expect(speakers(tom('Everyone called me Tom.'), 'en').at(-1)).toBe('Unknown [speech]');
    for (const sentence of [
      'They called me, Tom included, a dreamer.',
      'Everyone called me Tom’s shadow.',
    ]) {
      expect(speakers(tom(sentence), 'en').at(-1)).toBe('Tom [speech]');
    }
    // A nickname after "call me" or "me llamaban" is the narrator's too.
    const oldMan =
      '“Where are you going?” asked Anne.\n\n“Home,” I said.\n\n' +
      'The children call me the old man, and old men go home early.\n\n“Why?”\n\n“Because.”';
    expect(speakers(oldMan, 'en')).toEqual([
      'Anne [speech]',
      'Narrator [speech]',
      'Anne [speech]',
      'Narrator [speech]',
    ]);
    expect(newNames(oldMan, 'en')).toEqual(['Anne']);
    const nina =
      '—¿Dónde estabas? —preguntó mi padre.\n\n—Fuera —respondí.\n\n' +
      'En casa me llamaban la niña, aunque ya tenía quince años.\n\n—¿Fuera dónde?\n\n—Por ahí.';
    expect(speakers(nina, 'es').at(-2)).toBe('mi padre [speech]');
    expect(newNames(nina, 'es')).toEqual(['mi padre']);
    // Someone calling the narrator, named after the verb, is still someone.
    const pablo = 'Aquella tarde me llamaba Pablo desde el patio.\n\n—¡Baja!\n\n—Ya voy —respondí.';
    expect(speakers(pablo, 'es')).toEqual(['Pablo [speech]', 'Narrator [speech]']);
    const madre = 'Desde la cocina me llamaba mi madre.\n\n—¡A comer!\n\n—Ya voy —respondí.';
    expect(speakers(madre, 'es')).toEqual(['mi madre [speech]', 'Narrator [speech]']);
  });

  it('brings in whoever opens the sentence after "called me." or "me llamaron."', () => {
    const uncle =
      '“Morning,” I said.\n\nThe kitchen was cold. Mother called me. My uncle was already at the ' +
      'table.\n\n“Sit down.”\n\n“Yes, sir,” I said.';
    expect(speakers(uncle, 'en')).toEqual([
      'Narrator [speech]',
      'my uncle [speech]',
      'Narrator [speech]',
    ]);
    const tom = castWith('en', [['tom', 'Tom', 'male']]);
    const door =
      '“Morning,” I said.\n\nThen she called me! Tom was already at the door.\n\n“Ready?”';
    expect(speakers(door, 'en', tom)).toEqual(['Narrator [speech]', 'Tom [speech]']);
    const abuela =
      '—Buenos días —dije.\n\nEstaba en el patio cuando me llamaron. La abuela me esperaba en la ' +
      'cocina.\n\n—Siéntate —dijo.\n\n—¿Pasa algo? —pregunté.\n\n—Nada.';
    expect(speakers(abuela, 'es')).toEqual([
      'Narrator [speech]',
      'la abuela [speech]',
      'Narrator [speech]',
      'la abuela [speech]',
    ]);
    const pablo = castWith('es', [['pablo', 'Pablo', 'male']]);
    const puerta = '—Buenos días —dije.\n\nMe llamaron. Pablo estaba en la puerta.\n\n—¿Vienes?';
    expect(speakers(puerta, 'es', pablo)).toEqual(['Narrator [speech]', 'Pablo [speech]']);
  });

  it('reads a nickname set off by emphasis, a dash, a colon or the question it answers', () => {
    const kit = (intro: string) =>
      `${intro}\n\n“Kit!” shouted my uncle.\n\n“Coming!” I said.\n\n“Hurry, Kit.”\n\n` +
      '“I am hurrying.”';
    for (const intro of ['Everyone in the village called me *Kit*.', 'My name is *Kit*.']) {
      expect(speakers(kit(intro), 'en').at(-1)).toBe('Narrator [speech]');
      expect(newNames(kit(intro), 'en')).toEqual(['my uncle']);
    }
    const nena =
      'En el pueblo todos me decían *Nena*.\n\n—¡Nena! —gritó mi madre.\n\n—Ya voy —respondí.\n\n' +
      '—Date prisa, Nena.\n\n—Ya voy, ya voy.';
    expect(speakers(nena, 'es').at(-1)).toBe('Narrator [speech]');
    expect(newNames(nena, 'es')).toEqual(['mi madre']);
    const anne = (sentence: string) =>
      `“Where are you going?” asked Anne.\n\n“Home,” I said.\n\n${sentence}\n\n“Why?”\n\n“Because.”`;
    for (const sentence of [
      'The children call me _the old man_, and old men go home early.',
      'The children call me—the old man—and old men go home early.',
      'They had one name for me; they called me: the old man.',
      'And what do the children call me? The old man. Old men go home early.',
    ]) {
      expect(speakers(anne(sentence), 'en').at(-2)).toBe('Anne [speech]');
      expect(newNames(anne(sentence), 'en')).toEqual(['Anne']);
    }
    const padre = (sentence: string) =>
      '—¿Dónde estabas? —preguntó mi padre.\n\n—Fuera —respondí.\n\n' +
      `${sentence}\n\n—¿Fuera dónde?\n\n—Por ahí.`;
    for (const sentence of [
      'En casa me llamaban _la niña_, aunque ya tenía quince años.',
      'En casa me llamaban —todavía me llaman— la niña, aunque ya tenía quince años.',
      '¿Y en casa, cómo me llamaban? La niña, aunque ya tenía quince años.',
    ]) {
      expect(speakers(padre(sentence), 'es').at(-2)).toBe('mi padre [speech]');
      expect(newNames(padre(sentence), 'es')).toEqual(['mi padre']);
    }
    // Twins: after a dash or a colon the sentence goes on, and "who" asks for whoever called.
    const uncle = (sentence: string) =>
      `“Morning,” I said.\n\n${sentence}\n\n“Sit down.”\n\n“Yes, sir,” I said.`;
    for (const sentence of [
      'Mother called me—my uncle was already at the table.',
      'Then Mother called me: my uncle was waiting in the hall.',
      'The phone rang at six. Who called me? My uncle, of course.',
    ]) {
      expect(speakers(uncle(sentence), 'en')[1]).toBe('my uncle [speech]');
    }
    for (const sentence of [
      'Who knew my name well enough to have called me? Mr. Collins, at the door.',
      'Then some one called me:—Mr. Collins, from the hall.',
    ]) {
      const cousin = `“Good morning,” I said.\n\n${sentence}\n\n“Good morning, cousin.”`;
      expect(speakers(cousin, 'en')[1]).toBe('Mr. Collins [speech]');
    }
    const abuela = (sentence: string) =>
      `—Buenos días —dije.\n\n${sentence}\n\n—Siéntate.\n\n—¿Qué pasa? —pregunté.`;
    for (const sentence of [
      'Me llamaron —la abuela estaba en la cocina— y bajé corriendo.',
      'Me llamaron: la abuela quería verme.',
      '¿Me llamaban? La abuela asomó la cabeza por la puerta.',
    ]) {
      expect(speakers(abuela(sentence), 'es')[1]).toBe('la abuela [speech]');
    }
  });

  it('reads a nickname after a parenthesis, a "―", a "¡" or with a phrase that qualifies it', () => {
    const kit = (intro: string) =>
      `${intro}\n\n“Kit!” shouted my uncle.\n\n“Coming!” I said.\n\n“Hurry, Kit.”\n\n` +
      '“I am hurrying.”';
    for (const intro of [
      'Everyone in the village called me (and still calls me) Kit.',
      'Everyone in the village called me ***Kit***.',
    ]) {
      expect(speakers(kit(intro), 'en').at(-1)).toBe('Narrator [speech]');
      expect(newNames(kit(intro), 'en')).toEqual(['my uncle']);
    }
    const nena =
      'En el pueblo todos me decían ―y aún me dicen― Nena.\n\n―¡Nena! ―gritó mi madre.\n\n' +
      '―Ya voy ―respondí.\n\n―Date prisa, Nena.\n\n―Ya voy, ya voy.';
    expect(speakers(nena, 'es').at(-1)).toBe('Narrator [speech]');
    expect(newNames(nena, 'es')).toEqual(['mi madre']);
    const anne = (sentence: string) =>
      `“Where are you going?” asked Anne.\n\n“Home,” I said.\n\n${sentence}\n\n“Why?”\n\n“Because.”`;
    for (const sentence of [
      'And what did the children call me?—the old man. Old men go home early.',
      'At school they called me—the girl with the red hair—and I hated it.',
      'What did the children call me? The old man of the lighthouse. Old men go home early.',
      'And the name the children called me? The old man. Old men go home early.',
      'There was but one name for me in that house; they called me:—the boy.',
    ]) {
      expect(speakers(anne(sentence), 'en').at(-2)).toBe('Anne [speech]');
      expect(newNames(anne(sentence), 'en')).toEqual(['Anne']);
    }
    const padre = (sentence: string) =>
      '—¿Dónde estabas? —preguntó mi padre.\n\n—Fuera —respondí.\n\n' +
      `${sentence}\n\n—¿Fuera dónde?\n\n—Por ahí.`;
    for (const sentence of [
      'En casa me llamaban (todavía me llaman) la niña, aunque ya tenía quince años.',
      '¿Y sabes cómo me llamaban? ¡La niña! Y eso que ya tenía quince años.',
      'En casa me llamaban… ¡la niña! Y eso que ya tenía quince años.',
      'En casa me llamaban: ¡la niña! Y eso que ya tenía quince años.',
      '¿Y sabes qué me decían? La niña. Y eso que ya tenía quince años.',
      'En casa me llamaban: la niña de la casa. Y eso que ya tenía quince años.',
      'En casa me llamaban —la niña de la casa— y eso que ya tenía quince años.',
      '¿Sabes cuál era el nombre con que me llamaban? La niña, aunque ya tenía quince años.',
      '¿Y el mote que me decían? La niña. Y eso que ya tenía quince años.',
    ]) {
      expect(speakers(padre(sentence), 'es').at(-2)).toBe('mi padre [speech]');
      expect(newNames(padre(sentence), 'es')).toEqual(['mi padre']);
    }
    // Twins: someone else after the same marks, or a verb after the phrase that follows them.
    const uncle = (sentence: string) =>
      `“Morning,” I said.\n\n${sentence}\n\n“Sit down.”\n\n“Yes, sir,” I said.`;
    for (const sentence of [
      'Mother called me—my uncle with his coat on was waiting.',
      'Mother called me—my uncle in the hall was waiting.',
      'Mother called me—my uncle in the hall—and I went down.',
      'Mother called me:—my uncle was waiting in the hall.',
      'And the name Mother called me? My uncle was laughing at it.',
      'Do you know the name of the man who called me? My uncle.',
    ]) {
      expect(speakers(uncle(sentence), 'en')[1]).toBe('my uncle [speech]');
    }
    const abuela = (sentence: string) =>
      `—Buenos días —dije.\n\n${sentence}\n\n—Siéntate.\n\n—¿Qué pasa? —pregunté.`;
    for (const sentence of [
      'Me llamaron (la abuela estaba en la cocina) y bajé corriendo.',
      'Me llamaron ―la abuela estaba en la cocina― y bajé corriendo.',
      'Me llamaron… ¡La abuela estaba furiosa!',
      'Me llamaron: la abuela de Pablo quería verme.',
      'Me llamaron —la abuela de Pablo estaba en la cocina— y bajé corriendo.',
      'Me llamaron: la abuela en la cocina quería verme.',
      'Me llamaron —la abuela en la cocina— y bajé corriendo.',
      '¿Oíste el nombre que me decían? La abuela se reía de él.',
      '¿Cuál de ellas me llamaba? La abuela, claro.',
      '¿Y el nombre de la mujer que me llamaba? La abuela, claro.',
    ]) {
      expect(speakers(abuela(sentence), 'es')[1]).toBe('la abuela [speech]');
    }
  });

  it('keeps an observing narrator out of other people’s conversation', () => {
    const text =
      'I sat in the corner while my aunt and the vicar argued about the roof.\n\n' +
      '“The roof must be mended,” said the vicar.\n\n' +
      '“With what money?” said my aunt.\n\n' +
      '“The parish will find it.”\n\n' +
      'I looked from one to the other.\n\n' +
      '“The parish has never found anything.”';
    expect(speakers(text, 'en')).toEqual([
      'the vicar [speech]',
      'my aunt [speech]',
      'the vicar [speech]',
      'my aunt [speech]',
    ]);
  });

  it('marks narration and "I" lines for whoever tells the passage', () => {
    const text = 'It rained.\n\n“Hi,” I said.\n\n“Hello,” said Anne.\n\n“Bye.”';
    const { result } = analyse(text, 'en');
    const marked = result.spans
      .filter((s) => s.teller)
      .map((s) => text.slice(s.start, s.end).trim());
    expect(marked).toEqual(['It rained.', '“Hi,”', 'I said.', 'said Anne.']);
    for (const span of result.spans.filter((s) => s.teller)) {
      expect(span.speaker).toEqual({ kind: 'cast', id: 'narrator' });
    }
  });

  it('marks lines the narrator says through an intro, a beat or a continued quote', () => {
    const marked = (text: string, lang: Lang, cast?: Character[]) =>
      analyse(text, lang, cast)
        .result.spans.filter((s) => s.mode !== 'narration')
        .map((s) => `${text.slice(s.start, s.end).trim()}${s.teller ? ' (I)' : ''}`);
    expect(marked('“Hi,” said Anne.\n\nI turned to Anne and said:\n\n“Go.”', 'en')).toEqual([
      '“Hi,”',
      '“Go.” (I)',
    ]);
    expect(marked('“Where were you?” asked Anne.\n\nI shrugged. “Nowhere.”', 'en')).toEqual([
      '“Where were you?”',
      '“Nowhere.” (I)',
    ]);
    expect(marked('—Hola —dijo Ana.\n\nMe volví hacia Ana y le dije:\n\n—Vamos.', 'es')).toEqual([
      '—Hola',
      '—Vamos. (I)',
    ]);
    expect(
      marked('—¿Dónde estabas? —preguntó Ana.\n\n—Por ahí —me encogí de hombros—. ¿Y tú?', 'es'),
    ).toEqual(['—¿Dónde estabas?', '—Por ahí (I)', '. ¿Y tú? (I)']);
    expect(
      marked('“It was a long road,” I said, “and a hard one.\n\n“But we made it home.”', 'en'),
    ).toEqual(['“It was a long road,” (I)', '“and a hard one. (I)', '“But we made it home.” (I)']);
    // A narrator called Nick, named here: his line is not an "I" line.
    const nick = baseCast('en').map((c) =>
      c.role === 'narrator' ? { ...c, aliases: ['Nick'] } : c,
    );
    expect(marked('Nick turned to me and said, “Come.”', 'en', nick)).toEqual(['“Come.”']);
  });
});

describe('analyzeHeuristic: third person is unchanged by first-person rules', () => {
  it('keeps a chapter named after a character with the narrator', () => {
    const text =
      'ELIZABETH\n\n' +
      'Elizabeth walked to the window and looked out at the rain.\n\n' +
      '“You are very quiet,” said Jane.\n\n' +
      '“I am tired,” said Elizabeth.\n\n' +
      '“Then go to bed.”\n\n' +
      '“I will.”';
    const { result } = analyse(text, 'en');
    expect(speakers(text, 'en')).toEqual([
      'Jane [speech]',
      'Elizabeth [speech]',
      'Jane [speech]',
      'Elizabeth [speech]',
    ]);
    for (const span of result.spans.filter((s) => s.mode === 'narration')) {
      expect(span.speaker).toEqual({ kind: 'cast', id: 'narrator' });
    }
  });

  it('ignores an authorial "I" outside a speech tag', () => {
    const text =
      '“You are late,” said Anne.\n\n' +
      '“I know,” said Tom; and I must say he did not look sorry.\n\n' +
      '“Why?”\n\n' +
      '“The rain.”';
    expect(speakers(text, 'en')).toEqual([
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
      'Tom [speech]',
    ]);
  });

  it('ignores an authorial "I" next to a tag that is not the tag', () => {
    const collins =
      '“Good evening, Mr. Collins,” said Elizabeth. As I have said, she was tired.\n\n' +
      '“Good evening, Miss Bennet.”';
    expect(speakers(collins, 'en').at(-1)).toBe('Mr. Collins [speech]');
    const sisters = castWith('en', [
      ['elizabeth', 'Elizabeth', 'female'],
      ['jane', 'Jane', 'female'],
    ]);
    const restless =
      'Elizabeth and Jane sat by the fire.\n\n' +
      '“Shall we go?” said Elizabeth, who, as I said, was restless.\n\n“Not yet.”';
    expect(speakers(restless, 'en', sisters)).toEqual(['Elizabeth [speech]', 'Jane [speech]']);
    const ana =
      'Ana y Pedro llegaron a la casa.\n\n' +
      '—Buenas noches —dijo Ana. Como ya dije, estaba cansada.\n\n—Buenas noches.';
    expect(speakers(ana, 'es')).toEqual(['Ana [speech]', 'Pedro [speech]']);
    // Intros whose speech verb is someone else's.
    const bennet = (intro: string) =>
      `Mrs. Bennet sat by the window.\n\n${intro}\n\n` +
      '“Come here, Davy,” said Mrs. Bennet.\n\n“Yes, ma’am.”';
    for (const intro of [
      'As I have said before, Mrs. Bennet said to her husband one cold evening, ' +
        '“My dear, the boy is here.”',
      'She turned to her husband and said:\n\n“My dear, the boy is here.”',
      // An "I" that opens the sentence, but another subject's "and said".
      'I suppose she sighed and said, “My dear, the boy is here.”',
      'I think Mrs. Bennet turned to her husband and said:\n\n“My dear, the boy is here.”',
      'I must tell him now, she thought, and said:\n\n“My dear, the boy is here.”',
      'I daresay Mrs. Bennet turned to her husband and said, “My dear, the boy is here.”',
      'I daresay the old lady turned to her husband and said:\n\n“My dear, the boy is here.”',
      'I believe it was Mrs. Bennet who turned and said:\n\n“My dear, the boy is here.”',
      'I came in, and Mrs. Bennet looked up and said, “My dear, the boy is here.”',
    ]) {
      expect(speakers(bennet(intro), 'en').at(-1)).toBe('Davy [speech]');
    }
    const rosa = (intro: string) =>
      `La señora Rosa estaba junto a la ventana.\n\n${intro}\n\n—Ya ha llegado el chico.\n\n` +
      '—Ven aquí, Davy —dijo Rosa.\n\n—Sí, señora.';
    for (const intro of [
      'Yo creo que ella se volvió hacia su marido y le dijo:',
      // An imperfect may be "yo decía", but not after another clause's subject.
      'Yo sé que la señora se volvía y decía:',
      'Yo creo que se volvía hacia su marido y le decía:',
      'Yo estaba en la puerta, ella se volvía hacia su marido y le decía:',
    ]) {
      expect(speakers(rosa(intro), 'es').at(-1)).toBe('Davy [speech]');
    }
  });

  it('ignores an authorial "I" whose "and said" has a subject no name shows', () => {
    const bennet = (intro: string) =>
      `Mrs. Bennet sat by the window.\n\n${intro}\n\n` +
      '“Come here, Davy,” said Mrs. Bennet.\n\n“Yes, ma’am.”';
    const line = '“My dear, the boy is here.”';
    for (const intro of [
      // The narrator's own verb takes a clause or is a modal, so "said" is the clause's.
      `I suppose the cook sighed and said, ${line}`,
      `I daresay the parson coughed and said, ${line}`,
      `I think somebody laughed and said, ${line}`,
      `I am bound to say the children laughed and said, ${line}`,
      `I hear the cook sighed and said:\n\n${line}`,
      `But I must now return to Mrs. Bennet, who sighed and said, ${line}`,
      // "she" after "for" is a subject, and so is a relative that runs on into the verb.
      `I paused, for she sighed and said, ${line}`,
      `I leave it to Mrs. Bennet, who sighed and said, ${line}`,
    ]) {
      expect(speakers(bennet(intro), 'en').at(-1)).toBe('Davy [speech]');
    }
    const rosa =
      'La señora Rosa estaba junto a la ventana.\n\n' +
      'Yo no sé si la cocinera suspiraba y le decía:\n\n—Ya ha llegado el chico.\n\n' +
      '—Ven aquí, Davy —dijo Rosa.\n\n—Sí, señora.';
    expect(speakers(rosa, 'es').at(-1)).toBe('Davy [speech]');
  });

  it('ignores a "me" in hearsay or in a character’s thought', () => {
    const cast = castWith('en', [
      ['anne', 'Anne', 'female'],
      ['tom', 'Tom', 'male'],
      ['davy', 'Davy', 'male'],
    ]);
    const turns = ['Anne [speech]', 'Tom [speech]', 'Anne [speech]', 'Tom [speech]'];
    const hearsay =
      'Anne and Tom sat by the fire.\n\n“Where is Davy?” I was told she asked that night.\n\n' +
      '“Out, Anne.”\n\n“Out where, Tom?”\n\n“Fishing.”';
    expect(speakers(hearsay, 'en', cast)).toEqual(turns);
    const thought =
      'Anne and Tom were in the garden.\n\n' +
      '“It’s late.” She told me that every night, Tom thought.\n\n' +
      '“Not yet.”\n\n“Come in, Tom.”\n\n“In a minute.”';
    expect(speakers(thought, 'en', cast)).toEqual(turns);
  });

  it('ignores what the narrator was told outside the tag a line is read from', () => {
    const scene = (aside: string) =>
      `Mrs. Bennet sat by the window.\n\n${aside} “Come here, Davy,” she said.\n\n` +
      '“Yes, ma’am.”\n\n“Sit, Davy.”\n\n“Yes.”';
    const turns = [
      'Mrs. Bennet [speech]',
      'Davy [speech]',
      'Mrs. Bennet [speech]',
      'Davy [speech]',
    ];
    // The line's own tag is "she said", so no verb before it is read.
    for (const aside of [
      'Mrs. Bennet, as my aunt told me, was nervous.',
      'Mrs. Bennet, my mother told me, was nervous.',
      'Mrs. Bennet, I was told, was nervous.',
      'Mrs. Bennet, as I said, was nervous.',
    ]) {
      expect(speakers(scene(aside), 'en')).toEqual(turns);
      expect(newNames(scene(aside), 'en')).toEqual(['Mrs. Bennet', 'Davy']);
    }
    // Where an aside is the verb read, it is still no tag said to the narrator.
    const proverb =
      'Ana y Pedro discutían.\n\n—Más vale tarde que nunca, Luis —como nos dice el refrán.\n\n' +
      '—No estoy de acuerdo.\n\n—¿Por qué, Luis?\n\n—Porque no.';
    expect(speakers(proverb, 'es')).toEqual([
      'Pedro [speech]',
      'Luis [speech]',
      'Pedro [speech]',
      'Luis [speech]',
    ]);
  });

  it('reads no tag in a question after a line, even one about the narrator', () => {
    const cast = castWith('en', [
      ['anne', 'Anne', 'female'],
      ['tom', 'Tom', 'male'],
    ]);
    const gate =
      'Anne waited by the gate.\n\n“Tom?” Why had he told me nothing? She knocked again.\n\n' +
      '“Coming.”\n\n“Hurry up, Tom.”\n\n“I am hurrying.”';
    expect(speakers(gate, 'en', cast)).toEqual([
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
      'Tom [speech]',
    ]);
    const swapped = gate
      .replace('Anne waited', 'Tom waited')
      .replace('“Tom?” Why had he', '“Anne?” Why had she')
      .replace('She knocked', 'He knocked')
      .replace('Hurry up, Tom', 'Hurry up, Anne');
    expect(speakers(swapped, 'en', cast)).toEqual([
      'Tom [speech]',
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
    ]);
    // A tag set off inside the question, or a question with no question word, tags nothing either,
    // and turns no third-person part first person.
    const collins = castWith('en', [
      ['eliz', 'Elizabeth', 'female'],
      ['collins', 'Mr. Collins', 'male'],
    ]);
    const proposal = (question: string) =>
      'Elizabeth sat by the window.\n\n“Will you marry me?” asked Mr. Collins.\n\n' +
      `“No.” ${question}\n\n“But why not?”\n\n“Because I do not love you.”`;
    for (const question of [
      'Was it pride, I wonder?',
      'And who, I ask you, could blame her?',
      'Need I say that he was astonished?',
      'Did she mean it, he wondered?',
      'Surely she had said it before?',
    ]) {
      expect(speakers(proposal(question), 'en', collins)).toEqual([
        'Mr. Collins [speech]',
        'Elizabeth [speech]',
        'Mr. Collins [speech]',
        'Elizabeth [speech]',
      ]);
    }
    const ana = castWith('es', [
      ['ana', 'Ana', 'female'],
      ['pablo', 'Pablo', 'male'],
    ]);
    const madrid =
      '«Hola, Pablo», dijo Ana.\n\n«Me voy a Madrid». ¿Qué, se preguntó Ana, iba a hacer?';
    expect(speakers(madrid, 'es', ana)).toEqual(['Ana [speech]', 'Pablo [speech]']);
  });

  it('reads a tag before a question that "but", "and" or "because" joins to it', () => {
    const cast = castWith('en', [
      ['anne', 'Anne', 'female'],
      ['tom', 'Tom', 'male'],
    ]);
    const door = (tag: string) =>
      `Anne and Tom stood at the door.\n\n${tag}\n\n“You’re lying.”\n\n“I never lie, Anne.”`;
    for (const [tag, first] of [
      ['“It’s nothing,” Tom said, but was it?', 'Tom [speech]'],
      ['“It’s nothing,” said Tom, though did it really?', 'Tom [speech]'],
      ['“It’s nothing,” he said, and wasn’t that the truth?', 'Tom [speech]'],
      ['“It’s nothing,” Tom muttered, but who was he fooling?', 'Tom [speech, whisper]'],
      ['“It’s nothing,” Tom said, because what else could he say?', 'Tom [speech]'],
      ['“It’s nothing,” Tom said, since what else could he say?', 'Tom [speech]'],
      ['“It’s nothing,” said Tom, as who wouldn’t?', 'Tom [speech]'],
    ] as const) {
      expect(speakers(door(tag), 'en', cast)).toEqual([first, 'Anne [speech]', 'Tom [speech]']);
    }
    // The teller's own tag makes a first-person part, so "Kit" is the teller's name.
    const mom = castWith('en', [['mom', 'Mom', 'female']]);
    const soup = (tag: string) =>
      `Mom set the soup down.\n\n${tag}\n\n“You look pale, Kit.”\n\n“I’m just tired.”`;
    for (const tag of [
      '“I’m fine,” I said, but was I?',
      '“Can I drive?” I asked, and why shouldn’t I?',
      '“I’m fine,” I said, because what else could I say?',
      '“I’m fine,” I said… but was I?',
    ]) {
      expect(speakers(soup(tag), 'en', mom)).toEqual([
        'Narrator [speech]',
        'Mom [speech]',
        'Narrator [speech]',
      ]);
      expect(newNames(soup(tag), 'en', mom)).toEqual([]);
    }
    // Spanish written without the opening "¿".
    const ines = castWith('es', [
      ['ana', 'Ana', 'female'],
      ['tomas', 'Tomás', 'male'],
    ]);
    const puerta =
      'Ana esperaba en la puerta.\n\n—Ya voy —dijo Tomás, porque qué más podía decir?\n\n' +
      '—Ahora, Tomás.\n\n—Que sí.';
    expect(speakers(puerta, 'es', ines)).toEqual([
      'Tomás [speech]',
      'Ana [speech]',
      'Tomás [speech]',
    ]);
    // A tag that goes on from its line after a comma is a tag whatever its first word ("Will",
    // "was"), and "Por fin" opens no question.
    const will = castWith('en', [
      ['will', 'Will', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    const fine =
      '“Are you all right?” asked Anne.\n\n“I’m fine,” Will said, but was he?\n\n' +
      '“You don’t look fine.”\n\n“Well, I am.”';
    expect(speakers(fine, 'en', will)).toEqual([
      'Anne [speech]',
      'Will [speech]',
      'Anne [speech]',
      'Will [speech]',
    ]);
    // So is one whose line ends in "!": a cast name before its verb, or a wh-word before its
    // subject, opens no question ("Will said", "When he turned", "How Anne screamed").
    const fineBang = fine.replace('“I’m fine,” Will said', '“I’m fine!” Will said');
    expect(speakers(fineBang, 'en', will)).toEqual([
      'Anne [speech]',
      'Will [speech]',
      'Anne [speech]',
      'Will [speech]',
    ]);
    const quay = castWith('en', [
      ['anne', 'Anne', 'female'],
      ['tom', 'Tom', 'male'],
      ['jack', 'Jack', 'male'],
    ]);
    for (const tag of [
      '“Goodbye!” When he turned, Anne whispered, but did he hear?',
      '“Help!” How Anne screamed, and who could blame her?',
    ]) {
      const text = `“The ship is late,” said Jack.\n\n“It always is,” said Tom.\n\n${tag}`;
      expect(speakers(text, 'en', quay).at(-1)).toMatch(/^Anne \[/u);
    }
    const out =
      '“Where have you been?” asked Mom.\n\n“Out,” was all I said, but what else could I tell ' +
      'her?\n\n“Out where?”\n\n“Just out.”';
    expect(speakers(out, 'en', mom)).toEqual([
      'Mom [speech]',
      'Narrator [speech]',
      'Mom [speech]',
      'Narrator [speech]',
    ]);
    const finally_ =
      '—¿Me quieres? —le preguntó Ana a Pablo.\n\n—Claro que sí —dijo Tomás, riendo.\n\n' +
      '—Te quiero. —Por fin lo dijo Pablo, pero lo decía en serio?';
    const apt = castWith('es', [
      ['ana', 'Ana', 'female'],
      ['tomas', 'Tomás', 'male'],
      ['pablo', 'Pablo', 'male'],
    ]);
    expect(speakers(finally_, 'es', apt).at(-1)).toBe('Pablo [speech]');
    // An aside inside a question that opens before it, with "as", "since", "pues" or "…" after
    // it, tags no line either.
    for (const question of [
      'Did he mean it, I asked myself, as I watched him go?',
      'Did he mean it, I wondered, since he had never kept a promise before?',
      'Did he mean it, I wondered… or was it only the wine?',
    ]) {
      const promise =
        '“I’ll come back,” Tom said.\n\n“When?” I asked.\n\n' +
        `“Soon. I promise.” ${question}\n\n“Then go.”\n\n“I’m going.”`;
      expect(speakers(promise, 'en', cast)).toEqual([
        'Tom [speech]',
        'Narrator [speech]',
        'Tom [speech]',
        'Narrator [speech]',
        'Tom [speech]',
      ]);
    }
    // Twins: a question with a phrase set off inside it, or two questions joined by "or", still
    // tags no line.
    for (const question of [
      'Why had he told me, of all people, nothing?',
      'Had he told me nothing, or had I not listened? She knocked again.',
    ]) {
      const gate =
        `Anne waited by the gate.\n\n“Tom?” ${question}\n\n` +
        '“Coming.”\n\n“Hurry up, Tom.”\n\n“I am hurrying.”';
      expect(speakers(gate, 'en', cast)).toEqual([
        'Anne [speech]',
        'Tom [speech]',
        'Anne [speech]',
        'Tom [speech]',
      ]);
    }
  });

  it('reads old enclitic tags, but never a "-se" subjunctive, as a tag', () => {
    const kind = (word: string) => {
      const info = verbAt(tokenize(word, 'es'), 0, 'es');
      return info ? (info.firstPerson ? 'first' : 'third') : 'none';
    };
    expect(['díjele', 'preguntéle', 'pregúntole'].map(kind)).toEqual(['first', 'first', 'first']);
    expect(['díjole', 'preguntóle', 'díjose', 'preguntole'].map(kind)).toEqual([
      'third',
      'third',
      'third',
      'third',
    ]);
    expect(['dijese', 'preguntase', 'contestase'].map(kind)).toEqual(['none', 'none', 'none']);
    const text = '—¿Vienes, Luis? —preguntó Ana, sin que nadie dijese nada.\n\n—No.';
    expect(speakers(text, 'es')).toEqual(['Ana [speech]', 'Luis [speech]']);
  });
});

describe('analyzeHeuristic: attribution', () => {
  const tomAnne = castWith('en', [
    ['tom', 'Tom', 'male'],
    ['anne', 'Anne', 'female'],
  ]);

  it('prefers the subject before the verb to the person after it', () => {
    expect(speakers('“Where are you going?” Tom asked Anne.', 'en', tomAnne)).toEqual([
      'Tom [speech]',
    ]);
    expect(speakers('Tom said, “Yes.” Then Anne said, “No.”', 'en', tomAnne)).toEqual([
      'Tom [speech]',
      'Anne [speech]',
    ]);
    const pablo = castWith('es', [
      ['pablo', 'Pablo', 'male'],
      ['nela', 'Nela', 'female'],
    ]);
    expect(speakers('Pablo miró a Nela y le dijo:\n\n—Ven.', 'es', pablo)).toEqual([
      'Pablo [speech]',
    ]);
  });

  it('keeps one speaker for both halves of a split quote', () => {
    expect(speakers('Anne laughed. “You,” Tom said, “are impossible.”', 'en', tomAnne)).toEqual([
      'Tom [speech]',
      'Tom [speech]',
    ]);
    expect(
      speakers('“Where were you?” I asked. “Out,” Anne said, “walking.”', 'en', tomAnne),
    ).toEqual(['Narrator [speech]', 'Anne [speech]', 'Anne [speech]']);
    const tomas = castWith('es', [
      ['tomas', 'Tomás', 'male'],
      ['ana', 'Ana', 'female'],
    ]);
    expect(speakers('Ana se rió. «Tú», Tomás dijo, «eres imposible».', 'es', tomas)).toEqual([
      'Tomás [speech]',
      'Tomás [speech]',
    ]);
    // A line with an intro of its own still keeps it.
    expect(speakers('Tom said, “Yes,” and then Anne said, “No.”', 'en', tomAnne)).toEqual([
      'Tom [speech]',
      'Anne [speech]',
    ]);
  });

  it('never gives a passive tag to the person it is said to', () => {
    expect(speakers('“Hi,” said Anne.\n\n“Go home,” Tom was told.', 'en', tomAnne)).toEqual([
      'Anne [speech]',
      'Unknown [speech]',
    ]);
    const told = '“Hello,” said Tom.\n\n“Hi,” said Anne.\n\n“Sit down,” she was told.';
    expect(speakers(told, 'en', tomAnne)).toEqual([
      'Tom [speech]',
      'Anne [speech]',
      'Tom [speech]',
    ]);
    expect(newNames('“What is your name?” the boy was asked.', 'en')).toEqual([]);
  });

  it('takes the speaker of an inciso or a beat', () => {
    const cast = castWith('es', [
      ['pedro', 'Pedro', 'male'],
      ['ana', 'Ana', 'female'],
      ['luis', 'Luis', 'male'],
    ]);
    const text = '—Hola —dijo Luis.\n\n—Hola —dijo Pedro.\n\n—Hola —Ana sonrió—. ¿Qué tal?';
    expect(speakers(text, 'es', cast)).toEqual([
      'Luis [speech]',
      'Pedro [speech]',
      'Ana [speech]',
      'Ana [speech]',
    ]);
  });

  it('takes the subject that opens the clause across an aside, never the person before it', () => {
    const pablo = castWith('es', [
      ['pablo', 'Pablo', 'male'],
      ['nela', 'Nela', 'female'],
    ]);
    for (const [text, who] of [
      ['—¿Lo sabes? —preguntó Pablo.\n\nNela miró a Pablo, y después de un rato, dijo:', 'Nela'],
      [
        '—¿Lo sabes? —preguntó Pablo.\n\nNela se volvió hacia él, y con los ojos húmedos, dijo:',
        'Nela',
      ],
      ['—¿Y bien? —preguntó Nela.\n\nMiré a Nela, y después de un momento, contesté:', 'Narrator'],
      ['—¿Y bien? —preguntó Nela.\n\nMe acerqué a ella, y con voz muy baja, dije:', 'Narrator'],
      ['—Hola —dijo Pablo.\n\nPablo entró, y Nela, después de un rato, dijo:', 'Nela'],
      ['—Hola —dijo Pablo.\n\nPablo entró en la cocina, y Nela se levantó y le dijo:', 'Nela'],
      [
        '—Hola —dijo Pablo.\n\nPablo entró en la cocina, y Nela se levantó y entonces le dijo:',
        'Nela',
      ],
    ] as const) {
      expect(speakers(`${text}\n\n—Lo sé.`, 'es', pablo).at(-1)).toBe(`${who} [speech]`);
    }
    const cast = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    const pause = '“I don’t know,” Tom told Anne, and after a pause, added, “Maybe tomorrow.”';
    expect(speakers(`${pause}\n\n“Fine.”`, 'en', cast)).toEqual([
      'Tom [speech]',
      'Tom [speech]',
      'Anne [speech]',
    ]);
    for (const [text, who] of [
      ['“Coming?” asked Anne.\n\nTom turned to Anne, and in a low voice, said, “No.”', 'Tom'],
      ['“Ready?” Anne asked.\n\nI looked at Anne, and after a moment, said, “Yes.”', 'Narrator'],
      ['“Coming?” asked Anne.\n\nShe turned to Tom, and with a sigh, said, “No.”', 'Anne'],
      ['“Hello?” Anne called.\n\nTom came in, and Anne smiled and then said, “Hi.”', 'Anne'],
      ['“Hello?” Tom called.\n\nTom came in, and Anne, after a moment, said, “Hi.”', 'Anne'],
      ['“Who is it?” asked Anne.\n\nTom, red-faced, shouted, “Me!”', 'Tom'],
      ['“Who is it?” asked Tom.\n\nAnne nodded, then said, “Me.”', 'Anne'],
    ] as const) {
      expect(speakers(text, 'en', cast).at(-1)).toMatch(new RegExp(`^${who} \\[speech`));
    }
    // No character is made of the person looked at.
    const bennets = castWith('en', [
      ['mr', 'Mr. Bennet', 'male'],
      ['mrs', 'Mrs. Bennet', 'female'],
    ]);
    const husband =
      '“Well?” said Mr. Bennet.\n\nMrs. Bennet looked at her husband, and after a pause, ' +
      'replied, “Nothing.”';
    expect(speakers(husband, 'en', bennets)).toEqual([
      'Mr. Bennet [speech]',
      'Mrs. Bennet [speech]',
    ]);
    expect(newNames(husband, 'en', bennets)).toEqual([]);
    // In a third-person part, an authorial "I" before another subject says nothing.
    const davy =
      'Mrs. Bennet sat by the window.\n\nI daresay Mrs. Bennet turned, then said, “The boy is ' +
      'here.”\n\n“Come here, Davy,” said Mrs. Bennet.\n\n“Yes, ma’am.”\n\n“And bring the basket.”';
    expect(speakers(davy, 'en')).toEqual([
      'Mrs. Bennet [speech]',
      'Mrs. Bennet [speech]',
      'Davy [speech]',
      'Mrs. Bennet [speech]',
    ]);
  });

  it('takes the sentence’s subject past a lead word, an aside or a subordinate clause', () => {
    const three = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
    ]);
    const hello = '“Hello,” said Anne.\n\n“Hi,” said Mary.\n\n';
    // A "he" after a lead word is still a "he": Tom once he has spoken, else nobody, never a woman.
    for (const line of [
      'But he shook his head and said, “Enough.”',
      'Then he turns and says, “No.”',
    ]) {
      expect(speakers(`“Hey,” said Tom.\n\n${hello}${line}`, 'en', three).at(-1)).toBe(
        'Tom [speech]',
      );
      expect(speakers(`${hello}${line}`, 'en', three).at(-1)).toBe('Unknown [speech]');
    }
    for (const line of [
      'Then Tom turned and said, “Enough.”',
      'Tom waited until she had finished, then said, “Enough.”',
      'Tom kissed his wife, then said, “Enough.”',
      'Tom, when Anne had finished, smiled and said, “Enough.”',
      'At last Tom, laying down his paper, said, “Enough.”',
      'The door opened and Tom, breathless, said, “Enough.”',
      'Suddenly Tom, red-faced, said, “Enough.”',
    ]) {
      expect(speakers(`${hello}${line}`, 'en', three).at(-1)).toBe('Tom [speech]');
    }
    const darcy =
      '“Good evening,” said Elizabeth.\n\n“Good evening,” said Jane.\n\n' +
      'Then Mr. Darcy bowed and said, “Miss Bennet.”';
    expect(speakers(darcy, 'en').at(-1)).toBe('Mr. Darcy [speech]');
    // The teller's own "I" past a lead word or a clause that "and" opens.
    const late =
      '“Hello?” Tom called from the hall.\n\n“In here,” I said.\n\n' +
      'He came in and I, without looking up, said, “You’re late.”\n\n“I know.”\n\n“Again.”';
    expect(speakers(late, 'en', three)).toEqual([
      'Tom [speech]',
      'Narrator [speech]',
      'Narrator [speech]',
      'Tom [speech]',
      'Narrator [speech]',
    ]);
    // "he answered:" is the person asked, not the one asking.
    const river =
      'Tom and Anne walked by the river.\n\n' +
      '“Will you come with me?” Tom asked Anne, and she answered:\n\n“Yes.”';
    expect(speakers(river, 'en')).toEqual(['Tom [speech]', 'Anne [speech]']);
    const pablo = castWith('es', [
      ['pablo', 'Pablo', 'male'],
      ['ana', 'Ana', 'female'],
      ['nela', 'Nela', 'female'],
    ]);
    for (const [text, who] of [
      [
        '«Hola», dijo Ana.\n\nPablo, que estaba en la cocina, se secó las manos y dijo: «Ya voy».',
        'Pablo',
      ],
      ['«Hola», dijo Ana.\n\nPor fin Pablo, después de mucho pensarlo, dijo: «Acepto».', 'Pablo'],
      ['«¿Vienes?», preguntó Pablo.\n\nLa Nela, sin mirarlo, respondió: «No».', 'Nela'],
      [
        '—¿Vienes? —insistió Ana, a lo que Pablo, sin levantar la vista, respondió—: Ni hablar.',
        'Pablo',
      ],
      ['«Hola», dijo Nela.\n\nY entonces ella, sin pensarlo dos veces, dijo: «Me voy».', 'Nela'],
    ] as const) {
      expect(speakers(text, 'es', pablo).at(-1)).toBe(`${who} [speech]`);
    }
    const padre =
      '«Buenos días», dije al entrar.\n\n' +
      'Mi padre, que estaba leyendo el periódico, levantó la vista y me dijo: «Llegas tarde».';
    expect(speakers(padre, 'es')).toEqual(['Narrator [speech]', 'mi padre [speech]']);
  });

  it('takes the stretch before the join as a clause only when its subject has a verb', () => {
    const three = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
    ]);
    const asked = '“Well?” asked Mary.\n\n';
    // An appositive, the rest of a list, a phrase with no verb or someone's comment: the
    // sentence's subject says the line, and nobody new comes from it.
    for (const line of [
      'Tom turned to his sister, Anne, and said, “Tell her.”',
      'Tom pointed at the stranger, a tall man in a grey coat, and said, “That is Mr. Wickham.”',
      'Tom waited at the door, Anne at his side, and then said, “After you.”',
      'Tom kissed his mother, then his sister, and said, “I’ll write.”',
      'Tom looked at Mary, then at Anne, and said, “I don’t know.”',
      'Tom shook hands with Mr. Bingley, Mr. Darcy and Mr. Hurst, and said, “Sit down.”',
      'Tom thanked everyone, Anne included, and said, “You are very kind.”',
      'Tom greeted everyone, but Anne most warmly, and said, “I missed you all.”',
      'Tom hugged Mary, and Anne too, and said, “I’ll miss you both.”',
      'Tom stood up, the old man watching him closely, and said, “I accept.”',
      'Tom came in, his wife beside him, and said, “Only us.”',
      'Tom hesitated, Anne thought, and then said, “Quite sure.”',
      'Tom paused, I think, and then said, “Yes.”',
      '“Come in,” Tom said to his cousin, Anne, and then added, “Mind the step.”',
      'Tom looked at the two girls, Anne still pale, and said, “You had better both sit down.”',
      'Tom sat at the head of the table, Anne opposite, and said, “Let us eat.”',
      'Tom hesitated, Anne could see, and then said, “I will think about it.”',
      'Tom was lying, Anne was sure, and then said, “I was at the inn all night.”',
      'Tom hesitated, I noticed, and then said, “I will think about it.”',
    ]) {
      const text = `${asked}${line}`;
      expect(speakers(text, 'en', three).at(-1)).toBe('Tom [speech]');
      expect(newNames(text, 'en', three)).toEqual([]);
    }
    const colon = `${asked}Tom turned to his sister, Anne, and said:\n\n“We must tell Father.”`;
    expect(speakers(colon, 'en', three)).toEqual(['Mary [speech]', 'Tom [speech]']);
    // A clause of its own keeps its subject, also without "and" before it, with a fronted phrase
    // or a phrase before its verb, and when "and" or "but" opens a comment; so does the teller's
    // own comment on a state.
    for (const [line, who] of [
      ['Tom came in, and Anne smiled and then said, “Hello.”', 'Anne'],
      ['When the music stopped, Tom bowed, then said, “Thank you.”', 'Tom'],
      ['Tom came in, Anne stood up, and after a moment, said, “Hello.”', 'Anne'],
      ['Tom came in, and I suppose Anne smiled and said, “Hello.”', 'Anne'],
      ['Anne was right, I thought, and said, “You are right.”', 'Narrator'],
      ['That evening Anne was right, I thought, and said, “Let us go.”', 'Narrator'],
      ['Tom came in, and Anne at last looked up from her book and said, “You are late.”', 'Anne'],
      ['Tom opened the door, and Anne behind him laughed and said, “Go on, then.”', 'Anne'],
      ['Tom came in, and Anne could not believe her eyes and said, “You!”', 'Anne'],
      ['Tom tried to hide his limp, but Anne noticed, and said gently, “Sit down.”', 'Anne'],
      [
        'Tom came in, and the old man by the fire looked up and said, “Shut the door.”',
        'the old man',
      ],
      [
        'Seeing Tom, the old woman looked up from her knitting, and said, “You are late.”',
        'the old woman',
      ],
    ] as const) {
      expect(speakers(`${asked}${line}`, 'en', three).at(-1)).toBe(`${who} [speech]`);
    }
    // "that" after a noun or "knew" brings in nobody the teller watched; "I was told" is a hedge.
    const coat =
      '“Do you like it?” asked Anne.\n\n“It suits you,” said Tom.\n\n' +
      'I put on the coat that Anne had given me, and after a moment, said, “It fits.”';
    expect(speakers(coat, 'en', three).at(-1)).toBe('Narrator [speech]');
    const told =
      '“Will you come?” asked Anne.\n\n“Perhaps,” said Tom.\n\n' +
      'Anne hesitated, I was told, and then said, “Very well.”';
    expect(speakers(told, 'en', three)).toEqual(['Anne [speech]', 'Tom [speech]', 'Anne [speech]']);
    // The teller's hedge says nothing, in third person and in first, and with no cast.
    const hedge =
      '“Will you come with me?” asked Tom.\n\nAnne hesitated, I believe, and said, “No.”\n\n“Why not?”';
    expect(speakers(hedge, 'en', three)).toEqual(['Tom [speech]', 'Anne [speech]', 'Tom [speech]']);
    const collins =
      '“Will you dance with me?” asked Mr. Collins.\n\n' +
      'Elizabeth hesitated, I believe, and then said, “I cannot.”\n\n“But why?”';
    expect(speakers(collins, 'en')[1]).not.toBe('Narrator [speech]');
    const mom = castWith('en', [['mom', 'Mom', 'female']]);
    const remember =
      '“Where were you?” asked Mom.\n\n“Out,” I said.\n\n' +
      'Mom looked at me for a long time, I remember, and then said, “Go to bed.”\n\n“Yes, Mom.”';
    expect(speakers(remember, 'en', mom)).toEqual([
      'Mom [speech]',
      'Narrator [speech]',
      'Mom [speech]',
      'Narrator [speech]',
    ]);
    const supposeHe =
      '“Hello,” I said to Anne.\n\n“Hello,” said Anne.\n\n' +
      'Tom came in, and I suppose he sat down and said, “Evening, all.”\n\n“Evening, Tom.”';
    expect(speakers(supposeHe, 'en', three)).toEqual([
      'Narrator [speech]',
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
    ]);
    const thenAt =
      '“Ready?” asked Tom.\n\n“Ready,” said Anne.\n\nI looked at Tom, then at Anne, and said, ' +
      '“Let’s go.”';
    expect(speakers(thenAt, 'en', three).at(-1)).toBe('Narrator [speech]');
    const pablo = castWith('es', [
      ['pablo', 'Pablo', 'male'],
      ['ana', 'Ana', 'female'],
      ['nela', 'Nela', 'female'],
    ]);
    const pregunta = '—¿Qué pasa? —preguntó Ana.\n\n';
    for (const line of [
      'Pablo se volvió hacia su hermana, Nela, y le dijo:\n\n—Nada.',
      'Pablo abrazó a su hijo, un niño de seis años, y le dijo:\n\n—Ya estoy aquí.',
      'Pablo se dirigió a la anciana, una mujer menuda y arrugada, y le preguntó:\n\n—¿Vive aquí?',
      'Pablo miró a Nela, luego al capitán, y dijo:\n\n—Nos vamos mañana.',
      'Pablo entró, su mujer detrás de él, y dijo:\n\n—Somos nosotros.',
      '—No —Pablo miró a su hermana, Nela, y añadió—: Ni ella tampoco.',
      'Pablo dudó, yo creo, y luego dijo:\n\n—No.',
      'Pablo entró, Nela todavía dormida, y dijo:\n\n—Aquí está.',
      'Pablo entró, Nela descalza, y dijo:\n\n—Aquí está.',
    ]) {
      const text = `${pregunta}${line}`;
      expect(speakers(text, 'es', pablo).at(-1)).toBe('Pablo [speech]');
      expect(newNames(text, 'es', pablo)).toEqual([]);
    }
    const hijas = `${pregunta}Don Ramón miró a sus dos hijas, Ana y Nela, y les dijo:\n\n—Mañana.`;
    expect(speakers(hijas, 'es', pablo).at(-1)).toBe('Don Ramón [speech]');
    const padreDeAna = `${pregunta}Entró don Ramón, el padre de Ana, y dijo:\n\n—Buenas tardes.`;
    expect(speakers(padreDeAna, 'es', pablo).at(-1)).toBe('don Ramón [speech]');
    for (const [line, who] of [
      ['Pablo entró, Nela se levantó, y después de un rato, dijo:', 'Nela'],
      ['Pablo cogió el abrigo, su madre suspiró y dijo:', 'su madre'],
      ['Pablo cogió el abrigo, su madre suspiró, y dijo:', 'su madre'],
      ['Pablo cogió el abrigo, su madre se puso en pie, y dijo:', 'su madre'],
      ['Pablo calló, y Ana por fin levantó la vista y dijo:', 'Ana'],
      ['Pablo bajó la escalera, Ana lo vio, y le dijo:', 'Ana'],
      // Someone who sees the person in an aside after the join, unless they spoke last.
      ['Ana entró, y cuando Pablo la vio, exclamó:', 'Pablo'],
      ['Ana entró, y al verla Pablo, exclamó:', 'Pablo'],
    ] as const) {
      const text = `—Ya viene —dijo Nela.\n\n${line}\n\n—¡Por fin!`;
      expect(speakers(text, 'es', pablo).at(-1)).toMatch(new RegExp(`^${who} \\[`, 'u'));
    }
    const answers =
      '—¿Qué te pasa? —preguntó Pablo.\n\nAna se levantó, y cuando Pablo la miró, dijo:\n\n—Nada.';
    expect(speakers(answers, 'es', pablo).at(-1)).toBe('Ana [speech]');
    // Someone who calls the person is not the one who answers.
    const llamo =
      '—¿Dónde está Ana? —preguntó Nela.\n\n' +
      'Ana estaba en el jardín, y cuando Pablo la llamó, contestó:\n\n—¡Ya voy!';
    expect(speakers(llamo, 'es', pablo).at(-1)).toBe('Ana [speech]');
    // A clause that opens the sentence leaves only the stretch right after it with no subject.
    const cuando =
      '—¿Dónde estabas? —preguntó Pablo.\n\n' +
      'Cuando Ana llegó, abrazó a su hijo, un niño pálido y delgado, y le dijo:\n\n—Ya estoy aquí.';
    expect(speakers(cuando, 'es', pablo).at(-1)).toBe('Ana [speech]');
    expect(newNames(cuando, 'es', pablo)).toEqual([]);
    const sentado =
      'Mi padre volvió tarde de la fábrica.\n\n—¿Has cenado? —me preguntó.\n\n—No, te esperaba.\n\n' +
      'Mi padre se sentó, yo me quedé de pie, y entonces dijo:\n\n—Me han despedido.\n\n—¿Por qué?';
    expect(speakers(sentado, 'es')).toEqual([
      'mi padre [speech]',
      'Narrator [speech]',
      'mi padre [speech]',
      'Narrator [speech]',
    ]);
  });

  it('takes the subject before an aside that "and" opens only when it opens the sentence', () => {
    const tomAnneCast = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    const fire =
      '“Who is there?” asked Anne.\n\nSuddenly Tom, and I shall never forget it, shouted, “Fire!”';
    expect(speakers(fire, 'en', tomAnneCast).at(-1)).toMatch(/^Tom \[/u);
    const evening =
      '“Where is Papa?” asked Anne.\n\nThat evening Tom, and this surprised us all, said, “We go.”';
    expect(speakers(evening, 'en', tomAnneCast).at(-1)).toBe('Tom [speech]');
    // Never an object, and never over the verb's own inverted subject.
    const told =
      '“Well?” asked Anne.\n\n“Sit down,” Tom told Anne, and after a pause, added, “Now.”';
    expect(speakers(told, 'en', tomAnneCast)).toEqual([
      'Anne [speech]',
      'Tom [speech]',
      'Tom [speech]',
    ]);
    const pablo = castWith('es', [
      ['pablo', 'Pablo', 'male'],
      ['ana', 'Ana', 'female'],
      ['nela', 'Nela', 'female'],
    ]);
    const respondio =
      '—¿Vienes? —preguntó Nela.\n\n—Hola —dijo Ana, y después de un rato, respondió Pablo—: Hola.';
    expect(speakers(respondio, 'es', pablo)).toEqual([
      'Nela [speech]',
      'Ana [speech]',
      'Pablo [speech]',
    ]);
    // The subject "y" brings in right before an aside is the tag's.
    const nunca =
      '—Te lo dije —dijo Nela, y Pablo, y esto no lo olvidaré nunca, respondió—: Ya lo sé.';
    expect(speakers(nunca, 'es', pablo)).toEqual(['Nela [speech]', 'Pablo [speech]']);
  });

  it('reads an -s word as a tag only with a subject, never a plural noun', () => {
    const asked = '“What happened?” Tom asked.\n\n';
    const whispered = ['Tom [speech]', 'Anne [speech, whisper]'];
    const sobs = `${asked}Anne whispered between sobs, “He’s gone.”`;
    expect(speakers(sobs, 'en', tomAnne)).toEqual(whispered);
    const between = `${asked}“He’s gone.” Between sobs, Anne whispered the news.`;
    expect(speakers(between, 'en', tomAnne)).toEqual(whispered);
    expect(newNames(between, 'en', tomAnne)).toEqual([]);
    const laughs = '“Tell us a joke,” Anne said.\n\nTom said amid laughs, “Not now.”';
    expect(speakers(laughs, 'en', tomAnne)).toEqual(['Anne [speech]', 'Tom [speech]']);
    // Nor does one take the place of the tag or the beat it sits in.
    for (const narration of ['Anne answered through gasps.', 'Anne wiped her eyes between sobs.']) {
      expect(speakers(`${asked}${narration} “He’s gone.”`, 'en', tomAnne)).toEqual([
        'Tom [speech]',
        'Anne [speech]',
      ]);
    }
    // One that opens a sentence, or follows a possessive, names and tags nobody.
    const screams = '“Get out!” Tom shouts.\n\n“Help!” Screams echo down the hall.\n\n“Run!”';
    const shook = `${asked}Anne sat down. “I’m sorry.” Sobs shook her.\n\n“It’s all right.”`;
    for (const text of [screams, shook]) expect(newNames(text, 'en', tomAnne)).toEqual([]);
    const cries = '“Tom!” Anne’s cries filled the house.';
    expect(speakers(cries, 'en', tomAnne)).toEqual(['Unknown [speech]']);
    // With a subject after it, or in the clause it is joined to, it is a tag.
    expect(speakers('“Ha!” laughs Tom.', 'en', tomAnne)).toEqual(['Tom [speech, happy]']);
    const turns = 'Anne turns and whispers, “Go.”';
    expect(speakers(turns, 'en', tomAnne)).toEqual(['Anne [speech, whisper]']);
  });

  it('reads an -s word after "someone", "somebody else" or "always" as a tag', () => {
    // Nobody in particular, before or after it: the unknown speaker, in the verb's tone.
    const asks = '“Is he dead?” Tom asks.\n\n';
    for (const [tag, tone] of [
      ['“Yes,” whispers someone behind him.', 'whisper'],
      ['“Yes,” somebody else mutters.', 'whisper'],
      ['Someone turns and whispers, “Yes.”', 'whisper'],
      ['“Yes!” screams someone.', 'shout'],
      ['“Yes,” everyone else laughs.', 'happy'],
    ]) {
      expect(speakers(`${asks}${tag}`, 'en', tomAnne)).toEqual([
        'Tom [speech]',
        `Unknown [speech, ${tone}]`,
      ]);
    }
    // An adverb of frequency keeps the subject, so the tag is still said to the teller.
    const aunt = (tag: string) =>
      `My aunt was in the kitchen.\n\n“You’re late, Kit,” ${tag}\n\n“The bus broke down.”\n\n` +
      '“Something always breaks, Kit.”\n\n“This time it’s true.”';
    for (const tag of [
      'she always tells me.',
      'my aunt never tells me.',
      'she often calls to me.',
    ]) {
      expect(speakers(aunt(tag), 'en')).toEqual([
        'my aunt [speech]',
        'Narrator [speech]',
        'my aunt [speech]',
        'Narrator [speech]',
      ]);
      expect(newNames(aunt(tag), 'en')).toEqual(['my aunt']);
    }
  });

  it('reads an -s word as a tag after a fronted phrase, an aside, "and then" or "the teacher"', () => {
    // A person right after it, when a phrase of place comes first.
    const home = '“Is anyone home?” Anne asks.\n\n';
    for (const [tag, who] of [
      ['From the doorway shouts Tom, “In here!”', 'Tom [speech, shout]'],
      ['“In here!” From the hall calls Tom.', 'Tom [speech]'],
      ['Behind him mutters the old man, “Kids.”', 'the old man [speech, whisper]'],
    ]) {
      expect(speakers(`${home}${tag}`, 'en', tomAnne)).toEqual(['Anne [speech]', who]);
    }
    const jonah = castWith('en', [['jonah', 'Jonah', 'male']]);
    const behind = '“Where are we?” I ask.\n\nBehind me whispers Jonah, “Shh.”';
    expect(speakers(behind, 'en', jonah)).toEqual(['Narrator [speech]', 'Jonah [speech, whisper]']);
    // The subject of the clause it is joined to past an adverb, or before an aside.
    for (const tag of ['Tom says, and then whispers,', 'Tom says, then whispers,']) {
      expect(speakers(`“Go,” ${tag} “now.”`, 'en', tomAnne)).toEqual([
        'Tom [speech]',
        'Tom [speech, whisper]',
      ]);
    }
    const ready = '“Ready?” Tom asks.\n\nAnne nods and then whispers, “Go.”';
    expect(speakers(ready, 'en', tomAnne)).toEqual(['Tom [speech]', 'Anne [speech, whisper]']);
    const stay = '“Please stay,” Anne says.\n\n“Get out!” Tom, red-faced, shouts.';
    expect(speakers(stay, 'en', tomAnne)).toEqual(['Anne [speech]', 'Tom [speech, shout]']);
    // Someone the lexicon does not know who opens the clause the -s word ends.
    for (const [tag, tone] of [
      ['“Sit down,” the teacher snaps.', 'angry'],
      ['“Ha!” the audience laughs.', 'happy'],
      ['“Next!” shouts one of the guards.', 'shout'],
      ['The judge bangs his gavel and shouts, “Order!”', 'shout'],
    ]) {
      expect(speakers(`“Can we go?” Tom asks.\n\n${tag}`, 'en', tomAnne)).toEqual([
        'Tom [speech]',
        `Unknown [speech, ${tone}]`,
      ]);
    }
    // Twins that stay nouns, so the line takes no tone: a plural that does not open its clause or
    // end it, or a continuation.
    for (const narration of [
      'Tom heard shouts and the loud cries.',
      'The loud cries woke Tom.',
      'The music resumes.',
    ]) {
      const [, line] = speakers(`${home}${narration} “Who is it?”`, 'en', tomAnne);
      expect(line).toMatch(/ \[speech\]$/);
    }
    // The same shape as "the teacher snaps" takes the tone: '“Where?” The distant cries.'
    expect(speakers(`${home}“Where?” The distant cries.`, 'en', tomAnne)[1]).toBe(
      'Unknown [speech, excited]',
    );
    // "the man beside her shouts" keeps no tone, as "the sound of her sighs" is no tag.
    expect(speakers('“Help!” Anna cried.\n\nThe man beside her shouts, “Run!”', 'en')[1]).toBe(
      'the man [speech]',
    );
  });

  it('never makes names of headings, sentence starts, places or exclamations', () => {
    const chapter =
      'CHAPTER II\n\n“Hi,” said Anne.\n\n“Who is there?”\n\nElizabeth Bennet smiled.\n\n' +
      '“Hi,” said Jane Bennet.';
    expect(speakers(chapter, 'en')).toEqual([
      'Anne [speech]',
      'Unknown [speech]',
      'Jane Bennet [speech]',
    ]);
    expect(newNames(chapter, 'en')).toEqual(['Anne', 'Jane Bennet']);

    const walk =
      '“Hi,” said Anne.\n\n“Hello,” said Tom.\n\nThey walked to London on Monday.\n\n' +
      '“Is it far?”\n\n“Oh, Lord!” cried Anne.\n\n“What?”';
    expect(speakers(walk, 'en')).toEqual([
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
      'Anne [speech, excited]',
      'Tom [speech]',
    ]);
    expect(newNames(walk, 'en')).toEqual(['Anne', 'Tom']);
  });

  it('takes "Jesús" for a person only once he speaks', () => {
    const dialogue = '—Hola —dijo Jesús.\n\n—Hola —dijo María.\n\n—¿Vienes?\n\n—No.';
    const turns = ['Jesús [speech]', 'María [speech]', 'Jesús [speech]', 'María [speech]'];
    expect(speakers(dialogue, 'es')).toEqual(turns);
    const known = castWith('es', [
      ['jesus', 'Jesús', 'male'],
      ['maria', 'María', 'female'],
    ]);
    expect(speakers(dialogue, 'es', known)).toEqual(turns);

    const opening = '—Hola —dijo Pablo.\n\n—Hola —dijo Nela.\n\n';
    const ay = `${opening}—¡Ay, Jesús! —exclamó Nela.\n\n—¿Qué pasa?`;
    expect(speakers(ay, 'es')).toEqual([
      'Pablo [speech]',
      'Nela [speech]',
      'Nela [speech, excited]',
      'Pablo [speech]',
    ]);
    const prayed = `${opening}Nela rezó a Jesús en silencio.\n\n—¿Qué pasa?`;
    expect(speakers(prayed, 'es')).toEqual(['Pablo [speech]', 'Nela [speech]', 'Pablo [speech]']);
    // Prayed to in a tag, then called on: still nobody who can take a line.
    const commended =
      `${opening}—¡Qué miedo! —dijo Nela, encomendándose a Jesús.\n\n` +
      '—¡Ay, Jesús! —exclamó Pablo.\n\n—¿Qué?';
    expect(speakers(commended, 'es').at(-1)).toBe('Nela [speech]');
    // Nor is he someone the next line answers, or a "he" for a pronoun tag.
    const told = 'Llegué tarde a casa.\n\n—Hola —me dijo Pablo.\n\n—Hola —le dije a Nela.\n\n';
    expect(speakers(told + commended.slice(opening.length), 'es').at(-1)).toBe('Nela [speech]');
    const he = commended.replace('Pablo.\n\n—¿Qué?', 'Nela—. ¿Y ahora qué? —preguntó él.');
    const inciso =
      `${opening}—¡Qué miedo! —dijo Nela, encomendándose a Jesús—. ` + '¿Y ahora? —preguntó él.';
    for (const text of [he, inciso]) expect(speakers(text, 'es').at(-1)).toBe('Pablo [speech]');
    // Sacred phrases are interjections too, and name nobody in narration or in a tag.
    const phrases = ['Jesús María', 'Señor Jesús', 'Jesús de Nazaret', 'Jesús Crucificado'].map(
      (phrase) => `${opening}—¡Ay, ${phrase}! —exclamó Nela.\n\n—¿Qué pasa?`,
    );
    const nazaret = [
      prayed.replace('a Jesús', 'a Jesús de Nazaret'),
      `${opening}—¡Qué miedo! —dijo Nela, encomendándose a Jesús de Nazaret.\n\n—¿Qué pasa?`,
    ];
    for (const text of [ay, prayed, commended, he, inciso, ...phrases, ...nazaret]) {
      expect(newNames(text, 'es')).toEqual(['Pablo', 'Nela']);
    }
    for (const text of [...phrases, ...nazaret]) {
      expect(speakers(text, 'es').at(-1)).toBe('Pablo [speech]');
    }
    // A person's name with "Jesús" in it is a name like any other.
    const person = `${opening}Nela miró a María Jesús.\n\n—¿Qué pasa?`;
    expect(speakers(person, 'es').at(-1)).toBe('María Jesús [speech]');
    const named = '—Hola —dijo Jesús María.\n\n—Hola —dijo Nela.\n\n—¿Vienes?\n\n—No.';
    expect(speakers(named, 'es')).toEqual([
      'Jesús María [speech]',
      'Nela [speech]',
      'Jesús María [speech]',
      'Nela [speech]',
    ]);
    // A line that calls on him is still never his.
    const urged =
      'Llegué tarde.\n\n—Hola —dije.\n\n—¿Vienes? —le preguntó María a Jesús.\n\n' +
      '—¡Contesta, Jesús!';
    expect(speakers(urged, 'es').at(-1)).toBe('María [speech]');
  });

  it('takes "Jesús" for a person after a speaker noun, in a full name or once he has spoken', () => {
    const opening = '—Hola —dijo Pablo.\n\n—Hola —dijo Nela.\n\n';
    const entered = (who: string) => `${opening}Entonces entró ${who}.\n\n—Buenos días.`;
    for (const who of ['su tío Jesús', 'el padre Jesús', 'el señor Jesús', 'mi primo Jesús']) {
      expect(speakers(entered(who), 'es').at(-1)).toBe('Jesús [speech]');
    }
    const told = 'Llegué tarde a casa.\n\n—Hola —me dijo Pablo.\n\n—Hola —le dije a Nela.\n\n';
    const uncle = 'Entonces entró su tío Jesús.\n\n—Buenos días.';
    expect(speakers(`${told}${uncle}`, 'es').at(-1)).toBe('Jesús [speech]');
    const evening = `${opening}Pasó la tarde.\n\nAl anochecer llegó su tío Jesús.\n\n—Buenas noches.`;
    expect(speakers(evening, 'es').at(-1)).toBe('Jesús [speech]');
    // The child is the sacred one.
    const child = `${opening}Nela rezó al niño Jesús en silencio.\n\n—¿Qué pasa?`;
    expect(newNames(child, 'es')).toEqual(['Pablo', 'Nela']);
    // "María" or "del" next to "Jesús" is sacred only in the sacred name itself.
    for (const who of ['María Jesús del Valle', 'Jesús María Pérez']) {
      expect(speakers(entered(who), 'es').at(-1)).toBe(`${who} [speech]`);
    }
    const poder = `${opening}—¡Ay, Jesús del Gran Poder! —exclamó Nela.\n\n—¿Qué pasa?`;
    expect(newNames(poder, 'es')).toEqual(['Pablo', 'Nela']);
    const spoke =
      '—Hola —dijo Jesús.\n\n—Hola —dijo María.\n\n—Buenas —dijo Pablo.\n\n' +
      'Jesús se sentó junto al fuego.\n\n—Hace frío.';
    expect(speakers(spoke, 'es').at(-1)).toBe('Jesús [speech]');
  });

  it('keeps "Jesús" sacred before a sacred word, also in a longer name', () => {
    const opening = '—Hola —dijo Pablo.\n\n—Hola —dijo Nela.\n\n';
    for (const sentence of [
      'Nela rezó a Jesús Nazareno de Medinaceli en silencio.',
      '—¡Qué miedo! —dijo Nela, encomendándose a Jesús Cautivo de Medinaceli.',
      'Por la calle pasaba la Cofradía de Jesús Nazareno.',
      '—¡Ay, Jesús María Santísima! —exclamó Nela.',
      '—¡Ay, Jesús María José! —exclamó Nela.',
      'El Colegio Jesús María estaba cerrado aquel día.',
      'La Parroquia de Jesús Obrero estaba llena.',
    ]) {
      const text = `${opening}${sentence}\n\n—¿Qué pasa?`;
      expect(newNames(text, 'es')).toEqual(['Pablo', 'Nela']);
      expect(speakers(text, 'es').at(-1)).toBe('Pablo [speech]');
    }
    // A title or a name before "Jesús María" makes it a person's name, unless it is a place.
    for (const who of ['don Jesús María', 'Fray Jesús María', 'Sor Jesús María']) {
      const entered = `${opening}Entonces entró ${who}.\n\n—Buenos días.`;
      expect(speakers(entered, 'es').at(-1)).toBe(`${who} [speech]`);
    }
    const sister = `${opening}Entonces entró sor Teresa de Jesús María.\n\n—Buenos días.`;
    expect(speakers(sister, 'es').at(-1)).toBe('Teresa de Jesús María [speech]');
    const told = 'Llegué tarde a casa.\n\n—Hola —me dijo Pablo.\n\n—Hola —le dije a Nela.\n\n';
    const balcony = 'Desde el balcón vi pasar a la Hermandad de Jesús Nazareno.\n\n—¿Qué te pasa?';
    expect(speakers(`${told}${balcony}`, 'es').at(-1)).toBe('Nela [speech]');
  });

  it('keeps "Jesús" sacred with "de" on both sides inside a longer name', () => {
    const opening = '—Hola —dijo Pablo.\n\n—Hola —dijo Nela.\n\n';
    for (const sentence of [
      'Por la calle pasaba la Cofradía de Jesús de Nazaret.',
      'La Hermandad de Jesús de Medinaceli salió a la calle.',
      'Nela entró en la Basílica de Jesús de Medinaceli.',
    ]) {
      const text = `${opening}${sentence}\n\n—¿Qué pasa?`;
      expect(newNames(text, 'es')).toEqual(['Pablo', 'Nela']);
      expect(speakers(text, 'es').at(-1)).toBe('Pablo [speech]');
    }
    // First person: whoever the narration brings in, or the last other speaker, answers.
    const told = 'Llegué tarde a casa.\n\n—Hola —me dijo Pablo.\n\n—Hola —le dije a Nela.\n\n';
    const devota = 'Mi madre era devota de la Cofradía de Jesús de Nazaret.\n\n—¿Qué te pasa?';
    expect(speakers(`${told}${devota}`, 'es').at(-1)).toBe('mi madre [speech]');
    const ventana =
      'Desde la ventana vi pasar a la Hermandad de Jesús de Medinaceli.\n\n—¿Qué te pasa?';
    expect(speakers(`${told}${ventana}`, 'es').at(-1)).toBe('Nela [speech]');
  });

  it('keeps the name after a sentence opener for a later pronoun', () => {
    const cast = castWith('en', [
      ['bingley', 'Mr. Bingley', 'male'],
      ['darcy', 'Mr. Darcy', 'male'],
      ['elizabeth', 'Elizabeth', 'female'],
    ]);
    const darcy =
      '“How do you do?” said Mr. Bingley.\n\n“Very well,” said Elizabeth.\n\n' +
      'Even Mr. Darcy smiled.\n\n“I am glad,” he said.';
    expect(speakers(darcy, 'en', cast).at(-1)).toBe('Mr. Darcy [speech]');
    const anna = 'Suddenly Anna felt very tired. She sat down.\n\n“I don’t know,” she said.';
    expect(speakers(anna, 'en')).toEqual(['Anna [speech]']);
    // A full name at a sentence start is still never the surname of someone in the cast.
    const bennet = castWith('en', [['bennet', 'Mr. Bennet', 'male']]);
    expect(speakers('Elizabeth Bennet said, “Hi.”', 'en', bennet)).toEqual(['Unknown [speech]']);
  });

  it('reads possessives as the person, and "X’s mother" as someone else', () => {
    const text =
      '“Hi,” said Elizabeth.\n\n“Hello,” said Jane.\n\nJane took Elizabeth’s hand.\n\n' +
      '“How are you?”\n\n“No,” said Lucy’s mother.';
    expect(speakers(text, 'en')).toEqual([
      'Elizabeth [speech]',
      'Jane [speech]',
      'Elizabeth [speech]',
      'Lucy’s mother [speech]',
    ]);
  });

  it('reads titles, particles and Spanish articles before names', () => {
    expect(speakers('—Sí —dijo la Nela.\n\n—Vamos —dijo el Dr. Golfín.', 'es')).toEqual([
      'Nela [speech]',
      'Dr. Golfín [speech]',
    ]);
    const titled =
      '“Come,” said St. John.\n\n“Fall in!” said Col. Forster.\n\n“Come,” said Mr. de Winter.';
    expect(newNames(titled, 'en')).toEqual(['St. John', 'Col. Forster', 'Mr. de Winter']);
    const darcy = '“I certainly shall not,” said Mr. Darcy.\n\n“Undoubtedly,” replied Darcy.';
    expect(speakers(darcy, 'en')).toEqual(['Mr. Darcy [speech]', 'Mr. Darcy [speech]']);
    expect(newNames(darcy, 'en')).toEqual(['Mr. Darcy']);
    const master = '“Not I,” said Master Bates.\n\n“Good day,” said Mister Smith.';
    expect(speakers(master, 'en')).toEqual(['Master Bates [speech]', 'Mister Smith [speech]']);
    expect(analyse(master, 'en').result.newCharacters.map((c) => [c.name, c.gender])).toEqual([
      ['Master Bates', 'male'],
      ['Mister Smith', 'male'],
    ]);
    // On its own, "Master" is still no name.
    expect(newNames('“Yes, Master,” said Tom.', 'en')).toEqual(['Tom']);
  });

  it('keeps a man apart from a woman known by his name', () => {
    const bingley = '“How charming,” said Miss Bingley.\n\n“Very,” said Bingley.';
    expect(speakers(bingley, 'en')).toEqual(['Miss Bingley [speech]', 'Bingley [speech]']);
    const joe =
      '“Well,” said Joe, glancing up at the clock.\n\n' +
      '“Where have you been, you young monkey?” said Mrs. Joe, stamping her foot.';
    expect(speakers(joe, 'en')).toEqual(['Joe [speech]', 'Mrs. Joe [speech]']);
    expect(analyse(joe, 'en').result.newCharacters.map((c) => [c.name, c.gender])).toEqual([
      ['Joe', undefined],
      ['Mrs. Joe', 'female'],
    ]);
  });

  it('never takes an owned voice for a person', () => {
    const text = '“Hi,” said Anne.\n\n“Go away,” said Tom, his voice low.\n\n“Why?”';
    expect(speakers(text, 'en')).toEqual(['Anne [speech]', 'Tom [speech]', 'Anne [speech]']);
    expect(newNames(text, 'en')).toEqual(['Anne', 'Tom']);
  });

  it('resolves replies and continuations', () => {
    expect(
      speakers(
        '“Hello,” said Anne.\n\n“Hi,” said Tom.\n\n“Well,” she replied.\n\n“So,” he said.',
        'en',
      ),
    ).toEqual(['Anne [speech]', 'Tom [speech]', 'Anne [speech]', 'Tom [speech]']);
    expect(
      speakers('—Hola —dijo Ana.\n\n—Hola —respondió Tomás.\n\n—Hace frío —añadió.', 'es'),
    ).toEqual(['Ana [speech]', 'Tomás [speech]', 'Tomás [speech]']);
    expect(
      speakers(
        '“Is it?” said Mrs. Bennet.\n\n' +
          'Mr. Bennet replied, “I have no objection,” and returned to his book.',
        'en',
      ),
    ).toEqual(['Mrs. Bennet [speech]', 'Mr. Bennet [speech]']);
  });

  it('gives a reply in a colon intro to someone else when it answers the line', () => {
    const three = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['bob', 'Bob', 'male'],
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
    ]);
    // The tag's speaker goes on.
    for (const [text, who] of [
      [
        '“Will you come?” asked Mary.\n\n“Did you see him?” asked Tom.\n\n' +
          '“Who?” said Anne, and then, recovering herself, she answered:\n\n“Yes, I saw him.”',
        'Anne',
      ],
      [
        '“Morning,” said Bob.\n\n“Where were you?” asked Anne.\n\n' +
          '“Out,” said Tom, and when she frowned, he answered:\n\n“At the mill.”',
        'Tom',
      ],
      [
        '“Good evening,” said Mary.\n\n“Will you marry me?” asked Tom.\n\n' +
          '“Well,” said Anne, and after a long pause, she answered:\n\n“Yes.”',
        'Anne',
      ],
      [
        '“Who will go?” asked Mary.\n\n“Not I,” said Anne.\n\n' +
          '“Nor I,” said Mary, and then she replied to her sister:\n\n“But Kitty might.”',
        'Mary',
      ],
      [
        '“Hi,” said Mary.\n\n“I’m going out,” said Anne. When Mary asked where, she answered:\n\n' +
          '“To the village.”',
        'Anne',
      ],
      [
        '“Hi,” said Mary.\n\n“And what could I do?” said Anne, and she answered her own question:\n\n' +
          '“Nothing at all.”',
        'Anne',
      ],
    ] as const) {
      expect(speakers(text, 'en', three).at(-1)).toBe(`${who} [speech]`);
      expect(newNames(text, 'en', three)).toEqual([]);
    }
    // Someone asked, the person the line was said to, or someone the intro opens with answers,
    // and so does the other person when nothing but the reply's "she" follows the line.
    for (const [text, who] of [
      ['“Morning,” said Bob.\n\n“Where were you?” asked Tom, and he answered:\n\n“Out.”', 'Bob'],
      [
        '“Hello,” said Mary.\n\n“Will you go?” Anne said to Mary, and she replied:\n\n“Yes.”',
        'Mary',
      ],
      [
        '“Hi,” said Mary.\n\n“Where were you?” said Anne, and she replied:\n\n“At the mill.”',
        'Mary',
      ],
      [
        '“Hi,” said Mary.\n\n“Where were you? I waited all night,” said Anne, and she replied:\n\n' +
          '“At the mill.”',
        'Mary',
      ],
      [
        '“Hi,” said Mary.\n\n“You’re late,” said Anne, and she replied:\n\n“The bus broke down.”',
        'Mary',
      ],
      [
        '“Hi,” said Bob.\n\n“It’s cold tonight,” said Anne. Mary nodded, and then she replied:\n\n' +
          '“Very cold.”',
        'Mary',
      ],
    ] as const) {
      expect(speakers(text, 'en', three).at(-1)).toBe(`${who} [speech]`);
    }
    const sisters = castWith('es', [
      ['lucia', 'Lucía', 'female'],
      ['elena', 'Elena', 'female'],
    ]);
    const thinking =
      '—¿Le has perdonado? —preguntó Lucía.\n\n' +
      '—No lo sé —dijo Elena, y después de pensarlo un rato, ella contestó:\n\n—Creo que sí.\n\n' +
      '—Me alegro.';
    expect(speakers(thinking, 'es', sisters)).toEqual([
      'Lucía [speech]',
      'Elena [speech]',
      'Elena [speech]',
      'Lucía [speech]',
    ]);
    // A call by a common noun, or a gesture that is no recovery, leaves the answer to the other.
    for (const line of [
      '—Buenas noches, hermana —dijo Elena, y ella respondió:',
      '—¿Quién es? —dijo Elena, y ella, volviéndose hacia la puerta, contestó:',
      '—¿Vienes? —dijo Elena, y ella, encogiéndose de hombros, contestó:',
    ]) {
      const text = `—Ya es tarde —dijo Lucía.\n\n${line}\n\n—No.`;
      expect(speakers(text, 'es', sisters).at(-1)).toBe('Lucía [speech]');
    }
  });

  it('gives a line after narration to the one person it brought in', () => {
    const text =
      '—Hola —dijo la abuela.\n\n' +
      'Inés dejó la maleta junto a la escalera.\n\n' +
      'En ese momento entró Julián por la puerta del patio.\n\n' +
      '—¡La señorita de la capital! —exclamó al verla.';
    expect(speakers(text, 'es')).toEqual(['la abuela [speech]', 'Julián [speech, excited]']);
  });

  it('never gives a line to the person it is said to', () => {
    expect(
      speakers(
        '—Hola —dijo Pedro.\n\n—Hola —dijo Ana.\n\n—¿Vienes? —le preguntó a Pedro.\n\n—Sí.',
        'es',
      ),
    ).toEqual(['Pedro [speech]', 'Ana [speech]', 'Ana [speech]', 'Pedro [speech]']);
    expect(speakers('—¿Quién eres? —preguntó al ciego.', 'es')).toEqual(['Unknown [speech]']);
    const cast = castWith('en', [
      ['tom', 'Tom'],
      ['anne', 'Anne'],
      ['bob', 'Bob'],
    ]);
    const text =
      '“Good morning,” said Bob.\n\n“Morning,” said Tom. “Sit down, Anne.”\n\n“Thank you.”';
    expect(speakers(text, 'en', cast).at(-1)).toBe('Anne [speech]');
  });

  it('never gives a "he" or "she" line to someone known to have another gender', () => {
    // With no woman known, "she asked" goes to the unknown speaker, not to the man who spoke last.
    const tom = castWith('en', [['tom', 'Tom', 'male']]);
    const morning = '“Morning,” I said.\n\n“Morning,” said Tom.\n\n';
    expect(speakers(`${morning}“Is it going to rain?” she asked.`, 'en', tom)).toEqual([
      'Narrator [speech]',
      'Tom [speech]',
      'Unknown [speech]',
    ]);
    expect(speakers('“Hello,” said Tom. “How are you?” she asked.', 'en', tom)).toEqual([
      'Tom [speech]',
      'Unknown [speech]',
    ]);
    // Nor through a continuation, a beat (the teller's too), the paragraph's other lines or a
    // colon intro.
    const tomBob = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['bob', 'Bob', 'male'],
    ]);
    const talk = '“Hi,” said Tom.\n\n“Hello,” said Bob.\n\n';
    for (const end of [
      '“Well,” she said.',
      '“Well,” she added.',
      '“Well,” she said. “Who knows?”',
      'She turned and said, “Well.”',
      'Tom shrugged. “Well,” she said.',
      'I shrugged. “Well,” she said.',
      'She turned and said:\n\n“Well.”',
      'Tom laughed. Then she said:\n\n“Well.”',
      'She hesitated:\n\n“Well.”',
    ]) {
      for (const who of speakers(talk + end, 'en', tomBob).slice(2)) {
        expect(who).toBe('Unknown [speech]');
      }
    }
    // Someone the user marked as another gender is not a "she" either; someone of no known
    // gender still may be.
    const robin = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['robin', 'Robin', 'other'],
    ]);
    const robinTalk = '“Hi,” said Tom.\n\n“Hello,” said Robin.\n\n“Well,” she said.';
    expect(speakers(robinTalk, 'en', robin).at(-1)).toBe('Unknown [speech]');
    const samTalk = '“Hi,” said Sam.\n\n“Hello,” said Tom.\n\n“Well,” she said.';
    expect(speakers(samTalk, 'en', tom).at(-1)).toBe('Sam [speech]');
    // A "she" at the end of a speech paragraph introduces the next line as a colon intro would.
    const added = (first: string) =>
      `“Hi,” said ${first}.\n\n“Well,” said Tom, and then she added:\n\n“It’s late.”`;
    expect(speakers(added('Bob'), 'en', tomBob).at(-1)).toBe('Unknown [speech]');
    expect(speakers(added('Anne'), 'en', tomAnne).at(-1)).toBe('Anne [speech]');
    // With genders unknown, "and then he added:" goes on with the speaker of the tag, never with
    // the person spoken to.
    for (const [text, who] of [
      ['“Hi,” said Anne.\n\n“Well,” said Tom, and then he added:\n\n“It’s late.”', 'Tom'],
      [
        'Sam and Alex sat by the fire.\n\n“Hi,” said Alex.\n\n' +
          '“Well,” said Sam, and then she added:\n\n“It’s late.”',
        'Sam',
      ],
      [
        '“Hi,” said Sam.\n\n“Hello,” said Bob.\n\n' +
          '“Listen,” Tom said to Bob, and then he added:\n\n“We leave at dawn.”',
        'Tom',
      ],
      [
        'Sam and Alex sat by the fire.\n\n“Hi,” said Sam.\n\n“Hello,” said Alex.\n\n' +
          '“Well,” she replied, and then added:\n\n“It’s late.”',
        'Sam',
      ],
    ] as const) {
      expect(speakers(text, 'en').at(-1)).toBe(`${who} [speech]`);
    }
    const sara = '—Hola —dijo Álex.\n\n—Bueno —dijo Sara, y luego ella añadió:\n\n—Es tarde.';
    expect(speakers(sara, 'es').at(-1)).toBe('Sara [speech]');

    const tomas = castWith('es', [['tomas', 'Tomás', 'male']]);
    const hola = '—Hola —dije.\n\n—Hola —dijo Tomás.\n\n—¿Va a llover? —preguntó ella.';
    expect(speakers(hola, 'es', tomas)).toEqual([
      'Narrator [speech]',
      'Tomás [speech]',
      'Unknown [speech]',
    ]);
    const anaLuz = castWith('es', [
      ['ana', 'Ana', 'female'],
      ['luz', 'Luz', 'female'],
    ]);
    const charla = '—Hola —dijo Ana.\n\n—Hola —dijo Luz.\n\n';
    for (const end of [
      '—Bueno —dijo él.',
      '—Y bien —añadió él.',
      '—¿Y tú? —Luz se encogió de hombros—. Nada —dijo él.',
      'Él se volvió y dijo:\n\n—Bueno.',
      '—Bueno —dijo Luz, y entonces él añadió:\n\n—Es tarde.',
    ]) {
      expect(speakers(charla + end, 'es', anaLuz).at(-1)).toBe('Unknown [speech]');
    }
  });

  it('reads "so", "algo" or "nada" before another word as an adverb of the tag', () => {
    expect(
      speakers('“Are you angry?” asked Tom.\n\n“Fine,” I said so quietly that he leaned in.', 'en'),
    ).toEqual(['Tom [speech]', 'Narrator [speech, whisper]']);
    for (const text of [
      '—¿Quién eres? —preguntó Tomás.\n\n—Nadie —dije algo nervioso.',
      '—¿Vienes? —preguntó Tomás.\n\n—Bueno —dije nada convencido.',
      // "nada más" before an infinitive or a participle, or ending the sentence.
      '—Toma —me dijo Tomás.\n\n—Gracias —dije nada más dármelo.',
      '—¿Vienes? —me preguntó Tomás.\n\n—Sí —dije nada más.',
    ]) {
      expect(speakers(text, 'es').at(-1)).toBe('Narrator [speech]');
    }
    const cast = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['bob', 'Bob', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    const nowhere =
      '“Where were you?” Tom asked Anne.\n\n“Out,” said Bob.\n\n' +
      '“Nowhere,” she said so quietly that nobody heard.';
    expect(speakers(nowhere, 'en', cast).at(-1)).toBe('Anne [speech, whisper]');
    expect(speakers('—¡Fuego! —gritó algo asustada.', 'es')).toEqual(['Unknown [speech, shout]']);
    // Twins: "said so", "dijo algo extraño" and "no dijo nada" report something.
    const said = '“Hi,” said Anne.\n\n“Are you sure?” asked Tom.\n\n“I said so,” said Anne.';
    expect(speakers(said, 'en')).toEqual(['Anne [speech]', 'Tom [speech]', 'Anne [speech]']);
    const algo = '—Hola —dijo Ana.\n\nTomás dijo algo.\n\n—¿Qué? —preguntó Ana.';
    expect(speakers(algo, 'es')).toEqual(['Ana [speech]', 'Ana [speech]']);
    const lately =
      '“You’re late,” said Anne.\n\n“I know,” said Tom.\n\n“You’re always late.”\n\n' +
      'Tom sighed. Everyone said so lately. “I’ll try harder.”';
    expect(speakers(lately, 'en', cast).at(-1)).toBe('Tom [speech]');
    const anaPablo = castWith('es', [
      ['ana', 'Ana', 'female'],
      ['pablo', 'Pablo', 'male'],
    ]);
    const vuelta =
      '—Hola —dijo Ana.\n\n—Hola —dijo Pablo.\n\n' +
      '—¿Me quieres? —Pablo dijo algo ininteligible y se dio la vuelta.';
    expect(speakers(vuelta, 'es', anaPablo).at(-1)).toBe('Ana [speech]');
    const camino = (narration: string) =>
      '«¿Dónde estabas?», me preguntó Ana.\n\n«Por ahí», respondí.\n\n' +
      `«¿Estás enfadado?» ${narration}\n\n«Un poco», confesé al fin.`;
    for (const narration of [
      'No dije nada en todo el camino.',
      'Tampoco dije nada esta vez.',
      'Apenas dije nada más en todo el camino.',
      'Ninguno de los dos dijo nada más durante un buen rato.',
      'Ninguno de los dos dijo nada en todo el camino.',
    ]) {
      expect(speakers(camino(narration), 'es', anaPablo)).toEqual([
        'Ana [speech]',
        'Narrator [speech]',
        'Ana [speech]',
        'Narrator [speech]',
      ]);
    }
    // "so" before "that" and a time reports what was said, like "so" alone.
    for (const narration of [
      'Tom had said so early that morning.',
      'Tom had said so only that morning.',
      'Everyone had said so repeatedly that week.',
      'Tom had said so early that very morning.',
    ]) {
      const river = `“The river is rising,” said Anne. ${narration} “We should leave.”`;
      expect(speakers(river, 'en', cast)).toEqual(['Anne [speech]', 'Anne [speech]']);
    }
  });

  it('gives a line said by "someone" or "alguien" to the unknown speaker', () => {
    const tom = castWith('en', [['tom', 'Tom', 'male']]);
    const tomBob = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['bob', 'Bob', 'male'],
    ]);
    const morning = '“Morning,” I said.\n\n“Morning,” said Tom.\n\n';
    const talk = '“Hi,” said Tom.\n\n“Hello,” said Bob.\n\n';
    for (const end of [
      '“Rain later,” someone said.',
      '“Rain later,” somebody asked.',
      '“Rain later,” said someone.',
      '“Rain later,” someone else said.',
      'Someone turned and said, “Rain later.”',
      'Someone’s voice rose and said, “Rain later.”',
      'Then someone said:\n\n“Rain later.”',
    ]) {
      expect(speakers(morning + end, 'en', tom).at(-1)).toBe('Unknown [speech]');
      expect(speakers(talk + end, 'en', tomBob).at(-1)).toBe('Unknown [speech]');
    }
    const tomas = castWith('es', [['tomas', 'Tomás', 'male']]);
    const anaLuz = castWith('es', [
      ['ana', 'Ana', 'female'],
      ['luz', 'Luz', 'female'],
    ]);
    const hola = '—Hola —dije.\n\n—Hola —dijo Tomás.\n\n';
    const charla = '—Hola —dijo Ana.\n\n—Hola —dijo Luz.\n\n';
    for (const end of [
      '—Lloverá —dijo alguien.',
      '—Lloverá —dijo entonces alguien.',
      '—Lloverá —dijo alguien más.',
      'Alguien dijo:\n\n—Lloverá.',
      'Entonces alguien se volvió y dijo:\n\n—Lloverá.',
    ]) {
      expect(speakers(hola + end, 'es', tomas).at(-1)).toBe('Unknown [speech]');
      expect(speakers(charla + end, 'es', anaLuz).at(-1)).toBe('Unknown [speech]');
    }
    // Someone spoken to is not the speaker.
    expect(speakers('“Hi,” said Tom to someone.', 'en', tom)).toEqual(['Tom [speech]']);
    expect(speakers('“Hi,” I told someone.', 'en', tom)).toEqual(['Narrator [speech]']);
    const asked = 'Tom turned and asked someone, “Where is it?”';
    expect(speakers(asked, 'en', tom)).toEqual(['Tom [speech]']);
    expect(speakers('—Hola —le dijo Tomás a alguien.', 'es', tomas)).toEqual(['Tomás [speech]']);
  });

  it('rules nobody out by a guessed gender, or by a "she" or "someone" another subject follows', () => {
    // Tom's gender is only guessed from a "she" line someone else may have said.
    const bar =
      'The door opened and Tom walked in.\n\n“Another cold night,” she said.\n\n' +
      'Tom nodded. “Very cold,” he said.';
    expect(speakers(bar, 'en').at(-1)).toBe('Tom [speech]');
    const door =
      'Fui a ver a Tomás. Se abrió la puerta.\n\n—¿Sí? —dijo ella.\n\n—¿Está Tomás? —pregunté.\n\n' +
      '—Arriba.\n\nEntonces Tomás bajó la escalera.\n\n—Hola —dijo él.';
    expect(speakers(door, 'es').at(-1)).toBe('Tomás [speech]');
    // A coordinated clause with a subject of its own is that subject's.
    const tom = castWith('en', [['tom', 'Tom', 'male']]);
    for (const end of [
      'She came in, and Tom turned and said, “Good evening.”',
      'She came in, and Tom turned and said:\n\n“Good evening.”',
      'Someone knocked, and Tom went to the door and said:\n\n“Who is it?”',
    ]) {
      expect(speakers(`Tom sat by the fire.\n\n${end}`, 'en', tom).at(-1)).toBe('Tom [speech]');
    }
    const old =
      'The old man waited.\n\nShe sat down and the old man smiled and said:\n\n“Welcome.”';
    expect(speakers(old, 'en').at(-1)).toBe('the old man [speech]');
    const tomas = castWith('es', [['tomas', 'Tomás', 'male']]);
    const knock =
      'Tomás leía junto al fuego.\n\nAlguien llamó a la puerta y Tomás se levantó y dijo:\n\n' +
      '—¿Quién es?';
    expect(speakers(knock, 'es', tomas).at(-1)).toBe('Tomás [speech]');
  });

  it('reads "said goodbye" as no tag of the line before, so its "she" rules nobody out', () => {
    const tom = castWith('en', [['tom', 'Tom', 'male']]);
    for (const after of [
      'She nodded and said goodbye.',
      'She sat down and said nothing.',
      'She said nothing.',
      'Then she said goodbye.',
    ]) {
      const text = `“I must go,” said Tom. “It’s late.” ${after}`;
      expect(speakers(text, 'en', tom)).toEqual(['Tom [speech]', 'Tom [speech]']);
    }
    const anne = castWith('en', [['anne', 'Anne', 'female']]);
    const bowed = '“Hello,” said Anne. “Come in.” He bowed and said good evening.';
    expect(speakers(bowed, 'en', anne)).toEqual(['Anne [speech]', 'Anne [speech]']);
    const nice = '“Morning,” I said. “Nice day.” He nodded and said nothing.';
    expect(speakers(nice, 'en')).toEqual(['Narrator [speech]', 'Narrator [speech]']);
    const tomas = castWith('es', [['tomas', 'Tomás', 'male']]);
    const adios = '«Me voy», dijo Tomás. «Es tarde.» Ella asintió y dijo adiós.';
    expect(speakers(adios, 'es', tomas)).toEqual(['Tomás [speech]', 'Tomás [speech]']);
    // Twin: a "she" tag of the line is still never a man's.
    const whispered = '“I must go,” said Tom. “It’s late.” She turned and whispered.';
    expect(speakers(whispered, 'en', tom).at(-1)).toBe('Unknown [speech, whisper]');
    // An -s verb joined to a clause with a subject of its own keeps its tone and speaker.
    const mom = castWith('en', [['mom', 'Mom', 'female']]);
    const hush =
      '“Hi,” I say to Mom.\n\nSomebody laughs, and Mom turns around and whispers, “Hush.”';
    expect(speakers(hush, 'en', mom).at(-1)).toBe('Mom [speech, whisper]');
    // A gender carried over from an earlier part reads like one the user set, so a "he" line is
    // never Tom's once Tom is stored as a woman, whether that came from a guess or not.
    const stored = castWith('en', [['tom', 'Tom', 'female']]);
    const morning = '“Morning,” I said to Tom.\n\n“Morning,” he said.';
    expect(speakers(morning, 'en', stored).at(-1)).toBe('Unknown [speech]');
  });

  it('takes a name before an inciso as the one addressed only when it ends the line', () => {
    const opening = '—Hola —dijo Pablo.\n\n—Hola —dijo Nela.\n\n';
    const sit = `${opening}—Siéntate, Ana —dijo Pablo.\n\n—Gracias.`;
    expect(speakers(sit, 'es').at(-1)).toBe('Ana [speech]');
    // With more words after it, the name is someone talked about, or part of an exclamation.
    for (const line of [
      '—Oye, Ana dice que vengas —dijo Nela.',
      '—¡Jesús, María y José! —exclamó Nela.',
    ]) {
      const text = `${opening}${line}\n\n—¿Qué pasa?`;
      expect(speakers(text, 'es').at(-1)).toBe('Pablo [speech]');
      expect(newNames(text, 'es')).toEqual(['Pablo', 'Nela']);
    }
  });

  it('takes a name with words of endearment as addressed, and a name talked about as no speaker', () => {
    const people = castWith('es', [
      ['tomas', 'Tomás', 'male'],
      ['pablo', 'Pablo', 'male'],
      ['ana', 'Ana', 'female'],
      ['nela', 'Nela', 'female'],
    ]);
    // A line said to Ana is never hers, with a pronoun tag or with none, and she answers it.
    const her = '—Hola —dijo Nela.\n\n—Hola —dijo Ana.\n\n—Adiós, Ana mía —dijo ella.';
    expect(speakers(her, 'es', people).at(-1)).toBe('Nela [speech]');
    const bare = '—Hola —dijo Ana.\n\n—Hola —dijo Pablo.\n\n—Adiós, Ana mía —dijo.';
    expect(speakers(bare, 'es').at(-1)).toBe('Pablo [speech]');
    const opening = '—Hola —dijo Tomás.\n\n—Hola —dijo Nela.\n\n';
    for (const [line, name] of [
      ['—Adiós, Ana mía —dijo Nela.', 'Ana'],
      ['—Ven aquí, Juanito querido —dijo Nela.', 'Juanito'],
      ['—Gracias, Ana de mi alma —dijo Nela.', 'Ana'],
    ]) {
      expect(speakers(`${opening}${line}\n\n—Adiós.`, 'es').at(-1)).toBe(`${name} [speech]`);
    }
    const mine =
      'Llegué tarde.\n\n—Hola —me dijo Ana.\n\n—Hola —le dije.\n\n—Hola —dijo Pablo.\n\n' +
      '—Adiós, Ana mía —le dije.\n\n—Adiós.';
    expect(speakers(mine, 'es').at(-1)).toBe('Ana [speech]');
    const dear =
      '“Hello,” said Tom.\n\n“Hello,” said Mary.\n\n' +
      '“Come here, Anne dear”—Mary held out her hand—“let me look at you.”\n\n“Yes, ma’am.”';
    expect(speakers(dear, 'en').at(-1)).toBe('Anne [speech]');
    // Someone the line talks about does not say it either.
    const right =
      '—Hola —dijo Nela.\n\n—Hola —dijo Pablo.\n\n—Creo que deberíamos irnos —dijo Ana.\n\n' +
      '—Sí, Ana tiene razón —dijo ella.';
    expect(speakers(right, 'es', people).at(-1)).toBe('Nela [speech]');
    const gone =
      '—Hola —dijo Tomás.\n\n—Hola —dijo Pablo.\n\nPablo se fue a su casa.\n\n' +
      '—¿Volverá? —preguntó Ana.\n\n—No, Pablo no vendrá —dijo él.';
    expect(speakers(gone, 'es', people).at(-1)).toBe('Tomás [speech]');
    // A list of people addresses its first name, who answers; a list a sacred name opens is an
    // exclamation that addresses nobody, so the talk goes back to Tomás.
    const reply = (line: string) => speakers(`${opening}${line}\n\n—¿Qué?`, 'es').at(-1);
    expect(reply('—Oye, Ana y Pablo —dijo Nela.')).toBe('Ana [speech]');
    expect(reply('—¡Jesús, María y José! —exclamó Nela.')).toBe('Tomás [speech]');
    // So are an invocation and the Holy Family with commas, and "¡Jesús, María!" alone, also with
    // a María in the cast.
    const maria = castWith('es', [
      ['tomas', 'Tomás', 'male'],
      ['nela', 'Nela', 'female'],
      ['maria', 'María', 'female'],
    ]);
    for (const line of [
      '—¡Jesús, Madre de Dios! —exclamó Nela.',
      '—¡Jesús, Madre mía! —exclamó Nela.',
      '—¡Jesús, Madre Santa! —exclamó Nela.',
      '—¡Jesús, Espíritu Santo! —exclamó Nela.',
      '—¡Jesús, María, José y todos los santos! —exclamó Nela.',
      '—¡Jesús, María! —exclamó Nela.',
    ]) {
      const text = `—Hola —dijo Tomás.\n\n—Hola —dijo Nela.\n\n${line}\n\n—¿Qué pasa?`;
      expect(speakers(text, 'es', maria).at(-1)).toBe('Tomás [speech]');
      expect(newNames(text, 'es', maria)).toEqual([]);
    }
  });

  it('takes a name as addressed with praise, a full name or a list after it, or once brought in', () => {
    const es = '—Hola —dijo Tomás.\n\n—Hola —dijo Nela.\n\n';
    for (const [line, name] of [
      ['—Buenos días, Ana preciosa —dijo Nela.', 'Ana'],
      ['—Adiós, Ana bella —dijo Tomás.', 'Ana'],
      ['—Siéntate, Ana preciosa —dijo Nela—, que te traigo un café.', 'Ana'],
      ['—Ven aquí, María de los Ángeles —dijo Nela.', 'María'],
      ['—Buenas tardes, doña María de la Paz —dijo Tomás.', 'doña María'],
      ['—¡Oye, Ana y Pablo! —dijo Nela.', 'Ana'],
    ]) {
      expect(speakers(`${es}${line}\n\n—Hola.`, 'es').at(-1)).toBe(`${name} [speech]`);
    }
    const en = '“Hello,” said Tom.\n\n“Hello,” said Mary.\n\n';
    for (const [line, name] of [
      ['“Goodnight, Anne honey”—Mary kissed her brow—“sleep well.”', 'Anne'],
      ['“Come here, Anne and Jim”—Mary waved—“quickly.”', 'Anne'],
    ]) {
      expect(speakers(`${en}${line}\n\n“Goodnight.”`, 'en').at(-1)).toBe(`${name} [speech]`);
    }
    const hat = '“Wait, Tom my boy”—Mary caught his sleeve—“you forgot your hat.”\n\n“Thank you.”';
    expect(speakers(`${en}“Hello,” said Jim.\n\n${hat}`, 'en').at(-1)).toBe('Tom [speech]');
    // A name the paragraph's first line brought in is called again by the second, whose tag names
    // someone else: the person called answers.
    const tea =
      '“Hello, Anne,” said Tom. “Anne, can you hear me?” he asked, while Mary poured the tea.';
    expect(speakers(`${en}${tea}\n\n“Yes, I can hear you.”`, 'en').at(-1)).toBe('Anne [speech]');
    const cafe =
      '—Hola, Ana —dijo Tomás—. Ana, ¿me oyes? —insistió él mientras Nela servía el café.';
    expect(speakers(`${es}${cafe}\n\n—Sí, perdona.`, 'es').at(-1)).toBe('Ana [speech]');
    // After the exclamation "¡Jesús,", a person is still called, known or not; "¡Jesús, María y
    // José!" calls nobody.
    const susto = '—¡Jesús, Ana, qué susto me has dado! —exclamó Nela.\n\n—Perdona.';
    expect(speakers(`—Hola —dijo Ana.\n\n${es}${susto}`, 'es').at(-1)).toBe('Ana [speech]');
    const entered = `${es}Ana entró sin hacer ruido.\n\n${susto}`;
    expect(speakers(entered, 'es').at(-1)).toBe('Ana [speech]');
    const sacred = `${es}—¡Jesús, María y José! —exclamó Nela.\n\n—¿Qué pasa?`;
    expect(speakers(sacred, 'es').at(-1)).toBe('Tomás [speech]');
    expect(newNames(sacred, 'es')).toEqual(['Tomás', 'Nela']);
    // The Holy Family and an invocation call nobody, even with a María or a José in the cast.
    const maria = castWith('es', [
      ['tomas', 'Tomás', 'male'],
      ['nela', 'Nela', 'female'],
      ['maria', 'María', 'female'],
      ['jose', 'José', 'male'],
    ]);
    for (const exclamation of [
      '¡Jesús, María y José!',
      '¡Jesús, José y María!',
      '¡Jesús, María Santísima!',
      '¡Jesús, Ave María Purísima!',
      '¡Jesús, Santa Bárbara!',
    ]) {
      const text = `${es}—${exclamation} —exclamó Nela.\n\n—¿Qué pasa?`;
      expect(speakers(text, 'es', maria).at(-1)).toBe('Tomás [speech]');
      expect(newNames(text, 'es', maria)).toEqual([]);
    }
  });

  it('reads a Spanish chapter heading as a heading and "una voz" without a gender', () => {
    const text = 'CAPÍTULO PRIMERO\n\n—¿Quién va? —gritó una voz.\n\n—Yo —dijo Pablo.';
    expect(speakers(text, 'es')).toEqual(['una voz [speech, shout]', 'Pablo [speech]']);
    expect(analyse(text, 'es').result.newCharacters.map((c) => [c.name, c.gender])).toEqual([
      ['una voz', undefined],
      ['Pablo', undefined],
    ]);
  });

  it('keeps emphasis away from speech that only mentions thinking', () => {
    const text = '“I thought you had gone,” said Tom, holding out a copy of The Times.';
    const start = text.indexOf('The Times');
    const result = analyzeHeuristic({
      text,
      lang: 'en',
      units: splitUnits(text, 'en', [{ start, end: start + 9, kind: 'emphasis' }]),
      cast: baseCast('en'),
    });
    expect(result.spans.find((s) => s.start === start)?.mode).toBe('narration');
  });

  it('learns aliases only from speakers, never for the narrator', () => {
    const cast = castWith('es', [['golfin', 'Golfín', 'male', ['Teodoro Golfín']]]);
    const text = 'Allí estaba también su hermano Carlos Golfín, el ingeniero.';
    expect(analyse(text, 'es', cast).result.aliasAdditions).toEqual([]);
    const firstPerson = '“You’re late, Kit,” said Abel.\n\n“Sorry,” I said.\n\n“Kit!”';
    expect(analyse(firstPerson, 'en').result.aliasAdditions).toEqual([]);
  });

  it('continues a Spanish quotation that runs over paragraphs', () => {
    const text = '«Era tarde», dijo Ana. «Estábamos cansados.\n\n»Entonces llegó la guerra.»';
    expect(speakers(text, 'es')).toEqual(['Ana [speech]', 'Ana [speech]', 'Ana [speech]']);
  });

  it('reads a state, a set phrase, a purpose or a long opening before the join, and "at last she"', () => {
    const three = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
    ]);
    const asked = '“Well?” asked Mary.\n\n';
    // A state, the rest of an object list, a comment after a modal or a purpose after an act is
    // no clause of its own: the sentence's subject says the line, and nobody new comes from it.
    for (const line of [
      'Tom stood up, Anne quite exhausted beside him, and said, “We must go.”',
      'Tom stood on the deck, Anne bound for London with him, and said, “No turning back now.”',
      'Tom kissed his mother, and Anne on both cheeks and said, “Goodbye.”',
      'Tom hesitated, Anne must have noticed, and then said, “I will think about it.”',
      'Tom thanked the doctor, and his wife, and after a pause, said, “Good night.”',
      'Tom held the door, so Anne could get through, and said, “After you.”',
    ]) {
      expect(speakers(`${asked}${line}`, 'en', three).at(-1)).toBe('Tom [speech]');
      expect(newNames(`${asked}${line}`, 'en', three)).toEqual([]);
    }
    // A verb of its own (also after "rather", an adverb, a set phrase or "herself"), a comment
    // with an object, what "so" opens after a state, and, after an opening clause, the last part
    // before the join whose subject has an irregular past ("rose").
    for (const [line, who] of [
      ['Tom came in, Anne cast a glance at him, and said, “You are late.”', 'Anne'],
      ['Tom went out, Anne cast one last look at the house, and said, “Goodbye.”', 'Anne'],
      ['Tom sat down, Anne rather objected, and said, “Not in that chair.”', 'Anne'],
      ['Tom knocked, and Anne herself opened the door and said, “Come in.”', 'Anne'],
      ['Tom came in, and Anne almost cried and said, “You are safe.”', 'Anne'],
      ['Tom came in, and Anne once more smiled and said, “Welcome back.”', 'Anne'],
      ['Tom hesitated, Anne saw it, and said, “Then don’t.”', 'Anne'],
      ['Tom was gone, so Anne could at last ask her question, and said, “Where is he?”', 'Anne'],
      [
        'When the music stopped, Anne rather wanted to sit down, and said, “Shall we rest?”',
        'Anne',
      ],
      [
        'When the music stopped, and the dancers had gone, the old man rose, and said, ' +
          '“Now we can talk.”',
        'the old man',
      ],
      [
        'When the music stopped, and Anne sat down again, the old man rose, and said, ' +
          '“Now we can talk.”',
        'the old man',
      ],
      [
        'When the music stopped, Tom looked at Anne, the old man rose, and said, “Now we can talk.”',
        'the old man',
      ],
      [
        'When the music stopped, Tom looked at Anne, her mother rose, and said, “Now we can talk.”',
        'her mother',
      ],
      [
        'Seeing Tom at the gate, and knowing what it meant, the old woman rose, and said, ' +
          '“So he has come.”',
        'the old woman',
      ],
    ] as const) {
      expect(speakers(`${asked}${line}`, 'en', three).at(-1)).toBe(`${who} [speech]`);
    }
    const present =
      '“Well?” asks Mary.\n\nTom sits down, and Anne without a word gathers up her notes and says, ' +
      '“Good night.”';
    expect(speakers(present, 'en', three).at(-1)).toBe('Anne [speech]');
    const gifts =
      '“Well?” asks Mary.\n\nTom thanks the vicar, and Anne for her gifts and says, ' +
      '“You are too kind.”';
    expect(speakers(gifts, 'en', three).at(-1)).toBe('Tom [speech]');
    const four = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['will', 'Will', 'male'],
      ['mary', 'Mary', 'female'],
    ]);
    const will = `${asked}Tom came in, Anne with Will beside her, and said, “We are all here.”`;
    expect(speakers(will, 'en', four).at(-1)).toBe('Tom [speech]');
    // "and at last she" is the sentence's own subject when she has that gender.
    const letter =
      'The letter from Tom came on a Tuesday. Mary found Anne in the garden and gave it to her ' +
      'without a word.\n\n“Well?” asked Mary. “What does he say?”\n\nAnne read it twice. ' +
      'Anne folded it into a small square, and at last she looked up and said, ' +
      '“He isn’t coming back.”\n\n“Then he’s a fool,” said Mary.';
    expect(speakers(letter, 'en', three)).toEqual([
      'Mary [speech]',
      'Mary [speech]',
      'Anne [speech]',
      'Mary [speech]',
    ]);
  });

  it('reads a Spanish state before the join, someone who sees or hears, places and a new subject', () => {
    const pablo = castWith('es', [
      ['pablo', 'Pablo', 'male'],
      ['ana', 'Ana', 'female'],
      ['nela', 'Nela', 'female'],
    ]);
    for (const [line, who] of [
      ['Pablo entró, Nela de pronto pálida, y dijo:', 'Pablo'],
      ['Pablo tosió, Ana lo oyó, y gritó desde la cocina:', 'Ana'],
      ['Pablo se sienta a su lado, y Ana por fin apoya la cabeza en su hombro y dice:', 'Ana'],
      ['Ana entra, y cuando Pablo la ve, exclama:', 'Pablo'],
      ['Ana entró, y cuando Pablo también la vio, exclamó:', 'Pablo'],
    ] as const) {
      const text = `—Ya viene —dijo Nela.\n\n${line}\n\n—¡Por fin!`;
      expect(speakers(text, 'es', pablo).at(-1)).toMatch(new RegExp(`^${who} \\[`, 'u'));
    }
    // The one who asked sees someone hesitate: the line is that person's answer.
    const hesito = '—¿Pasa algo? —preguntó Ana.\n\nPablo dudó, ella lo vio, y luego dijo:\n\n—No.';
    expect(speakers(hesito, 'es', pablo)).toEqual(['Ana [speech]', 'Pablo [speech]']);
    const four = castWith('es', [
      ['pablo', 'Pablo', 'male'],
      ['nela', 'Nela', 'female'],
      ['tomas', 'Tomás', 'male'],
      ['ana', 'Ana', 'female'],
    ]);
    for (const [opening, line, reply, who] of [
      // A state word in present narration.
      ['dice', 'Pablo se sienta, Nela por fin feliz, y dice:', '—Qué día más largo.', 'Pablo'],
      ['dice', 'Pablo entra, Nela de pronto distraída, y dice:', '—¿Qué miras?', 'Pablo'],
      // Places after the verb are more objects, not a new subject.
      [
        'dijo',
        'Pablo recorrió Toledo, y Segovia, y después de un rato, dijo:',
        '—Volvamos a casa.',
        'Pablo',
      ],
      // In present narration, someone who hears answers.
      ['dijo', 'Ana la llama desde el patio, Nela oye, y responde:', '—¡Ya voy!', 'Nela'],
      // A descriptor without the "a" of the person before it, or after "y entonces", is a new
      // subject, and so is one before a remark; "al médico" stays one more object.
      [
        'dijo',
        'Nela miró a Ana, y el médico, y después de un rato, dijo:',
        '—Hay que esperar.',
        'el médico',
      ],
      [
        'dijo',
        'Nela cerró la puerta, y entonces el médico, y después de un rato, dijo:',
        '—Hay que esperar.',
        'el médico',
      ],
      [
        'dijo',
        'Nela miró a Ana, y entonces al médico, y después de un rato, dijo:',
        '—Hay que esperar.',
        'Nela',
      ],
      [
        'dijo',
        'Nela se sentó junto al fuego, y la abuela, y ninguno lo esperaba, dijo:',
        '—Me voy.',
        'la abuela',
      ],
    ] as const) {
      const text = `—¿Dónde has estado? —${opening} Tomás.\n\n—Fuera —${opening} Pablo.\n\n${line}\n\n${reply}`;
      expect(speakers(text, 'es', four).at(-1)).toMatch(new RegExp(`^${who} \\[`, 'u'));
    }
  });

  it('takes the subject "and" brings in before a remark or right after the tag’s subject', () => {
    const cast = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['bennet', 'Mrs. Bennet', 'female'],
    ]);
    const out = '“Where have you been?” said Mrs. Bennet.\n\n“Out,” said Tom.\n\n';
    for (const [line, who] of [
      ['Mrs. Bennet looked away, and Anne, and this surprised me, said, “Yes.”', 'Anne'],
      ['Mrs. Bennet stood up, and Anne, and to my astonishment, said, “Sit down.”', 'Anne'],
      [
        'Mrs. Bennet sat down by the fire, and Tom, and no one expected it, said, “I will go.”',
        'Tom',
      ],
      ['Mrs. Bennet looked at Anne, and he, and this I will never forget, said, “Well?”', 'Tom'],
      // One more object: a list, also after people a plural noun names.
      [
        'Mrs. Bennet kissed Tom, and then Anne, and after a moment, said, “Welcome home.”',
        'Mrs. Bennet',
      ],
      [
        'Mrs. Bennet kissed the twins, and Anne, and I shall never forget it, said, ' +
          '“Welcome home, all of you.”',
        'Mrs. Bennet',
      ],
    ] as const) {
      expect(speakers(`${out}${line}`, 'en', cast).at(-1)).toBe(`${who} [speech]`);
    }
    // Right after the tag's own subject, also past an adverb, or before a reply past the person
    // the tag is said to; before "added" the people it is said to make a list.
    const slowly =
      '“Where have you been?” said Mrs. Bennet.\n\n' +
      '“Out,” said Anne slowly, and Tom, and after a moment, replied, “So were we.”';
    expect(speakers(slowly, 'en', cast)).toEqual([
      'Mrs. Bennet [speech]',
      'Anne [speech]',
      'Tom [speech]',
    ]);
    const toTom =
      '“Where have you been?” said Tom.\n\n' +
      '“Out,” said Mrs. Bennet to Tom, and Anne, and after a pause, replied, “So were we.”';
    expect(speakers(toTom, 'en', cast)).toEqual([
      'Tom [speech]',
      'Mrs. Bennet [speech]',
      'Anne [speech]',
    ]);
    const added =
      '“Where have you been?” said Tom.\n\n' +
      '“Come in,” said Mrs. Bennet to Anne, and Tom, and after a moment, added, “Both of you.”';
    expect(speakers(added, 'en', cast)).toEqual([
      'Tom [speech]',
      'Mrs. Bennet [speech]',
      'Mrs. Bennet [speech]',
    ]);
  });

  it('gives a colon intro’s reply to who answers a question, a hesitation or a line said to them', () => {
    const four = castWith('en', [
      ['tom', 'Tom', 'male'],
      ['bob', 'Bob', 'male'],
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
    ]);
    // Someone else replies: the line asked something, even after someone else's question; after
    // a scene break, a paragraph sets the scene with its people; not knowing what to say, or
    // what the teller wonders about her, asks nothing; the intro's verb has a subject of its own;
    // the intro names someone else the "she" may be.
    for (const text of [
      '“Is that you?” asked Mary.\n\n' +
        '“Where were you? I waited all night,” said Anne, and she replied:\n\n“At the inn.”',
      '“Will you come?” asked Tom.\n\n* * *\n\nAnne and Mary sat by the fire.\n\n' +
        '“You’re late,” said Anne, and she replied:\n\n“The bus broke down.”',
      '“Hi,” said Bob.\n\n' +
        '“I love you,” said Anne. Mary did not know what to say, and then she replied:\n\n' +
        '“And I you.”',
      'Anne and Mary sat by the fire.\n\n“You’re late,” said Anne. ' +
        'Mary did not know, for a moment, what to say, and then she replied:\n\n' +
        '“The bus broke down.”',
      'Anne and Mary sat by the fire.\n\n“You’re late,” said Anne. Mary looked away. ' +
        'What could she say? She shrugged, and then she replied:\n\n“The bus broke down.”',
      '“Hi,” said Bob.\n\n“You’re late,” said Anne, and Mary replied:\n\n“The bus broke down.”',
      'Anne and Mary walked home along the river. It was getting dark, and the path was ' +
        'muddy.\n\n“Is it much farther? My feet are killing me,” said Anne, glancing at Mary, ' +
        'and then she answered:\n\n“Another mile, no more.”',
    ]) {
      expect(speakers(text, 'en', four).at(-1)).toBe('Mary [speech]');
    }
    // The tag's speaker goes on: a line that only hesitates right after a heading starts the
    // answer to the question before it, and "added" goes on with the line.
    for (const text of [
      '“Will you marry me?” asked Tom.\n\nCHAPTER II\n\n' +
        '“Well,” said Anne, and she answered:\n\n“Yes.”',
      'Mary looked up from her book. “You’re late,” said Anne, and she added:\n\n“Again.”',
    ]) {
      expect(speakers(text, 'en', four).at(-1)).toBe('Anne [speech]');
    }
    const jane = castWith('en', [
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
      ['jane', 'Jane', 'female'],
    ]);
    const vocative =
      'Anne and Mary sat by the fire. Jane came in. “You’re late, Mary,” said Anne, and she ' +
      'replied:\n\n“Not as late as Jane.”';
    expect(speakers(vocative, 'en', jane).at(-1)).toBe('Mary [speech]');
    const sisters = castWith('es', [
      ['lucia', 'Lucía', 'female'],
      ['elena', 'Elena', 'female'],
    ]);
    for (const [line, who] of [
      ['—¿Nos vamos? —dijo Elena, y ella se respondió a sí misma:', 'Elena'],
      ['—¿Nos vamos? —dijo Elena, y ella, contentándose con eso, respondió:', 'Lucía'],
      ['—Te quiero —dijo Elena. Lucía no supo qué decir, y luego ella respondió:', 'Lucía'],
    ] as const) {
      const text = `—Ya es tarde —dijo Lucía.\n\n${line}\n\n—Sí.`;
      expect(speakers(text, 'es', sisters).at(-1)).toBe(`${who} [speech]`);
    }
    const pablo = castWith('es', [
      ['pablo', 'Pablo', 'male'],
      ['nela', 'Nela', 'female'],
      ['ana', 'Ana', 'female'],
    ]);
    const no =
      'Ana cosía junto al fuego.\n\n—¿Vendrás? —preguntó Pablo, y Nela dijo que no:\n\n—No puedo.';
    expect(speakers(no, 'es', pablo)).toEqual(['Pablo [speech]', 'Nela [speech]']);
  });
});
