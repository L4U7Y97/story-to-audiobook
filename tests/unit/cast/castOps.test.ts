import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Analysis, Character, Lang, Part, Segment } from '@/format/types';
import {
  castUsage,
  filterCast,
  findNameClash,
  findNameOwner,
  findTypedNameOwner,
  mergeCharacters,
  parseAliases,
  partsToldBy,
  renameCharacter,
  setAliases,
} from '@/cast/castOps';
import { analyzePart } from '@/analysis/analyzer';
import { reassignSegments } from '@/analysis/reassign';
import { NARRATOR_NAME, UNKNOWN_NAME } from '@/analysis/castMatch';
import { validateAnalysis } from '@/format/validate';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { createStory, getStory, updateStory } from '@/storage/stories';
import { addPart, getPart } from '@/storage/parts';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { mergeCharactersInStory } from '@/storage/cast';
import { buildUtterances } from '@/playback/utterances';
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
const paste = (text: string) => ({ title: 'p', source: { kind: 'paste' as const }, text });

/** The stored segment that covers the start of `quote` in the part's text. */
async function segmentAt(db: StoryDb, part: Part, quote: string) {
  const start = part.text.indexOf(quote);
  const analysis = await getAnalysis(db, part.id);
  return analysis?.segments.find((s) => s.start <= start && start < s.end);
}

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

  it('moves a named narrator’s names to the character and its lines as user corrections', () => {
    const [narrator, unknown] = baseCast('en');
    const named = [
      { ...narrator!, name: 'Watson', aliases: ['Dr. Watson'] },
      unknown!,
      character('x', 'X'),
    ];
    const result = mergeCharacters(
      named,
      [analysis('p', ['narrator', 'x', 'narrator'])],
      'narrator',
      'x',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cast.find((c) => c.id === 'x')!.aliases).toEqual(
      expect.arrayContaining(['Watson', 'Dr. Watson']),
    );
    expect(result.value.cast[0]).toMatchObject({ name: 'Narrator', aliases: [] });
    expect(result.value.analyses[0]!.segments.map((s) => [s.speakerId, s.source])).toEqual([
      ['x', 'user'],
      ['x', 'heuristic'],
      ['x', 'user'],
    ]);
  });

  it('moves the unknown speaker’s lines as user corrections and keeps its names', () => {
    // "a voice" was merged into the unknown speaker, so it stays unattributed in later parts.
    const named = cast.map((c) => (c.id === 'unknown' ? { ...c, aliases: ['a voice'] } : c));
    const result = mergeCharacters(named, [analysis('p', ['unknown', 'a'])], 'unknown', 'a');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.analyses[0]!.segments.map((s) => s.source)).toEqual(['user', 'heuristic']);
    expect(result.value.cast.find((c) => c.id === 'a')!.aliases).toEqual(['Lizzy']);
    expect(result.value.cast.find((c) => c.id === 'unknown')).toMatchObject({
      name: 'Unknown',
      aliases: ['a voice'],
    });
  });

  it('gives a character’s names to the narrator and keeps the moved lines as analysed', () => {
    const result = mergeCharacters(cast, [analysis('p', ['b', 'narrator'])], 'b', 'narrator');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cast[0]).toMatchObject({
      name: 'Narrator',
      aliases: ['Miss Bennet', 'Eliza', 'lizzy'],
    });
    expect(result.value.analyses[0]!.segments.map((s) => [s.speakerId, s.source])).toEqual([
      ['narrator', 'heuristic'],
      ['narrator', 'heuristic'],
    ]);
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

  it('keeps a named narrator’s old name as an alias', () => {
    const named = cast.map((c) => (c.id === 'narrator' ? { ...c, name: 'Watson' } : c));
    const result = renameCharacter(named, 'narrator', 'John Watson');
    expect(result.ok && result.value[0]).toMatchObject({
      name: 'John Watson',
      aliases: ['Watson'],
    });
  });

  it('does not alias a default name or the same name written differently', () => {
    const unnamed = cast.map((c) => (c.id === 'unknown' ? { ...c, name: UNKNOWN_NAME.es } : c));
    const unknown = renameCharacter(unnamed, 'unknown', 'Una voz');
    expect(unknown.ok && unknown.value[1]).toMatchObject({ name: 'Una voz', aliases: [] });
    const respelled = renameCharacter([...cast, character('o', "O'Brien")], 'o', 'O’Brien');
    expect(respelled.ok && respelled.value[3]).toMatchObject({ name: 'O’Brien', aliases: [] });
  });

  it('un-names a narrator renamed back to its default name, keeping only the listed names', () => {
    const nick = cast.map((c) => (c.id === 'narrator' ? { ...c, name: 'Nick' } : c));
    const unnamed = renameCharacter(nick, 'narrator', 'Narrator');
    expect(unnamed.ok && unnamed.value[0]).toMatchObject({ name: 'Narrator', aliases: [] });
    const ines = cast.map((c) => (c.id === 'narrator' ? { ...c, name: 'Inés' } : c));
    const es = renameCharacter(ines, 'narrator', NARRATOR_NAME.es);
    expect(es.ok && es.value[0]).toMatchObject({ name: 'Narrador', aliases: [] });
    const listed = cast.map((c) => (c.id === 'narrator' ? { ...c, aliases: ['Nick'] } : c));
    const again = renameCharacter(listed, 'narrator', 'Narrator');
    expect(again.ok && again.value[0]).toMatchObject({ name: 'Narrator', aliases: ['Nick'] });
  });

  it('keeps no old names for the unknown speaker, only the names merged into it', () => {
    const named = cast.map((c) => (c.id === 'unknown' ? { ...c, name: 'Una voz' } : c));
    const renamed = renameCharacter(named, 'unknown', 'Voces');
    expect(renamed.ok && renamed.value[1]).toMatchObject({ name: 'Voces', aliases: [] });
    const merged = cast.map((c) => (c.id === 'unknown' ? { ...c, aliases: ['una voz'] } : c));
    const kept = renameCharacter(merged, 'unknown', 'Voces');
    expect(kept.ok && kept.value[1]).toMatchObject({ name: 'Voces', aliases: ['una voz'] });
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

describe('findNameOwner', () => {
  const [narrator, unknown] = baseCast('en');
  const cast: Character[] = [
    { ...narrator!, aliases: ['Watson'] },
    { ...unknown!, name: UNKNOWN_NAME.en },
    character('jane', 'Jane', ['Miss Bennet']),
    character('obrien', 'Mr. O’Brien'),
  ];

  it('finds the member called that, except the one being edited', () => {
    expect(findNameOwner(cast, 'jane')?.id).toBe('jane');
    expect(findNameOwner(cast, 'jane', 'jane')).toBeUndefined();
    expect(findNameOwner(cast, ' miss  bennet ')?.id).toBe('jane');
    expect(findNameOwner(cast, "Mr O'Brien")?.id).toBe('obrien');
    expect(findNameOwner(cast, 'Watson')?.id).toBe('narrator');
  });

  it('treats default names as nobody’s', () => {
    expect(findNameOwner(cast, 'Narrator')).toBeUndefined();
    expect(findNameOwner(cast, 'Unknown speaker')).toBeUndefined();
    expect(findNameOwner(cast, '  ')).toBeUndefined();
  });
});

describe('findTypedNameOwner', () => {
  const [narrator, unknown] = baseCast('en');
  const tom = character('tom', 'Tom', ['Tommy']);
  const cast: Character[] = [narrator!, { ...unknown!, name: UNKNOWN_NAME.en }, tom];
  const es: Character[] = [
    { ...narrator!, name: NARRATOR_NAME.es },
    { ...unknown!, name: UNKNOWN_NAME.es },
    tom,
  ];

  it('reads the narrator’s default name as the narrator, named or not', () => {
    expect(findTypedNameOwner(cast, 'narrator', 'narrator')?.id).toBe('narrator');
    expect(findTypedNameOwner(es, 'Narrador', 'narrator')?.id).toBe('narrator');
    const watson = cast.map((c) => (c.id === 'narrator' ? { ...c, name: 'Watson' } : c));
    expect(findTypedNameOwner(watson, 'Narrator', 'narrator')?.id).toBe('narrator');
    expect(findTypedNameOwner(cast, 'tommy', 'narrator')?.id).toBe('tom');
  });

  it('leaves the unknown speaker’s default name free, and the narrator’s on its own card', () => {
    expect(findTypedNameOwner(es, 'Desconocido', 'narrator')).toBeUndefined();
    expect(findTypedNameOwner(cast, 'Narrator', 'narrator', 'narrator')).toBeUndefined();
  });
});

describe('findNameClash', () => {
  const [narrator, unknown] = baseCast('en');
  const cast: Character[] = [
    narrator!,
    { ...unknown!, name: UNKNOWN_NAME.en },
    character('elizabeth', 'Elizabeth', ['Lizzy']),
    character('jane', 'Jane'),
    character('kit', 'Kit'),
    character('watson', 'Watson'),
  ];
  /** The clashing name and who has it, for an edit of member `id`. */
  const clash = (id: string, name: string, aliases: string[] = [], within = cast) => {
    const found = findNameClash(within, id, { name, aliases }, 'narrator');
    return found && [found.name, found.owner.id];
  };
  const withAliases = (id: string, aliases: string[]) =>
    cast.map((c) => (c.id === id ? { ...c, aliases } : c));

  it('refuses another member’s name, as the new name or as one of the other names', () => {
    expect(clash('elizabeth', 'Jane')).toEqual(['Jane', 'jane']);
    expect(clash('jane', 'lizzy')).toEqual(['lizzy', 'elizabeth']);
    expect(clash('elizabeth', 'Elizabeth', ['Lizzy', 'Jane'])).toEqual(['Jane', 'jane']);
    expect(clash('narrator', 'Narrator', ['Watson'])).toEqual(['Watson', 'watson']);
    expect(clash('narrator', 'Narrator', [' kit '])).toEqual([' kit ', 'kit']);
    // Typed as a name, "Narrator" means the narrator.
    expect(clash('jane', 'Narrator')).toEqual(['Narrator', 'narrator']);
  });

  it('skips its current name and the other names it has, so a clash saved earlier never blocks an edit', () => {
    const jane = withAliases('elizabeth', ['jane']);
    expect(clash('elizabeth', 'Elizabeth', ['Jane', 'Lizzy'], jane)).toBeUndefined();
    const twoJanes = cast.map((c) => (c.id === 'elizabeth' ? { ...c, name: 'jane' } : c));
    expect(clash('elizabeth', 'Jane', ['Lizzy'], twoJanes)).toBeUndefined();
    const kit = withAliases('narrator', ['Kit']);
    expect(clash('narrator', 'Narrator', ['Kit', 'Kitty'], kit)).toBeUndefined();
    expect(clash('kit', 'Christopher', ['Kit'], kit)).toBeUndefined();
    expect(clash('watson', 'John Watson', ['Watson'])).toBeUndefined();
  });

  it('refuses one of its other names as its new name while another member has it', () => {
    // Other names saved before the check: made the name, two members would be called the same.
    const kit = withAliases('narrator', ['Kit']);
    expect(clash('narrator', 'Kit', [], kit)).toEqual(['Kit', 'kit']);
    const jane = withAliases('elizabeth', ['Lizzy', 'jane']);
    expect(clash('elizabeth', 'Jane', ['Lizzy'], jane)).toEqual(['Jane', 'jane']);
    // "Narrator" is free as an other name, but typed as a name it means the narrator.
    const narratorAlias = withAliases('jane', ['Narrator']);
    expect(clash('jane', 'Narrator', [], narratorAlias)).toEqual(['Narrator', 'narrator']);
    // An other name nobody else has can still become the name.
    expect(clash('elizabeth', 'Lizzy', ['Elizabeth'])).toBeUndefined();
  });

  it('leaves default names typed as other names free, and the narrator’s own default name', () => {
    expect(clash('jane', 'Jane', ['Narrator', 'Unknown speaker'])).toBeUndefined();
    const named = cast.map((c) => (c.id === 'narrator' ? { ...c, name: 'Nick' } : c));
    expect(clash('narrator', 'Narrator', [], named)).toBeUndefined();
  });

  it('refuses the names the user gave the unknown speaker, never its default names', () => {
    // A member merged into it, or a name it was renamed to: CastView sends the user to its card.
    const merged = mergeCharacters(cast, [], 'kit', 'unknown');
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(clash('jane', 'Jane', ['kit'], merged.value.cast)).toEqual(['kit', 'unknown']);
    expect(clash('narrator', 'Kit', [], merged.value.cast)).toEqual(['Kit', 'unknown']);
    const crowd = cast.map((c) => (c.id === 'unknown' ? { ...c, name: 'Crowd' } : c));
    expect(clash('jane', 'crowd', [], crowd)).toEqual(['crowd', 'unknown']);
    expect(clash('jane', 'Unknown speaker')).toBeUndefined();
    const es = cast.map((c) => (c.id === 'unknown' ? { ...c, name: UNKNOWN_NAME.es } : c));
    expect(clash('jane', 'Desconocido', ['Unknown speaker'], es)).toBeUndefined();
  });
});

describe('castUsage', () => {
  it('counts lines per speaker', () => {
    const usage = castUsage([analysis('p', ['a', 'a', 'b']), undefined]);
    expect(Object.fromEntries(usage)).toEqual({ a: 2, b: 1 });
  });
});

describe('saveAnalysis alias additions', () => {
  let db: StoryDb | undefined;
  afterEach(async () => {
    await db?.delete();
  });

  it('adds each new alias once and never a name the member already has', async () => {
    db = openStoryDb(`cast-${Math.random()}`);
    const story = await createStory(db, { title: 'S', lang: 'en' });
    const obrien = character('obrien', 'Mr. O’Brien', ['Tom']);
    await updateStory(db, story.id, { cast: [...story.cast, obrien] });
    const part = await addPart(db, story.id, paste('Hello.'));
    const narrated: Analysis = {
      partId: part.id,
      textHash: part.textHash,
      analyzer: { kind: 'heuristic', version: 1 },
      createdAt: '',
      segments: [
        {
          start: 0,
          end: part.text.length,
          speakerId: story.narratorId,
          mode: 'narration',
          source: 'heuristic',
        },
      ],
    };
    await saveAnalysis(db, narrated, {
      added: [],
      aliasAdditions: [
        { characterId: 'obrien', alias: "Mr O'Brien" },
        { characterId: 'obrien', alias: 'tom' },
        { characterId: 'obrien', alias: 'O’Brien' },
        { characterId: 'obrien', alias: "o'brien" },
      ],
    });
    const after = (await getStory(db, story.id))!.cast.find((c) => c.id === 'obrien')!;
    expect(after.aliases).toEqual(['Tom', 'O’Brien']);
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
    const one = await addPart(db, story.id, paste(text.slice(0, cut)));
    const two = await addPart(db, story.id, paste(text.slice(cut)));
    await analyzePart(db, one.id, { voices: [] });
    await analyzePart(db, two.id, { voices: [] });
    const cast = (await getStory(db, story.id))!.cast;
    const id = (name: string) => cast.find((c) => c.name === name)!.id;
    return { db, story, parts: [one, two], id };
  }

  async function emptyStory(lang: Lang) {
    db = openStoryDb(`cast-${Math.random()}`);
    return { db, story: await createStory(db, { title: 'S', lang }) };
  }

  it('rewrites every part and keeps all analyses valid', async () => {
    const { db, story, parts, id } = await marianela();
    const doctor = id('el doctor');
    const golfin = id('Golfín');
    // Where "el doctor" spoke before the merge, per part (segment start offsets).
    const doctorLines = new Map<string, number[]>();
    for (const p of parts) {
      const a = (await getAnalysis(db, p.id))!;
      doctorLines.set(
        p.id,
        a.segments.filter((s) => s.speakerId === doctor).map((s) => s.start),
      );
    }
    expect([...doctorLines.values()].flat().length).toBeGreaterThan(0);
    await mergeCharactersInStory(db, story.id, doctor, golfin);

    const after = (await getStory(db, story.id))!;
    expect(after.cast.some((c) => c.id === doctor)).toBe(false);
    expect(after.cast.find((c) => c.id === golfin)!.aliases).toContain('el doctor');
    const ids = new Set(after.cast.map((c) => c.id));
    for (const p of parts) {
      const a = (await getAnalysis(db, p.id))!;
      expect(a.segments.some((s) => s.speakerId === doctor)).toBe(false);
      expect(validateAnalysis((await getPart(db, p.id))!, a, ids)).toEqual({ ok: true });

      // Playback reads those lines with the surviving character's voice.
      const part = (await getPart(db, p.id))!;
      const queue = buildUtterances(part, a, after.cast, 0, 1);
      const golfinVoice = after.cast.find((c) => c.id === golfin)!.voice;
      for (const start of doctorLines.get(p.id)!) {
        const index = a.segments.findIndex((s) => s.start <= start && start < s.end);
        const spoken = queue.filter((u) => u.segmentIndex === index);
        expect(spoken.length).toBeGreaterThan(0);
        for (const u of spoken) expect(u.voice).toEqual(golfinVoice);
      }
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

  it('gives later lines to the narrator a duplicate was merged into', async () => {
    const { db, story } = await emptyStory('en');
    const one = await addPart(db, story.id, paste('“Come here, Kit,” said Abel.\n\n“Coming.”'));
    await analyzePart(db, one.id, { voices: [] });
    const kit = (await getStory(db, story.id))!.cast.find((c) => c.name === 'Kit');
    expect(kit).toBeDefined();

    await mergeCharactersInStory(db, story.id, kit!.id, story.narratorId);
    const merged = (await getStory(db, story.id))!.cast;
    expect(merged.find((c) => c.id === story.narratorId)!.aliases).toEqual(['Kit']);

    const two = await addPart(db, story.id, paste('“Late again, Kit,” said Abel.\n\n“Sorry.”'));
    await analyzePart(db, two.id, { voices: [] });
    expect((await segmentAt(db, two, '“Sorry.”'))?.speakerId).toBe(story.narratorId);
    const after = (await getStory(db, story.id))!.cast;
    expect(after.map((c) => c.id)).toEqual(merged.map((c) => c.id));
  });

  it('keeps lines merged off the unknown speaker when the part is analysed again', async () => {
    const { db, story } = await emptyStory('en');
    const unknown = story.cast.find((c) => c.role === 'unknown')!.id;
    const part = await addPart(
      db,
      story.id,
      paste(
        'The door creaked open.\n\n“Who goes there?”\n\nNobody answered.\n\n' +
          '“Only the wind,” said Mr. Rochester at last.',
      ),
    );
    await analyzePart(db, part.id, { voices: [] });
    expect((await segmentAt(db, part, '“Who goes there?”'))?.speakerId).toBe(unknown);
    const rochester = (await getStory(db, story.id))!.cast.find((c) => c.name === 'Mr. Rochester');
    expect(rochester).toBeDefined();

    await mergeCharactersInStory(db, story.id, unknown, rochester!.id);
    expect(await segmentAt(db, part, '“Who goes there?”')).toMatchObject({
      speakerId: rochester!.id,
      source: 'user',
    });
    await analyzePart(db, part.id, { voices: [] });
    expect((await segmentAt(db, part, '“Who goes there?”'))?.speakerId).toBe(rochester!.id);
  });

  it('gives the narrator back the default name of the story’s language', async () => {
    const { db, story } = await emptyStory('es');
    const named = story.cast.map((c) => (c.id === story.narratorId ? { ...c, name: 'Inés' } : c));
    await updateStory(db, story.id, { cast: [...named, character('julian', 'Julián')] });
    await mergeCharactersInStory(db, story.id, story.narratorId, 'julian');
    const after = (await getStory(db, story.id))!.cast;
    expect(after.find((c) => c.id === story.narratorId)).toMatchObject({
      name: 'Narrador',
      aliases: [],
    });
    expect(after.find((c) => c.id === 'julian')!.aliases).toEqual(['Inés']);
  });
});

describe('partsToldBy', () => {
  /** An analysis of consecutive narration spans, each [speakerId, length]. */
  const narrated = (partId: string, spans: Array<[string, number]>): Analysis => {
    let start = 0;
    const segments = spans.map(([speakerId, length]): Segment => {
      start += length;
      return { start: start - length, end: start, speakerId, mode: 'narration', source: 'llm' };
    });
    return { ...analysis(partId, []), segments };
  };

  it('counts the parts whose narration a member reads most of', () => {
    const analyses = [
      narrated('p1', [
        ['amy', 10],
        ['narrator', 5],
      ]),
      narrated('p2', [['narrator', 8]]),
      narrated('p3', [
        ['amy', 4],
        ['narrator', 4],
      ]),
      analysis('p4', ['amy', 'amy']),
      undefined,
    ];
    expect(partsToldBy(analyses, 'amy', 'narrator')).toBe(1);
    expect(partsToldBy(analyses, 'narrator', 'narrator')).toBe(3);
    expect(partsToldBy(analyses, 'nick', 'narrator')).toBe(0);
  });

  it('counts a part once “Told by” gives its narration to a character', () => {
    const text = 'AMY\n\n“Hi,” I said.';
    const before: Analysis = {
      ...analysis('p', []),
      segments: [
        { start: 0, end: 5, speakerId: 'narrator', mode: 'narration', source: 'heuristic' },
        { start: 5, end: 10, speakerId: 'narrator', mode: 'speech', source: 'heuristic' },
        { start: 10, end: 18, speakerId: 'narrator', mode: 'narration', source: 'heuristic' },
      ],
    };
    expect(partsToldBy([before], 'amy', 'narrator')).toBe(0);
    const segments = reassignSegments(text, before.segments, 0, 'amy', {
      narratorId: 'narrator',
      scope: 'part',
    });
    expect(partsToldBy([{ ...before, segments }], 'amy', 'narrator')).toBe(1);
    expect(partsToldBy([{ ...before, segments }], 'narrator', 'narrator')).toBe(0);
  });
});

describe('filterCast', () => {
  const cast: Character[] = [
    { ...character('n', 'Narrator'), role: 'narrator' },
    character('j', 'José Arcadio', ['the colonel']),
    character('o', 'Mrs. O’Brien'),
    character('d', 'Mr Darcy'),
  ];
  const names = (query: string) => filterCast(cast, query).map((c) => c.name);

  it('finds the member a typed name means when no name contains it', () => {
    expect(names('Mr. Darcy')).toEqual(['Mr Darcy']);
    expect(names('Mister Darcy')).toEqual(['Mr Darcy']);
    expect(names('Mr. Darcy’s')).toEqual(['Mr Darcy']);
    const renamed = cast.map((c) => (c.id === 'n' ? { ...c, name: 'Ishmael' } : c));
    expect(filterCast(renamed, 'narrator', 'n').map((c) => c.name)).toEqual(['Ishmael']);
  });

  it('keeps everyone, in order, for a blank query', () => {
    const everyone = ['Narrator', 'José Arcadio', 'Mrs. O’Brien', 'Mr Darcy'];
    expect(names('')).toEqual(everyone);
    expect(names('   ')).toEqual(everyone);
  });

  it('matches part of a name, ignoring case and accents', () => {
    expect(names('jose')).toEqual(['José Arcadio']);
    expect(names('ARCA')).toEqual(['José Arcadio']);
  });

  it('matches other names, and straight or curly apostrophes alike', () => {
    expect(names('colonel')).toEqual(['José Arcadio']);
    expect(names("o'bri")).toEqual(['Mrs. O’Brien']);
  });

  it('finds nobody for a name no one has', () => {
    expect(names('Aureliano')).toEqual([]);
  });
});
