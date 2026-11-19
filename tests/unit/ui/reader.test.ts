import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'vue-router';
import type { Segment } from '@/format/types';
import type { PlayerSnapshot } from '@/playback/player';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { addBook, renameBook } from '@/storage/books';
import { addPart } from '@/storage/parts';
import { getStory, updateStory } from '@/storage/stories';
import ReaderView from '@/ui/views/ReaderView.vue';
import {
  button,
  db,
  holdJumps,
  jumped,
  mountRouted,
  mountView,
  paused,
  played,
  playerSnapshot,
  resumed,
  savedCorrection,
  storeStory,
  stubVoices,
  submit,
  typeInto,
  unmountView,
  until,
  type Chunk,
  type StoredStory,
} from '../../helpers/ui';

vi.mock('@/ui/composables/usePlayer', () => import('../../helpers/ui').then((m) => m.playerStub()));
// Saves go through as usual; a test can hold one back to tap something while it is in flight.
vi.mock('@/storage/analyses', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/analyses')>();
  return { ...actual, saveAnalysis: vi.fn(actual.saveAnalysis) };
});

afterEach(() => {
  unmountView();
  vi.mocked(saveAnalysis).mockReset();
});

const lines = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.segment')];
const tint = (el: Element | null | undefined) =>
  (el as HTMLElement | null | undefined)?.style.getPropertyValue('--tint');

/** Opens the reader on a stored one-part story, in "Fix speakers" mode. */
async function fixSpeakers(
  chunks: Chunk[],
  characters: Array<{ name: string; aliases?: string[] }>,
) {
  const story = await storeStory(chunks, { characters });
  const host = await mountView(ReaderView, { id: story.storyId, partId: story.partId });
  await until(() => lines(host).length === chunks.length, 'the lines');
  button(host, 'Fix speakers')!.click();
  await until(() => host.querySelector('.text.editing'), 'Fix speakers');
  return { story, host };
}

/** Taps line `index`; returns the speaker picker it opens. */
async function tap(host: HTMLElement, index: number) {
  lines(host)[index]!.click();
  return until(() => host.querySelector<HTMLElement>('.sheet'), 'the picker');
}

/** The stored stretch whose text includes `words`. */
function stretch(story: StoredStory, segments: Segment[], words: string) {
  return segments.find((s) => story.text.slice(s.start, s.end).includes(words));
}

/** Stores the part's analysis again, its segments redone by `redo`, as a re-analysis does. */
async function saveAgain(story: StoredStory, redo: (segments: Segment[]) => Segment[]) {
  const analysis = (await getAnalysis(db, story.partId))!;
  await saveAnalysis(db, { ...analysis, segments: redo(analysis.segments) });
}

/** Adds a part to `story` after the others: the narrator's `lines`, analysed. */
async function addNarratedPart(story: StoredStory, lines: string[], title = 'Two') {
  const part = await addPart(db, story.storyId, {
    title,
    source: { kind: 'paste' },
    text: lines.join(''),
  });
  let end = 0;
  await saveAnalysis(db, {
    partId: part.id,
    textHash: part.textHash,
    analyzer: { kind: 'heuristic', version: 2 },
    createdAt: new Date().toISOString(),
    segments: lines.map((line): Segment => {
      end += line.length;
      return {
        start: end - line.length,
        end,
        speakerId: story.ids.N!,
        mode: 'narration',
        source: 'heuristic',
      };
    }),
  });
  return part;
}

// A frame narrator; Nelly's tale in the middle.
const frame: Chunk[] = [
  ['I came to the Grange in the rain.\n\n', 'N', 'narration'],
  ['“Tell me about them,”', 'N', 'speech'],
  [' I said.\n\n', 'N', 'narration'],
  ['It was a long time ago, and the master was young.\n\n', 'N', 'narration'],
  ['“Hush,”', 'Hindley', 'speech'],
  [' said Hindley.\n\n', 'N', 'narration'],
  ['That was all he ever said to me.\n\n', 'N', 'narration'],
  ['She stopped there, and I went to bed.', 'N', 'narration'],
];

describe('the speaker picker', () => {
  it('removes a character from the cast after all their lines are reassigned', async () => {
    const { story, host } = await fixSpeakers(
      [['“Hello,” said Tom.', 'Tom', 'speech']],
      [{ name: 'Tom' }, { name: 'Jane' }],
    );

    button(await tap(host, 0), 'Jane')!.click();

    await until(
      async () => !(await getStory(db, story.storyId))!.cast.some((c) => c.id === story.ids.Tom),
      'Tom to leave the cast',
    );
    expect((await getStory(db, story.storyId))!.cast.map((c) => c.id)).toContain(story.ids.Jane);
  });

  // The analyser missed the unquoted question and gave it to the narrator as narration.
  const missed: Chunk[] = [
    ['Tom came in late.\n\n', 'N', 'narration'],
    ['Where have you been, Tom wanted to know.\n\n', 'N', 'narration'],
    ['“Out,”', 'N', 'speech'],
    [' I said.', 'N', 'narration'],
  ];

  it.each([
    ['Tom', 'Tom'],
    ['Unknown speaker', 'U'],
  ])('preselects no mode for plain narration, and %s says it', async (person, who) => {
    const { story, host } = await fixSpeakers(missed, [{ name: 'Tom' }]);
    const sheet = await tap(host, 1);
    expect(sheet.querySelector('.modes .active')).toBeNull();
    expect(sheet.querySelector('.note')?.textContent).toContain('anyone else says it');
    button(sheet, person)!.click();
    const saved = await savedCorrection(story.partId);
    expect(stretch(story, saved, 'Where have you been')).toMatchObject({
      speakerId: story.ids[who],
      mode: 'speech',
      source: 'user',
    });
  });

  it('keeps plain narration given to the narrator as narration', async () => {
    const { story, host } = await fixSpeakers(missed, [{ name: 'Tom' }]);
    const sheet = await tap(host, 0);
    button(sheet, 'Narrator')!.click();
    const saved = await savedCorrection(story.partId);
    expect(stretch(story, saved, 'Tom came in')).toMatchObject({
      speakerId: story.ids.N,
      mode: 'narration',
    });
  });

  it('preselects how a line reads when it reads the same for anyone', async () => {
    const { host } = await fixSpeakers(missed, [{ name: 'Tom' }]);
    const sheet = await tap(host, 2);
    expect(sheet.querySelector('.modes .active')?.textContent?.trim()).toBe('Says');
    expect(sheet.querySelector('.note')).toBeNull();
  });

  it.each([
    ['narrator', 'N'],
    ['tommy', 'Tom'],
  ])('gives a line to the member typed as “%s” rather than a new one', async (typed, who) => {
    const { story, host } = await fixSpeakers(
      [
        ['“Where were you?”', 'U', 'speech'],
        [' asked Tom.\n\n', 'N', 'narration'],
        ['“Out,”', 'U', 'speech'],
        [' I said.', 'N', 'narration'],
      ],
      [{ name: 'Tom', aliases: ['Tommy'] }],
    );
    const sheet = await tap(host, 2);
    typeInto(sheet.querySelector<HTMLInputElement>('form.new input')!, typed);
    submit(sheet.querySelector('form.new')!);
    const saved = await savedCorrection(story.partId);
    expect(stretch(story, saved, '“Out,”')).toMatchObject({ speakerId: story.ids[who] });
    expect((await getStory(db, story.storyId))!.cast.map((c) => c.id)).toEqual(
      who === 'N' ? [story.ids.N, story.ids.U] : [story.ids.N, story.ids.U, story.ids.Tom],
    );
  });

  it('gives a new character the traits its name tells, and a voice to match', async () => {
    // The narrator reads with the device's first voice, a woman's. A pick that ignored the
    // traits would take the next voice, another woman's.
    stubVoices.push(
      { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
      { name: 'Microsoft Jenny - English (United States)', lang: 'en-US' },
      { name: 'Microsoft David - English (United States)', lang: 'en-US' },
    );
    const { story, host } = await fixSpeakers(
      [
        ['“Where were you?”', 'U', 'speech'],
        [' asked Tom.\n\n', 'N', 'narration'],
        ['“Out,”', 'U', 'speech'],
        [' I said.', 'N', 'narration'],
      ],
      [{ name: 'Tom' }],
    );
    const add = async (index: number, name: string) => {
      const sheet = await tap(host, index);
      typeInto(sheet.querySelector<HTMLInputElement>('form.new input')!, name);
      submit(sheet.querySelector('form.new')!);
      return until(
        async () => (await getStory(db, story.storyId))!.cast.find((c) => c.name === name),
        `${name} in the cast`,
      );
    };
    expect(await add(0, 'the old man')).toMatchObject({
      gender: 'male',
      age: 'elder',
      voice: { voiceName: 'Microsoft David - English (United States)' },
    });
    // A name that tells nothing leaves no trait behind, not even an empty one.
    await until(() => !host.querySelector('.sheet'), 'the picker to close');
    expect(Object.keys(await add(2, 'Mary'))).toEqual(['id', 'role', 'name', 'aliases', 'voice']);
  });
});

describe('the speaker picker’s search', () => {
  const chunks: Chunk[] = [
    ['“Where were you?”', 'U', 'speech'],
    [' asked Tom.\n\n', 'N', 'narration'],
    ['“Out,”', 'U', 'speech'],
    [' I said.', 'N', 'narration'],
  ];
  const people = (sheet: HTMLElement) =>
    [...sheet.querySelectorAll('.people button')].map((b) => b.textContent?.trim());
  const search = (sheet: HTMLElement) =>
    sheet.querySelector<HTMLInputElement>('.cast-filter input')!;

  it('narrows the people to those a name or other name matches', async () => {
    const { host } = await fixSpeakers(chunks, [
      { name: 'Tom', aliases: ['Tommy'] },
      { name: 'Ann' },
    ]);
    const sheet = await tap(host, 2);
    typeInto(search(sheet), 'tommy');
    await until(() => people(sheet).length === 1, 'the filtered people');
    expect(people(sheet)).toEqual(['Tom']);
  });

  it('offers to add a name nobody has, and gives the line to them', async () => {
    const { story, host } = await fixSpeakers(chunks, [{ name: 'Tom' }]);
    const sheet = await tap(host, 2);
    typeInto(search(sheet), 'Mary');
    const add = await until(() => button(sheet, 'Add “Mary”'), 'the add button');
    add.click();
    const saved = await savedCorrection(story.partId);
    const cast = (await getStory(db, story.storyId))!.cast;
    const mary = cast.find((c) => c.name === 'Mary');
    expect(mary).toBeDefined();
    expect(stretch(story, saved, '“Out,”')).toMatchObject({ speakerId: mary!.id });
  });

  it('clears the search on Esc before Esc closes the picker', async () => {
    const { host } = await fixSpeakers(chunks, [{ name: 'Tom' }]);
    const sheet = await tap(host, 2);
    const input = search(sheet);
    typeInto(input, 'zz');
    await until(() => people(sheet).length === 0, 'the filtered people');
    const esc = () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    esc();
    await until(() => people(sheet).length > 0, 'everyone back');
    expect(input.value).toBe('');
    expect(host.querySelector('.sheet')).not.toBeNull();
    esc();
    await until(() => !host.querySelector('.sheet'), 'the picker to close');
  });
});

describe('“Same person as…” in the speaker picker', () => {
  const chunks: Chunk[] = [
    ['“Where were you?”', 'Bob', 'speech'],
    [' asked Bob.\n\n', 'N', 'narration'],
    ['“Out,”', 'Robert', 'speech'],
    [' said Robert.', 'N', 'narration'],
  ];
  const people = (sheet: HTMLElement) =>
    [...sheet.querySelectorAll('.people button')].map((b) => b.textContent?.trim());
  const sameAs = (sheet: HTMLElement, who: string) =>
    button(sheet, `${who} is the same person as…`);

  /** Adds a second part in which Bob reads a line. */
  async function secondPart(story: StoredStory) {
    const text = '“Again,” said Bob.';
    const part = await addPart(db, story.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text,
    });
    await saveAnalysis(db, {
      partId: part.id,
      textHash: part.textHash,
      analyzer: { kind: 'heuristic', version: 2 },
      createdAt: new Date().toISOString(),
      segments: [
        { start: 0, end: 8, speakerId: story.ids.Bob!, mode: 'speech', source: 'heuristic' },
        {
          start: 8,
          end: text.length,
          speakerId: story.ids.N!,
          mode: 'narration',
          source: 'heuristic',
        },
      ],
    });
    return part.id;
  }

  it('merges the line’s speaker into someone else in every part, once confirmed', async () => {
    const { story, host } = await fixSpeakers(chunks, [{ name: 'Bob', aliases: ['Bobby'] }]);
    const two = await secondPart(story);
    const sheet = await tap(host, 0);
    sameAs(sheet, 'Bob')!.click();
    await until(() => sheet.querySelector('h2')?.textContent?.includes('same person'), 'the step');
    // Nobody is the same person as themselves or as the unknown speaker.
    expect(people(sheet)).toEqual(['Narrator', 'Robert']);
    const confirm = button(sheet, 'Confirm merge')!;
    expect(confirm.disabled).toBe(true);
    button(sheet, 'Robert')!.click();
    const warning = await until(() => sheet.querySelector('.warning')?.textContent, 'the warning');
    expect(warning).toContain('in every part');
    // Picking someone saves nothing until confirmed.
    expect((await getStory(db, story.storyId))!.cast.some((c) => c.id === story.ids.Bob)).toBe(
      true,
    );
    confirm.click();

    const cast = await until(async () => {
      const c = (await getStory(db, story.storyId))!.cast;
      return c.some((m) => m.id === story.ids.Bob) ? undefined : c;
    }, 'Bob to leave the cast');
    expect(cast.find((c) => c.id === story.ids.Robert)?.aliases).toEqual(['Bob', 'Bobby']);
    for (const partId of [story.partId, two]) {
      const segments = (await getAnalysis(db, partId))!.segments;
      expect(segments.some((s) => s.speakerId === story.ids.Bob)).toBe(false);
    }
    expect((await getAnalysis(db, two))!.segments[0]!.speakerId).toBe(story.ids.Robert);
    await until(() => !host.querySelector('.sheet'), 'the picker to close');
  });

  it('goes back to choosing who reads the line without merging', async () => {
    const { story, host } = await fixSpeakers(chunks, []);
    const sheet = await tap(host, 0);
    sameAs(sheet, 'Bob')!.click();
    await until(() => button(sheet, 'Back'), 'the merge step');
    button(sheet, 'Robert')!.click();
    button(sheet, 'Back')!.click();
    await until(() => sheet.querySelector('h2')?.textContent === 'Who reads this?', 'the picker');
    expect(people(sheet)).toContain('Bob');
    expect((await getStory(db, story.storyId))!.cast.some((c) => c.id === story.ids.Bob)).toBe(
      true,
    );
  });

  it('is not offered for the narrator, the unknown speaker or “Who tells this part?”', async () => {
    const { host } = await fixSpeakers([['“Hi,”', 'U', 'speech'], ...chunks], []);
    expect(sameAs(await tap(host, 0), 'Unknown speaker')).toBeUndefined();
    button(host.querySelector('.sheet')!, 'Cancel')!.click();
    await until(() => !host.querySelector('.sheet'), 'the picker to close');
    expect(sameAs(await tap(host, 2), 'Narrator')).toBeUndefined();
    button(host.querySelector('.sheet')!, 'Cancel')!.click();
    await until(() => !host.querySelector('.sheet'), 'the picker to close');
    host.querySelector<HTMLButtonElement>('.told-by')!.click();
    const teller = await until(() => host.querySelector<HTMLElement>('.sheet'), 'the picker');
    expect(teller.querySelector('.same-person')).toBeNull();
  });
});

