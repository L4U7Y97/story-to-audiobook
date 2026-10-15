import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, Character, Part, Segment, Story } from '@/format/types';
import { FakeSpeechEngine } from '@/playback/fakeEngine';
import { NativeSpeechEngine } from '@/playback/nativeEngine';
import { newerEnginePosition } from '@/playback/resume';
import { FakeNarrator } from '../../helpers/fakeNarrator';
import { Player, type PlayerPosition } from '@/playback/player';
import { buildUtterances, chunkText, cleanForSpeech, paragraphStarts } from '@/playback/utterances';

const voice = (pitch: number) => ({ lang: 'en-US', pitch, rate: 1 });
const cast: Character[] = [
  { id: 'n', role: 'narrator', name: 'Narrator', aliases: [], voice: voice(1) },
  { id: 'a', role: 'character', name: 'Anne', aliases: [], voice: voice(1.2) },
];

/** Builds a part whose segments are given as [text, speakerId] pairs. */
function makePart(id: string, pieces: Array<[string, string]>, analysed = true) {
  let text = '';
  const segments: Segment[] = [];
  for (const [piece, speakerId] of pieces) {
    segments.push({
      start: text.length,
      end: text.length + piece.length,
      speakerId,
      mode: speakerId === 'n' ? 'narration' : 'speech',
      source: 'heuristic',
    });
    text += piece;
  }
  const part: Part = {
    id,
    storyId: 's',
    title: id,
    source: { kind: 'paste' },
    text,
    textHash: `hash-${id}`,
    analysisStatus: analysed ? 'done' : 'pending',
  };
  const analysis: Analysis | undefined = analysed
    ? {
        partId: id,
        textHash: part.textHash,
        analyzer: { kind: 'heuristic', version: 1 },
        createdAt: '',
        segments,
      }
    : undefined;
  return { part, analysis };
}

type EngineKind = 'fake engine' | 'native engine';

/**
 * The engine under test plus the test's controls over it. The native engine runs against a fake
 * of the Android plugin, so the same player tests check both sides of the SpeechEngine contract.
 */
function makeEngine(kind: EngineKind) {
  if (kind === 'fake engine') {
    const engine = new FakeSpeechEngine();
    return {
      engine,
      narrator: undefined,
      control: {
        advance: () => engine.advance(),
        finishAll: () => engine.finishAll(),
        get current() {
          return engine.current;
        },
        get spoken() {
          return engine.spoken;
        },
      },
    };
  }
  const narrator = new FakeNarrator();
  const engine = new NativeSpeechEngine(narrator);
  return {
    engine,
    narrator,
    control: {
      advance: () => narrator.advance(),
      finishAll: () => narrator.finishAll(),
      get current() {
        const u = narrator.current;
        return u && { text: u.text, voice: { pitch: u.pitch, rate: u.rate } };
      },
      get spoken() {
        return narrator.spoken;
      },
    },
  };
}

function setup(parts: Array<ReturnType<typeof makePart>>, kind: EngineKind = 'fake engine') {
  const story: Story = {
    id: 's',
    schemaVersion: 1,
    title: 'S',
    lang: 'en',
    partIds: parts.map((p) => p.part.id),
    cast: structuredClone(cast),
    narratorId: 'n',
    createdAt: '',
    updatedAt: '',
  };
  const saved: PlayerPosition[] = [];
  let clock = 0;
  const { engine: speech, narrator, control: engine } = makeEngine(kind);
  const player = new Player(
    speech,
    {
      story: async () => story,
      part: async (id) => parts.find((p) => p.part.id === id),
      savePosition: async (p) => {
        saved.push(p);
        story.position = p;
      },
    },
    { saveIntervalMs: 2000, now: () => clock },
  );
  return { story, saved, engine, narrator, player, tick: (ms: number) => (clock += ms) };
}

/** Lets the player finish its async steps (loading parts, starting the engine). */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const texts = (engine: { spoken: Array<{ text: string }> }) => engine.spoken.map((u) => u.text);

