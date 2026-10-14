import { beforeEach, describe, expect, it } from 'vitest';
import type { Analysis, Character, Part, Segment, Story } from '@/format/types';
import { FakeSpeechEngine } from '@/playback/fakeEngine';
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

function setup(parts: Array<ReturnType<typeof makePart>>) {
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
  const engine = new FakeSpeechEngine();
  const player = new Player(
    engine,
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
  return { story, saved, engine, player, tick: (ms: number) => (clock += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const texts = (engine: FakeSpeechEngine) => engine.spoken.map((u) => u.text);

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

describe('Player', () => {
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
    const { engine, player } = setup(parts);
    await player.play();
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
    const { engine, player } = setup(parts);
    await player.play();
    engine.finishAll();
    await flush();
    await flush();
    expect(player.state).toMatchObject({
      state: 'blocked',
      message: '“p2” has not been analysed yet.',
    });
  });

  it('saves the position at most every 2 s while playing, and always on pause', async () => {
    const { engine, player, saved, tick } = setup(parts);
    await player.play();
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
    const { engine, player, story } = setup(parts);
    story.position = { partId: 'p1', segmentIndex: 3 };
    await player.play();
    expect(engine.current?.text).toBe('Nobody moved.');
  });

  it('skips by segment, paragraph and part', async () => {
    const { engine, player } = setup(parts);
    await player.play();
    await player.skipSegment(1);
    expect(engine.current?.text).toBe('“Go,”');
    await player.skipParagraph(1);
    expect(engine.current?.text).toBe('Nobody moved.');
    await player.skipParagraph(-1);
    expect(engine.current?.text).toBe('It was late.');
    await player.skipPart(1);
    await flush();
    expect(engine.current?.text).toBe('Morning came.');
  });

  it('applies a voice change from the next segment that starts', async () => {
    const { engine, player, story } = setup(parts);
    await player.play();
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
    const { engine, player, saved } = setup(parts);
    await player.jump({ partId: 'p1', segmentIndex: 2 });
    expect(engine.spoken).toEqual([]);
    expect(saved.at(-1)).toEqual({ partId: 'p1', segmentIndex: 2 });
  });

  it('restarts at the current segment when the speed changes', async () => {
    const { engine, player } = setup(parts);
    await player.play();
    engine.advance();
    await player.setSpeed(2);
    expect(engine.current?.text).toBe('“Go,”');
    expect(engine.current?.voice.rate).toBe(2);
  });
});