describe('colours', () => {
  it('gives the narrator’s spoken lines a colour of their own, and its narration none', async () => {
    const { host } = await fixSpeakers(
      [
        ['“Who’s there?”\n\n', 'U', 'speech'],
        ['Nobody answered.\n\n', 'N', 'narration'],
        ['“Me,”', 'N', 'speech'],
        [' I said.', 'N', 'narration'],
      ],
      [],
    );
    const [unknown, narration, spoken] = lines(host);
    expect(tint(unknown)).toBe('var(--speaker-0)');
    expect(tint(spoken)).toBe('var(--narrator)');
    expect(spoken!.classList.contains('voiced')).toBe(true);
    expect(tint(narration)).toBe('');
    // The "Told by" chip and the picker's swatches show the same colours.
    expect(tint(host.querySelector('.told-by'))).toBe('var(--narrator)');
    const sheet = await tap(host, 2);
    expect(tint(button(sheet, 'Narrator'))).toBe('var(--narrator)');
    expect(tint(button(sheet, 'Unknown speaker'))).toBe('var(--speaker-0)');
  });

  it('defines the narrator’s colour in every theme, apart from the accent and every speaker’s', () => {
    const css = readFileSync('src/ui/styles/base.css', 'utf8');
    const themes = [
      /^:root \{([^}]*)\}/gmu,
      /^\s+:root:not\(\[data-theme='light'\]\) \{([^}]*)\}/gmu,
      /^:root\[data-theme='dark'\] \{([^}]*)\}/gmu,
    ];
    for (const theme of themes) {
      const tokens = new Map<string, string>();
      for (const [, body] of css.matchAll(theme)) {
        for (const [, name, value] of body!.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) {
          tokens.set(name!, value!.trim());
        }
      }
      const others = [...tokens].filter(([name]) => /^--(?:accent|speaker-\d)$/u.test(name));
      expect(others).toHaveLength(9);
      expect(tokens.get('--narrator')).toMatch(/^#[\da-f]{6}$/u);
      expect(others.map(([, value]) => value)).not.toContain(tokens.get('--narrator'));
    }
  });
});

describe('a part saved again while the picker is open', () => {
  const chunks: Chunk[] = [
    ['Tom looked up. “Where were you?”\n\n', 'N', 'narration'],
    ['“Out,”', 'N', 'speech'],
    [' I said.\n\n', 'N', 'narration'],
    ['“Liar.”', 'U', 'speech'],
  ];

  it('keeps the picker on the tapped line when other lines change', async () => {
    const { story, host } = await fixSpeakers(chunks, [{ name: 'Tom' }]);
    const sheet = await tap(host, 3);
    expect(sheet.querySelector('blockquote')?.textContent).toBe('“Liar.”');
    // The new analysis found Tom's question: one more line before the tapped one.
    const question = story.text.indexOf('“Where');
    await saveAgain(story, ([first, ...rest]) => [
      { ...first!, end: question },
      { ...first!, start: question, speakerId: story.ids.Tom!, mode: 'speech' },
      ...rest,
    ]);
    await until(() => lines(host).length === 5, 'the part saved again');
    expect(host.querySelector('.sheet blockquote')?.textContent).toBe('“Liar.”');
    button(host.querySelector('.sheet')!, 'Tom')!.click();
    const saved = await savedCorrection(story.partId);
    expect(stretch(story, saved, 'Liar')?.speakerId).toBe(story.ids.Tom);
    expect(stretch(story, saved, 'I said')?.speakerId).toBe(story.ids.N);
  });

  it('closes the picker when the tapped line was given to someone else', async () => {
    const { story, host } = await fixSpeakers(chunks, [{ name: 'Tom' }]);
    await tap(host, 3);
    await saveAgain(story, (before) =>
      before.map((s, i) => (i === 3 ? { ...s, speakerId: story.ids.Tom! } : s)),
    );
    await until(() => !host.querySelector('.sheet'), 'the picker to close');
  });

  it('keeps “Told by” on the teller’s lines when another line is cut in two', async () => {
    const { story, host } = await fixSpeakers(
      [
        ['“Wake up! It is late,”', 'Tom', 'speech'],
        [' Tom said.\n\n', 'N', 'narration'],
        ['“Go away,”', 'N', 'speech'],
        [' I said.\n\n', 'N', 'narration'],
        ['“Up,”', 'Tom', 'speech'],
        [' he said again.', 'N', 'narration'],
      ],
      [{ name: 'Kit' }],
    );
    host.querySelector<HTMLButtonElement>('.told-by')!.click();
    await until(() => host.querySelector('.sheet'), 'the picker');
    const cut = story.text.indexOf(' It is');
    await saveAgain(story, ([first, ...rest]) => [
      { ...first!, end: cut, speakerId: story.ids.U! },
      { ...first!, start: cut },
      ...rest,
    ]);
    await until(() => lines(host).length === 7, 'the part saved again');
    const scope = host.querySelector('.sheet input[type="radio"]:checked')?.closest('label');
    expect(scope?.textContent?.trim()).toBe('Every line by Narrator in this part (4)');
    button(host.querySelector('.sheet')!, 'Kit')!.click();
    const saved = await savedCorrection(story.partId);
    expect(saved.map((s) => s.speakerId)).toEqual(
      ['U', 'Tom', 'Kit', 'Kit', 'Kit', 'Tom', 'Kit'].map((who) => story.ids[who]),
    );
  });
});