describe('utterances', () => {
  it('cleans text for speech without touching what is stored', () => {
    expect(cleanForSpeech('--No puedo--murmuró--. _Villafangosa_\nseñor.')).toBe(
      'No puedo, murmuró, . Villafangosa señor.',
    );
    expect(cleanForSpeech('—Hola ')).toBe('Hola');
  });

  it('chunks long text at sentence boundaries', () => {
    const text = 'One two three. Four five six. Seven eight nine.';
    expect(chunkText(text, 20)).toEqual(['One two three.', 'Four five six.', 'Seven eight nine.']);
    expect(chunkText('a, b, c, d', 5).every((c) => c.length <= 5)).toBe(true);
    expect(chunkText('short', 20)).toEqual(['short']);
  });

  it('skips unspeakable segments and applies voices and speed', () => {
    const { part, analysis } = makePart('p', [
      ['Hello. ', 'n'],
      ['— ', 'n'],
      ['“Hi.”', 'a'],
    ]);
    const queue = buildUtterances(part, analysis!, cast, 0, 1.5);
    expect(queue.map((u) => [u.id, u.text, u.voice.pitch, u.voice.rate])).toEqual([
      ['0.0', 'Hello.', 1, 1.5],
      ['2.0', '“Hi.”', 1.2, 1.5],
    ]);
  });

  it('finds paragraph starts', () => {
    const { part, analysis } = makePart('p', [
      ['A. ', 'n'],
      ['B.\n\n', 'n'],
      ['C.', 'n'],
    ]);
    expect(paragraphStarts(part.text, analysis!.segments)).toEqual([true, false, true]);
  });
});

describe.each(['fake engine', 'native engine'] as const)('Player with the %s', (kind) => {
  let parts: Array<ReturnType<typeof makePart>>;
  beforeEach(() => {
    parts = [
      makePart('p1', [
        ['It was late. ', 'n'],
        ['“Go,” ', 'a'],
        ['she said.\n\n', 'n'],
        ['Nobody moved.', 'n'],
      ]),
      makePart('p2', [['Morning came.', 'n']]),
    ];
  });

  it('plays segments in order and moves on to the next part', async () => {
    const { engine, player } = setup(parts, kind);
    await player.play();
    await flush();
    engine.finishAll();
    await flush();
    await flush();
    engine.finishAll();
    await flush();
    expect(texts(engine)).toEqual([
      'It was late.',
      '“Go,”',
      'she said.',
      'Nobody moved.',
      'Morning came.',
    ]);
    expect(player.state).toMatchObject({ state: 'idle', message: 'End of the story.' });
  });

  it('stops with a message at a part that is not analysed', async () => {
    parts[1] = makePart('p2', [['Later.', 'n']], false);
    const { engine, player } = setup(parts, kind);
    await player.play();
    await flush();
    engine.finishAll();
    await flush();
    await flush();
    expect(player.state).toMatchObject({
      state: 'blocked',
      message: '“p2” has not been analysed yet.',
    });
  });

  it('saves the position at most every 2 s while playing, and always on pause', async () => {
    const { engine, player, saved, tick } = setup(parts, kind);
    await player.play();
    await flush();
    await flush();
    engine.advance(); // segment 1 starts: saved
    expect(saved).toEqual([{ partId: 'p1', segmentIndex: 1 }]);
    engine.advance(); // segment 2 starts at the same moment: not saved
    expect(saved).toHaveLength(1);
    tick(2500);
    engine.advance(); // segment 3, 2.5 s later: saved
    expect(saved.at(-1)).toEqual({ partId: 'p1', segmentIndex: 3 });
    await player.pause();
    expect(saved).toHaveLength(3);
    expect(player.state.state).toBe('paused');
  });

  it('resumes from the saved position', async () => {
    const { engine, player, story } = setup(parts, kind);
    story.position = { partId: 'p1', segmentIndex: 3 };
    await player.play();
    await flush();
    expect(engine.current?.text).toBe('Nobody moved.');
  });

  it('skips by segment, paragraph and part', async () => {
    const { engine, player } = setup(parts, kind);
    await player.play();
    await flush();
    await player.skipSegment(1);
    await flush();
    expect(engine.current?.text).toBe('“Go,”');
    await player.skipParagraph(1);
    await flush();
    expect(engine.current?.text).toBe('Nobody moved.');
    await player.skipParagraph(-1);
    await flush();
    expect(engine.current?.text).toBe('It was late.');
    await player.skipPart(1);
    await flush();
    expect(engine.current?.text).toBe('Morning came.');
  });

  it('applies a voice change from the next segment that starts', async () => {
    const { engine, player, story } = setup(parts, kind);
    await player.play();
    await flush();
    engine.advance(); // Anne speaks with pitch 1.2
    expect(engine.current?.voice.pitch).toBe(1.2);
    story.cast[1]!.voice = voice(0.8);
    story.cast[0]!.voice = voice(0.9);
    player.castChanged();
    engine.advance(); // next segment starts → player re-voices from here
    await flush();
    expect(engine.current?.text).toBe('she said.');
    expect(engine.current?.voice.pitch).toBe(0.9);
    engine.advance();
    expect(engine.current?.text).toBe('Nobody moved.');
  });

  it('jumps without playing when stopped', async () => {
    const { engine, player, saved } = setup(parts, kind);
    await player.jump({ partId: 'p1', segmentIndex: 2 });
    expect(engine.spoken).toEqual([]);
    expect(saved.at(-1)).toEqual({ partId: 'p1', segmentIndex: 2 });
  });

  it('restarts at the current segment when the speed changes', async () => {
    const { engine, player } = setup(parts, kind);
    await player.play();
    await flush();
    engine.advance();
    await player.setSpeed(2);
    await flush();
    expect(engine.current?.text).toBe('“Go,”');
    expect(engine.current?.voice.rate).toBe(2);
  });
});

