import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Character } from '@/format/types';
import { analyzePart } from '@/analysis/analyzer';
import type { LlmTransport } from '@/analysis/llm/client';
import { reassignSegment } from '@/analysis/reassign';
import { validateAnalysis } from '@/format/validate';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { createStory, getStory, updateStory } from '@/storage/stories';
import { addPart, getPart } from '@/storage/parts';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { mergeCharactersInStory } from '@/storage/cast';
import { renameCharacter } from '@/cast/castOps';
import { splitUnits } from '@/analysis/units';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { mergeLabels } from '@/analysis/merge';
import { baseCast, loadFixture } from '../../helpers/fixtures';
import { fakeTransport, heldTransport, labelAll } from '../../helpers/fakeLlm';

let db: StoryDb;
let count = 0;
const voices = [
  { name: 'en-a', lang: 'en-US', isDefault: true },
  { name: 'en-b', lang: 'en-GB' },
];

beforeEach(() => {
  db = openStoryDb(`analyzer-${++count}`);
});
afterEach(async () => {
  await db.delete();
});

const paste = (text: string) => ({ title: 'p', source: { kind: 'paste' as const }, text });
const llm = (transport: LlmTransport) => ({
  transport,
  model: 'claude-haiku-5-5',
  effort: 'low' as const,
});
const character = (id: string, name: string): Character => ({
  id,
  role: 'character',
  name,
  aliases: [],
  voice: { lang: 'en-US', pitch: 1.1, rate: 1 },
});

