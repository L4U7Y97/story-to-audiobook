import type { Analysis, Character, Part, Segment, VoiceSettings } from '@/format/types';
import { isSpeakable } from '@/format/validate';
import type { Utterance } from './engine';

/** TTS engines cut off or stall on long inputs; segments are spoken in chunks of at most this. */
export const MAX_CHUNK = 280;

export interface PlannedUtterance extends Utterance {
  segmentIndex: number;
}

/**
 * The utterances to speak for a part from a segment onwards. Text is cleaned for speech here
 * (markup underscores, dialogue dashes, hard wraps) — the stored text is never touched.
 */
export function buildUtterances(
  part: Pick<Part, 'text'>,
  analysis: Pick<Analysis, 'segments'>,
  cast: readonly Character[],
  fromSegment: number,
  speed: number,
): PlannedUtterance[] {
  const voices = new Map(cast.map((c) => [c.id, c.voice]));
  const out: PlannedUtterance[] = [];
  analysis.segments.forEach((segment, i) => {
    if (i < fromSegment) return;
    const spoken = cleanForSpeech(part.text.slice(segment.start, segment.end));
    if (!isSpeakable(spoken)) return;
    const voice = withSpeed(voices.get(segment.speakerId) ?? fallbackVoice(cast), speed);
    chunkText(spoken, MAX_CHUNK).forEach((text, k) => {
      out.push({ id: utteranceId(i, k), segmentIndex: i, text, voice });
    });
  });
  return out;
}

export function utteranceId(segmentIndex: number, chunk: number): string {
  return `${segmentIndex}.${chunk}`;
}

export function segmentIndexOf(utteranceId: string): number {
  return Number.parseInt(utteranceId, 10);
}

export function cleanForSpeech(text: string): string {
  return text
    .replace(/_/gu, '') // Gutenberg-style _italics_
    .replace(/(^|\s)(?:--+|[—―–])|(?:--+|[—―–])(?=\s|$)/gu, '$1') // dialogue dashes
    .replace(/--+|[—―]/gu, ', ') // dashes inside a sentence: a short pause
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Splits at sentence ends, then clause punctuation, then spaces, keeping chunks ≤ max. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+["”»’)]*\s*|$)/gu) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const piece of sentences.flatMap((s) => splitLong(s, max))) {
    if (current && (current + piece).length > max) {
      chunks.push(current.trim());
      current = '';
    }
    current += piece;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function splitLong(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const clauses = sentence.match(/[^,;:]+[,;:]?\s*/gu) ?? [sentence];
  return clauses.flatMap((clause) => {
    if (clause.length <= max) return [clause];
    const words = clause.split(/(?<=\s)/u);
    const parts: string[] = [];
    let current = '';
    for (const w of words) {
      if (current && (current + w).length > max) {
        parts.push(current);
        current = '';
      }
      current += w;
    }
    if (current) parts.push(current);
    return parts;
  });
}

/** Whether each segment starts a paragraph (the previous one ends with a line break). */
export function paragraphStarts(text: string, segments: readonly Segment[]): boolean[] {
  return segments.map((_, i) => i === 0 || text[segments[i - 1]!.end - 1] === '\n');
}

function withSpeed(voice: VoiceSettings, speed: number): VoiceSettings {
  return {
    ...voice,
    rate: Math.round(Math.min(4, Math.max(0.25, voice.rate * speed)) * 100) / 100,
  };
}

function fallbackVoice(cast: readonly Character[]): VoiceSettings {
  return cast.find((c) => c.role === 'narrator')?.voice ?? { lang: 'en-US', pitch: 1, rate: 1 };
}
