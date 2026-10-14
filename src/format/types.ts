// The story format: the contract shared by every module. See SPEC.md, "The story format".

export const SCHEMA_VERSION = 1;

export type Lang = 'en' | 'es';

/** written = letters, signs, notes read aloud */
export type Mode = 'narration' | 'speech' | 'thought' | 'written';

export const TONE_LABELS = [
  'neutral',
  'whisper',
  'shout',
  'angry',
  'sad',
  'happy',
  'fearful',
  'sarcastic',
  'tender',
  'excited',
  'tired',
  'urgent',
  'mocking',
  'pleading',
] as const;
export type ToneLabel = (typeof TONE_LABELS)[number];

export interface Tone {
  label: ToneLabel;
  /** mild / clear / extreme */
  intensity?: 1 | 2 | 3;
  /** Free-form, e.g. "through tears". Stored, not voiced in the MVP. */
  notes?: string;
}

export interface Story {
  id: string;
  schemaVersion: number;
  title: string;
  lang: Lang;
  /** Reading order. */
  partIds: string[];
  cast: Character[];
  /** Always present; a Character with role 'narrator'. */
  narratorId: string;
  position?: { partId: string; segmentIndex: number };
  createdAt: string;
  updatedAt: string;
}

export type CharacterRole = 'narrator' | 'character' | 'unknown';
export type Gender = 'male' | 'female' | 'other';

export interface Character {
  id: string;
  /** One 'unknown' character collects unattributed speech. */
  role: CharacterRole;
  name: string;
  aliases: string[];
  /** Hint for voice choice only. */
  gender?: Gender;
  /** Short description; helps keep later parts consistent. */
  description?: string;
  voice: VoiceSettings;
  firstSeenPartId?: string;
}

export interface VoiceSettings {
  /** Device voice id; may be missing on another device. */
  voiceName?: string;
  /** BCP-47, used when voiceName is unavailable. */
  lang: string;
  /** 0.5–2.0 */
  pitch: number;
  /** 0.5–2.0, multiplied by the player's global speed. */
  rate: number;
}

export type PartSourceKind = 'txt' | 'epub' | 'paste';
export type AnalysisStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Part {
  id: string;
  storyId: string;
  title: string;
  source: { kind: PartSourceKind; fileName?: string; epubHref?: string };
  /** Canonical text. Immutable after creation. */
  text: string;
  /** SHA-256 of text, hex. */
  textHash: string;
  /** Non-text metadata from the source, e.g. EPUB italics. */
  hints?: Hint[];
  analysisStatus: AnalysisStatus;
}

export interface Hint {
  start: number;
  end: number;
  kind: 'emphasis';
}

export type AnalyzerKind = 'llm' | 'heuristic' | 'mixed';

export interface Analysis {
  partId: string;
  /** Must equal Part.textHash or the analysis is stale. */
  textHash: string;
  analyzer: { kind: AnalyzerKind; model?: string; version: number };
  createdAt: string;
  segments: Segment[];
}

export type SegmentSource = 'llm' | 'heuristic' | 'user';

export interface Segment {
  /** UTF-16 code-unit offset into Part.text, inclusive. */
  start: number;
  /** Exclusive. */
  end: number;
  speakerId: string;
  mode: Mode;
  tone?: Tone;
  /** 'user' = manual correction. */
  source: SegmentSource;
}
