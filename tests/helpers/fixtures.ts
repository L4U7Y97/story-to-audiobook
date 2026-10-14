import { readFileSync } from 'node:fs';
import type { Character, Lang } from '@/format/types';
import type { LabelResult } from '@/analysis/labels';

export interface FixtureLabels {
  lang: Lang;
  people: Record<string, string[]>;
  speech: Array<{ start: number; end: number; speaker: string; text: string }>;
}

export function loadFixture(path: string): { text: string; labels: FixtureLabels } {
  return {
    text: readFileSync(`tests/fixtures/${path}.txt`, 'utf8'),
    labels: JSON.parse(readFileSync(`tests/fixtures/${path}.labels.json`, 'utf8')) as FixtureLabels,
  };
}

export function baseCast(lang: Lang): Character[] {
  const voice = { lang: lang === 'es' ? 'es-ES' : 'en-US', pitch: 1, rate: 1 };
  return [
    { id: 'narrator', role: 'narrator', name: 'Narrator', aliases: [], voice },
    { id: 'unknown', role: 'unknown', name: 'Unknown', aliases: [], voice },
  ];
}

export interface Score {
  /** Share of non-whitespace characters classified correctly as speech or narration. */
  speechVsNarration: number;
  /** Share of labelled speech spans attributed to the right person. */
  attribution: number;
  /** Characters the analyser created. */
  characters: string[];
  misses: string[];
}

/** Scores labels against a fixture. A predicted name counts if it is one of the person's aliases. */
export function score(
  text: string,
  labels: FixtureLabels,
  result: LabelResult,
  cast: Character[],
): Score {
  const nameOf = (s: LabelResult['spans'][number]) =>
    s.speaker.kind === 'cast'
      ? cast.find((c) => c.id === (s.speaker as { id: string }).id)!.name
      : result.newCharacters.find((c) => c.ref === (s.speaker as { ref: string }).ref)!.name;

  const expectedSpeech = new Uint8Array(text.length);
  for (const s of labels.speech) expectedSpeech.fill(1, s.start, s.end);
  let correct = 0;
  let total = 0;
  for (const span of result.spans) {
    const predicted = span.mode === 'narration' ? 0 : 1;
    for (let i = span.start; i < span.end; i++) {
      if (/\s/u.test(text[i]!)) continue;
      total++;
      if (expectedSpeech[i] === predicted) correct++;
    }
  }

  const misses: string[] = [];
  let right = 0;
  for (const expected of labels.speech) {
    const span = result.spans.find((s) => s.start <= expected.start && expected.start < s.end);
    const predicted = span ? nameOf(span) : '(none)';
    const aliases = labels.people[expected.speaker]!.map((a) => a.toLowerCase());
    if (aliases.includes(predicted.toLowerCase())) right++;
    else
      misses.push(
        `${expected.text.slice(0, 40).replace(/\s+/g, ' ')} → ${predicted} (expected ${expected.speaker})`,
      );
  }

  return {
    speechVsNarration: correct / total,
    attribution: right / labels.speech.length,
    characters: result.newCharacters.map((c) => c.name),
    misses,
  };
}
