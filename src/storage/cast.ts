import type { Analysis, Character, Story, Traits, VoiceSettings } from '@/format/types';
import { validateAnalysis } from '@/format/validate';
import {
  matchVoicesToTraits,
  mergeCharacters,
  repickMember,
  setTraits,
  type CastOpResult,
} from '@/cast/castOps';
import type { DeviceVoice } from '@/playback/engine';
import type { StoryDb } from './db';
import { now } from './ids';
import { DEFAULT_LOCALE } from './stories';

/** What undoCastChange needs to put a story's cast, and the analyses a change rewrote, back. */
export interface CastUndo {
  storyId: string;
  /** The story's updatedAt as the change left it: any later write to the story makes it stale. */
  updatedAt: string;
  /** The cast before the change, and (JSON) as the change left it. */
  cast: Character[];
  castAfter: string;
  /** The analyses the change rewrote, as they were before it. */
  analyses: Analysis[];
  /** The same analyses as the change left them, to tell that nothing has rewritten them since. */
  after: string[];
}

/** Why an undo was refused: the story was changed again after the change it would undo. */
export const STALE_UNDO = 'The cast has changed since, so this can’t be undone.';

async function castState(db: StoryDb, storyId: string) {
  const story = await db.stories.get(storyId);
  if (!story) throw new Error(`story ${storyId} not found`);
  const analyses = (await db.analyses.bulkGet(story.partIds)).filter(
    (a): a is Analysis => a !== undefined,
  );
  return { story, analyses };
}

/**
 * Runs `change` (one of the cast changes here) and returns how to undo it, or undefined when it
 * wrote nothing. The change keeps its own transaction: it may wait on things Dexie can't hold a
 * transaction open across (the device's voices), so the state is read before and after instead,
 * and undoCastChange refuses when anything was written in between.
 */
export async function recordCastChange(
  db: StoryDb,
  storyId: string,
  change: () => Promise<void>,
): Promise<CastUndo | undefined> {
  const before = await castState(db, storyId);
  await change();
  const after = await castState(db, storyId);
  const was = new Map(before.analyses.map((a) => [a.partId, a]));
  const rewritten = after.analyses.flatMap((a) => {
    const old = was.get(a.partId);
    const json = JSON.stringify(a);
    return old && JSON.stringify(old) !== json ? [{ old, json }] : [];
  });
  const castAfter = JSON.stringify(after.story.cast);
  if (castAfter === JSON.stringify(before.story.cast) && !rewritten.length) return undefined;
  return {
    storyId,
    updatedAt: after.story.updatedAt,
    cast: before.story.cast,
    castAfter,
    analyses: rewritten.map((r) => r.old),
    after: rewritten.map((r) => r.json),
  };
}

/**
 * Puts back the cast and analyses `undo` holds, in one transaction, unless the story or one of
 * those analyses was written since the change (STALE_UNDO): undoing then would lose that write.
 */
export async function undoCastChange(db: StoryDb, undo: CastUndo): Promise<void> {
  await db.transaction('rw', db.stories, db.analyses, async () => {
    const story = await db.stories.get(undo.storyId);
    // Timestamps are to the millisecond, so the cast itself is compared too.
    const changed =
      !story || story.updatedAt !== undo.updatedAt || JSON.stringify(story.cast) !== undo.castAfter;
    if (changed) throw new Error(STALE_UNDO);
    const current = await db.analyses.bulkGet(undo.analyses.map((a) => a.partId));
    if (current.some((a, i) => JSON.stringify(a) !== undo.after[i])) throw new Error(STALE_UNDO);
    await db.stories.update(undo.storyId, { cast: undo.cast, updatedAt: now() });
    await db.analyses.bulkPut(undo.analyses);
  });
}

/**
 * Merges one character into another across the whole story in a single transaction: the cast and
 * every affected analysis are rewritten and re-validated, or nothing changes.
 */