describe('“Told by”', () => {
  it('gives every line the teller reads in the part, as counted, to the person picked', async () => {
    const { story, host } = await fixSpeakers(frame, [{ name: 'Nelly' }]);
    const chip = await until(() => host.querySelector<HTMLButtonElement>('.told-by'), 'the chip');
    expect(chip.textContent).toContain('Told by: Narrator');
    chip.click();
    const sheet = await until(() => host.querySelector<HTMLElement>('.sheet'), 'the picker');
    expect(sheet.querySelector('h2')?.textContent).toBe('Who tells this part?');
    const checked = sheet.querySelector<HTMLInputElement>('input[type="radio"]:checked')!;
    expect(checked.value).toBe('part');
    const counted = Number(/\((\d+)\)/u.exec(checked.closest('label')!.textContent!)?.[1]);
    expect(counted).toBe(frame.filter(([, who]) => who === 'N').length);
    button(sheet, 'Nelly')!.click();
    const saved = await savedCorrection(story.partId);
    expect(saved.some((s) => s.speakerId === story.ids.N)).toBe(false);
    expect(stretch(story, saved, 'Tell me')).toMatchObject({
      speakerId: story.ids.Nelly,
      mode: 'speech',
    });
    expect(stretch(story, saved, 'Hush')?.speakerId).toBe(story.ids.Hindley);
    await until(() => host.querySelector('.told-by')?.textContent?.includes('Nelly'), 'the chip');
  });
});

describe('a passage', () => {
  /** Taps the passage's first line and picks who tells it, up to a line tapped next. */
  async function startPassage(host: HTMLElement, first: number, teller: string) {
    const sheet = await tap(host, first);
    sheet.querySelector<HTMLInputElement>('input[value="range"]')!.click();
    button(sheet, teller)!.click();
    return until(() => host.querySelector('.banner')?.textContent, 'the banner');
  }

  it('moves its first line’s speaker’s lines up to the line tapped next, keeping modes', async () => {
    const { story, host } = await fixSpeakers(frame, [{ name: 'Nelly' }]);
    expect(await startPassage(host, 3, 'Nelly')).toContain('Tap the last line Nelly reads');
    lines(host)[6]!.click();
    const saved = await savedCorrection(story.partId);
    for (const words of ['It was a long time', 'said Hindley', 'That was all']) {
      expect(stretch(story, saved, words)).toMatchObject({
        speakerId: story.ids.Nelly,
        mode: 'narration',
      });
    }
    expect(stretch(story, saved, 'Hush')?.speakerId).toBe(story.ids.Hindley);
    expect(stretch(story, saved, 'Tell me')?.speakerId).toBe(story.ids.N);
    expect(stretch(story, saved, 'She stopped')?.speakerId).toBe(story.ids.N);
  });

  it('saves nothing when cancelled', async () => {
    const { story, host } = await fixSpeakers(frame, [{ name: 'Nelly' }]);
    await startPassage(host, 3, 'Nelly');
    button(host.querySelector('.banner')!, 'Cancel')!.click();
    await until(() => !host.querySelector('.banner'), 'the banner to go');
    // With no passage waiting, a tap opens the picker instead of ending one.
    await tap(host, 6);
    const stored = (await getAnalysis(db, story.partId))!.segments;
    expect(stored.every((s) => s.source === 'heuristic')).toBe(true);
  });

  it('moves nothing when its first line was redone meanwhile', async () => {
    const { story, host } = await fixSpeakers(frame, [{ name: 'Nelly' }]);
    await startPassage(host, 3, 'Nelly');
    await saveAgain(story, (before) =>
      before.map((s, i) => (i === 3 ? { ...s, speakerId: story.ids.Hindley! } : s)),
    );
    await until(() => lines(host)[3]?.title === 'Hindley', 'the part saved again');
    lines(host)[6]!.click();
    await until(() => !host.querySelector('.banner'), 'the banner to go');
    // Correct another line: once that is stored, so is anything the tap saved.
    button(await tap(host, 0), 'Nelly')!.click();
    const saved = await savedCorrection(story.partId);
    expect(stretch(story, saved, 'It was a long time')?.speakerId).toBe(story.ids.Hindley);
    expect(stretch(story, saved, 'Hush')?.speakerId).toBe(story.ids.Hindley);
    expect(stretch(story, saved, 'That was all')?.speakerId).toBe(story.ids.N);
  });
});

