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

function cardOf(host: HTMLElement, name: string): HTMLElement {
  const card = [...host.querySelectorAll<HTMLElement>('li.card')].find(
    (li) => li.querySelector('h2')?.textContent?.trim() === name,
  );
  if (!card) throw new Error(`no card for ${name}`);
  return card;
}

/** Fills in a card's names and presses "Save names". */
function saveNames(card: HTMLElement, { name, aliases }: { name?: string; aliases?: string }) {
  const [nameInput, aliasesInput] =
    card.querySelectorAll<HTMLInputElement>('.editor .fields input');
  if (name !== undefined) typeInto(nameInput!, name);
  if (aliases !== undefined) typeInto(aliasesInput!, aliases);
  submit(card.querySelector('.editor .fields')!);
}

const clash = (card: HTMLElement) => card.querySelector('.editor .fields [role="alert"]');
const clashShown = (card: HTMLElement) =>
  until(() => clash(card)?.textContent?.trim(), 'the name clash');

/** Chooses `target` in a card's merge list, then presses Merge and Confirm merge. */
async function mergeInto(card: HTMLElement, target: string) {
  const select = card.querySelector<HTMLSelectElement>('.editor .merge select')!;
  select.value = [...select.options].find((o) => o.textContent?.trim() === target)!.value;
  select.dispatchEvent(new Event('change'));
  const merge = () => card.querySelector<HTMLButtonElement>('.editor .merge button')!;
  await until(() => !merge().disabled, 'Merge');
  merge().click();
  await until(() => merge().textContent?.trim() === 'Confirm merge', 'Confirm merge');
  merge().click();
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
    saveNames(cardOf(host, 'Elizabeth'), { aliases: 'Lizzy, Jane' });
    expect(await clashShown(cardOf(host, 'Elizabeth'))).toBe(
      '“Jane” is already in the cast. Use “Same person as…” to merge them.',
    );
    const cast = (await getStory(db, story.storyId))!.cast;
    expect(cast.find((c) => c.id === story.ids.Elizabeth)!.aliases).toEqual([]);
  });

  it('sends the narrator’s editor to the other member’s card to merge', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    saveNames(cardOf(host, 'Narrator'), { aliases: 'Watson' });
    expect(await clashShown(cardOf(host, 'Narrator'))).toBe(
      '“Watson” is already in the cast. If Watson tells the whole story, open Watson’s card and ' +
        'use “Same person as… Narrator” to merge them.',
    );
    expect((await getStory(db, story.storyId))!.cast[0]!.aliases).toEqual([]);
  });

  it('points the unknown speaker’s editor to giving its lines away', async () => {
    const host = await openCast(await storeStory(holmes));
    saveNames(cardOf(host, 'Unknown speaker'), { name: 'Holmes' });
    expect(await clashShown(cardOf(host, 'Unknown speaker'))).toBe(
      '“Holmes” is already in the cast. To have Holmes read these lines, use “Give all these ' +
        'lines to…”.',
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
    saveNames(cardOf(host, 'Holmes'), { aliases: 'a voice' });
    expect(await clashShown(cardOf(host, 'Holmes'))).toBe(
      '“a voice” is already in the cast as “Unknown speaker”. To give it to Holmes, open Unknown ' +
        'speaker’s card and remove it from “Other names” first.',
    );
    saveNames(cardOf(host, 'Narrator'), { aliases: 'a voice' });
    expect(await clashShown(cardOf(host, 'Narrator'))).toBe(
      '“a voice” is already in the cast as “Unknown speaker”. To give it to Narrator, open ' +
        'Unknown speaker’s card and remove it from “Other names” first.',
    );
    // Doing so frees the name.
    saveNames(cardOf(host, 'Unknown speaker'), { aliases: '' });
    await until(() => !cardOf(host, 'Unknown speaker').textContent?.includes('“a voice”'), 'save');
    saveNames(cardOf(host, 'Holmes'), { aliases: 'a voice' });
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
    const names = () => [...host.querySelectorAll('li.card h2')].map((h) => h.textContent?.trim());
    saveNames(cardOf(host, 'Unknown speaker'), { name: 'Crowd' });
    await until(() => names().includes('Crowd'), 'the rename');
    saveNames(cardOf(host, 'Holmes'), { name: 'crowd' });
    expect(await clashShown(cardOf(host, 'Holmes'))).toBe(
      '“crowd” is already in the cast. To give it to Holmes, open Crowd’s card and change its ' +
        'name first.',
    );
    const cast = (await getStory(db, story.storyId))!.cast;
    expect(cast.map((c) => c.name)).toEqual(['Narrator', 'Crowd', 'Holmes', 'Watson']);
  });

  it('includes “Narrator” typed as a character’s name', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    saveNames(cardOf(host, 'Holmes'), { name: 'Narrator' });
    expect(await clashShown(cardOf(host, 'Holmes'))).toBe(
      '“Narrator” is already in the cast. Use “Same person as…” to merge them.',
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
    saveNames(cardOf(host, 'Narrator'), { name: 'Watson' });
    expect(await clashShown(cardOf(host, 'Narrator'))).toBe(
      '“Watson” is already in the cast. If Watson tells the whole story, open Watson’s card and ' +
        'use “Same person as… Narrator” to merge them.',
    );
    const saved = (await getStory(db, story.storyId))!.cast;
    expect(saved.map((c) => c.name)).toEqual(['Narrator', 'Unknown speaker', 'Holmes', 'Watson']);
  });

  it('includes “Narrator” saved as a character’s other name, then typed as its name', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    saveNames(cardOf(host, 'Holmes'), { aliases: 'Narrator' });
    await until(() => cardOf(host, 'Holmes').textContent?.includes('also “Narrator”'), 'the save');
    saveNames(cardOf(host, 'Holmes'), { name: 'Narrator' });
    expect(await clashShown(cardOf(host, 'Holmes'))).toBe(
      '“Narrator” is already in the cast. Use “Same person as…” to merge them.',
    );
    const cast = (await getStory(db, story.storyId))!.cast;
    expect(cast.map((c) => c.name)).toEqual(['Narrator', 'Unknown speaker', 'Holmes', 'Watson']);
  });

  it('stops being shown once the merge it suggests is done, also after later merges', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    saveNames(cardOf(host, 'Narrator'), { name: 'Watson' });
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
    saveNames(cardOf(host, 'Nick'), { name: 'Narrator' });
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
      .map((li) => li.querySelector('h2')?.textContent?.trim());
  const search = (host: HTMLElement) => host.querySelector<HTMLInputElement>('.cast-filter input')!;

  it('shows only the members whose name or other names match', async () => {
    const host = await openCast(await storeStory(holmes));
    typeInto(search(host), 'wat');
    await until(() => shownNames(host).length === 1, 'the filtered cast');
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
    const editor = cardOf(host, 'Watson').querySelector('details')!;
    editor.open = true;
    const nameInput = editor.querySelector<HTMLInputElement>('.editor .fields input')!;
    typeInto(nameInput, 'John Watson');
    typeInto(search(host), 'holm');
    await until(() => !shownNames(host).includes('Watson'), 'Watson hidden');
    typeInto(search(host), '');
    await until(() => shownNames(host).includes('Watson'), 'Watson back');
    expect(cardOf(host, 'Watson').querySelector('details')!.open).toBe(true);
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
const keptNote = (card: HTMLElement) => traitsOf(card).querySelector('[role="alert"]');
/** The card's voice picker: the first list in it. */
const voiceSelect = (card: HTMLElement) => card.querySelector<HTMLSelectElement>('select')!;
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

/** Picks the device voice called `name` ('' is the device default) in a card's voice picker. */
async function chooseVoice(card: HTMLElement, name: string) {
  const select = voiceSelect(card);
  await until(() => [...select.options].some((o) => o.value === name), `the voice ${name}`);
  select.value = name;
  select.dispatchEvent(new Event('change'));
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
    await until(() => voiceSelect(cardOf(host, 'Holmes')).value === zira.name, 'the new voice');
    expect(keptNote(cardOf(host, 'Holmes'))).toBeNull();
    // A story being played takes the new voice up from its next line.
    await playerTold(1);
  });

  it('say why a change was not saved, until the next change is', async () => {
    const story = await storeStory(holmes);
    const host = await openCast(story);
    const card = cardOf(host, 'Holmes');
    const error = () => host.querySelector('main > p.error');
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
    const blocks = [...cardOf(host, 'Holmes').querySelectorAll('details')];
    expect(blocks.map((d) => d.querySelector('summary')!.textContent?.trim())).toEqual([
      'Edit names or merge',
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
    const match = host.querySelector<HTMLButtonElement>('.match button')!;
    match.click();
    await until(() => match.textContent?.trim() === 'Confirm match', 'the first press');
    match.click();
    await pause();
    expect(await castOf(story)).toEqual(before);

    listVoices();
    const saved = await storedMember(story, story.ids.Holmes!, (m) => !!m.voice.voiceName);
    expect(saved.voice.voiceName).toBe(zira.name);
  });
});

describe('the voice picker', () => {
  it('tells the gender a voice’s name gives away, and which voices are online', async () => {
    stubVoices.push(zira, david, plain, { name: 'en-cloud', lang: 'en-US', network: true });
    const host = await openCast(await storeStory(holmes));
    const select = voiceSelect(cardOf(host, 'Holmes'));
    await until(() => select.options.length > 1, 'the voices');
    expect(optionLabels(select)).toEqual([
      'Device default (en-US)',
      'Microsoft Zira - English (United States) (female)',
      'Microsoft David - English (United States) (male)',
      'en-plain',
      'en-cloud (online)',
    ]);
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
  // Truthful about a story from before voices were marked: its hand-picked voices have no mark.
  const WARNING =
    'Traits missing from a character are guessed from its names, then every voice not marked ' +
    'as set by hand is picked again. A voice you chose before this update has no mark, so it is ' +
    'picked again too. Press again to confirm.';
  const oldMan: Chunk[] = [
    ...holmes,
    ['\n\n“Who goes there?”', 'the old man', 'speech'],
    [' asked the old man.', 'N', 'narration'],
  ];
  const matchButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.match button');
  const warning = (host: HTMLElement) => host.querySelector('.match [role="alert"]');

  it('needs two presses, then guesses traits from names and picks the voices again', async () => {
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

    const match = matchButton(host)!;
    expect(match.textContent?.trim()).toBe('Match voices to traits');
    expect(warning(host)).toBeNull();
    match.click();
    const shown = await until(() => warning(host), 'the warning');
    expect(shown.textContent?.trim().replace(/\s+/gu, ' ')).toBe(WARNING);
    expect(match.classList.contains('danger')).toBe(true);
    expect(match.textContent?.trim()).toBe('Confirm match');
    // Nothing happens before the second press, and the player is told of nothing new.
    expect((await getStory(db, story.storyId))!.cast).toEqual(before);
    expect(castChanged).toHaveBeenCalledTimes(1);

    match.click();
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
    // The button is back to its first press, and says what it did.
    await until(() => !warning(host), 'the warning to go');
    expect(match.classList.contains('danger')).toBe(false);
    expect(match.textContent?.trim()).toBe('Match voices to traits');
    const done = await until(() => host.querySelector('.match [role="status"]'), 'the result');
    expect(done.textContent?.trim()).toBe('Voices matched to traits.');
    // What it did is said until focus moves on.
    match.dispatchEvent(new Event('blur'));
    await until(() => !host.querySelector('.match [role="status"]'), 'the result to go');
  });

  it('is disarmed when focus leaves the button', async () => {
    stubVoices.push(zira, david);
    const story = await storeStory(oldMan);
    const host = await openCast(story);
    const before = (await getStory(db, story.storyId))!.cast;
    const match = matchButton(host)!;
    match.click();
    await until(() => warning(host), 'the warning');
    match.dispatchEvent(new Event('blur'));
    await until(() => !warning(host), 'the warning to go');
    expect(match.textContent?.trim()).toBe('Match voices to traits');
    // The next press is a first press again.
    match.click();
    await until(() => warning(host), 'the warning again');
    expect((await getStory(db, story.storyId))!.cast).toEqual(before);
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
