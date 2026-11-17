import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Character } from '@/format/types';
import { getStory, updateStory } from '@/storage/stories';
import CastView from '@/ui/views/CastView.vue';
import {
  button,
  castChanged,
  db,
  holdVoices,
  mountView,
  previewed,
  stopped,
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

// Watson told an earlier part, and the analysis made him a character there.
const holmes: Chunk[] = [
  ['“Come in, Watson,”', 'Holmes', 'speech'],
  [' said Holmes.\n\n', 'N', 'narration'],
  ['“Thank you,”', 'Watson', 'speech'],
  [' said Watson.', 'N', 'narration'],
];

/** Opens the Cast view on a stored story. */
async function openCast(story: StoredStory) {
  const host = await mountView(CastView, { id: story.storyId });
  const members = (await getStory(db, story.storyId))!.cast.length;
  await until(() => host.querySelectorAll('li.card').length === members, 'the cards');
  return host;
}

/** Opens a member's card, as a tap on its row does, and gives it back once it shows. */
async function openCard(card: HTMLElement): Promise<HTMLElement> {
  card.querySelector<HTMLButtonElement>('h3 .toggle')!.click();
  await until(() => card.querySelector<HTMLElement>('.body')!.style.display !== 'none', 'open');
  return card;
}

function cardOf(host: HTMLElement, name: string): HTMLElement {
  const card = [...host.querySelectorAll<HTMLElement>('li.card')].find(
    (li) => li.querySelector('h3')?.textContent?.trim() === name,
  );
  if (!card) throw new Error(`no card for ${name}`);
  return card;
}

/** Opens a member's ⋯ menu, as a tap on it does. */
function openMenu(card: HTMLElement): HTMLDetailsElement {
  const menu = card.querySelector<HTMLDetailsElement>('.member-menu')!;
  menu.open = true;
  menu.dispatchEvent(new Event('toggle'));
  return menu;
}

/**
 * Saves a card's names as the user does: a new name with Rename in its ⋯ menu, other names in
 * the card's "Other names" field.
 */
async function saveNames(
  card: HTMLElement,
  { name, aliases }: { name?: string; aliases?: string },
) {
  if (name !== undefined) {
    const menu = openMenu(card);
    button(menu, 'Rename')!.click();
    const input = await until(
      () => menu.querySelector<HTMLInputElement>('.rename input'),
      'Rename',
    );
    typeInto(input, name);
    submit(menu.querySelector('.rename')!);
  }
  if (name !== undefined && aliases === undefined) return;
  const input = card.querySelector<HTMLInputElement>('.editor .fields input')!;
  if (aliases !== undefined) typeInto(input, aliases);
  submit(card.querySelector('.editor .fields')!);
}

/** A refused name: said in the card's editor (other names) or in the bar (a rename). */
const clash = (card: HTMLElement) => card.querySelector('.editor .fields [role="alert"]');
const clashShown = (card: HTMLElement) =>
  until(
    () =>
      clash(card)?.textContent?.trim() ||
      document.querySelector('.snackbar .snack-text')?.textContent?.trim(),
    'the name clash',
  );

/** Opens the merge sheet from a member's ⋯ menu ("Same person as…", "Give all these lines…"). */
async function openMergeSheet(card: HTMLElement): Promise<HTMLElement> {
  const menu = openMenu(card);
  button(menu, /Same person as…|Give all these lines/u)!.click();
  return until(() => document.querySelector<HTMLElement>('[role="dialog"]'), 'the merge sheet');
}

/** Merges the card's member into `target` through its ⋯ menu and the merge sheet. */
async function mergeInto(card: HTMLElement, target: string) {
  const sheet = await openMergeSheet(card);
  button(sheet, target)!.click();
  await until(() => !button(sheet, 'Merge')!.disabled, 'Merge');
  button(sheet, 'Merge')!.click();
  await until(() => !document.querySelector('[role="dialog"]'), 'the sheet to close');
}

describe('a name another member has', () => {
  it('is refused under “Other names” too, with a hint to merge', async () => {
    const story = await storeStory([
      ['“Hello,”', 'Elizabeth', 'speech'],
      [' said Elizabeth.\n\n', 'N', 'narration'],
      ['“Hi,”', 'Jane', 'speech'],
      [' said Jane.', 'N', 'narration'],
    ]);
    const host = await openCast(story);
    await saveNames(cardOf(host, 'Elizabeth'), { aliases: 'Lizzy, Jane' });
    expect(await clashShown(cardOf(host, 'Elizabeth'))).toBe(
      '“Jane” is already in the cast. Use “Same person as…” in the ⋯ menu to merge them.',
    );
    const cast = (await getStory(db, story.storyId))!.cast;
    expect(cast.find((c) => c.id === story.ids.Elizabeth)!.aliases).toEqual([]);
  });

  it('sends the narrator’s editor to the other member’s card to merge', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    await saveNames(cardOf(host, 'Narrator'), { aliases: 'Watson' });
    expect(await clashShown(cardOf(host, 'Narrator'))).toBe(
      '“Watson” is already in the cast. If Watson tells the whole story, use “Same person as…” ' +
        'in Watson’s ⋯ menu and choose Narrator.',
    );
    expect((await getStory(db, story.storyId))!.cast[0]!.aliases).toEqual([]);
  });

  it('points the unknown speaker’s editor to giving its lines away', async () => {
    const host = await openCast(await storeStory(holmes));
    await saveNames(cardOf(host, 'Unknown speaker'), { name: 'Holmes' });
    expect(await clashShown(cardOf(host, 'Unknown speaker'))).toBe(
      '“Holmes” is already in the cast. To have Holmes read these lines, use “Give all these ' +
        'lines to…” in the ⋯ menu.',
    );
  });

  it('sends the editor to the unknown speaker’s card to free a name merged into it', async () => {
    // Not "Same person as…": merging Holmes into the unknown speaker would remove him.
    const story = await storeStory([
      ...holmes.slice(0, 2),
      ['“Who is there?”', 'a voice', 'speech'],
      [' asked a voice.', 'N', 'narration'],
    ]);
    const host = await openCast(story);
    await mergeInto(cardOf(host, 'a voice'), 'Unknown speaker');
    await until(() => cardOf(host, 'Unknown speaker').textContent?.includes('“a voice”'), 'merge');
    await saveNames(cardOf(host, 'Holmes'), { aliases: 'a voice' });
    expect(await clashShown(cardOf(host, 'Holmes'))).toBe(
      '“a voice” is already in the cast as “Unknown speaker”. To give it to Holmes, first remove ' +
        'it from Unknown speaker’s other names.',
    );
    await saveNames(cardOf(host, 'Narrator'), { aliases: 'a voice' });
    expect(await clashShown(cardOf(host, 'Narrator'))).toBe(
      '“a voice” is already in the cast as “Unknown speaker”. To give it to Narrator, first ' +
        'remove it from Unknown speaker’s other names.',
    );
    // Doing so frees the name.
    await saveNames(cardOf(host, 'Unknown speaker'), { aliases: '' });
    await until(() => !cardOf(host, 'Unknown speaker').textContent?.includes('“a voice”'), 'save');
    await saveNames(cardOf(host, 'Holmes'), { aliases: 'a voice' });
    await until(() => cardOf(host, 'Holmes').textContent?.includes('also “a voice”'), 'the save');
    const cast = (await getStory(db, story.storyId))!.cast;
    expect(cast.map((c) => [c.name, c.aliases])).toEqual([
      ['Narrator', []],
      ['Unknown speaker', []],
      ['Holmes', ['a voice']],
    ]);
  });

  it('sends the editor to rename the unknown speaker when it is called that', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const names = () => [...host.querySelectorAll('li.card h3')].map((h) => h.textContent?.trim());
    await saveNames(cardOf(host, 'Unknown speaker'), { name: 'Crowd' });
    await until(() => names().includes('Crowd'), 'the rename');
    await saveNames(cardOf(host, 'Holmes'), { name: 'crowd' });
    expect(await clashShown(cardOf(host, 'Holmes'))).toBe(
      '“crowd” is already in the cast. To give it to Holmes, first rename Crowd (⋯ menu).',
    );
    const cast = (await getStory(db, story.storyId))!.cast;
    expect(cast.map((c) => c.name)).toEqual(['Narrator', 'Crowd', 'Holmes', 'Watson']);
  });

  it('includes “Narrator” typed as a character’s name', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    await saveNames(cardOf(host, 'Holmes'), { name: 'Narrator' });
    expect(await clashShown(cardOf(host, 'Holmes'))).toBe(
      '“Narrator” is already in the cast. Use “Same person as…” in the ⋯ menu to merge them.',
    );
    const cast = (await getStory(db, story.storyId))!.cast;
    expect(cast.map((c) => c.name)).toEqual(['Narrator', 'Unknown speaker', 'Holmes', 'Watson']);
  });

  it('is refused as the new name when the member already has it as an other name', async () => {
    const story = await storeStory(holmes);
    // Saved before names were checked: the narrator's other name "Watson" is Watson's name.
    const { cast } = (await getStory(db, story.storyId))!;
    await updateStory(db, story.storyId, {
      cast: cast.map((c) => (c.id === story.ids.N ? { ...c, aliases: ['Watson'] } : c)),
    });
    const host = await openCast(story);
    await saveNames(cardOf(host, 'Narrator'), { name: 'Watson' });
    expect(await clashShown(cardOf(host, 'Narrator'))).toBe(
      '“Watson” is already in the cast. If Watson tells the whole story, use “Same person as…” ' +
        'in Watson’s ⋯ menu and choose Narrator.',
    );
    const saved = (await getStory(db, story.storyId))!.cast;
    expect(saved.map((c) => c.name)).toEqual(['Narrator', 'Unknown speaker', 'Holmes', 'Watson']);
  });

  it('includes “Narrator” saved as a character’s other name, then typed as its name', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    await saveNames(cardOf(host, 'Holmes'), { aliases: 'Narrator' });
    await until(() => cardOf(host, 'Holmes').textContent?.includes('also “Narrator”'), 'the save');
    await saveNames(cardOf(host, 'Holmes'), { name: 'Narrator' });
    expect(await clashShown(cardOf(host, 'Holmes'))).toBe(
      '“Narrator” is already in the cast. Use “Same person as…” in the ⋯ menu to merge them.',
    );
    const cast = (await getStory(db, story.storyId))!.cast;
    expect(cast.map((c) => c.name)).toEqual(['Narrator', 'Unknown speaker', 'Holmes', 'Watson']);
  });

  it('stops being shown once the merge it suggests is done, also after later merges', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    await saveNames(cardOf(host, 'Narrator'), { aliases: 'Watson' });
    await clashShown(cardOf(host, 'Narrator'));
    await mergeInto(cardOf(host, 'Watson'), 'Narrator');
    await until(() => cardOf(host, 'Narrator').textContent?.includes('also “Watson”'), 'merge');
    expect(clash(cardOf(host, 'Narrator'))).toBeNull();
    // The narrator then gives its lines and names, "Watson" included, to Holmes.
    await mergeInto(cardOf(host, 'Narrator'), 'Holmes');
    await until(() => cardOf(host, 'Holmes').textContent?.includes('also “Watson”'), 'merge');
    expect(clash(cardOf(host, 'Narrator'))).toBeNull();
  });
});

