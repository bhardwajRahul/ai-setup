import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  detectTranscriptProvider,
  loadTranscriptFile,
  parseCursorTranscript,
  parseGenericTranscript,
  parseTranscript,
  serializeGenericTranscript,
  writeGenericTranscript,
  GENERIC_TRANSCRIPT_SCHEMA,
  findLatestCursorTranscript,
  cursorTranscriptDir,
} from '../index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('parseCursorTranscript', () => {
  it('parses the in-repo Cursor fixture (role + message, no tool ids or results)', () => {
    const raw = fs.readFileSync(path.join(fixtures, 'cursor-session.jsonl'), 'utf-8');
    const messages = parseCursorTranscript(raw);

    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages[0]).toMatchObject({
      role: 'user',
      text: expect.stringContaining('List the project files'),
    });
    expect(messages[1].toolUses.map((use) => use.tool)).toEqual(['Shell', 'Glob']);
    expect(messages[1].toolUses[0].tool_use_id).toMatch(/^cursor_tool_/);
    expect(messages.some((message) => (message.toolResults ?? []).length > 0)).toBe(false);
  });

  it('skips turn_ended and synthesizes ids only when tool_use has none', () => {
    const jsonl = [
      line({ type: 'turn_ended', status: 'error' }),
      line({
        role: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'real_id', name: 'Read', input: { path: 'a.ts' } }],
        },
      }),
    ].join('\n');

    const messages = parseCursorTranscript(jsonl);
    expect(messages).toHaveLength(1);
    expect(messages[0].toolUses[0].tool_use_id).toBe('real_id');
  });

  it('keeps tool_result when a Cursor file actually has one', () => {
    const jsonl = line({
      role: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
      },
    });
    expect(parseCursorTranscript(jsonl)[0].toolResults?.[0]).toMatchObject({
      tool_use_id: 't1',
      text: 'ok',
    });
  });
});

describe('cursor transcript discovery', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-cursor-home-'));
    dirs.push(home);
  });

  it('finds nested and flat agent-transcripts, newest first', () => {
    const dir = cursorTranscriptDir('/repo', home);
    fs.mkdirSync(path.join(dir, 'nested-id'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'flat.jsonl'), '{"role":"user"}');
    fs.writeFileSync(path.join(dir, 'nested-id', 'nested-id.jsonl'), '{"role":"user"}');
    fs.utimesSync(path.join(dir, 'flat.jsonl'), new Date(0), new Date(0));

    expect(findLatestCursorTranscript('/repo', home)).toBe(
      path.join(dir, 'nested-id', 'nested-id.jsonl'),
    );
  });

  it('returns null when there are no Cursor transcripts', () => {
    expect(findLatestCursorTranscript('/no/such', home)).toBeNull();
  });
});

describe('parseGenericTranscript', () => {
  it('parses caliber.transcript.v1 envelope', () => {
    const raw = fs.readFileSync(path.join(fixtures, 'generic-session.v1.json'), 'utf-8');
    const parsed = parseGenericTranscript(raw);
    expect(parsed.encoding).toBe('envelope');
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[1].toolUses[0].tool).toBe('Calc');
    expect(parsed.messages[2].toolResults?.[0].text).toBe('4');
  });

  it('parses Message JSONL fixture', () => {
    const raw = fs.readFileSync(path.join(fixtures, 'generic-session.jsonl'), 'utf-8');
    const parsed = parseGenericTranscript(raw);
    expect(parsed.encoding).toBe('jsonl');
    expect(parsed.messages[0].text).toContain('Fix the failing test');
    expect(parsed.messages[4].toolResults?.[0].text).toContain('AAAA');
  });

  it('parses an OpenAI-compatible messages array', () => {
    const raw = JSON.stringify([
      { role: 'user', content: 'Fix it' },
      {
        role: 'assistant',
        content: 'Reading',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
      { role: 'assistant', content: 'done' },
    ]);
    const parsed = parseGenericTranscript(raw);
    expect(parsed.encoding).toBe('openai');
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[1].toolUses[0]).toMatchObject({
      tool_use_id: 'call_1',
      tool: 'Read',
      input: { path: 'a.ts' },
    });
    expect(parsed.messages[2].toolResults?.[0].text).toBe('file contents');
  });

  it('round-trips envelope, json-array, jsonl, and openai encodings', () => {
    const original = parseGenericTranscript(
      fs.readFileSync(path.join(fixtures, 'generic-session.v1.json'), 'utf-8'),
    ).messages;

    for (const encoding of ['envelope', 'json-array', 'jsonl', 'openai'] as const) {
      const serialized = serializeGenericTranscript(original, encoding);
      const again = parseGenericTranscript(serialized);
      expect(again.encoding).toBe(encoding);
      expect(again.messages.map((m) => m.role)).toEqual(original.map((m) => m.role));
      expect(again.messages[1].toolUses[0].tool_use_id).toBe('call_1');
      expect(again.messages.some((m) => (m.toolResults ?? []).some((r) => r.text === '4'))).toBe(
        true,
      );
    }
  });

  it('writes atomically and re-reads the same messages', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-generic-write-'));
    dirs.push(tmp);
    const file = path.join(tmp, 'session.json');
    const messages = parseGenericTranscript(
      fs.readFileSync(path.join(fixtures, 'generic-session.v1.json'), 'utf-8'),
    ).messages;

    writeGenericTranscript(file, messages, 'envelope');
    const loaded = loadTranscriptFile(file, 'generic');
    expect(loaded.provider).toBe('generic');
    expect(loaded.supportsWrite).toBe(true);
    expect(loaded.messages).toHaveLength(messages.length);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).schema).toBe(GENERIC_TRANSCRIPT_SCHEMA);
  });
});

describe('detectTranscriptProvider', () => {
  it('detects Claude JSONL from type + message', () => {
    const jsonl = line({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    expect(detectTranscriptProvider(jsonl)).toBe('claude');
    expect(parseTranscript(jsonl)[0].text).toBe('hi');
  });

  it('detects Cursor JSONL from role + message', () => {
    const raw = fs.readFileSync(path.join(fixtures, 'cursor-session.jsonl'), 'utf-8');
    expect(detectTranscriptProvider(raw)).toBe('cursor');
  });

  it('detects generic envelope and JSONL', () => {
    expect(
      detectTranscriptProvider(
        fs.readFileSync(path.join(fixtures, 'generic-session.v1.json'), 'utf-8'),
      ),
    ).toBe('generic');
    expect(
      detectTranscriptProvider(
        fs.readFileSync(path.join(fixtures, 'generic-session.jsonl'), 'utf-8'),
      ),
    ).toBe('generic');
  });

  it('returns null for empty or unknown input', () => {
    expect(detectTranscriptProvider('')).toBeNull();
    expect(detectTranscriptProvider('{"type":"summary","summary":"x"}')).toBeNull();
  });
});