export async function mergeCharactersInStory(
  db: StoryDb,
  storyId: string,
  fromId: string,
  intoId: string,
): Promise<void> {
  await db.transaction('rw', db.stories, db.parts, db.analyses, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw new Error(`story ${storyId} not found`);
    const analyses = (await db.analyses.bulkGet(story.partIds)).filter(
      (a): a is Analysis => a !== undefined,
    );

    const result = mergeCharacters(story.cast, analyses, fromId, intoId);
    if (!result.ok) throw new Error(result.reason);
    const { cast, analyses: updated } = result.value;

    const castIds = new Set(cast.map((c) => c.id));
    const changed = updated.filter((a, i) => a !== analyses[i]);
    for (const analysis of changed) {
      const part = await db.parts.get(analysis.partId);
      const check = part ? validateAnalysis(part, analysis, castIds) : { ok: true as const };
      if (!check.ok) throw new Error(`merge would break part ${analysis.partId}: ${check.reason}`);
    }

    await db.stories.update(storyId, { cast, updatedAt: now() });
    await db.analyses.bulkPut(changed);
  });
}

/**
 * Sets or clears (undefined) traits of a cast member and, unless its voice was set by hand, picks
 * its voice again to match (setTraits). `repicked` tells whether the voice was picked again.
 * Nothing is written when nothing changes.
 */
export async function setTraitsInStory(
  db: StoryDb,
  storyId: string,
  characterId: string,
  changes: { [K in keyof Traits]?: Traits[K] | undefined },
  deviceVoices: readonly DeviceVoice[],
): Promise<{ repicked: boolean }> {
  let repicked = false;
  await changeCast(db, storyId, (story) => {
    const value = valueOf(
      setTraits(story.cast, characterId, changes, deviceVoices, DEFAULT_LOCALE),
    );
    repicked = value.repicked;
    return value.cast;
  });
  return { repicked };
}

/** Picks a cast member's voice again from its traits, also when it was set by hand. */
export async function repickVoiceInStory(
  db: StoryDb,
  storyId: string,
  characterId: string,
  deviceVoices: readonly DeviceVoice[],
): Promise<void> {
  await changeCast(db, storyId, (story) =>
    valueOf(repickMember(story.cast, characterId, deviceVoices, DEFAULT_LOCALE)),
  );
}

/**
 * Matches the voices of the whole cast to its traits (matchVoicesToTraits): traits missing from a
 * character are guessed from its names, then every character voice not set by hand is picked
 * again.
 */
export async function matchVoicesInStory(
  db: StoryDb,
  storyId: string,
  deviceVoices: readonly DeviceVoice[],
): Promise<void> {
  await changeCast(db, storyId, (story) =>
    matchVoicesToTraits(story.cast, deviceVoices, DEFAULT_LOCALE),
  );
}

/**
 * Changes a member's voice by hand (voice picker, pitch, speed): merges `changes` into its voice
 * and marks it manual, so automatic re-picks leave it alone. A `voiceName: undefined` change
 * removes the voice name ("Device default").
 */
export async function setVoiceInStory(
  db: StoryDb,
  storyId: string,
  characterId: string,
  changes: Partial<Pick<VoiceSettings, 'voiceName' | 'lang' | 'pitch' | 'rate'>>,
): Promise<void> {
  await changeCast(db, storyId, (story) => {
    if (!story.cast.some((c) => c.id === characterId)) throw new Error('character not found');
    return story.cast.map((c) => {
      if (c.id !== characterId) return c;
      const voice: VoiceSettings = { ...c.voice, manual: true };
      if (changes.voiceName !== undefined) voice.voiceName = changes.voiceName;
      else if ('voiceName' in changes) delete voice.voiceName;
      if (changes.lang !== undefined) voice.lang = changes.lang;
      if (changes.pitch !== undefined) voice.pitch = changes.pitch;
      if (changes.rate !== undefined) voice.rate = changes.rate;
      return { ...c, voice };
    });
  });
}

/**
 * Reads the story and writes the cast `change` gives in one transaction, or nothing when it
 * throws. A change that hands back the story's own cast array changed nothing and writes nothing.
 */
async function changeCast(
  db: StoryDb,
  storyId: string,
  change: (story: Story) => Character[],
): Promise<void> {
  await db.transaction('rw', db.stories, async () => {
    const story = await db.stories.get(storyId);
    if (!story) throw new Error(`story ${storyId} not found`);
    const cast = change(story);
    if (cast !== story.cast) await db.stories.update(storyId, { cast, updatedAt: now() });
  });
}

function valueOf<T>(result: CastOpResult<T>): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
