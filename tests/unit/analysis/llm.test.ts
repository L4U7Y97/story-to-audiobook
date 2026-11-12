import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Analysis, Character, Lang, Mode } from '@/format/types';
import { analyzePart } from '@/analysis/analyzer';
import { analyzeHeuristic } from '@/analysis/heuristic';
import type { SpeakerRef } from '@/analysis/labels';
import { analyzeLlm } from '@/analysis/llm';
import { chunkUnits, estimateTokens, type ChunkLimits } from '@/analysis/llm/chunking';
import { LlmError } from '@/analysis/llm/client';
import { buildUserPrompt, narratorStyleOf, SYSTEM_PROMPT } from '@/analysis/llm/prompt';
import { LLM_OUTPUT_FORMAT, readLlmOutput } from '@/analysis/llm/schema';
import { splitUnits } from '@/analysis/units';
import { validateAnalysis } from '@/format/validate';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { getAnalysis } from '@/storage/analyses';
import { mergeCharactersInStory } from '@/storage/cast';
import { renameCharacter } from '@/cast/castOps';
import { addPart, getPart } from '@/storage/parts';
import { createStory, getStory, updateStory } from '@/storage/stories';
import { baseCast } from '../../helpers/fixtures';
import { fakeTransport, heldTransport, labelAll, type FakeCall } from '../../helpers/fakeLlm';

// Units: 0 “Hi,” · 1 said Anne. · 2 “Where is Tom?” · 3 Tom looked up. · 4 “Here.” · 5 The end.
const TEXT = '“Hi,” said Anne. “Where is Tom?”\n\nTom looked up. “Here.”\n\nThe end.';
const voices = [
  { name: 'en-a', lang: 'en-US', isDefault: true },
  { name: 'en-b', lang: 'en-GB' },
];
const llm = (transport: ReturnType<typeof fakeTransport>) => ({
  transport,
  model: 'claude-haiku-5-5',
  effort: 'low' as const,
});

const anneAndTom = {
  newCharacters: [
    { ref: 'new1', name: 'Anne', aliases: [], gender: 'female', description: 'asks for Tom' },
    { ref: 'new2', name: 'Tom', aliases: ['Thomas'], gender: 'male', description: 'answers' },
  ],
};

/** Units 0 and 2 to Anne, 4 to Tom, the rest narration. */
function goodReply(units: string[]) {
  return {
    ...anneAndTom,
    aliasAdditions: [],
    units: units.map((text, id) => ({
      id,
      spans: [
        id === 4
          ? { speaker: 'new2', mode: 'speech' }
          : text.startsWith('“')
            ? { speaker: 'new1', mode: 'speech', tone: { label: 'excited', intensity: 2 } }
            : { speaker: 'N', mode: 'narration' },
      ],
    })),
  };
}

let db: StoryDb;
let count = 0;
beforeEach(() => {
  db = openStoryDb(`llm-${++count}`);
});
afterEach(async () => {
  await db.delete();
});

async function setup(text = TEXT) {
  const story = await createStory(db, { title: 'S', lang: 'en' });
  const part = await addPart(db, story.id, { title: 'p', source: { kind: 'paste' }, text });
  return { story, part };
}

async function stored(partId: string) {
  const part = (await getPart(db, partId))!;
  const story = (await getStory(db, part.storyId))!;
  const analysis = (await getAnalysis(db, partId))!;
  const name = (id: string) => story.cast.find((c) => c.id === id)?.name;
  const castIds = new Set(story.cast.map((c) => c.id));
  expect(validateAnalysis(part, analysis, castIds)).toEqual({ ok: true });
  return {
    story,
    analysis,
    lines: analysis.segments.map((s) => [
      part.text.slice(s.start, s.end),
      name(s.speakerId),
      s.source,
    ]),
  };
}

function character(id: string, name: string, extra: Partial<Character> = {}): Character {
  return {
    id,
    role: 'character',
    name,
    aliases: [],
    voice: { lang: 'en-US', pitch: 1, rate: 1 },
    ...extra,
  };
}

function castWithNarrator(changes: Partial<Character>, lang: Lang = 'en'): Character[] {
  return baseCast(lang).map((c) => (c.role === 'narrator' ? { ...c, ...changes } : c));
}

/** Runs analyzeLlm without storage; `lines` are each span's trimmed text, speaker name and mode. */
async function analyze(
  text: string,
  cast: readonly Character[],
  respond: (call: FakeCall) => object,
  options: { lang?: Lang; limits?: ChunkLimits } = {},
) {
  const lang = options.lang ?? 'en';
  const units = splitUnits(text, lang);
  const transport = fakeTransport(respond);
  const result = await analyzeLlm({
    text,
    lang,
    units,
    cast,
    heuristic: analyzeHeuristic({ text, lang, units, cast }),
    ...llm(transport),
    limits: options.limits,
  });
  const name = (ref: SpeakerRef) =>
    ref.kind === 'cast'
      ? cast.find((c) => c.id === ref.id)?.name
      : result.labels.newCharacters.find((c) => c.ref === ref.ref)?.name;
  const lines = result.labels.spans.map((s) => [
    text.slice(s.start, s.end).trim(),
    name(s.speaker),
    s.mode,
  ]);
  return { result, transport, lines };
}

/** The code a prompt's cast list gives the member known as `name`. */
function codeIn(user: string, name: string): string {
  const line = user.split('\n').find((l) => /^[NUcx]\d*: /u.test(l) && l.includes(name))!;
  return line.slice(0, line.indexOf(':'));
}