describe('playback around a fix', () => {
  // Once the unknown speaker's first two lines are both Tom's, they join into one line, and the
  // lines after them move up by one: “Liar.” goes from line 3 to line 2.
  const chunks: Chunk[] = [
    ['“Where were you?”', 'U', 'speech'],
    [' “Out.”', 'U', 'speech'],
    [' I said.\n\n', 'N', 'narration'],
    ['“Liar.”', 'U', 'speech'],
  ];
  const at = (story: StoredStory, segmentIndex: number, partId = story.partId) => ({
    partId,
    segmentIndex,
  });
  /** Lets saves and player moves still under way land, before checking that nothing happened. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  async function fixing(story: StoredStory, count = chunks.length) {
    const host = await mountView(ReaderView, { id: story.storyId, partId: story.partId });
    await until(() => lines(host).length === count, 'the lines');
    button(host, 'Fix speakers')!.click();
    await until(() => host.querySelector('.text.editing'), 'Fix speakers');
    return host;
  }

  /** Gives the first two lines to Tom, one tap at a time; the second joins them. */
  async function giveBothToTom(host: HTMLElement) {
    button(await tap(host, 0), 'Tom')!.click();
    await until(() => lines(host)[0]?.title === 'Tom', 'the first fix');
    button(await tap(host, 1), 'Tom')!.click();
    await until(() => lines(host).length === chunks.length - 1, 'the lines to join');
  }

  /** Starts a passage of the unknown speaker's first two lines told by Tom; they join. */
  async function startPassage(host: HTMLElement) {
    const sheet = await tap(host, 0);
    sheet.querySelector<HTMLInputElement>('input[value="range"]')!.click();
    button(sheet, 'Tom')!.click();
    await until(() => host.querySelector('.banner'), 'the banner');
  }

  /** Holds the next save of an analysis back until the function it gives is called. */
  function holdNextSave(): () => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const save = vi.mocked(saveAnalysis);
    const real = save.getMockImplementation()!;
    save.mockImplementationOnce(async (...args) => {
      await held;
      return real(...args);
    });
    return release;
  }

  /**
   * Adds a second part whose first line is longer than the first part's first three lines, so a
   * place there read with the first part's lines would land on its line 0. Gives its id.
   */
  async function secondPart(story: StoredStory) {
    const pieces: Chunk[] = [
      ['The river had risen over the road in the night. ', 'N', 'narration'],
      ['“Look,”', 'Tom', 'speech'],
      [' said Tom.\n\n', 'N', 'narration'],
      ['Nobody answered.', 'N', 'narration'],
    ];
    const text = pieces.map(([piece]) => piece).join('');
    const part = await addPart(db, story.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text,
    });
    let end = 0;
    await saveAnalysis(db, {
      partId: part.id,
      textHash: part.textHash,
      analyzer: { kind: 'heuristic', version: 2 },
      createdAt: new Date().toISOString(),
      segments: pieces.map(([piece, who, mode]) => {
        end += piece.length;
        return {
          start: end - piece.length,
          end,
          speakerId: story.ids[who]!,
          mode,
          source: 'heuristic',
        };
      }),
    });
    return part.id;
  }

  it('carries on from the same words, with the new voices, when Done ends the fix', async () => {
    const story = await storeStory(chunks, { characters: [{ name: 'Tom' }] });
    playerSnapshot.value = { state: 'playing', speed: 1, position: at(story, 3) };
    const host = await fixing(story);
    expect(paused).toHaveBeenCalled();

    await giveBothToTom(host);
    // Each fix has the player drop the queue it built before, keeping to the same words.
    await until(() => jumped.mock.calls.length === 2, 'the second fix to reach the player');
    expect(jumped.mock.calls.map(([to]) => to)).toEqual([at(story, 3), at(story, 2)]);
    await until(
      () => host.querySelector('.segment.current')?.textContent === '“Liar.”',
      'the playing line to stay on “Liar.”',
    );

    button(host, 'Done')!.click();
    await until(() => played.mock.calls.length, 'playback to carry on');
    expect(played).toHaveBeenCalledWith(at(story, 2));
    expect(resumed).not.toHaveBeenCalled();
  });

  it('keeps to the words of a line that joins the line before it', async () => {
    const story = await storeStory(chunks, { characters: [{ name: 'Tom' }] });
    // Playing “Out.”, which the second fix joins to the line before it.
    playerSnapshot.value = { state: 'playing', speed: 1, position: at(story, 1) };
    const host = await fixing(story);
    await giveBothToTom(host);
    await until(() => jumped.mock.calls.length === 2, 'the second fix to reach the player');
    expect(jumped.mock.calls.map(([to]) => to)).toEqual([at(story, 1), at(story, 0)]);
    button(host, 'Done')!.click();
    await until(() => played.mock.calls.length, 'playback to carry on');
    expect(played).toHaveBeenCalledWith(at(story, 0));
  });

  it('carries on as it was when nothing was fixed', async () => {
    const story = await storeStory(chunks);
    playerSnapshot.value = { state: 'playing', speed: 1, position: at(story, 3) };
    const host = await fixing(story);
    button(host, 'Done')!.click();
    await until(() => resumed.mock.calls.length, 'playback to resume');
    expect(played).not.toHaveBeenCalled();
    expect(jumped).not.toHaveBeenCalled();
  });

  it('leaves playback stopped on the same words when it was paused before Fix', async () => {
    const story = await storeStory(chunks, { characters: [{ name: 'Tom' }] });
    playerSnapshot.value = { state: 'paused', speed: 1, position: at(story, 3) };
    const host = await fixing(story);
    button(await tap(host, 0), 'Tom')!.click();
    await until(() => jumped.mock.calls.length, 'the fix to reach the player');
    button(host, 'Done')!.click();
    await until(() => !host.querySelector('.text.editing'), 'Done');
    await settle();
    expect(played).not.toHaveBeenCalled();
    expect(resumed).not.toHaveBeenCalled();
    // The fix dropped the queue the player had paused (a jump goes idle): ▶ builds it afresh.
    expect(playerSnapshot.value).toMatchObject({ state: 'idle', position: at(story, 3) });
  });

  it('keeps the saved place on the same words when nothing has played', async () => {
    const story = await storeStory(chunks, { characters: [{ name: 'Tom' }] });
    await updateStory(db, story.storyId, { position: at(story, 3) });
    const host = await fixing(story);
    await giveBothToTom(host);
    await until(
      async () => (await getStory(db, story.storyId))!.position?.segmentIndex === 2,
      'the saved place to move to “Liar.”',
    );
    expect(jumped).not.toHaveBeenCalled();
  });

  it('leaves a saved place in another part where it is', async () => {
    const story = await storeStory(chunks, { characters: [{ name: 'Tom' }] });
    const two = await secondPart(story);
    await updateStory(db, story.storyId, { position: at(story, 3, two) });
    const host = await fixing(story);
    await giveBothToTom(host);
    await settle();
    expect((await getStory(db, story.storyId))!.position).toEqual(at(story, 3, two));
  });

  it('keeps playback in another part on its line, and carries on there', async () => {
    const story = await storeStory(chunks, { characters: [{ name: 'Tom' }] });
    const two = await secondPart(story);
    playerSnapshot.value = { state: 'playing', speed: 1, position: at(story, 3, two) };
    const host = await fixing(story);
    await giveBothToTom(host);
    await until(() => jumped.mock.calls.length === 2, 'the second fix to reach the player');
    expect(jumped.mock.calls.map(([to]) => to)).toEqual([at(story, 3, two), at(story, 3, two)]);
    button(host, 'Done')!.click();
    await until(() => played.mock.calls.length, 'playback to carry on');
    expect(played).toHaveBeenCalledWith(at(story, 3, two));
  });

  it.each([['the next part'], ['the next part and back']])(
    'leaves playback alone after Done once Fix went to %s',
    async (trip) => {
      const story = await storeStory(chunks, { characters: [{ name: 'Tom' }] });
      const two = await secondPart(story);
      playerSnapshot.value = { state: 'playing', speed: 1, position: at(story, 3) };
      const host = await fixing(story);
      const select = host.querySelector<HTMLSelectElement>('.part-picker select')!;
      for (const partId of trip.endsWith('back') ? [two, story.partId] : [two]) {
        select.value = partId;
        select.dispatchEvent(new Event('change'));
      }
      await until(() => jumped.mock.calls.length === (trip.endsWith('back') ? 2 : 1), 'the moves');
      button(host, 'Done')!.click();
      await until(() => !host.querySelector('.text.editing'), 'Done');
      await settle();
      expect(played).not.toHaveBeenCalled();
      expect(resumed).not.toHaveBeenCalled();
    },
  );

  it('carries on from the same line after “Same person as…”', async () => {
    const people: Chunk[] = [
      ['“Where were you?”', 'Bob', 'speech'],
      [' asked Bob.\n\n', 'N', 'narration'],
      ['“Out,”', 'Robert', 'speech'],
      [' said Robert.', 'N', 'narration'],
    ];
    const story = await storeStory(people);
    playerSnapshot.value = { state: 'playing', speed: 1, position: at(story, 2) };
    const host = await fixing(story, people.length);
    const sheet = await tap(host, 0);
    button(sheet, 'Bob is the same person as…')!.click();
    await until(() => button(sheet, 'Confirm merge'), 'the merge step');
    button(sheet, 'Robert')!.click();
    await until(() => sheet.querySelector('.warning'), 'the warning');
    button(sheet, 'Confirm merge')!.click();
    // The old queue read Bob's lines in his old voice: it is dropped.
    await until(() => jumped.mock.calls.length, 'the merge to reach the player');
    expect(jumped).toHaveBeenCalledWith(at(story, 2));
    button(host, 'Done')!.click();
    await until(() => played.mock.calls.length, 'playback to carry on');
    expect(played).toHaveBeenCalledWith(at(story, 2));
  });

  it('does not scroll to the playing line while fixing', async () => {
    const story = await storeStory(chunks, { characters: [{ name: 'Tom' }] });
    playerSnapshot.value = { state: 'playing', speed: 1, position: at(story, 3) };
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    try {
      const host = await fixing(story);
      // Opened on the playing line, before fixing.
      await until(() => scroll.mock.calls.length, 'the page to open on the playing line');
      scroll.mockClear();
      await giveBothToTom(host);
      // The playing line was renumbered from 3 to 2.
      await until(
        () => host.querySelector('.segment.current')?.textContent === '“Liar.”',
        'the playing line to stay on “Liar.”',
      );
      await settle();
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      scroll.mockRestore();
    }
  });

  it('waits for a passage still being saved before Done carries on', async () => {
    const story = await storeStory(chunks, { characters: [{ name: 'Tom' }] });
    playerSnapshot.value = { state: 'playing', speed: 1, position: at(story, 3) };
    const host = await fixing(story);
    await startPassage(host);
    const release = holdNextSave();
    lines(host)[1]!.click();
    button(host, 'Done')!.click();
    await settle();
    expect(resumed).not.toHaveBeenCalled();
    expect(played).not.toHaveBeenCalled();
    release();
    await until(() => played.mock.calls.length, 'playback to carry on');
    expect(jumped.mock.calls.map(([to]) => to)).toEqual([at(story, 2)]);
    expect(played).toHaveBeenCalledWith(at(story, 2));
  });

  it('follows the same words when playback started again while a fix was saved', async () => {
    const story = await storeStory(chunks, { characters: [{ name: 'Tom' }] });
    playerSnapshot.value = { state: 'playing', speed: 1, position: at(story, 3) };
    const host = await fixing(story);
    await startPassage(host);
    const release = holdNextSave();
    lines(host)[1]!.click();
    // The media controls played on meanwhile: the same line, started again.
    playerSnapshot.value = { state: 'playing', speed: 1, position: at(story, 3) };
    release();
    await until(() => jumped.mock.calls.length, 'the fix to reach the player');
    expect(jumped).toHaveBeenCalledWith(at(story, 2));
  });
});

/** Spies on scrolls to lines: which line, and how. */
function watchScrolls() {
  const scrolled: Array<[number, ScrollBehavior | undefined]> = [];
  const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
    this: Element,
    options?: boolean | ScrollIntoViewOptions,
  ) {
    const index = (this as HTMLElement).dataset.index;
    const behavior = typeof options === 'object' ? options.behavior : undefined;
    if (index !== undefined) scrolled.push([Number(index), behavior]);
  });
  return { scrolled, restore: () => spy.mockRestore() };
}

/** Puts the stubbed player on line `segmentIndex` of part `partId`, playing. */
function playingAt(partId: string, segmentIndex: number) {
  playerSnapshot.value = { state: 'playing', speed: 1, position: { partId, segmentIndex } };
}

