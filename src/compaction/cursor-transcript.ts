import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Message, ToolResult, ToolUse } from '../vendor/caliber-jev-compaction/index.js';
import { blockText, parseJsonlObjects, type ContentBlock } from './transcript.js';

/**
 * Cursor agent transcripts (community-observed, not an official Cursor contract).
 *
 * On disk, local Cursor Agent sessions typically live at:
 *
 *   ~/.cursor/projects/<sanitized-cwd>/agent-transcripts/<session-id>.jsonl
 *   ~/.cursor/projects/<sanitized-cwd>/agent-transcripts/<session-id>/<session-id>.jsonl
 *
 * Rows look like `{ "role": "user"|"assistant", "message": { "content": [...] } }`.
 * Content blocks are `text` and `tool_use`. `tool_use` often has no `id`.
 * `tool_result` is typically absent — Jev therefore has nothing to pair and
 * nothing to drop. Older files may include `{ "type": "turn_ended", ... }`.
 *
 * That is why `--write` is not offered for this format: synthesizing IDs or
 * inserting results would corrupt a host-owned file we cannot round-trip.
 *
 * Sources (2026): Cursor forum sample of `agent-transcripts/` JSONL; community
 * adapters. Layout and fields are unofficial and may change.
 */

/** Cursor slugifies the project path by replacing non-alphanumerics with `-`. */
export function cursorProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function cursorTranscriptDir(cwd: string, home = os.homedir()): string {
  return path.join(home, '.cursor', 'projects', cursorProjectSlug(cwd), 'agent-transcripts');
}

function collectJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    else if (entry.isDirectory()) {
      const nested = path.join(full, `${entry.name}.jsonl`);
      if (fs.existsSync(nested)) found.push(nested);
      else {
        try {
          for (const child of fs.readdirSync(full)) {
            if (child.endsWith('.jsonl')) found.push(path.join(full, child));
          }
        } catch {
          /* ignore unreadable nested dirs */
        }
      }
    }
  }
  return found;
}

/**
 * Newest Cursor agent transcript for `cwd`, or null. Discovery is best-effort
 * (layout is unofficial). The CLI still requires `--transcript` for `--provider
 * cursor` so a guessed path is never silently compacted.
 */
export function findLatestCursorTranscript(cwd: string, home = os.homedir()): string | null {
  const files = collectJsonlFiles(cursorTranscriptDir(cwd, home));
  if (files.length === 0) return null;
  return (
    files
      .map((full) => {
        try {
          return { full, mtime: fs.statSync(full).mtimeMs };
        } catch {
          return { full, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime)[0]?.full ?? null
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (content === undefined) return [];
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/**
 * Parses Cursor agent JSONL. Unknown / control rows (`turn_ended`, …) are
 * skipped. Tool uses without an id get a stable synthetic id so the vendor
 * `Message` shape is valid; they will not be Jev candidates unless a matching
 * `tool_result` is also present (usually it is not).
 */
export function parseCursorTranscript(jsonl: string): Message[] {
  const messages: Message[] = [];
  let synthetic = 0;

  for (const entry of parseJsonlObjects(jsonl)) {
    if (entry.type === 'turn_ended') continue;

    const role = entry.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const message = asRecord(entry.message);
    const blocks = contentBlocks(message?.content);
    if (blocks.length === 0 && message?.content === undefined) continue;

    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    const texts: string[] = [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      } else if (block.type === 'tool_use') {
        const id =
          typeof block.id === 'string' && block.id.length > 0
            ? block.id
            : `cursor_tool_${++synthetic}`;
        const input =
          block.input && typeof block.input === 'object' && !Array.isArray(block.input)
            ? block.input
            : {};
        toolUses.push({
          tool_use_id: id,
          tool: typeof block.name === 'string' && block.name ? block.name : 'unknown',
          input,
        });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolResults.push({
          tool_use_id: block.tool_use_id,
          text: blockText(block.content),
          isError: block.is_error === true,
        });
      }
    }

    const parsed: Message = { role, text: texts.join('\n'), toolUses };
    if (toolResults.length > 0) parsed.toolResults = toolResults;
    messages.push(parsed);
  }

  return messages;
}

export function readCursorTranscript(filePath: string): Message[] {
  return parseCursorTranscript(fs.readFileSync(filePath, 'utf-8'));
}