describe('renaming', () => {
  it('un-names the narrator renamed back to “Narrator”, keeping no old name', async () => {
    const story = await storeStory(holmes);
    const { cast } = (await getStory(db, story.storyId))!;
    await updateStory(db, story.storyId, {
      cast: cast.map((c) => (c.id === story.ids.N ? { ...c, name: 'Nick' } : c)),
    });
    const host = await openCast(story);
    await saveNames(cardOf(host, 'Nick'), { name: 'Narrator' });
    const narrator = await until(async () => {
      const n = (await getStory(db, story.storyId))!.cast[0];
      return n?.name === 'Narrator' ? n : undefined;
    }, 'the rename');
    expect(narrator.aliases).toEqual([]);
  });
});

it('shows the narrator in its own colour, as the reader does', async () => {
  const host = await openCast(await storeStory(holmes));
  const tint = (name: string) => cardOf(host, name).style.getPropertyValue('--tint');
  expect(tint('Narrator')).toBe('var(--narrator)');
  expect(tint('Unknown speaker')).toBe('var(--speaker-0)');
  expect(tint('Holmes')).toBe('var(--speaker-1)');
});

describe('the cast search', () => {
  const shownNames = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('li.card')]
      .filter((li) => li.style.display !== 'none')
      .map((li) => li.querySelector('h3')?.textContent?.trim());
  const search = (host: HTMLElement) => host.querySelector<HTMLInputElement>('.cast-filter input')!;

  it('shows only the members whose name or other names match', async () => {
    const host = await openCast(await storeStory(holmes));
    typeInto(search(host), 'm');
    await until(() => shownNames(host).length === 1, 'the first filtered cast');
    expect(shownNames(host)).toEqual(['Holmes']);

    typeInto(search(host), 'mo');
    await until(() => host.querySelector('[role="status"]'), 'the updated no-match note');
    expect(shownNames(host)).toEqual([]);

    typeInto(search(host), 'wat');
    await until(() => shownNames(host).length === 1, 'the filtered cast');
    expect(shownNames(host)).toEqual(['Watson']);
  });

  it('updates while the keyboard is composing text', async () => {
    const host = await openCast(await storeStory(holmes));
    const input = search(host);
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'wat';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await until(() => shownNames(host).length === 1, 'the live composed-text filter');
    expect(shownNames(host)).toEqual(['Watson']);
  });

  it('says when nobody matches, and the clear button brings everyone back', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    typeInto(search(host), 'Moriarty');
    const status = await until(() => host.querySelector('[role="status"]'), 'the no-match note');
    expect(status.textContent).toContain('“Moriarty”');
    expect(shownNames(host)).toEqual([]);
    host.querySelector<HTMLButtonElement>('.cast-filter .clear')!.click();
    const members = (await getStory(db, story.storyId))!.cast.length;
    await until(() => shownNames(host).length === members, 'the whole cast');
    expect(search(host).value).toBe('');
    // Focus goes back to the box, not to the page behind it.
    expect(document.activeElement).toBe(search(host));
  });

  it('keeps what is typed in a card’s editor while the card is searched out of view', async () => {
    const host = await openCast(await storeStory(holmes));
    const editor = cardOf(host, 'Watson').querySelector<HTMLDetailsElement>('details.names')!;
    editor.open = true;
    const nameInput = editor.querySelector<HTMLInputElement>('.editor .fields input')!;
    typeInto(nameInput, 'John Watson');
    typeInto(search(host), 'holm');
    await until(() => !shownNames(host).includes('Watson'), 'Watson hidden');
    typeInto(search(host), '');
    await until(() => shownNames(host).includes('Watson'), 'Watson back');
    expect(cardOf(host, 'Watson').querySelector<HTMLDetailsElement>('details.names')!.open).toBe(
      true,
    );
    expect(
      cardOf(host, 'Watson').querySelector<HTMLInputElement>('.editor .fields input')!.value,
    ).toBe('John Watson');
  });
});

describe('a member’s lines', () => {
  it('lists them, each linking to its line in the reader', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const lines = cardOf(host, 'Holmes').querySelector<HTMLDetailsElement>('details.lines')!;
    expect(lines.querySelector('summary')!.textContent).toContain('Holmes’s lines');
    lines.open = true;
    lines.dispatchEvent(new Event('toggle'));
    const links = await until(() => {
      const found = [...lines.querySelectorAll<HTMLAnchorElement>('a')];
      return found.length ? found : undefined;
    }, 'the links');
    expect(links.map((a) => a.querySelector('.line-text')!.textContent)).toEqual([
      '“Come in, Watson,”',
    ]);
    expect(links[0]!.getAttribute('href')).toBe(
      `/story/${story.storyId}/read/${story.partId}?line=0`,
    );

    const narrator = cardOf(host, 'Narrator').querySelector<HTMLDetailsElement>('details.lines')!;
    narrator.open = true;
    narrator.dispatchEvent(new Event('toggle'));
    await until(() => narrator.querySelectorAll('a').length === 2, 'the narrator’s links');
    expect(narrator.querySelectorAll('a')[1]!.getAttribute('href')).toContain('?line=3');
  });

  it('is not offered to a member with no lines', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    expect(cardOf(host, 'Unknown speaker').querySelector('details.lines')).toBeNull();
  });
});

// Voices whose names tell their gender, and one whose name tells nothing.
const zira = { name: 'Microsoft Zira - English (United States)', lang: 'en-US' };
const jenny = { name: 'Microsoft Jenny - English (United States)', lang: 'en-US' };
const david = { name: 'Microsoft David - English (United States)', lang: 'en-US' };
const plain = { name: 'en-plain', lang: 'en-US' };

const KEPT =
  'Traits changed; the voice you set by hand was kept. Use “Re-pick voice” to choose one that ' +
  'matches.';

const traitsOf = (card: HTMLElement) => card.querySelector<HTMLDetailsElement>('details.traits')!;
const traitsSummary = (card: HTMLElement) =>
  traitsOf(card).querySelector('summary')!.textContent?.trim();
const keptNote = (card: HTMLElement) => traitsOf(card).querySelector('.warning');
/** The card's voice button, which opens the voice sheet; `data-voice` is the voice chosen. */
const voiceButton = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('.voice-button')!;
/** The open voice sheet. */
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
/** The sheet's row for the voice called `name` ('' the device default). */
const sheetRow = (name: string) => sheet()?.querySelector<HTMLElement>(`li[data-voice="${name}"]`);
const optionLabels = (select: HTMLSelectElement) =>
  [...select.options].map((o) => o.textContent?.trim());