describe('opening on a part being read', () => {
  it('goes at once to the line being read, then follows the next ones smoothly', async () => {
    const story = await storeStory(frame);
    playingAt(story.partId, 4);
    const scrolls = watchScrolls();
    try {
      // As the story page's Continue opens it: the part is playing already.
      const host = await mountView(ReaderView, { id: story.storyId });
      await until(() => scrolls.scrolled.length, 'the page to open on the line');
      expect(scrolls.scrolled).toEqual([[4, 'auto']]);
      expect(host.querySelector('.segment.current')?.textContent).toBe('“Hush,”');

      playingAt(story.partId, 5);
      await until(() => scrolls.scrolled.length === 2, 'the next line');
      expect(scrolls.scrolled[1]).toEqual([5, 'smooth']);
    } finally {
      scrolls.restore();
    }
  });

  it('moves to the next lines at once when the reader asks for less motion', async () => {
    const story = await storeStory(frame);
    playingAt(story.partId, 4);
    const media = vi
      .spyOn(window, 'matchMedia')
      .mockReturnValue({ matches: true } as unknown as MediaQueryList);
    const scrolls = watchScrolls();
    try {
      await mountView(ReaderView, { id: story.storyId });
      await until(() => scrolls.scrolled.length, 'the page to open on the line');
      playingAt(story.partId, 5);
      await until(() => scrolls.scrolled.length === 2, 'the next line');
      expect(scrolls.scrolled).toEqual([
        [4, 'auto'],
        [5, 'auto'],
      ]);
    } finally {
      scrolls.restore();
      media.mockRestore();
    }
  });

  it('opens on a line linked from the cast, not on the line being read', async () => {
    const story = await storeStory(frame);
    playingAt(story.partId, 1);
    const scrolls = watchScrolls();
    try {
      await mountView(ReaderView, { id: story.storyId, partId: story.partId, line: 4 });
      await until(() => scrolls.scrolled.length, 'the scroll');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrolls.scrolled.map(([index]) => index)).toEqual([4]);
    } finally {
      scrolls.restore();
    }
  });

  it('goes at once to the line being read when playback starts after the lines show', async () => {
    const story = await storeStory(frame);
    const scrolls = watchScrolls();
    try {
      // As Continue opens it: the player takes up its place a moment after the page shows.
      const host = await mountView(ReaderView, { id: story.storyId });
      await until(() => lines(host).length === frame.length, 'the lines');
      playingAt(story.partId, 6);
      await until(() => scrolls.scrolled.length, 'the scroll');
      expect(scrolls.scrolled).toEqual([[6, 'auto']]);
    } finally {
      scrolls.restore();
    }
  });

  it('scrolls smoothly to a line tapped to play in a part nothing was playing in', async () => {
    const story = await storeStory(frame);
    const scrolls = watchScrolls();
    try {
      // Opened from the part's row.
      const host = await mountView(ReaderView, { id: story.storyId, partId: story.partId });
      await until(() => lines(host).length === frame.length, 'the lines');
      lines(host)[5]!.click();
      await until(() => scrolls.scrolled.length, 'the scroll');
      expect(played).toHaveBeenCalledExactlyOnceWith({ partId: story.partId, segmentIndex: 5 });
      expect(scrolls.scrolled).toEqual([[5, 'smooth']]);
    } finally {
      scrolls.restore();
    }
  });

  it('goes at once to the line being read in each part playback moves into', async () => {
    const story = await storeStory(frame);
    const next = await addNarratedPart(story, ['Years later. ', 'It rained.']);
    playingAt(story.partId, 6);
    const scrolls = watchScrolls();
    try {
      const host = await mountView(ReaderView, { id: story.storyId });
      await until(() => scrolls.scrolled.length, 'the page to open on the line');
      playingAt(next.id, 1);
      await until(() => lines(host).length === 2, 'the next part');
      await until(() => scrolls.scrolled.length === 2, 'the line in the next part');
      expect(scrolls.scrolled).toEqual([
        [6, 'auto'],
        [1, 'auto'],
      ]);
    } finally {
      scrolls.restore();
    }
  });

  it('stays put when the part’s analysis is saved again with other paragraphs', async () => {
    const story = await storeStory(frame);
    playerSnapshot.value = {
      state: 'paused',
      speed: 1,
      position: { partId: story.partId, segmentIndex: 4 },
    };
    const scrolls = watchScrolls();
    try {
      const host = await mountView(ReaderView, { id: story.storyId, partId: story.partId });
      await until(() => scrolls.scrolled.length, 'the page to open on the line');
      const paragraphs = () => host.querySelectorAll('.text p').length;
      const before = paragraphs();

      // The first line now ends before its blank line, so the next line no longer starts a
      // paragraph: one paragraph fewer, the same lines.
      await saveAgain(story, ([first, second, ...rest]) => [
        { ...first!, end: first!.end - 2 },
        { ...second!, start: second!.start - 2 },
        ...rest,
      ]);
      await until(() => paragraphs() === before - 1, 'the paragraphs as saved again');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrolls.scrolled).toEqual([[4, 'auto']]);
    } finally {
      scrolls.restore();
    }
  });
});

