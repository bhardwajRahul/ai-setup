import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Message, ToolResult, ToolUse } from '../vendor/caliber-jev-compaction/index.js';

/**
 * Reads Claude Code session transcripts (JSONL) into the `Message` shape the
 * vendored compaction library expects.
 *
 * Claude Code writes one JSON object per line under
 * `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`. Lines that are not
 * user/assistant turns (summaries, meta events, file-history entries) are
 * skipped rather than guessed at.
 */

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Claude Code slugifies the project path by replacing non-alphanumerics with `-`. */
export function projectTranscriptDir(cwd: string, home = os.homedir()): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', slug);
}

/** The most recently modified transcript for `cwd`, or null when there is none. */
export function findLatestTranscript(cwd: string, home = os.homedir()): string | null {
  const dir = projectTranscriptDir(cwd, home);
  if (!fs.existsSync(dir)) return null;

  try {
    const candidates = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.full ?? null;
  } catch {
    return null;
  }
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' ? ((block as ContentBlock).text ?? '') : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** Parses transcript JSONL text into messages, ignoring lines it cannot model. */
export function parseTranscript(jsonl: string): Message[] {
  const messages: Message[] = [];

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const role = entry.type;
    if (role !== 'user' && role !== 'assistant') continue;

    const message = entry.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (content === undefined) continue;

    const blocks: ContentBlock[] = Array.isArray(content)
      ? (content as ContentBlock[])
      : [{ type: 'text', text: String(content) }];

    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    const texts: string[] = [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      } else if (block.type === 'tool_use' && block.id) {
        toolUses.push({
          tool_use_id: block.id,
          tool: block.name ?? 'unknown',
          input: block.input ?? {},
        });
      } else if (block.type === 'tool_result' && block.tool_use_id) {
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

export function readTranscript(filePath: string): Message[] {
  return parseTranscript(fs.readFileSync(filePath, 'utf-8'));
}
