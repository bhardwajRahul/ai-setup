import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { compactCommand } from '../compact.js';
import {
  compactTranscript,
  CompactionError,
  WRITE_UNSUPPORTED_CURSOR,
} from '../../compaction/index.js';
import { program } from '../../cli.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../compaction/__tests__/fixtures',
);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function copyFixture(name: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-compact-cmd-'));
  dirs.push(tmp);
  const dest = path.join(tmp, name);
  fs.copyFileSync(path.join(fixtures, name), dest);
  return dest;
}

function dropAllFetch(): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      questions?: Record<string, unknown>;
    };
    const answers = Object.fromEntries(
      Object.keys(body.questions ?? {}).map((k) => [k, { type: 'boolean', probability: 0 }]),
    );
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
}

describe('compact CLI options', () => {
  it('registers --provider and --write', () => {
    const cmd = program.commands.find((c) => c.name() === 'compact');
    expect(cmd?.options.find((o) => o.long === '--provider')).toBeDefined();
    expect(cmd?.options.find((o) => o.long === '--write')).toBeDefined();
    expect(cmd?.options.find((o) => o.long === '--transcript')).toBeDefined();
  });
});

describe('compactCommand', () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalGateway = process.env.AI_GATEWAY_API_KEY;
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    logs.length = 0;
    errors.length = 0;
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    if (originalGateway === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = originalGateway;
    process.exitCode = undefined;
  });

  function capture() {
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
  }

  it('rejects an invalid --provider', async () => {
    capture();
    await compactCommand({ provider: 'grok', transcript: '/nope.jsonl' });
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/auto, claude, cursor, or generic/);
  });

  it('requires --transcript for cursor and generic', async () => {
    await expect(compactTranscript({ provider: 'cursor' })).rejects.toThrow(
      /--transcript is required for --provider cursor/,
    );
    await expect(compactTranscript({ provider: 'generic' })).rejects.toThrow(
      /--transcript is required for --provider generic/,
    );
  });

  it('prints a Cursor report without claiming a /compact toast', async () => {
    const transcript = copyFixture('cursor-session.jsonl');
    delete process.env.TYPESAFE_API_KEY;
    capture();

    await compactCommand({
      provider: 'cursor',
      transcript,
      gatewayKey: 'gw-test',
    });

    expect(process.exitCode).toBeUndefined();
    const text = logs.join('\n');
    expect(text).toMatch(/Jev Compaction/);
    expect(text).toMatch(/provider: cursor/);
    expect(text).toMatch(/no \/compact toast/);
    expect(text).not.toMatch(/Wrote compacted/);
  });

  it('emits provider and writeSupported in --json', async () => {
    const transcript = copyFixture('cursor-session.jsonl');
    capture();

    await compactCommand({
      provider: 'cursor',
      transcript,
      gatewayKey: 'gw-test',
      json: true,
    });

    const payload = JSON.parse(logs.join('\n')) as {
      provider: string;
      wrote: boolean;
      writeSupported: boolean;
    };
    expect(payload).toMatchObject({
      provider: 'cursor',
      wrote: false,
      writeSupported: false,
    });
  });

  it('scores a generic fixture through compactTranscript (fetch substituted)', async () => {
    const transcript = copyFixture('generic-session.jsonl');
    const outcome = await compactTranscript({
      provider: 'generic',
      transcript,
      gatewayApiKey: 'gw-test',
      preserveRecentMessages: 0,
      fetch: dropAllFetch(),
    });

    expect(outcome.provider).toBe('generic');
    expect(outcome.writeSupported).toBe(true);
    expect(outcome.wrote).toBe(false);
    expect(outcome.result.stats.requests).toBeGreaterThanOrEqual(1);
  });

  it('writes a generic transcript and round-trips the compacted file', async () => {
    const transcript = copyFixture('generic-session.jsonl');
    const before = fs.readFileSync(transcript, 'utf-8');

    const outcome = await compactTranscript({
      provider: 'generic',
      transcript,
      write: true,
      gatewayApiKey: 'gw-test',
      preserveRecentMessages: 0,
      fetch: dropAllFetch(),
    });

    expect(outcome.wrote).toBe(true);
    const after = fs.readFileSync(transcript, 'utf-8');
    expect(after).not.toBe(before);

    const again = await compactTranscript({
      provider: 'generic',
      transcript,
      gatewayApiKey: 'gw-test',
      preserveRecentMessages: 0,
      fetch: dropAllFetch(),
    });
    expect(again.messages.length).toBe(outcome.result.messages.length);
    expect(again.messages.map((m) => m.role)).toEqual(outcome.result.messages.map((m) => m.role));
  });

  it('refuses --write for Cursor JSONL', async () => {
    const transcript = copyFixture('cursor-session.jsonl');
    await expect(
      compactTranscript({
        provider: 'cursor',
        transcript,
        write: true,
        gatewayApiKey: 'gw-test',
      }),
    ).rejects.toThrow(CompactionError);
    await expect(
      compactTranscript({
        provider: 'cursor',
        transcript,
        write: true,
        gatewayApiKey: 'gw-test',
      }),
    ).rejects.toThrow(WRITE_UNSUPPORTED_CURSOR);
    expect(fs.readFileSync(transcript, 'utf-8')).toContain('tool_use');
  });

  it('auto-detects the generic fixture', async () => {
    const transcript = copyFixture('generic-session.v1.json');
    const outcome = await compactTranscript({
      provider: 'auto',
      transcript,
      gatewayApiKey: 'gw-test',
      preserveRecentMessages: 6,
      fetch: dropAllFetch(),
    });
    expect(outcome.provider).toBe('generic');
    expect(outcome.writeSupported).toBe(true);
  });

  it('reports Cursor transcripts without calling them writable', async () => {
    const transcript = copyFixture('cursor-session.jsonl');
    const outcome = await compactTranscript({
      provider: 'cursor',
      transcript,
      gatewayApiKey: 'gw-test',
      fetch: dropAllFetch(),
    });
    expect(outcome.provider).toBe('cursor');
    expect(outcome.writeSupported).toBe(false);
    expect(outcome.wrote).toBe(false);
    expect(outcome.result.stats.calls).toBe(0);
  });
});
