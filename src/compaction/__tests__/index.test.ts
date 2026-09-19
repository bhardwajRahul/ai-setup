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

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
  });

  it('throws when no transcript exists for the project', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-compact-cwd-'));
    dirs.push(cwd);
    delete process.env.TYPESAFE_API_KEY;

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

  it('throws when TYPESAFE_API_KEY is unset', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-compact-key-'));
    dirs.push(cwd);
    const transcript = path.join(cwd, 'session.jsonl');
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`,
    );
    delete process.env.TYPESAFE_API_KEY;

    await expect(compactTranscript({ transcript })).rejects.toThrow(/TYPESAFE_API_KEY is not set/);
    await expect(compactTranscript({ transcript })).rejects.toThrow(/your own TypeSafe API key/);
    await expect(compactTranscript({ transcript })).rejects.toThrow(
      /Caliber does not provide a key/,
    );
  });
});
