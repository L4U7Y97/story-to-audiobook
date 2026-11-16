/** Scene changes in narration: headings, time passing, people coming in and people leaving. */

import type { Unit } from '../units';
import type { Cast } from './cast';
import { coordinated } from './clauses';
import {
  ARRIVALS,
  ARRIVING,
  BEING_THERE,
  COORDINATORS,
  DEPARTURES,
  ENTERING,
  ENTRY_LEADS,
  HEADING_WORDS,
  INDEFINITE_SUBJECTS,
  LEAVING,
  OFFSTAGE_AUXILIARIES,
  OTHER_SUBJECTS,
  SENDING,
  SENTENCE_LEADS,
  THERE,
} from './lexicon';
import { isPronoun, subjectIndexBefore, subjectOf } from './mentions';
import type { Lookup } from './reading';
import {
  arrives,
  becomes,
  returns,
  subjectAfterLeads,
  timeInClause,
  timeLaterInSentence,
  timeOpensSentence,
  timePasses,
  timePhraseStart,
  timeShifts,
  untilTimeAt,
} from './time';
import {
  gluedAt,
  gluedWordAt,
  lastSentenceStart,
  pastLyAdverbs,
  phrasesAt,
  sentenceEndAfter,
  UPPER,
  wordAt,
  type Mention,
  type Token,
} from './tokens';
import type { Turns } from './turns';

// "everyone had left": all who were there.
const EVERYONE = new Set(['everyone', 'everybody']);

/** What the narration between two lines says about the conversation before it. */
interface Stretch {
  /** A scene break, time passing or someone leaving ("* * *", "In the evening", "Tom left."). */
  changed: boolean;
}

/** Where the first scene cue in a run of tokens starts (see timePasses, someoneLeaves), or -1. */
export function sceneCue(ts: Token[], mentions: Mention[]): number {
  const cues = [timePasses(ts), someoneLeaves(ts, mentions)].filter((i) => i !== -1);
  return cues.length > 0 ? Math.min(...cues) : -1;
}

/**
 * "Tom left.", "drove me home and left": where someone leaves, at the end of a clause, or -1. In
 * English someone has to be the one leaving ("on my left", "no butter left"), and someone who had
 * left was gone before the scene ("the scarf she had left"; but see speakerLeaves).
 */
