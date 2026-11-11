import type { Character, Lang, Segment } from '@/format/types';
import { splitUnits } from '@/analysis/units';
import { mergeLabels } from '@/analysis/merge';
import { analyzeHeuristic } from '@/analysis/heuristic';
import { baseCast } from './fixtures';
import type { StorySpec } from './heldoutStories';

export interface Judgement {
  /** Expectations missed (soft ones count only when not even their fallback holds). */
  hard: number;
  total: number;
  misses: string[];
  /** The story's cast after its last part. */
  cast: Character[];
}

/** Analyses a story part by part with the heuristic, carrying the cast forward as the app does. */
export function analyseStory(
  lang: Lang,
  texts: string[],
): { parts: Array<{ text: string; segments: Segment[] }>; cast: Character[] } {
  let cast = baseCast(lang);
  let ids = 0;
  const parts = texts.map((text, p) => {
    const result = analyzeHeuristic({ text, lang, units: splitUnits(text, lang), cast });
    const merged = mergeLabels(text, result, cast, `p${p}`, () => `c${p}-${++ids}`);
    cast = merged.cast.map((c) => ('voice' in c ? c : { ...c, voice: cast[0]!.voice }));
    return { text, segments: merged.segments };
  });
  return { parts, cast };
}

/**
 * Checks who voices each expected unit. 'N' must be the story's narrator entry. Every other
 * person must have one cast id of their own: a person is pinned to the character whose name or
 * aliases contain all the words of the person's label (tellers excepted, who may be voiced by any
 * one id, the narrator included); anyone left is pinned to the id voicing most of their lines.
 */
export function judgeStory(story: StorySpec): Judgement {
  const { parts, cast } = analyseStory(
    story.lang,
    story.parts.map((p) => p.text),
  );
  const narratorId = cast.find((c) => c.role === 'narrator')!.id;
  const unknownId = cast.find((c) => c.role === 'unknown')!.id;
  const items = story.parts.flatMap((spec, i) => {
    const { text, segments } = parts[i]!;
    return spec.expect.map((e) => {
      const at = text.indexOf(e.needle);
      if (at === -1) throw new Error(`${story.id}: needle not found: ${e.needle}`);
      const segment = segments.find((s) => s.start <= at && at < s.end)!;
      return { ...e, part: i, got: segment.speakerId, mode: segment.mode };
    });
  });

  const owner = new Map<string, string>();
  const taken = new Set<string>();
  const persons = new Set(items.map((x) => x.who));
  if (persons.has('N')) {
    owner.set('N', narratorId);
    taken.add(narratorId);
  }
  const tellers = new Set(story.tellers ?? []);
  const words = (s: string) =>
    s
      .toLowerCase()
      .split(/[\s.]+/u)
      .filter(Boolean);
  const linesOf = (who: string, id: string) =>
    items.filter((x) => x.who === who && x.got === id).length;
  for (const who of persons) {
    if (who === 'N' || tellers.has(who)) continue;
    const wanted = words(who);
    const named = cast.filter(
      (c) =>
        c.role === 'character' &&
        !taken.has(c.id) &&
        [c.name, ...c.aliases].some((n) => wanted.every((w) => words(n).includes(w))),
    );
    const best = named.sort((a, b) => linesOf(who, b.id) - linesOf(who, a.id))[0];
    if (!best) continue;
    owner.set(who, best.id);
    taken.add(best.id);
  }
  const votes: Array<{ who: string; id: string; n: number }> = [];
  for (const who of persons) {
    if (owner.has(who)) continue;
    const ids = new Set(items.filter((x) => x.who === who).map((x) => x.got));
    for (const id of ids) if (id !== unknownId) votes.push({ who, id, n: linesOf(who, id) });
  }
  votes.sort((a, b) => b.n - a.n || a.who.localeCompare(b.who));
  for (const v of votes) {
    if (owner.has(v.who) || taken.has(v.id)) continue;
    owner.set(v.who, v.id);
    taken.add(v.id);
  }

  const nameOf = (id: string) => {
    const c = cast.find((x) => x.id === id);
    if (c?.role === 'narrator') return `N${c.aliases.length ? `(${c.aliases.join('/')})` : ''}`;
    if (c?.role === 'unknown') return 'U';
    return c?.name ?? id;
  };
  const misses = items
    .filter((x) => owner.get(x.who) !== x.got && !(x.soft && x.alt && owner.get(x.alt) === x.got))
    .map((x) => `p${x.part + 1} ${x.needle} → ${nameOf(x.got)}/${x.mode} (want ${x.who})`);
  return { hard: misses.length, total: items.length, misses, cast };
}
