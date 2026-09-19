import { describe, it, expect } from 'vitest';
import { register } from '../../../plugin/caliber-jev-compaction/hooks/compaction.js';

/**
 * End-to-end test of the plugin's runtime contract.
 *
 * Claude Code loads the hook and calls `register(on, options)`, then fires
 * `session.compact` / `turn.complete` against the engine handle. This drives
 * that exact path with a fake engine and a fake fetch standing in for the Jev
 * API — everything a live session does except the one network hop to
 * api.typesafe.ai (unreachable and keyless in CI). It proves: the hooks
 * register, the key resolves, a compaction actually replaces the transcript,
 * every failure mode falls back to built-in compaction, and turn.complete
 * auto-triggers past the threshold.
 */

type Handlers = Record<string, (...args: unknown[]) => unknown>;

/** Captures the handlers `register` wires up. */
function collectHandlers(options: Record<string, unknown> = {}): Handlers {
  const handlers: Handlers = {};
  const on = ((pattern: string, handler: (...a: unknown[]) => unknown) => {
    handlers[pattern] = handler;
    return {};
  }) as never;
  register(on, options as never);
  return handlers;
}

interface FakeEngineOptions {
  /** Jev's answer for every question asked; 0 drops, 1 keeps. */
  noul?: number;
  /** Force a transport failure. */
  failFetch?: boolean;
  /** Value $.env.get('TYPESAFE_API_KEY') returns. */
  envKey?: string;
  /** Value $.env.get('AI_GATEWAY_API_KEY') returns. */
  gatewayEnvKey?: string;
  /** Context percentage $.session.usage() reports. */
  percent?: number;
}

function fakeEngine(opts: FakeEngineOptions = {}) {
  const calls = {
    fetched: [] as Array<{
      url: string;
      auth: string;
      questionKeys: string[];
      questionTypes: string[];
      modelId: string;
    }>,
    toasts: [] as string[],
    logs: [] as string[],
    compactRequested: 0,
  };

  const $ = {
    http: {
      async fetch(url: string, init?: { headers?: Record<string, string>; body?: string }) {
        const body = JSON.parse(init?.body ?? '{}') as {
          questions?: Record<string, { type?: string }>;
        };
        const questions = body.questions ?? {};
        calls.fetched.push({
          url,
          auth: init?.headers?.authorization ?? init?.headers?.Authorization ?? '',
          questionKeys: Object.keys(questions),
          questionTypes: Object.values(questions).map((q) => String(q.type)),
          modelId: init?.headers?.['ai-model-id'] ?? '',
        });
        if (opts.failFetch) return { status: 500, ok: false, text: 'jev exploded' };
        const isGateway = url.includes('evaluation-model') || url.includes('ai-gateway');
        const answers = Object.fromEntries(
          Object.keys(body.questions ?? {}).map((k) =>
            isGateway
              ? [k, { type: 'boolean', probability: opts.noul ?? 0 }]
              : [k, { type: 'noul', noul: opts.noul ?? 0 }],
          ),
        );
        return { status: 200, ok: true, text: JSON.stringify({ answers }) };
      },
    },
    env: {
      get: async (name: string) => {
        if (name === 'AI_GATEWAY_API_KEY') return opts.gatewayEnvKey;
        if (name === 'TYPESAFE_API_KEY') return opts.envKey;
        return undefined;
      },
    },
    settings: { read: async () => ({}) },
    ui: {
      log: (t: string) => calls.logs.push(t),
      toast: (t: string) => calls.toasts.push(t),
    },
    session: {
      usage: async () => ({ context: { percent: opts.percent ?? 0 } }),
      compact: async () => {
        calls.compactRequested += 1;
      },
    },
  };

  return { $, calls };
}

/** A transcript whose weight is old, droppable tool output. */
function transcript() {
  const big = (seed: string) => `${seed} `.repeat(400); // ~big tool result
  return [
    { role: 'user', text: 'Fix the failing test. Never touch src/generated.', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }],
    },
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 't1', text: big('AAAA'), isError: false }],
    },
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 't2', tool: 'Bash', input: { command: 'npm test' } }],
    },
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 't2', text: big('BBBB'), isError: false }],
    },
    { role: 'assistant', text: 'The failure is in b.test.ts.', toolUses: [] },
    { role: 'user', text: 'go ahead', toolUses: [] },
  ];
}

const NEXT = Symbol('next');
const next = () => NEXT;

