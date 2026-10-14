import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Analysis, Character } from '@/format/types';
import {
  castUsage,
  mergeCharacters,
  parseAliases,
  renameCharacter,
  setAliases,
} from '@/cast/castOps';
import { analyzePart } from '@/analysis/analyzer';
import { validateAnalysis } from '@/format/validate';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { createStory, getStory } from '@/storage/stories';
import { addPart, getPart } from '@/storage/parts';
import { getAnalysis } from '@/storage/analyses';
import { mergeCharactersInStory } from '@/storage/cast';
import { baseCast, loadFixture } from '../../helpers/fixtures';

const voice = { lang: 'en-US', pitch: 1, rate: 1 };
const character = (id: string, name: string, aliases: string[] = []): Character => ({
  id,
  role: 'character',
  name,
  aliases,
  voice,
});
const analysis = (partId: string, speakers: string[]): Analysis => ({
  partId,
  textHash: 'h',
  analyzer: { kind: 'heuristic', version: 1 },
  createdAt: '',
  segments: speakers.map((speakerId, i) => ({
    start: i,
    end: i + 1,
    speakerId,
    mode: 'speech',
    source: 'heuristic',
  })),
});

describe('mergeCharacters', () => {
  const cast = [
    ...baseCast('en'),
    character('a', 'Elizabeth', ['Lizzy']),
    character('b', 'Miss Bennet', ['Eliza', 'lizzy']),
  ];

  it('moves every line and folds names into aliases', () => {
    const result = mergeCharacters(
      cast,
      [analysis('p1', ['b', 'a', 'narrator']), analysis('p2', ['b'])],
      'b',
      'a',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cast.map((c) => c.id)).toEqual(['narrator', 'unknown', 'a']);
    expect(result.value.cast[2]!.aliases).toEqual(['Lizzy', 'Miss Bennet', 'Eliza']);
    expect(result.value.analyses.map((a) => a.segments.map((s) => s.speakerId))).toEqual([
      ['a', 'a', 'narrator'],
      ['a'],
    ]);
  });

  it('keeps the unknown speaker and narrator in the cast when merging them away', () => {
    const result = mergeCharacters(cast, [analysis('p', ['unknown'])], 'unknown', 'a');
    expect(result.ok && result.value.cast.some((c) => c.id === 'unknown')).toBe(true);
    expect(result.ok && result.value.analyses[0]!.segments[0]!.speakerId).toBe('a');
  });

  it('rejects merging into itself or unknown ids', () => {
    expect(mergeCharacters(cast, [], 'a', 'a')).toMatchObject({ ok: false });
    expect(mergeCharacters(cast, [], 'x', 'a')).toMatchObject({ ok: false });
  });
});

describe('renameCharacter / aliases', () => {
  const cast = [...baseCast('en'), character('a', 'his wife')];

  it('keeps the old name as an alias', () => {
    const result = renameCharacter(cast, 'a', '  Mrs.   Bennet ');
    expect(result.ok && result.value[2]).toMatchObject({
      name: 'Mrs. Bennet',
      aliases: ['his wife'],
    });
  });

  it('does not alias the narrator’s old name', () => {
    const result = renameCharacter(cast, 'narrator', 'Ishmael');
    expect(result.ok && result.value[0]).toMatchObject({ name: 'Ishmael', aliases: [] });
  });

  it('rejects empty names', () => {
    expect(renameCharacter(cast, 'a', '  ')).toMatchObject({ ok: false });
  });

  it('parses alias lists without duplicates or the name itself', () => {
    expect(parseAliases('Liz, lizzy , Lizzy,, Elizabeth', 'Elizabeth')).toEqual(['Liz', 'lizzy']);
    const result = setAliases(cast, 'a', ['Mrs. B']);
    expect(result.ok && result.value[2]!.aliases).toEqual(['Mrs. B']);
  });
});

describe('castUsage', () => {
  it('counts lines per speaker', () => {
    const usage = castUsage([analysis('p', ['a', 'a', 'b']), undefined]);
    expect(Object.fromEntries(usage)).toEqual({ a: 2, b: 1 });
  });
});

describe('mergeCharactersInStory', () => {
  let db: StoryDb | undefined;
  afterEach(async () => {
    await db?.delete();
  });

  async function marianela() {
    db = openStoryDb(`cast-${Math.random()}`);
    const { text } = loadFixture('es/marianela-ch1');
    const story = await createStory(db, { title: 'Marianela', lang: 'es' });
    const cut = text.indexOf('--¿Va usted al establecimiento?');
    const paste = (t: string) => ({ title: 'p', source: { kind: 'paste' as const }, text: t });
    const one = await addPart(db, story.id, paste(text.slice(0, cut)));
    const two = await addPart(db, story.id, paste(text.slice(cut)));
    await analyzePart(db, one.id, { voices: [] });
    await analyzePart(db, two.id, { voices: [] });
    const cast = (await getStory(db, story.id))!.cast;
    const id = (name: string) => cast.find((c) => c.name === name)!.id;
    return { db, story, parts: [one, two], id };
  }

  it('rewrites every part and keeps all analyses valid', async () => {
    const { db, story, parts, id } = await marianela();
    const doctor = id('el doctor');
    const golfin = id('Golfín');
    await mergeCharactersInStory(db, story.id, doctor, golfin);

    const after = (await getStory(db, story.id))!;
    expect(after.cast.some((c) => c.id === doctor)).toBe(false);
    expect(after.cast.find((c) => c.id === golfin)!.aliases).toContain('el doctor');
    const ids = new Set(after.cast.map((c) => c.id));
    for (const p of parts) {
      const a = (await getAnalysis(db, p.id))!;
      expect(a.segments.some((s) => s.speakerId === doctor)).toBe(false);
      expect(validateAnalysis((await getPart(db, p.id))!, a, ids)).toEqual({ ok: true });
    }
  });

  it('rolls back completely when writing an analysis fails', async () => {
    const { db, story, id } = await marianela();
    const before = await getStory(db, story.id);
    const analysesBefore = await db.analyses.toArray();
    db.analyses.hook('creating', () => {
      throw new Error('disk full');
    });
    db.analyses.hook('updating', () => {
      throw new Error('disk full');
    });
    await expect(
      mergeCharactersInStory(db, story.id, id('el doctor'), id('Golfín')),
    ).rejects.toThrow();
    expect(await getStory(db, story.id)).toEqual(before);
    expect(await db.analyses.toArray()).toEqual(analysesBefore);
  });
});