describe('reading along', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const backButton = (host: HTMLElement) => button(host, /Back to the playing line/);
  const indexes = (scrolls: ReturnType<typeof watchScrolls>) =>
    scrolls.scrolled.map(([index]) => index);

  /**
   * Lays the lines out as a browser would (happy-dom has no layout): each on the screen, or above
   * or below it as `where` says. Then scrolls, so the page measures them again.
   */
  function layOut(host: HTMLElement, where: (index: number) => 'above' | 'on' | 'below') {
    for (const line of lines(host)) {
      const index = Number(line.dataset.index);
      const top = { above: -5000, on: 100 + 30 * index, below: 5000 }[where(index)];
      vi.spyOn(line, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 300, 30));
    }
    window.dispatchEvent(new Event('scroll'));
  }

  /** The reader on `story`'s part, playing line 1, scrolled to it. */
  async function reading(story: StoredStory) {
    playingAt(story.partId, 1);
    const scrolls = watchScrolls();
    const host = await mountView(ReaderView, { id: story.storyId, partId: story.partId });
    await until(() => scrolls.scrolled.length, 'the page to open on the line');
    return { host, scrolls };
  }

  /**
   * Spies on lines taking the focus: the line's tabindex then (happy-dom lets any element take
   * it; a browser only one with a tabindex), and how.
   */
  function watchFocus() {
    const focus = HTMLElement.prototype.focus;
    const focused: Array<[string | null, FocusOptions | undefined]> = [];
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (this.classList.contains('segment'))
        focused.push([this.getAttribute('tabindex'), options]);
      focus.call(this, options);
    });
    return { focused, restore: () => spy.mockRestore() };
  }

  it.each(['wheel', 'touchmove'])(
    'keeps the line being read in view until the reader scrolls away (%s)',
    async (scrolling) => {
      const story = await storeStory(frame);
      const { scrolls } = await reading(story);
      try {
        playingAt(story.partId, 2);
        await until(() => indexes(scrolls).includes(2), 'the page to follow');

        window.dispatchEvent(new Event(scrolling));
        playingAt(story.partId, 3);
        await settle();
        expect(indexes(scrolls)).toEqual([1, 2]);
      } finally {
        scrolls.restore();
      }
    },
  );

  it('offers a way back to the line being read once it is off the screen', async () => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    const focus = watchFocus();
    try {
      window.dispatchEvent(new WheelEvent('wheel'));
      playingAt(story.partId, 3);
      layOut(host, () => 'on');
      await settle();
      expect(backButton(host)).toBeUndefined();

      layOut(host, (index) => (index >= 3 ? 'below' : 'on'));
      const back = await until(() => backButton(host), 'the way back');
      expect(back.textContent).toContain('↓');
      back.focus();
      back.click();
      await until(() => indexes(scrolls).includes(3), 'the line being read');
      expect(scrolls.scrolled.at(-1)).toEqual([3, 'smooth']);
      await until(() => !backButton(host), 'the way back gone');
      // The line takes the focus the button had, which went with it, without cutting the scroll
      // short; it alone can take it.
      await until(() => focus.focused.length, 'the line to take the focus');
      expect(focus.focused).toEqual([['-1', { preventScroll: true }]]);
      expect(document.activeElement).toBe(lines(host)[3]);
      expect(host.querySelectorAll('.segment[tabindex]')).toHaveLength(1);

      // The page follows again.
      playingAt(story.partId, 4);
      await until(() => indexes(scrolls).includes(4), 'the next line');
    } finally {
      focus.restore();
      scrolls.restore();
    }
  });

  /** Stops the clock the reader reads (performance.now); `wait` moves it on. */
  function stopClock() {
    let now = 100_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    return { wait: (ms: number) => void (now += ms), restore: () => spy.mockRestore() };
  }

  it('takes no second tap of a double tap on the way back for a tap on a line', async () => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    const clock = stopClock();
    try {
      window.dispatchEvent(new WheelEvent('wheel'));
      playingAt(story.partId, 3);
      layOut(host, (index) => (index >= 3 ? 'below' : 'on'));
      (await until(() => backButton(host), 'the way back')).click();
      // The second tap of a double tap comes up to 300 ms later, on the line the button uncovered.
      clock.wait(300);
      lines(host)[5]!.click();
      clock.wait(199);
      lines(host)[5]!.click();
      await settle();
      expect(played).not.toHaveBeenCalled();

      // Half a second on, a tap plays from the line.
      clock.wait(1);
      lines(host)[5]!.click();
      await until(() => played.mock.calls.length, 'playback from the line');
      expect(played).toHaveBeenCalledExactlyOnceWith({ partId: story.partId, segmentIndex: 5 });
    } finally {
      clock.restore();
      scrolls.restore();
    }
  });

  it('takes no second tap of a double tap on the way back to another part', async () => {
    const story = await storeStory(frame);
    const second = await addNarratedPart(story, ['Years later. ', 'It rained.']);
    playingAt(second.id, 1);
    const clock = stopClock();
    try {
      const host = await mountRouted(ReaderView, {
        name: 'reader',
        params: { id: story.storyId, partId: story.partId },
      });
      (await until(() => backButton(host), 'the way back')).click();
      await until(() => lines(host).length === 2, 'the playing part');
      clock.wait(300);
      lines(host)[0]!.click();
      await settle();
      expect(played).not.toHaveBeenCalled();
    } finally {
      clock.restore();
    }
  });

  it.each<[string, () => PointerEventInit, () => Element]>([
    ['the middle button', () => ({ button: 1 }), () => document.body],
    ['the page’s scrollbar', () => ({ clientX: 365 }), () => document.documentElement],
  ])('stops reading along at a press with %s, which scrolls the page', async (_, init, on) => {
    const story = await storeStory(frame);
    const { scrolls } = await reading(story);
    const width = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(360);
    try {
      on().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, ...init() }));
      playingAt(story.partId, 2);
      await settle();
      expect(indexes(scrolls)).toEqual([1]);
    } finally {
      width.mockRestore();
      scrolls.restore();
    }
  });

  it.each<[string, (host: HTMLElement) => Element, PointerEventInit]>([
    // Beside the text, where the page shows nothing.
    ['on the page itself', () => document.documentElement, { button: 0, clientX: 300 }],
    // To copy it, say.
    ['with the right button on a line', (host) => lines(host)[4]!, { button: 2 }],
    // Which opens it in another tab.
    [
      'with the middle button on a link',
      (host) => [...host.querySelectorAll('a')].find((a) => a.textContent === 'Cast')!,
      { button: 1 },
    ],
  ])('reads along on through a press %s', async (_, on, init) => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    const width = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(360);
    try {
      on(host).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, ...init }));
      playingAt(story.partId, 2);
      await until(() => indexes(scrolls).includes(2), 'the page to follow');
    } finally {
      width.mockRestore();
      scrolls.restore();
    }
  });

  it('points up to the line being read once the reader has scrolled past it', async () => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
      layOut(host, () => 'on');
      await settle();
      expect(backButton(host)).toBeUndefined();

      layOut(host, (index) => (index <= 1 ? 'above' : 'on'));
      const back = await until(() => backButton(host), 'the way back');
      expect(back.textContent).toContain('↑');
    } finally {
      scrolls.restore();
    }
  });

  it('measures the line against the header above it and the player below it', async () => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    try {
      window.dispatchEvent(new WheelEvent('wheel'));
      const height = window.innerHeight;
      vi.spyOn(host.querySelector('.reader-head')!, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, 300, 60),
      );
      vi.spyOn(host.querySelector('.player-bar')!, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, height - 68, 300, 68),
      );
      const line = vi.spyOn(lines(host)[1]!, 'getBoundingClientRect');
      /** The way back once line 1 is `top` from the top of the screen and `event` measured it. */
      const wayBackAt = async (top: number, event = 'scroll') => {
        line.mockReturnValue(new DOMRect(0, top, 300, 30));
        window.dispatchEvent(new Event(event));
        await settle();
        return backButton(host);
      };

      // Under the header, and the way back just above the player.
      const back = await wayBackAt(20);
      expect(back?.textContent).toContain('↑');
      expect(back?.style.bottom).toBe('80px');
      // Under the player.
      expect((await wayBackAt(height - 40))?.textContent).toContain('↓');
      // Partly in sight, under the header's edge or the player's.
      expect(await wayBackAt(40)).toBeUndefined();
      expect(await wayBackAt(height - 80)).toBeUndefined();
      // A turned phone measures again.
      expect((await wayBackAt(20, 'resize'))?.textContent).toContain('↑');
    } finally {
      scrolls.restore();
    }
  });

  it.each<[string, Partial<PlayerSnapshot>]>([
    ['the story ends', { state: 'idle', ended: true }],
    ['the player cannot go on', { state: 'blocked', message: '“Two” has not been analysed yet.' }],
  ])('keeps the way back to a place moved while paused, until %s', async (_, end) => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    const at = (segmentIndex: number) => ({ partId: story.partId, segmentIndex });
    try {
      window.dispatchEvent(new WheelEvent('wheel'));
      playerSnapshot.value = { state: 'paused', speed: 1, position: at(5) };
      layOut(host, (index) => (index >= 3 ? 'below' : 'on'));
      await until(() => backButton(host), 'the way back');

      // ◀ while paused: the player waits, idle, on the line before, which ▶ plays.
      playerSnapshot.value = { state: 'idle', speed: 1, position: at(4) };
      await settle();
      expect(backButton(host)?.textContent).toContain('↓');

      // Nothing is left to go back to.
      playerSnapshot.value = { state: 'idle', speed: 1, position: at(7), ...end };
      await until(() => !backButton(host), 'the way back gone');
    } finally {
      scrolls.restore();
    }
  });

  it('follows again from a line tapped to play', async () => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
      playingAt(story.partId, 2);
      await settle();
      expect(indexes(scrolls)).toEqual([1]);

      lines(host)[5]!.click();
      await until(() => played.mock.calls.length, 'playback from the line');
      expect(played).toHaveBeenCalledWith({ partId: story.partId, segmentIndex: 5 });
      playingAt(story.partId, 6);
      await until(() => indexes(scrolls).includes(6), 'the page to follow');
    } finally {
      scrolls.restore();
    }
  });

  it('is not stopped by keys a control takes, or keys that do not scroll', async () => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    try {
      const select = host.querySelector<HTMLSelectElement>('.part-picker select')!;
      select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      // Space presses the button.
      const pause = host.querySelector<HTMLElement>('.player-bar [aria-label="Pause"]')!;
      pause.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
      playingAt(story.partId, 2);
      await until(() => indexes(scrolls).includes(2), 'the page to follow');
    } finally {
      scrolls.restore();
    }
  });

  /** Whether `key` pressed on what `on` finds (the page itself if nothing) stops reading along. */
  async function stopsAt(key: string, on?: (host: HTMLElement) => HTMLElement) {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    try {
      const target = on?.(host) ?? document.body;
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      playingAt(story.partId, 2);
      await settle();
      return indexes(scrolls).length === 1;
    } finally {
      scrolls.restore();
    }
  }

  it.each([' ', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'])(
    'stops reading along at %j, which scrolls the page',
    async (key) => {
      expect(await stopsAt(key)).toBe(true);
    },
  );

  it.each(['ArrowDown', 'PageDown', 'End'])(
    'stops reading along at %j on a button, which leaves it to the page',
    async (key) => {
      const nextLine = (host: HTMLElement) =>
        host.querySelector<HTMLElement>('.player-bar [aria-label="Next line"]')!;
      expect(await stopsAt(key, nextLine)).toBe(true);
    },
  );

  it('stops reading along at Space on a link, which leaves it to the page', async () => {
    const cast = (host: HTMLElement) =>
      [...host.querySelectorAll<HTMLElement>('a')].find((a) => a.textContent === 'Cast')!;
    expect(await stopsAt(' ', cast)).toBe(true);
  });

  it('reads along again after Done when keys only scrolled the speaker picker', async () => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    try {
      button(host, 'Fix speakers')!.click();
      await until(() => host.querySelector('.text.editing'), 'Fix speakers');
      const sheet = await tap(host, 1);
      sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
      button(sheet, 'Cancel')!.click();
      await until(() => !host.querySelector('.sheet'), 'the picker to close');
      button(host, 'Done')!.click();
      await until(() => playerSnapshot.value.state === 'playing', 'playback to carry on');
      playingAt(story.partId, 2);
      await until(() => indexes(scrolls).includes(2), 'the page to follow');
    } finally {
      scrolls.restore();
    }
  });

  it.each<[string, () => Event]>([
    ['wheel', () => new WheelEvent('wheel', { bubbles: true })],
    ['touchmove', () => new Event('touchmove', { bubbles: true })],
    ['middle-button press', () => new PointerEvent('pointerdown', { bubbles: true, button: 1 })],
  ])(
    'reads along again after Done when a %s only scrolled the speaker picker',
    async (_, gesture) => {
      const story = await storeStory(frame);
      playingAt(story.partId, 1);
      const scrolls = watchScrolls();
      try {
        let router: Router | undefined;
        // As Continue opens it: the part shown is the one playing, not one the route names.
        const host = await mountRouted(
          ReaderView,
          { name: 'reader', params: { id: story.storyId } },
          (r) => (router = r),
        );
        await until(() => scrolls.scrolled.length, 'the page to open on the line');
        button(host, 'Fix speakers')!.click();
        await until(() => host.querySelector('.text.editing'), 'Fix speakers');
        const sheet = await tap(host, 1);
        sheet.dispatchEvent(gesture());
        button(sheet, 'Cancel')!.click();
        await until(() => !host.querySelector('.sheet'), 'the picker to close');
        button(host, 'Done')!.click();
        await until(() => playerSnapshot.value.state === 'playing', 'playback to carry on');
        playingAt(story.partId, 4);
        await until(() => indexes(scrolls).includes(4), 'the page to follow');
        expect(router!.currentRoute.value.params.partId).toBeUndefined();
      } finally {
        scrolls.restore();
      }
    },
  );

  it('lets go of the page once it is closed', async () => {
    const story = await storeStory(frame);
    playingAt(story.partId, 1);
    let router: Router | undefined;
    const host = await mountRouted(
      ReaderView,
      { name: 'reader', params: { id: story.storyId } },
      (r) => (router = r),
    );
    await until(() => lines(host).length === frame.length, 'the lines');
    await router!.push({ name: 'story', params: { id: story.storyId } });
    await until(() => !lines(host).length, 'the reader to close');
    window.dispatchEvent(new WheelEvent('wheel'));
    window.dispatchEvent(new Event('touchmove'));
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 1 }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    await settle();
    expect(router!.currentRoute.value.name).toBe('story');
  });

  it('goes on into the next part with the player while reading along', async () => {
    const story = await storeStory(frame);
    const next = await addNarratedPart(story, ['Years later. ', 'It rained.']);
    playingAt(story.partId, 6);
    const scrolls = watchScrolls();
    try {
      let router: Router | undefined;
      const host = await mountRouted(
        ReaderView,
        { name: 'reader', params: { id: story.storyId, partId: story.partId } },
        (r) => (router = r),
      );
      await until(() => scrolls.scrolled.length, 'the page to open on the line');
      playingAt(next.id, 0);
      await until(() => router!.currentRoute.value.params.partId === next.id, 'the next part');
      await until(() => lines(host).length === 2, 'its lines');
      await until(() => indexes(scrolls).at(-1) === 0, 'its line being read');
    } finally {
      scrolls.restore();
    }
  });

  it('stays on a part opened while another plays, offering the way to it', async () => {
    const story = await storeStory(frame);
    const second = await addNarratedPart(story, ['Years later. ', 'It rained.']);
    const third = await addNarratedPart(story, ['The end.'], 'Three');
    // Left where it was: nothing is being read.
    playerSnapshot.value = {
      state: 'idle',
      speed: 1,
      position: { partId: story.partId, segmentIndex: 6 },
    };
    let router: Router | undefined;
    const host = await mountRouted(
      ReaderView,
      { name: 'reader', params: { id: story.storyId, partId: third.id } },
      (r) => (router = r),
    );
    await until(() => lines(host).length === 1, 'the part');
    await settle();
    expect(backButton(host)).toBeUndefined();

    playerSnapshot.value = { ...playerSnapshot.value, state: 'paused' };
    const back = await until(() => backButton(host), 'the way back');
    expect(back.textContent).toContain('↑');
    // The player moves on into the second part: the page stays on the third.
    playingAt(second.id, 0);
    await settle();
    expect(router!.currentRoute.value.params.partId).toBe(third.id);
    expect(lines(host)).toHaveLength(1);

    backButton(host)!.click();
    await until(() => router!.currentRoute.value.params.partId === second.id, 'the playing part');
    await until(() => lines(host).length === 2, 'its lines');
    await until(() => !backButton(host), 'the way back gone');
  });

  it('offers the way back at once on a part opened while another is paused', async () => {
    const story = await storeStory(frame);
    // Not analysed yet: it has no lines to show.
    const second = await addPart(db, story.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'Years later.',
    });
    playerSnapshot.value = {
      state: 'paused',
      speed: 1,
      position: { partId: story.partId, segmentIndex: 6 },
    };
    const host = await mountRouted(ReaderView, {
      name: 'reader',
      params: { id: story.storyId, partId: second.id },
    });
    const back = await until(() => backButton(host), 'the way back');
    expect(back.textContent).toContain('↑');

    // ◀ while paused: the player waits, idle, on the line before; the way back stays.
    playerSnapshot.value = {
      state: 'idle',
      speed: 1,
      position: { partId: story.partId, segmentIndex: 5 },
    };
    await settle();
    expect(backButton(host)?.textContent).toContain('↑');
  });

  it('follows again once the reader goes to another part', async () => {
    const story = await storeStory(frame);
    await addNarratedPart(story, ['Years later. ', 'It rained.']);
    playingAt(story.partId, 1);
    const scrolls = watchScrolls();
    try {
      const host = await mountRouted(ReaderView, {
        name: 'reader',
        params: { id: story.storyId, partId: story.partId },
      });
      await until(() => scrolls.scrolled.length, 'the page to open on the line');
      window.dispatchEvent(new WheelEvent('wheel'));

      host.querySelector<HTMLElement>('[aria-label="Next part"]')!.click();
      await until(() => lines(host).length === 2, 'the next part');
      // The player waits at its first line, which the page goes to.
      await until(() => indexes(scrolls).length === 2, 'the next part’s line');
      expect(scrolls.scrolled.at(-1)).toEqual([0, 'auto']);
    } finally {
      scrolls.restore();
    }
  });

  /** The ways the player holds its place in the second part, each then gone to one way. */
  const holds: Array<[string, string, Array<'playing' | 'paused' | 'idle'>]> = [
    ['playing there', 'Next part', ['playing']],
    ['paused there', 'the part picker', ['paused']],
    ['moved while paused there', 'Next part', ['paused', 'idle']],
  ];
  it.each(holds)(
    'keeps the place of the part being read, %s, when %s goes to it',
    async (_, how, states) => {
      const story = await storeStory(frame);
      const next = await addNarratedPart(story, ['Years later. ', 'It rained. ', 'The end.']);
      playingAt(story.partId, 6);
      const scrolls = watchScrolls();
      try {
        let router: Router | undefined;
        const host = await mountRouted(
          ReaderView,
          { name: 'reader', params: { id: story.storyId } },
          (r) => (router = r),
        );
        await until(() => scrolls.scrolled.length, 'the page to open on the line');
        // The reader reads on in the first part while the player goes on into the second.
        window.dispatchEvent(new WheelEvent('wheel'));
        await until(
          () => router!.currentRoute.value.params.partId === story.partId,
          'the part kept in the route',
        );
        for (const state of states) {
          playerSnapshot.value = {
            state,
            speed: 1,
            position: { partId: next.id, segmentIndex: state === 'idle' ? 1 : 2 },
          };
          await settle();
        }
        const place = playerSnapshot.value.position!;
        await until(() => backButton(host), 'the way back');

        if (how === 'Next part') {
          host.querySelector<HTMLElement>('[aria-label="Next part"]')!.click();
        } else {
          const select = host.querySelector<HTMLSelectElement>('.part-picker select')!;
          select.value = next.id;
          select.dispatchEvent(new Event('change'));
        }
        await until(() => lines(host).length === 3, 'the part being read');
        await until(() => indexes(scrolls).at(-1) === place.segmentIndex, 'its line');
        expect(scrolls.scrolled.at(-1)).toEqual([place.segmentIndex, 'auto']);
        expect(jumped).not.toHaveBeenCalled();
        expect(playerSnapshot.value.position).toEqual(place);
      } finally {
        scrolls.restore();
      }
    },
  );

  it('starts a part at its first line when nothing is being read', async () => {
    const story = await storeStory(frame);
    const next = await addNarratedPart(story, ['Years later. ', 'It rained.']);
    // Left there earlier: nothing is being read.
    playerSnapshot.value = {
      state: 'idle',
      speed: 1,
      position: { partId: next.id, segmentIndex: 1 },
    };
    const host = await mountRouted(ReaderView, {
      name: 'reader',
      params: { id: story.storyId, partId: story.partId },
    });
    await until(() => lines(host).length === frame.length, 'the lines');
    host.querySelector<HTMLElement>('[aria-label="Next part"]')!.click();
    await until(() => jumped.mock.calls.length, 'the place to move');
    expect(jumped).toHaveBeenCalledExactlyOnceWith({ partId: next.id, segmentIndex: 0 });
  });

  it('offers no way back to the first line of a part gone to while paused', async () => {
    const story = await storeStory(frame);
    await addNarratedPart(story, ['Years later. ', 'It rained.']);
    playerSnapshot.value = {
      state: 'paused',
      speed: 1,
      position: { partId: story.partId, segmentIndex: 1 },
    };
    const host = await mountRouted(ReaderView, {
      name: 'reader',
      params: { id: story.storyId, partId: story.partId },
    });
    await until(() => lines(host).length === frame.length, 'the lines');
    host.querySelector<HTMLElement>('[aria-label="Next part"]')!.click();
    await until(() => lines(host).length === 2, 'the next part');
    // The player waits at the part's first line, and the reader reads on past it.
    expect(playerSnapshot.value.state).toBe('idle');
    window.dispatchEvent(new WheelEvent('wheel'));
    layOut(host, (index) => (index === 0 ? 'above' : 'on'));
    await settle();
    expect(backButton(host)).toBeUndefined();
  });

  it('offers no way back on a part opened while another is paused, once fixing', async () => {
    const story = await storeStory(frame);
    await addNarratedPart(story, ['Years later. ', 'It rained.']);
    const third = await addNarratedPart(story, ['The end.'], 'Three');
    playerSnapshot.value = {
      state: 'paused',
      speed: 1,
      position: { partId: story.partId, segmentIndex: 6 },
    };
    const host = await mountRouted(ReaderView, {
      name: 'reader',
      params: { id: story.storyId, partId: third.id },
    });
    await until(() => backButton(host), 'the way back');
    // Already paused: Fix speakers leaves the player as it is.
    button(host, 'Fix speakers')!.click();
    await until(() => host.querySelector('.text.editing'), 'Fix speakers');
    await settle();
    expect(backButton(host)).toBeUndefined();
  });

  it('offers no way back while fixing speakers', async () => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    try {
      window.dispatchEvent(new WheelEvent('wheel'));
      button(host, 'Fix speakers')!.click();
      await until(() => host.querySelector('.text.editing'), 'Fix speakers');
      layOut(host, (index) => (index <= 1 ? 'above' : 'on'));
      await settle();
      expect(backButton(host)).toBeUndefined();

      button(host, 'Done')!.click();
      await until(() => backButton(host), 'the way back once done');
    } finally {
      scrolls.restore();
    }
  });

  it('reads a line linked from the cast without being pulled to the line being read', async () => {
    const story = await storeStory(frame);
    playingAt(story.partId, 1);
    const scrolls = watchScrolls();
    try {
      const host = await mountView(ReaderView, {
        id: story.storyId,
        partId: story.partId,
        line: 4,
      });
      await until(() => scrolls.scrolled.length, 'the linked line');
      playingAt(story.partId, 2);
      await settle();
      expect(indexes(scrolls)).toEqual([4]);

      layOut(host, (index) => (index < 3 ? 'above' : 'on'));
      const back = await until(() => backButton(host), 'the way back');
      expect(back.textContent).toContain('↑');

      // Back there, the page follows the lines read after it smoothly.
      back.click();
      await until(() => indexes(scrolls).length === 2, 'the line being read');
      expect(scrolls.scrolled.at(-1)).toEqual([2, 'smooth']);
      playingAt(story.partId, 3);
      await until(() => indexes(scrolls).length === 3, 'the next line');
      expect(scrolls.scrolled.at(-1)).toEqual([3, 'smooth']);
    } finally {
      scrolls.restore();
    }
  });

  it('keeps the way back to a place being listened to when the reader is opened again', async () => {
    const story = await storeStory(frame);
    const next = await addNarratedPart(story, ['Years later. ', 'It rained.']);
    playingAt(story.partId, 5);
    const scrolls = watchScrolls();
    try {
      let router: Router | undefined;
      const host = await mountRouted(
        ReaderView,
        { name: 'reader', params: { id: story.storyId, partId: next.id } },
        (r) => (router = r),
      );
      await until(() => backButton(host), 'the way back');
      // On the cast page a voice preview stops the story, where it was.
      await router!.push({ name: 'cast', params: { id: story.storyId } });
      await until(() => !lines(host).length, 'the reader to close');
      playerSnapshot.value = { ...playerSnapshot.value, state: 'idle' };
      router!.back();
      await until(() => lines(host).length === 2, 'the reader again');

      const back = await until(() => backButton(host), 'the way back again');
      expect(back.textContent).toContain('↑');
      // The part being listened to keeps its place.
      host.querySelector<HTMLElement>('[aria-label="Previous part"]')!.click();
      await until(() => lines(host).length === frame.length, 'the part being listened to');
      await until(() => indexes(scrolls).at(-1) === 5, 'its line');
      expect(jumped).not.toHaveBeenCalled();
    } finally {
      scrolls.restore();
    }
  });

  it.each(['paused', 'playing'] as const)(
    'goes to the place in a part gone to while fixing speakers once Done (%s)',
    async (state) => {
      const story = await storeStory(frame);
      const next = await addNarratedPart(story, ['A. ', 'B. ', 'C. ', 'D. ', 'E.']);
      playerSnapshot.value = { state, speed: 1, position: { partId: next.id, segmentIndex: 3 } };
      const scrolls = watchScrolls();
      try {
        const host = await mountRouted(ReaderView, {
          name: 'reader',
          params: { id: story.storyId, partId: story.partId },
        });
        await until(() => backButton(host), 'the way back');
        button(host, 'Fix speakers')!.click();
        await until(() => host.querySelector('.text.editing'), 'Fix speakers');
        host.querySelector<HTMLElement>('[aria-label="Next part"]')!.click();
        await until(() => lines(host).length === 5, 'the part being listened to');
        // While fixing, the page stays at the top of the part.
        await settle();
        expect(scrolls.scrolled).toEqual([]);

        button(host, 'Done')!.click();
        await until(() => scrolls.scrolled.length, 'the place');
        expect(scrolls.scrolled).toEqual([[3, 'auto']]);
        expect(jumped).not.toHaveBeenCalled();
      } finally {
        scrolls.restore();
      }
    },
  );

  it('carries on after Done once fixing went to the part being listened to', async () => {
    const story = await storeStory(frame);
    const second = await addNarratedPart(story, ['Years later. ', 'It rained.']);
    playingAt(story.partId, 3);
    // Opened from the second part's row while the first plays.
    const host = await mountRouted(ReaderView, {
      name: 'reader',
      params: { id: story.storyId, partId: second.id },
    });
    await until(() => lines(host).length === 2, 'the part');
    button(host, 'Fix speakers')!.click();
    await until(() => host.querySelector('.text.editing'), 'Fix speakers');
    await until(() => playerSnapshot.value.state === 'paused', 'the pause');
    host.querySelector<HTMLElement>('[aria-label="Previous part"]')!.click();
    await until(() => lines(host).length === frame.length, 'the part being listened to');
    button(host, 'Done')!.click();
    await until(() => resumed.mock.calls.length, 'playback to carry on');
    expect(jumped).not.toHaveBeenCalled();
    expect(played).not.toHaveBeenCalled();
  });

  it('leaves the page where fixing speakers left it once Done', async () => {
    const story = await storeStory(frame);
    const { host, scrolls } = await reading(story);
    try {
      button(host, 'Fix speakers')!.click();
      await until(() => host.querySelector('.text.editing'), 'Fix speakers');
      button(host, 'Done')!.click();
      await until(() => resumed.mock.calls.length, 'playback to carry on');
      await settle();
      expect(scrolls.scrolled).toEqual([[1, 'auto']]);
    } finally {
      scrolls.restore();
    }
  });

  it('gives the line no focus once Next part overtakes the way back', async () => {
    const story = await storeStory(frame);
    const second = await addNarratedPart(story, ['Years later. ', 'It rained.']);
    playingAt(second.id, 1);
    const scrolls = watchScrolls();
    try {
      const host = await mountRouted(ReaderView, {
        name: 'reader',
        params: { id: story.storyId, partId: story.partId },
      });
      const back = await until(() => backButton(host), 'the way back');
      const next = host.querySelector<HTMLElement>('[aria-label="Next part"]')!;
      back.click();
      // Before the playing part's lines show, Next part goes there too.
      next.focus();
      next.click();
      await until(() => lines(host).length === 2, 'the playing part');
      await until(() => indexes(scrolls).at(-1) === 1, 'its line');
      await settle();
      expect(document.activeElement).toBe(next);
      expect(host.querySelector('.segment[tabindex]')).toBeNull();
    } finally {
      scrolls.restore();
    }
  });

  it('gives no line the focus later once the way back was scrolled away from', async () => {
    const story = await storeStory(frame);
    const second = await addNarratedPart(story, ['Years later. ', 'It rained.']);
    playingAt(second.id, 1);
    const clock = stopClock();
    try {
      let router: Router | undefined;
      const host = await mountRouted(
        ReaderView,
        { name: 'reader', params: { id: story.storyId, partId: story.partId } },
        (r) => (router = r),
      );
      await until(() => lines(host).length === frame.length, 'the lines');
      (await until(() => backButton(host), 'the way back')).click();
      // A finger moves before the playing part's lines show.
      window.dispatchEvent(new Event('touchmove'));
      await until(() => router!.currentRoute.value.params.partId === second.id, 'the playing part');
      await until(() => lines(host).length === 2, 'its lines');

      // A while later the reader taps a line there, and the page follows again.
      clock.wait(1000);
      lines(host)[0]!.click();
      await until(() => played.mock.calls.length, 'playback from the line');
      await settle();
      expect(host.querySelector('.segment[tabindex]')).toBeNull();
    } finally {
      clock.restore();
    }
  });

  it.each(['paused', 'playing'] as const)(
    'offers no way back while the player is still on its way to the part gone to (%s)',
    async (state) => {
      const story = await storeStory(frame);
      const next = await addNarratedPart(story, ['Years later. ', 'It rained.']);
      playerSnapshot.value = {
        state,
        speed: 1,
        position: { partId: story.partId, segmentIndex: 1 },
      };
      // As on Android: the player moves once its engine has stopped, after the page has.
      const release = holdJumps();
      const host = await mountRouted(ReaderView, {
        name: 'reader',
        params: { id: story.storyId, partId: story.partId },
      });
      await until(() => lines(host).length === frame.length, 'the lines');
      host.querySelector<HTMLElement>('[aria-label="Next part"]')!.click();
      await until(() => lines(host).length === 2, 'the next part');
      await settle();
      expect(backButton(host)).toBeUndefined();

      release();
      await until(() => playerSnapshot.value.position?.partId === next.id, 'the player there');
      await settle();
      expect(backButton(host)).toBeUndefined();
    },
  );

  it('keeps its part while the player moves on, and goes to the playing part when asked', async () => {
    const story = await storeStory(frame);
    const next = await addNarratedPart(story, ['Years later. ', 'It rained.']);
    playingAt(story.partId, 6);
    const scrolls = watchScrolls();
    const focus = watchFocus();
    try {
      let router: Router | undefined;
      // Opened as Continue opens it: on the part being read, not one the route names.
      const host = await mountRouted(
        ReaderView,
        { name: 'reader', params: { id: story.storyId } },
        (r) => (router = r),
      );
      await until(() => scrolls.scrolled.length, 'the page to open on the line');

      window.dispatchEvent(new WheelEvent('wheel'));
      await until(
        () => router!.currentRoute.value.params.partId === story.partId,
        'the part kept in the route',
      );
      playingAt(next.id, 0);
      await settle();
      expect(router!.currentRoute.value.params.partId).toBe(story.partId);
      expect(lines(host)).toHaveLength(frame.length);

      const back = await until(() => backButton(host), 'the way back');
      expect(back.textContent).toContain('↓');
      back.focus();
      back.click();
      await until(() => router!.currentRoute.value.params.partId === next.id, 'the playing part');
      await until(() => lines(host).length === 2, 'its lines');
      await until(() => indexes(scrolls).at(-1) === 0, 'the line being read');
      // At once, as when the page opens on a part.
      expect(scrolls.scrolled.at(-1)).toEqual([0, 'auto']);
      await until(() => focus.focused.length, 'the line to take the focus');
      expect(focus.focused).toEqual([['-1', { preventScroll: true }]]);
      expect(document.activeElement).toBe(lines(host)[0]);

      // The focus stays there while the page follows the lines read after it.
      playingAt(next.id, 1);
      await until(() => indexes(scrolls).at(-1) === 1, 'the next line');
      await settle();
      expect(document.activeElement).toBe(lines(host)[0]);
      expect(focus.focused).toHaveLength(1);
    } finally {
      focus.restore();
      scrolls.restore();
    }
  });
});