describe('LLM analysis', () => {
  it('turns a valid answer into segments and adds the new characters to the cast', async () => {
    const { part } = await setup();
    const transport = fakeTransport(({ units }) => goodReply(units));
    const report = await analyzePart(db, part.id, { voices, llm: llm(transport) });

    const { story, analysis, lines } = await stored(part.id);
    expect(report).toMatchObject({ kind: 'llm', fallbackUnits: 0 });
    expect(analysis.analyzer).toEqual({ kind: 'llm', model: 'claude-haiku-5-5', version: 3 });
    expect(lines).toEqual([
      ['“Hi,”', 'Anne', 'llm'],
      [' said Anne. ', 'Narrator', 'llm'],
      ['“Where is Tom?”\n\n', 'Anne', 'llm'],
      ['Tom looked up. ', 'Narrator', 'llm'],
      ['“Here.”\n\n', 'Tom', 'llm'],
      ['The end.', 'Narrator', 'llm'],
    ]);
    expect(analysis.segments[0]!.tone).toEqual({ label: 'excited', intensity: 2 });
    const tom = story.cast.find((c) => c.name === 'Tom')!;
    expect(tom).toMatchObject({ aliases: ['Thomas'], gender: 'male', description: 'answers' });
    expect(tom.voice.voiceName).toBeDefined();
  });

  it('sends the cast under short codes and the request settings', async () => {
    const { story, part } = await setup();
    const transport = fakeTransport(({ units }) => goodReply(units));
    const cast: Character[] = [
      ...story.cast,
      {
        id: 'liz-id',
        role: 'character',
        name: 'Elizabeth',
        aliases: ['Lizzy'],
        gender: 'female',
        voice: { lang: 'en-US', pitch: 1, rate: 1 },
      },
    ];
    await updateStory(db, story.id, { cast });
    await analyzePart(db, part.id, { voices, llm: llm(transport) });

    const [call] = transport.calls;
    expect(call!.codes).toEqual(['N', 'U', 'c1']);
    expect(call!.request.user).toContain('c1: Elizabeth (female; also called Lizzy)');
    expect(call!.request.user).not.toContain('liz-id');
    expect(call!.units).toEqual([
      '“Hi,”',
      'said Anne.',
      '“Where is Tom?”',
      'Tom looked up.',
      '“Here.”',
      'The end.',
    ]);
    expect(call!.request).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(call!.request.format.type).toBe('json_schema');
  });

  it('maps a "new" character that matches the cast to the existing one, and records aliases', async () => {
    const { story, part } = await setup();
    const anne: Character = {
      id: 'anne-id',
      role: 'character',
      name: 'Anne Shirley',
      aliases: [],
      voice: { lang: 'en-US', pitch: 1.1, rate: 1 },
    };
    await updateStory(db, story.id, { cast: [...story.cast, anne] });
    const transport = fakeTransport(({ units }) => ({
      ...goodReply(units),
      newCharacters: [
        { ref: 'new1', name: 'Shirley', aliases: [], description: '' },
        anneAndTom.newCharacters[1],
      ],
      aliasAdditions: [{ characterId: 'c1', alias: 'Miss Shirley' }],
    }));
    await analyzePart(db, part.id, { voices, llm: llm(transport) });

    const { story: after, lines } = await stored(part.id);
    expect(lines[0]).toEqual(['“Hi,”', 'Anne Shirley', 'llm']);
    expect(after.cast.find((c) => c.id === 'anne-id')).toMatchObject({
      aliases: ['Miss Shirley'],
      voice: anne.voice,
    });
    expect(after.cast.map((c) => c.name)).toEqual([
      'Narrator',
      'Unknown speaker',
      'Anne Shirley',
      'Tom',
    ]);
  });

  it('splits a unit at the spans the model returns; whitespace between them stays with the first', async () => {
    const text = 'Anne smiled. Hello there, Tom.\n\nThe end.';
    const { part } = await setup(text);
    const transport = fakeTransport(({ units }) => ({
      ...anneAndTom,
      aliasAdditions: [],
      units: units.map((_, id) =>
        id === 0
          ? {
              id,
              spans: [
                { text: 'Anne smiled.', speaker: 'N', mode: 'narration' },
                { text: 'Hello there, Tom.', speaker: 'new1', mode: 'speech' },
              ],
            }
          : { id, spans: [{ speaker: 'N', mode: 'narration' }] },
      ),
    }));
    await analyzePart(db, part.id, { voices, llm: llm(transport) });
    const { lines } = await stored(part.id);
    expect(lines).toEqual([
      ['Anne smiled. ', 'Narrator', 'llm'],
      ['Hello there, Tom.\n\n', 'Anne', 'llm'],
      ['The end.', 'Narrator', 'llm'],
    ]);
  });

  it('rejects a split with a whitespace-only span instead of storing it', async () => {
    const units = splitUnits('Anne smiled. Hello there, Tom.', 'en');
    const cast = baseCast('en');
    const transport = fakeTransport(() => ({
      units: [
        {
          id: 0,
          spans: [
            { text: 'Anne smiled.', speaker: 'N', mode: 'narration' },
            { text: ' ', speaker: 'U', mode: 'speech' },
            { text: 'Hello there, Tom.', speaker: 'U', mode: 'speech' },
          ],
        },
      ],
      newCharacters: [],
      aliasAdditions: [],
    }));
    const result = await analyzeLlm({
      text: 'Anne smiled. Hello there, Tom.',
      lang: 'en',
      units,
      cast,
      heuristic: analyzeHeuristic({
        text: 'Anne smiled. Hello there, Tom.',
        lang: 'en',
        units,
        cast,
      }),
      ...llm(transport),
    });
    expect(result.fallbackUnits).toBe(1);
    expect(result.labels.spans.every((s) => s.source === 'heuristic')).toBe(true);
  });

  it('falls back to the heuristic per unit for bad spans, missing units and unknown speakers', async () => {
    const { part } = await setup();
    const transport = fakeTransport(({ units }) => {
      const reply = goodReply(units);
      reply.units = reply.units.filter((u) => u.id !== 3); // missing
      reply.units[0]!.spans = [
        { text: '“Hi', speaker: 'new1', mode: 'speech' },
        { text: 'there”', speaker: 'N', mode: 'narration' },
      ] as never; // spans that don't match the text
      reply.units[3]!.spans = [{ speaker: 'zz', mode: 'speech' }]; // unit 4: unknown speaker
      return reply;
    });
    const report = await analyzePart(db, part.id, { voices, llm: llm(transport) });

    const { analysis, lines } = await stored(part.id);
    expect(report).toMatchObject({ kind: 'mixed', fallbackUnits: 3 });
    expect(analysis.analyzer.kind).toBe('mixed');
    expect(lines.map((l) => l[2])).toEqual([
      'heuristic',
      'llm',
      'llm',
      'heuristic',
      'heuristic',
      'llm',
    ]);
    // The heuristic's "Anne" (from “said Anne”) is the model's Anne, not a duplicate character.
    expect(lines[0]![1]).toBe('Anne');
    expect(analysis.segments[0]!.speakerId).toBe(analysis.segments[2]!.speakerId);
  });

  it('treats a refusal as a failed chunk: every unit uses the heuristic', async () => {
    const { part } = await setup();
    const transport = fakeTransport(() => ({ stopReason: 'refusal', text: '' }));
    const report = await analyzePart(db, part.id, { voices, llm: llm(transport) });
    const { analysis } = await stored(part.id);
    expect(report).toMatchObject({ kind: 'mixed', fallbackUnits: 6 });
    expect(analysis.segments.every((s) => s.source === 'heuristic')).toBe(true);
  });

  it('splits a chunk in two when the answer is cut off at max_tokens', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `“Line ${i}.”`).join('\n\n');
    const { part } = await setup(text);
    const transport = fakeTransport(({ units }) =>
      units.length > 6 ? { stopReason: 'max_tokens', text: '{"units": [' } : labelAll(units, 'U'),
    );
    const report = await analyzePart(db, part.id, { voices, llm: llm(transport) });
    expect(transport.calls.map((c) => c.units.length)).toEqual([12, 6, 6]);
    expect(report).toMatchObject({ kind: 'llm', fallbackUnits: 0 });
  });

  it('resumes a failed run without repeating the chunks that finished', async () => {
    const text = Array.from({ length: 4 }, (_, i) => `“Line ${i}.” said Anne.`).join('\n\n');
    let fail = true;
    const transport = fakeTransport(({ units }) => {
      if (transport.calls.length === 2 && fail) throw new LlmError('network', 'offline');
      return labelAll(units, 'U');
    });
    const units = splitUnits(text, 'en');
    const cast = baseCast('en');
    const input = {
      text,
      lang: 'en' as const,
      units,
      cast,
      heuristic: analyzeHeuristic({ text, lang: 'en', units, cast }),
      ...llm(transport),
      limits: { maxUnits: 4, maxTokens: 10_000 }, // two chunks of two paragraphs
      cache: new Map(),
      cacheKey: 'k',
    };
    await expect(analyzeLlm(input)).rejects.toThrow('offline');
    fail = false;
    const result = await analyzeLlm(input);
    expect(transport.calls).toHaveLength(3); // chunk 1 once, chunk 2 twice
    expect(result.fallbackUnits).toBe(0);
  });

  it('marks the part failed and rethrows when the key is rejected', async () => {
    const { part } = await setup();
    const transport = fakeTransport(() => {
      throw new LlmError('auth', 'API key rejected');
    });
    await expect(analyzePart(db, part.id, { voices, llm: llm(transport) })).rejects.toThrow(
      'API key rejected',
    );
    expect((await getPart(db, part.id))!.analysisStatus).toBe('failed');
    expect(await getAnalysis(db, part.id)).toBeUndefined();
  });

  it('gives the first chunk of part 2 the end of part 1 as context', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const p1 = await addPart(db, story.id, { title: '1', source: { kind: 'paste' }, text: TEXT });
    const p2 = await addPart(db, story.id, {
      title: '2',
      source: { kind: 'paste' },
      text: '“Again?”',
    });
    const transport = fakeTransport(({ units }) => goodReply(units));
    await analyzePart(db, p1.id, { voices, llm: llm(transport) });
    await analyzePart(db, p2.id, { voices, llm: llm(transport) });
    const user = transport.calls[1]!.request.user;
    expect(user).toContain('Context (already labelled):');
    expect(user).toContain('[c2, speech] “Here.”');
    expect(user).toContain('c2: Tom (male; also called Thomas; answers)');
  });

  it('marks where the previous part ends, since the teller may change there', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const p1 = await addPart(db, story.id, {
      title: '1',
      source: { kind: 'paste' },
      text: '“Hi,” said Anne. “Where is Tom?”\n\nTom looked up. “Here.”',
    });
    const p2 = await addPart(db, story.id, {
      title: '2',
      source: { kind: 'paste' },
      text: '“Again?”',
    });
    const transport = fakeTransport(({ units }) => goodReply(units));
    await analyzePart(db, p1.id, { voices, llm: llm(transport) });
    await analyzePart(db, p2.id, { voices, llm: llm(transport) });
    expect(transport.calls[1]!.request.user).toContain(
      '[c2, speech] “Here.”\n(end of the previous part)\n\nUnits to label:',
    );
  });

  it('asks again after the cast changes instead of replaying codes that now mean someone else', async () => {
    const { story, part } = await setup(
      Array.from({ length: 301 }, (_, i) => `“Line ${i}.”`).join('\n\n'), // 300 + 1 units
    );
    await updateStory(db, story.id, {
      cast: [
        ...story.cast,
        character('anne', 'Anne'),
        character('bob', 'Bob'),
        character('tom', 'Tom'),
      ],
    });
    let online = false;
    // Every line is Bob's, under whatever code the request's cast gives him.
    const transport = fakeTransport(({ request, units }) => {
      if (!online && units.length === 1) throw new LlmError('network', 'offline');
      return labelAll(units, codeIn(request.user, 'Bob'));
    });
    await expect(analyzePart(db, part.id, { voices, llm: llm(transport) })).rejects.toThrow(
      'offline',
    );
    expect(transport.calls.map((c) => codeIn(c.request.user, 'Bob'))).toEqual(['c2', 'c2']);

    await mergeCharactersInStory(db, story.id, 'bob', 'anne'); // Tom becomes c2
    online = true;
    await analyzePart(db, part.id, { voices, llm: llm(transport) });
    expect(transport.calls).toHaveLength(4);
    const { analysis } = await stored(part.id);
    expect(new Set(analysis.segments.map((s) => s.speakerId))).toEqual(new Set(['anne']));

    // Once stored, the part's answers are gone, even with the same cast.
    await analyzePart(db, part.id, { voices, llm: llm(transport) });
    expect(transport.calls).toHaveLength(6);
  });

  it('replays the finished chunks after a rename, since the codes name the same members', async () => {
    const { story, part } = await setup(
      Array.from({ length: 301 }, (_, i) => `“Line ${i}.”`).join('\n\n'), // 300 + 1 units
    );
    await updateStory(db, story.id, {
      cast: [...story.cast, character('anne', 'Anne'), character('bob', 'Bob')],
    });
    let online = false;
    const transport = fakeTransport(({ request, units }) => {
      if (!online && units.length === 1) throw new LlmError('network', 'offline');
      return labelAll(units, codeIn(request.user, 'Bob'));
    });
    await expect(analyzePart(db, part.id, { voices, llm: llm(transport) })).rejects.toThrow(
      'offline',
    );

    // The Cast view's rename keeps the old name as an alias.
    const renamed = renameCharacter((await getStory(db, story.id))!.cast, 'bob', 'Robert');
    await updateStory(db, story.id, { cast: renamed.ok ? renamed.value : [] });
    online = true;
    await analyzePart(db, part.id, { voices, llm: llm(transport) });
    expect(transport.calls.map((c) => c.units.length)).toEqual([300, 1, 1]);
    const { analysis } = await stored(part.id);
    expect(new Set(analysis.segments.map((s) => s.speakerId))).toEqual(new Set(['bob']));
  });

  it('forgets the cached answers of a part the free method stores', async () => {
    const { part } = await setup(
      Array.from({ length: 301 }, (_, i) => `“Line ${i}.”`).join('\n\n'),
    );
    let online = false;
    const transport = fakeTransport(({ units }) => {
      if (!online && units.length === 1) throw new LlmError('network', 'offline');
      return labelAll(units, 'U');
    });
    await expect(analyzePart(db, part.id, { voices, llm: llm(transport) })).rejects.toThrow(
      'offline',
    );
    await analyzePart(db, part.id, { voices });
    online = true;
    await analyzePart(db, part.id, { voices, llm: llm(transport) });
    expect(transport.calls).toHaveLength(4); // the first chunk is asked again
  });
});

describe('the system prompt', () => {
  it('says who tells the story, for under 400 more tokens', () => {
    expect(SYSTEM_PROMPT).toContain('Who tells the story:');
    expect(SYSTEM_PROMPT).not.toContain(
      "In a first-person story the narrator's own dialogue and thoughts are also N",
    );
    expect(estimateTokens(SYSTEM_PROMPT) - 671).toBeLessThan(400);
  });
});

describe('narratorStyleOf', () => {
  /** An analysis with `count` segments of each speaker and mode (offsets do not matter here). */
  const analysis = (...runs: Array<[speakerId: string, mode: Mode, count?: number]>): Analysis => ({
    partId: 'p',
    textHash: 'h',
    analyzer: { kind: 'heuristic', version: 2 },
    createdAt: '',
    segments: runs.flatMap(([speakerId, mode, count = 1]) =>
      Array.from({ length: count }, () => ({
        start: 0,
        end: 1,
        speakerId,
        mode,
        source: 'heuristic' as const,
      })),
    ),
  });

  it('calls the narrator first person when it speaks or thinks often enough', () => {
    const style = (...a: Analysis[]) => narratorStyleOf(a, 'n');
    expect(style(analysis(['n', 'narration', 10], ['n', 'speech'], ['n', 'thought']))).toBe(
      'first person',
    );
    expect(
      style(
        analysis(['n', 'narration', 3], ['n', 'speech']),
        analysis(['n', 'narration', 3], ['n', 'speech']),
      ),
    ).toBe('first person');
    expect(style(analysis(['n', 'narration', 10], ['anne', 'speech', 5]))).toBe('third person');
    expect(style(analysis(['n', 'narration', 60], ['n', 'speech'], ['anne', 'speech', 5]))).toBe(
      'third person',
    );
    // Between one line in 50 and one in 20, or with too little narration, it says nothing.
    expect(style(analysis(['n', 'narration', 100], ['n', 'speech', 3]))).toBeUndefined();
    expect(style(analysis(['n', 'narration', 4], ['n', 'speech', 2]))).toBeUndefined();
    expect(style()).toBeUndefined();
  });

  it('never calls a narrator third person where nobody else talks either', () => {
    // A first-person opening without dialogue has the same counts as third-person narration.
    const style = (...a: Analysis[]) => narratorStyleOf(a, 'n');
    expect(style(analysis(['n', 'narration', 7]))).toBeUndefined();
    expect(style(analysis(['n', 'narration', 60], ['n', 'speech']))).toBeUndefined();
    expect(style(analysis(['n', 'narration', 10], ['anne', 'speech']))).toBeUndefined();
    expect(style(analysis(['n', 'narration', 10], ['anne', 'narration', 5]))).toBeUndefined();
  });
});