function someoneLeaves(ts: Token[], mentions: Mention[]): number {
  const found = phrasesAt(ts, DEPARTURES, true).find((i) => {
    const b = subjectIndexBefore(ts, i);
    const word = wordAt(ts, b);
    // "she had left", "I’d left": gone before the scene.
    if (
      b !== -1 &&
      (/['’]d$/u.test(ts[b]!.text) || ts.slice(b + 1, i).some((t) => t.text === 'had'))
    ) {
      return false;
    }
    return (
      subjectOf(ts, i, mentions) !== null ||
      OTHER_SUBJECTS.has(word) ||
      INDEFINITE_SUBJECTS.has(word) ||
      word === 'we' ||
      coordinated(ts, i, lastSentenceStart(ts.slice(0, i + 1)))
    );
  });
  return found ?? -1;
}

/**
 * Whether the person at `m` opens their clause, after lead words or "and" ("Then Anne came in",
 * "Suddenly Anne came in", "and Anne came in"): they come in themselves, rather than being only
 * named ("I had not seen Anne", "I hoped Anne would come", "and Anne had promised to come"). After
 * an entry lead such as "suddenly" or "finally" they come in only with a verb of coming or of
 * being there ("Suddenly Anne was there"; not "Suddenly Anne stopped writing", "Finally Anne
 * agreed to come").
 */
function opensClause(ts: Token[], m: Mention): boolean {
  const next = ts[m.last + 1];
  if (next && !next.punctBefore && OFFSTAGE_AUXILIARIES.has(next.text.toLowerCase())) {
    return false;
  }
  const coming = (k: number) =>
    ARRIVALS.has(wordAt(ts, k)) ||
    ENTERING.has(wordAt(ts, k)) ||
    (BEING_THERE.has(wordAt(ts, k)) && THERE.has(wordAt(ts, k + 1)));
  const after = pastLyAdverbs(ts, m.last + 1);
  // "Then Anne agreed to come. She arrived that evening.": a plan to come, not coming in, when a
  // later sentence of the paragraph tells of the arrival (not "Then Anne came to show me her
  // shawl. Later she told me she had knitted it.", "Then Anne happened to come in."). A plan with
  // no arrival after it here may still be one (see the `plan` of newcomers).
  const later = sentenceEndAfter(ts, m.last);
  // A plan that ends its clause ("Then Anne agreed to come.") takes any later sentence with a verb
  // of arriving after a pronoun or a name. Other shapes may be someone there already ("Then Anne
  // came to show me her shawl."), so the arrival has to be the person's own, a "he", "she" or their
  // name before the verb (not "Later she told me Tom returned it", "Tom came over to look", "I came
  // to love it"), and no becoming ("Later she came to love the place").
  const clear = clearPlan(ts, m);
  const arrivesLater = ts.slice(later).some((t, i) => {
    const k = later + i;
    const before = ts[k - 1]?.text ?? '';
    const pronoun = isPronoun(before);
    if (i === 0 || t.punctBefore || !ARRIVALS.has(t.text.toLowerCase())) return false;
    // Coming back after a bare "Later" is no arrival after a plan (see sentenceTime), as in two
    // paragraphs: "Then Anne rose to come over. Later she came back with a pot of tea." has her
    // come over.
    const time = sentenceTime(ts, k);
    if (time.passes && !time.moves) return false;
    if (clear) return pronoun !== undefined || UPPER.test(before);
    const self = pronoun === 'male' || pronoun === 'female' || before === ts[m.last]!.text;
    return self && !becomes(ts, k);
  });
  if (arrivesLater && plansToCome(ts, m)) return false;
  const comesIn = !!ts[after] && !ts[after]!.punctBefore && coming(after);
  const opens = (k: number) => {
    for (; k > 0 && !ts[k]!.punctBefore && !ts[k]!.sentenceStart; k--) {
      const lead = ts[k - 1]!.text.toLowerCase();
      if (COORDINATORS.has(lead)) return true;
      const entry = ENTRY_LEADS.has(lead);
      if (!SENTENCE_LEADS.has(lead) && !(entry && comesIn)) return false;
    }
    return true;
  };
  return opens(m.first);
}

/**
 * "Then Anne agreed to come", "At last Anne promised to come": the person at `m` has a verb with
 * "to" and a verb of arriving after it, which may be a plan to come (see opensClause).
 */
function plansToCome(ts: Token[], m: Mention): boolean {
  const after = pastLyAdverbs(ts, m.last + 1);
  return (
    gluedAt(ts, after) &&
    gluedAt(ts, after + 1) &&
    gluedAt(ts, after + 2) &&
    wordAt(ts, after + 1) === 'to' &&
    ARRIVING.has(wordAt(ts, after + 2))
  );
}

/**
 * "Then Anne agreed to come.", "At last Anne agreed to come over.", "Then Anne agreed to show up.":
 * a plan to come that ends its clause, which a later arrival in the stretch makes the arrival (see
 * the `plan` of newcomers). Not someone there already: "Then Anne happened to come in.", "Then
 * Anne came to show me her shawl.", "Then Anne seemed to appear from nowhere.".
 */
function clearPlan(ts: Token[], m: Mention): boolean {
  if (!plansToCome(ts, m)) return false;
  const after = pastLyAdverbs(ts, m.last + 1);
  let end = after + 3;
  if (['show', 'turn'].includes(gluedWordAt(ts, after + 2))) {
    if (gluedWordAt(ts, end) !== 'up') return false;
    end++;
  } else if (['over', 'back', 'home', 'round', 'again'].includes(gluedWordAt(ts, end))) {
    end++;
  }
  return !ts[end] || !!ts[end]!.punctBefore;
}

/**
 * Whether time passes in the sentence of token `e`, and whether it moves the narration to a new
 * time there: any time shift does but a bare "Later" ("The next morning she knocked at my door.",
 * "She knocked an hour later."; not "Later she came back with a pot of tea.").
 */
function sentenceTime(ts: Token[], e: number): { passes: boolean; moves: boolean } {
  const start = lastSentenceStart(ts.slice(0, e + 1));
  const end = sentenceEndAfter(ts, e);
  const shifts = timeShifts(ts).filter((x) => x >= start && x < end);
  const bare = (x: number) => wordAt(ts, x) === 'later' && timePhraseStart(ts, start - 1, x) === x;
  return { passes: shifts.length > 0, moves: shifts.some((x) => !bare(x)) };
}

export class Scene {
  /** The narration since the last line. */
  stretch: Stretch = { changed: false };
  /**
   * Characters narration brought in who have not spoken yet: when, in which stretch, whether the
   * stretch had changed the scene before them, and whether they came in themselves, opening a
   * clause ("Then Anne came in"), rather than being only named ("I had not seen Anne").
   */
  readonly newcomers = new Map<
    string,
    { entered: number; stretch: Stretch; changed: boolean; came: boolean; plan?: boolean }
  >();

  constructor(
    private readonly cast: Cast,
    private readonly turns: Turns,
  ) {}

  /** The narration after a paragraph of speech: a new stretch. */
  newStretch(): void {
    this.stretch = { changed: false };
  }

  /**
   * A scene break, or someone who has spoken leaving: the scene changes from here, and for the
   * people this stretch brought in before it too ("I hoped Anne would come. / * * * / She came").
   */
  breakScene(): void {
    this.stretch.changed = true;
    for (const n of this.newcomers.values()) if (n.stretch === this.stretch) n.changed = true;
  }

  bringIn(key: string, ts: Token[], m: Mention, mentions: Mention[]): boolean {
    // The stretch brings someone in once, where it first names them. Time passing in the
    // clause that names them brings them in after it too ("Then Anne came to see me that
    // evening.", "I went to see Anne the next day.").
    const { stretch } = this;
    if (!this.turns.spoke.has(key) && this.newcomers.get(key)?.stretch !== stretch) {
      const came = opensClause(ts, m);
      const changed =
        stretch.changed ||
        (this.turns.tellerSpeaks && timeInClause(ts, m, came, mentions, this.turns.hasSpoken));
      // A plan to come with no arrival after it in this paragraph reads as coming in, until a
      // later arrival in the stretch tells otherwise ("Then Anne agreed to come. / She
      // arrived the next morning.").
      const plan = came && clearPlan(ts, m);
      this.newcomers.set(key, {
        entered: this.turns.clock,
        stretch,
        changed,
        came,
        plan,
      });
      return true;
    }
    return false;
  }

  waitEnds(
    key: string,
    ts: Token[],
    m: Mention,
    mentions: Mention[],
    first: boolean,
    until: boolean,
  ): void {
    // Named again in this stretch, in a wait that ends when time passes: "I had asked Anne to
    // come. Anne did not come back until the next morning."
    const known = this.newcomers.get(key);
    if (
      !first &&
      until &&
      this.turns.tellerSpeaks &&
      known?.stretch === this.stretch &&
      !known.changed &&
      !known.came &&
      timeInClause(ts, m, opensClause(ts, m), mentions, this.turns.hasSpoken)
    ) {
      known.changed = true;
    }
  }

  /**
   * "I had not seen Anne for a month. In the evening she came to see me.", "I had asked Anne to
   * come. She arrived that evening.": time passing in a sentence about someone this stretch only
   * named so far (by their name, or a "he" or "she"), at its start or later in its subject's own
   * clause, brings them in after it. Someone who came in before it joins the talk ("Then Anne came
   * in. Later she told me she had been crying."), and a "he" or "she" that comes back may be
   * someone who has spoken and went out ("Tom went out to the boat. He came back later with the
   * lamp.").
   */
  timeBringsIn(ts: Token[], mentions: Mention[]): void {
    const subjects = timeOpensSentence(ts).map((e) => ({
      e,
      named: mentions.find((m) => m.first === e && !m.possessive),
    }));
    const later = timeLaterInSentence(ts, mentions, this.turns.hasSpoken).filter(
      ({ e, named, v }) => !!named || !returns(ts, v) || !this.speakerBefore(ts, e, mentions),
    );
    // "She did not come until the next morning", "She was not back until that evening": a wait
    // that ends when time passes, in a sentence a "he" or "she" opens (read as timeInClause reads
    // "Anne did not come until…").
    const waits: { e: number; named: Mention | undefined }[] = [];
    const t = untilTimeAt(ts);
    if (t !== -1) {
      const e = subjectAfterLeads(ts, t);
      const pronoun = isPronoun(ts[e]?.text ?? '');
      const at = { ...(mentions[0] ?? {}), first: e, last: e } as Mention;
      if (
        (pronoun === 'male' || pronoun === 'female') &&
        timeInClause(ts, at, false, mentions, this.turns.hasSpoken) &&
        !this.speakerBefore(ts, e, mentions)
      ) {
        waits.push({ e, named: undefined });
      }
    }
    // Whether the subject at `e` arrives, for a plan to come read as coming in ("The next morning
    // she knocked at my door."; not "Later she told me…").
    const arrivesAt = (e: number, named: Mention | undefined) => {
      const v = pastLyAdverbs(ts, named ? named.last + 1 : e + 1);
      if (!ts[v] || ts[v]!.punctBefore || !ARRIVALS.has(wordAt(ts, v))) return false;
      const end = sentenceEndAfter(ts, v);
      const time = timeShifts(ts).find((x) => x > v && x < end) ?? end;
      const closed = [
        ...ts,
        { ...ts[ts.length - 1]!, text: '', punctBefore: '.', sentenceStart: true },
      ];
      return arrives(closed, v, time) && !becomes(ts, v);
    };
    // A plan to come ends in an arrival at a time the narration moves to ("The next morning she
    // knocked at my door.", "She knocked an hour later."), not after a bare "Later" ("Then Anne rose
    // to come over. / Later she came back with a pot of tea."; see sentenceTime, and opensClause
    // for the two sentences in one paragraph).
    const moved = (e: number) => sentenceTime(ts, e).moves;
    const triggers = [
      ...subjects.map((s) => ({ ...s, arrival: moved(s.e) && arrivesAt(s.e, s.named) })),
      ...later.map((s) => ({ ...s, arrival: moved(s.e) })),
      ...waits.map((s) => ({ ...s, arrival: moved(s.e) })),
    ];
    for (const { e, named, arrival } of triggers) {
      const pronoun = isPronoun(ts[e]!.text);
      const key = named && this.cast.match(named.name)?.key;
      for (const [k, n] of this.newcomers) {
        if (n.stretch !== this.stretch || n.changed || (n.came && !(n.plan && arrival))) continue;
        const gender = this.cast.entry(k).gender;
        if (
          (key !== undefined && key === k) ||
          ((pronoun === 'male' || pronoun === 'female') && (!gender || gender === pronoun))
        ) {
          n.changed = true;
        }
      }
    }
  }

  /**
   * Whether someone who has spoken is named before `e` in this narration and may be the subject
   * there: a "he" or "she" of their gender. Someone sent away or gone, named last, is the one who
   * comes back, and counts only if they spoke ("Tom stayed with the horses. I had sent Anne to the
   * village. She returned that evening." brings Anne in).
   */
  private speakerBefore(ts: Token[], e: number, mentions: Mention[]): boolean {
    const pronoun = isPronoun(ts[e]!.text);
    const fits = (m: Mention, key: string | undefined): key is string => {
      if (m.last >= e || m.possessive) return false;
      if (key === undefined || this.cast.entry(key).role !== 'character') return false;
      const gender = this.cast.entry(key).gender;
      return (pronoun === 'male' || pronoun === 'female') && (!gender || gender === pronoun);
    };
    // "Anne had gone", "I had sent Anne".
    const away = (m: Mention) => {
      const after = wordAt(ts, m.last + 1) === 'had' ? m.last + 2 : m.last + 1;
      const before = m.first - 1;
      return LEAVING.has(wordAt(ts, after)) || SENDING.has(wordAt(ts, before));
    };
    const gone = mentions.filter((m) => away(m) && fits(m, this.cast.match(m.name)?.key));
    if (gone.length > 0) {
      const key = this.cast.match(gone.at(-1)!.name)?.key;
      return key !== undefined && this.turns.spoke.has(key);
    }
    return mentions.some((m) => {
      const key = this.cast.match(m.name)?.key;
      return fits(m, key) && this.turns.spoke.has(key);
    });
  }

  /**
   * Whether someone who has spoken leaves in this narration, or had left: "Tom left.", "By the
   * time I woke, Tom had left", "Tom’d left", "everyone had left". Someone who never spoke leaves
   * no talk ("The boy had left.").
   */
  speakerLeaves(ts: Token[], mentions: Mention[]): boolean {
    return phrasesAt(ts, DEPARTURES, true).some((i) => {
      const b = subjectIndexBefore(ts, i);
      if (EVERYONE.has(wordAt(ts, wordAt(ts, b) === 'else' ? b - 1 : b)))
        return this.turns.spoke.size > 0;
      const subject = subjectOf(ts, i, mentions);
      // "Tom’d left": the name before the "’d".
      const contracted = /\p{Lu}.*['’]d$/u.test(ts[b]?.text ?? '');
      const name =
        subject?.kind === 'mention' ? subject.mention.name : contracted ? ts[b]!.text : '';
      const key = name ? this.cast.match(name.replace(/['’]d$/u, ''))?.key : undefined;
      return key !== undefined && this.turns.spoke.has(key);
    });
  }
}

/** One short line with no final punctuation: a chapter heading, a scene break, a name. */
export function isHeading(r: Lookup, units: Unit[]): boolean {
  if (units.length !== 1) return false;
  const text = r.slice(units[0]!).trim();
  if (!text || text.length > 60 || /[.!?…:;,]$/u.test(text)) return false;
  const words = text.split(/\s+/u);
  if (words.length > 8) return false;
  if (/^[\s*#~·•⁂◆◇❖—–\-_=+.]+$/u.test(text) || HEADING_WORDS.test(text)) return true;
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 2 && letters === letters.toUpperCase()) return true;
  return words
    .filter((w) => w.replace(/[^\p{L}]/gu, '').length > 3)
    .every((w) => /^[\p{Lu}\d]/u.test(w));
}
