/** The Attributor: reads a part's paragraphs in order and picks the speaker of each line. */

import type { Character, Mode, Tone } from '@/format/types';
import type { LabelResult, SpanLabel, SpeakerRef } from '../labels';
import { groupByParagraph, OPENING_QUOTE, type Unit } from '../units';
import { Cast } from './cast';
import { narrationIntro, replyIntro, type Intro } from './intros';
import { asksInLine, namesSoFar, read, vocativeMentions } from './lines';
import { someone, type Reading, type Who } from './reading';
import { isHeading, Scene, sceneCue } from './scene';
import { beatAfter, beatBefore, tagNear } from './tags';
import { findTellerTag, isFirstPerson, selfIntroduced } from './teller';
import { untilTimeAt } from './time';
import { afterPreposition, wordBefore, type Token } from './tokens';
import { Turns } from './turns';

const CLOSING_QUOTE = /[”"’']\s*$/u;

export class Attributor implements Reading {
  readonly cast: Cast;
  readonly turns: Turns;
  private readonly scene: Scene;
  /** The last line's speaker, the unknown speaker included. */
  private lastTurn?: Who;
  /** The last colon intro, read by the next paragraph. */
  private intro: Intro = { notTeller: false };
  /** Who said the last line, when it asked something. */
  private lastAsker?: string;
  /** The line `lastAsker` said. */
  private lastQuestion?: string;
  /** Who asked the question right before the last heading, until the next line. */
  private headingAsker?: string;
  private continuesSpeech = false;

  constructor(
    readonly text: string,
    private readonly units: readonly Unit[],
    cast: readonly Character[],
  ) {
    this.cast = new Cast(cast);
    this.turns = new Turns(this.cast);
    this.scene = new Scene(this.cast, this.turns);
  }

  run(): LabelResult {
    this.turns.tellerSpeaks = findTellerTag(this, this.units);
    const spans: SpanLabel[] = [];
    for (const paragraph of groupByParagraph(this.units)) {
      spans.push(...this.paragraph(paragraph));
    }
    const used = new Set(spans.map((s) => (s.speaker.kind === 'new' ? s.speaker.ref : '')));
    const newCharacters = this.cast.newCharacters(used);
    return { spans, newCharacters, aliasAdditions: this.cast.aliasAdditions };
  }

  private paragraph(units: Unit[]): SpanLabel[] {
    const { tokens, isVoiced } = read(this, units);
    const voiced = units.filter(isVoiced);

    if (voiced.length === 0) {
      this.narrationParagraph(units, tokens);
      return units.map((u) => this.label(u, this.cast.narratorKey, 'narration', undefined, true));
    }

    // Where each unit stands, so a long paragraph is never searched line by line.
    const at = new Map(units.map((u, n) => [u, n]));
    // Each voiced unit takes its nearest tag; untagged ones share the paragraph's speaker.
    const tags = new Map(
      voiced.map((u) => [u, tagNear(this, units, at.get(u)!, tokens, isVoiced)]),
    );
    // The names each line calls on, and the people among them.
    const calls = new Map(
      voiced.map((u) => [u, vocativeMentions(this, units, at.get(u)!, tokens.get(u)!)]),
    );
    const callsRead = this.cast.version;
    const vocatives = new Map(voiced.map((u) => [u, this.cast.keys(calls.get(u)!)]));
    // A call on someone not in the cast yet, read before touchVocatives adds them.
    const unknownCall = new Map(
      voiced.map((u) => [u, calls.get(u)!.some((m) => !this.cast.match(m.name))]),
    );
    // Nobody says a line to themselves: the people it is said to never speak it.
    const saidTo = (u: Unit) => new Set([...(tags.get(u)?.addressees ?? []), ...vocatives.get(u)!]);
    // The people each unit names, read in one walk of the paragraph. Nothing in this loop resolves
    // a mention or adds a name (byGender only learns genders), so they stay valid throughout.
    const namedBefore = namesSoFar(this, units, tokens, vocatives);
    for (const u of voiced) {
      const tag = tags.get(u);
      if (tag?.speaker === undefined && tag?.pending) {
        // People named earlier in the paragraph come first: "“Hello,” said Tom, turning to
        // Anne. “How are you?” she asked."
        tag.speaker = this.turns.byGender(
          tag.pending,
          saidTo(u),
          tag.verb,
          namedBefore(at.get(u)!),
        );
      }
    }
    // Who cannot say a line whose tag names nobody: the people it is said to, the teller when the
    // tag is someone else's ("she asked"), and anyone known to have another gender than its "he"
    // or "she".
    const ruledOut = (u: Unit) => {
      const tag = tags.get(u);
      const out = saidTo(u);
      if (tag?.toTeller || tag?.notTeller) out.add(this.cast.narratorKey);
      if (tag?.pending) for (const k of this.turns.otherGender(tag.pending)) out.add(k);
      return out;
    };
    const exclude = new Set<string>();
    for (const u of voiced) if (!tags.get(u)?.speaker) for (const k of ruledOut(u)) exclude.add(k);
    // An untagged line right after a narration sentence (a beat, or narration between two lines)
    // is its subject's.
    const beats = new Map<Unit, Who>();
    for (const u of voiced) {
      if (tags.get(u)?.speaker) continue;
      const n = at.get(u)!;
      const beat =
        beatBefore(this, units, n, tokens, isVoiced) ?? beatAfter(this, units, n, tokens, isVoiced);
      if (beat && !ruledOut(u).has(beat.key)) beats.set(u, beat);
    }

    const allTags = [...tags.values()];
    const firstTag = allTags.find((t) => t !== undefined);
    const speakerTag = allTags.find((t) => t?.speaker);
    let fallback: Who | undefined = speakerTag?.speaker
      ? { key: speakerTag.speaker, teller: speakerTag.teller }
      : undefined;
    if (!fallback && this.continuesSpeech && OPENING_QUOTE.test(this.slice(voiced[0]!))) {
      fallback = this.lastTurn;
    }
    // A colon intro that names nobody rules people out like a tag: the line after "Then I was
    // asked:" is not the teller's, and the line after "She turned and said:" is not a man's.
    if (this.intro.notTeller) exclude.add(this.cast.narratorKey);
    if (this.intro.gender)
      for (const k of this.turns.otherGender(this.intro.gender)) exclude.add(k);
    // "added" with no speaker: the last speaker goes on.
    const continues = allTags.some((t) => t?.verb.continues && !t.speaker);
    if (!fallback && continues && this.turns.narrationGap <= 1 && this.turns.lastSpeaker) {
      if (!exclude.has(this.turns.lastSpeaker)) fallback = someone(this.turns.lastSpeaker);
    }
    fallback ??= this.intro.speaker ?? beats.get(voiced[0]!);
    if (fallback && exclude.has(fallback.key)) fallback = undefined;
    const chosen: Who = fallback ?? { key: this.turns.alternate(exclude), teller: false };
    // A line's own tag names its speaker, else its beat, else the paragraph's speaker.
    const whoOf = (u: Unit): Who => {
      const own = tags.get(u);
      return own?.speaker ? { key: own.speaker, teller: own.teller } : (beats.get(u) ?? chosen);
    };
    const speakerOf = (u: Unit) => whoOf(u).key;

    const addressed: string[] = [];
    for (const u of voiced) {
      for (const k of [...(tags.get(u)?.addressees ?? []), ...vocatives.get(u)!])
        if (k !== speakerOf(u) && !addressed.includes(k)) addressed.push(k);
      if (tags.get(u)?.toTeller && speakerOf(u) !== this.cast.narratorKey) {
        addressed.push(this.cast.narratorKey);
      }
    }
    // People addressed or mentioned rank just below the speaker as the next "other" participant.
    for (const u of voiced) {
      const speaker = speakerOf(u);
      // A newcomer's first line with a tag or beat of its own starts a scene when the narration
      // brought them in after a scene break, time passing or someone leaving.
      // Without one before them they join the talk ("Then Anne came in.", "Then Anne came in.
      // Later I would remember…"), and an untagged line given to someone only mentioned starts
      // nothing.
      const newcomer = this.scene.newcomers.get(speaker);
      // A colon intro that names them is a tag of their own ("The next morning she knocked at my
      // door and said:").
      const introduced = u === voiced[0] && this.intro.speaker?.key === speaker;
      if (newcomer && (tags.get(u) !== undefined || beats.has(u) || introduced)) {
        if (newcomer.changed)
          this.turns.sceneStart = Math.max(this.turns.sceneStart, newcomer.entered);
        this.scene.newcomers.delete(speaker);
      }
      for (const key of tags.get(u)?.others ?? []) if (key !== speaker) this.turns.touch(key);
      // A name an earlier line here brought in is a mention by now, also at a sentence start
      // ("“Hello, Anne,” said Tom. “Anne, can you hear me?”"), so a line is read again once the
      // cast has grown.
      const names =
        this.cast.version === callsRead
          ? calls.get(u)!
          : vocativeMentions(this, units, at.get(u)!, tokens.get(u)!);
      this.turns.touchVocatives(names, speaker);
      if (speaker !== this.cast.unknownKey) this.turns.speaks(speaker);
      this.lastTurn = whoOf(u);
    }

    const lastVoiced = voiced.at(-1)!;
    const lineAsks = /\?[”"’']?$/u.test(this.slice(lastVoiced).trimEnd());
    this.continuesSpeech =
      lastVoiced === units.at(-1) &&
      lastVoiced.kind === 'speech' &&
      !CLOSING_QUOTE.test(this.slice(lastVoiced)) &&
      OPENING_QUOTE.test(this.slice(lastVoiced));
    // "“Well,” said Tom, and then he added:" introduces Tom's next paragraph. A "he" or "she" there
    // is read as in a colon intro of its own ("“Well,” I said, and then she added:").
    this.intro = replyIntro(
      this,
      units,
      tokens,
      isVoiced,
      {
        unit: lastVoiced,
        who: whoOf(lastVoiced),
        saidTo: [...(tags.get(lastVoiced)?.addressees ?? []), ...vocatives.get(lastVoiced)!],
        unknownCall: unknownCall.get(lastVoiced)!,
        asks: lineAsks,
      },
      {
        lastAsker: this.lastAsker,
        lastQuestion: this.lastQuestion,
        headingAsker: this.headingAsker,
      },
    );
    // A question inside the line asks too ("Where were you? I waited all night,"), but not a short
    // one that opens it, which may be an echo ("Marry Tom? Never,"; see asksInLine).
    this.lastAsker =
      lineAsks || asksInLine(this.slice(lastVoiced), true) ? speakerOf(lastVoiced) : undefined;
    this.lastQuestion = this.lastAsker === undefined ? undefined : this.slice(lastVoiced);
    this.headingAsker = undefined;
    this.turns.afterSpeech(addressed);
    this.scene.newStretch();

    return units.map((u) => {
      if (!isVoiced(u)) return this.label(u, this.cast.narratorKey, 'narration', undefined, true);
      const own = tags.get(u);
      // A line spoken after a beat does not take the tone of another line's tag.
      const tag = own ?? (beats.has(u) ? undefined : firstTag);
      const mode: Mode =
        u.kind === 'emphasis' || tag?.verb.thought || tag?.thought ? 'thought' : 'speech';
      const tone: Tone | undefined = tag?.tone ? { label: tag.tone } : undefined;
      const { key, teller } = whoOf(u);
      return this.label(u, key, mode, tone, teller);
    });
  }

  private narrationParagraph(units: Unit[], tokens: Map<Unit, Token[]>): void {
    this.intro = { notTeller: false };
    this.continuesSpeech = false;
    this.turns.afterNarration();
    // Headings ("CHAPTER II", "NICK DUNNE", "* * *") are never read for names.
    if (isHeading(this, units)) {
      const asker = this.lastAsker;
      this.breakScene();
      this.headingAsker = asker;
      return;
    }
    const all = units.map((u) => {
      const ts = tokens.get(u)!;
      return { tokens: ts, mentions: this.cast.mentions(ts) };
    });
    for (const { tokens: ts, mentions } of all) {
      // A scene cue, which only orders first-person turn-taking (see alternate). It changes the
      // scene from where it stands: "Then Anne came in. Later I would remember…" brings Anne in
      // before it.
      const cue = this.turns.tellerSpeaks ? sceneCue(ts, mentions) : -1;
      if (this.turns.tellerSpeaks && ts.some((_, i) => isFirstPerson(ts, i))) {
        this.turns.touch(this.cast.narratorKey);
      }
      const until = untilTimeAt(ts) !== -1;
      for (const m of mentions) {
        if (cue !== -1 && cue < m.first) this.scene.stretch.changed = true;
        // "My name is Ishmael": the teller's own name, never a new character.
        if (selfIntroduced(ts, m)) {
          this.turns.touch(this.cast.narratorKey);
          continue;
        }
        // "walked to London", "a letter from Mr. Collins": not someone present.
        if (afterPreposition(ts, m) || wordBefore(ts, m) === 'to') {
          continue;
        }
        const key = this.cast.resolve(m);
        this.turns.touch(key);
        let first = false;
        if (this.cast.entry(key).role === 'character' && !this.turns.entrants.includes(key)) {
          this.turns.entrants.push(key);
          first = this.scene.bringIn(key, ts, m, mentions);
        }
        this.scene.waitEnds(key, ts, m, mentions, first, until);
      }
      if (this.turns.tellerSpeaks) this.scene.timeBringsIn(ts, mentions);
      if (cue !== -1) this.scene.stretch.changed = true;
      // Someone who has spoken leaving ends their talk, also for people named before ("Then Anne
      // came in, and Tom left.").
      if (this.turns.tellerSpeaks && this.scene.speakerLeaves(ts, mentions)) this.breakScene();
    }
    // A paragraph that sets the new scene with its people leaves the question before the heading
    // behind ("CHAPTER II / Anne and Mary sat by the fire. / “Well,” said Anne, and she replied:"),
    // unlike one about someone there ("CHAPTER TWO / Mary held her breath.").
    if (this.turns.entrants.length > 1) this.headingAsker = undefined;

    // "Tom turned to Anne and said:" introduces the next paragraph's speaker. Only the sentence
    // that ends with the colon counts.
    const last = units.at(-1)!;
    if (!this.slice(last).trimEnd().endsWith(':')) return;
    const { tokens: ts, mentions } = all.at(-1)!;
    this.intro = narrationIntro(this, last, ts, mentions);
  }

  /**
   * A scene break, or someone who has spoken leaving (see Scene.breakScene): a question asked
   * before it is no longer the one a later reply answers.
   */
  private breakScene(): void {
    this.scene.breakScene();
    this.lastAsker = undefined;
    this.headingAsker = undefined;
  }

  slice(u: Unit): string {
    return this.text.slice(u.start, u.end);
  }

  private label(u: Unit, key: string, mode: Mode, tone?: Tone, teller?: boolean): SpanLabel {
    const speaker: SpeakerRef = key.startsWith('new:')
      ? { kind: 'new', ref: key }
      : { kind: 'cast', id: key };
    return {
      start: u.start,
      end: u.end,
      speaker,
      mode,
      ...(tone ? { tone } : {}),
      source: 'heuristic',
      ...(teller && key === this.cast.narratorKey ? { teller: true as const } : {}),
    };
  }
}