describe('names for the narrator', () => {
  const holmes = [...baseCast('en'), character('holmes', 'Holmes')];
  const names = ({ units }: FakeCall) =>
    labelAll(units, 'c1', {
      aliasAdditions: [
        { characterId: 'N', alias: 'Watson' },
        { characterId: 'N', alias: 'the narrator' },
        { characterId: 'N', alias: 'Holmes' },
        { characterId: 'N', alias: 'el doctor' },
        { characterId: 'U', alias: 'Lestrade' },
      ],
    });

  it('keeps a real name the model gives N, and nothing that is not one', async () => {
    const { result } = await analyze('“Come, Watson,” said Holmes.', holmes, names);
    expect(result.labels.aliasAdditions).toEqual([{ characterId: 'narrator', alias: 'Watson' }]);
  });

  it('stores it on the narrator', async () => {
    const { story, part } = await setup('“Come, Watson,” said Holmes.');
    await updateStory(db, story.id, { cast: [...story.cast, character('holmes', 'Holmes')] });
    await analyzePart(db, part.id, { voices, llm: llm(fakeTransport(names)) });
    const { story: after } = await stored(part.id);
    expect(after.cast.map((c) => [c.name, c.aliases])).toEqual([
      ['Narrator', ['Watson']],
      ['Unknown speaker', []],
      ['Holmes', []],
    ]);
  });

  it('only takes names that fit the ones the narrator has', async () => {
    const { result } = await analyze(
      '“Hi.”',
      castWithNarrator({ aliases: ['Watson'] }),
      ({ units }) =>
        labelAll(units, 'N', {
          aliasAdditions: [
            { characterId: 'N', alias: 'Amy' },
            { characterId: 'N', alias: 'Dr. Watson' },
          ],
        }),
    );
    expect(result.labels.aliasAdditions).toEqual([
      { characterId: 'narrator', alias: 'Dr. Watson' },
    ]);
  });

  /** The names a narrator with `changes` keeps when the model gives it `alias`. */
  async function kept(changes: Partial<Character>, alias: string, lang: Lang = 'en') {
    const { result } = await analyze(
      lang === 'es' ? '—Hola —dije.' : '“Hi,” I said.',
      castWithNarrator(changes, lang),
      ({ units }) => labelAll(units, 'N', { aliasAdditions: [{ characterId: 'N', alias }] }),
      { lang },
    );
    return result.labels.aliasAdditions.map((a) => a.alias);
  }

  it('refuses a full name with another first name, even with a word in common', async () => {
    expect(await kept({ aliases: ['Nick Dunne'] }, 'Amy Dunne')).toEqual([]);
    expect(await kept({ aliases: ['Nick Dunne'] }, 'Amy Elliott Dunne')).toEqual([]);
    expect(await kept({ aliases: ['Watson', 'John Watson'] }, 'James Watson')).toEqual([]);
    expect(await kept({ name: 'Inés de Suárez' }, 'Pedro de Valdivia', 'es')).toEqual([]);
    // Other forms of the same name still fit.
    expect(await kept({ aliases: ['Watson', 'John Watson'] }, 'John Hamish Watson')).toEqual([
      'John Hamish Watson',
    ]);
    expect(await kept({ name: 'Inés de Suárez' }, 'Inés Suárez', 'es')).toEqual(['Inés Suárez']);
  });

  it('takes a name after a title written in lower case, but not the title alone', async () => {
    expect(await kept({}, 'doña Inés', 'es')).toEqual(['doña Inés']);
    expect(await kept({}, 'doña', 'es')).toEqual([]);
  });

  it('takes a titled name whose next word is a particle in lower case', async () => {
    expect(await kept({}, 'Mrs. de Winter')).toEqual(['Mrs. de Winter']);
    expect(await kept({ aliases: ['de Winter'] }, 'Mrs. de Winter')).toEqual(['Mrs. de Winter']);
    expect(await kept({}, 'Señora de Pérez', 'es')).toEqual(['Señora de Pérez']);
  });

  it('takes a first name that is also a joining word, such as "Della" or "Van"', async () => {
    expect(await kept({ aliases: ['Della Street'] }, 'Della')).toEqual(['Della']);
    expect(await kept({ aliases: ['Della'] }, 'Della Street')).toEqual(['Della Street']);
    expect(await kept({ aliases: ['Van Veen'] }, 'Van')).toEqual(['Van']);
    expect(await kept({ aliases: ['Van'] }, 'Van Veen')).toEqual(['Van Veen']);
    // A longer name that has only that word in common is someone else's.
    expect(await kept({ aliases: ['Van Veen'] }, 'Van Helsing')).toEqual([]);
  });

  it('refuses a woman’s title before the family name it goes by, unless it is a woman', async () => {
    // "Mrs. Watson" may be the wife of a narrator called "Watson".
    expect(await kept({ aliases: ['Watson'] }, 'Mrs. Watson')).toEqual([]);
    expect(await kept({ name: 'Watson', gender: 'male' }, 'Miss Watson')).toEqual([]);
    expect(await kept({ aliases: ['Watson'], gender: 'female' }, 'Mrs. Watson')).toEqual([
      'Mrs. Watson',
    ]);
  });

  it('takes "Miss" before a name that its full name shows is not its family name', async () => {
    // The first name of its full name, or a name the full name leaves out.
    expect(await kept({ name: 'Jane Eyre', aliases: ['Jane'] }, 'Miss Jane')).toEqual([
      'Miss Jane',
    ]);
    expect(await kept({ name: 'Jane Eyre', aliases: ['Janet'] }, 'Miss Janet')).toEqual([
      'Miss Janet',
    ]);
    expect(await kept({ name: 'Clara Montes', aliases: ['Clara'] }, 'Miss Clara', 'es')).toEqual([
      'Miss Clara',
    ]);
    // Not the surname of its full name, nor any name of a man.
    expect(await kept({ name: 'John Smith', aliases: ['Smith'] }, 'Miss Smith')).toEqual([]);
    expect(
      await kept({ name: 'Morgan Smith', aliases: ['Morgan'], gender: 'male' }, 'Miss Morgan'),
    ).toEqual([]);
  });

  it('refuses "Miss" before a name it goes by alone, his surname and her first name alike', async () => {
    // "Miss Smith" may be the daughter of a narrator called "Smith", and nothing tells "Smith"
    // from "Clara", so "Miss Clara" is refused too (see isFamilyTitleOf).
    expect(await kept({ aliases: ['Smith'] }, 'Miss Smith', 'es')).toEqual([]);
    expect(await kept({ aliases: ['Clara'] }, 'Miss Clara', 'es')).toEqual([]);
  });

  it('reads a new character with ref N as a name for the narrator', async () => {
    const { result, lines } = await analyze(
      '—Hola —dije.',
      baseCast('es'),
      ({ units }) =>
        labelAll(units, 'N', {
          newCharacters: [{ ref: 'N', name: 'Lucía', aliases: [], description: 'tells the story' }],
        }),
      { lang: 'es' },
    );
    expect(result.labels.aliasAdditions).toEqual([{ characterId: 'narrator', alias: 'Lucía' }]);
    expect(result.labels.newCharacters).toEqual([]);
    expect(lines.map(([, name]) => name)).toEqual(['Narrator', 'Narrator']);
  });
});

