import { describe, it, expect } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  jevAsker,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../../../plugin/caliber-jev-compaction/hooks/compaction.js';
import {
  applyDecisions,
  collectToolCalls,
  decideCall,
  type CompactResult,
  type Message,
} from '../../vendor/caliber-jev-compaction/index.js';

/**
 * The plugin hook is vendored from upstream and loaded by Claude Code at
 * runtime, so it is never bundled into dist/bin.js. Its `claude-code` imports
 * are type-only and erase at compile time, which makes the pure helpers — the
 * ones that decide what the session transcript becomes — testable here.
 */

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function result(stats: Partial<CompactResult['stats']> = {}): CompactResult {
  return {
    messages: [],
    decisions: [],
    stats: {
      messagesBefore: 10,
      messagesAfter: 6,
      charsBefore: 1000,
      charsAfter: 400,
      calls: 4,
      kept: 1,
      resultsDropped: 1,
      callsDropped: 2,
      pinned: 0,
      stateTokens: 1200,
      stateStage: 'full',
      requests: 1,
      ms: 5,
      ...stats,
    },
  };
}

describe('resolveHookConfig', () => {
  it('falls back to upstream defaults when nothing is configured', () => {
    const config = resolveHookConfig({});
    expect(config.compactAtPercent).toBe(60);
    expect(config.minReductionRatio).toBe(0.25);
    expect(config.model).toBe('jev-latest');
  });

  it('takes configured numbers and strings', () => {
    const config = resolveHookConfig({
      compactAtPercent: 80,
      keepThreshold: 0.7,
      model: 'jev-pinned',
      apiKey: 'sk-test',
    });
    expect(config.compactAtPercent).toBe(80);
    expect(config.keepThreshold).toBe(0.7);
    expect(config.model).toBe('jev-pinned');
    expect(config.apiKey).toBe('sk-test');
  });

  it('takes a Gateway key and base URL from userConfig', () => {
    const config = resolveHookConfig({
      gatewayApiKey: 'gw-test',
      gatewayBaseUrl: 'https://gateway.example/v4/ai',
    });
    expect(config.gatewayApiKey).toBe('gw-test');
    expect(config.gatewayBaseUrl).toBe('https://gateway.example/v4/ai');
  });

  it('ignores values of the wrong type rather than trusting them', () => {
    const config = resolveHookConfig({ compactAtPercent: 'lots', model: '' });
    expect(config.compactAtPercent).toBe(60);
    expect(config.model).toBe('jev-latest');
  });
});

describe('toSessionMessages', () => {
  it('returns the engine’s own objects for untouched messages', () => {
    const kept = message('user', 'hello');
    const input = [kept];

    const output = toSessionMessages(input as never, [kept]);

    // Identity matters: an unchanged message must come back as the same object
    // so the engine keeps its handle rather than treating it as edited.
    expect(output[0]).toBe(kept);
  });

  it('rebuilds messages the library reconstructed', () => {
    const original = message('assistant', 'original');
    const rebuilt = message('assistant', 'trimmed');

    const output = toSessionMessages([original] as never, [rebuilt]);

    expect(output[0]).not.toBe(original);
    expect(output[0].text).toBe('trimmed');
  });

  it('preserves tool uses and results by identity where it can', () => {
    const toolUse = { tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } };
    const toolResult = { tool_use_id: 't1', text: 'contents', isError: false };
    const call = message('assistant', '', { toolUses: [toolUse] });
    const answer = message('user', '', { toolResults: [toolResult] });

    const output = toSessionMessages([call, answer] as never, [
      message('assistant', 'edited', { toolUses: [toolUse] }),
      answer,
    ]);

    expect(output[0].toolUses[0]).toBe(toolUse);
    expect(output[1]).toBe(answer);
  });

  it('drops messages the library removed', () => {
    const keep = message('user', 'keep');
    const drop = message('assistant', 'drop');

    expect(toSessionMessages([keep, drop] as never, [keep])).toEqual([keep]);
  });
});

describe('summarize', () => {
  it('reports the reduction and the per-reason counts', () => {
    const text = summarize(result());
    expect(text).toContain('60% reduction');
    expect(text).toContain('1 kept');
    expect(text).toContain('1 results truncated');
    expect(text).toContain('1 request(s)');
  });

  it('says so when there were no tool calls', () => {
    expect(summarize(result({ kept: 0, resultsDropped: 0, callsDropped: 0, pinned: 0 }))).toContain(
      'no tool calls',
    );
  });
});

describe('decisionLogLines', () => {
  it('reports none when every call was pinned', () => {
    const withPinned = result();
    withPinned.decisions = [
      { id: 't1', tool: 'Read', action: 'keep', reason: 'pinned', keepCall: 1, keepResult: 1 },
    ];
    expect(decisionLogLines(withPinned)).toEqual(['decisions: (none)']);
  });

  it('splits long decision logs into numbered chunks', () => {
    const many = result();
    many.decisions = Array.from({ length: 200 }, (_, i) => ({
      id: `t${i}`,
      tool: 'Read',
      action: 'drop_call' as const,
      reason: 'call_dropped' as const,
      keepCall: 0.1,
      keepResult: 0.1,
    }));

    const lines = decisionLogLines(many, 200);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^decisions \(1\/\d+\): /);
  });
});