/** The list under `label` ("Gender", "Age", "Species", "Size") in a card's traits. */
function traitSelect(card: HTMLElement, label: string): HTMLSelectElement {
  const found = [...traitsOf(card).querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  if (!found) throw new Error(`no ${label} list`);
  return found.querySelector('select')!;
}

/** Picks the option shown as `option` in a card's `label` list, as a tap on it does. */
function chooseTrait(card: HTMLElement, label: string, option: string) {
  const select = traitSelect(card, label);
  select.value = [...select.options].find((o) => o.textContent?.trim() === option)!.value;
  select.dispatchEvent(new Event('change'));
}

/** Picks the device voice called `name` ('' is the device default) in a card's voice sheet. */
async function chooseVoice(card: HTMLElement, name: string) {
  voiceButton(card).click();
  const row = await until(() => sheetRow(name), `the voice ${name}`);
  const use = button(row, 'Use');
  if (use) use.click();
  else button(sheet()!, 'Done')!.click();
  await until(() => !sheet(), 'the sheet to close');
}

/** The stored member `id`, once `saved` holds for it. */
function storedMember(story: StoredStory, id: string, saved: (member: Character) => boolean) {
  return until(async () => {
    const member = (await getStory(db, story.storyId))!.cast.find((c) => c.id === id);
    return member && saved(member) ? member : undefined;
  }, 'the save');
}

/** Holds once the view has told the player of `times` changes to the cast, and of no more. */
async function playerTold(times: number) {
  await until(() => castChanged.mock.calls.length >= times, 'the player to be told');
  expect(castChanged).toHaveBeenCalledTimes(times);
}

/** Time enough for a save that wrongly did not wait for something to land. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 200));

describe('a member’s traits', () => {
  it('are summarised on the card: “not set”, then the ones chosen', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const card = cardOf(host, 'Holmes');
    expect(traitsSummary(card)).toBe('Traits: not set');

    chooseTrait(card, 'Gender', 'Female');
    await until(() => traitsSummary(card) === 'Traits: female', 'the gender');
    chooseTrait(card, 'Age', 'Child');
    await until(() => traitsSummary(card) === 'Traits: female · child', 'the age');
    const saved = await storedMember(story, story.ids.Holmes!, (m) => m.age === 'child');
    expect(saved).toMatchObject({ gender: 'female', age: 'child' });

    // Back to "Not set" removes the trait rather than storing an empty one.
    chooseTrait(card, 'Gender', 'Not set');
    await until(() => traitsSummary(card) === 'Traits: child', 'the gender to go');
    const cleared = await storedMember(story, story.ids.Holmes!, (m) => m.gender === undefined);
    expect(Object.keys(cleared)).not.toContain('gender');
    expect(cleared.age).toBe('child');
  });

  it('show what the member was stored with', async () => {
    const story = await storeStory(holmes, {
      characters: [{ name: 'Rex', age: 'elder', species: 'creature', size: 'large' }],
    });
    const host = await openCast(story);
    const card = cardOf(host, 'Rex');
    expect(traitsSummary(card)).toBe('Traits: elderly · fantasy · large');
    expect(traitSelect(card, 'Gender').value).toBe('');
    expect(traitSelect(card, 'Age').value).toBe('elder');
    expect(traitSelect(card, 'Species').value).toBe('creature');
    expect(traitSelect(card, 'Size').value).toBe('large');
    expect(optionLabels(traitSelect(card, 'Size'))).toEqual(['Average', 'Small', 'Large']);
  });

  it('pick the member’s voice again: a woman’s voice for a character set to female', async () => {
    // The narrator reads with David; a pick that ignored the gender would take the plain voice.
    stubVoices.push(david, plain, zira);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    chooseTrait(cardOf(host, 'Holmes'), 'Gender', 'Female');
    const saved = await storedMember(story, story.ids.Holmes!, (m) => m.gender === 'female');
    expect(saved.voice.voiceName).toBe(zira.name);
    expect(saved.voice.manual).toBeUndefined();
    await until(
      () => voiceButton(cardOf(host, 'Holmes')).dataset.voice === zira.name,
      'the new voice',
    );
    expect(keptNote(cardOf(host, 'Holmes'))).toBeNull();
    // A story being played takes the new voice up from its next line.
    await playerTold(1);
  });

  it('say why a change was not saved, until the next change is', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const card = await openCard(cardOf(host, 'Holmes'));
    // Said in the card the change was made in.
    const error = () => card.querySelector('.card-note.error');
    expect(error()).toBeNull();

    const failing = () => {
      throw new Error('disk full');
    };
    db.stories.hook('updating', failing);
    try {
      chooseTrait(card, 'Gender', 'Female');
      const shown = await until(error, 'the error');
      expect(shown.textContent?.trim()).toBe('disk full');
      expect(shown.getAttribute('role')).toBe('alert');
    } finally {
      db.stories.hook('updating').unsubscribe(failing);
    }
    const unsaved = (await getStory(db, story.storyId))!.cast.find(
      (c) => c.id === story.ids.Holmes,
    )!;
    expect(Object.keys(unsaved)).not.toContain('gender');
    // The player is told of nothing: the cast is as it was.
    expect(castChanged).not.toHaveBeenCalled();

    chooseTrait(card, 'Gender', 'Female');
    await storedMember(story, story.ids.Holmes!, (m) => m.gender === 'female');
    await until(() => !error(), 'the error to go');
    await playerTold(1);
  });

  it('keep a voice set by hand and say so, until “Re-pick voice” replaces it', async () => {
    stubVoices.push(david, zira);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const card = cardOf(host, 'Holmes');
    await chooseVoice(card, david.name);
    await storedMember(story, story.ids.Holmes!, (m) => m.voice.voiceName === david.name);
    await playerTold(1);

    chooseTrait(card, 'Gender', 'Female');
    const kept = await storedMember(story, story.ids.Holmes!, (m) => m.gender === 'female');
    expect(kept.voice).toMatchObject({ voiceName: david.name, manual: true });
    const note = await until(() => keptNote(card), 'the note');
    expect(note.textContent?.trim().replace(/\s+/gu, ' ')).toBe(KEPT);
    // Nobody else's card says it.
    expect(keptNote(cardOf(host, 'Watson'))).toBeNull();
    await playerTold(2);

    button(traitsOf(card), 'Re-pick voice')!.click();
    const repicked = await storedMember(
      story,
      story.ids.Holmes!,
      (m) => m.voice.voiceName === zira.name,
    );
    expect(repicked.gender).toBe('female');
    expect('manual' in repicked.voice).toBe(false);
    await until(() => !keptNote(card), 'the note to go');
    await playerTold(3);
  });

  it('stop saying a hand-set voice was kept once another is chosen by hand', async () => {
    stubVoices.push(david, zira);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const card = cardOf(host, 'Holmes');
    await chooseVoice(card, david.name);
    await storedMember(story, story.ids.Holmes!, (m) => m.voice.manual === true);
    chooseTrait(card, 'Gender', 'Female');
    await until(() => keptNote(card), 'the note');

    await chooseVoice(card, zira.name);
    await storedMember(story, story.ids.Holmes!, (m) => m.voice.voiceName === zira.name);
    await until(() => !keptNote(card), 'the note to go');
  });

  it('say nothing about a hand-set voice when the trait chosen is the one it has', async () => {
    stubVoices.push(david, zira);
    const story = await storeStory(holmes, { characters: [{ name: 'Holmes', gender: 'male' }] });
    const host = await openCast(story);
    const card = cardOf(host, 'Holmes');
    await chooseVoice(card, zira.name);
    await storedMember(story, story.ids.Holmes!, (m) => m.voice.manual === true);
    chooseTrait(card, 'Gender', 'Male');
    // Saves run one after another, so once Watson's shows, Holmes's is over.
    chooseTrait(cardOf(host, 'Watson'), 'Gender', 'Male');
    await until(() => traitsSummary(cardOf(host, 'Watson')) === 'Traits: male', 'Watson’s save');
    expect(keptNote(card)).toBeNull();

    // A trait that does change brings the note.
    chooseTrait(card, 'Size', 'Small');
    await until(() => keptNote(card), 'the note for the size');
    const saved = await storedMember(story, story.ids.Holmes!, (m) => m.size === 'small');
    expect(saved).toMatchObject({ gender: 'male', voice: { voiceName: zira.name, manual: true } });
  });

  it('are offered for the narrator, whose voice follows them too', async () => {
    // The device's default voice is a man's, so a narrator set to female needs another.
    stubVoices.push(david, zira);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    chooseTrait(cardOf(host, 'Narrator'), 'Gender', 'Female');
    const saved = await storedMember(story, story.ids.N!, (m) => m.gender === 'female');
    expect(saved.voice.voiceName).toBe(zira.name);
  });

  it('are not offered for the unknown speaker', async () => {
    const host = await openCast(await storeStory(holmes));
    expect(cardOf(host, 'Unknown speaker').querySelector('details.traits')).toBeNull();
    expect(cardOf(host, 'Narrator').querySelector('details.traits')).not.toBeNull();
  });

  it('come after the names editor in the card', async () => {
    const host = await openCast(await storeStory(holmes));
    const blocks = [...cardOf(host, 'Holmes').querySelectorAll('.body details')];
    expect(blocks.map((d) => d.querySelector('summary')!.textContent?.trim())).toEqual([
      'Other names',
      'Traits: not set',
      'See Holmes’s lines',
    ]);
  });
});

describe('a change made before the device has listed its voices', () => {
  // The narrator reads with David; a pick that ignored the gender would take the plain voice.
  const voices = [david, plain, zira];
  const woman = { characters: [{ name: 'Holmes', gender: 'female' as const }] };
  const castOf = async (story: StoredStory) => (await getStory(db, story.storyId))!.cast;

  it('of a trait waits for them, then picks a voice to match', async () => {
    const listVoices = holdVoices();
    stubVoices.push(...voices);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const before = await castOf(story);
    chooseTrait(cardOf(host, 'Holmes'), 'Gender', 'Female');
    await pause();
    expect(await castOf(story)).toEqual(before);

    listVoices();
    const saved = await storedMember(story, story.ids.Holmes!, (m) => m.gender === 'female');
    expect(saved.voice.voiceName).toBe(zira.name);
  });

  it('with “Re-pick voice” waits for them, then picks a voice to match', async () => {
    const listVoices = holdVoices();
    stubVoices.push(...voices);
    const story = await storeStory(holmes, woman);
    const host = await openCast(story);
    const before = await castOf(story);
    button(traitsOf(cardOf(host, 'Holmes')), 'Re-pick voice')!.click();
    await pause();
    expect(await castOf(story)).toEqual(before);

    listVoices();
    const saved = await storedMember(story, story.ids.Holmes!, (m) => !!m.voice.voiceName);
    expect(saved.voice.voiceName).toBe(zira.name);
  });

  it('with “Match voices to traits” waits for them, then picks voices to match', async () => {
    const listVoices = holdVoices();
    stubVoices.push(...voices);
    const story = await storeStory(holmes, woman);
    const host = await openCast(story);
    const before = await castOf(story);
    host.querySelector<HTMLButtonElement>('.match button')!.click();
    await pause();
    expect(await castOf(story)).toEqual(before);

    listVoices();
    const saved = await storedMember(story, story.ids.Holmes!, (m) => !!m.voice.voiceName);
    expect(saved.voice.voiceName).toBe(zira.name);
  });
});

describe('the voice picker', () => {
  it('tells the gender a voice’s name gives away, its accent, and which are online', async () => {
    stubVoices.push(zira, david, plain, { name: 'en-cloud', lang: 'en-GB', network: true });
    const host = await openCast(await storeStory(holmes));
    voiceButton(cardOf(host, 'Holmes')).click();
    await until(() => sheetRow('en-cloud'), 'the voices');
    const titles = [...sheet()!.querySelectorAll('li .title')].map((t) =>
      t.textContent?.replace(/\s+/gu, ' ').trim(),
    );
    expect(titles).toEqual([
      'Device default en-US',
      'Zira female · US',
      'David male · US',
      'en-plain US',
      'en-cloud UK · online',
    ]);
    // A shortened name keeps the full one beside it.
    expect(sheetRow(zira.name)!.querySelector('.full')!.textContent?.trim()).toBe(zira.name);
  });

  it('marks a voice chosen by hand as manual', async () => {
    stubVoices.push(zira, david);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    await chooseVoice(cardOf(host, 'Holmes'), david.name);
    const saved = await storedMember(story, story.ids.Holmes!, (m) => m.voice.manual === true);
    expect(saved.voice).toStrictEqual({
      voiceName: david.name,
      lang: 'en-US',
      pitch: 1,
      rate: 1,
      manual: true,
    });
    await playerTold(1);

    // Back to the device default: still a choice made by hand, and no empty voice name is kept.
    await chooseVoice(cardOf(host, 'Holmes'), '');
    const reset = await storedMember(story, story.ids.Holmes!, (m) => !m.voice.voiceName);
    expect(reset.voice).toStrictEqual({ lang: 'en-US', pitch: 1, rate: 1, manual: true });
    await playerTold(2);
  });

  it('marks a voice whose pitch or speed was moved by hand as manual', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const [pitch, speed] = cardOf(host, 'Watson').querySelectorAll<HTMLInputElement>(
      '.sliders input[type="range"]',
    );
    pitch!.value = '1.3';
    pitch!.dispatchEvent(new Event('change'));
    const pitched = await storedMember(story, story.ids.Watson!, (m) => m.voice.pitch === 1.3);
    expect(pitched.voice.manual).toBe(true);
    await playerTold(1);
    speed!.value = '0.9';
    speed!.dispatchEvent(new Event('change'));
    const slowed = await storedMember(story, story.ids.Watson!, (m) => m.voice.rate === 0.9);
    expect(slowed.voice).toStrictEqual({ lang: 'en-US', pitch: 1.3, rate: 0.9, manual: true });
    // Nobody else's voice was touched.
    const holmesNow = (await getStory(db, story.storyId))!.cast.find(
      (c) => c.id === story.ids.Holmes,
    )!;
    expect(holmesNow.voice).toStrictEqual({ lang: 'en-US', pitch: 1, rate: 1 });
  });
});

describe('“Match voices to traits”', () => {
  // Counted from the cast: Holmes's voice is set by hand, Watson's and the old man's are not.
  const DONE =
    '2 voices picked again to suit traits guessed from names. The 1 voice set by hand stays.';
  const oldMan: Chunk[] = [
    ...holmes,
    ['\n\n“Who goes there?”', 'the old man', 'speech'],
    [' asked the old man.', 'N', 'narration'],
  ];
  const matchButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.match button');
  const snackbar = () => document.querySelector<HTMLElement>('.snackbar');

  it('guesses traits from names and picks the voices again in one press, then can be undone', async () => {
    // The narrator reads with the device's first voice, Zira. Watson, picked first, takes the
    // plain voice, so a pick that ignored the old man's traits would take Jenny.
    stubVoices.push(zira, plain, jenny, david);
    const story = await storeStory(oldMan);
    const host = await openCast(story);
    // Holmes's voice is set by hand.
    await chooseVoice(cardOf(host, 'Holmes'), zira.name);
    await storedMember(story, story.ids.Holmes!, (m) => m.voice.manual === true);
    await playerTold(1);
    const before = (await getStory(db, story.storyId))!.cast;

    matchButton(host)!.click();
    const saved = await storedMember(story, story.ids['the old man']!, (m) => m.age === 'elder');
    expect(saved).toMatchObject({ gender: 'male', age: 'elder', voice: { voiceName: david.name } });
    await playerTold(2);
    await until(
      () => traitsSummary(cardOf(host, 'the old man')) === 'Traits: male · elderly',
      'the old man’s traits',
    );
    const after = (await getStory(db, story.storyId))!.cast;
    // The hand-set voice stays, and so do the narrator and the unknown speaker.
    expect(after.find((c) => c.id === story.ids.Holmes)).toEqual(
      before.find((c) => c.id === story.ids.Holmes),
    );
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    // What it did, counted, with Undo.
    const bar = await until(snackbar, 'the bar');
    expect(bar.querySelector('.snack-text')!.textContent?.trim()).toBe(DONE);

    button(bar, 'Undo')!.click();
    await until(async () => {
      const cast = (await getStory(db, story.storyId))!.cast;
      return JSON.stringify(cast) === JSON.stringify(before);
    }, 'the cast as it was');
    await until(() => snackbar()?.textContent?.includes('Undone.'), 'Undone');
    expect(button(snackbar()!, 'Undo')).toBeUndefined();
    await playerTold(3);
  });

  it('says so when every voice already suits its traits', async () => {
    stubVoices.push(zira, plain, jenny, david);
    const host = await openCast(await storeStory(oldMan));
    matchButton(host)!.click();
    await until(() => snackbar(), 'the first match');
    matchButton(host)!.click();
    const said = await until(() => host.querySelector('.match .card-note'), 'the note');
    expect(said.textContent?.trim()).toBe('Every voice already suits its traits.');
  });

  it('is not offered when the cast has no characters', async () => {
    const host = await openCast(await storeStory([['Once upon a time.', 'N', 'narration']]));
    expect(matchButton(host)).toBeNull();
  });

  it('adds no status note above the search’s own', async () => {
    const host = await openCast(await storeStory(oldMan));
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});

describe('the narrator’s “Give all these lines to…”', () => {
  const names = ['Elizabeth', 'Jane', 'Lydia', 'Kitty', 'Mary', 'Darcy', 'Bingley'];
  const story = () => storeStory(names.map((n): Chunk => [`“Hello,” said ${n}. `, n, 'speech']));
  const shown = (sheet: HTMLElement) =>
    [...sheet.querySelectorAll('.people button')].map((b) => b.textContent?.trim());

  it('is in the ⋯ menu, and finds who to give the lines to by name', async () => {
    const host = await openCast(await story());
    const sheet = await openMergeSheet(cardOf(host, 'Narrator'));
    expect(sheet.querySelector('h2')!.textContent?.replace(/\s+/gu, ' ').trim()).toBe(
      'Give all of Narrator’s lines, in every part, to…',
    );
    typeInto(sheet.querySelector<HTMLInputElement>('input[type="search"]')!, 'y');
    await until(() => shown(sheet).length === 5, 'the filtered list');
    expect(shown(sheet)).toEqual(['Lydia', 'Kitty', 'Mary', 'Darcy', 'Bingley']);
  });

  it('says what giving them does, without a name or voice to choose, once someone is chosen', async () => {
    const host = await openCast(await storeStory(holmes));
    const sheet = await openMergeSheet(cardOf(host, 'Narrator'));
    expect(button(sheet, 'Merge')!.disabled).toBe(true);
    button(sheet, 'Watson')!.click();
    await until(() => !button(sheet, 'Merge')!.disabled, 'Merge');
    expect(sheet.querySelectorAll('fieldset')).toHaveLength(0);
    expect(
      [...sheet.querySelectorAll('p.note')].at(-1)!.textContent?.replace(/\s+/gu, ' ').trim(),
    ).toBe(
      'All of these lines will be read by “Watson”. If Watson tells the whole story, use “Same ' +
        'person as…” in Watson’s ⋯ menu and choose Narrator instead. You can undo this.',
    );
  });

  it('has no “Not a character” for the narrator or the unknown speaker', async () => {
    const host = await openCast(await storeStory(holmes));
    for (const name of ['Narrator', 'Unknown speaker']) {
      const menu = openMenu(cardOf(host, name));
      expect(button(menu, 'Not a character')).toBeUndefined();
      expect(button(menu, 'Rename')).toBeDefined();
    }
  });
});

describe('a card', () => {
  const meta = (card: HTMLElement) =>
    card.querySelector('.head p')!.textContent?.replace(/\s+/gu, ' ').trim();

  it('counts lines as “1 line” or “2 lines”, without repeating the role', async () => {
    const host = await openCast(await storeStory(holmes));
    expect(meta(cardOf(host, 'Holmes'))).toBe('1 line');
    // The role is the section's heading, so the card doesn't repeat it.
    expect(meta(cardOf(host, 'Narrator'))).toBe('2 lines');
    expect(meta(cardOf(host, 'Unknown speaker'))).toBe('not in any part yet');
  });

  it('names whose voice its Preview button plays', async () => {
    const host = await openCast(await storeStory(holmes));
    const preview = cardOf(host, 'Holmes').querySelector('button.preview')!;
    expect(preview.getAttribute('aria-label')).toBe('Preview Holmes’s voice');
  });

  it('shows a pitch as it is dragged, and saves it only on release', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const card = cardOf(host, 'Watson');
    const pitch = card.querySelector<HTMLInputElement>('.sliders input[type="range"]')!;
    const label = () => pitch.closest('label')!.querySelector('.dial-value')!.textContent?.trim();
    expect(label()).toBe('Normal');
    expect(pitch.getAttribute('aria-valuetext')).toBe('Normal');

    pitch.value = '1.25';
    pitch.dispatchEvent(new Event('input'));
    await until(() => label() === '1.25×', 'the dragged value');
    expect(pitch.getAttribute('aria-valuetext')).toBe('1.25×');
    await pause();
    const unsaved = (await getStory(db, story.storyId))!.cast.find(
      (c) => c.id === story.ids.Watson,
    );
    expect(unsaved!.voice.pitch).toBe(1);

    pitch.dispatchEvent(new Event('change'));
    await storedMember(story, story.ids.Watson!, (m) => m.voice.pitch === 1.25);
    expect(label()).toBe('1.25×');
  });
});

describe('the voice rules', () => {
  const chip = (card: HTMLElement) => card.querySelector('.voice .chip')!.textContent?.trim();
  const back = (card: HTMLElement) => button(card, 'Back to automatic');

  it('show whether a voice is automatic or set by hand, and put it back to automatic', async () => {
    stubVoices.push(zira, david);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const card = cardOf(host, 'Holmes');
    expect(chip(card)).toBe('Automatic');
    expect(back(card)).toBeUndefined();
    // The picker is described by the chip, so a screen reader hears it with the voice.
    const picker = voiceButton(card);
    expect(
      host.querySelector(`#${picker.getAttribute('aria-describedby')}`)?.textContent?.trim(),
    ).toBe('Automatic');

    await chooseVoice(card, david.name);
    await until(() => chip(card) === 'Set by hand', 'the hand-set chip');
    back(card)!.click();
    const automatic = await storedMember(story, story.ids.Holmes!, (m) => !m.voice.manual);
    expect('manual' in automatic.voice).toBe(false);
    await until(() => chip(card) === 'Automatic', 'the automatic chip');
    expect(back(card)).toBeUndefined();
    await playerTold(2);
  });

  it('group the cast under Narrator, Characters and Unattributed, each saying what it does', async () => {
    const host = await openCast(await storeStory(holmes));
    const sections = [...host.querySelectorAll<HTMLElement>('section.group')];
    const titles = sections.map((s) =>
      s.querySelector('h2')!.textContent?.replace(/\s+/gu, ' ').trim(),
    );
    expect(titles).toEqual(['Narrator', 'Characters 2', 'Unattributed']);
    const names = (s: HTMLElement) =>
      [...s.querySelectorAll('li.card h3')].map((h) => h.textContent?.trim());
    expect(sections.map(names)).toEqual([['Narrator'], ['Holmes', 'Watson'], ['Unknown speaker']]);
    expect(sections[1]!.querySelector('.match button')).not.toBeNull();

    // A search hides the sections it leaves empty.
    typeInto(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'holm');
    await until(() => sections[0]!.style.display === 'none', 'the narrator section to hide');
    expect(sections[1]!.style.display).toBe('');
    expect(sections[2]!.style.display).toBe('none');
  });

  it('say when the analysed parts found no characters', async () => {
    const host = await openCast(await storeStory([['Once upon a time.', 'N', 'narration']]));
    const empty = await until(() => host.querySelector('section.group .empty'), 'the empty note');
    expect(empty.textContent).toContain('No characters were found in the analysed parts.');
    expect(empty.querySelector('a')?.textContent?.trim()).toBe('Go to the parts');
  });

  it('are explained in “How voices work”, closed until opened', async () => {
    const host = await openCast(await storeStory(holmes));
    const tips = host.querySelector<HTMLDetailsElement>('details.tips')!;
    expect(tips.querySelector('summary')!.textContent?.trim()).toBe('How voices work');
    expect(tips.open).toBe(false);
  });
});

describe('the compact list', () => {
  const body = (card: HTMLElement) => card.querySelector<HTMLElement>('.body')!;
  const toggle = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('h3 .toggle')!;
  const isOpen = (card: HTMLElement) => body(card).style.display !== 'none';
  const characterNames = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('section.group')[1]!.querySelectorAll('li.card')]
      .filter((li) => (li as HTMLElement).style.display !== 'none')
      .map((li) => li.querySelector('h3')!.textContent?.trim());

  it('shows each member as a row that opens one at a time', async () => {
    const host = await openCast(await storeStory(holmes));
    const [holmesCard, watsonCard] = [cardOf(host, 'Holmes'), cardOf(host, 'Watson')];
    expect(isOpen(holmesCard)).toBe(false);
    expect(toggle(holmesCard).getAttribute('aria-expanded')).toBe('false');

    toggle(holmesCard).click();
    await until(() => isOpen(holmesCard), 'Holmes open');
    expect(toggle(holmesCard).getAttribute('aria-expanded')).toBe('true');
    toggle(watsonCard).click();
    await until(() => isOpen(watsonCard), 'Watson open');
    expect(isOpen(holmesCard)).toBe(false);
    toggle(watsonCard).click();
    await until(() => !isOpen(watsonCard), 'Watson closed');
  });

  it('sums up each voice in its row: the voice heard, and whether it was set by hand', async () => {
    stubVoices.push(zira, david);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const summary = () =>
      cardOf(host, 'Holmes').querySelector('.voice-sum')!.textContent?.replace(/\s+/gu, ' ').trim();
    await chooseVoice(cardOf(host, 'Holmes'), david.name);
    await until(() => summary() === 'David · set by hand', 'the summary');
  });

  it('sorts characters by lines, by name or by when they are first heard', async () => {
    const host = await openCast(
      await storeStory([
        ['“Hi,”', 'Zed', 'speech'],
        [' said Zed. ', 'N', 'narration'],
        ['“Hello,”', 'Amy', 'speech'],
        [' said Amy. ', 'N', 'narration'],
        ['“Yes,”', 'Amy', 'speech'],
        [' said Amy again.', 'N', 'narration'],
      ]),
    );
    const sort = host.querySelector<HTMLSelectElement>('.sort select')!;
    expect(characterNames(host)).toEqual(['Amy', 'Zed']);
    for (const [mode, names] of [
      ['first', ['Zed', 'Amy']],
      ['name', ['Amy', 'Zed']],
    ] as const) {
      sort.value = mode;
      sort.dispatchEvent(new Event('change'));
      await until(() => characterNames(host).join() === names.join(), `the ${mode} order`);
    }
  });

  it('filters by chips that count who they would show', async () => {
    const host = await openCast(await storeStory(holmes));
    const chip = (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('.filter-chip')].find((b) =>
        b.textContent?.includes(label),
      )!;
    // The narrator and both characters have no traits; the unknown speaker has none to set.
    expect(chip('No traits').textContent?.replace(/\s+/gu, ' ').trim()).toBe('No traits 3');
    expect(chip('2 lines or fewer').textContent).toContain('2');

    chip('2 lines or fewer').click();
    await until(() => chip('2 lines or fewer').getAttribute('aria-pressed') === 'true', 'pressed');
    const sections = [...host.querySelectorAll<HTMLElement>('section.group')];
    await until(() => sections[0]!.style.display === 'none', 'the narrator hidden');
    expect(characterNames(host)).toEqual(['Holmes', 'Watson']);
    expect(host.querySelector('.toolbar [aria-live]')!.textContent?.trim()).toBe('Showing 2 of 4');

    chip('2 lines or fewer').click();
    await until(() => sections[0]!.style.display !== 'none', 'everyone back');
  });

  describe('of a long cast', () => {
    // Three characters with three lines each, five with one.
    const major = ['Ann', 'Ben', 'Cal'];
    const minor = ['Dee', 'Eve', 'Fay', 'Gus', 'Hal'];
    const chunks: Chunk[] = [
      ...major.flatMap((n): Chunk[] =>
        [1, 2, 3].flatMap((i): Chunk[] => [
          [`“Line ${i},”`, n, 'speech'],
          [` said ${n}. `, 'N', 'narration'],
        ]),
      ),
      ...minor.flatMap((n): Chunk[] => [
        ['“Hm,”', n, 'speech'],
        [` said ${n}. `, 'N', 'narration'],
      ]),
    ];
    const fold = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.fold-toggle')!;

    it('folds the minor characters behind one row that names them', async () => {
      const host = await openCast(await storeStory(chunks));
      expect(characterNames(host)).toEqual(major);
      expect(fold(host).textContent?.replace(/\s+/gu, ' ').trim()).toBe(
        'Minor characters 5: Dee, Eve, Fay, +2',
      );
      expect(fold(host).getAttribute('aria-expanded')).toBe('false');

      fold(host).click();
      await until(() => characterNames(host).length === 8, 'the minor characters');
      expect(characterNames(host)).toEqual([...major, ...minor]);
    });

    it('unfolds them for a search', async () => {
      const host = await openCast(await storeStory(chunks));
      typeInto(host.querySelector<HTMLInputElement>('.cast-filter input')!, 'gus');
      await until(() => characterNames(host).join() === 'Gus', 'Gus');
      expect(fold(host).closest('li')!.style.display).toBe('none');
    });
  });
});

describe('auditions', () => {
  const LONG_1 = 'I have been watching the house across the street for three days now';
  const LONG_2 = 'Nobody has come in or out, and yet the lamp is lit every single evening';
  const watcher: Chunk[] = [
    [`“${LONG_1},”`, 'Holmes', 'speech'],
    [' said Holmes. ', 'N', 'narration'],
    [`“${LONG_2}.”`, 'Holmes', 'speech'],
    [' he added. “Hm,”', 'N', 'narration'],
    ['“Thank you,”', 'Watson', 'speech'],
    [' said Watson.', 'N', 'narration'],
  ];
  const playButton = (card: HTMLElement) =>
    card.querySelector<HTMLButtonElement>('button.preview')!;
  const open = async (card: HTMLElement) => {
    card.querySelector<HTMLButtonElement>('h3 .toggle')!.click();
    await until(() => card.querySelector('.sample'), 'the open card');
  };
  const spoken = () => previewed.mock.calls.map(([text]) => text);

  it('play one of the member’s own lines, or a greeting when none will do', async () => {
    const host = await openCast(await storeStory(holmes));
    // Too short for a sample, but the longest Holmes has: read without its quotes and comma.
    await open(cardOf(host, 'Holmes'));
    const sample = () => cardOf(host, 'Holmes').querySelector('.sample-text')!.textContent?.trim();
    await until(() => sample() === '“Come in, Watson”', 'the parts');
    playButton(cardOf(host, 'Holmes')).click();
    await until(() => previewed.mock.calls.length === 1, 'the preview');
    playButton(cardOf(host, 'Watson')).click();
    await until(() => previewed.mock.calls.length === 2, 'the second preview');
    // "Thank you" is too short to tell a voice by.
    expect(spoken()).toEqual(['Come in, Watson', 'Hello, I am Watson.']);
  });

  it('show the line in the open card, and “Next line” plays the next one', async () => {
    const host = await openCast(await storeStory(watcher));
    const card = cardOf(host, 'Holmes');
    await open(card);
    const text = () => card.querySelector('.sample-text')!.textContent?.trim();
    expect(text()).toBe(`“${LONG_1}”`);
    button(card, 'Next line')!.click();
    await until(() => text() === `“${LONG_2}.”`, 'the next line');
    await until(() => spoken().includes(`${LONG_2}.`), 'the next line spoken');
    // Watson has a single line, so there is no next one.
    await open(cardOf(host, 'Watson'));
    expect(button(cardOf(host, 'Watson'), 'Next line')).toBeUndefined();
  });

  it('turn the preview button into Stop while the line is spoken', async () => {
    const host = await openCast(await storeStory(holmes));
    let finish = () => {};
    previewed.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const play = playButton(cardOf(host, 'Holmes'));
    play.click();
    await until(() => play.getAttribute('aria-pressed') === 'true', 'speaking');
    play.click();
    await until(() => play.getAttribute('aria-pressed') === 'false', 'stopped');
    expect(stopped).toHaveBeenCalledTimes(1);
    finish();

    // A preview that ends by itself lets go of the button too.
    play.click();
    await until(() => previewed.mock.calls.length === 2, 'the second preview');
    await until(() => play.getAttribute('aria-pressed') === 'false', 'the end');
  });

  it('play the new voice after each change, unless told not to', async () => {
    stubVoices.push(zira, david);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const card = cardOf(host, 'Holmes');
    await open(card);
    await chooseVoice(card, david.name);
    await until(() => previewed.mock.calls.length === 1, 'the replay');
    expect(previewed.mock.calls[0]![1]).toMatchObject({ voiceName: david.name, manual: true });

    const auto = card.querySelector<HTMLInputElement>('.auto input')!;
    auto.checked = false;
    auto.dispatchEvent(new Event('change'));
    await chooseVoice(card, zira.name);
    await storedMember(story, story.ids.Holmes!, (m) => m.voice.voiceName === zira.name);
    await pause();
    expect(previewed).toHaveBeenCalledTimes(1);
  });
});

describe('the voice sheet', () => {
  it('opens from the voice button, closes on Esc, and gives focus back to the button', async () => {
    stubVoices.push(zira, david);
    const host = await openCast(await storeStory(holmes));
    const picker = voiceButton(cardOf(host, 'Holmes'));
    expect(picker.textContent).toContain('Device default');
    picker.click();
    const dialog = await until(sheet, 'the sheet');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Voice for Holmes');
    await until(() => document.activeElement === dialog, 'focus in the sheet');
    // The voice in use says so instead of offering itself.
    expect(sheetRow('')!.textContent).toContain('In use');

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => !sheet(), 'the sheet to close');
    await until(() => document.activeElement === picker, 'focus back on the button');
  });

  it('plays the member in a voice without saving it, and says who else has it', async () => {
    stubVoices.push(zira, david);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    await chooseVoice(cardOf(host, 'Watson'), david.name);
    await storedMember(story, story.ids.Watson!, (m) => m.voice.voiceName === david.name);
    previewed.mockClear();

    voiceButton(cardOf(host, 'Holmes')).click();
    const row = await until(() => sheetRow(david.name), 'David’s row');
    expect(row.querySelector('.users')!.textContent?.replace(/\s+/gu, ' ').trim()).toBe(
      'Also Watson',
    );
    row.querySelector<HTMLButtonElement>('.hear')!.click();
    await until(() => previewed.mock.calls.length === 1, 'the audition');
    expect(previewed.mock.calls[0]![1]).toMatchObject({ voiceName: david.name, pitch: 1 });
    await pause();
    const holmesNow = (await getStory(db, story.storyId))!.cast.find(
      (c) => c.id === story.ids.Holmes,
    )!;
    expect(holmesNow.voice.voiceName).toBeUndefined();
  });
});

describe('voices that sound alike', () => {
  /** Sets each member's pitch and rate; with no device voices, only twins sound alike. */
  async function voices(story: StoredStory, pitches: Record<string, number>) {
    const { cast } = (await getStory(db, story.storyId))!;
    await updateStory(db, story.storyId, {
      cast: cast.map((c) => ({ ...c, voice: { lang: 'en-US', pitch: pitches[c.name]!, rate: 1 } })),
    });
  }
  const note = (card: HTMLElement) =>
    card.querySelector('.alike')?.textContent?.replace(/\s+/gu, ' ').trim();

  it('warn about a character who sounds like the narrator, until another is picked', async () => {
    const story = await storeStory(holmes);
    await voices(story, { Narrator: 1, 'Unknown speaker': 1.3, Holmes: 1, Watson: 0.8 });
    const host = await openCast(story);
    expect(note(cardOf(host, 'Holmes'))).toBe('Sounds like the narrator. Pick another voice');
    expect(note(cardOf(host, 'Watson'))).toBeUndefined();
    expect(note(cardOf(host, 'Narrator'))).toBeUndefined();
    expect(cardOf(host, 'Holmes').querySelector('.voice-sum')!.textContent).toContain(
      'sounds alike',
    );

    button(cardOf(host, 'Holmes'), 'Pick another voice')!.click();
    await until(() => !note(cardOf(host, 'Holmes')), 'the warning to go');
  });

  it('name the others a character sounds close to, and take you to them', async () => {
    const story = await storeStory(holmes);
    await voices(story, { Narrator: 1, 'Unknown speaker': 1.3, Holmes: 1.2, Watson: 1.2 });
    const host = await openCast(story);
    expect(note(cardOf(host, 'Holmes'))).toBe('Sounds close to Watson. Pick another voice');
    const chips = [...host.querySelectorAll<HTMLButtonElement>('.filter-chip')];
    expect(chips.find((b) => b.textContent?.includes('Sound alike'))!.textContent).toContain('2');

    button(cardOf(host, 'Holmes'), 'Watson')!.click();
    const watson = cardOf(host, 'Watson');
    await until(
      () => watson.querySelector('.toggle')!.getAttribute('aria-expanded') === 'true',
      'Watson open',
    );
    expect(document.activeElement).toBe(watson.querySelector('.toggle'));
  });
});

