import type { Gender, Lang, Mode } from '@/format/types';

/** A character as the prompt shows it, under a short code instead of its id. */
export interface PromptCharacter {
  code: string;
  name: string;
  role: 'narrator' | 'character' | 'unknown';
  aliases: readonly string[];
  gender?: Gender;
  description?: string;
}

export interface ContextLine {
  code: string;
  mode: Mode;
  text: string;
}

export interface PromptInput {
  lang: Lang;
  cast: readonly PromptCharacter[];
  /** Already-labelled units just before the chunk. */
  context: readonly ContextLine[];
  /** Unit texts, numbered from 0 in the prompt. */
  units: readonly string[];
}

/** Stays the same for every request, so the model sees one stable instruction block. */
export const SYSTEM_PROMPT = `You label stories for a multi-voice audiobook. A narrator voice reads the narration, and each character has their own voice. For every numbered unit of the story, say who voices it and how.

Modes:
- "narration": the narrator's text, including dialogue tags such as "she said" or "—dijo Ana—".
- "speech": words a character says aloud.
- "thought": a character's unspoken thoughts (often in italics or after "thought", "pensó").
- "written": a letter, note, sign or inscription that is read out. The speaker is its writer, or N when the writer is unknown.

Speakers are cast codes. N is the narrator. In a first-person story the narrator's own dialogue and thoughts are also N. Use U only when the text gives no way to tell who is speaking. Work out unattributed dialogue from context: alternating speakers in a conversation, who was addressed, who is present.

New characters: when someone not in the cast speaks, thinks or writes, add them to newCharacters with a fresh ref ("new1", "new2", …) and use that ref as the speaker. Use the name the text gives them; an unnamed character gets a short description as the name ("the innkeeper"). Do not add people who are only mentioned. Before adding anyone, check the cast: a nickname, surname, title or description of an existing character ("Lizzy", "Mr. Darcy", "his wife") is that character, so use their code and, when the text uses a new name for them, add it to aliasAdditions.

Tone: add a tone only when the text clearly signals it (a verb such as "whispered" or "gritó", an adverb, or obvious emotion). Otherwise leave it out.

Spans: give each unit one span without "text". Split a unit into several spans only when it mixes voices (for example narration followed by unquoted speech). Then give every span its "text", copied character for character from the unit, so that the spans together reproduce the unit exactly.

Label every unit under "Units to label" exactly once, in order, by its number. The context lines are already labelled; do not label them.`;

const LANGUAGE: Record<Lang, string> = { en: 'English', es: 'Spanish' };
const CONTEXT_CHARS = 200;

function describe(c: PromptCharacter): string {
  if (c.role === 'narrator') return `${c.code}: the narrator`;
  if (c.role === 'unknown') return `${c.code}: unknown speaker`;
  const details = [
    c.gender,
    c.aliases.length ? `also called ${c.aliases.join(', ')}` : '',
    c.description ?? '',
  ].filter(Boolean);
  return `${c.code}: ${c.name}${details.length ? ` (${details.join('; ')})` : ''}`;
}

function shorten(text: string): string {
  const t = text.trim().replace(/\s+/gu, ' ');
  return t.length > CONTEXT_CHARS ? `${t.slice(0, CONTEXT_CHARS)}…` : t;
}

/** The user message for one chunk. Unit texts are JSON strings so every character is explicit. */
export function buildUserPrompt(input: PromptInput): string {
  const lines = [
    `Story language: ${LANGUAGE[input.lang]}`,
    '',
    'Cast:',
    ...input.cast.map(describe),
  ];
  if (input.context.length) {
    lines.push('', 'Context (already labelled):');
    for (const c of input.context) lines.push(`[${c.code}, ${c.mode}] ${shorten(c.text)}`);
  }
  lines.push('', 'Units to label:');
  input.units.forEach((text, i) => lines.push(`${i}: ${JSON.stringify(text.trim())}`));
  return lines.join('\n');
}