describe('compactSession', () => {
  type SessionMessage = Message & { handle?: string };

  function sessionMessage(
    role: Message['role'],
    text: string,
    extra: Partial<SessionMessage> = {},
  ): SessionMessage {
    return { role, text, toolUses: [], ...extra };
  }

  function sessionCall(
    id: string,
    tool: string,
    input: Record<string, unknown>,
    text: string,
  ): SessionMessage {
    return sessionMessage('assistant', '', {
      toolUses: [{ tool_use_id: id, tool, input, text }],
      handle: `h-${id}`,
    });
  }

  function sessionResult(id: string, text: string, isError = false): SessionMessage {
    return sessionMessage('user', '', {
      toolResults: [{ tool_use_id: id, text, isError }],
      handle: `r-${id}`,
    });
  }

  const fileA = 'export const a = 1;\n'.repeat(50);

  function sessionTranscript(): SessionMessage[] {
    return [
      sessionMessage('user', 'Fix the failing test.', { handle: 'h-0' }),
      sessionCall('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
      sessionResult('tool-1', fileA),
      sessionCall('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
      sessionResult('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
      sessionMessage('assistant', 'Fixing now.', { handle: 'h-5' }),
      sessionMessage('user', 'go ahead', { handle: 'h-6' }),
    ];
  }

  function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
    return async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? '');
      const { questions } = JSON.parse(init?.body ?? '{}') as {
        questions: Record<string, unknown>;
      };
      const answers = Object.fromEntries(
        Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
      );
      return { status: 200, ok: true, text: JSON.stringify({ answers }) };
    };
  }

  it('returns engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = sessionTranscript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(
      messages as never,
      applyDecisions(messages, decisions, calls, 300),
    );
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect((out[1] as SessionMessage).handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[caliber-jev-compaction truncated 1700 chars`),
    );
    expect((out[2] as SessionMessage).handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[caliber-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = {
      ...resolveHookConfig({ preserveRecentMessages: 1 }),
      apiKey: 'k',
      model: 'jev-x',
    };
    const { result: output, messages } = await compactSession(
      sessionTranscript() as never,
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => (m as SessionMessage).handle)).toEqual([
      'h-0',
      'h-tool-2',
      'r-tool-2',
      'h-5',
      'h-6',
    ]);
    expect(summarize(output)).toMatch(
      /^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/,
    );
    expect(decisionLog(output)).toBe(
      't1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90',
    );
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(
      compactSession(
        sessionTranscript() as never,
        config,
        jevFetch(() => 0),
      ),
    ).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(sessionTranscript() as never, { ...config, apiKey: 'k' }, async () => ({
        status: 500,
        ok: false,
        text: 'x',
      })),
    ).rejects.toThrow(/500/);
  });
});

describe('jevAsker', () => {
  it('posts the built request and parses the response', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const asker = jevAsker(
      async (url, init) => {
        calls.push({ url, body: String(init?.body) });
        return { status: 200, ok: true, text: JSON.stringify({ answers: { q1: { noul: 0.9 } } }) };
      },
      'sk-test',
      'jev-latest',
    );

    const response = await asker.ask('state', {
      q1: { type: 'noul', instructions: 'keep?' },
    });

    expect(response.answers.q1).toEqual({ noul: 0.9 });
    expect(calls[0].url).toContain('typesafe.ai');
    expect(JSON.parse(calls[0].body).model).toBe('jev-latest');
  });

  it('posts Gateway evaluate when the transport is gateway', async () => {
    const calls: Array<{ url: string; body: string; headers?: Record<string, string> }> = [];
    const asker = jevAsker(
      async (url, init) => {
        calls.push({ url, body: String(init?.body), headers: init?.headers });
        return {
          status: 200,
          ok: true,
          text: JSON.stringify({ answers: { q1: { type: 'boolean', probability: 0.7 } } }),
        };
      },
      'gw-test',
      'jev-latest',
      { kind: 'gateway' },
    );

    const response = await asker.ask('state', {
      q1: { type: 'noul', instructions: 'keep?' },
    });

    expect(response.answers.q1).toEqual({ type: 'noul', noul: 0.7 });
    expect(calls[0].url).toContain('ai-gateway.vercel.sh');
    expect(calls[0].url).toContain('evaluation-model');
    expect(JSON.parse(calls[0].body).questions.q1.type).toBe('boolean');
    expect(JSON.parse(calls[0].body).model).toBeUndefined();
    expect(calls[0].headers?.['ai-model-id']).toBe('typesafe-ai/jev');
  });

  it('throws on a failed Jev request rather than returning junk', async () => {
    const asker = jevAsker(
      async () => ({ status: 500, ok: false, text: 'upstream exploded' }),
      'sk-test',
      'jev-latest',
    );

    await expect(asker.ask('state', {})).rejects.toThrow(/Jev request failed \(500\)/);
  });
});
