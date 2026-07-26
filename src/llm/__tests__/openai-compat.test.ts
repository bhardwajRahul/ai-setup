import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMConfig } from '../types.js';

const openAIConstructor = vi.fn();
const mockSDKCreate = vi.fn();

class MockAPIConnectionError extends Error {
  status: undefined;
  headers: undefined;
  requestID: undefined;
  error: undefined;
  code: undefined;
  param: undefined;
  type: undefined;
  cause: unknown;
  constructor({ message, cause }: { message?: string; cause?: unknown }) {
    super(message || 'Connection error.');
    this.name = 'APIConnectionError';
    this.cause = cause;
  }
}

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: mockSDKCreate } };
    models = { list: vi.fn() };
    constructor(opts: unknown) {
      openAIConstructor(opts);
    }
  }
  return { default: OpenAI, APIConnectionError: MockAPIConnectionError };
});

vi.mock('../usage.js', () => ({
  trackUsage: vi.fn(),
}));

const defaultConfig: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'http://localhost:11434/v1',
  model: 'gpt-4o',
};

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

function makeReader(chunks: Array<{ done: boolean; value?: Uint8Array }>): {
  getReader: () => {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock: () => void;
  };
} {
  let i = 0;
  return {
    getReader: () => ({
      read: () => {
        if (i < chunks.length) return Promise.resolve(chunks[i++]);
        return Promise.resolve({ done: true });
      },
      releaseLock: () => {},
    }),
  };
}

describe('OpenAICompatProvider — CALIBER_OPENAI_TIMEOUT_MS', () => {
  beforeEach(() => {
    openAIConstructor.mockClear();
    delete process.env.CALIBER_OPENAI_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.CALIBER_OPENAI_TIMEOUT_MS;
  });

  it('uses the default 10-minute timeout when env var is unset', async () => {
    const { OpenAICompatProvider } = await import('../openai-compat.js');
    new OpenAICompatProvider(defaultConfig);
    expect(openAIConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 10 * 60 * 1000 }),
    );
  });

  it('honors CALIBER_OPENAI_TIMEOUT_MS when set', async () => {
    process.env.CALIBER_OPENAI_TIMEOUT_MS = '1800000';
    const { OpenAICompatProvider } = await import('../openai-compat.js');
    new OpenAICompatProvider(defaultConfig);
    expect(openAIConstructor).toHaveBeenCalledWith(expect.objectContaining({ timeout: 1800000 }));
  });

  it('falls back to default when env var is non-numeric', async () => {
    process.env.CALIBER_OPENAI_TIMEOUT_MS = 'forever';
    const { OpenAICompatProvider } = await import('../openai-compat.js');
    new OpenAICompatProvider(defaultConfig);
    expect(openAIConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 10 * 60 * 1000 }),
    );
  });

  it('falls back to default when env var is below 1000ms', async () => {
    process.env.CALIBER_OPENAI_TIMEOUT_MS = '500';
    const { OpenAICompatProvider } = await import('../openai-compat.js');
    new OpenAICompatProvider(defaultConfig);
    expect(openAIConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 10 * 60 * 1000 }),
    );
  });
});

