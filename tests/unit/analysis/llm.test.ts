import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Character } from '@/format/types';
import { analyzePart } from '@/analysis/analyzer';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { analyzeLlm } from '@/analysis/llm';
import { chunkUnits, estimateTokens } from '@/analysis/llm/chunking';
import { LlmError } from '@/analysis/llm/client';
import { buildUserPrompt } from '@/analysis/llm/prompt';
import { splitUnits } from '@/analysis/units';
import { validateAnalysis } from '@/format/validate';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { getAnalysis } from '@/storage/analyses';
import { addPart, getPart } from '@/storage/parts';
import { createStory, getStory, updateStory } from '@/storage/stories';
import { baseCast } from '../../helpers/fixtures';
import { fakeTransport, labelAll } from '../../helpers/fakeLlm';

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

describe('LLM analysis', () => {
  it('turns a valid answer into segments and adds the new characters to the cast', async () => {
    const { part } = await setup();
    const transport = fakeTransport(({ units }) => goodReply(units));
    const report = await analyzePart(db, part.id, { voices, llm: llm(transport) });

    const { story, analysis, lines } = await stored(part.id);
    expect(report).toMatchObject({ kind: 'llm', fallbackUnits: 0 });
    expect(analysis.analyzer).toEqual({ kind: 'llm', model: 'claude-haiku-5-5', version: 1 });
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
