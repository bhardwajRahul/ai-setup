import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compactTranscript, CompactionError } from '../index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('compactTranscript', () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalGateway = process.env.AI_GATEWAY_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    if (originalGateway === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = originalGateway;
  });

  it('throws when no transcript exists for the project', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-compact-cwd-'));
    dirs.push(cwd);
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;

    await expect(compactTranscript({ cwd })).rejects.toThrow(CompactionError);
    await expect(compactTranscript({ cwd })).rejects.toThrow(/No Claude Code transcript/);
  });

  it('throws when an explicit transcript path is missing', async () => {
    await expect(compactTranscript({ transcript: '/no/such/transcript.jsonl' })).rejects.toThrow(
      /Transcript not found/,
    );
  });

  it('throws when the transcript has no user or assistant messages', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-compact-empty-'));
    dirs.push(cwd);
    const transcript = path.join(cwd, 'empty.jsonl');
    fs.writeFileSync(transcript, '{"type":"summary","summary":"ignored"}\n');

    await expect(compactTranscript({ transcript })).rejects.toThrow(
      /no user or assistant messages/,
    );
  });

  it('throws when neither AI_GATEWAY_API_KEY nor TYPESAFE_API_KEY is set', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-compact-key-'));
    dirs.push(cwd);
    const transcript = path.join(cwd, 'session.jsonl');
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`,
    );
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;

    await expect(compactTranscript({ transcript })).rejects.toThrow(/AI_GATEWAY_API_KEY/);
    await expect(compactTranscript({ transcript })).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(compactTranscript({ transcript })).rejects.toThrow(/not a TypeSafe key/);
    await expect(compactTranscript({ transcript })).rejects.toThrow(
      /Caliber does not provide a key/,
    );
  });

  it('posts Gateway evaluate when a Gateway key is set', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-compact-gw-'));
    dirs.push(cwd);
    const transcript = path.join(cwd, 'session.jsonl');
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'text', text: 'fix it' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'AAAA '.repeat(400) }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'done' }] },
        }),
      ].join('\n'),
    );
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;

    const urls: string[] = [];
    const outcome = await compactTranscript({
      transcript,
      gatewayApiKey: 'gw-test',
      preserveRecentMessages: 0,
      fetch: async (url, init) => {
        urls.push(String(url));
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          questions?: Record<string, unknown>;
        };
        const answers = Object.fromEntries(
          Object.keys(body.questions ?? {}).map((k) => [k, { type: 'boolean', probability: 0 }]),
        );
        return new Response(JSON.stringify({ answers }), { status: 200 });
      },
    });

    expect(urls[0]).toContain('ai-gateway.vercel.sh');
    expect(urls[0]).toContain('evaluation-model');
    expect(outcome.result.stats.requests).toBeGreaterThanOrEqual(1);
  });

  it('surfaces Vercel billing 403 as account config, not a missing Caliber key', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-compact-bill-'));
    dirs.push(cwd);
    const transcript = path.join(cwd, 'session.jsonl');
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'text', text: 'fix it' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'AAAA '.repeat(400) }],
          },
        }),
      ].join('\n'),
    );
    delete process.env.TYPESAFE_API_KEY;

    await expect(
      compactTranscript({
        transcript,
        gatewayApiKey: 'gw-unbilled',
        preserveRecentMessages: 0,
        fetch: async () =>
          new Response('AI Gateway requires a valid credit card on file', { status: 403 }),
      }),
    ).rejects.toThrow(/Vercel account billing/);
  });
});
