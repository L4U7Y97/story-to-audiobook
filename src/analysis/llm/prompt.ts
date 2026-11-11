import type { Analysis, Character, Gender, Lang, Mode } from '@/format/types';
import { isDefaultName } from '../castMatch';

/** How the narrator has told the story's analysed parts (see narratorStyleOf). */
export type NarratorStyle = 'first person' | 'third person';

/** A character as the prompt shows it, under a short code instead of its id. */
export interface PromptCharacter {
  code: string;
  name: string;
  role: 'narrator' | 'character' | 'unknown';
  aliases: readonly string[];
  gender?: Gender;
  description?: string;
  /** Narrator only. */
  style?: NarratorStyle;
}

export interface ContextLine {
  code: string;
  mode: Mode;
  text: string;
  /** From the end of the previous part: the teller may change at the part break. */
  previousPart?: boolean;
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
export const SYSTEM_PROMPT = `You label stories for a multi-voice audiobook. Each cast member has their own voice, and the narration is read by whoever tells the story at that point, which can be N or a character. For every numbered unit of the story, say who voices it and how.

Modes:
- "narration": the teller's text, including dialogue tags such as "she said" or "—dijo Ana—".
- "speech": words someone says aloud.
- "thought": someone's unspoken thoughts (often in italics or after "thought", "pensó").
- "written": a letter, note, diary entry, sign or inscription that is read out. The speaker is its writer, or the current teller when the writer is unknown.

Speakers are cast codes. Use U only when the text gives no way to tell who is speaking, never for narration. Work out unattributed dialogue from context: alternating speakers in a conversation (the teller included), who was addressed, who is present.

Who tells the story:
- N is the main narrator: an impersonal storyteller, or the "I" telling the story. Third-person narration is N's, even when it follows one character or its chapter is headed with a character's name.
- A first-person teller uses one code for their narration, speech ("I said", "—dije") and thoughts.
- The "I" is N if N's cast line names them, or if N has no name yet and nothing shows the "I" is someone else. If N's line says "third person" or names someone else, the "I" is a character: use their code (new if needed) for everything they tell, letters and diaries included.
- The narrating voice can change between parts and within one: at a heading naming someone ("AMY", "Mina Murray's Journal"), a scene break, a tale a character tells, a letter or diary. Otherwise keep the teller of the context lines.
- When the text reveals the name of N's "I", add it to aliasAdditions for "N". Never add the narrator, "I" or "yo" as a new character.

New characters: when someone not in the cast speaks, thinks, writes or tells part of the story, add them to newCharacters with a fresh ref ("new1", "new2", …) and use that ref as the speaker. Use the name the text gives them; an unnamed character gets a short description as the name ("the innkeeper"). Do not add people who are only mentioned. Before adding anyone, check the cast: a nickname, surname, title or description of an existing character ("Lizzy", "Mr. Darcy", "his wife") is that character, so use their code and, when the text uses a new name for them, add it to aliasAdditions. A name the cast shows for N is N.

Tone: add a tone only when the text clearly signals it (a verb such as "whispered" or "gritó", an adverb, or obvious emotion). Otherwise leave it out.

Spans: give each unit one span without "text". Split a unit into several spans only when it mixes voices (for example narration followed by unquoted speech). Then give every span its "text", copied character for character from the unit, so that the spans together reproduce the unit exactly.

Label every unit under "Units to label" exactly once, in order, by its number. The context lines are already labelled; do not label them.`;

const LANGUAGE: Record<Lang, string> = { en: 'English', es: 'Spanish' };
const CONTEXT_CHARS = 200;

/** The cast under its prompt codes: N for the narrator, U for the unknown speaker, c1… for the rest. */
export function promptCast(
  cast: readonly Character[],
  narratorStyle?: NarratorStyle,
): PromptCharacter[] {
  let n = 0;
  return cast.map((c) => ({
    code: c.role === 'narrator' ? 'N' : c.role === 'unknown' ? 'U' : `c${++n}`,
    name: c.name,
    role: c.role,
    aliases: c.aliases,
    ...(c.gender ? { gender: c.gender } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.role === 'narrator' && narratorStyle ? { style: narratorStyle } : {}),
  }));
}

/**
 * How the narrator told these parts, from its segments: "first person" when it also speaks or
 * thinks (at least twice, and once per 20 narration segments), "third person" when it almost never
 * does (at most once per 50) while others talk (at least twice). Undefined with under 5 narration
 * segments, or in between: a narrator who is silent where nobody talks may still be an "I".
 */
export function narratorStyleOf(
  analyses: readonly Analysis[],
  narratorId: string,
): NarratorStyle | undefined {
  let narration = 0;
  let voiced = 0;
  let others = 0;
  for (const analysis of analyses) {
    for (const s of analysis.segments) {
      if (s.speakerId !== narratorId) {
        if (s.mode !== 'narration') others++;
      } else if (s.mode === 'narration') narration++;
      else if (s.mode === 'speech' || s.mode === 'thought') voiced++;
    }
  }
  if (narration < 5) return undefined;
  if (voiced >= 2 && voiced >= 0.05 * narration) return 'first person';
  if (others >= 2 && voiced <= 0.02 * narration) return 'third person';
  return undefined;
}

function describe(c: PromptCharacter): string {
  if (c.role === 'unknown') return `${c.code}: unknown speaker`;
  if (c.role === 'narrator') {
    // A default name ("Narrator") says nothing about who tells the story.
    const names = [c.name, ...c.aliases].filter((n) => !isDefaultName(n, 'narrator'));
    return withDetails(`${c.code}: the narrator`, [
      c.gender,
      c.style,
      names.length ? `called ${names.join(', ')}` : '',
      c.description,
    ]);
  }
  return withDetails(`${c.code}: ${c.name}`, [
    c.gender,
    c.aliases.length ? `also called ${c.aliases.join(', ')}` : '',
    c.description,
  ]);
}

function withDetails(line: string, details: ReadonlyArray<string | undefined>): string {
  const shown = details.filter(Boolean);
  return shown.length ? `${line} (${shown.join('; ')})` : line;
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
    let lastPrevious = input.context.length - 1;
    while (lastPrevious >= 0 && !input.context[lastPrevious]!.previousPart) lastPrevious--;
    input.context.forEach((c, i) => {
      lines.push(`[${c.code}, ${c.mode}] ${shorten(c.text)}`);
      if (i === lastPrevious) lines.push('(end of the previous part)');
    });
  }
  lines.push('', 'Units to label:');
  input.units.forEach((text, i) => lines.push(`${i}: ${JSON.stringify(text.trim())}`));
  return lines.join('\n');
}