describe('characters the model proposes', () => {
  it('are the narrator when named like it, or "the narrator"', async () => {
    const { story, part } = await setup('“Hello.”\n\n“Hi.”');
    const transport = fakeTransport(() => ({
      units: [
        { id: 0, spans: [{ speaker: 'new1', mode: 'speech' }] },
        { id: 1, spans: [{ speaker: 'new2', mode: 'speech' }] },
      ],
      newCharacters: [
        { ref: 'new1', name: 'Watson', aliases: [], description: 'a doctor' },
        { ref: 'new2', name: 'The narrator', aliases: [], description: '' },
      ],
      aliasAdditions: [{ characterId: 'N', alias: 'Watson' }],
    }));
    await analyzePart(db, part.id, { voices, llm: llm(transport) });
    const { story: after, analysis } = await stored(part.id);
    expect(after.cast.map((c) => c.name)).toEqual(['Narrator', 'Unknown speaker']);
    expect(analysis.segments.map((s) => s.speakerId)).toEqual([story.narratorId, story.narratorId]);
  });

  it('are the narrator when named like the renamed narrator', async () => {
    const { lines, result } = await analyze(
      '“Hello.”',
      castWithNarrator({ name: 'Jane' }),
      ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [{ ref: 'new1', name: 'Jane', aliases: [], description: '' }],
        }),
    );
    expect(lines).toEqual([['“Hello.”', 'Jane', 'speech']]);
    expect(result.labels.newCharacters).toEqual([]);
  });

  it('give the member they map to the names it did not have', async () => {
    const cast = [...baseCast('es'), character('golfin', 'Teodoro Golfín')];
    const { result, transport } = await analyze(
      '—Vamos —dijo Golfín.\n\n—Sí.',
      cast,
      ({ units }) =>
        units.length === 2
          ? labelAll(units, 'new1', {
              newCharacters: [
                {
                  ref: 'new1',
                  name: 'Golfín',
                  aliases: ['el doctor'],
                  gender: 'male',
                  description: '',
                },
              ],
            })
          : labelAll(units, 'c1'),
      { lang: 'es', limits: { maxUnits: 2, maxTokens: 10_000 } },
    );
    expect(transport.calls[1]!.request.user).toContain(
      'c1: Teodoro Golfín (male; also called el doctor)',
    );
    expect(result.labels.aliasAdditions).toEqual([{ characterId: 'golfin', alias: 'el doctor' }]);
    expect(result.labels.newCharacters).toEqual([]);
  });

  it('are new when only a description they share fits a member', async () => {
    const cast = [
      ...baseCast('en'),
      character('mrs-bennet', 'Mrs. Bennet', { aliases: ['his lady'] }),
    ];
    const { lines, result } = await analyze('“Indeed,” said Lady Lucas.', cast, ({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [
          { ref: 'new1', name: 'Lady Lucas', aliases: ['his lady'], description: 'a neighbour' },
        ],
      }),
    );
    expect(lines[0]).toEqual(['“Indeed,”', 'Lady Lucas', 'speech']);
    expect(result.labels.newCharacters.map((c) => c.name)).toEqual(['Lady Lucas']);
  });

  it('are the one member their proper-name alias fits', async () => {
    const cast = [...baseCast('en'), character('elizabeth', 'Elizabeth')];
    const { lines, result } = await analyze('“Yes,” said Lizzy.', cast, ({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [{ ref: 'new1', name: 'Lizzy', aliases: ['Elizabeth'], description: '' }],
      }),
    );
    expect(lines[0]).toEqual(['“Yes,”', 'Elizabeth', 'speech']);
    expect(result.labels.newCharacters).toEqual([]);
    expect(result.labels.aliasAdditions).toEqual([{ characterId: 'elizabeth', alias: 'Lizzy' }]);
  });

  it.each([[[]], [['Jane']]])(
    'are new when only a word of their own full name fits a member (its aliases: %j)',
    async (aliases: string[]) => {
      const cast = [...baseCast('en'), character('jane', 'Jane Bennet', { aliases })];
      const { lines, result } = await analyze(
        '“How do you do?” said Jane Fairfax.',
        cast,
        ({ units }) =>
          labelAll(units, 'new1', {
            newCharacters: [
              {
                ref: 'new1',
                name: 'Jane Fairfax',
                aliases: ['Jane', 'Miss Fairfax'],
                description: '',
              },
            ],
          }),
      );
      expect(lines[0]).toEqual(['“How do you do?”', 'Jane Fairfax', 'speech']);
      expect(result.labels.aliasAdditions).toEqual([]);
    },
  );

  it.each([
    ['Dr. John Watson', 'Watson', 'John H. Watson'],
    ['Dr. John Watson', 'John', 'John H. Watson'],
    ['Dr. John H. Watson', 'Watson', 'John Watson'],
    ['Mrs. Amy Dunne', 'Amy', 'Amy Elliott Dunne'],
    ['Mrs. Amy Elliott Dunne', 'Amy', 'Amy Dunne'],
  ])(
    'are the member a word of their own name names when its full name agrees (%s, %s)',
    async (name, alias, member) => {
      const cast = [...baseCast('en'), character('member', member, { aliases: [alias] })];
      const { lines, result } = await analyze(`“Come at once,” said ${name}.`, cast, ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [{ ref: 'new1', name, aliases: [alias], description: '' }],
        }),
      );
      expect(lines[0]).toEqual(['“Come at once,”', member, 'speech']);
      expect(result.labels.newCharacters).toEqual([]);
      expect(result.labels.aliasAdditions).toEqual([{ characterId: 'member', alias: name }]);
    },
  );

  it('are new when an alias only resembles a name of the narrator', async () => {
    const proposal =
      (name: string, aliases: string[]) =>
      ({ units }: FakeCall) =>
        labelAll(units, 'new1', {
          newCharacters: [{ ref: 'new1', name, aliases, gender: 'female', description: '' }],
        });
    const watson = await analyze(
      '“Good evening,” said Miss Morstan.',
      castWithNarrator({ aliases: ['Watson'] }),
      proposal('Mary Morstan', ['Miss Morstan', 'Mrs. Watson']),
    );
    expect(watson.lines[0]).toEqual(['“Good evening,”', 'Mary Morstan', 'speech']);

    // The narrator's mother shares its surname, but not its full name.
    const copperfield = await analyze(
      '“Davy, come here,” said my mother.',
      castWithNarrator({ name: 'David Copperfield', aliases: ['Copperfield', 'Davy'] }),
      proposal('Clara Copperfield', ['Clara', 'Copperfield', 'Mrs. Copperfield']),
    );
    expect(copperfield.lines[0]).toEqual(['“Davy, come here,”', 'Clara Copperfield', 'speech']);
    expect(copperfield.result.labels.aliasAdditions).toEqual([]);
  });

  it('are the narrator when an alias is exactly a name of it', async () => {
    const { lines, result } = await analyze(
      '“Come at once,” said Dr. John Watson.',
      castWithNarrator({ aliases: ['Watson'] }),
      ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [
            { ref: 'new1', name: 'Dr. John Watson', aliases: ['Watson'], description: '' },
          ],
        }),
    );
    expect(lines[0]).toEqual(['“Come at once,”', 'Narrator', 'speech']);
    expect(result.labels.newCharacters).toEqual([]);
    expect(result.labels.aliasAdditions).toEqual([
      { characterId: 'narrator', alias: 'Dr. John Watson' },
    ]);

    // A narrator with a full name that the proposal's own name agrees with.
    const named = await analyze(
      '“Come at once,” said Dr. John Watson.',
      castWithNarrator({ name: 'John H. Watson', aliases: ['Watson'] }),
      ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [
            { ref: 'new1', name: 'Dr. John Watson', aliases: ['Watson'], description: '' },
          ],
        }),
    );
    expect(named.lines[0]).toEqual(['“Come at once,”', 'John H. Watson', 'speech']);
    expect(named.result.labels.newCharacters).toEqual([]);
  });

  it.each([
    ['Mrs. Joe', [...baseCast('en'), character('joe', 'Joe')]],
    [
      'Miss Bingley',
      [...baseCast('en'), character('bingley', 'Bingley', { aliases: ['Mr. Bingley'] })],
    ],
  ])(
    'are new when named %s, a woman’s title before the name of a member',
    async (name, cast: Character[]) => {
      const { lines, result } = await analyze(`“Come in,” said ${name}.`, cast, ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [{ ref: 'new1', name, aliases: [], description: '' }],
        }),
      );
      expect(lines[0]).toEqual(['“Come in,”', name, 'speech']);
      expect(result.labels.newCharacters.map((c) => c.name)).toEqual([name]);
      expect(result.labels.aliasAdditions).toEqual([]);
    },
  );

  it.each([
    ['Mrs. Watson', 'Watson', castWithNarrator({ aliases: ['Watson'] })],
    ['Mrs. Watson', 'Watson', [...baseCast('en'), character('w', 'Watson', { gender: 'male' })]],
    ['Mrs. Joe', 'Joe', [...baseCast('en'), character('joe', 'Joe')]],
    [
      'Miss Bingley',
      'Bingley',
      [...baseCast('en'), character('bingley', 'Bingley', { aliases: ['Mr. Bingley'] })],
    ],
  ])(
    'are new when only the family name of %s, %s, names a member',
    async (name, alias, cast: Character[]) => {
      // The member who goes by it may be her husband, father or brother.
      const { lines, result } = await analyze(`“Come in,” said ${name}.`, cast, ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [{ ref: 'new1', name, aliases: [alias], description: '' }],
        }),
      );
      expect(lines[0]).toEqual(['“Come in,”', name, 'speech']);
      expect(result.labels.aliasAdditions).toEqual([]);
      // The family name stays the member's.
      expect(result.labels.newCharacters.map((c) => [c.name, c.aliases])).toEqual([[name, []]]);
    },
  );

  it('leave the family name with the member, so that "Dr. Watson" still finds him', async () => {
    // One chunk per paragraph: "Mrs. Watson", called "Watson", then "Dr. Watson".
    const { lines } = await analyze(
      '“Welcome,” said Mrs. Watson.\n\n“Thank you,” said Dr. Watson.',
      castWithNarrator({ aliases: ['Watson'] }),
      ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [
            units[0] === '“Welcome,”'
              ? { ref: 'new1', name: 'Mrs. Watson', aliases: ['Watson'], description: '' }
              : { ref: 'new1', name: 'Dr. Watson', aliases: [], description: '' },
          ],
        }),
      { limits: { maxUnits: 2, maxTokens: 10_000 } },
    );
    expect(lines.filter(([, , mode]) => mode === 'speech')).toEqual([
      ['“Welcome,”', 'Mrs. Watson', 'speech'],
      ['“Thank you,”', 'Narrator', 'speech'],
    ]);
  });

  it('are the member who goes by their family name when she is a woman', async () => {
    const cast = [...baseCast('en'), character('hudson', 'Hudson', { gender: 'female' })];
    const { lines, result } = await analyze('“Come in,” said Mrs. Hudson.', cast, ({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [{ ref: 'new1', name: 'Mrs. Hudson', aliases: ['Hudson'], description: '' }],
      }),
    );
    expect(lines[0]).toEqual(['“Come in,”', 'Hudson', 'speech']);
    expect(result.labels.aliasAdditions).toEqual([{ characterId: 'hudson', alias: 'Mrs. Hudson' }]);
  });

  it('never give a man who goes by a family name a woman’s title before it', async () => {
    const cast = [
      ...baseCast('en'),
      character('bingley', 'Bingley', { aliases: ['Mr. Bingley'], gender: 'male' }),
    ];
    // Mapped to him by name, and named by an alias addition.
    const { lines, result } = await analyze('“Charles!” said Bingley.', cast, ({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [
          { ref: 'new1', name: 'Bingley', aliases: ['Miss Bingley'], description: '' },
        ],
        aliasAdditions: [{ characterId: 'c1', alias: 'Miss Bingley' }],
      }),
    );
    expect(lines[0]).toEqual(['“Charles!”', 'Bingley', 'speech']);
    expect(result.labels.aliasAdditions).toEqual([]);
  });

  it.each([
    ['Miss Elizabeth', 'Elizabeth Bennet', 'Elizabeth', 'en'],
    ['Miss Scarlett', 'Scarlett O’Hara', 'Scarlett', 'en'],
    ['Miss Eliza', 'Elizabeth Bennet', 'Eliza', 'en'],
    ['Miss Florence', 'Florence Smith', 'Florence', 'es'],
  ] as const)(
    'are the member when named %s, a title before a name of %s that is not a family name',
    async (name, member, alias, lang) => {
      // The member's full name starts with the name, or leaves it out.
      const cast = [...baseCast(lang), character('m', member, { aliases: [alias] })];
      const [text, quote] =
        lang === 'es'
          ? [`—Pase —dijo ${name}.`, '—Pase']
          : [`“Come in,” said ${name}.`, '“Come in,”'];
      const { lines, result } = await analyze(
        text,
        cast,
        ({ units }) =>
          labelAll(units, 'new1', {
            newCharacters: [
              { ref: 'new1', name, aliases: [alias], gender: 'female', description: '' },
            ],
          }),
        { lang },
      );
      expect(lines[0]).toEqual([quote, member, 'speech']);
      expect(result.labels.newCharacters).toEqual([]);
      expect(result.labels.aliasAdditions).toEqual([{ characterId: 'm', alias: name }]);
    },
  );

  it('give a member "Miss" before a name its full name shows is not a family name', async () => {
    const cast = [
      ...baseCast('en'),
      character('eb', 'Elizabeth Bennet', { aliases: ['Elizabeth'] }),
    ];
    // Named by an alias addition, and by a proposal mapped to her by name.
    for (const reply of [
      { aliasAdditions: [{ characterId: 'c1', alias: 'Miss Elizabeth' }] },
      {
        newCharacters: [
          { ref: 'new1', name: 'Elizabeth Bennet', aliases: ['Miss Elizabeth'], description: '' },
        ],
      },
    ]) {
      const { lines, result } = await analyze('“Indeed,” said Miss Elizabeth.', cast, ({ units }) =>
        labelAll(units, 'newCharacters' in reply ? 'new1' : 'c1', reply),
      );
      expect(lines[0]).toEqual(['“Indeed,”', 'Elizabeth Bennet', 'speech']);
      expect(result.labels.aliasAdditions).toEqual([
        { characterId: 'eb', alias: 'Miss Elizabeth' },
      ]);
    }
  });

  it('are the narrator when named "Miss" before the first name of its full name', async () => {
    const { lines, result } = await analyze(
      '“Miss Jane, you must not cry,” said Bessie.\n\n“I am not crying,” said Miss Jane.',
      castWithNarrator({ name: 'Jane Eyre', aliases: ['Jane'] }),
      ({ units }) => ({
        units: units.map((text, id) => ({
          id,
          spans: [
            text.startsWith('“')
              ? { speaker: text.includes('cry,') ? 'new1' : 'new2', mode: 'speech' }
              : { speaker: 'N', mode: 'narration' },
          ],
        })),
        newCharacters: [
          { ref: 'new1', name: 'Bessie', aliases: [], gender: 'female', description: '' },
          { ref: 'new2', name: 'Miss Jane', aliases: ['Jane'], gender: 'female', description: '' },
        ],
        aliasAdditions: [],
      }),
    );
    expect(lines.filter(([, , mode]) => mode === 'speech')).toEqual([
      ['“Miss Jane, you must not cry,”', 'Bessie', 'speech'],
      ['“I am not crying,”', 'Jane Eyre', 'speech'],
    ]);
    expect(result.labels.newCharacters.map((c) => c.name)).toEqual(['Bessie']);
    expect(result.labels.aliasAdditions).toEqual([{ characterId: 'narrator', alias: 'Miss Jane' }]);
  });

  it('are the member renamed meanwhile to a full name the name after "Miss" starts', async () => {
    const { story, part } = await setup('“I am perfectly serious,” said Miss Elizabeth.');
    await updateStory(db, story.id, { cast: [...story.cast, character('s', 'the stranger')] });
    const held = heldTransport(({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [
          {
            ref: 'new1',
            name: 'Miss Elizabeth',
            aliases: ['Elizabeth'],
            gender: 'female',
            description: '',
          },
        ],
      }),
    );
    const running = analyzePart(db, part.id, { voices, llm: llm(held.transport) });
    await held.requested;
    // The Cast view gives "the stranger" her name while Claude runs.
    const cast = (await getStory(db, story.id))!.cast.map((c) =>
      c.id === 's' ? { ...c, name: 'Elizabeth Bennet', aliases: ['the stranger', 'Elizabeth'] } : c,
    );
    await updateStory(db, story.id, { cast });
    held.release();
    await running;

    const { story: after, lines } = await stored(part.id);
    expect(lines[0]).toEqual(['“I am perfectly serious,”', 'Elizabeth Bennet', 'llm']);
    expect(after.cast.map((c) => [c.name, c.aliases])).toEqual([
      ['Narrator', []],
      ['Unknown speaker', []],
      ['Elizabeth Bennet', ['the stranger', 'Elizabeth', 'Miss Elizabeth']],
    ]);
  });

  it.each([
    ['Miss Bingley', 'Bingley', []],
    ['Miss Elizabeth', 'Elizabeth', []],
    ['Miss Bingley', 'Bingley', ['Charles Bingley']],
    ['Miss Marple', 'Marple', ['Jane Marple']],
    ['Mrs. Joe', 'Joe', ['Joe Gargery']],
    ['Mrs. Elizabeth', 'Elizabeth', ['Elizabeth Bennet']],
  ])(
    'are new when named %s while a member goes by %s, who may be her family (%j)',
    async (name, alias, aliases: string[]) => {
      // Twins: "Miss Bingley" is his sister but "Miss Elizabeth" is the member herself, and "Miss
      // Marple" is "Jane Marple" but "Miss Bingley" is not "Charles Bingley". Only a list of first
      // names would tell them apart, so each is new, the milder mistake (see isFamilyTitleOf). A
      // married woman's title may also go before her husband's first name ("Mrs. Joe").
      const cast = [...baseCast('en'), character('m', alias, { aliases })];
      const { lines, result } = await analyze(`“Come in,” said ${name}.`, cast, ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [
            { ref: 'new1', name, aliases: [alias], gender: 'female', description: '' },
          ],
        }),
      );
      expect(lines[0]).toEqual(['“Come in,”', name, 'speech']);
      expect(result.labels.newCharacters.map((c) => [c.name, c.aliases])).toEqual([[name, []]]);
      expect(result.labels.aliasAdditions).toEqual([]);
    },
  );

  it('never make "I" or "the narrator" a name of anyone', async () => {
    const cast = [...baseCast('en'), character('amy', 'Amy', { gender: 'female' })];
    const placeholders = ['I', 'yo', 'the narrator'];
    const mapped = await analyze(
      '“Hello.”\n\n“Hi.”',
      cast,
      ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [{ ref: 'new1', name: 'Amy', aliases: placeholders, description: '' }],
          aliasAdditions: [{ characterId: 'c1', alias: 'I' }],
        }),
      { limits: { maxUnits: 1, maxTokens: 10_000 } },
    );
    expect(mapped.result.labels.aliasAdditions).toEqual([]);
    expect(mapped.transport.calls[1]!.request.user).toContain('\nc1: Amy (female)\n');

    const created = await analyze('“Hello.”', baseCast('en'), ({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [
          { ref: 'new1', name: 'Amy', aliases: [...placeholders, 'Amy Dunne'], description: '' },
        ],
      }),
    );
    expect(created.result.labels.newCharacters.map((c) => c.aliases)).toEqual([['Amy Dunne']]);
  });

  it('are not a member only because both were called "I"', async () => {
    // A cast stored before such names were refused.
    const cast = [...baseCast('en'), character('amy', 'Amy', { aliases: ['I'] })];
    const { lines, transport } = await analyze('“Hello.”', cast, ({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [{ ref: 'new1', name: 'Nick', aliases: ['I'], description: '' }],
      }),
    );
    expect(lines[0]).toEqual(['“Hello.”', 'Nick', 'speech']);
    expect(transport.calls[0]!.request.user).toContain('\nc1: Amy\n');
  });
});

