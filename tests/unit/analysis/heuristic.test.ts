import { describe, expect, it } from 'vitest';
import type { Character, Gender } from '@/format/types';
import { splitUnits } from '@/analysis/units';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { findMentions, isPronoun, tokenize, verbAt } from '@/analysis/heuristic/mentions';
import { matchCast, type CastEntry } from '@/analysis/castMatch';
import type { LabelResult } from '@/analysis/labels';
import { baseCast } from '../../helpers/fixtures';

function analyse(text: string, cast: Character[] = baseCast()) {
  const result = analyzeHeuristic({ text, units: splitUnits(text), cast });
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
  const names = (text: string, known: string[] = []) =>
    findMentions(tokenize(text), (n) => known.includes(n)).map((m) => m.name);

  it('keeps titles with names and ignores capitals at sentence start', () => {
    expect(names('Then Mr. Bennet left. Anne stayed with Mrs. Long.')).toEqual([
      'Mr. Bennet',
      'Mrs. Long',
    ]);
    expect(names('Then Mr. Bennet left. Anne stayed.', ['Anne'])).toEqual(['Mr. Bennet', 'Anne']);
  });

  it('finds descriptors', () => {
    expect(names('cried his wife, impatiently')).toEqual(['his wife']);
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
    expect(matchCast('Harker', [entry('Jonathan Harker')])?.key).toBe('Jonathan Harker');
    expect(matchCast('Jonathan Harker', [entry('Harker')])?.key).toBe('Harker');
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
    const { lines } = analyse('“Run!” shouted Anne. “Why?” whispered Tom.');
    expect(lines).toEqual(['“Run!” → Anne [speech, shout]', '“Why?” → Tom [speech, whisper]']);
  });

  it('marks thoughts from thought verbs and from emphasised narration', () => {
    expect(analyse('“I must go,” thought Anne.').lines).toEqual(['“I must go,” → Anne [thought]']);
    const text = 'I must go, Anne thought.';
    const result = analyzeHeuristic({
      text,
      units: splitUnits(text, [{ start: 0, end: 9, kind: 'emphasis' }]),
      cast: baseCast(),
    });
    expect(describe_(text, result, baseCast())).toEqual(['I must go → Anne [thought]']);
  });

  it('gives first-person tags to the narrator', () => {
    expect(analyse('“Hello,” I said.').lines).toEqual(['“Hello,” → Narrator [speech]']);
  });

  it('alternates between two speakers in untagged dialogue', () => {
    const text = '“Hi,” said Anne.\n\n“Hello,” said Tom.\n\n“How are you?”\n\n“Fine.”';
    expect(analyse(text).lines).toEqual([
      '“Hi,” → Anne [speech]',
      '“Hello,” → Tom [speech]',
      '“How are you?” → Anne [speech]',
      '“Fine.” → Tom [speech]',
    ]);
  });

  it('resolves pronouns by gender', () => {
    const text = '“Hi,” said Mr. Smith.\n\n“Hello,” said Mrs. Jones.\n\n“Well,” he replied.';
    expect(analyse(text).lines.at(-1)).toBe('“Well,” → Mr. Smith [speech]');
  });

  it('keeps the speaker for speech continued over several paragraphs', () => {
    const text = '“It began long ago,” said Anne. “We were young.\n\n“Then the war came.”';
    expect(analyse(text).lines.at(-1)).toBe('“Then the war came.” → Anne [speech]');
  });

  it('keeps the speaker for speech in single quotes continued over several paragraphs', () => {
    for (const [open, close] of [
      ['‘', '’'],
      ["'", "'"],
    ]) {
      const text =
        `${open}Tell me,${close} said Tom.\n\n${open}It began long ago,${close} said Anne. ` +
        `${open}We were young.\n\n${open}Then the war came.${close}`;
      expect(analyse(text).lines.at(-1)).toBe(`${open}Then the war came.${close} → Anne [speech]`);
    }
  });

  it('falls back to the unknown speaker after a long stretch of narration', () => {
    const text = '“Hi,” said Anne.\n\nTime passed.\n\nYears went by.\n\n“Who is there?”';
    expect(analyse(text).lines.at(-1)).toBe('“Who is there?” → Unknown [speech]');
  });

  it('reuses characters from earlier parts and records new aliases', () => {
    const cast: Character[] = [
      ...baseCast(),
      {
        id: 'harker',
        role: 'character',
        name: 'Jonathan Harker',
        aliases: [],
        voice: { lang: 'en-US', pitch: 0.9, rate: 1 },
      },
    ];
    const { result, lines } = analyse('“Come,” said Harker. “Quickly.”', cast);
    expect(lines).toEqual([
      '“Come,” → Jonathan Harker [speech]',
      '“Quickly.” → Jonathan Harker [speech]',
    ]);
    expect(result.newCharacters).toEqual([]);
    expect(result.aliasAdditions).toEqual([{ characterId: 'harker', alias: 'Harker' }]);
  });

  it('labels narration with the narrator and tiles the text', () => {
    const text = 'It was late.\n\n“Go,” said Anne.';
    const { result } = analyse(text);
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
function castWith(people: Array<[string, string, Gender?, string[]?]>): Character[] {
  return [
    ...baseCast(),
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
const speakers = (text: string, cast?: Character[]) =>
  analyse(text, cast).lines.map((l) => l.split(' → ')[1]);
const newNames = (text: string, cast?: Character[]) =>
  analyse(text, cast).result.newCharacters.map((c) => c.name);

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
    expect(match('Jonathan Harker', [entry('Harker')])).toBe('Harker');
    expect(match('Mina Harker', [entry('Harker', ['Jonathan Harker'])])).toBeUndefined();
  });

  it('ignores apostrophe style and a possessive ’s', () => {
    expect(match("O'Brien", [entry('O’Brien')])).toBe('O’Brien');
    expect(match('Harker’s', [entry('Harker')])).toBe('Harker');
  });
});

describe('tokenize / findMentions: words that are not people', () => {
  const mentions = (text: string, known: string[] = []) =>
    findMentions(tokenize(text), (n) => known.includes(n));
  const names = (text: string, known: string[] = []) => mentions(text, known).map((m) => m.name);

  it('skips an unknown capitalised run at a sentence start, or in capitals, whole', () => {
    expect(names('Elizabeth Bennet smiled.')).toEqual([]);
    expect(names('CHAPTER II')).toEqual([]);
    expect(names('NICK DUNNE')).toEqual([]);
    expect(names('Jane Bennet smiled.', ['Jane'])).toEqual(['Jane']);
  });

  it('reads the name after a capitalised sentence opener', () => {
    expect(names('Even Mr. Darcy smiled.', ['Mr. Darcy'])).toEqual(['Mr. Darcy']);
    expect(names('Even Mr. Collins smiled.')).toEqual(['Mr. Collins']);
    expect(names('Poor Mrs. Bennet sighed.')).toEqual(['Mrs. Bennet']);
    expect(names('Suddenly Anna felt tired.')).toEqual(['Anna']);
    // "St." sits inside a full name, so the run is still skipped whole.
    expect(names('Elizabeth St. Clair smiled.')).toEqual([]);
  });

  it('never takes I-contractions for names', () => {
    expect(names('He knew I’d come, and I’m glad.')).toEqual([]);
    expect(names("He knew I'd come, and I'm glad.")).toEqual([]);
  });

  it('reads possessives as the name, never as a subject', () => {
    const found = mentions('Jane took Elizabeth’s hand.', ['Jane']);
    expect(found.map((m) => [m.name, m.possessive ?? false])).toEqual([
      ['Jane', false],
      ['Elizabeth', true],
    ]);
    expect(names('“No,” said Lucy’s mother.')).toEqual(['Lucy’s mother']);
  });

  it('keeps decomposed accents and hyphenated names in one word', () => {
    const tokens = tokenize('said Renée'.normalize('NFD'));
    expect(tokens.map((t) => t.text)).toEqual(['said', 'Renée'.normalize('NFD')]);
    expect(tokenize('said Anne-Marie').map((t) => t.text)).toEqual(['said', 'Anne-Marie']);
  });

  it('ends descriptors at another determiner or a speech verb', () => {
    expect(names('She knew that her mother was right.')).toEqual(['her mother']);
    // A speech verb ends one too: "her tell mother" names nobody, unlike "her old mother".
    expect(names('I heard her tell mother about the stranger.')).toEqual(['the stranger']);
    expect(names('I heard her old mother talk about the stranger.')).toEqual([
      'her old mother',
      'the stranger',
    ]);
  });

  it('ignores owned voices', () => {
    expect(names('said Tom, his voice low')).toEqual(['Tom']);
    // Twin: a voice nobody owns is a speaker.
    expect(names('called a voice from the dark')).toEqual(['a voice']);
  });

  it('names the person a descriptor introduces', () => {
    const [jane] = mentions('said her sister Jane');
    expect([jane?.name, jane?.gender]).toEqual(['Jane', 'female']);
  });
});

describe('analyzeHeuristic: words that are also Object.prototype keys', () => {
  // Every plain object inherits "constructor", "toString", "valueOf"… The word tables must never
  // read those as entries: in a text they are words like any other.
  const mentions = (text: string) =>
    findMentions(tokenize(text), () => false).map((m) => [m.name, m.gender]);
  /** Whether every tone and gender in the analysis of `text` is a label or missing. */
  const plainLabels = (text: string, cast?: Character[]) => {
    const { result } = analyse(text, cast);
    return [
      ...result.spans.map((s) => s.tone?.label),
      ...result.newCharacters.map((c) => c.gender),
    ].every((v) => v === undefined || typeof v === 'string');
  };

  it('finds no pronoun, speech verb, title, determiner or speaker noun in them', () => {
    for (const word of ['constructor', 'Constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(isPronoun(word)).toBeUndefined();
    }
    expect(verbAt(tokenize('the constructor said'), 1)).toBeUndefined();
    // The same as with an ordinary word in their place: "a strange voice", "said zorbit Smith",
    // "the castle guard", "Lucy’s builder".
    expect(mentions('A constructor voice said hello.')).toEqual([
      ['a constructor voice', undefined],
    ]);
    expect(mentions('said toString Smith')).toEqual([['Smith', undefined]]);
    expect(mentions('said the constructor guard')).toEqual([['the constructor guard', undefined]]);
    expect(mentions('said Lucy’s constructor')).toEqual([['Lucy', undefined]]);
  });

  it('gives a character named Constructor or ToString their lines', () => {
    for (const name of ['Constructor', 'ToString']) {
      expect(speakers(`“Who?” asked ${name}.`)).toEqual([`${name} [speech]`]);
      expect(speakers(`“Hello,” ${name} said.`)).toEqual([`${name} [speech]`]);
      expect(speakers(`“Hello,” said ${name}.`, castWith([['c', name, 'male']]))).toEqual([
        `${name} [speech]`,
      ]);
      expect(plainLabels(`“Who?” asked ${name}.`)).toBe(true);
    }
  });

  it('reads them in a tag like any other word, with no tone or gender of their own', () => {
    // Each line gets the speaker it gets with an ordinary word in place of the key: "Marlow’s
    // voice", "a strange voice", "said zorbit", "a builder of bridges", "the castle guard",
    // "Lucy’s builder", "the builder said".
    for (const [text, speaker] of [
      ['“Who?” asked Constructor’s voice.', 'Unknown [speech]'],
      ['A constructor voice said, “Hello.”', 'a constructor voice [speech]'],
      ['“Done,” said toString.', 'Unknown [speech]'],
      ['“Wait,” said Tom, a constructor of bridges.', 'Tom [speech]'],
      ['“Halt!” said the constructor guard.', 'the constructor guard [speech]'],
      ['“Hi,” said Lucy’s constructor.', 'Unknown [speech]'],
      ['“Ready,” the constructor said.', 'Unknown [speech]'],
    ] as const) {
      expect(speakers(text)).toEqual([speaker]);
      expect(plainLabels(text)).toBe(true);
    }
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
    expect(speakers(text)).toEqual([
      'Uncle Abel [speech]',
      'Narrator [speech]',
      'Uncle Abel [speech]',
      'Narrator [speech]',
    ]);
    expect(newNames(text)).toEqual(['Uncle Abel']);
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
    expect(speakers(text)).toEqual([
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
    expect(speakers(en).slice(-4)).toEqual([
      'Anne [speech]',
      'Narrator [speech]',
      'Anne [speech]',
      'Narrator [speech]',
    ]);
    // Leaving and time passing end the scene even when it ended on a question.
    const asked = en.replace('“It always is.”', '“Will you be all right?”');
    expect(speakers(asked).slice(-4)).toEqual([
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
      const turns = speakers(text);
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
        speakers(net.replace('Then Anne came in with the bread.', entrance)).slice(-3),
      ).toEqual(['Tom [speech]', 'Anne [speech]', 'Tom [speech]']);
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
      expect(speakers(en(bridge)).slice(-4)).toEqual(scene);
    }
    // Someone only named before a time cue that opens a sentence about her comes in after it,
    // unlike someone who came in before it ("Then Anne came in. Later I would remember…").
    const month = en('I had not seen Anne for a month. In the evening she came to see me.');
    expect(speakers(month).slice(-4)).toEqual(scene);
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
      expect(speakers(en(bridge)).slice(-4)).toEqual(scene);
    }
    // A name at a sentence start is a mention only once the cast knows it.
    const tomAnne = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    for (const bridge of [
      'I had asked Anne to come. Anne only arrived the next morning.',
      'Anne was not back until that evening.',
      'Anne did not even come down until that evening.',
      'Anne didn’t make it back until the next morning.',
    ]) {
      expect(speakers(en(bridge), tomAnne).slice(-4)).toEqual(scene);
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
      expect(speakers(text).at(-1)).toBe('Tom [speech]');
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
      expect(speakers(fire(bridge)).slice(-3)).toEqual([
        'Anne [speech]',
        'Tom [speech]',
        'Anne [speech]',
      ]);
    }
    // "my friend had left" reads like "The boy had left.", someone who never spoke leaving, which
    // ends no talk: Tom goes on.
    const friend = en('When I came back, my friend had left, and Anne was waiting.');
    expect(speakers(friend).slice(-4)).toEqual([
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
    const tomAnne = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    // A plan to come is no coming in when the narration goes on to tell of the arrival, in the
    // same paragraph or a later one.
    for (const bridge of [
      'I had written to Anne. Then Anne agreed to come. She arrived that evening.',
      'I wrote to the farm. Then Anne agreed to come.\n\nShe arrived the next morning.',
    ]) {
      expect(speakers(en(bridge)).slice(-4)).toEqual(scene);
      expect(speakers(en(bridge), tomAnne).slice(-4)).toEqual(scene);
    }
    // Having driven or walked over, back or round counts as arriving.
    expect(speakers(en('Anne had driven over that evening.'), tomAnne).slice(-4)).toEqual(scene);
    // A name that is also a month or a modal verb arrives like any other.
    const tomMay = castWith([
      ['tom', 'Tom', 'male'],
      ['may', 'May', 'female'],
    ]);
    const may = en('I had written to May. A few weeks later May knocked on my door.').replace(
      'asked Anne',
      'asked May',
    );
    expect(speakers(may, tomMay).slice(-4)).toEqual(scene.map((s) => s.replace('Anne', 'May')));
    // Someone already there who comes over to show something starts no scene, even when the
    // narration says what she told the teller later.
    const net =
      'Tom was mending the net when I came in.\n\n“You’re late,” said Tom.\n\n' +
      '“The tide was against me,” I said.\n\n“It always is.”\n\n' +
      'Then Anne came to show me the letter. Later she told me Tom returned it to her unopened.\n\n' +
      '“Good evening,” said Anne.\n\n“Sit down, girl. Your brother has news.”\n\n“What news?”';
    expect(speakers(net, tomAnne).slice(-3)).toEqual([
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
    ]);
  });

  it('starts a scene for someone named again in a wait that ends at a time', () => {
    const scene = ['Anne [speech]', 'Narrator [speech]', 'Anne [speech]', 'Narrator [speech]'];
    const en = (bridge: string) =>
      'I met Tom at the station.\n\n“You’re late,” said Tom.\n\n“The train was slow,” I said.\n\n' +
      `“It always is.”\n\n${bridge}\n\n` +
      '“How was the trip?” asked Anne.\n\n“Long.”\n\n“Did Tom meet you?”\n\n“He did.”';
    const tomAnne = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    // Only named at first, then by her name or as "she" in a sentence that waits for a time,
    // which comes right after "until" or after its article.
    for (const bridge of [
      'I had asked Anne to come. Anne did not come back until the next morning.',
      'I had asked Anne to come. Anne did not come until that evening.',
      'I had asked Anne to come. She did not come until the next morning.',
      'I had asked Anne to come. She was not back until that evening.',
    ]) {
      expect(speakers(en(bridge), tomAnne).slice(-4)).toEqual(scene);
    }
    // A name that is also an auxiliary ("Will did not come back") waits like any other.
    const tomWill = castWith([
      ['tom', 'Tom', 'male'],
      ['will', 'Will', 'male'],
    ]);
    const will = en(
      'I had asked Will to come. Will did not come back until the next morning.',
    ).replace('asked Anne', 'asked Will');
    expect(speakers(will, tomWill).slice(-4)).toEqual([
      'Will [speech]',
      'Narrator [speech]',
      'Will [speech]',
      'Narrator [speech]',
    ]);
  });

  it('starts a scene once a plan to come ends in an arrival, past an adverb or an opening time', () => {
    const scene = ['Anne [speech]', 'Narrator [speech]', 'Anne [speech]', 'Narrator [speech]'];
    const en = (bridge: string) =>
      'I met Tom at the station.\n\n“You’re late,” said Tom.\n\n“The train was slow,” I said.\n\n' +
      `“It always is.”\n\n${bridge}\n\n` +
      '“How was the trip?” asked Anne.\n\n“Long.”\n\n“Did Tom meet you?”\n\n“He did.”';
    const tomAnne = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    for (const bridge of [
      'I wrote to the farm. Then Anne agreed to come.\n\nThe next morning she knocked at my door.',
      'I wrote to the farm. Then Anne agreed to come.\n\n' +
        'The next morning she quietly knocked at my door.',
      'I wrote to the farm. Then Anne finally agreed to come.\n\nShe arrived the next morning.',
      // The plan ends its clause: the next sentence's "Again" is not "come again".
      'I wrote to the farm. Then Anne agreed to come. Again I waited.\n\n' +
        'She arrived the next morning.',
    ]) {
      expect(speakers(en(bridge), tomAnne).slice(-4)).toEqual(scene);
    }
  });

  it('starts no scene when someone who came over comes back after a bare "Later"', () => {
    const net = (bridge: string) =>
      'Tom was mending the net when I came in.\n\n“You’re late,” said Tom.\n\n' +
      `“The tide was against me,” I said.\n\n“It always is.”\n\n${bridge}\n\n` +
      '“Good evening,” said Anne.\n\n“Sit down, girl. Your brother has news.”\n\n“What news?”';
    const tomAnne = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    // A bare "Later" moves the narration to no new time, so coming back then is no arrival after
    // a plan to come, in one paragraph or two: Anne joins the talk, and Tom goes on.
    for (const bridge of [
      'Then Anne rose to come over. Later she came back with a pot of tea.',
      'Then Anne rose to come over.\n\nLater she came back with a pot of tea.',
    ]) {
      expect(speakers(net(bridge), tomAnne).slice(-3)).toEqual([
        'Anne [speech]',
        'Tom [speech]',
        'Anne [speech]',
      ]);
    }
  });

  it('starts a scene once everyone else has left, or at an arrival another sentence reports on', () => {
    const scene = ['Anne [speech]', 'Narrator [speech]', 'Anne [speech]', 'Narrator [speech]'];
    const en = (bridge: string) =>
      'I met Tom at the station.\n\n“You’re late,” said Tom.\n\n“The train was slow,” I said.\n\n' +
      `“It always is.”\n\n${bridge}\n\n` +
      '“How was the trip?” asked Anne.\n\n“Long.”\n\n“Did Tom meet you?”\n\n“He did.”';
    expect(
      speakers(
        en('When I came back, everyone else had left, and Anne was sitting alone by the fire.'),
      ).slice(-4),
    ).toEqual(scene);
    // Only an aside in the arrival's own sentence is someone's report of it.
    const tomAnne = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    const cold = en(
      'I had asked Anne to come. She arrived that evening. It was late, Tom said, and very cold.',
    );
    expect(speakers(cold, tomAnne).slice(-4)).toEqual(scene);
  });

  it('starts no scene for the time of something else, nor for coming with someone who spoke', () => {
    const net = (bridge: string) =>
      'Tom was mending the net when I came in.\n\n“You’re late,” said Tom.\n\n' +
      `“The tide was against me,” I said.\n\n“It always is.”\n\n${bridge}\n\n` +
      '“Good evening,” said Anne.\n\n“Sit down, girl. Your brother has news.”\n\n“What news?”';
    const tomAnne = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    // A time that is something else's, past its article ("the bread for the next day"), in her own
    // clause or in a later sentence about her, and coming in with Tom, who has spoken: Tom goes on.
    for (const bridge of [
      'Then Anne came in with the bread for the next day.',
      'I saw Anne by the fire. She came with the bread for the next day.',
      'I had asked Anne to come, and Tom went to the station to meet her. ' +
        'She came with Tom that evening.',
    ]) {
      expect(speakers(net(bridge), tomAnne).slice(-3)).toEqual([
        'Anne [speech]',
        'Tom [speech]',
        'Anne [speech]',
      ]);
    }
  });

  it('matches a named narrator by its name and aliases', () => {
    const aliased = baseCast().map((c) =>
      c.role === 'narrator' ? { ...c, aliases: ['Watson'] } : c,
    );
    const first = '“You look tired, Watson,” said Holmes.\n\n“I slept badly.”\n\n“So did I.”';
    expect(speakers(first, aliased)).toEqual([
      'Holmes [speech]',
      'Narrator [speech]',
      'Holmes [speech]',
    ]);
    expect(newNames(first, aliased)).toEqual(['Holmes']);

    const renamed = baseCast().map((c) =>
      c.role === 'narrator' ? { ...c, name: 'John Watson' } : c,
    );
    const second = '“Sit down, Watson,” said Holmes.\n\n“Thank you.”\n\n“Hello,” said Watson.';
    expect(speakers(second, renamed)).toEqual([
      'Holmes [speech]',
      'John Watson [speech]',
      'John Watson [speech]',
    ]);
    expect(newNames(second, renamed)).toEqual(['Holmes']);
  });

  it('never gives "he" or "she" to the narrator', () => {
    expect(speakers('“I am here,” I said.\n\n“Good,” she said.')).toEqual([
      'Narrator [speech]',
      'Unknown [speech]',
    ]);
    expect(speakers('“Hi,” I said. “Hello,” she said.')).toEqual([
      'Narrator [speech]',
      'Unknown [speech]',
    ]);
    const tom = castWith([['tom', 'Tom', 'male']]);
    const morning = '“Morning,” I said.\n\n“Morning,” said Tom.\n\n';
    for (const line of ['“Is it going to rain?” she asked.', '“Rain later,” someone said.']) {
      expect(speakers(morning + line, tom).at(-1)).not.toBe('Narrator [speech]');
    }
    // A self-introduction makes the narrator present, but still not "she".
    const kit =
      'My name is Kit. I keep the lighthouse.\n\n“Morning,” said Tom.\n\n' +
      '“Is it going to rain?” she asked.';
    expect(speakers(kit, tom).at(-1)).not.toBe('Narrator [speech]');
  });

  it('reads English first-person tags in their usual shapes', () => {
    for (const text of ['“No,” I’d said.', "“No,” I'd said."]) {
      expect(speakers(text)).toEqual(['Narrator [speech]']);
      expect(newNames(text)).toEqual([]);
    }
    expect(speakers('“Where are you going?” I asked Holmes.\n\n“Out.”')).toEqual([
      'Narrator [speech]',
      'Holmes [speech]',
    ]);
    expect(speakers('“Where?” asked Anne.\n\nI turned to her and said, “Home.”')).toEqual([
      'Anne [speech]',
      'Narrator [speech]',
    ]);
    expect(speakers('“No,” I had said.\n\n“No,” I would say.\n\n“No,” I finally said.')).toEqual([
      'Narrator [speech]',
      'Narrator [speech]',
      'Narrator [speech]',
    ]);
    expect(speakers('I turned to Anne and said:\n\n“Go.”')).toEqual(['Narrator [speech]']);
    expect(speakers('“Where?” I ask.')).toEqual(['Narrator [speech]']);
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
      expect(speakers(kit(middle)).at(-1)).toBe('Narrator [speech]');
      expect(newNames(kit(middle))).toEqual(['Uncle Abel']);
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
      expect(speakers(text).at(-1)).toBe('Narrator [speech]');
      expect(newNames(text)).not.toContain('Kit');
    }
  });

  it('turns first-person rules on for a later "I" or a past "would"', () => {
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
      expect(speakers(then(middle)).at(-1)).toBe('Narrator [speech]');
      expect(newNames(then(middle))).not.toContain('Kit');
    }
    // Twins: an "I" in an aside or in a clause "when" opens does not say the verb, nor does the
    // teller when someone else may: "I would add that…" (third person: Davy).
    const rosa = (intro: string) =>
      `Mrs. Rosa was at the window.\n\n${intro}\n\n“The boy is here.”\n\n` +
      '“Come here, Davy,” said Mrs. Rosa.\n\n“Yes, ma’am.”\n\n“And bring the basket.”';
    for (const intro of [
      'I suppose, as I said, the cook sighed and said:',
      'I think, when I was young, the cook sighed and said:',
      'I would add that the cook sighed and said:',
    ]) {
      expect(speakers(rosa(intro)).at(-2)).toBe('Davy [speech]');
    }
  });

  it('turns first-person rules on for lines said to the narrator', () => {
    const kit = (tag: string) =>
      `My uncle was in the kitchen.\n\n“You’re late, Kit,” ${tag}.\n\n` +
      '“The tide was against me.”\n\n“The tide is always against you, Kit.”\n\n“Then I row.”';
    for (const tag of ['he told me', 'my uncle said to me', 'my uncle asked me']) {
      expect(speakers(kit(tag)).at(-1)).toBe('Narrator [speech]');
      expect(newNames(kit(tag))).toEqual(['my uncle']);
    }
    const clerk =
      'The clerk looked up from his ledger.\n\n“Late again, Kit?” I was asked.\n\n' +
      '“The tide was against me.”\n\n“Sign here, Kit.”\n\n“Yes, sir.”';
    expect(speakers(clerk)).toEqual([
      'the clerk [speech]',
      'Narrator [speech]',
      'the clerk [speech]',
      'Narrator [speech]',
    ]);
    expect(newNames(clerk)).toEqual(['the clerk']);
  });

  it('reads present-tense tags with a name, "to" someone, "myself" or an adverb', () => {
    const text =
      '“You’re up early,” said Mom.\n\n“I couldn’t sleep,” I answer quietly.\n\n' +
      '“Bad dreams?”\n\n“Not really,” I tell Mom.\n\n“Okay.”';
    expect(speakers(text)).toEqual([
      'Mom [speech]',
      'Narrator [speech, whisper]',
      'Mom [speech]',
      'Narrator [speech]',
      'Mom [speech]',
    ]);
    expect(speakers('“Shh,” I whisper to her.')).toEqual(['Narrator [speech, whisper]']);
    expect(speakers('“Nearly,” I tell Mrs. Pruett.\n\n“Good.”')).toEqual([
      'Narrator [speech]',
      'Mrs. Pruett [speech]',
    ]);
    expect(speakers('“Again?” I ask Mom again.')).toEqual(['Narrator [speech]']);
    expect(speakers('“Calm down,” I tell myself.')).toEqual(['Narrator [thought]']);
    // Thinking stays strict: what follows is a clause, not someone spoken to.
    expect(speakers('“Hello.” I think Mom knew.')).toEqual(['Unknown [speech]']);
    // A question with "I" after its auxiliary is no tag, in either tense.
    const mom = castWith([['mom', 'Mom', 'female']]);
    const turns = ['Mom [speech]', 'Narrator [speech]', 'Mom [speech]'];
    const dad =
      'Mom set down her fork. “Is something wrong?” Should I tell Dad? I couldn’t.\n\n' +
      '“Nothing,” I said.\n\n“Okay.”';
    expect(speakers(dad, mom)).toEqual(turns);
    expect(newNames(dad, mom)).toEqual([]);
    const again =
      'Mom grabs her keys. “Ready?” Can I ask again? Better not.\n\n“Yes,” I say.\n\n“Go.”';
    expect(speakers(again, mom)).toEqual(turns);
    expect(speakers(dad.replace('Should', 'Shouldn’t'), mom)).toEqual(turns);
    // An order that only stresses ("Only then did I tell him.") is still a tag.
    const nor = '“No,” Mom says.\n\n“Please?” Nor do I reply.\n\n“No.”';
    expect(speakers(nor, mom)).toEqual(turns);
    const parents = castWith([
      ['dad', 'Dad', 'male'],
      ['mom', 'Mom', 'female'],
    ]);
    const then =
      '“Morning,” said Dad.\n\n“Morning,” I said.\n\n“Sleep well?”\n\n“Not really.”\n\n' +
      'He poured the coffee and waited. Only then did I tell him. “Mom called.”\n\n“When?”';
    expect(speakers(then, parents).slice(-2)).toEqual(['Narrator [speech]', 'Dad [speech]']);
    // Someone's reaction after the narrator's clause tags the line, in either tense.
    const family = castWith([
      ['mom', 'Mom', 'female'],
      ['jonah', 'Jonah', 'male'],
    ]);
    const laughs =
      '“Morning,” says Jonah.\n\n“Morning,” I say.\n\n' +
      'I whisper to Mom, and Jonah laughs. “I heard that.”';
    expect(speakers(laughs, family).at(-1)).toBe('Jonah [speech, happy]');
    // After "the" or a possessive such a form is a noun, so the beat still names the speaker.
    const gulls = '“Hi,” said Jonah.\n\nMom heard the cries of the gulls. “Listen.”';
    expect(speakers(gulls, family)).toEqual(['Jonah [speech]', 'Mom [speech]']);
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
    expect(speakers(clerk)).toEqual(turns);
    const present =
      '“Morning,” I say.\n\nThe clerk looks up from his ledger.\n\n“Name?” I’m asked.\n\n' +
      '“Kit Morrow.”\n\n“Business?”\n\n“Family.”';
    expect(speakers(present)).toEqual(turns);
    const anne = castWith([['anne', 'Anne', 'female']]);
    const saidToMe =
      '“Morning,” I said.\n\n“Good morning,” Anne said to me.\n\n' +
      '“Where are you from?” I was asked.\n\n“Leeds.”';
    expect(speakers(saidToMe, anne)).toEqual([
      'Narrator [speech]',
      'Anne [speech]',
      'Anne [speech]',
      'Narrator [speech]',
    ]);
    expect(speakers('“Name?” I was asked.')).toEqual(['Unknown [speech]']);
    expect(speakers('“Name?” I’m also asked.')).toEqual(['Unknown [speech]']);
    const colon = 'The clerk looked up from his ledger. Then I was asked:\n\n“Name?”';
    expect(speakers(colon)).toEqual(['the clerk [speech]']);
  });

  it('reads hearsay about a line by the verb it reports ("I was told I said")', () => {
    const tom = castWith([['tom', 'Tom', 'male']]);
    expect(speakers('“Hello,” said Tom.\n\n“Yes,” I was told I answered.', tom)).toEqual([
      'Tom [speech]',
      'Narrator [speech]',
    ]);
    const said = '“Morning,” I said.\n\n“Hello,” said Tom.\n\n“Yes,” I’m told I said.';
    expect(speakers(said, tom)).toEqual(['Narrator [speech]', 'Tom [speech]', 'Narrator [speech]']);
    expect(speakers('“I love you,” I’m told I whispered.')).toEqual(['Narrator [speech, whisper]']);
    expect(speakers('“Yes,” so I was told I had said.')).toEqual(['Narrator [speech]']);
    // Without a reported speech verb the line is still said to the narrator.
    expect(speakers('“Sit,” I was told I could.')).toEqual(['Unknown [speech]']);
  });

  it('gives the narrator the answer to what an unknown voice asked them', () => {
    const turns = [
      'Unknown [speech]',
      'Narrator [speech]',
      'Unknown [speech]',
      'Narrator [speech]',
    ];
    const en =
      '“What’s your name?” somebody asked me.\n\n“Kit.”\n\n“Where from?”\n\n' +
      '“The lighthouse,” I said.';
    expect(speakers(en)).toEqual(turns);
    // Only the very next line answers: not after a scene break.
    const dark = (gap: string) => `“Wait here,” somebody told me.\n\n${gap}“Who’s there?”`;
    expect(speakers(dark(''))).toEqual(['Unknown [speech]', 'Narrator [speech]']);
    expect(speakers(dark('* * *\n\n'))).toEqual(['Unknown [speech]', 'Unknown [speech]']);
    // Third-person parts keep their turn-taking: there the unknown voice is not answered.
    const anne = castWith([['anne', 'Anne', 'female']]);
    expect(speakers('“Where are you going, Anne?” somebody asked.\n\n“Home.”', anne)).toEqual([
      'Unknown [speech]',
      'Unknown [speech]',
    ]);
  });

  it('reads talking to oneself as thought', () => {
    expect(speakers('“Fool,” I told myself.')).toEqual(['Narrator [thought]']);
    expect(speakers('“Hello.” I think she was lying.')).toEqual(['Unknown [speech]']);
  });

  it('reads saying something "to" oneself as thought', () => {
    expect(speakers('“Fool,” I said to myself.')).toEqual(['Narrator [thought]']);
    const anne = castWith([['anne', 'Anne', 'female']]);
    expect(speakers('“I must hurry,” Anne said to herself.', anne)).toEqual(['Anne [thought]']);
  });

  it('lets the narrator answer in a two-person first-person exchange', () => {
    expect(
      speakers('“Hi,” I said.\n\n“Where were you?” asked Anne.\n\nI shrugged.\n\n“Nowhere.”'),
    ).toEqual(['Narrator [speech]', 'Anne [speech]', 'Narrator [speech]']);
  });

  it('gives the narrator the line after a first-person beat', () => {
    // Turn-taking alone would give the last line to Anne, who spoke before Tom.
    const en =
      '“Hi,” I said.\n\n“Where were you?” asked Anne.\n\n“Out,” said Tom.\n\n' +
      'I shrugged. “Nowhere.”';
    expect(speakers(en)).toEqual([
      'Narrator [speech]',
      'Anne [speech]',
      'Tom [speech]',
      'Narrator [speech]',
    ]);
  });

  it('never makes a character of the narrator’s own name', () => {
    const text = 'My name is Ishmael.\n\n“Where are you going?” asked the captain.\n\n“To sea.”';
    expect(speakers(text)).toEqual(['the captain [speech]', 'Narrator [speech]']);
    expect(newNames(text)).toEqual(['the captain']);
  });

  it('never makes a character of the name others call the narrator', () => {
    const kit =
      'Everyone in the village called me Kit.\n\n“Kit!” shouted my uncle.\n\n“Coming!” I said.\n\n' +
      '“Hurry, Kit.”\n\n“I am hurrying.”';
    expect(speakers(kit).at(-1)).toBe('Narrator [speech]');
    expect(newNames(kit)).toEqual(['my uncle']);
    // The narrator then answers to that name, also after a pause ("…"), which is no comma.
    const called = (intro: string, name: string) =>
      `${intro}\n\n“${name}!” shouted my uncle.\n\n“Coming!” I said.\n\n` +
      `“Hurry, ${name}.”\n\n“I am hurrying.”`;
    for (const [intro, name, other] of [
      ['My uncle calls me Kit.', 'Kit', 'my uncle'],
      ['They named me Kit.', 'Kit', 'my uncle'],
      ['My name is… Kit.', 'Kit', 'my uncle'],
    ] as const) {
      expect(speakers(called(intro, name)).at(-1)).toBe('Narrator [speech]');
      expect(newNames(called(intro, name))).toEqual([other]);
    }
    // A name after a comma, or a possessive, is someone else: the one person brought in.
    const tom = (sentence: string) =>
      `“Morning,” I said.\n\nThe sun was up.\n\n${sentence}\n\n“Ready?”`;
    expect(speakers(tom('Everyone called me Tom.')).at(-1)).toBe('Unknown [speech]');
    for (const sentence of [
      'They called me, Tom included, a dreamer.',
      'Everyone called me Tom’s shadow.',
    ]) {
      expect(speakers(tom(sentence)).at(-1)).toBe('Tom [speech]');
    }
    // A nickname after "call me" is the narrator's too.
    const oldMan =
      '“Where are you going?” asked Anne.\n\n“Home,” I said.\n\n' +
      'The children call me the old man, and old men go home early.\n\n“Why?”\n\n“Because.”';
    expect(speakers(oldMan)).toEqual([
      'Anne [speech]',
      'Narrator [speech]',
      'Anne [speech]',
      'Narrator [speech]',
    ]);
    expect(newNames(oldMan)).toEqual(['Anne']);
  });

  it('brings in whoever opens the sentence after "called me."', () => {
    const uncle =
      '“Morning,” I said.\n\nThe kitchen was cold. Mother called me. My uncle was already at the ' +
      'table.\n\n“Sit down.”\n\n“Yes, sir,” I said.';
    expect(speakers(uncle)).toEqual([
      'Narrator [speech]',
      'my uncle [speech]',
      'Narrator [speech]',
    ]);
    const tom = castWith([['tom', 'Tom', 'male']]);
    const door =
      '“Morning,” I said.\n\nThen she called me! Tom was already at the door.\n\n“Ready?”';
    expect(speakers(door, tom)).toEqual(['Narrator [speech]', 'Tom [speech]']);
  });

  it('reads a nickname set off by emphasis, a dash, a colon or the question it answers', () => {
    const kit = (intro: string) =>
      `${intro}\n\n“Kit!” shouted my uncle.\n\n“Coming!” I said.\n\n“Hurry, Kit.”\n\n` +
      '“I am hurrying.”';
    for (const intro of ['Everyone in the village called me *Kit*.', 'My name is *Kit*.']) {
      expect(speakers(kit(intro)).at(-1)).toBe('Narrator [speech]');
      expect(newNames(kit(intro))).toEqual(['my uncle']);
    }
    const anne = (sentence: string) =>
      `“Where are you going?” asked Anne.\n\n“Home,” I said.\n\n${sentence}\n\n“Why?”\n\n“Because.”`;
    for (const sentence of [
      'The children call me _the old man_, and old men go home early.',
      'The children call me—the old man—and old men go home early.',
      'They had one name for me; they called me: the old man.',
      'And what do the children call me? The old man. Old men go home early.',
    ]) {
      expect(speakers(anne(sentence)).at(-2)).toBe('Anne [speech]');
      expect(newNames(anne(sentence))).toEqual(['Anne']);
    }
    // Twins: after a dash or a colon the sentence goes on, and "who" asks for whoever called.
    const uncle = (sentence: string) =>
      `“Morning,” I said.\n\n${sentence}\n\n“Sit down.”\n\n“Yes, sir,” I said.`;
    for (const sentence of [
      'Mother called me—my uncle was already at the table.',
      'Then Mother called me: my uncle was waiting in the hall.',
      'The phone rang at six. Who called me? My uncle, of course.',
    ]) {
      expect(speakers(uncle(sentence))[1]).toBe('my uncle [speech]');
    }
    for (const sentence of [
      'Who knew my name well enough to have called me? Mr. Collins, at the door.',
      'Then some one called me:—Mr. Collins, from the hall.',
    ]) {
      const cousin = `“Good morning,” I said.\n\n${sentence}\n\n“Good morning, cousin.”`;
      expect(speakers(cousin)[1]).toBe('Mr. Collins [speech]');
    }
  });

  it('reads a nickname after a parenthesis or with a phrase that qualifies it', () => {
    const kit = (intro: string) =>
      `${intro}\n\n“Kit!” shouted my uncle.\n\n“Coming!” I said.\n\n“Hurry, Kit.”\n\n` +
      '“I am hurrying.”';
    for (const intro of [
      'Everyone in the village called me (and still calls me) Kit.',
      'Everyone in the village called me ***Kit***.',
    ]) {
      expect(speakers(kit(intro)).at(-1)).toBe('Narrator [speech]');
      expect(newNames(kit(intro))).toEqual(['my uncle']);
    }
    const anne = (sentence: string) =>
      `“Where are you going?” asked Anne.\n\n“Home,” I said.\n\n${sentence}\n\n“Why?”\n\n“Because.”`;
    for (const sentence of [
      'And what did the children call me?—the old man. Old men go home early.',
      'At school they called me—the girl with the red hair—and I hated it.',
      'What did the children call me? The old man of the lighthouse. Old men go home early.',
      'And the name the children called me? The old man. Old men go home early.',
      'There was but one name for me in that house; they called me:—the boy.',
    ]) {
      expect(speakers(anne(sentence)).at(-2)).toBe('Anne [speech]');
      expect(newNames(anne(sentence))).toEqual(['Anne']);
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
      expect(speakers(uncle(sentence))[1]).toBe('my uncle [speech]');
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
    expect(speakers(text)).toEqual([
      'the vicar [speech]',
      'my aunt [speech]',
      'the vicar [speech]',
      'my aunt [speech]',
    ]);
  });

  it('marks narration and "I" lines for whoever tells the passage', () => {
    const text = 'It rained.\n\n“Hi,” I said.\n\n“Hello,” said Anne.\n\n“Bye.”';
    const { result } = analyse(text);
    const marked = result.spans
      .filter((s) => s.teller)
      .map((s) => text.slice(s.start, s.end).trim());
    expect(marked).toEqual(['It rained.', '“Hi,”', 'I said.', 'said Anne.']);
    for (const span of result.spans.filter((s) => s.teller)) {
      expect(span.speaker).toEqual({ kind: 'cast', id: 'narrator' });
    }
  });

  it('marks lines the narrator says through an intro, a beat or a continued quote', () => {
    const marked = (text: string, cast?: Character[]) =>
      analyse(text, cast)
        .result.spans.filter((s) => s.mode !== 'narration')
        .map((s) => `${text.slice(s.start, s.end).trim()}${s.teller ? ' (I)' : ''}`);
    expect(marked('“Hi,” said Anne.\n\nI turned to Anne and said:\n\n“Go.”')).toEqual([
      '“Hi,”',
      '“Go.” (I)',
    ]);
    expect(marked('“Where were you?” asked Anne.\n\nI shrugged. “Nowhere.”')).toEqual([
      '“Where were you?”',
      '“Nowhere.” (I)',
    ]);
    expect(
      marked('“It was a long road,” I said, “and a hard one.\n\n“But we made it home.”'),
    ).toEqual(['“It was a long road,” (I)', '“and a hard one. (I)', '“But we made it home.” (I)']);
    // A narrator called Nick, named here: his line is not an "I" line.
    const nick = baseCast().map((c) => (c.role === 'narrator' ? { ...c, aliases: ['Nick'] } : c));
    expect(marked('Nick turned to me and said, “Come.”', nick)).toEqual(['“Come.”']);
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
    const { result } = analyse(text);
    expect(speakers(text)).toEqual([
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
    expect(speakers(text)).toEqual([
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
    expect(speakers(collins).at(-1)).toBe('Mr. Collins [speech]');
    const sisters = castWith([
      ['elizabeth', 'Elizabeth', 'female'],
      ['jane', 'Jane', 'female'],
    ]);
    const restless =
      'Elizabeth and Jane sat by the fire.\n\n' +
      '“Shall we go?” said Elizabeth, who, as I said, was restless.\n\n“Not yet.”';
    expect(speakers(restless, sisters)).toEqual(['Elizabeth [speech]', 'Jane [speech]']);
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
      expect(speakers(bennet(intro)).at(-1)).toBe('Davy [speech]');
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
      expect(speakers(bennet(intro)).at(-1)).toBe('Davy [speech]');
    }
  });

  it('ignores an authorial "I" whose words have a curly apostrophe ("I don’t doubt")', () => {
    const doubt =
      'Mrs. Bennet sat by the window.\n\n' +
      'I don’t doubt Mrs. Bennet turned, then said, “The boy is here.”\n\n' +
      '“Come here, Davy,” said Mrs. Bennet.\n\n“Yes, ma’am.”';
    expect(speakers(doubt)).toEqual([
      'Mrs. Bennet [speech]',
      'Mrs. Bennet [speech]',
      'Davy [speech]',
    ]);
  });

  it('ignores a "me" in hearsay or in a character’s thought', () => {
    const cast = castWith([
      ['anne', 'Anne', 'female'],
      ['tom', 'Tom', 'male'],
      ['davy', 'Davy', 'male'],
    ]);
    const turns = ['Anne [speech]', 'Tom [speech]', 'Anne [speech]', 'Tom [speech]'];
    const hearsay =
      'Anne and Tom sat by the fire.\n\n“Where is Davy?” I was told she asked that night.\n\n' +
      '“Out, Anne.”\n\n“Out where, Tom?”\n\n“Fishing.”';
    expect(speakers(hearsay, cast)).toEqual(turns);
    const thought =
      'Anne and Tom were in the garden.\n\n' +
      '“It’s late.” She told me that every night, Tom thought.\n\n' +
      '“Not yet.”\n\n“Come in, Tom.”\n\n“In a minute.”';
    expect(speakers(thought, cast)).toEqual(turns);
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
      expect(speakers(scene(aside))).toEqual(turns);
      expect(newNames(scene(aside))).toEqual(['Mrs. Bennet', 'Davy']);
    }
  });

  it('reads no tag in an aside about what someone says', () => {
    // "as my aunt told me" is about Mrs. Bennet's nerves, not the line: "my aunt" says nothing,
    // and Mrs. Bennet, whom the narration brought in, speaks first.
    const scene = (aside: string) =>
      `Mrs. Bennet sat by the window.\n\n${aside} “Come here, Davy.”\n\n` +
      '“Yes, ma’am.”\n\n“Sit, Davy.”\n\n“Yes.”';
    for (const aside of [
      'Mrs. Bennet was nervous, as my aunt told me.',
      'She was nervous, as my aunt told me.',
      'She was nervous, or so I was told.',
    ]) {
      expect(speakers(scene(aside))).toEqual([
        'Mrs. Bennet [speech]',
        'Davy [speech]',
        'Mrs. Bennet [speech]',
        'Davy [speech]',
      ]);
      expect(newNames(scene(aside))).toEqual(['Mrs. Bennet', 'Davy']);
    }
    // "as well as" opens no aside: the speech verb before the line still tags it, tone and all.
    const gifts =
      '“Thank you,” said Tom.\n\nThe feast was the Magistrate’s gift, as well as a whispered, ' +
      '“I hope our friendship continues.”';
    expect(speakers(gifts).at(-1)).toMatch(/\[speech, whisper\]$/u);
  });

  it('ignores what the narrator was told in an aside next to a line', () => {
    // "as she told me later" is an aside, no tag, so no line is said to the narrator.
    const told =
      'Mrs. Bennet sat by the window.\n\nShe was nervous, as she told me later. ' +
      '“Come here, Davy.”\n\n“Yes, ma’am.”\n\n“Sit, Davy.”\n\n“Yes.”';
    expect(speakers(told)).toEqual([
      'Mrs. Bennet [speech]',
      'Davy [speech]',
      'Mrs. Bennet [speech]',
      'Davy [speech]',
    ]);
  });

  it('reads no tag in a question after a line, even one about the narrator', () => {
    const cast = castWith([
      ['anne', 'Anne', 'female'],
      ['tom', 'Tom', 'male'],
    ]);
    const gate =
      'Anne waited by the gate.\n\n“Tom?” Why had he told me nothing? She knocked again.\n\n' +
      '“Coming.”\n\n“Hurry up, Tom.”\n\n“I am hurrying.”';
    expect(speakers(gate, cast)).toEqual([
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
    expect(speakers(swapped, cast)).toEqual([
      'Tom [speech]',
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
    ]);
    // A tag set off inside the question, or a question with no question word, tags nothing either,
    // and turns no third-person part first person.
    const collins = castWith([
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
      expect(speakers(proposal(question), collins)).toEqual([
        'Mr. Collins [speech]',
        'Elizabeth [speech]',
        'Mr. Collins [speech]',
        'Elizabeth [speech]',
      ]);
    }
  });

  it('reads a tag before a question that "but", "and" or "because" joins to it', () => {
    const cast = castWith([
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
      expect(speakers(door(tag), cast)).toEqual([first, 'Anne [speech]', 'Tom [speech]']);
    }
    // The teller's own tag makes a first-person part, so "Kit" is the teller's name.
    const mom = castWith([['mom', 'Mom', 'female']]);
    const soup = (tag: string) =>
      `Mom set the soup down.\n\n${tag}\n\n“You look pale, Kit.”\n\n“I’m just tired.”`;
    for (const tag of [
      '“I’m fine,” I said, but was I?',
      '“Can I drive?” I asked, and why shouldn’t I?',
      '“I’m fine,” I said, because what else could I say?',
      '“I’m fine,” I said… but was I?',
    ]) {
      expect(speakers(soup(tag), mom)).toEqual([
        'Narrator [speech]',
        'Mom [speech]',
        'Narrator [speech]',
      ]);
      expect(newNames(soup(tag), mom)).toEqual([]);
    }
    // A tag that goes on from its line after a comma is a tag whatever its first word ("Will",
    // "was").
    const will = castWith([
      ['will', 'Will', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    const fine =
      '“Are you all right?” asked Anne.\n\n“I’m fine,” Will said, but was he?\n\n' +
      '“You don’t look fine.”\n\n“Well, I am.”';
    expect(speakers(fine, will)).toEqual([
      'Anne [speech]',
      'Will [speech]',
      'Anne [speech]',
      'Will [speech]',
    ]);
    // So is one whose line ends in "!": a cast name before its verb, or a wh-word before its
    // subject, opens no question ("Will said", "When he turned", "How Anne screamed").
    const fineBang = fine.replace('“I’m fine,” Will said', '“I’m fine!” Will said');
    expect(speakers(fineBang, will)).toEqual([
      'Anne [speech]',
      'Will [speech]',
      'Anne [speech]',
      'Will [speech]',
    ]);
    const quay = castWith([
      ['anne', 'Anne', 'female'],
      ['tom', 'Tom', 'male'],
      ['jack', 'Jack', 'male'],
    ]);
    for (const tag of [
      '“Goodbye!” When he turned, Anne whispered, but did he hear?',
      '“Help!” How Anne screamed, and who could blame her?',
    ]) {
      const text = `“The ship is late,” said Jack.\n\n“It always is,” said Tom.\n\n${tag}`;
      expect(speakers(text, quay).at(-1)).toMatch(/^Anne \[/u);
    }
    const out =
      '“Where have you been?” asked Mom.\n\n“Out,” was all I said, but what else could I tell ' +
      'her?\n\n“Out where?”\n\n“Just out.”';
    expect(speakers(out, mom)).toEqual([
      'Mom [speech]',
      'Narrator [speech]',
      'Mom [speech]',
      'Narrator [speech]',
    ]);
    // An aside inside a question that opens before it, with "as", "since" or "…" after it, tags
    // no line either.
    for (const question of [
      'Did he mean it, I asked myself, as I watched him go?',
      'Did he mean it, I wondered, since he had never kept a promise before?',
      'Did he mean it, I wondered… or was it only the wine?',
    ]) {
      const promise =
        '“I’ll come back,” Tom said.\n\n“When?” I asked.\n\n' +
        `“Soon. I promise.” ${question}\n\n“Then go.”\n\n“I’m going.”`;
      expect(speakers(promise, cast)).toEqual([
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
      expect(speakers(gate, cast)).toEqual([
        'Anne [speech]',
        'Tom [speech]',
        'Anne [speech]',
        'Tom [speech]',
      ]);
    }
  });
});

describe('analyzeHeuristic: attribution', () => {
  const tomAnne = castWith([
    ['tom', 'Tom', 'male'],
    ['anne', 'Anne', 'female'],
  ]);

  it('prefers the subject before the verb to the person after it', () => {
    expect(speakers('“Where are you going?” Tom asked Anne.', tomAnne)).toEqual(['Tom [speech]']);
    expect(speakers('Tom said, “Yes.” Then Anne said, “No.”', tomAnne)).toEqual([
      'Tom [speech]',
      'Anne [speech]',
    ]);
  });

  it('finds the subject after the verb past "then" or "at last"', () => {
    expect(speakers('“Come in,” said at last the old man.')).toEqual(['the old man [speech]']);
    expect(speakers('“Well?” asked Tom.\n\n“Nothing,” replied then Anne.')).toEqual([
      'Tom [speech]',
      'Anne [speech]',
    ]);
  });

  it('keeps one speaker for both halves of a split quote', () => {
    expect(speakers('Anne laughed. “You,” Tom said, “are impossible.”', tomAnne)).toEqual([
      'Tom [speech]',
      'Tom [speech]',
    ]);
    expect(speakers('“Where were you?” I asked. “Out,” Anne said, “walking.”', tomAnne)).toEqual([
      'Narrator [speech]',
      'Anne [speech]',
      'Anne [speech]',
    ]);
    // A line with an intro of its own still keeps it.
    expect(speakers('Tom said, “Yes,” and then Anne said, “No.”', tomAnne)).toEqual([
      'Tom [speech]',
      'Anne [speech]',
    ]);
  });

  it('never gives a passive tag to the person it is said to', () => {
    expect(speakers('“Hi,” said Anne.\n\n“Go home,” Tom was told.', tomAnne)).toEqual([
      'Anne [speech]',
      'Unknown [speech]',
    ]);
    const told = '“Hello,” said Tom.\n\n“Hi,” said Anne.\n\n“Sit down,” she was told.';
    expect(speakers(told, tomAnne)).toEqual(['Tom [speech]', 'Anne [speech]', 'Tom [speech]']);
    expect(newNames('“What is your name?” the boy was asked.')).toEqual([]);
  });

  it('takes the subject that opens the clause across an aside, never the person before it', () => {
    const cast = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    const pause = '“I don’t know,” Tom told Anne, and after a pause, added, “Maybe tomorrow.”';
    expect(speakers(`${pause}\n\n“Fine.”`, cast)).toEqual([
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
      expect(speakers(text, cast).at(-1)).toMatch(new RegExp(`^${who} \\[speech`));
    }
    // No character is made of the person looked at.
    const bennets = castWith([
      ['mr', 'Mr. Bennet', 'male'],
      ['mrs', 'Mrs. Bennet', 'female'],
    ]);
    const husband =
      '“Well?” said Mr. Bennet.\n\nMrs. Bennet looked at her husband, and after a pause, ' +
      'replied, “Nothing.”';
    expect(speakers(husband, bennets)).toEqual(['Mr. Bennet [speech]', 'Mrs. Bennet [speech]']);
    expect(newNames(husband, bennets)).toEqual([]);
    // In a third-person part, an authorial "I" before another subject says nothing.
    const davy =
      'Mrs. Bennet sat by the window.\n\nI daresay Mrs. Bennet turned, then said, “The boy is ' +
      'here.”\n\n“Come here, Davy,” said Mrs. Bennet.\n\n“Yes, ma’am.”\n\n“And bring the basket.”';
    expect(speakers(davy)).toEqual([
      'Mrs. Bennet [speech]',
      'Mrs. Bennet [speech]',
      'Davy [speech]',
      'Mrs. Bennet [speech]',
    ]);
  });

  it('takes the sentence’s subject past a lead word, an aside or a subordinate clause', () => {
    const three = castWith([
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
      expect(speakers(`“Hey,” said Tom.\n\n${hello}${line}`, three).at(-1)).toBe('Tom [speech]');
      expect(speakers(`${hello}${line}`, three).at(-1)).toBe('Unknown [speech]');
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
      expect(speakers(`${hello}${line}`, three).at(-1)).toBe('Tom [speech]');
    }
    const darcy =
      '“Good evening,” said Elizabeth.\n\n“Good evening,” said Jane.\n\n' +
      'Then Mr. Darcy bowed and said, “Miss Bennet.”';
    expect(speakers(darcy).at(-1)).toBe('Mr. Darcy [speech]');
    // The teller's own "I" past a lead word or a clause that "and" opens.
    const late =
      '“Hello?” Tom called from the hall.\n\n“In here,” I said.\n\n' +
      'He came in and I, without looking up, said, “You’re late.”\n\n“I know.”\n\n“Again.”';
    expect(speakers(late, three)).toEqual([
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
    expect(speakers(river)).toEqual(['Tom [speech]', 'Anne [speech]']);
  });

  it('takes a subject pronoun after a fronted phrase for the subject of the main clause', () => {
    // Not the description set off after the person the main clause goes to.
    const gate =
      '“Who is there?” called Tom.\n\n' +
      'Hearing the gate, I ran to my father, a tall man dressed in black, and said, ' +
      '“It is only me.”';
    expect(speakers(gate, tomAnne)).toEqual(['Tom [speech]', 'Narrator [speech]']);
    expect(newNames(gate, tomAnne)).toEqual([]);
    // A "she" there is the woman named before it in the paragraph, as in "She ran to the gate and
    // said", even when nobody has said her name in a line yet.
    const her =
      '“Who is there?” called Tom.\n\n' +
      'Anne was in the garden. Hearing the gate, she ran to her father, a tall man dressed in ' +
      'black, and said, “It is only me.”';
    expect(speakers(her, tomAnne)).toEqual(['Tom [speech]', 'Anne [speech]']);
    expect(newNames(her, tomAnne)).toEqual([]);
  });

  it('takes the "he" or "she" after an opening clause for the one of that gender it names', () => {
    const three = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
    ]);
    const saw = '“Hi,” said Mary.\n\nWhen Tom saw Anne, he smiled and said, “Hello.”';
    expect(speakers(saw, three).at(-1)).toBe('Tom [speech]');
    // Mary, who spoke last, is a woman too, but the opening names Anne.
    const she = '“Hi,” said Mary.\n\nWhen Anne saw Tom, she smiled and said, “Hello.”';
    expect(speakers(she, three).at(-1)).toBe('Anne [speech]');
  });

  it('reads a "he" or "she" that opens the clause before "and said" like "she said"', () => {
    const three = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
    ]);
    // Someone named earlier in the paragraph comes first, though Mary spoke last.
    for (const line of [
      'Anne saw Tom. She smiled and said, “Hello.”',
      'Tom looked at Anne, and she smiled and said, “Hello.”',
      'Anne saw Tom. She smiled at Mary and said, “Hello.”',
    ]) {
      expect(speakers(`“Hi,” said Mary.\n\n${line}`, three).at(-1)).toBe('Anne [speech]');
    }
    // Never the person the line is said to, and a reply skips the one it answers.
    const hello = '“Hello,” said Anne.\n\n“Hi,” said Mary.\n\n';
    expect(speakers(`${hello}She turned to Mary and said, “Sit down.”`, three).at(-1)).toBe(
      'Anne [speech]',
    );
    const asked = '“Hi,” said Mary.\n\n“Where were you?” asked Anne.\n\n';
    expect(speakers(`${asked}She shrugged and replied, “Out.”`, three).at(-1)).toBe(
      'Mary [speech]',
    );
  });

  it('takes the subject after a time phrase that opens the sentence', () => {
    const night = '“Good night,” said Tom.\n\n“Good night,” said Anne.\n\n';
    for (const line of [
      'The next morning she knocked at my door and said:\n\n“Are you awake?”',
      'The next morning Anne knocked at my door and said, “Are you awake?”',
    ]) {
      expect(speakers(`${night}${line}`, tomAnne).at(-1)).toBe('Anne [speech]');
    }
  });

  it('never takes the subject of a sentence a time phrase opens for a colon intro after it', () => {
    // "somebody" in the intro is nobody known, and the "I" before it is not who knocks.
    const dawn =
      'That night I lay awake. At dawn somebody knocked at the door and said:\n\n“Wake up.”';
    expect(speakers(dawn)).toEqual(['Unknown [speech]']);
  });

  it('reads "somebody" past an opening phrase as the subject of a colon intro', () => {
    // Not Anne, the subject of the sentence before.
    for (const intro of [
      'Anne lay awake. At dawn somebody knocked at the door and said:',
      'Anne lay awake. Suddenly somebody knocked at the door and said:',
    ]) {
      expect(speakers(`${intro}\n\n“Wake up.”`, tomAnne)).toEqual(['Unknown [speech]']);
    }
  });

  it('takes the stretch before the join as a clause only when its subject has a verb', () => {
    const three = castWith([
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
      expect(speakers(text, three).at(-1)).toBe('Tom [speech]');
      expect(newNames(text, three)).toEqual([]);
    }
    const colon = `${asked}Tom turned to his sister, Anne, and said:\n\n“We must tell Father.”`;
    expect(speakers(colon, three)).toEqual(['Mary [speech]', 'Tom [speech]']);
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
      expect(speakers(`${asked}${line}`, three).at(-1)).toBe(`${who} [speech]`);
    }
    // "that" after a noun or "knew" brings in nobody the teller watched; "I was told" is a hedge.
    const coat =
      '“Do you like it?” asked Anne.\n\n“It suits you,” said Tom.\n\n' +
      'I put on the coat that Anne had given me, and after a moment, said, “It fits.”';
    expect(speakers(coat, three).at(-1)).toBe('Narrator [speech]');
    const told =
      '“Will you come?” asked Anne.\n\n“Perhaps,” said Tom.\n\n' +
      'Anne hesitated, I was told, and then said, “Very well.”';
    expect(speakers(told, three)).toEqual(['Anne [speech]', 'Tom [speech]', 'Anne [speech]']);
    // The teller's hedge says nothing, in third person and in first, and with no cast.
    const hedge =
      '“Will you come with me?” asked Tom.\n\nAnne hesitated, I believe, and said, “No.”\n\n“Why not?”';
    expect(speakers(hedge, three)).toEqual(['Tom [speech]', 'Anne [speech]', 'Tom [speech]']);
    const collins =
      '“Will you dance with me?” asked Mr. Collins.\n\n' +
      'Elizabeth hesitated, I believe, and then said, “I cannot.”\n\n“But why?”';
    expect(speakers(collins)[1]).not.toBe('Narrator [speech]');
    const mom = castWith([['mom', 'Mom', 'female']]);
    const remember =
      '“Where were you?” asked Mom.\n\n“Out,” I said.\n\n' +
      'Mom looked at me for a long time, I remember, and then said, “Go to bed.”\n\n“Yes, Mom.”';
    expect(speakers(remember, mom)).toEqual([
      'Mom [speech]',
      'Narrator [speech]',
      'Mom [speech]',
      'Narrator [speech]',
    ]);
    const supposeHe =
      '“Hello,” I said to Anne.\n\n“Hello,” said Anne.\n\n' +
      'Tom came in, and I suppose he sat down and said, “Evening, all.”\n\n“Evening, Tom.”';
    expect(speakers(supposeHe, three)).toEqual([
      'Narrator [speech]',
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
    ]);
    const thenAt =
      '“Ready?” asked Tom.\n\n“Ready,” said Anne.\n\nI looked at Tom, then at Anne, and said, ' +
      '“Let’s go.”';
    expect(speakers(thenAt, three).at(-1)).toBe('Narrator [speech]');
  });

  it('takes the subject before an aside that "and" opens only when it opens the sentence', () => {
    const tomAnneCast = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    const fire =
      '“Who is there?” asked Anne.\n\nSuddenly Tom, and I shall never forget it, shouted, “Fire!”';
    expect(speakers(fire, tomAnneCast).at(-1)).toMatch(/^Tom \[/u);
    const evening =
      '“Where is Papa?” asked Anne.\n\nThat evening Tom, and this surprised us all, said, “We go.”';
    expect(speakers(evening, tomAnneCast).at(-1)).toBe('Tom [speech]');
    // Never an object, and never over the verb's own inverted subject.
    const told =
      '“Well?” asked Anne.\n\n“Sit down,” Tom told Anne, and after a pause, added, “Now.”';
    expect(speakers(told, tomAnneCast)).toEqual(['Anne [speech]', 'Tom [speech]', 'Tom [speech]']);
  });

  it('reads an -s word as a tag only with a subject, never a plural noun', () => {
    const asked = '“What happened?” Tom asked.\n\n';
    const whispered = ['Tom [speech]', 'Anne [speech, whisper]'];
    const sobs = `${asked}Anne whispered between sobs, “He’s gone.”`;
    expect(speakers(sobs, tomAnne)).toEqual(whispered);
    const between = `${asked}“He’s gone.” Between sobs, Anne whispered the news.`;
    expect(speakers(between, tomAnne)).toEqual(whispered);
    expect(newNames(between, tomAnne)).toEqual([]);
    const laughs = '“Tell us a joke,” Anne said.\n\nTom said amid laughs, “Not now.”';
    expect(speakers(laughs, tomAnne)).toEqual(['Anne [speech]', 'Tom [speech]']);
    // Nor does one take the place of the tag or the beat it sits in.
    for (const narration of ['Anne answered through gasps.', 'Anne wiped her eyes between sobs.']) {
      expect(speakers(`${asked}${narration} “He’s gone.”`, tomAnne)).toEqual([
        'Tom [speech]',
        'Anne [speech]',
      ]);
    }
    // One that opens a sentence, or follows a possessive, names and tags nobody.
    const screams = '“Get out!” Tom shouts.\n\n“Help!” Screams echo down the hall.\n\n“Run!”';
    const shook = `${asked}Anne sat down. “I’m sorry.” Sobs shook her.\n\n“It’s all right.”`;
    for (const text of [screams, shook]) expect(newNames(text, tomAnne)).toEqual([]);
    const cries = '“Tom!” Anne’s cries filled the house.';
    expect(speakers(cries, tomAnne)).toEqual(['Unknown [speech]']);
    // With a subject after it, or in the clause it is joined to, it is a tag.
    expect(speakers('“Ha!” laughs Tom.', tomAnne)).toEqual(['Tom [speech, happy]']);
    const turns = 'Anne turns and whispers, “Go.”';
    expect(speakers(turns, tomAnne)).toEqual(['Anne [speech, whisper]']);
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
      expect(speakers(`${asks}${tag}`, tomAnne)).toEqual([
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
      expect(speakers(aunt(tag))).toEqual([
        'my aunt [speech]',
        'Narrator [speech]',
        'my aunt [speech]',
        'Narrator [speech]',
      ]);
      expect(newNames(aunt(tag))).toEqual(['my aunt']);
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
      expect(speakers(`${home}${tag}`, tomAnne)).toEqual(['Anne [speech]', who]);
    }
    const jonah = castWith([['jonah', 'Jonah', 'male']]);
    const behind = '“Where are we?” I ask.\n\nBehind me whispers Jonah, “Shh.”';
    expect(speakers(behind, jonah)).toEqual(['Narrator [speech]', 'Jonah [speech, whisper]']);
    // The subject of the clause it is joined to past an adverb, or before an aside.
    for (const tag of ['Tom says, and then whispers,', 'Tom says, then whispers,']) {
      expect(speakers(`“Go,” ${tag} “now.”`, tomAnne)).toEqual([
        'Tom [speech]',
        'Tom [speech, whisper]',
      ]);
    }
    const ready = '“Ready?” Tom asks.\n\nAnne nods and then whispers, “Go.”';
    expect(speakers(ready, tomAnne)).toEqual(['Tom [speech]', 'Anne [speech, whisper]']);
    const stay = '“Please stay,” Anne says.\n\n“Get out!” Tom, red-faced, shouts.';
    expect(speakers(stay, tomAnne)).toEqual(['Anne [speech]', 'Tom [speech, shout]']);
    // Someone the lexicon does not know who opens the clause the -s word ends.
    for (const [tag, tone] of [
      ['“Sit down,” the teacher snaps.', 'angry'],
      ['“Ha!” the audience laughs.', 'happy'],
      ['“Next!” shouts one of the guards.', 'shout'],
      ['The judge bangs his gavel and shouts, “Order!”', 'shout'],
    ]) {
      expect(speakers(`“Can we go?” Tom asks.\n\n${tag}`, tomAnne)).toEqual([
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
      const [, line] = speakers(`${home}${narration} “Who is it?”`, tomAnne);
      expect(line).toMatch(/ \[speech\]$/);
    }
    // The same shape as "the teacher snaps" takes the tone: '“Where?” The distant cries.'
    expect(speakers(`${home}“Where?” The distant cries.`, tomAnne)[1]).toBe(
      'Unknown [speech, excited]',
    );
    // "the man beside her shouts" keeps no tone, as "the sound of her sighs" is no tag.
    expect(speakers('“Help!” Anna cried.\n\nThe man beside her shouts, “Run!”')[1]).toBe(
      'the man [speech]',
    );
  });

  it('never makes names of headings, sentence starts, places or exclamations', () => {
    const chapter =
      'CHAPTER II\n\n“Hi,” said Anne.\n\n“Who is there?”\n\nElizabeth Bennet smiled.\n\n' +
      '“Hi,” said Jane Bennet.';
    expect(speakers(chapter)).toEqual([
      'Anne [speech]',
      'Unknown [speech]',
      'Jane Bennet [speech]',
    ]);
    expect(newNames(chapter)).toEqual(['Anne', 'Jane Bennet']);

    const walk =
      '“Hi,” said Anne.\n\n“Hello,” said Tom.\n\nThey walked to London on Monday.\n\n' +
      '“Is it far?”\n\n“Oh, Lord!” cried Anne.\n\n“What?”';
    expect(speakers(walk)).toEqual([
      'Anne [speech]',
      'Tom [speech]',
      'Anne [speech]',
      'Anne [speech, excited]',
      'Tom [speech]',
    ]);
    expect(newNames(walk)).toEqual(['Anne', 'Tom']);
  });

  it('keeps the name after a sentence opener for a later pronoun', () => {
    const cast = castWith([
      ['bingley', 'Mr. Bingley', 'male'],
      ['darcy', 'Mr. Darcy', 'male'],
      ['elizabeth', 'Elizabeth', 'female'],
    ]);
    const darcy =
      '“How do you do?” said Mr. Bingley.\n\n“Very well,” said Elizabeth.\n\n' +
      'Even Mr. Darcy smiled.\n\n“I am glad,” he said.';
    expect(speakers(darcy, cast).at(-1)).toBe('Mr. Darcy [speech]');
    const anna = 'Suddenly Anna felt very tired. She sat down.\n\n“I don’t know,” she said.';
    expect(speakers(anna)).toEqual(['Anna [speech]']);
    // A full name at a sentence start is still never the surname of someone in the cast.
    const bennet = castWith([['bennet', 'Mr. Bennet', 'male']]);
    expect(speakers('Elizabeth Bennet said, “Hi.”', bennet)).toEqual(['Unknown [speech]']);
  });

  it('reads possessives as the person, and "X’s mother" as someone else', () => {
    const text =
      '“Hi,” said Elizabeth.\n\n“Hello,” said Jane.\n\nJane took Elizabeth’s hand.\n\n' +
      '“How are you?”\n\n“No,” said Lucy’s mother.';
    expect(speakers(text)).toEqual([
      'Elizabeth [speech]',
      'Jane [speech]',
      'Elizabeth [speech]',
      'Lucy’s mother [speech]',
    ]);
  });

  it('reads titles and particles before names', () => {
    const titled =
      '“Come,” said St. John.\n\n“Fall in!” said Col. Forster.\n\n“Come,” said Mr. de Winter.';
    expect(newNames(titled)).toEqual(['St. John', 'Col. Forster', 'Mr. de Winter']);
    const darcy = '“I certainly shall not,” said Mr. Darcy.\n\n“Undoubtedly,” replied Darcy.';
    expect(speakers(darcy)).toEqual(['Mr. Darcy [speech]', 'Mr. Darcy [speech]']);
    expect(newNames(darcy)).toEqual(['Mr. Darcy']);
    const master = '“Not I,” said Master Bates.\n\n“Good day,” said Mister Smith.';
    expect(speakers(master)).toEqual(['Master Bates [speech]', 'Mister Smith [speech]']);
    expect(analyse(master).result.newCharacters.map((c) => [c.name, c.gender])).toEqual([
      ['Master Bates', 'male'],
      ['Mister Smith', 'male'],
    ]);
    // On its own, "Master" is still no name.
    expect(newNames('“Yes, Master,” said Tom.')).toEqual(['Tom']);
  });

  it('keeps a man apart from a woman known by his name', () => {
    const bingley = '“How charming,” said Miss Bingley.\n\n“Very,” said Bingley.';
    expect(speakers(bingley)).toEqual(['Miss Bingley [speech]', 'Bingley [speech]']);
    const joe =
      '“Well,” said Joe, glancing up at the clock.\n\n' +
      '“Where have you been, you young monkey?” said Mrs. Joe, stamping her foot.';
    expect(speakers(joe)).toEqual(['Joe [speech]', 'Mrs. Joe [speech]']);
    expect(analyse(joe).result.newCharacters.map((c) => [c.name, c.gender])).toEqual([
      ['Joe', undefined],
      ['Mrs. Joe', 'female'],
    ]);
  });

  it('never takes an owned voice for a person', () => {
    const text = '“Hi,” said Anne.\n\n“Go away,” said Tom, his voice low.\n\n“Why?”';
    expect(speakers(text)).toEqual(['Anne [speech]', 'Tom [speech]', 'Anne [speech]']);
    expect(newNames(text)).toEqual(['Anne', 'Tom']);
  });

  it('resolves replies and continuations', () => {
    expect(
      speakers('“Hello,” said Anne.\n\n“Hi,” said Tom.\n\n“Well,” she replied.\n\n“So,” he said.'),
    ).toEqual(['Anne [speech]', 'Tom [speech]', 'Anne [speech]', 'Tom [speech]']);
    expect(
      speakers(
        '“Is it?” said Mrs. Bennet.\n\n' +
          'Mr. Bennet replied, “I have no objection,” and returned to his book.',
      ),
    ).toEqual(['Mrs. Bennet [speech]', 'Mr. Bennet [speech]']);
  });

  it('gives a reply in a colon intro to someone else when it answers the line', () => {
    const three = castWith([
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
      expect(speakers(text, three).at(-1)).toBe(`${who} [speech]`);
      expect(newNames(text, three)).toEqual([]);
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
      expect(speakers(text, three).at(-1)).toBe(`${who} [speech]`);
    }
  });

  it('gives the line after a colon intro to the person its "who" stands for', () => {
    // Not someone the relative clause names before the verb ("greeted Tom"), nor the sentence's
    // subject when "who" stands for someone else ("Tom opened the door to an old man").
    const tom = castWith([['tom', 'Tom', 'male']]);
    for (const intro of [
      'Then came an old man, who looked at Tom and said:',
      'Then came an old man, who greeted Tom and said:',
      'Tom opened the door to an old man, who said:',
    ]) {
      expect(speakers(`${intro}\n\n“You are late.”`, tom)).toEqual(['an old man [speech]']);
    }
    const watching =
      'Tom, who had been watching Anne across the room all evening, exclaimed:\n\n“Enough!”';
    expect(speakers(watching, tomAnne)).toEqual(['Tom [speech]']);
    // An intro after a line, whose verb is not the tag's.
    const answered = '“You are late,” Tom told Anne, who answered:\n\n“I know.”';
    expect(speakers(answered, tomAnne)).toEqual(['Tom [speech]', 'Anne [speech]']);
  });

  it('takes a "who" right before a tag’s verb for the person it stands for', () => {
    const tom = castWith([['tom', 'Tom', 'male']]);
    const answered = '“You are late,” said Tom to the old man, who answered, “I know.”';
    expect(speakers(answered, tom)).toEqual(['Tom [speech]', 'the old man [speech]']);
    expect(speakers('Tom turned to Anne, who said, “Not now.”', tomAnne)).toEqual([
      'Anne [speech]',
    ]);
  });

  it('never gives a line to the person it is said to', () => {
    const cast = castWith([
      ['tom', 'Tom'],
      ['anne', 'Anne'],
      ['bob', 'Bob'],
    ]);
    const text =
      '“Good morning,” said Bob.\n\n“Morning,” said Tom. “Sit down, Anne.”\n\n“Thank you.”';
    expect(speakers(text, cast).at(-1)).toBe('Anne [speech]');
  });

  it('never gives a "he" or "she" line to someone known to have another gender', () => {
    // With no woman known, "she asked" goes to the unknown speaker, not to the man who spoke last.
    const tom = castWith([['tom', 'Tom', 'male']]);
    const morning = '“Morning,” I said.\n\n“Morning,” said Tom.\n\n';
    expect(speakers(`${morning}“Is it going to rain?” she asked.`, tom)).toEqual([
      'Narrator [speech]',
      'Tom [speech]',
      'Unknown [speech]',
    ]);
    expect(speakers('“Hello,” said Tom. “How are you?” she asked.', tom)).toEqual([
      'Tom [speech]',
      'Unknown [speech]',
    ]);
    // Nor through a continuation, a beat (the teller's too), the paragraph's other lines or a
    // colon intro.
    const tomBob = castWith([
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
      for (const who of speakers(talk + end, tomBob).slice(2)) {
        expect(who).toBe('Unknown [speech]');
      }
    }
    // Someone the user marked as another gender is not a "she" either; someone of no known
    // gender still may be.
    const robin = castWith([
      ['tom', 'Tom', 'male'],
      ['robin', 'Robin', 'other'],
    ]);
    const robinTalk = '“Hi,” said Tom.\n\n“Hello,” said Robin.\n\n“Well,” she said.';
    expect(speakers(robinTalk, robin).at(-1)).toBe('Unknown [speech]');
    const samTalk = '“Hi,” said Sam.\n\n“Hello,” said Tom.\n\n“Well,” she said.';
    expect(speakers(samTalk, tom).at(-1)).toBe('Sam [speech]');
    // A "she" at the end of a speech paragraph introduces the next line as a colon intro would.
    const added = (first: string) =>
      `“Hi,” said ${first}.\n\n“Well,” said Tom, and then she added:\n\n“It’s late.”`;
    expect(speakers(added('Bob'), tomBob).at(-1)).toBe('Unknown [speech]');
    expect(speakers(added('Anne'), tomAnne).at(-1)).toBe('Anne [speech]');
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
      expect(speakers(text).at(-1)).toBe(`${who} [speech]`);
    }
  });

  it('reads "so" before another word as an adverb of the tag', () => {
    expect(
      speakers('“Are you angry?” asked Tom.\n\n“Fine,” I said so quietly that he leaned in.'),
    ).toEqual(['Tom [speech]', 'Narrator [speech, whisper]']);
    const cast = castWith([
      ['tom', 'Tom', 'male'],
      ['bob', 'Bob', 'male'],
      ['anne', 'Anne', 'female'],
    ]);
    const nowhere =
      '“Where were you?” Tom asked Anne.\n\n“Out,” said Bob.\n\n' +
      '“Nowhere,” she said so quietly that nobody heard.';
    expect(speakers(nowhere, cast).at(-1)).toBe('Anne [speech, whisper]');
    // Twins: "said so" reports something.
    const said = '“Hi,” said Anne.\n\n“Are you sure?” asked Tom.\n\n“I said so,” said Anne.';
    expect(speakers(said)).toEqual(['Anne [speech]', 'Tom [speech]', 'Anne [speech]']);
    const lately =
      '“You’re late,” said Anne.\n\n“I know,” said Tom.\n\n“You’re always late.”\n\n' +
      'Tom sighed. Everyone said so lately. “I’ll try harder.”';
    expect(speakers(lately, cast).at(-1)).toBe('Tom [speech]');
    // "so" before "that" and a time reports what was said, like "so" alone.
    for (const narration of [
      'Tom had said so early that morning.',
      'Tom had said so only that morning.',
      'Everyone had said so repeatedly that week.',
      'Tom had said so early that very morning.',
    ]) {
      const river = `“The river is rising,” said Anne. ${narration} “We should leave.”`;
      expect(speakers(river, cast)).toEqual(['Anne [speech]', 'Anne [speech]']);
    }
  });

  it('gives a line said by "someone" to the unknown speaker', () => {
    const tom = castWith([['tom', 'Tom', 'male']]);
    const tomBob = castWith([
      ['tom', 'Tom', 'male'],
      ['bob', 'Bob', 'male'],
    ]);
    const morning = '“Morning,” I said.\n\n“Morning,” said Tom.\n\n';
    const talk = '“Hi,” said Tom.\n\n“Hello,” said Bob.\n\n';
    for (const end of [
      '“Rain later,” someone said.',
      '“Rain later,” somebody asked.',
      '“Rain later,” said someone.',
      '“Rain later,” said then someone.',
      '“Rain later,” someone else said.',
      'Someone turned and said, “Rain later.”',
      'Someone’s voice rose and said, “Rain later.”',
      'Then someone said:\n\n“Rain later.”',
    ]) {
      expect(speakers(morning + end, tom).at(-1)).toBe('Unknown [speech]');
      expect(speakers(talk + end, tomBob).at(-1)).toBe('Unknown [speech]');
    }
    // Someone spoken to is not the speaker.
    expect(speakers('“Hi,” said Tom to someone.', tom)).toEqual(['Tom [speech]']);
    expect(speakers('“Hi,” I told someone.', tom)).toEqual(['Narrator [speech]']);
    const asked = 'Tom turned and asked someone, “Where is it?”';
    expect(speakers(asked, tom)).toEqual(['Tom [speech]']);
  });

  it('rules nobody out by a guessed gender, or by a "she" or "someone" another subject follows', () => {
    // Tom's gender is only guessed from a "she" line someone else may have said.
    const bar =
      'The door opened and Tom walked in.\n\n“Another cold night,” she said.\n\n' +
      'Tom nodded. “Very cold,” he said.';
    expect(speakers(bar).at(-1)).toBe('Tom [speech]');
    // A coordinated clause with a subject of its own is that subject's.
    const tom = castWith([['tom', 'Tom', 'male']]);
    for (const end of [
      'She came in, and Tom turned and said, “Good evening.”',
      'She came in, and Tom turned and said:\n\n“Good evening.”',
      'Someone knocked, and Tom went to the door and said:\n\n“Who is it?”',
    ]) {
      expect(speakers(`Tom sat by the fire.\n\n${end}`, tom).at(-1)).toBe('Tom [speech]');
    }
    const old =
      'The old man waited.\n\nShe sat down and the old man smiled and said:\n\n“Welcome.”';
    expect(speakers(old).at(-1)).toBe('the old man [speech]');
  });

  it('reads "said goodbye" as no tag of the line before, so its "she" rules nobody out', () => {
    const tom = castWith([['tom', 'Tom', 'male']]);
    for (const after of [
      'She nodded and said goodbye.',
      'She sat down and said nothing.',
      'She said nothing.',
      'Then she said goodbye.',
    ]) {
      const text = `“I must go,” said Tom. “It’s late.” ${after}`;
      expect(speakers(text, tom)).toEqual(['Tom [speech]', 'Tom [speech]']);
    }
    const anne = castWith([['anne', 'Anne', 'female']]);
    const bowed = '“Hello,” said Anne. “Come in.” He bowed and said good evening.';
    expect(speakers(bowed, anne)).toEqual(['Anne [speech]', 'Anne [speech]']);
    const nice = '“Morning,” I said. “Nice day.” He nodded and said nothing.';
    expect(speakers(nice)).toEqual(['Narrator [speech]', 'Narrator [speech]']);
    // Twin: a "she" tag of the line is still never a man's.
    const whispered = '“I must go,” said Tom. “It’s late.” She turned and whispered.';
    expect(speakers(whispered, tom).at(-1)).toBe('Unknown [speech, whisper]');
    // An -s verb joined to a clause with a subject of its own keeps its tone and speaker.
    const mom = castWith([['mom', 'Mom', 'female']]);
    const hush =
      '“Hi,” I say to Mom.\n\nSomebody laughs, and Mom turns around and whispers, “Hush.”';
    expect(speakers(hush, mom).at(-1)).toBe('Mom [speech, whisper]');
    // A gender carried over from an earlier part reads like one the user set, so a "he" line is
    // never Tom's once Tom is stored as a woman, whether that came from a guess or not.
    const stored = castWith([['tom', 'Tom', 'female']]);
    const morning = '“Morning,” I said to Tom.\n\n“Morning,” he said.';
    expect(speakers(morning, stored).at(-1)).toBe('Unknown [speech]');
  });

  it('takes a name with words of endearment as addressed', () => {
    const dear =
      '“Hello,” said Tom.\n\n“Hello,” said Mary.\n\n' +
      '“Come here, Anne dear”—Mary held out her hand—“let me look at you.”\n\n“Yes, ma’am.”';
    expect(speakers(dear).at(-1)).toBe('Anne [speech]');
  });

  it('takes a name as addressed with an endearment, a full name or a list after it, or once brought in', () => {
    const en = '“Hello,” said Tom.\n\n“Hello,” said Mary.\n\n';
    for (const [line, name] of [
      ['“Goodnight, Anne honey”—Mary kissed her brow—“sleep well.”', 'Anne'],
      ['“Come here, Anne and Jim”—Mary waved—“quickly.”', 'Anne'],
      // A particle keeps the rest of the full name in the call.
      ['“Come here, Maxim de Winter”—Mary waved—“quickly.”', 'Maxim de Winter'],
    ]) {
      expect(speakers(`${en}${line}\n\n“Goodnight.”`).at(-1)).toBe(`${name} [speech]`);
    }
    const hat = '“Wait, Tom my boy”—Mary caught his sleeve—“you forgot your hat.”\n\n“Thank you.”';
    expect(speakers(`${en}“Hello,” said Jim.\n\n${hat}`).at(-1)).toBe('Tom [speech]');
    // A name the paragraph's first line brought in is called again by the second, whose tag names
    // someone else: the person called answers.
    const tea =
      '“Hello, Anne,” said Tom. “Anne, can you hear me?” he asked, while Mary poured the tea.';
    expect(speakers(`${en}${tea}\n\n“Yes, I can hear you.”`).at(-1)).toBe('Anne [speech]');
  });

  it('calls someone by a full name with a particle the cast spells with another surname', () => {
    // At the start of a line only the known first name is a name ("Anne" of "Anne de Courcy" for
    // Anne Elliot), so the call takes in the particle and every word of the surname after it.
    const anne = castWith([
      ['tom', 'Tom', 'male'],
      ['mary', 'Mary', 'female'],
      ['anne', 'Anne Elliot', 'female'],
    ]);
    const married =
      '“Hello,” said Tom.\n\n“Hello,” said Mary.\n\n' +
      '“Anne de Courcy! So you are married at last,” said Mary.\n\n“Last spring.”';
    expect(speakers(married, anne).at(-1)).toBe('Anne Elliot [speech]');
    const henry = castWith([
      ['mary', 'Mary', 'female'],
      ['tom', 'Tom', 'male'],
      ['henry', 'Henry Stacpoole', 'male'],
    ]);
    const scolded =
      '“Where is that boy?” said Mary.\n\n“In the garden,” said Tom.\n\n' +
      '“Henry de Vere Stacpoole, come here this instant!” Mary called.\n\n“Coming!”';
    expect(speakers(scolded, henry).at(-1)).toBe('Henry Stacpoole [speech]');
  });

  it('keeps emphasis away from speech that only mentions thinking', () => {
    const text = '“I thought you had gone,” said Tom, holding out a copy of The Times.';
    const start = text.indexOf('The Times');
    const result = analyzeHeuristic({
      text,
      units: splitUnits(text, [{ start, end: start + 9, kind: 'emphasis' }]),
      cast: baseCast(),
    });
    expect(result.spans.find((s) => s.start === start)?.mode).toBe('narration');
  });

  it('learns aliases only from speakers, never for the narrator', () => {
    // Harker named in narration is Jonathan Harker, but only a tag keeps "Harker" as an alias.
    const harker = castWith([['harker', 'Jonathan Harker', 'male']]);
    const aliases = (text: string) => analyse(text, harker).result.aliasAdditions;
    expect(aliases('Then Harker sat down by the fire.')).toEqual([]);
    expect(aliases('“Sit down,” said Harker.')).toEqual([
      { characterId: 'harker', alias: 'Harker' },
    ]);
    const firstPerson = '“You’re late, Kit,” said Abel.\n\n“Sorry,” I said.\n\n“Kit!”';
    expect(analyse(firstPerson).result.aliasAdditions).toEqual([]);
  });

  it('reads a state, a set phrase, a purpose or a long opening before the join, and "at last she"', () => {
    const three = castWith([
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
      expect(speakers(`${asked}${line}`, three).at(-1)).toBe('Tom [speech]');
      expect(newNames(`${asked}${line}`, three)).toEqual([]);
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
      expect(speakers(`${asked}${line}`, three).at(-1)).toBe(`${who} [speech]`);
    }
    const present =
      '“Well?” asks Mary.\n\nTom sits down, and Anne without a word gathers up her notes and says, ' +
      '“Good night.”';
    expect(speakers(present, three).at(-1)).toBe('Anne [speech]');
    const gifts =
      '“Well?” asks Mary.\n\nTom thanks the vicar, and Anne for her gifts and says, ' +
      '“You are too kind.”';
    expect(speakers(gifts, three).at(-1)).toBe('Tom [speech]');
    const four = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['will', 'Will', 'male'],
      ['mary', 'Mary', 'female'],
    ]);
    const will = `${asked}Tom came in, Anne with Will beside her, and said, “We are all here.”`;
    expect(speakers(will, four).at(-1)).toBe('Tom [speech]');
    // "and at last she" is the sentence's own subject when she has that gender.
    const letter =
      'The letter from Tom came on a Tuesday. Mary found Anne in the garden and gave it to her ' +
      'without a word.\n\n“Well?” asked Mary. “What does he say?”\n\nAnne read it twice. ' +
      'Anne folded it into a small square, and at last she looked up and said, ' +
      '“He isn’t coming back.”\n\n“Then he’s a fool,” said Mary.';
    expect(speakers(letter, three)).toEqual([
      'Mary [speech]',
      'Mary [speech]',
      'Anne [speech]',
      'Mary [speech]',
    ]);
  });

  it('takes the subject "and" brings in before a remark or right after the tag’s subject', () => {
    const cast = castWith([
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
      expect(speakers(`${out}${line}`, cast).at(-1)).toBe(`${who} [speech]`);
    }
    // Right after the tag's own subject, also past an adverb, or before a reply past the person
    // the tag is said to; before "added" the people it is said to make a list.
    const slowly =
      '“Where have you been?” said Mrs. Bennet.\n\n' +
      '“Out,” said Anne slowly, and Tom, and after a moment, replied, “So were we.”';
    expect(speakers(slowly, cast)).toEqual([
      'Mrs. Bennet [speech]',
      'Anne [speech]',
      'Tom [speech]',
    ]);
    const toTom =
      '“Where have you been?” said Tom.\n\n' +
      '“Out,” said Mrs. Bennet to Tom, and Anne, and after a pause, replied, “So were we.”';
    expect(speakers(toTom, cast)).toEqual([
      'Tom [speech]',
      'Mrs. Bennet [speech]',
      'Anne [speech]',
    ]);
    const added =
      '“Where have you been?” said Tom.\n\n' +
      '“Come in,” said Mrs. Bennet to Anne, and Tom, and after a moment, added, “Both of you.”';
    expect(speakers(added, cast)).toEqual([
      'Tom [speech]',
      'Mrs. Bennet [speech]',
      'Mrs. Bennet [speech]',
    ]);
  });

  it('takes the subject "and" brings in right after the tag’s subject for an -s verb too', () => {
    const cast = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['bennet', 'Mrs. Bennet', 'female'],
    ]);
    const says =
      '“Where have you been?” asks Mrs. Bennet.\n\n' +
      '“Out,” says Anne, and Tom, and after a moment, adds, “So were we.”';
    expect(speakers(says, cast)).toEqual(['Mrs. Bennet [speech]', 'Anne [speech]', 'Tom [speech]']);
  });

  it('reads "and to everyone’s astonishment," as a remark, like "and to my astonishment,"', () => {
    const cast = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['bennet', 'Mrs. Bennet', 'female'],
    ]);
    const out = '“Where have you been?” said Mrs. Bennet.\n\n“Out,” said Tom.\n\n';
    for (const everyone of ['everyone’s', "everyone's"]) {
      const line = `Mrs. Bennet stood up, and Anne, and to ${everyone} astonishment, said, “Sit down.”`;
      expect(speakers(`${out}${line}`, cast).at(-1)).toBe('Anne [speech]');
    }
  });

  it('takes a person after a count of people and "and" as one more object, only of the verb', () => {
    const cast = castWith([
      ['tom', 'Tom', 'male'],
      ['anne', 'Anne', 'female'],
      ['bennet', 'Mrs. Bennet', 'female'],
    ]);
    const out = '“Where have you been?” said Mrs. Bennet.\n\n“Out,” said Tom.\n\n';
    // Anne is kissed too, so the sentence's subject says the line.
    const kissed =
      'Mrs. Bennet kissed her two sons, and Anne, and I shall never forget it, said, ' +
      '“Welcome home, all of you.”';
    expect(speakers(`${out}${kissed}`, cast).at(-1)).toBe('Mrs. Bennet [speech]');
    // After a preposition the count is no object of the verb: Anne opens a clause of her own.
    const laughed =
      'Mrs. Bennet laughed at her two sons, and Anne, and I shall never forget it, said, ' +
      '“You are all very silly.”';
    expect(speakers(`${out}${laughed}`, cast).at(-1)).toBe('Anne [speech]');
  });

  it('gives a colon intro’s reply to who answers a question, a hesitation or a line said to them', () => {
    const four = castWith([
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
      expect(speakers(text, four).at(-1)).toBe('Mary [speech]');
    }
    // The tag's speaker goes on: a line that only hesitates right after a heading starts the
    // answer to the question before it, and "added" goes on with the line.
    for (const text of [
      '“Will you marry me?” asked Tom.\n\nCHAPTER II\n\n' +
        '“Well,” said Anne, and she answered:\n\n“Yes.”',
      'Mary looked up from her book. “You’re late,” said Anne, and she added:\n\n“Again.”',
    ]) {
      expect(speakers(text, four).at(-1)).toBe('Anne [speech]');
    }
    const jane = castWith([
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
      ['jane', 'Jane', 'female'],
    ]);
    const vocative =
      'Anne and Mary sat by the fire. Jane came in. “You’re late, Mary,” said Anne, and she ' +
      'replied:\n\n“Not as late as Jane.”';
    expect(speakers(vocative, jane).at(-1)).toBe('Mary [speech]');
  });

  it('gives a colon intro’s reply to the one the line calls past a glance or the teller’s question, or to the one that question names', () => {
    const four = castWith([
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
      ['jane', 'Jane', 'female'],
      ['tom', 'Tom', 'male'],
    ]);
    const fire = 'Anne, Mary and Jane sat by the fire.\n\n';
    for (const intro of [
      '“You’re late, Mary,” said Anne, glancing at Jane, and she replied:',
      '“You’re late again, Mary,” said Anne. Jane went on reading. What excuse would it be this ' +
        'time? Then she replied:',
      // A question of the teller's about one person of that gender names who replies.
      '“You’re late,” said Anne. What would Mary tell Tom? She shrugged, and then she replied:',
    ]) {
      expect(speakers(`${fire}${intro}\n\n“The bus broke down.”`, four).at(-1)).toBe(
        'Mary [speech]',
      );
    }
  });

  it('gives a colon intro’s reply to the one the line was said to, past the teller’s question', () => {
    const four = castWith([
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
      ['jane', 'Jane', 'female'],
      ['tom', 'Tom', 'male'],
    ]);
    // Jane is named after Mary, but the line was said to Mary.
    for (const tag of ['said Anne to Mary', 'Anne said to Mary']) {
      const text =
        `Anne, Mary and Jane sat by the fire.\n\n“You’re late again,” ${tag}. Jane went on ` +
        'reading. What excuse would it be this time? Then she replied:\n\n“The bus broke down.”';
      expect(speakers(text, four).at(-1)).toBe('Mary [speech]');
    }
  });

  it('lets a colon intro’s speaker go on from a question her line answers, after "and then"', () => {
    const three = castWith([
      ['anne', 'Anne', 'female'],
      ['mary', 'Mary', 'female'],
      ['tom', 'Tom', 'male'],
    ]);
    const perhaps =
      '“Will you come?” asked Mary.\n\n“Who knows? Perhaps,” said Anne, and then she answered:\n\n' +
      '“Yes, I will.”';
    expect(speakers(perhaps, three).at(-1)).toBe('Anne [speech]');
  });
});