describe('undo and feedback', () => {
  const snackbar = () => document.querySelector<HTMLElement>('.snackbar');
  const noteIn = (card: HTMLElement) =>
    card.querySelector('.card-note')?.textContent?.replace(/\s+/gu, ' ').trim();

  it('merges in one press, opens the member merged into, and undoes the merge', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const before = (await getStory(db, story.storyId))!;
    await mergeInto(cardOf(host, 'Watson'), 'Holmes');
    await until(() => !host.textContent?.includes('Watson’s lines'), 'Watson gone');

    const bar = await until(snackbar, 'the bar');
    expect(bar.querySelector('.snack-text')!.textContent?.trim()).toBe(
      'Watson merged into Holmes · 1 line moved.',
    );
    const holmesCard = cardOf(host, 'Holmes');
    await until(
      () => holmesCard.querySelector('.toggle')!.getAttribute('aria-expanded') === 'true',
      'Holmes open',
    );
    expect(holmesCard.classList.contains('flash')).toBe(true);
    expect(document.activeElement).toBe(holmesCard.querySelector('.toggle'));

    button(bar, 'Undo')!.click();
    await until(
      () =>
        [...host.querySelectorAll('li.card h3')].some((h) => h.textContent?.trim() === 'Watson'),
      'Watson back',
    );
    const after = (await getStory(db, story.storyId))!;
    expect(after.cast).toEqual(before.cast);
    expect(await db.analyses.bulkGet(after.partIds)).toEqual(
      await db.analyses.bulkGet(before.partIds),
    );
  });

  it('refuses an undo once the cast has changed since, and says why', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    await mergeInto(cardOf(host, 'Watson'), 'Holmes');
    const bar = await until(snackbar, 'the bar');
    chooseTrait(cardOf(host, 'Holmes'), 'Gender', 'Male');
    await storedMember(story, story.ids.Holmes!, (m) => m.gender === 'male');

    button(bar, 'Undo')!.click();
    await until(
      () =>
        snackbar()?.textContent?.includes('The cast has changed since, so this can’t be undone.'),
      'the refusal',
    );
    const cast = (await getStory(db, story.storyId))!.cast;
    expect(cast.some((c) => c.id === story.ids.Watson)).toBe(false);
  });

  it('offers to undo a voice used from the voice sheet', async () => {
    stubVoices.push(zira, david);
    const story = await storeStory(holmes);
    const host = await openCast(story);
    await chooseVoice(cardOf(host, 'Holmes'), david.name);
    const bar = await until(snackbar, 'the bar');
    expect(bar.querySelector('.snack-text')!.textContent?.trim()).toBe(
      'Holmes now speaks with David.',
    );
    button(bar, 'Undo')!.click();
    const back = await storedMember(story, story.ids.Holmes!, (m) => !m.voice.voiceName);
    expect(back.voice.manual).toBeUndefined();
  });

  it('says in the card that names were saved, or that nothing changed, keeping focus', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const card = await openCard(cardOf(host, 'Watson'));
    const save = card.querySelector<HTMLButtonElement>('.editor .fields button[type="submit"]')!;
    save.focus();
    await saveNames(card, {});
    await until(() => noteIn(card) === 'No changes to save.', 'nothing to save');

    await saveNames(card, { aliases: 'John, Dr. Watson' });
    await until(() => noteIn(card) === 'Names saved.', 'saved');
    await storedMember(story, story.ids.Watson!, (m) => m.aliases.length === 2);
    // The editor shows the saved names and keeps focus: it is not rebuilt.
    const aliasesInput = card.querySelector<HTMLInputElement>('.editor .fields input')!;
    expect(aliasesInput.value).toBe('John, Dr. Watson');
    expect(card.querySelector('.editor .fields button[type="submit"]')).toBe(save);
    expect(document.activeElement).toBe(save);
  });
});