describe('traits of new characters', () => {
  /** The trait keys an object holds, whatever their values (toEqual would not see an undefined). */
  const traitKeys = (c: object) =>
    Object.keys(c).filter((k) => ['gender', 'age', 'species', 'size'].includes(k));

  it('are stored with a character the model describes', async () => {
    const { part } = await setup('“Squeak,” said Pip.');
    const transport = fakeTransport(({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [
          {
            ref: 'new1',
            name: 'Pip',
            aliases: [],
            age: 'child',
            species: 'animal',
            size: 'small',
            description: 'a mouse',
          },
        ],
      }),
    );
    const report = await analyzePart(db, part.id, { voices, llm: llm(transport) });

    const { story } = await stored(part.id);
    const pip = story.cast.find((c) => c.name === 'Pip')!;
    expect(report).toMatchObject({ kind: 'llm', fallbackUnits: 0 });
    expect(pip).toMatchObject({ age: 'child', species: 'animal', size: 'small' });
    expect(traitKeys(pip)).toEqual(['age', 'species', 'size']);
    expect(pip.voice.voiceName).toBeDefined();
  });

  it('leave out a value the format does not know, and keep the character and its lines', async () => {
    const { part } = await setup('“Go away,” said Morgana.');
    const transport = fakeTransport(({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [
          {
            ref: 'new1',
            name: 'Morgana',
            aliases: [],
            gender: 'female',
            age: 'elderly',
            species: 'creature',
            size: 'medium',
            description: 'a fairy',
          },
        ],
      }),
    );
    const report = await analyzePart(db, part.id, { voices, llm: llm(transport) });

    const { story, lines } = await stored(part.id);
    const morgana = story.cast.find((c) => c.name === 'Morgana')!;
    expect(report).toMatchObject({ kind: 'llm', fallbackUnits: 0 });
    expect(lines[0]).toEqual(['“Go away,”', 'Morgana', 'llm']);
    expect(morgana).toMatchObject({ gender: 'female', species: 'creature' });
    expect(traitKeys(morgana)).toEqual(['gender', 'species']);
  });

  it('grow when a later answer describes a character of this run again', async () => {
    const { result } = await analyze(
      '“Hi,” said Tom.\n\n“Bye,” said Tom.',
      baseCast('en'),
      ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [
            units[0] === '“Hi,”'
              ? { ref: 'new1', name: 'Tom', aliases: [], gender: 'male', description: '' }
              : {
                  ref: 'new1',
                  name: 'Tom',
                  aliases: [],
                  gender: 'female',
                  age: 'child',
                  species: 'animal',
                  size: 'huge',
                  description: '',
                },
          ],
        }),
      { limits: { maxUnits: 2, maxTokens: 10_000 } },
    );
    expect(result.fallbackUnits).toBe(0);
    expect(result.labels.newCharacters).toStrictEqual([
      { ref: 'x1', name: 'Tom', aliases: [], gender: 'male', age: 'child', species: 'animal' },
    ]);
  });

  it('keep what the first answer said when a later one disagrees', async () => {
    const { result } = await analyze(
      '“Hi,” said Tom.\n\n“Bye,” said Tom.',
      baseCast('en'),
      ({ units }) =>
        labelAll(units, 'new1', {
          newCharacters: [
            {
              ref: 'new1',
              name: 'Tom',
              aliases: [],
              ...(units[0] === '“Hi,”'
                ? { age: 'elder', size: 'large' }
                : { age: 'child', size: 'small', species: 'machine' }),
              description: '',
            },
          ],
        }),
      { limits: { maxUnits: 2, maxTokens: 10_000 } },
    );
    expect(result.labels.newCharacters).toStrictEqual([
      { ref: 'x1', name: 'Tom', aliases: [], age: 'elder', size: 'large', species: 'machine' },
    ]);
  });

  it('never reach a member of the cast, whatever the model says about it', async () => {
    const { story, part } = await setup('“Hi,” said Tom.\n\n“Hello,” I said.');
    const tom = character('tom-id', 'Tom');
    await updateStory(db, story.id, { cast: [...story.cast, tom] });
    const transport = fakeTransport(({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [
          {
            ref: 'new1',
            name: 'Tom',
            aliases: [],
            gender: 'male',
            age: 'child',
            species: 'animal',
            size: 'small',
            description: 'a kitten',
          },
          {
            ref: 'N',
            name: 'Watson',
            aliases: [],
            age: 'elder',
            species: 'human',
            description: '',
          },
        ],
      }),
    );
    await analyzePart(db, part.id, { voices, llm: llm(transport) });

    const { story: after } = await stored(part.id);
    expect(after.cast.map((c) => c.name)).toEqual(['Narrator', 'Unknown speaker', 'Tom']);
    expect(after.cast.find((c) => c.id === 'tom-id')).toStrictEqual(tom);
    expect(after.cast.flatMap(traitKeys)).toEqual([]);
  });

  it('are guessed from the name of a character only the heuristic found, not of the model’s own', async () => {
    // Units: 0 “Hi,” · 1 said the little girl. · 2 “Who goes there?” · 3 asked the old man.
    const { result, lines } = await analyze(
      '“Hi,” said the little girl.\n\n“Who goes there?” asked the old man.',
      baseCast('en'),
      ({ units }) =>
        units[0] === '“Who goes there?”'
          ? { stopReason: 'refusal', text: '' }
          : labelAll(units, 'new1', {
              newCharacters: [
                { ref: 'new1', name: 'the little girl', aliases: [], description: '' },
              ],
            }),
      { limits: { maxUnits: 2, maxTokens: 10_000 } },
    );
    expect(result.fallbackUnits).toBe(2);
    expect(lines.filter(([, , mode]) => mode === 'speech')).toEqual([
      ['“Hi,”', 'the little girl', 'speech'],
      ['“Who goes there?”', 'the old man', 'speech'],
    ]);
    // The model saw the name and left the traits out; the heuristic never looks for them.
    expect(result.labels.newCharacters).toStrictEqual([
      { ref: 'x1', name: 'the little girl', aliases: [] },
      { ref: 'x2', name: 'the old man', aliases: [], gender: 'male', age: 'elder' },
    ]);
  });

  it('are guessed in the story’s language: a Spanish description in a Spanish story', async () => {
    const { result, lines } = await analyze(
      '—¿Quién anda ahí? —preguntó la abuela.',
      baseCast('es'),
      () => ({ stopReason: 'refusal', text: '' }),
      { lang: 'es' },
    );
    expect(result.fallbackUnits).toBeGreaterThan(0);
    expect(lines.filter(([, , mode]) => mode === 'speech')).toEqual([
      ['—¿Quién anda ahí?', 'la abuela', 'speech'],
    ]);
    expect(result.labels.newCharacters).toStrictEqual([
      { ref: 'x1', name: 'la abuela', aliases: [], gender: 'female', age: 'elder' },
    ]);
  });

  it('are not guessed from the surname of a titled character said alone', async () => {
    const { result } = await analyze(
      '“Good morning,” said Mr. Fox.\n\n“Is it?” said Anne.\n\n“It is,” said Fox.',
      baseCast('en'),
      () => ({ stopReason: 'refusal', text: '' }),
    );
    // "Fox" is the surname of "Mr. Fox", not the name of an animal: no species.
    expect(result.labels.newCharacters).toStrictEqual([
      { ref: 'x1', name: 'Mr. Fox', aliases: ['Fox'], gender: 'male' },
      { ref: 'x2', name: 'Anne', aliases: [] },
    ]);
  });
});

