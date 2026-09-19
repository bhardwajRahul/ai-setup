import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findLatestTranscript, parseTranscript, projectTranscriptDir } from '../transcript.js';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('parseTranscript', () => {
  it('parses user text, assistant tool_use and the matching tool_result', () => {
    const jsonl = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Fix the test' }] } }),
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading the file' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }],
        },
      }),
    ].join('\n');

    const messages = parseTranscript(jsonl);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: 'user', text: 'Fix the test', toolUses: [] });
    expect(messages[1].toolUses[0]).toMatchObject({
      tool_use_id: 'toolu_1',
      tool: 'Read',
      input: { file_path: 'a.ts' },
    });
    expect(messages[2].toolResults?.[0]).toMatchObject({
      tool_use_id: 'toolu_1',
      text: 'file contents',
    });
  });

  it('flattens array-shaped tool_result content', () => {
    const jsonl = line({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
      },
    });

    expect(parseTranscript(jsonl)[0].toolResults?.[0].text).toBe('line one\nline two');
  });

  it('marks error results', () => {
    const jsonl = line({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
      },
    });

    expect(parseTranscript(jsonl)[0].toolResults?.[0].isError).toBe(true);
  });

  it('skips summaries, meta events and malformed lines rather than guessing', () => {
    const jsonl = [
      line({ type: 'summary', summary: 'ignored' }),
      line({ type: 'file-history-snapshot', messageId: 'x' }),
      '{ not json',
      '',
      line({ type: 'user', message: { content: [{ type: 'text', text: 'kept' }] } }),
    ].join('\n');

    const messages = parseTranscript(jsonl);

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('kept');
  });

  it('handles a plain string message body', () => {
    const jsonl = line({ type: 'user', message: { content: 'just a string' } });
    expect(parseTranscript(jsonl)[0].text).toBe('just a string');
  });

  it('returns an empty list for empty input', () => {
    expect(parseTranscript('')).toEqual([]);
  });
});

describe('transcript discovery', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-home-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('slugifies the project path the way Claude Code does', () => {
    expect(projectTranscriptDir('/Users/me/my repo', home)).toBe(
      path.join(home, '.claude', 'projects', '-Users-me-my-repo'),
    );
  });

  it('returns null when the project has no transcripts', () => {
    expect(findLatestTranscript('/no/such/project', home)).toBeNull();
  });

  it('returns the most recently modified transcript', () => {
    const dir = projectTranscriptDir('/repo', home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'new.jsonl'), '');
    fs.utimesSync(path.join(dir, 'old.jsonl'), new Date(0), new Date(0));

    expect(findLatestTranscript('/repo', home)).toBe(path.join(dir, 'new.jsonl'));
  });
});