describe('analyzePart', () => {
  it('stores a valid analysis and adds voiced characters to the cast', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await addPart(db, story.id, paste('“Hi,” said Anne.\n\n“Hello,” said Tom.'));
    await analyzePart(db, part.id, { voices });

    const saved = (await getStory(db, story.id))!;
    const analysis = (await getAnalysis(db, part.id))!;
    expect(saved.cast.map((c) => c.name)).toEqual(['Narrator', 'Unknown speaker', 'Anne', 'Tom']);
    expect(saved.cast.slice(2).every((c) => c.voice.voiceName === 'en-b')).toBe(true);
    expect(saved.cast[2]!.voice).not.toEqual(saved.cast[3]!.voice);
    expect((await getPart(db, part.id))!.analysisStatus).toBe('done');
    expect(analysis.analyzer.kind).toBe('heuristic');
    const castIds = new Set(saved.cast.map((c) => c.id));
    expect(validateAnalysis((await getPart(db, part.id))!, analysis, castIds)).toEqual({
      ok: true,
    });
    // The heuristic marks " said Anne." as told by the teller; that mark is never stored.
    expect(analysis.segments.filter((s) => 'teller' in s)).toEqual([]);
  });

  it('reuses characters from part 1 when analysing part 2', async () => {
    const { text } = loadFixture('es/marianela-ch1');
    const cut = text.indexOf('--¿Va usted al establecimiento?');
    const story = await createStory(db, { title: 'Marianela', lang: 'es' });
    const one = await addPart(db, story.id, paste(text.slice(0, cut)));
    const two = await addPart(db, story.id, paste(text.slice(cut)));

    await analyzePart(db, one.id, { voices: [] });
    const afterOne = (await getStory(db, story.id))!.cast;
    await analyzePart(db, two.id, { voices: [] });
    const afterTwo = (await getStory(db, story.id))!.cast;

    // Characters from part 1 keep their ids and voices; part 2 speaks through them.
    expect(afterTwo.slice(0, afterOne.length)).toEqual(
      afterOne.map((c) => ({ ...c, aliases: expect.any(Array) })),
    );
    const golfin = afterOne.find((c) => c.name === 'Golfín')!;
    const speakers = new Set((await getAnalysis(db, two.id))!.segments.map((s) => s.speakerId));
    expect(speakers.has(golfin.id)).toBe(true);
  });

  it('keeps cast edits made while an analysis runs', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await addPart(db, story.id, paste('“Hi,” said Anne.'));
    const running = analyzePart(db, part.id, { voices });
    const renamed = story.cast.map((c) => (c.role === 'narrator' ? { ...c, name: 'Voice' } : c));
    await updateStory(db, story.id, { cast: renamed });
    await running;
    const names = (await getStory(db, story.id))!.cast.map((c) => c.name);
    expect(names).toEqual(['Voice', 'Unknown speaker', 'Anne']);
  });

  it('marks the part failed when analysis throws, and keeps the queue going', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const part = await addPart(db, story.id, paste('Hello.'));
    await updateStory(db, story.id, { cast: [] }); // no narrator: the analyser cannot run
    await expect(analyzePart(db, part.id, { voices })).rejects.toThrow();
    expect((await getPart(db, part.id))!.analysisStatus).toBe('failed');

    const other = await createStory(db, { title: 'T', lang: 'en' });
    const ok = await addPart(db, other.id, paste('Fine.'));
    await analyzePart(db, ok.id, { voices });
    expect((await getPart(db, ok.id))!.analysisStatus).toBe('done');
  });

  it.each([
    ['first person', '“Hi,” I said.\n\n“No,” I said.'],
    ['third person', '“Hi,” said Anne.\n\n“No,” said Anne.'],
  ])('tells Claude the narrator told the other parts in the %s', async (style, lines) => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const narration = Array.from({ length: 8 }, (_, i) => `The road ran on for mile ${i}.`);
    const one = await addPart(db, story.id, paste([...narration, lines].join('\n\n')));
    const two = await addPart(db, story.id, paste('It was late.'));
    await analyzePart(db, one.id, { voices });

    const transport = fakeTransport(({ units }) => labelAll(units, 'U'));
    await analyzePart(db, two.id, { voices, llm: llm(transport) });
    expect(transport.calls[0]!.request.user).toContain(`\nN: the narrator (${style})\n`);
  });

  it('gives Claude no style after a first-person part without dialogue', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const opening = [
      'I went back to the house by the marsh last spring.',
      'The gate had rusted open, and I walked up the drive alone.',
      'Nobody had cut the hedges since my aunt died.',
      'I stood in the hall for a long time before I opened the shutters.',
      'Dust lay on the piano, on the clock, on every frame along the stairs.',
      'I slept that night in the room that had been mine as a child.',
      'In the morning I began to write this down.',
    ];
    const one = await addPart(db, story.id, paste(opening.join('\n\n')));
    const two = await addPart(db, story.id, paste('“You came back,” said the gardener.'));
    await analyzePart(db, one.id, { voices });

    const transport = fakeTransport(({ units }) => labelAll(units, 'U'));
    await analyzePart(db, two.id, { voices, llm: llm(transport) });
    // "Third person" would tell Claude that the "I" of the context lines is somebody else.
    expect(transport.calls[0]!.request.user).toContain('\nN: the narrator\n');
  });

  it('leaves the part being analysed again out of the narrator style', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const narration = Array.from({ length: 8 }, (_, i) => `The road ran on for mile ${i}.`);
    const lines = '“Hi,” I said.\n\n“No,” I said.';
    const part = await addPart(db, story.id, paste([...narration, lines].join('\n\n')));
    await analyzePart(db, part.id, { voices });

    const transport = fakeTransport(({ units }) => labelAll(units, 'U'));
    await analyzePart(db, part.id, { voices, llm: llm(transport) });
    // Its own first-person labels would only repeat what the first analysis decided.
    expect(transport.calls[0]!.request.user).toContain('\nN: the narrator\n');
  });

  it('keeps the lines of a character merged into the narrator while Claude runs', async () => {
    const story = await createStory(db, { title: 'S', lang: 'es' });
    await updateStory(db, story.id, {
      cast: [...story.cast, character('ines', 'Inés'), character('ramon', 'don Ramón')],
    });
    const part = await addPart(
      db,
      story.id,
      paste('—No podía dormir.\n\n—Ni yo —respondió don Ramón.'),
    );
    const held = heldTransport(() => ({
      units: [
        { id: 0, spans: [{ speaker: 'c1', mode: 'speech' }] },
        { id: 1, spans: [{ speaker: 'c2', mode: 'speech' }] },
        { id: 2, spans: [{ speaker: 'N', mode: 'narration' }] },
      ],
      newCharacters: [],
      aliasAdditions: [{ characterId: 'c1', alias: 'Nesita' }],
    }));
    const running = analyzePart(db, part.id, { voices, llm: llm(held.transport) });
    await held.requested;
    await mergeCharactersInStory(db, story.id, 'ines', story.narratorId);
    held.release();
    await running;

    const saved = (await getStory(db, story.id))!;
    const analysis = (await getAnalysis(db, part.id))!;
    expect(saved.cast.map((c) => c.name)).toEqual(['Narrador', 'Desconocido', 'don Ramón']);
    // The name Claude found for Inés goes where she went.
    expect(saved.cast.find((c) => c.id === story.narratorId)!.aliases).toEqual(['Inés', 'Nesita']);
    expect(analysis.segments.map((s) => s.speakerId)).toEqual([
      story.narratorId,
      'ramon',
      story.narratorId,
    ]);
    expect((await getPart(db, part.id))!.analysisStatus).toBe('done');
  });

  it('keeps a correction to a character made in the Reader while the part is re-analysed', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const text = '“Hi,” said Anne.\n\n“Who is there?”\n\nNobody answered.';
    const part = await addPart(db, story.id, paste(text));
    await analyzePart(db, part.id, { voices });
    const isQuestion = (s: { start: number; end: number }) =>
      text.slice(s.start, s.end).startsWith('“Who');

    const held = heldTransport(({ units }) => labelAll(units, 'U'));
    const running = analyzePart(db, part.id, { voices, llm: llm(held.transport) });
    await held.requested;
    // The Reader's "New character": one save adds Grace and gives her the line.
    const before = (await getAnalysis(db, part.id))!;
    const index = before.segments.findIndex(isQuestion);
    const segments = reassignSegment(text, before.segments, index, 'grace', story.narratorId);
    await saveAnalysis(
      db,
      { ...before, segments },
      { added: [character('grace', 'Grace')], aliasAdditions: [] },
    );
    held.release();
    await running;

    const after = (await getAnalysis(db, part.id))!;
    expect(after.analyzer.kind).toBe('llm');
    expect(after.segments.find(isQuestion)).toMatchObject({ speakerId: 'grace', source: 'user' });
  });

  it('gives a character Claude finds to the one made in the Reader meanwhile', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const text = '“Who is there?”\n\n“Open the door!”\n\nNobody answered.';
    const part = await addPart(db, story.id, paste(text));
    await analyzePart(db, part.id, { voices });

    const held = heldTransport(({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [{ ref: 'new1', name: 'Grace', aliases: [], description: '' }],
      }),
    );
    const running = analyzePart(db, part.id, { voices, llm: llm(held.transport) });
    await held.requested;
    const before = (await getAnalysis(db, part.id))!;
    const segments = reassignSegment(text, before.segments, 0, 'grace', story.narratorId);
    await saveAnalysis(
      db,
      { ...before, segments },
      { added: [character('grace', 'Grace')], aliasAdditions: [] },
    );
    held.release();
    await running;

    const saved = (await getStory(db, story.id))!;
    const after = (await getAnalysis(db, part.id))!;
    expect(saved.cast.map((c) => c.name)).toEqual(['Narrator', 'Unknown speaker', 'Grace']);
    expect(after.segments.filter((s) => s.mode === 'speech').map((s) => s.speakerId)).toEqual([
      'grace',
      'grace',
    ]);
  });

  it('gives a character Claude finds to the member renamed to it meanwhile', async () => {
    const story = await createStory(db, { title: 'S', lang: 'en' });
    await updateStory(db, story.id, { cast: [...story.cast, character('s', 'the stranger')] });
    const part = await addPart(db, story.id, paste('“Who is there?” asked Grace.'));
    const held = heldTransport(({ units }) =>
      labelAll(units, 'new1', {
        newCharacters: [{ ref: 'new1', name: 'Grace', aliases: ['Mrs. Poole'], description: '' }],
      }),
    );
    const running = analyzePart(db, part.id, { voices, llm: llm(held.transport) });
    await held.requested;
    // The Cast view's rename keeps the old name as an alias.
    const renamed = renameCharacter((await getStory(db, story.id))!.cast, 's', 'Grace');
    await updateStory(db, story.id, { cast: renamed.ok ? renamed.value : [] });
    held.release();
    await running;

    const saved = (await getStory(db, story.id))!;
    const after = (await getAnalysis(db, part.id))!;
    expect(saved.cast.map((c) => [c.name, c.aliases])).toEqual([
      ['Narrator', []],
      ['Unknown speaker', []],
      ['Grace', ['the stranger', 'Mrs. Poole']],
    ]);
    expect(after.segments[0]!.speakerId).toBe('s');
  });
});

describe('heuristic pipeline performance', () => {
  it('analyses a 5,000-word chapter in under a second', () => {
    const { text: base } = loadFixture('en/pride-ch1');
    const words = base.split(/\s+/).length;
    const text = Array.from({ length: Math.ceil(5000 / words) }, () => base).join('\n\n');
    const cast = baseCast('en');
    const t0 = performance.now();
    const labels = analyzeHeuristic({ text, lang: 'en', units: splitUnits(text, 'en'), cast });
    mergeLabels(text, labels, cast, 'p', () => crypto.randomUUID());
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