describe('a line linked from the cast', () => {
  it('is marked and scrolled to, without playing', async () => {
    const story = await storeStory(frame);
    const scrolled: Element[] = [];
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
    ) {
      scrolled.push(this);
    });
    try {
      const host = await mountView(ReaderView, {
        id: story.storyId,
        partId: story.partId,
        line: 4,
      });
      await until(() => lines(host).length === frame.length, 'the lines');
      const target = await until(() => host.querySelector('.segment.target'), 'the marked line');
      expect(target.textContent).toBe('“Hush,”');
      await until(() => scrolled.includes(target), 'the scroll');
      expect(host.querySelector('.segment.current')).toBeNull();
    } finally {
      scroll.mockRestore();
    }
  });
});

describe('the back link', () => {
  const back = (host: HTMLElement) => host.querySelector<HTMLAnchorElement>('nav.top a')!;
  /** Opens the reader on `partId` once its lines show; gives the back link's target and text. */
  async function backFrom(story: StoredStory, partId: string, count: number) {
    const host = await mountView(ReaderView, { id: story.storyId, partId });
    await until(() => lines(host).length === count, 'the lines');
    return { href: back(host).getAttribute('href'), text: back(host).textContent?.trim() };
  }

  it('goes to the story when it has no books', async () => {
    const story = await storeStory(frame);
    expect(await backFrom(story, story.partId, frame.length)).toEqual({
      href: `/story/${story.storyId}`,
      text: '← Story',
    });
  });

  it('goes to the shown part’s book, named, when the story has books', async () => {
    const story = await storeStory(frame);
    // The story's part becomes the first book's; a second book gets a part of its own.
    const second = await addBook(db, story.storyId, 'The Heights');
    const first = (await getStory(db, story.storyId))!.books![0]!;
    await renameBook(db, story.storyId, first.id, 'The Grange');
    const later = await addPart(db, story.storyId, {
      title: 'Two',
      source: { kind: 'paste' },
      text: 'Years later.',
      bookId: second.id,
    });
    await saveAnalysis(db, {
      partId: later.id,
      textHash: later.textHash,
      analyzer: { kind: 'heuristic', version: 2 },
      createdAt: new Date().toISOString(),
      segments: [{ start: 0, end: 12, speakerId: story.ids.N!, mode: 'narration', source: 'user' }],
    });

    expect(await backFrom(story, story.partId, frame.length)).toEqual({
      href: `/story/${story.storyId}/book/${first.id}`,
      text: '← The Grange',
    });
    unmountView();
    expect(await backFrom(story, later.id, 1)).toEqual({
      href: `/story/${story.storyId}/book/${second.id}`,
      text: '← The Heights',
    });
  });
});
