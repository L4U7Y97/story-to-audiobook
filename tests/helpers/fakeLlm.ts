import type { LlmRequest, LlmResponse, LlmTransport } from '@/analysis/llm/client';

export interface FakeCall {
  request: LlmRequest;
  /** The unit texts the prompt asked to label, in order. */
  units: string[];
  /** The cast codes listed in the prompt. */
  codes: string[];
}

type Reply = Partial<LlmResponse> | object | string;

/** Reads the numbered units back out of a user prompt. */
export function unitsOf(user: string): string[] {
  const section = user.split('Units to label:\n')[1] ?? '';
  return section
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(line.indexOf(': ') + 2)) as string);
}

function codesOf(user: string): string[] {
  const section = user.split('Cast:\n')[1]?.split('\n\n')[0] ?? '';
  return section.split('\n').map((line) => line.slice(0, line.indexOf(':')));
}

/**
 * A transport that answers with `respond(call)`: an object is sent as the JSON output, a string
 * as raw text, and a value with `stopReason` or `text` as the full response.
 */
export function fakeTransport(respond: (call: FakeCall) => Reply | Promise<Reply>): LlmTransport & {
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  return {
    calls,
    async send(request) {
      const call = { request, units: unitsOf(request.user), codes: codesOf(request.user) };
      calls.push(call);
      const reply = await respond(call);
      const usage = { inputTokens: request.user.length, outputTokens: 100 };
      if (typeof reply === 'string') return { stopReason: 'end_turn', text: reply, usage };
      if ('stopReason' in reply || 'text' in reply) {
        return { stopReason: 'end_turn', text: '', usage, ...(reply as Partial<LlmResponse>) };
      }
      return { stopReason: 'end_turn', text: JSON.stringify(reply), usage };
    },
  };
}

/** A reply labelling every unit as one span: quoted units go to `speaker`, the rest to N. */
export function labelAll(units: readonly string[], speaker: string, extra: object = {}) {
  return {
    units: units.map((text, id) => ({
      id,
      spans: [
        /^[“"«—]/u.test(text) ? { speaker, mode: 'speech' } : { speaker: 'N', mode: 'narration' },
      ],
    })),
    newCharacters: [],
    aliasAdditions: [],
    ...extra,
  };
}