describe('notifications', () => {
  const snackbar = () => document.querySelector<HTMLElement>('.snackbar');
  /** Fakes only setTimeout, still moving with real time, so waits on the page keep working. */
  const fakeTime = () =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('close the undo bar after 5 seconds, but not while it is pointed at or focused', async () => {
    const host = await openCast(await storeStory(holmes));
    fakeTime();
    await mergeInto(cardOf(host, 'Watson'), 'Holmes');
    const bar = await until(snackbar, 'the bar');

    bar.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(20_000);
    await pause();
    expect(snackbar()).not.toBeNull();
    bar.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(4_000);
    await pause();
    expect(snackbar()).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    await until(() => !snackbar(), 'the bar to close');

    // Focus on Undo holds it too.
    await mergeInto(cardOf(host, 'Holmes'), 'Narrator');
    const next = await until(snackbar, 'the next bar');
    next.dispatchEvent(new FocusEvent('focusin'));
    vi.advanceTimersByTime(20_000);
    await pause();
    expect(snackbar()).not.toBeNull();
  });

  it('let “Names saved.” go after 4 seconds, while a failure stays', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const card = await openCard(cardOf(host, 'Watson'));
    const noteIn = () => card.querySelector('.card-note');
    fakeTime();
    await saveNames(card, { name: 'John Watson' });
    await until(() => noteIn()?.textContent?.includes('Names saved.'), 'saved');
    vi.advanceTimersByTime(4_000);
    await until(() => !noteIn(), 'the note to go');

    const failing = () => {
      throw new Error('disk full');
    };
    db.stories.hook('updating', failing);
    try {
      chooseTrait(card, 'Gender', 'Male');
      await until(() => noteIn()?.textContent?.includes('disk full'), 'the failure');
    } finally {
      db.stories.hook('updating').unsubscribe(failing);
    }
    vi.advanceTimersByTime(60_000);
    await pause();
    expect(noteIn()?.textContent).toContain('disk full');
  });
});

