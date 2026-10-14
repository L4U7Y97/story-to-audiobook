import Anthropic from '@anthropic-ai/sdk';
import type { JSONOutputFormat } from '@anthropic-ai/sdk/resources/messages';

export type Effort = 'low' | 'medium' | 'high';

/** Models offered in Settings; the first is the default. */
export const MODELS = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fast, cheapest)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (most capable)' },
] as const;

export interface LlmRequest {
  model: string;
  effort: Effort;
  system: string;
  user: string;
  maxTokens: number;
  format: JSONOutputFormat;
}

export interface LlmResponse {
  stopReason: string | null;
  /** Concatenated text blocks (the JSON document when structured output succeeded). */
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** The one thing the analyser needs from the API; tests replace it with a fake. */
export interface LlmTransport {
  send(request: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorReason = 'auth' | 'model' | 'network' | 'api';

/** A failure that ends the whole analysis (the part is marked failed). */
export class LlmError extends Error {
  constructor(
    readonly reason: LlmErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const MESSAGES: Record<LlmErrorReason, string> = {
  auth: 'API key rejected',
  model: 'The selected model is not available for this API key',
  network: 'Could not reach the Anthropic API. Check the connection and try again.',
  api: 'The Anthropic API returned an error. Try again later.',
};

/** Maps SDK errors to the few cases the UI distinguishes. Never includes the key. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  )
    return new LlmError('auth', MESSAGES.auth);
  if (error instanceof Anthropic.NotFoundError) return new LlmError('model', MESSAGES.model);
  if (error instanceof Anthropic.APIConnectionError)
    return new LlmError('network', MESSAGES.network);
  if (error instanceof Anthropic.APIError) {
    const status = error.status ? ` (${error.status})` : '';
    return new LlmError('api', `${MESSAGES.api}${status}`);
  }
  return new LlmError('api', MESSAGES.api);
}

function client(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    // A personal app: the key is the user's own and is only sent to api.anthropic.com.
    dangerouslyAllowBrowser: true,
    // The SDK retries 429, 5xx and connection errors with exponential backoff.
    maxRetries: 4,
  });
}

export function createAnthropicTransport(apiKey: string): LlmTransport {
  const anthropic = client(apiKey);
  return {
    async send(request) {
      try {
        const response = await anthropic.messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          output_config: { effort: request.effort, format: request.format },
        });
        return {
          stopReason: response.stop_reason,
          text: response.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (error) {
        throw toLlmError(error);
      }
    },
  };
}

/**
 * Checks a key with one free request (it reads the model's metadata, so nothing is billed) and
 * that the chosen model is available to it.
 */
export async function testApiKey(
  apiKey: string,
  model: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!apiKey.trim()) return { ok: false, message: 'Enter an API key first' };
  try {
    await client(apiKey.trim()).models.retrieve(model);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toLlmError(error).message };
  }
}