describe('plugin runtime: session.compact', () => {
  it('registers both function hooks', () => {
    const handlers = collectHandlers();
    expect(Object.keys(handlers).sort()).toEqual(['session.compact', 'turn.complete']);
  });

  it('replaces the transcript when Jev drops stale calls (the whole path)', async () => {
    const handlers = collectHandlers({ apiKey: 'sk-test', preserveRecentMessages: 0 });
    const { $, calls } = fakeEngine({ noul: 0 }); // drop everything droppable

    const result = (await handlers['session.compact']($, { messages: transcript() }, next)) as {
      messages: unknown[];
    };

    // Returned the compacted transcript, not the built-in-summary fallback.
    expect(result).not.toBe(NEXT);
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeLessThanOrEqual(transcript().length);
    // Jev was actually consulted, with the key and real questions.
    expect(calls.fetched.length).toBeGreaterThan(0);
    expect(calls.fetched[0].auth).toBe('Bearer sk-test');
    expect(calls.fetched[0].questionKeys.length).toBeGreaterThan(0);
    expect(calls.toasts.join(' ')).toMatch(/no summary/);
  });

  it('falls back to built-in compaction when the reduction is not worth it', async () => {
    const handlers = collectHandlers({ apiKey: 'sk-test', preserveRecentMessages: 0 });
    const { $, calls } = fakeEngine({ noul: 1 }); // keep everything -> ~0 reduction

    const result = await handlers['session.compact']($, { messages: transcript() }, next);

    expect(result).toBe(NEXT);
    expect(calls.toasts.join(' ')).toMatch(/fallback to built-in summary/);
  });

  it('falls back — never throws into the session — when Jev fails', async () => {
    const handlers = collectHandlers({ apiKey: 'sk-test', preserveRecentMessages: 0 });
    const { $, calls } = fakeEngine({ failFetch: true });

    const result = await handlers['session.compact']($, { messages: transcript() }, next);

    expect(result).toBe(NEXT);
    expect(calls.toasts.join(' ')).toMatch(/fallback to built-in summary/);
  });

  it('resolves the key from the engine env when no option is set', async () => {
    const handlers = collectHandlers({ preserveRecentMessages: 0 }); // no apiKey option
    const { $, calls } = fakeEngine({ noul: 0, envKey: 'sk-from-env' });

    await handlers['session.compact']($, { messages: transcript() }, next);

    expect(calls.fetched[0]?.auth).toBe('Bearer sk-from-env');
  });

  it('falls back when no key can be found anywhere', async () => {
    const handlers = collectHandlers({ preserveRecentMessages: 0 });
    const { $, calls } = fakeEngine({}); // no option, no env key

    const result = await handlers['session.compact']($, { messages: transcript() }, next);

    expect(result).toBe(NEXT);
    expect(calls.fetched.length).toBe(0); // never even reached the network
  });

  it('resolves the key from settings.env when option and process env are empty', async () => {
    const handlers = collectHandlers({ preserveRecentMessages: 0 });
    const { $, calls } = fakeEngine({ noul: 0 });
    $.settings.read = async () => ({ env: { TYPESAFE_API_KEY: 'sk-from-settings' } });

    await handlers['session.compact']($, { messages: transcript() }, next);

    expect(calls.fetched[0]?.auth).toBe('Bearer sk-from-settings');
    expect(calls.fetched[0]?.url).toContain('typesafe.ai');
  });

  it('uses Vercel AI Gateway when gatewayApiKey is set', async () => {
    const handlers = collectHandlers({ gatewayApiKey: 'gw-opt', preserveRecentMessages: 0 });
    const { $, calls } = fakeEngine({ noul: 0 });

    const result = await handlers['session.compact']($, { messages: transcript() }, next);

    expect(result).not.toBe(NEXT);
    expect(calls.fetched[0]?.auth).toBe('Bearer gw-opt');
    expect(calls.fetched[0]?.url).toContain('evaluation-model');
    expect(calls.fetched[0]?.url).toContain('ai-gateway.vercel.sh/v4/ai');
    expect(calls.fetched[0]?.modelId).toBe('typesafe-ai/jev');
    expect(calls.fetched[0]?.questionTypes.length).toBeGreaterThan(0);
    expect(calls.fetched[0]?.questionTypes.every((t) => t === 'boolean')).toBe(true);
  });

  it('prefers AI_GATEWAY_API_KEY from the engine env over TYPESAFE_API_KEY', async () => {
    const handlers = collectHandlers({ preserveRecentMessages: 0 });
    const { $, calls } = fakeEngine({
      noul: 0,
      envKey: 'sk-typesafe',
      gatewayEnvKey: 'gw-from-env',
    });

    await handlers['session.compact']($, { messages: transcript() }, next);

    expect(calls.fetched[0]?.auth).toBe('Bearer gw-from-env');
    expect(calls.fetched[0]?.url).toContain('ai-gateway.vercel.sh');
    expect(calls.fetched[0]?.modelId).toBe('typesafe-ai/jev');
    expect(calls.fetched[0]?.questionTypes.every((t) => t === 'boolean')).toBe(true);
  });

  it('keeps an explicit TypeSafe apiKey even when a Gateway env key exists', async () => {
    const handlers = collectHandlers({ apiKey: 'sk-explicit', preserveRecentMessages: 0 });
    const { $, calls } = fakeEngine({ noul: 0, gatewayEnvKey: 'gw-from-env' });

    await handlers['session.compact']($, { messages: transcript() }, next);

    expect(calls.fetched[0]?.auth).toBe('Bearer sk-explicit');
    expect(calls.fetched[0]?.url).toContain('typesafe.ai');
  });

  it('keeps user and assistant text verbatim when Jev drops stale calls', async () => {
    const handlers = collectHandlers({ apiKey: 'sk-test', preserveRecentMessages: 0 });
    const { $ } = fakeEngine({ noul: 0 });
    const input = transcript();

    const result = (await handlers['session.compact']($, { messages: input }, next)) as {
      messages: Array<{ text: string }>;
    };

    expect(result).not.toBe(NEXT);
    const kept = result.messages.map((m) => m.text);
    expect(kept).toContain('Fix the failing test. Never touch src/generated.');
    expect(kept).toContain('go ahead');
    expect(kept).toContain('The failure is in b.test.ts.');
  });
});

describe('plugin runtime: turn.complete', () => {
  it('requests compaction once context passes the threshold', async () => {
    const handlers = collectHandlers({ compactAtPercent: 60 });
    const { $, calls } = fakeEngine({ percent: 80 });

    const result = await handlers['turn.complete']($, { reason: 'answer' }, next);

    expect(calls.compactRequested).toBe(1);
    expect(result).toBe(NEXT);
  });

  it('does nothing below the threshold', async () => {
    const handlers = collectHandlers({ compactAtPercent: 60 });
    const { $, calls } = fakeEngine({ percent: 10 });

    const result = await handlers['turn.complete']($, { reason: 'answer' }, next);

    expect(calls.compactRequested).toBe(0);
    expect(result).toBe(NEXT);
  });
});