describe('duplicate cleanup', () => {
  const snackbar = () => document.querySelector<HTMLElement>('.snackbar');
  const names = async (story: StoredStory) =>
    (await getStory(db, story.storyId))!.cast.map((c) => c.name);
  // Robert has three lines, Bob one: Bob may be Robert.
  const bob: Chunk[] = [
    ['“One,”', 'Robert', 'speech'],
    [' said Robert. ', 'N', 'narration'],
    ['“Two,”', 'Robert', 'speech'],
    [' said Robert. ', 'N', 'narration'],
    ['“Three,”', 'Robert', 'speech'],
    [' said Robert. ', 'N', 'narration'],
    ['“Hi there, everyone,”', 'Bob', 'speech'],
    [' said Bob.', 'N', 'narration'],
  ];
  const dupes = (host: HTMLElement) => host.querySelector<HTMLElement>('.dupes');
  const pairs = (host: HTMLElement) =>
    [...(dupes(host)?.querySelectorAll('.pair') ?? [])].map((p) =>
      p.textContent?.replace(/\s+/gu, ' ').trim(),
    );

  it('keeps the possible duplicates folded until opened', async () => {
    const host = await openCast(await storeStory(bob));
    const panel = dupes(host) as HTMLDetailsElement;
    expect(panel.tagName).toBe('DETAILS');
    expect(panel.open).toBe(false);
    expect(panel.querySelector('summary')!.textContent?.replace(/\s+/gu, ' ').trim()).toBe(
      'Possible duplicates 1',
    );
  });

  it('suggests possible duplicates, and merges one in a tap, the less heard into the more', async () => {
    const story = await storeStory(bob);
    const host = await openCast(story);
    expect(pairs(host)).toEqual(['Bob → into Robert']);
    expect(dupes(host)!.querySelector('.reason')!.textContent?.replace(/\s+/gu, ' ').trim()).toBe(
      '“Bob” can be short for “Robert” · 1 line and 3 lines',
    );
    button(dupes(host)!, 'Merge')!.click();
    await until(async () => !(await names(story)).includes('Bob'), 'Bob merged');
    expect(
      (await getStory(db, story.storyId))!.cast.find((c) => c.name === 'Robert')!.aliases,
    ).toEqual(['Bob']);
    await until(() => !dupes(host), 'no more suggestions');
    expect((await until(snackbar, 'the bar')).textContent).toContain('Bob merged into Robert');
  });

  it('turns a suggestion round with Swap', async () => {
    const story = await storeStory(bob);
    const host = await openCast(story);
    button(dupes(host)!, 'Swap')!.click();
    await until(() => pairs(host)[0] === 'Robert → into Bob', 'swapped');
    button(dupes(host)!, 'Merge')!.click();
    await until(
      async () => (await names(story)).join() === 'Narrator,Unknown speaker,Bob',
      'merged',
    );
  });

  it('stops suggesting a pair said to be “Not the same”, also on the next visit', async () => {
    const story = await storeStory(bob);
    let host = await openCast(story);
    button(dupes(host)!, 'Not the same')!.click();
    await until(() => !dupes(host), 'the suggestion gone');
    unmountView();
    host = await openCast(story);
    await pause();
    expect(dupes(host)).toBeNull();
    expect(await names(story)).toContain('Bob');
  });

  it('compares the two in the merge sheet, keeping the name and the voice chosen', async () => {
    stubVoices.push(zira, david);
    const story = await storeStory(bob);
    const host = await openCast(story);
    await chooseVoice(cardOf(host, 'Bob'), david.name);
    await storedMember(story, story.ids.Bob!, (m) => m.voice.voiceName === david.name);

    const dialog = await openMergeSheet(cardOf(host, 'Bob'));
    button(dialog, 'Robert')!.click();
    const sides = await until(() => {
      const found = [...dialog.querySelectorAll('.side')];
      return found.length === 2 ? found : undefined;
    }, 'the comparison');
    expect(sides.map((s) => s.querySelector('q')?.textContent)).toEqual([
      'Hi there, everyone',
      'One',
    ]);
    // Keep Bob's name: Robert is the one merged, into Bob; the voice follows the name kept.
    const radio = (legend: string, value: string) =>
      [...dialog.querySelectorAll('fieldset')]
        .find((f) => f.querySelector('legend')!.textContent === legend)!
        .querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
    radio('Keep the name', 'member').click();
    await until(() => radio('Keep the voice', 'member').checked, 'Bob’s voice chosen');
    // ...unless another is chosen.
    radio('Keep the voice', 'target').click();
    button(dialog, 'Merge')!.click();
    const kept = await storedMember(story, story.ids.Bob!, (m) => m.aliases.includes('Robert'));
    expect(kept.voice.voiceName).not.toBe(david.name);
    expect(await names(story)).not.toContain('Robert');
    await until(
      () => snackbar()?.textContent?.includes('Robert merged into Bob, with Robert’s voice'),
      'the merge in the bar',
    );
    // Undo puts both back, voice and all.
    button(snackbar()!, 'Undo')!.click();
    const back = await storedMember(story, story.ids.Bob!, (m) => m.voice.voiceName === david.name);
    expect(back.aliases).toEqual([]);
    expect(await names(story)).toContain('Robert');
  });

  it('takes a name that was never anyone out of the cast from its ⋯ menu', async () => {
    const story = await storeStory(bob);
    const host = await openCast(story);
    const menu = cardOf(host, 'Bob').querySelector<HTMLDetailsElement>('.member-menu')!;
    menu.open = true;
    menu.dispatchEvent(new Event('toggle'));
    button(menu, 'Not a character')!.click();
    await until(() => button(menu, 'Tap again: their lines go to Unknown speaker'), 'second tap');
    button(menu, 'Tap again: their lines go to Unknown speaker')!.click();
    await until(async () => !(await names(story)).includes('Bob'), 'Bob gone');
    const unknown = (await getStory(db, story.storyId))!.cast.find((c) => c.role === 'unknown')!;
    // Bob's line goes to the unknown speaker, and so does the name, so later parts give it there.
    expect(unknown.aliases).toEqual(['Bob']);
    const { partIds } = (await getStory(db, story.storyId))!;
    const segments = (await db.analyses.get(partIds[0]!))!.segments;
    expect(segments.some((s) => s.speakerId === unknown.id && s.source === 'user')).toBe(true);
    expect((await until(snackbar, 'the bar')).textContent).toContain(
      'Bob taken out of the cast · 1 line now read by Unknown speaker.',
    );
  });

  it('renames from the ⋯ menu', async () => {
    const story = await storeStory(bob);
    const host = await openCast(story);
    const menu = cardOf(host, 'Bob').querySelector<HTMLDetailsElement>('.member-menu')!;
    menu.open = true;
    menu.dispatchEvent(new Event('toggle'));
    button(menu, 'Rename')!.click();
    const input = await until(() => menu.querySelector<HTMLInputElement>('.rename input'), 'input');
    typeInto(input, 'Bobby');
    submit(menu.querySelector('.rename')!);
    await storedMember(story, story.ids.Bob!, (m) => m.name === 'Bobby');
  });

  it('shows a member’s few lines open in its card, and only in the open one', async () => {
    const host = await openCast(await storeStory(bob));
    const lines = cardOf(host, 'Bob').querySelector<HTMLDetailsElement>('details.lines')!;
    expect(lines.open).toBe(false);
    await openCard(cardOf(host, 'Bob'));
    await until(() => lines.open && lines.querySelectorAll('ol a').length === 1, 'the line');
    // Robert's three lines are worked out only once his card opens.
    expect(cardOf(host, 'Robert').querySelectorAll('details.lines ol a')).toHaveLength(0);
  });

  it('takes back a “Not the same” with Undo, and names the pair for screen readers', async () => {
    const story = await storeStory(bob);
    const host = await openCast(story);
    const notSame = button(dupes(host)!, 'Not the same')!;
    expect(notSame.getAttribute('aria-label')).toBe('Bob and Robert are not the same person');
    notSame.click();
    await until(() => !dupes(host), 'the suggestion gone');
    const bar = await until(snackbar, 'the bar');
    expect(bar.textContent).toContain('Bob and Robert won’t be suggested again.');
    // Focus doesn't drop to the page: the Characters heading takes it.
    expect(document.activeElement?.id).toBe('group-character');
    button(bar, 'Undo')!.click();
    await until(() => dupes(host), 'the suggestion back');
  });

  it('turns a suggestion round with each Swap', async () => {
    const story = await storeStory(bob);
    const host = await openCast(story);
    button(dupes(host)!, 'Swap')!.click();
    await until(() => pairs(host)[0] === 'Robert → into Bob', 'swapped');
    // The way chosen is kept as who merges, so it holds whatever the line counts do; a second
    // Swap turns it back.
    button(dupes(host)!, 'Swap')!.click();
    await until(() => pairs(host)[0] === 'Bob → into Robert', 'turned back');
  });

  it('explains a refused rename from the ⋯ menu in the bar', async () => {
    const story = await storeStory(bob);
    const host = await openCast(story);
    const menu = cardOf(host, 'Bob').querySelector<HTMLDetailsElement>('.member-menu')!;
    menu.open = true;
    menu.dispatchEvent(new Event('toggle'));
    button(menu, 'Rename')!.click();
    const input = await until(() => menu.querySelector<HTMLInputElement>('.rename input'), 'input');
    expect(input.getAttribute('aria-label')).toBe('Name');
    typeInto(input, 'Robert');
    submit(menu.querySelector('.rename')!);
    await until(
      () => snackbar()?.textContent?.includes('“Robert” is already in the cast.'),
      'the refusal',
    );
    expect(await names(story)).toContain('Bob');
  });

  it('offers no voice choice when merging into the narrator, who keeps its own', async () => {
    const host = await openCast(await storeStory(bob));
    const dialog = await openMergeSheet(cardOf(host, 'Bob'));
    button(dialog, 'Narrator')!.click();
    await until(() => dialog.querySelector('.compare'), 'the comparison');
    expect(dialog.querySelectorAll('fieldset')).toHaveLength(0);
    button(dialog, 'Robert')!.click();
    await until(() => dialog.querySelectorAll('fieldset').length === 2, 'both choices');
    // Each pair of radios is one group.
    const groups = new Set(
      [...dialog.querySelectorAll('input[type="radio"]')].map((r) => r.getAttribute('name')),
    );
    expect(groups.size).toBe(2);
  });
});
