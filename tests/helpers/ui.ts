// Mounts the app's views on stories stored in a fake IndexedDB. A test file using it starts with
// `import 'fake-indexeddb/auto'` and mocks '@/ui/composables/usePlayer' with playerStub(): the
// real player needs a speech engine.
import { vi } from 'vitest';
import { createApp, defineComponent, h, shallowRef, type App, type Component } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Character, Lang, Mode, Segment, Traits } from '@/format/types';
import type { DeviceVoice } from '@/playback/engine';
import type { PlayerSnapshot } from '@/playback/player';
import { getAppDb } from '@/storage/db';
import { getAnalysis, saveAnalysis } from '@/storage/analyses';
import { addPart } from '@/storage/parts';
import { createStory, updateStory } from '@/storage/stories';

/** The database the views read. */
export const db = getAppDb();

/**
 * The voices the stubbed engine lists: none by default. A test pushes the device's voices before
 * it mounts a view; unmountView empties the list again.
 */
export const stubVoices: DeviceVoice[] = [];

/** Settles when the stubbed engine may list its voices; unset, it lists them at once. */
let voicesHeld: Promise<void> | undefined;

/**
 * Makes the stubbed engine slow to list its voices, as a device is on the first open of a view:
 * nothing is listed until the function this returns is called. unmountView ends the hold.
 */
export function holdVoices(): () => void {
  let release: () => void = () => undefined;
  voicesHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => release();
}

/**
 * The stubbed player's castChanged, which a view calls to have the player take up a change to the
 * cast. A test checks its calls; unmountView forgets them.
 */
export const castChanged = vi.fn<() => void>();

/** What usePlayer.ts exports, with a player that does nothing and an engine listing stubVoices. */
export function playerStub() {
  const done = async () => undefined;
  const player = {
    play: done,
    pause: done,
    resume: done,
    stop: done,
    jump: done,
    setSpeed: done,
    preview: done,
    skipSegment: done,
    skipParagraph: done,
    skipPart: done,
    castChanged,
    subscribe: () => () => undefined,
  };
  const snapshot = shallowRef<PlayerSnapshot>({ state: 'idle', speed: 1 });
  const listVoices = async () => {
    if (voicesHeld) await voicesHeld;
    return [...stubVoices];
  };
  return {
    getEngine: () => ({ listVoices }),
    existingPlayer: () => undefined,
    usePlayer: () => ({ player, snapshot }),
  };
}

/**
 * A stretch of a part: its text, who reads it ('N' the narrator, 'U' the unknown speaker, or a
 * character's name) and how.
 */
export type Chunk = [text: string, who: string, mode: Mode];

export interface StoredStory {
  storyId: string;
  partId: string;
  text: string;
  /** Cast ids by 'N', 'U' and character name. */
  ids: Record<string, string>;
}

const voice = { lang: 'en-US', pitch: 1, rate: 1 };

/**
 * Stores a story with one part: the chunks' text, analysed exactly as the chunks say. Everyone
 * reading a chunk is in the cast, and so are `characters`, with the traits they are given.
 */
export async function storeStory(
  chunks: Chunk[],
  {
    lang = 'en',
    characters = [],
  }: { lang?: Lang; characters?: Array<{ name: string; aliases?: string[] } & Traits> } = {},
): Promise<StoredStory> {
  const story = await createStory(db, { title: 'Story', lang });
  const ids: Record<string, string> = {
    N: story.narratorId,
    U: story.cast.find((c) => c.role === 'unknown')!.id,
  };
  const added: Character[] = [];
  const speakers: typeof characters = chunks.map(([, name]) => ({ name }));
  for (const { name, aliases = [], ...traits } of [...characters, ...speakers]) {
    if (ids[name]) continue;
    const id = `c-${name.toLowerCase()}`;
    ids[name] = id;
    added.push({ id, role: 'character', name, aliases, ...traits, voice });
  }
  await updateStory(db, story.id, { cast: [...story.cast, ...added] });
  const text = chunks.map(([piece]) => piece).join('');
  const part = await addPart(db, story.id, { title: 'One', source: { kind: 'paste' }, text });
  let at = 0;
  const segments = chunks.map(([piece, who, mode]): Segment => {
    at += piece.length;
    return { start: at - piece.length, end: at, speakerId: ids[who]!, mode, source: 'heuristic' };
  });
  await saveAnalysis(db, {
    partId: part.id,
    textHash: part.textHash,
    analyzer: { kind: 'heuristic', version: 2 },
    createdAt: new Date().toISOString(),
    segments,
  });
  return { storyId: story.id, partId: part.id, text, ids };
}

const Blank = defineComponent({ render: () => h('div') });
let app: App | undefined;

/** Mounts `view` with `props`, with a router; returns the element it is mounted in. */
export async function mountView(view: Component, props: Record<string, unknown>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/story/:id', name: 'story', component: Blank },
      { path: '/story/:id/read/:partId?', name: 'reader', component: Blank },
      { path: '/story/:id/cast', name: 'cast', component: Blank },
    ],
  });
  await router.push('/');
  await router.isReady();
  const host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(view, props).use(router);
  app.mount(host);
  return host;
}

/**
 * Unmounts the view and empties the page, for afterEach. The stubbed engine and player start
 * afresh: no voices, none held back, no castChanged call remembered.
 */
export function unmountView() {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = '';
  stubVoices.length = 0;
  voicesHeld = undefined;
  castChanged.mockClear();
}

/** Polls until `check` gives something truthy: live queries and saves land asynchronously. */
export async function until<T>(
  check: () => T | Promise<T>,
  what: string,
  ms = 3000,
): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The part's stored segments, once `saved` holds for them. */
export function storedSegments(
  partId: string,
  saved: (segments: Segment[]) => boolean,
  what = 'the save',
): Promise<Segment[]> {
  return until(async () => {
    const segments = (await getAnalysis(db, partId))?.segments;
    return segments && saved(segments) ? segments : undefined;
  }, what);
}

/** The part's stored segments once a correction is saved. */
export function savedCorrection(partId: string): Promise<Segment[]> {
  return storedSegments(partId, (s) => s.some((x) => x.source === 'user'), 'a saved correction');
}

export function button(root: ParentNode, label: string | RegExp): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) =>
    typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''),
  );
}

export function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

export function submit(form: Element) {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}
