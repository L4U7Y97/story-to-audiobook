import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzePart } from '@/analysis/analyzer';
import { createAnthropicTransport, testApiKey } from '@/analysis/llm/client';
import { openStoryDb } from '@/storage/db';
import { addPart, getPart } from '@/storage/parts';
import { createStory } from '@/storage/stories';
import { setSetting, getSetting } from '@/storage/settings';
import { unitsOf } from '../../helpers/fakeLlm';

const KEY = 'sk-ant-test-SECRET-1234';

interface Sent {
  url: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

/** Stubs fetch with a handler; records every request. */
function stubFetch(handle: (sent: Sent) => { status: number; body: unknown }): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = init?.body ? String(init.body) : '';
      const s: Sent = {
        url: request.url,
        headers: request.headers,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
      };
      sent.push(s);
      const { status, body } = handle(s);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
      });
    }),
  );
  return sent;
}

const authError = {
  status: 401,
  body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('testApiKey', () => {
  it('reports a rejected key as "API key rejected"', async () => {
    stubFetch(() => authError);
    expect(await testApiKey('sk-ant-wrong', 'claude-haiku-5-5')).toEqual({
      ok: false,
      message: 'API key rejected',
    });
  });

  it('accepts a working key with one free request to the model endpoint', async () => {
    const sent = stubFetch(() => ({
      status: 200,
      body: { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
    }));
    expect(await testApiKey(` ${KEY} `, 'claude-haiku-5-5')).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/models/claude-haiku-5-5');
    expect(sent[0]!.headers.get('x-api-key')).toBe(KEY);
  });

  it('explains a model the key cannot use', async () => {
    stubFetch(() => ({
      status: 404,
      body: { type: 'error', error: { type: 'not_found_error', message: 'model: x' } },
    }));
    expect(await testApiKey(KEY, 'x')).toEqual({
      ok: false,
      message: 'The selected model is not available for this API key',
    });
  });

  it('asks for a key when none is set, without any request', async () => {
    const sent = stubFetch(() => authError);
    expect(await testApiKey('  ', 'claude-haiku-5-5')).toMatchObject({ ok: false });
    expect(sent).toHaveLength(0);
  });
});

describe('analysis through the real SDK', () => {
  it('sends structured-output requests only to api.anthropic.com and never stores or logs the key', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    await setSetting('apiKey', KEY);
    const sent = stubFetch(({ body }) => {
      const messages = body!.messages as Array<{ content: string }>;
      const units = unitsOf(messages[0]!.content);
      const answer = {
        units: units.map((text, id) => ({
          id,
          spans: [
            text.startsWith('“')
              ? { speaker: 'new1', mode: 'speech' }
              : { speaker: 'N', mode: 'narration' },
          ],
        })),
        newCharacters: [{ ref: 'new1', name: 'Anne', aliases: [], description: 'a girl' }],
        aliasAdditions: [],
      };
      return {
        status: 200,
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [{ type: 'text', text: JSON.stringify(answer) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 900, output_tokens: 120 },
        },
      };
    });

    const db = openStoryDb(`llm-client-${Math.random()}`);
    try {
      const story = await createStory(db, { title: 'S', lang: 'en' });
      const part = await addPart(db, story.id, {
        title: 'p',
        source: { kind: 'paste' },
        text: '“Hi,” said Anne.',
      });
      const transport = createAnthropicTransport(await getSetting('apiKey'));
      const report = await analyzePart(db, part.id, {
        voices: [],
        llm: { transport, model: 'claude-haiku-5-5', effort: 'low' },
      });

      expect(report).toMatchObject({
        kind: 'llm',
        usage: { inputTokens: 900, outputTokens: 120 },
      });
      expect((await getPart(db, part.id))!.analysisStatus).toBe('done');
      expect(sent.every((s) => new URL(s.url).host === 'api.anthropic.com')).toBe(true);
      expect(sent[0]!.body).toMatchObject({
        model: 'claude-haiku-5-5',
        output_config: { effort: 'low', format: { type: 'json_schema' } },
      });

      const everything = JSON.stringify(
        await Promise.all(db.tables.map(async (t) => [t.name, await t.toArray()])),
      );
      expect(everything).toContain('Anne');
      expect(everything).not.toContain('SECRET');
      for (const spy of logs) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET');
      }
    } finally {
      await db.delete();
    }
  });
});