describe('the output schema', () => {
  const descriptions = {
    age: 'When the text shows it, one of: child, teen, adult, elder',
    species:
      'When the text shows it, one of: human, animal, creature (fantasy being), machine (robot, AI)',
    size: 'small or large; omit for average',
  };

  it('tells the model what the three trait fields may hold', () => {
    const wire = JSON.stringify(LLM_OUTPUT_FORMAT.schema);
    for (const text of Object.values(descriptions)) expect(wire).toContain(JSON.stringify(text));
  });

  it('sends the traits as optional plain strings, so that an odd value costs only itself', () => {
    const schema = LLM_OUTPUT_FORMAT.schema as {
      properties: {
        newCharacters: {
          items: { properties: Record<string, object>; required: string[] };
        };
      };
    };
    const proposal = schema.properties.newCharacters.items;
    expect(proposal.required).toEqual(['ref', 'name', 'aliases', 'description']);
    for (const [key, description] of Object.entries(descriptions)) {
      expect(proposal.properties[key]).toEqual({ type: 'string', description });
    }
    expect(Object.keys(proposal.properties)).toEqual([
      'ref',
      'name',
      'aliases',
      'gender',
      'age',
      'species',
      'size',
      'description',
    ]);

    const read = readLlmOutput(
      JSON.stringify({
        units: [],
        newCharacters: [
          { ref: 'a', name: 'Ann', aliases: [], description: '' },
          { ref: 'b', name: 'Bo', aliases: [], age: 'elderly', size: 'medium', description: '' },
          { ref: 'c', name: 'Cy', aliases: [], age: 7, description: '' },
        ],
        aliasAdditions: [],
      }),
    );
    expect(read.newCharacters).toStrictEqual([
      { ref: 'a', name: 'Ann', aliases: [], description: '' },
      { ref: 'b', name: 'Bo', aliases: [], age: 'elderly', size: 'medium', description: '' },
    ]);
  });
});

describe('codes and context', () => {
  it('gives each proposal its own fresh code, whatever refs the model picks', async () => {
    const { lines, result } = await analyze(
      '“Hi,” said Anne.\n\n“Up the hill,” said Jack. “Wait,” said Jill.',
      baseCast('en'),
      ({ units }) =>
        units.length === 2
          ? labelAll(units, 'new1', {
              newCharacters: [{ ref: 'new1', name: 'Anne', aliases: [], description: '' }],
            })
          : {
              units: [
                { id: 0, spans: [{ speaker: 'x2', mode: 'speech' }] },
                { id: 1, spans: [{ speaker: 'N', mode: 'narration' }] },
                { id: 2, spans: [{ speaker: 'x3', mode: 'speech' }] },
                { id: 3, spans: [{ speaker: 'N', mode: 'narration' }] },
              ],
              newCharacters: [
                { ref: 'x3', name: 'Jill', aliases: [], description: '' },
                { ref: 'x2', name: 'Jack', aliases: [], description: '' },
              ],
              aliasAdditions: [],
            },
      { limits: { maxUnits: 4, maxTokens: 10_000 } },
    );
    expect(lines.filter(([, , mode]) => mode === 'speech')).toEqual([
      ['“Hi,”', 'Anne', 'speech'],
      ['“Up the hill,”', 'Jack', 'speech'],
      ['“Wait,”', 'Jill', 'speech'],
    ]);
    expect(new Set(result.labels.newCharacters.map((c) => c.ref)).size).toBe(3);
  });

  it('keeps the meaning of a code the request showed when a proposal reuses it', async () => {
    const cast = [
      ...baseCast('en'),
      character('elizabeth', 'Elizabeth'),
      character('bennet', 'Mr. Bennet'),
    ];
    const { lines, result } = await analyze(
      '“Good morning,” said Elizabeth.\n\n“Good morning, Lizzy,” said her father.\n\n“Are you well?” asked Lizzy.',
      cast,
      ({ units }) => ({
        units: units.map((u, id) => ({
          id,
          spans: [
            u.startsWith('“Good morning, Lizzy')
              ? { speaker: 'c2', mode: 'speech' }
              : u.startsWith('“')
                ? { speaker: 'c1', mode: 'speech' }
                : { speaker: 'N', mode: 'narration' },
          ],
        })),
        // "Lizzy" belongs in aliasAdditions; declared under c1 it must not take Elizabeth's lines.
        newCharacters: [{ ref: 'c1', name: 'Lizzy', aliases: [], description: '' }],
        aliasAdditions: [],
      }),
    );
    expect(lines.filter(([, , mode]) => mode === 'speech').map(([, name]) => name)).toEqual([
      'Elizabeth',
      'Mr. Bennet',
      'Elizabeth',
    ]);
    expect(result.labels.newCharacters).toEqual([]);

    // Declared under its own name, the member still learns its other names.
    const named = await analyze('“Yes,” said Lizzy.', cast, ({ units }) =>
      labelAll(units, 'c1', {
        newCharacters: [{ ref: 'c1', name: 'Elizabeth', aliases: ['Lizzy'], description: '' }],
      }),
    );
    expect(named.result.labels.aliasAdditions).toEqual([
      { characterId: 'elizabeth', alias: 'Lizzy' },
    ]);
  });

  it('never makes U a character, so its narration still goes to the teller', async () => {
    const { lines, result } = await analyze(
      'The wind howled.\n\n“Who is there?” called a voice.\n\n“Nobody,” came a second voice.',
      baseCast('en'),
      ({ units }) => ({
        units: units.map((u, id) => ({
          id,
          spans: [
            u.startsWith('“') || u === 'The wind howled.'
              ? { speaker: 'U', mode: u.startsWith('“') ? 'speech' : 'narration' }
              : { speaker: 'N', mode: 'narration' },
          ],
        })),
        newCharacters: [{ ref: 'U', name: 'a voice', aliases: [], description: 'someone outside' }],
        aliasAdditions: [],
      }),
    );
    expect(lines.map(([, name]) => name)).toEqual([
      'Narrator',
      'Unknown',
      'Narrator',
      'Unknown',
      'Narrator',
    ]);
    expect(result.labels.newCharacters).toEqual([]);
  });

  it('lets a character proposed in the same answer receive an alias', async () => {
    const { part } = await setup('“Who are you?” asked the stranger.');
    const transport = fakeTransport(({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [{ ref: 'new1', name: 'the stranger', aliases: [], description: '' }],
        aliasAdditions: [{ characterId: 'new1', alias: 'Rochester' }],
      }),
    );
    await analyzePart(db, part.id, { voices, llm: llm(transport) });
    const { story } = await stored(part.id);
    expect(story.cast.find((c) => c.name === 'the stranger')!.aliases).toEqual(['Rochester']);
  });

  it('shows an alias added to a new character once', async () => {
    const { transport, result } = await analyze(
      '“Hi.”\n\n“Hello.”\n\n“Bye.”',
      baseCast('en'),
      ({ units }) =>
        units[0] === '“Hi.”'
          ? labelAll(units, 'new1', {
              newCharacters: [
                { ref: 'new1', name: 'Tom', aliases: [], gender: 'male', description: 'a boy' },
              ],
            })
          : labelAll(units, 'x1', { aliasAdditions: [{ characterId: 'x1', alias: 'Tommy' }] }),
      { limits: { maxUnits: 1, maxTokens: 10_000 } },
    );
    expect(transport.calls[2]!.request.user).toContain('x1: Tom (male; also called Tommy; a boy)');
    expect(result.labels.newCharacters[0]!.aliases).toEqual(['Tommy']);
  });

  it('includes refused and fallback units in the context', async () => {
    const { transport } = await analyze(
      '“Come in.”\n\n“Why not?”\n\n“Because.”',
      baseCast('en'),
      ({ units }) =>
        units[0] === '“Why not?”' ? { stopReason: 'refusal', text: '' } : labelAll(units, 'U'),
      { limits: { maxUnits: 1, maxTokens: 10_000 } },
    );
    expect(transport.calls[2]!.request.user).toMatch(/^\[\w+, speech\] “Why not\?”$/mu);
  });

  it('gives the context one line per span of a split unit', async () => {
    const cast = [...baseCast('en'), character('anne', 'Anne')];
    const { transport } = await analyze(
      'Anne turned to him. I am not going back, she said.\n\n“Fine.”',
      cast,
      ({ units }) =>
        units.length === 1 && units[0]!.startsWith('Anne')
          ? {
              units: [
                {
                  id: 0,
                  spans: [
                    { text: 'Anne turned to him.', speaker: 'N', mode: 'narration' },
                    { text: 'I am not going back,', speaker: 'c1', mode: 'speech' },
                    { text: 'she said.', speaker: 'N', mode: 'narration' },
                  ],
                },
              ],
              newCharacters: [],
              aliasAdditions: [],
            }
          : labelAll(units, 'U'),
      { limits: { maxUnits: 1, maxTokens: 10_000 } },
    );
    expect(transport.calls[1]!.request.user).toContain(
      '[N, narration] Anne turned to him.\n[c1, speech] I am not going back,\n[N, narration] she said.',
    );
  });
});

