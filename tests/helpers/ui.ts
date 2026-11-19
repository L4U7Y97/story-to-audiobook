// Mounts the app's views on stories stored in a fake IndexedDB. A test file using it starts with
// `import 'fake-indexeddb/auto'` and mocks '@/ui/composables/usePlayer' with playerStub(): the
// real player needs a speech engine.
import { vi } from 'vitest';
import {
  createApp,
  defineComponent,
  h,
  ref,
  shallowRef,
  watch,
  type App,
  type Component,
} from 'vue';
import {
  createMemoryHistory,
  createRouter,
  RouterView,
  type RouteLocationNamedRaw,
  type RouteLocationRaw,
  type RouteRecordRaw,
  type Router,
} from 'vue-router';
import type { Character, Mode, Segment, Traits, VoiceSettings } from '@/format/types';
import type { DeviceVoice } from '@/playback/engine';
import { stillListening, type PlayerPosition, type PlayerSnapshot } from '@/playback/player';
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

/**
 * The stubbed player's preview (the line and voice it was asked to speak) and stop. A preview ends
 * at once unless a test gives it a longer run; unmountView forgets the calls and any such run.
 */
export const previewed = vi.fn<(text: string, voice: VoiceSettings) => Promise<void>>(
  async () => undefined,
);

const IDLE: PlayerSnapshot = { state: 'idle', speed: 1 };

/**
 * The stubbed player's snapshot, which a test may set to put the player somewhere (playing a
 * line, say), and its play, pause, resume and jump, which move the snapshot as the real player
 * does, without speaking. unmountView puts the player back to idle and forgets the calls.
 */
export const playerSnapshot = shallowRef<PlayerSnapshot>(IDLE);
/** Whether the stubbed player's place is one being listened to, kept as usePlayer keeps it. */
export const playerListening = ref(false);
watch(playerSnapshot, (s) => (playerListening.value = stillListening(playerListening.value, s)), {
  flush: 'sync',
});
const moveTo = (changes: Partial<PlayerSnapshot>) => {
  playerSnapshot.value = { ...playerSnapshot.value, ...changes };
};
export const played = vi.fn<(from?: PlayerPosition) => Promise<void>>(async (from) =>
  moveTo({ state: 'playing', position: from ?? playerSnapshot.value.position, ended: undefined }),
);
export const paused = vi.fn<() => Promise<void>>(async () => {
  if (playerSnapshot.value.state === 'playing') moveTo({ state: 'paused' });
});
export const resumed = vi.fn<() => Promise<void>>(async () => {
  if (playerSnapshot.value.state === 'paused') moveTo({ state: 'playing' });
});

/** Settles when the stubbed player may move where it jumps; unset, it moves at once. */
let jumpsHeld: Promise<void> | undefined;

/**
 * Makes the stubbed player slow to move where it jumps, as the real one is while its engine stops
 * (a bridge call on Android): its snapshot stays put until the function this returns is called.
 * unmountView ends the hold.
 */
export function holdJumps(): () => void {
  let release: () => void = () => undefined;
  jumpsHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => release();
}

export const jumped = vi.fn<(to: PlayerPosition) => Promise<void>>(async (to) => {
  if (jumpsHeld) await jumpsHeld;
  moveTo({
    position: to,
    state: playerSnapshot.value.state === 'playing' ? 'playing' : 'idle',
    ended: undefined,
  });
});
export const stopped = vi.fn<() => Promise<void>>(async () => moveTo({ state: 'idle' }));
/** The stubbed player's partsChanged, which a view calls once it changed parts. */
export const partsChanged = vi.fn<() => Promise<void>>(async () => undefined);

/**
 * The story whose player has been made, as usePlayer makes it: existingPlayer finds it for that
 * story only. unmountView forgets it.
 */
let playerStory: string | undefined;

/** As if a view had played `storyId` already: its player exists, in `snapshot`. */
export function playerAlreadyMade(storyId: string, snapshot: PlayerSnapshot) {
  playerStory = storyId;
  playerSnapshot.value = snapshot;
}

/** The stubbed restorePlace, which a view calls to take up the place a killed app reached. */
export const placeRestored = vi.fn<(storyId: string) => Promise<void>>(async () => undefined);

