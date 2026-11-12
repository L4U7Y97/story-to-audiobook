import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lang, Segment } from '@/format/types';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { getStory } from '@/storage/stories';
import ReaderView from '@/ui/views/ReaderView.vue';
import {
  button,
  db,
  mountView,
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

afterEach(unmountView);

const lines = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.segment')];
const tint = (el: Element | null | undefined) =>
  (el as HTMLElement | null | undefined)?.style.getPropertyValue('--tint');

/** Opens the reader on a stored one-part story, in "Fix speakers" mode. */
async function fixSpeakers(
  chunks: Chunk[],
  characters: Array<{ name: string; aliases?: string[] }>,
  lang: Lang = 'en',
) {
  const story = await storeStory(chunks, { characters, lang });
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
    expect((await getStory(db, story.storyId))!.cast).toHaveLength(3);
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

  it('reads a new character’s name in the story’s language', async () => {
    // The narrator reads with the device's first voice, a man's. A pick that ignored the traits
    // would take the next voice, whose name tells nothing.
    stubVoices.push(
      { name: 'Microsoft Pablo - Spanish (Spain)', lang: 'es-ES' },
      { name: 'es-plain', lang: 'es-ES' },
      { name: 'Microsoft Helena - Spanish (Spain)', lang: 'es-ES' },
    );
    const { story, host } = await fixSpeakers(
      [
        ['—¿Dónde estabas?', 'U', 'speech'],
        [' —preguntó Tom.', 'N', 'narration'],
      ],
      [{ name: 'Tom' }],
      'es',
    );
    const sheet = await tap(host, 0);
    typeInto(sheet.querySelector<HTMLInputElement>('form.new input')!, 'la abuela');
    submit(sheet.querySelector('form.new')!);
    const added = await until(
      async () => (await getStory(db, story.storyId))!.cast.find((c) => c.name === 'la abuela'),
      'la abuela in the cast',
    );
    expect(added).toMatchObject({
      gender: 'female',
      age: 'elder',
      voice: { voiceName: 'Microsoft Helena - Spanish (Spain)', lang: 'es-ES' },
    });
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
