import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStory, updateStory } from '@/storage/stories';
import CastView from '@/ui/views/CastView.vue';
import {
  db,
  mountView,
  storeStory,
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
