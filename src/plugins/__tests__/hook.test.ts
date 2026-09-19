import { describe, it, expect } from 'vitest';
import {
  decisionLogLines,
  jevAsker,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../../../plugin/caliber-jev-compaction/hooks/compaction.js';
import type { CompactResult, Message } from '../../vendor/caliber-jev-compaction/index.js';

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

  it('throws on a failed Jev request rather than returning junk', async () => {
    const asker = jevAsker(
      async () => ({ status: 500, ok: false, text: 'upstream exploded' }),
      'sk-test',
      'jev-latest',
    );

    await expect(asker.ask('state', {})).rejects.toThrow(/Jev request failed \(500\)/);
  });
});