describe('Player with the native engine', () => {
  let parts: Array<ReturnType<typeof makePart>>;
  beforeEach(() => {
    parts = [
      makePart('p1', [
        ['It was late. ', 'n'],
        ['“Go,” ', 'a'],
      ]),
      makePart('p2', [['Morning came.', 'n']]),
      makePart('p3', [['Noon.', 'n']]),
    ];
  });

  it('sends the rest of the part and the next analysed part in one batch, with titles', async () => {
    const { narrator, player, engine } = setup(parts, 'native engine');
    const play = vi.spyOn(narrator!, 'play');
    await player.play({ partId: 'p1', segmentIndex: 1 });
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    const queue = play.mock.calls[0]![0].queue;
    expect(queue.map((u) => [u.text, u.title, u.subtitle])).toEqual([
      ['“Go,”', 'S', 'p1'],
      ['Morning came.', 'S', 'p2'],
    ]);
    // Crossing into p2 needs no JS: the native queue already holds it.
    engine.advance();
    expect(player.state.position).toEqual({ partId: 'p2', segmentIndex: 0 });
    expect(play).toHaveBeenCalledTimes(1);
    // After the batch, the player continues with the part after it.
    engine.finishAll();
    await flush();
    expect(engine.current?.text).toBe('Noon.');
  });

  it('follows pause, play and next pressed in the notification', async () => {
    const { narrator, player, saved } = setup(parts, 'native engine');
    await player.play();
    await flush();
    narrator!.pressToggle();
    expect(player.state.state).toBe('paused');
    expect(saved.at(-1)).toEqual({ partId: 'p1', segmentIndex: 0 });
    narrator!.pressToggle();
    expect(player.state.state).toBe('playing');
    narrator!.pressNext();
    expect(player.state.position).toEqual({ partId: 'p1', segmentIndex: 1 });
  });

  it('substitutes voices missing on the device before sending them', async () => {
    const narrator = new FakeNarrator([
      { name: 'es-es-x-eee-local', lang: 'es-ES', network: false, quality: 400 },
    ]);
    const engine = new NativeSpeechEngine(narrator);
    await engine.listVoices();
    const play = vi.spyOn(narrator, 'play');
    void engine.play(
      [
        {
          id: 'u',
          text: 'Hola',
          voice: { voiceName: 'Microsoft Laura', lang: 'es-ES', pitch: 0.9, rate: 1.1 },
        },
      ],
      () => {},
    );
    await flush();
    expect(play.mock.calls[0]![0].queue[0]).toMatchObject({
      voiceName: 'es-es-x-eee-local',
      lang: 'es-ES',
      pitch: 0.9,
      rate: 1.1,
    });
  });

  it('shares one native voice request between callers asking at the same time', async () => {
    const narrator = new FakeNarrator([{ name: 'v', lang: 'en-US', network: false, quality: 400 }]);
    const getVoices = vi.spyOn(narrator, 'getVoices');
    const engine = new NativeSpeechEngine(narrator); // prefetches
    const [a, b] = await Promise.all([engine.listVoices(), engine.listVoices()]);
    expect(getVoices).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    await engine.listVoices(); // a later call asks again (voices can be installed meanwhile)
    expect(getVoices).toHaveBeenCalledTimes(2);
  });

  it('resumes after the app was killed from the last line the service started', async () => {
    const narrator = new FakeNarrator();
    const engine = new NativeSpeechEngine(narrator);
    const story = {
      partIds: ['p1', 'p2'],
      updatedAt: '2026-10-15T10:00:00.000Z',
      position: { partId: 'p1', segmentIndex: 0 },
    };
    const at = Date.parse('2026-10-15T10:05:00.000Z');

    expect(await newerEnginePosition(engine, story)).toBeUndefined(); // nothing saved natively
    narrator.lastSpoken = { id: 'p2|3.0', at };
    expect(await newerEnginePosition(engine, story)).toEqual({ partId: 'p2', segmentIndex: 3 });
    // Older than the story's last save, from another story, or the same as saved: keep the story's.
    expect(
      await newerEnginePosition(engine, { ...story, updatedAt: '2026-10-15T10:06:00.000Z' }),
    ).toBeUndefined();
    narrator.lastSpoken = { id: 'other|1.0', at };
    expect(await newerEnginePosition(engine, story)).toBeUndefined();
    narrator.lastSpoken = { id: 'p1|0.0', at };
    expect(await newerEnginePosition(engine, story)).toBeUndefined();
  });
});
