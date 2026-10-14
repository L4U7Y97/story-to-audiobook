import type { Gender, Mode, SegmentSource, Tone } from '@/format/types';

/** Who speaks a span: an existing cast member, or a character found during this analysis. */
export type SpeakerRef = { kind: 'cast'; id: string } | { kind: 'new'; ref: string };

/** A labelled range of the part text. Labels from one analyser tile the text. */
export interface SpanLabel {
  start: number;
  end: number;
  speaker: SpeakerRef;
  mode: Mode;
  tone?: Tone;
  source: SegmentSource;
}

export interface NewCharacter {
  ref: string;
  name: string;
  aliases: string[];
  gender?: Gender;
  description?: string;
}

export interface AliasAddition {
  characterId: string;
  alias: string;
}

/** What an analyser returns for one part. */
export interface LabelResult {
  spans: SpanLabel[];
  newCharacters: NewCharacter[];
  aliasAdditions: AliasAddition[];
}