describe('units left to the heuristic', () => {
  const text =
    'AMY\n\nI met Nick at a party.\n\nI knew at once.\n\n“Hi,” I said.\n\n“Hello,” said Nick.';
  /** Labels AMY, the first narration, “Hello,” and its tag; leaves out the units in between. */
  const reply =
    (teller: string) =>
    ({ units }: FakeCall) => ({
      units: units.flatMap((u, id) =>
        u === '“Hello,”'
          ? [{ id, spans: [{ speaker: 'new2', mode: 'speech' }] }]
          : ['AMY', 'I met Nick at a party.', 'said Nick.'].includes(u)
            ? [{ id, spans: [{ speaker: teller, mode: 'narration' }] }]
            : [],
      ),
      newCharacters: [
        { ref: 'new1', name: 'Amy', aliases: [], gender: 'female', description: 'tells it' },
        { ref: 'new2', name: 'Nick', aliases: [], gender: 'male', description: '' },
      ],
      aliasAdditions: [],
    });

  it('take the teller the model chose nearby for narration and “I” lines', async () => {
    const { lines, result } = await analyze(text, baseCast('en'), reply('new1'));
    expect(result.fallbackUnits).toBe(3);
    expect(lines).toEqual([
      ['AMY', 'Amy', 'narration'],
      ['I met Nick at a party.', 'Amy', 'narration'],
      ['I knew at once.', 'Amy', 'narration'],
      ['“Hi,”', 'Amy', 'speech'],
      ['I said.', 'Amy', 'narration'],
      ['“Hello,”', 'Nick', 'speech'],
      ['said Nick.', 'Amy', 'narration'],
    ]);
    expect(result.labels.spans.filter((s) => 'teller' in s)).toEqual([]);
  });

  it('take the teller for lines said through a beat, an intro or a continued quote', async () => {
    const { lines } = await analyze(
      [
        'AMY',
        'I met Nick at a party.',
        '“Hello,” said Nick.',
        'I shrugged. “Nowhere.”',
        'I turned to him and said:',
        '“Let’s go.”',
        '“It was a long road,” I said, “and a hard one.',
        '“But we made it home.”',
      ].join('\n\n'),
      baseCast('en'),
      reply('new1'),
    );
    expect(lines.filter(([, , mode]) => mode !== 'narration')).toEqual([
      ['“Hello,”', 'Nick', 'speech'],
      ['“Nowhere.”', 'Amy', 'speech'],
      ['“Let’s go.”', 'Amy', 'speech'],
      ['“It was a long road,”', 'Amy', 'speech'],
      ['“and a hard one.', 'Amy', 'speech'],
      ['“But we made it home.”', 'Amy', 'speech'],
    ]);
  });

  it('stay with the narrator when the model gave it the narration', async () => {
    const { lines } = await analyze(text, baseCast('en'), reply('N'));
    expect(lines.slice(2, 5)).toEqual([
      ['I knew at once.', 'Narrator', 'narration'],
      ['“Hi,”', 'Narrator', 'speech'],
      ['I said.', 'Narrator', 'narration'],
    ]);
  });

  it('reuse a name the model gave the narrator', async () => {
    const { lines, result } = await analyze(
      '“Come in, Watson,” said Holmes.\n\n“Thank you,” said Watson.',
      baseCast('en'),
      ({ units }) =>
        units[0] === '“Thank you,”'
          ? { stopReason: 'refusal', text: '' }
          : labelAll(units, 'new1', {
              newCharacters: [{ ref: 'new1', name: 'Holmes', aliases: [], description: '' }],
              aliasAdditions: [{ characterId: 'N', alias: 'Watson' }],
            }),
      { limits: { maxUnits: 2, maxTokens: 10_000 } },
    );
    expect(lines.slice(2)).toEqual([
      ['“Thank you,”', 'Narrator', 'speech'],
      ['said Watson.', 'Narrator', 'narration'],
    ]);
    expect(result.labels.newCharacters.map((c) => c.name)).toEqual(['Holmes']);
  });

  it('give narration the model left to U to the last teller, else to N', async () => {
    const { lines } = await analyze(
      'AMY\n\nI met Nick at a party.\n\nIt rained.',
      baseCast('en'),
      () => ({
        units: [
          { id: 0, spans: [{ speaker: 'U', mode: 'narration' }] },
          { id: 1, spans: [{ speaker: 'new1', mode: 'narration' }] },
          { id: 2, spans: [{ speaker: 'U', mode: 'narration' }] },
        ],
        newCharacters: [{ ref: 'new1', name: 'Amy', aliases: [], description: '' }],
        aliasAdditions: [],
      }),
    );
    expect(lines.map(([, name]) => name)).toEqual(['Narrator', 'Amy', 'Amy']);
  });

  describe('in a refused chunk', () => {
    /** Refuses the chunk that starts with `refused` and gives every other unit to Amy. */
    const refusing =
      (refused: string) =>
      ({ units }: FakeCall) =>
        units[0] === refused
          ? { stopReason: 'refusal', text: '' }
          : {
              units: units.map((_, id) => ({
                id,
                spans: [{ speaker: 'new1', mode: 'narration' }],
              })),
              newCharacters: [{ ref: 'new1', name: 'Amy', aliases: [], description: 'tells it' }],
              aliasAdditions: [],
            };

    it('take the teller the model names after it', async () => {
      const { lines, result } = await analyze(
        'AMY\n\nI knew at once.\n\nI met Nick at a party.\n\nIt rained.',
        baseCast('en'),
        refusing('AMY'),
        { limits: { maxUnits: 2, maxTokens: 10_000 } },
      );
      expect(result.fallbackUnits).toBe(2);
      expect(lines.map(([, name]) => name)).toEqual(['Amy', 'Amy', 'Amy', 'Amy']);
    });

    it('take the teller the model named before it', async () => {
      const { lines, result } = await analyze(
        'I met Nick at a party.\n\nIt rained.\n\nI woke early.\n\n“Hi,” I said.',
        baseCast('en'),
        refusing('“Hi,”'),
        { limits: { maxUnits: 3, maxTokens: 10_000 } },
      );
      expect(result.fallbackUnits).toBe(2);
      expect(lines.slice(3)).toEqual([
        ['“Hi,”', 'Amy', 'speech'],
        ['I said.', 'Amy', 'narration'],
      ]);
    });
  });

  it('look past narration the model left to U for the teller it named', async () => {
    const amy = { ref: 'new1', name: 'Amy', aliases: [], description: '' };
    // The heading is N's only because the model had named no teller yet.
    const skipped = await analyze(
      'AMY ELLIOTT\n\nI met Nick at a party.\n\nI knew at once.',
      baseCast('en'),
      () => ({
        units: [
          { id: 0, spans: [{ speaker: 'U', mode: 'narration' }] },
          { id: 2, spans: [{ speaker: 'new1', mode: 'narration' }] },
        ],
        newCharacters: [amy],
        aliasAdditions: [],
      }),
    );
    expect(skipped.lines.map(([, name]) => name)).toEqual(['Narrator', 'Amy', 'Amy']);

    // One chunk per paragraph: the first is refused, and the heading after it is left to U.
    const refused = await analyze(
      'I met Nick at a party.\n\nAMY ELLIOTT\n\nI knew at once.',
      baseCast('en'),
      ({ units }) =>
        units[0] === 'I met Nick at a party.'
          ? { stopReason: 'refusal', text: '' }
          : {
              units: [
                {
                  id: 0,
                  spans: [
                    { speaker: units[0] === 'AMY ELLIOTT' ? 'U' : 'new1', mode: 'narration' },
                  ],
                },
              ],
              newCharacters: units[0] === 'AMY ELLIOTT' ? [] : [amy],
              aliasAdditions: [],
            },
      { limits: { maxUnits: 1, maxTokens: 10_000 } },
    );
    expect(refused.lines.map(([, name]) => name)).toEqual(['Amy', 'Narrator', 'Amy']);
  });

  describe('around a letter or diary', () => {
    const cast = [
      ...baseCast('en'),
      character('nick', 'Nick Dunne'),
      character('amy', 'Amy Elliott'),
      character('lestrade', 'Lestrade'),
    ];
    /** Labels the units named in `spans` by their text and leaves out the rest. */
    const labelled =
      (spans: Record<string, [speaker: string, mode: Mode]>) =>
      ({ units }: FakeCall) => ({
        units: units.flatMap((u, id) =>
          spans[u] ? [{ id, spans: [{ speaker: spans[u][0], mode: spans[u][1] }] }] : [],
        ),
        newCharacters: [],
        aliasAdditions: [],
      });
    /** The narrator, and a character, telling the stretch around the letters. */
    const tellers = [
      ['N', 'Narrator'],
      ['c1', 'Nick Dunne'],
    ] as const;

    it('go to its writer when inside it', async () => {
      const { lines } = await analyze(
        [
          'NICK DUNNE',
          'I drove to the bar and opened up.',
          'AMY ELLIOTT, DIARY ENTRY',
          'Tonight I met a boy at a party.',
          '“Hi,” he said.',
          '“Hello,” I said.',
          '“Want a drink?”',
          'He was tall and he made me laugh.',
        ].join('\n\n'),
        cast,
        labelled({
          'NICK DUNNE': ['c1', 'narration'],
          'I drove to the bar and opened up.': ['c1', 'narration'],
          'AMY ELLIOTT, DIARY ENTRY': ['c2', 'written'],
          'Tonight I met a boy at a party.': ['c2', 'written'],
          '“Hi,”': ['c1', 'speech'],
          'he said.': ['c2', 'written'],
          '“Want a drink?”': ['c1', 'speech'],
          'He was tall and he made me laugh.': ['c2', 'written'],
        }),
      );
      expect(lines.slice(6, 8)).toEqual([
        ['“Hello,”', 'Amy Elliott', 'speech'],
        ['I said.', 'Amy Elliott', 'narration'],
      ]);
    });

    it('go to its writer right after its heading', async () => {
      const { lines } = await analyze(
        [
          'NICK DUNNE',
          'I drove to the bar and opened up.',
          'AMY ELLIOTT, DIARY ENTRY',
          'Tonight I met a boy at a party.',
          'He was tall and he made me laugh.',
          'I think I will see him again.',
        ].join('\n\n'),
        cast,
        labelled({
          'NICK DUNNE': ['c1', 'narration'],
          'I drove to the bar and opened up.': ['c1', 'narration'],
          'AMY ELLIOTT, DIARY ENTRY': ['c2', 'written'],
          'He was tall and he made me laugh.': ['c2', 'written'],
          'I think I will see him again.': ['c2', 'written'],
        }),
      );
      expect(lines[3]).toEqual(['Tonight I met a boy at a party.', 'Amy Elliott', 'narration']);
    });

    it('go to its writer in a refused chunk inside it', async () => {
      const { lines, result } = await analyze(
        [
          'NICK DUNNE',
          'I drove to the bar and opened up.',
          'AMY ELLIOTT, DIARY ENTRY',
          'Tonight I met a boy at a party.',
          'He was tall and he made me laugh.',
          'I think I will see him again.',
          'We danced until the music stopped.',
          'I wrote his number on my hand.',
        ].join('\n\n'),
        cast,
        (call) =>
          call.units[0] === 'He was tall and he made me laugh.'
            ? { stopReason: 'refusal', text: '' }
            : labelled({
                'NICK DUNNE': ['c1', 'narration'],
                'I drove to the bar and opened up.': ['c1', 'narration'],
                'AMY ELLIOTT, DIARY ENTRY': ['c2', 'written'],
                'Tonight I met a boy at a party.': ['c2', 'written'],
                'We danced until the music stopped.': ['c2', 'written'],
                'I wrote his number on my hand.': ['c2', 'written'],
              })(call),
        { limits: { maxUnits: 2, maxTokens: 10_000 } },
      );
      expect(result.fallbackUnits).toBe(2);
      expect(lines.slice(4, 6).map(([, name]) => name)).toEqual(['Amy Elliott', 'Amy Elliott']);
    });

    it('go to its writer after the writer’s own “I” line', async () => {
      const { lines } = await analyze(
        [
          'NICK DUNNE',
          'I drove to the bar and opened up.',
          'AMY ELLIOTT, DIARY ENTRY',
          'Tonight I met a boy at a party.',
          '“You are funny,” I told him.',
          'We danced until the music stopped.',
        ].join('\n\n'),
        cast,
        labelled({
          'NICK DUNNE': ['c1', 'narration'],
          'I drove to the bar and opened up.': ['c1', 'narration'],
          'AMY ELLIOTT, DIARY ENTRY': ['c2', 'written'],
          'Tonight I met a boy at a party.': ['c2', 'written'],
          '“You are funny,”': ['c2', 'speech'],
          'We danced until the music stopped.': ['c2', 'written'],
        }),
      );
      expect(lines[5]).toEqual(['I told him.', 'Amy Elliott', 'narration']);
    });

    it('stay with the teller between two notes by one writer', async () => {
      for (const [teller, name] of tellers) {
        const { lines } = await analyze(
          [
            'I opened the first note.',
            'Meet me at noon. A.',
            '“What does she want?” I asked.',
            'Bring the key. A.',
            'I went down at noon.',
          ].join('\n\n'),
          cast,
          labelled({
            'I opened the first note.': [teller, 'narration'],
            'Meet me at noon. A.': ['c2', 'written'],
            'Bring the key. A.': ['c2', 'written'],
            'I went down at noon.': [teller, 'narration'],
          }),
        );
        expect(lines.slice(2, 4)).toEqual([
          ['“What does she want?”', name, 'speech'],
          ['I asked.', name, 'narration'],
        ]);
      }
    });

    it('stay with the narrator between longer notes by one writer', async () => {
      const gap = 'I folded it away and waited by the window.';
      // Two paragraphs, then one; one, then two; two of each.
      const notes: [string[], string[]][] = [
        [['Nick,', 'Meet me at noon. A.'], ['Bring the key. A.']],
        [['Meet me at noon. A.'], ['Nick,', 'Bring the key. A.']],
        [
          ['Nick,', 'Meet me at noon. A.'],
          ['Nick,', 'Bring the key. A.'],
        ],
      ];
      for (const [first, second] of notes) {
        const { lines } = await analyze(
          ['I opened the first note.', ...first, gap, ...second, 'I went down at noon.'].join(
            '\n\n',
          ),
          cast,
          labelled({
            'I opened the first note.': ['N', 'narration'],
            'Nick,': ['c2', 'written'],
            'Meet me at noon. A.': ['c2', 'written'],
            'Bring the key. A.': ['c2', 'written'],
            'I went down at noon.': ['N', 'narration'],
          }),
        );
        expect(lines[first.length + 1]).toEqual([gap, 'Narrator', 'narration']);
      }
    });

    it('stay with whoever the model gave an “I” line between them', async () => {
      for (const [teller, name] of tellers) {
        const { lines } = await analyze(
          [
            'I opened the first note.',
            'Nick,',
            'Meet me at noon. A.',
            '“What does she want?” I asked.',
            'Bring the key. A.',
            'I went down at noon.',
          ].join('\n\n'),
          cast,
          // The model labels the line, but not its tag.
          labelled({
            'I opened the first note.': [teller, 'narration'],
            'Nick,': ['c2', 'written'],
            'Meet me at noon. A.': ['c2', 'written'],
            '“What does she want?”': [teller, 'speech'],
            'Bring the key. A.': ['c2', 'written'],
            'I went down at noon.': [teller, 'narration'],
          }),
        );
        expect(lines.slice(3, 5)).toEqual([
          ['“What does she want?”', name, 'speech'],
          ['I asked.', name, 'narration'],
        ]);
      }
    });

    it('stay with the teller between a letter and its writer’s own narration', async () => {
      for (const [teller, name] of tellers) {
        const { lines } = await analyze(
          [
            'I took the letter from Holmes.',
            'Dear Holmes,',
            'Come at once. Lestrade.',
            'He arrived an hour later and sat down by the fire.',
            'I reached the docks at midnight and found the body.',
          ].join('\n\n'),
          cast,
          labelled({
            'I took the letter from Holmes.': [teller, 'narration'],
            'Dear Holmes,': ['c3', 'written'],
            'Come at once. Lestrade.': ['c3', 'written'],
            'I reached the docks at midnight and found the body.': ['c3', 'narration'],
          }),
        );
        expect(lines[3]).toEqual([
          'He arrived an hour later and sat down by the fire.',
          name,
          'narration',
        ]);
      }
    });

    it('stay with the teller where narration the model left to U ends the notes', async () => {
      const notes = (gap: string[]) => [
        'I found a note on the door.',
        'KEEP OUT.',
        'NO ENTRY.',
        ...gap,
        'STAY OUT.',
        'I tore it down.',
      ];
      for (const [teller, name] of tellers) {
        const labels = (left: string) =>
          labelled({
            'I found a note on the door.': [teller, 'narration'],
            'KEEP OUT.': ['c2', 'written'],
            'NO ENTRY.': ['c2', 'written'],
            [left]: ['U', 'narration'],
            'STAY OUT.': ['c2', 'written'],
            'I tore it down.': [teller, 'narration'],
          });
        // A scene break the model left to U, then the unit it skipped.
        const scene = await analyze(
          notes(['* * *', 'The next morning it rained.']).join('\n\n'),
          cast,
          labels('* * *'),
        );
        expect(scene.lines[4]).toEqual(['The next morning it rained.', name, 'narration']);
        // The unit it skipped, then narration it left to U.
        const told = await analyze(
          notes(['It was dark inside.', 'I went in anyway.']).join('\n\n'),
          cast,
          labels('I went in anyway.'),
        );
        expect(told.lines[3]).toEqual(['It was dark inside.', name, 'narration']);
      }
    });

    it('go back to the teller after a short letter', async () => {
      const { lines } = await analyze(
        [
          'I took the letter from Holmes and read it.',
          'Come at once. Lestrade.',
          '“It is very short,” I said.',
          'Holmes nodded and reached for his coat.',
        ].join('\n\n'),
        cast,
        labelled({
          'I took the letter from Holmes and read it.': ['N', 'narration'],
          'Come at once. Lestrade.': ['c3', 'written'],
          'Holmes nodded and reached for his coat.': ['N', 'narration'],
        }),
      );
      expect(lines.slice(2, 4)).toEqual([
        ['“It is very short,”', 'Narrator', 'speech'],
        ['I said.', 'Narrator', 'narration'],
      ]);
    });

    it('never take U as their teller', async () => {
      for (const [teller, name] of tellers) {
        // One note the model left to U before the line, then two.
        for (const notes of [['KEEP OUT.'], ['KEEP OUT.', 'DANGER.']]) {
          const { lines } = await analyze(
            ['I found a note.', ...notes, 'I went in anyway.', 'NO ENTRY.', 'I stopped.'].join(
              '\n\n',
            ),
            cast,
            labelled({
              'I found a note.': [teller, 'narration'],
              'KEEP OUT.': ['U', 'written'],
              'DANGER.': ['U', 'written'],
              'NO ENTRY.': ['U', 'written'],
              'I stopped.': [teller, 'narration'],
            }),
          );
          expect(lines[notes.length + 1]).toEqual(['I went in anyway.', name, 'narration']);
        }
      }
    });
  });

  /** Runs analyzeLlm alone on a long part, timed. */
  async function timed(text: string, respond: (call: FakeCall) => object) {
    const cast = baseCast('en');
    const units = splitUnits(text, 'en');
    const heuristic = analyzeHeuristic({ text, lang: 'en', units, cast });
    const started = performance.now();
    const result = await analyzeLlm({
      text,
      lang: 'en',
      units,
      cast,
      heuristic,
      ...llm(fakeTransport(respond)),
    });
    return { ...result, elapsed: performance.now() - started };
  }

  it('find their tellers without walking the part for each unit', async () => {
    // 3,000 lines of speech whose “I said.” tags the model leaves out, and no narration to end a
    // walk: walking the part from each tag took about 3 s here, and the whole run now about 40 ms.
    const { labels, fallbackUnits, elapsed } = await timed(
      Array.from({ length: 3000 }, (_, i) => `“Line ${i},” I said.`).join('\n\n'),
      ({ units }) => ({
        units: units.flatMap((u, id) =>
          u.startsWith('“') ? [{ id, spans: [{ speaker: 'N', mode: 'speech' }] }] : [],
        ),
        newCharacters: [],
        aliasAdditions: [],
      }),
    );
    expect(fallbackUnits).toBe(3000);
    expect(labels.spans[1]).toMatchObject({
      speaker: { kind: 'cast', id: 'narrator' },
      mode: 'narration',
    });
    expect(elapsed).toBeLessThan(500);
  });

  it('find their heuristic spans without searching all of them for each unit', async () => {
    // 12,000 one-line paragraphs in chunks the model all refuses: searching every heuristic span
    // for each unit's own took about 1.5 s here.
    const { labels, fallbackUnits, elapsed } = await timed(
      Array.from({ length: 12000 }, (_, i) => `Day ${i}.`).join('\n\n'),
      () => ({ stopReason: 'refusal', text: '' }),
    );
    expect(fallbackUnits).toBe(12000);
    expect(labels.spans).toHaveLength(12000);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('chunkUnits', () => {
  const text = Array.from({ length: 10 }, (_, i) => `“Speech ${i},” said A. Narration ${i}.`).join(
    '\n\n',
  );
  const units = splitUnits(text, 'en');

  it('keeps every unit once, in order, and ends chunks at paragraph breaks', () => {
    const chunks = chunkUnits(text, units, { maxUnits: 7, maxTokens: 10_000 });
    expect(chunks.flat()).toEqual(units);
    expect(chunks.every((c) => c.length <= 7)).toBe(true);
    for (const [i, c] of chunks.entries()) {
      if (i < chunks.length - 1) expect(c.at(-1)!.paragraph).not.toBe(chunks[i + 1]![0]!.paragraph);
    }
  });

  it('splits a paragraph that is larger than a chunk', () => {
    const big = 'a. '.repeat(300).trim();
    const paragraph = `“${big},” said A. “${big}.”`;
    const bigUnits = splitUnits(paragraph, 'en');
    const chunks = chunkUnits(paragraph, bigUnits, {
      maxUnits: 300,
      maxTokens: estimateTokens(big) + 10,
    });
    expect(chunks.map((c) => c.length)).toEqual([2, 1]);
    expect(chunks.flat()).toEqual(bigUnits);
  });
});

describe('buildUserPrompt', () => {
  it('lists the cast, context and trimmed units as JSON strings', () => {
    const prompt = buildUserPrompt({
      lang: 'es',
      cast: [
        { code: 'N', name: 'Narrador', role: 'narrator', aliases: [] },
        { code: 'U', name: '?', role: 'unknown', aliases: [] },
        { code: 'c1', name: 'Pablo', role: 'character', aliases: ['el ciego'], gender: 'male' },
      ],
      context: [{ code: 'c1', mode: 'speech', text: '—Hola.\n\n' }],
      units: ['—¿Quién es?\n\n', ' dijo "él".'],
    });
    expect(prompt).toBe(
      [
        'Story language: Spanish',
        '',
        'Cast:',
        'N: the narrator',
        'U: unknown speaker',
        'c1: Pablo (male; also called el ciego)',
        '',
        'Context (already labelled):',
        '[c1, speech] —Hola.',
        '',
        'Units to label:',
        '0: "—¿Quién es?"',
        '1: "dijo \\"él\\"."',
      ].join('\n'),
    );
  });

  it("shows the narrator's names and style, but not its default name", () => {
    const prompt = buildUserPrompt({
      lang: 'en',
      cast: [
        {
          code: 'N',
          name: 'Narrator',
          role: 'narrator',
          aliases: ['Watson', 'John Watson'],
          style: 'first person',
        },
      ],
      context: [],
      units: ['Hi.'],
    });
    expect(prompt).toContain('N: the narrator (first person; called Watson, John Watson)\n');
  });
});

describe('analyzeLlm without storage', () => {
  it('uses the base cast codes N and U', async () => {
    const units = splitUnits(TEXT, 'en');
    const cast = baseCast('en');
    const heuristic = analyzeHeuristic({ text: TEXT, lang: 'en', units, cast });
    const transport = fakeTransport(({ units: u }) => labelAll(u, 'U'));
    const result = await analyzeLlm({
      text: TEXT,
      lang: 'en',
      units,
      cast,
      heuristic,
      ...llm(transport),
    });
    expect(result.labels.spans.every((s) => s.speaker.kind === 'cast')).toBe(true);
    expect(new Set(result.labels.spans.map((s) => (s.speaker as { id: string }).id))).toEqual(
      new Set(['narrator', 'unknown']),
    );
  });
});