/** What usePlayer.ts exports, with a player that does not speak and an engine listing stubVoices. */
export function playerStub() {
  const done = async () => undefined;
  const player = {
    play: played,
    pause: paused,
    resume: resumed,
    stop: stopped,
    jump: jumped,
    setSpeed: done,
    preview: previewed,
    skipSegment: done,
    skipParagraph: done,
    skipPart: done,
    castChanged,
    partsChanged,
    subscribe: () => () => undefined,
  };
  const listVoices = async () => {
    if (voicesHeld) await voicesHeld;
    return [...stubVoices];
  };
  const made = { player, snapshot: playerSnapshot, listening: playerListening };
  return {
    getEngine: () => ({ listVoices }),
    existingPlayer: (storyId: string) => (playerStory === storyId ? made : undefined),
    restorePlace: placeRestored,
    usePlayer: (storyId: string) => {
      // Another story's player stops, and this story's starts idle.
      if (playerStory !== undefined && playerStory !== storyId) {
        void stopped();
        playerSnapshot.value = IDLE;
        playerListening.value = false;
      }
      playerStory = storyId;
      return made;
    },
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
  { characters = [] }: { characters?: Array<{ name: string; aliases?: string[] } & Traits> } = {},
): Promise<StoredStory> {
  const story = await createStory(db, { title: 'Story', lang: 'en' });
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

/**
 * The app's routes (src/ui/router.ts), every page blank but `shown`'s, which gets its route's
 * props as the app gives them.
 */
function appRoutes(shown?: { name: string; view: Component }): RouteRecordRaw[] {
  const page = (name: string) => (shown?.name === name ? shown.view : Blank);
  return [
    { path: '/', component: Blank },
    { path: '/library', name: 'library', component: page('library') },
    { path: '/story/:id', name: 'story', component: page('story'), props: true },
    { path: '/story/:id/book/:bookId', name: 'book', component: page('book'), props: true },
    {
      path: '/story/:id/read/:partId?',
      name: 'reader',
      component: page('reader'),
      props: (route) => ({
        ...route.params,
        line: typeof route.query.line === 'string' ? Number(route.query.line) : undefined,
      }),
    },
    { path: '/story/:id/cast', name: 'cast', component: page('cast'), props: true },
  ];
}

/** Mounts `root` with a router on `routes`, at `to`; returns the element it is mounted in. */
async function mountWithRouter(
  root: Component,
  props: Record<string, unknown> | undefined,
  routes: RouteRecordRaw[],
  to: RouteLocationRaw,
  onRouter?: (router: Router) => void,
) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  onRouter?.(router);
  await router.push(to);
  await router.isReady();
  const host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(root, props).use(router);
  app.mount(host);
  return host;
}

/** Mounts `view` with `props`, with a router; returns the element it is mounted in. */
export function mountView(
  view: Component,
  props: Record<string, unknown>,
  onRouter?: (router: Router) => void,
) {
  return mountWithRouter(view, props, appRoutes(), '/', onRouter);
}

/**
 * Mounts `view` as the app shows it at the route `to` names: under the router, so a new route
 * (a router.replace, say) gives it new props. Returns the element it is mounted in.
 */
export function mountRouted(
  view: Component,
  to: RouteLocationNamedRaw & { name: string },
  onRouter?: (router: Router) => void,
) {
  const root: Component = { render: () => h(RouterView) };
  return mountWithRouter(root, undefined, appRoutes({ name: to.name, view }), to, onRouter);
}

/**
 * Unmounts the view and empties the page, for afterEach. The stubbed engine and player start
 * afresh: no voices, none held back, no player made, the player idle, no call to it remembered.
 */
export function unmountView() {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = '';
  stubVoices.length = 0;
  voicesHeld = undefined;
  castChanged.mockClear();
  previewed.mockReset();
  previewed.mockImplementation(async () => undefined);
  playerSnapshot.value = IDLE;
  playerListening.value = false;
  jumpsHeld = undefined;
  playerStory = undefined;
  for (const spy of [played, paused, resumed, stopped, jumped, partsChanged, placeRestored]) {
    spy.mockClear();
  }
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

export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

export function submit(form: Element) {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}
