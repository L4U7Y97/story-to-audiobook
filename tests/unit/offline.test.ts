import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTxtFile } from '@/ingest/txt';
import { FakeSpeechEngine } from '@/playback/fakeEngine';
import { Player } from '@/playback/player';
import { openStoryDb, type StoryDb } from '@/storage/db';
import { getAnalysis } from '@/storage/analyses';
import { exportStory, importStory, parseExport } from '@/storage/exportImport';
import { addPart, getPart, listParts } from '@/storage/parts';
import { createStory, getStory, updateStory } from '@/storage/stories';
import { useAnalysis } from '@/ui/composables/useAnalysis';

/**
 * Spec success criterion 10: with no API key the app works fully offline. Every network API is
 * replaced by one that records the attempt and throws, then the whole flow runs:
 * import a file → analyse → play.
 */
const attempts: string[] = [];
const refuse = (api: string) =>
  vi.fn((...args: unknown[]) => {
    attempts.push(`${api} ${String(args[0])}`);
    throw new Error(`network access attempted: ${api}`);
  });

let db: StoryDb;
beforeEach(() => {
  localStorage.clear(); // no API key
  attempts.length = 0;
  vi.stubGlobal('fetch', refuse('fetch'));
  vi.stubGlobal('XMLHttpRequest', refuse('XMLHttpRequest'));
  vi.stubGlobal('WebSocket', refuse('WebSocket'));
  vi.stubGlobal('EventSource', refuse('EventSource'));
  vi.spyOn(navigator, 'sendBeacon').mockImplementation(refuse('sendBeacon') as never);
  db = openStoryDb(`offline-${Math.random()}`);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.delete();
});

function playerFor(storyId: string, engine: FakeSpeechEngine) {
  return new Player(engine, {
    story: () => getStory(db, storyId),
    part: async (partId) => {
      const part = await getPart(db, partId);
      return part ? { part, analysis: await getAnalysis(db, partId) } : undefined;
    },
    savePosition: (position) => updateStory(db, storyId, { position }),
  });
}

describe('offline without an API key', () => {
  it('imports a .txt file, analyses it and plays it without any network request', async () => {
    const story = await createStory(db, { title: 'Offline', lang: 'en' });
    const file = new File(['“Hi,” said Anne.\r\n\r\n“Hello,” said Tom.'], 'one.txt');
    const { text } = await readTxtFile(file);
    const part = await addPart(db, story.id, { title: 'One', source: { kind: 'txt' }, text });

    const analysis = useAnalysis(db);
    await analysis.loadSettings();
    expect(analysis.hasKey()).toBe(false);
    // Even when Claude is asked for, no key means the free method.
    await analysis.run(part, 'llm');
    expect(analysis.errors.value).toEqual({});
    expect((await getAnalysis(db, part.id))!.analyzer.kind).toBe('heuristic');

    const engine = new FakeSpeechEngine();
    const player = playerFor(story.id, engine);
    const done = player.play();
    await vi.waitFor(() => expect(engine.current).toBeDefined());
    engine.finishAll();
    await done;
    expect(engine.spoken.map((u) => u.text)).toEqual([
      '“Hi,”',
      'said Anne.',
      '“Hello,”',
      'said Tom.',
    ]);

    expect(attempts).toEqual([]);
  });

  it('imports an exported story and plays it without any network request', async () => {
    const source = await createStory(db, { title: 'Exported', lang: 'es' });
    const part = await addPart(db, source.id, {
      title: 'Uno',
      source: { kind: 'paste' },
      text: '—Hola —dijo Ana.',
    });
    await useAnalysis(db).run(part, 'heuristic');
    const file = JSON.stringify(await exportStory(db, source.id));

    const other = openStoryDb(`offline-other-${Math.random()}`);
    try {
      const parsed = parseExport(file);
      if (!parsed.ok) throw new Error(parsed.reason);
      const { story } = await importStory(other, parsed.data);
      expect((await listParts(other, story.id)).map((p) => p.analysisStatus)).toEqual(['done']);
    } finally {
      await other.delete();
    }
    expect(attempts).toEqual([]);
  });
});
