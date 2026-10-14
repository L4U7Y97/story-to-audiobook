import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { TONE_LABELS } from '@/format/types';

export const MODES = ['narration', 'speech', 'thought', 'written'] as const;

const ToneSchema = z.object({
  label: z.enum(TONE_LABELS),
  intensity: z.number().int().optional().describe('1 mild, 2 clear, 3 extreme'),
});

export const SpanSchema = z.object({
  text: z
    .string()
    .optional()
    .describe('Omit when the span is the whole unit. When a unit is split, the exact unit text.'),
  speaker: z.string().describe('A cast code (N, U, c1…) or the ref of a new character'),
  mode: z.enum(MODES),
  tone: ToneSchema.optional(),
});

export const UnitLabelSchema = z.object({
  id: z.number().int(),
  spans: z.array(SpanSchema),
});

export const NewCharacterSchema = z.object({
  ref: z.string().describe('A new code for this character, e.g. "n1"'),
  name: z.string(),
  aliases: z.array(z.string()),
  gender: z.enum(['male', 'female', 'other']).optional(),
  description: z.string().describe('A few words that identify the character'),
});

export const AliasAdditionSchema = z.object({
  characterId: z.string().describe('The cast code of an existing character'),
  alias: z.string(),
});

export const LlmOutputSchema = z.object({
  units: z.array(UnitLabelSchema),
  newCharacters: z.array(NewCharacterSchema),
  aliasAdditions: z.array(AliasAdditionSchema),
});

export type LlmSpan = z.infer<typeof SpanSchema>;
export type LlmUnitLabel = z.infer<typeof UnitLabelSchema>;
export type LlmNewCharacter = z.infer<typeof NewCharacterSchema>;
export type LlmOutput = z.infer<typeof LlmOutputSchema>;

/** The structured-output format sent with every request. */
export const LLM_OUTPUT_FORMAT = zodOutputFormat(LlmOutputSchema);

/**
 * Reads a response leniently: each unit, new character and alias addition is validated on its
 * own, so one malformed item only costs that item (its unit falls back to the heuristic).
 */
export function readLlmOutput(raw: string): {
  units: LlmUnitLabel[];
  newCharacters: LlmNewCharacter[];
  aliasAdditions: Array<z.infer<typeof AliasAdditionSchema>>;
} {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { units: [], newCharacters: [], aliasAdditions: [] };
  }
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const each = <T>(value: unknown, schema: z.ZodType<T>): T[] =>
    Array.isArray(value)
      ? value.flatMap((item) => {
          const parsed = schema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  return {
    units: each(obj.units, UnitLabelSchema),
    newCharacters: each(obj.newCharacters, NewCharacterSchema),
    aliasAdditions: each(obj.aliasAdditions, AliasAdditionSchema),
  };
}