describe('OpenAICompatProvider — SDK call path', () => {
  beforeEach(() => {
    mockSDKCreate.mockReset();
    mocks.fetch.mockReset();
    delete process.env.CALIBER_OPENAI_TIMEOUT_MS;
  });

  it('returns SDK result when SDK succeeds', async () => {
    mockSDKCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello from SDK' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });

    const { OpenAICompatProvider } = await import('../openai-compat.js');
    const provider = new OpenAICompatProvider(defaultConfig);
    const result = await provider.call({ system: 'be helpful', prompt: 'hi' });

    expect(result).toBe('Hello from SDK');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('propagates non-connection errors without fallback', async () => {
    const sdkError = new Error('Invalid API key');
    mockSDKCreate.mockRejectedValue(sdkError);

    const { OpenAICompatProvider } = await import('../openai-compat.js');
    const provider = new OpenAICompatProvider(defaultConfig);

    await expect(provider.call({ system: 'be helpful', prompt: 'hi' })).rejects.toThrow(
      'Invalid API key',
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('propagates connection error if it has an HTTP status (not transport-level)', async () => {
    const apiError = new MockAPIConnectionError({ message: '401 Invalid auth' });
    apiError.status = 401 as never;
    mockSDKCreate.mockRejectedValue(apiError);

    const { OpenAICompatProvider } = await import('../openai-compat.js');
    const provider = new OpenAICompatProvider(defaultConfig);

    await expect(provider.call({ system: 'be helpful', prompt: 'hi' })).rejects.toThrow(
      '401 Invalid auth',
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('OpenAICompatProvider — fetch fallback', () => {
  beforeEach(() => {
    mockSDKCreate.mockReset();
    mocks.fetch.mockReset();
    global.fetch = mocks.fetch as unknown as typeof global.fetch;
    delete process.env.CALIBER_OPENAI_TIMEOUT_MS;
  });

  it('falls back to fetch on APIConnectionError and returns result', async () => {
    const connError = new MockAPIConnectionError({
      message: 'Connection error.',
      cause: new TypeError('fetch failed'),
    });
    mockSDKCreate.mockRejectedValue(connError);

    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: 'Hello from fetch fallback' } }],
          usage: { prompt_tokens: 5, completion_tokens: 10 },
        }),
    });

    const { OpenAICompatProvider } = await import('../openai-compat.js');
    const provider = new OpenAICompatProvider(defaultConfig);
    const result = await provider.call({ system: 'be helpful', prompt: 'hi' });

    expect(result).toBe('Hello from fetch fallback');

    const fetchCall = mocks.fetch.mock.calls[0];
    expect(fetchCall[0]).toBe('http://localhost:11434/v1/chat/completions');

    const fetchOpts = fetchCall[1];
    expect(fetchOpts.method).toBe('POST');
    expect(fetchOpts.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    });

    const sentBody = JSON.parse(fetchOpts.body);
    expect(sentBody.model).toBe('gpt-4o');
    expect(sentBody.messages).toHaveLength(2);
    expect(sentBody.messages[0].role).toBe('system');
    expect(sentBody.messages[1].role).toBe('user');
  });

  it('rejects with safe diagnostics on HTTP error', async () => {
    const connError = new MockAPIConnectionError({ message: 'Connection error.' });
    mockSDKCreate.mockRejectedValue(connError);

    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: () => Promise.resolve({ error: { message: 'upstream failure' } }),
    });

    const { OpenAICompatProvider } = await import('../openai-compat.js');
    const provider = new OpenAICompatProvider(defaultConfig);

    await expect(provider.call({ system: 'be helpful', prompt: 'hi' })).rejects.toThrow('HTTP 502');
    await expect(provider.call({ system: 'be helpful', prompt: 'hi' })).rejects.toThrow(
      'upstream failure',
    );
  });

  it('rejects with combined diagnostics when fetch also fails', async () => {
    const connError = new MockAPIConnectionError({
      message: 'Connection error.',
      cause: new Error('ECONNREFUSED'),
    });
    mockSDKCreate.mockRejectedValue(connError);

    mocks.fetch.mockRejectedValue(new TypeError('fetch failed'));

    const { OpenAICompatProvider } = await import('../openai-compat.js');
    const provider = new OpenAICompatProvider(defaultConfig);

    await expect(provider.call({ system: 'be helpful', prompt: 'hi' })).rejects.toThrow(
      'connection failed',
    );
    await expect(provider.call({ system: 'be helpful', prompt: 'hi' })).rejects.toThrow(
      'ECONNREFUSED',
    );
    await expect(provider.call({ system: 'be helpful', prompt: 'hi' })).rejects.toThrow(
      'fetch failed',
    );
  });

  it('does not include API key in error messages', async () => {
    const connError = new MockAPIConnectionError({ message: 'Connection error.' });
    mockSDKCreate.mockRejectedValue(connError);

    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: { message: 'Invalid authentication' } }),
    });

    const { OpenAICompatProvider } = await import('../openai-compat.js');
    const provider = new OpenAICompatProvider(defaultConfig);

    let err: Error | undefined;
    try {
      await provider.call({ system: 'be helpful', prompt: 'hi' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).not.toContain('sk-test');
  });
});

describe('OpenAICompatProvider — streaming', () => {
  beforeEach(() => {
    mockSDKCreate.mockReset();
    mocks.fetch.mockReset();
    global.fetch = mocks.fetch as unknown as typeof global.fetch;
    delete process.env.CALIBER_OPENAI_TIMEOUT_MS;
  });

  it('uses SDK stream when SDK succeeds', async () => {
    async function* mockAsyncIterable() {
      yield { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] };
      yield { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] };
    }
    mockSDKCreate.mockResolvedValue(mockAsyncIterable());

    const { OpenAICompatProvider } = await import('../openai-compat.js');
    const provider = new OpenAICompatProvider(defaultConfig);
    const text: string[] = [];
    const onText = (t: string) => text.push(t);
    const onEnd = vi.fn();
    const onError = vi.fn();

    await provider.stream({ system: 'be helpful', prompt: 'hi' }, { onText, onError, onEnd });

    expect(text.join('')).toBe('Hello world');
    expect(onError).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('falls back to fetch stream on APIConnectionError', async () => {
    const connError = new MockAPIConnectionError({ message: 'Connection error.' });
    mockSDKCreate.mockRejectedValue(connError);

    const encoder = new TextEncoder();
    const reader = makeReader([
      {
        done: false,
        value: encoder.encode(
          'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n' +
            'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n' +
            'data: [DONE]\n',
        ),
      },
    ]);

    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: reader,
    });

    const { OpenAICompatProvider } = await import('../openai-compat.js');
    const provider = new OpenAICompatProvider(defaultConfig);
    const text: string[] = [];
    const onText = (t: string) => text.push(t);
    const onEnd = vi.fn();
    const onError = vi.fn();

    await provider.stream({ system: 'be helpful', prompt: 'hi' }, { onText, onError, onEnd });

    expect(text.join('')).toBe('Hello world');
    expect(onError).not.toHaveBeenCalled();

    const fetchCall = mocks.fetch.mock.calls[0];
    expect(fetchCall[0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(fetchCall[1].method).toBe('POST');
    expect(fetchCall[1].headers.Authorization).toBe('Bearer sk-test');
  });

  it('reports fetch failure in streaming fallback via onError', async () => {
    const connError = new MockAPIConnectionError({ message: 'Connection error.' });
    mockSDKCreate.mockRejectedValue(connError);

    mocks.fetch.mockRejectedValue(new TypeError('network failure'));

    const { OpenAICompatProvider } = await import('../openai-compat.js');
    const provider = new OpenAICompatProvider(defaultConfig);
    const onError = vi.fn();
    const onEnd = vi.fn();

    await provider.stream(
      { system: 'be helpful', prompt: 'hi' },
      { onText: vi.fn(), onError, onEnd },
    );

    expect(onError).toHaveBeenCalled();
    const errArg = onError.mock.calls[0][0] as Error;
    expect(errArg.message).toContain('network failure');
    expect(errArg.message).not.toContain('sk-test');
  });
});
