import fs from 'fs';
import path from 'path';
import type { Message, ToolResult, ToolUse } from '../vendor/caliber-jev-compaction/index.js';
import { parseJsonlObjects } from './transcript.js';

/**
 * Documented generic transcript schema for hosts that are not Claude Code.
 *
 * Caliber cannot rewrite Claude Code or Cursor on-disk transcripts safely.
 * Agents that *do* hold tool results in memory (Cursor, Codex, Grok Bot, …)
 * should export this schema, run `caliber compact --provider generic`, and
 * either `--write` the compacted file or apply the report themselves.
 *
 * ## caliber.transcript.v1
 *
 * Envelope:
 * ```json
 * {
 *   "schema": "caliber.transcript.v1",
 *   "messages": []
 * }
 * ```
 * `messages` is an array of `Message` objects (shape below).
 *
 * Or a bare JSON array of `Message`, or JSONL (one `Message` per line).
 *
 * Each `Message` matches the vendored Jev library:
 * ```json
 * {
 *   "role": "user" | "assistant",
 *   "text": "string",
 *   "toolUses": [
 *     { "tool_use_id": "call_1", "tool": "Read", "input": { "path": "a.ts" } }
 *   ],
 *   "toolResults": [
 *     { "tool_use_id": "call_1", "text": "file contents", "isError": false }
 *   ]
 * }
 * ```
 *
 * `toolUses` defaults to `[]`. `toolResults` may be omitted.
 *
 * ## OpenAI-compatible encoding
 *
 * A JSON array of chat-completions messages is also accepted (Grok Bot–style
 * agents). `role: "tool"` rows become `toolResults` on a user message.
 * `--write` serializes back to the same encoding that was read.
 */

export const GENERIC_TRANSCRIPT_SCHEMA = 'caliber.transcript.v1';

export type GenericEncoding = 'envelope' | 'json-array' | 'jsonl' | 'openai';

export interface ParsedGenericTranscript {
  messages: Message[];
  encoding: GenericEncoding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRole(value: unknown): 'user' | 'assistant' | undefined {
  return value === 'user' || value === 'assistant' ? value : undefined;
}

function asToolInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseArguments(args: unknown): Record<string, unknown> {
  if (isRecord(args)) return args;
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      if (isRecord(parsed)) return parsed;
    } catch {
      /* keep raw */
    }
    return { raw: args };
  }
  return {};
}

function openaiContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!isRecord(block)) return '';
      return typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseVendorMessage(entry: unknown): Message | undefined {
  if (!isRecord(entry)) return undefined;
  const role = asRole(entry.role);
  if (!role) return undefined;
  if (
    typeof entry.text !== 'string' &&
    !Array.isArray(entry.toolUses) &&
    !Array.isArray(entry.toolResults)
  ) {
    return undefined;
  }

  const toolUses: ToolUse[] = [];
  if (Array.isArray(entry.toolUses)) {
    for (const raw of entry.toolUses) {
      if (!isRecord(raw) || typeof raw.tool_use_id !== 'string') continue;
      toolUses.push({
        tool_use_id: raw.tool_use_id,
        tool: typeof raw.tool === 'string' && raw.tool ? raw.tool : 'unknown',
        input: asToolInput(raw.input),
        ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
        ...(raw.isError === true ? { isError: true } : {}),
      });
    }
  }

  const toolResults: ToolResult[] = [];
  if (Array.isArray(entry.toolResults)) {
    for (const raw of entry.toolResults) {
      if (!isRecord(raw) || typeof raw.tool_use_id !== 'string') continue;
      toolResults.push({
        tool_use_id: raw.tool_use_id,
        text: typeof raw.text === 'string' ? raw.text : '',
        ...(raw.isError === true ? { isError: true } : {}),
      });
    }
  }

  const message: Message = {
    role,
    text: typeof entry.text === 'string' ? entry.text : '',
    toolUses,
  };
  if (toolResults.length > 0) message.toolResults = toolResults;
  return message;
}

function parseOpenAIToolCalls(raw: unknown): ToolUse[] {
  if (!Array.isArray(raw)) return [];
  const uses: ToolUse[] = [];
  for (const call of raw) {
    if (!isRecord(call) || typeof call.id !== 'string') continue;
    const fn = isRecord(call.function) ? call.function : {};
    uses.push({
      tool_use_id: call.id,
      tool: typeof fn.name === 'string' && fn.name ? fn.name : 'unknown',
      input: parseArguments(fn.arguments),
    });
  }
  return uses;
}

function parseOpenAIMessages(entries: unknown[]): Message[] {
  const messages: Message[] = [];
  let pendingResults: ToolResult[] = [];

  const flushTools = () => {
    if (pendingResults.length === 0) return;
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: pendingResults });
    pendingResults = [];
  };

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry.role === 'system') continue;

    if (entry.role === 'tool') {
      if (typeof entry.tool_call_id === 'string') {
        pendingResults.push({
          tool_use_id: entry.tool_call_id,
          text: openaiContentText(entry.content),
        });
      }
      continue;
    }

    flushTools();
    const role = asRole(entry.role);
    if (!role) continue;

    const toolUses = parseOpenAIToolCalls(entry.tool_calls);
    const text = openaiContentText(entry.content);
    const message: Message = { role, text, toolUses };
    messages.push(message);
  }

  flushTools();
  return messages;
}

function looksLikeVendorMessage(entry: unknown): boolean {
  return parseVendorMessage(entry) !== undefined;
}

function looksLikeOpenAIMessage(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (entry.role === 'tool' && typeof entry.tool_call_id === 'string') return true;
  if (entry.role === 'system') return true;
  if (entry.role !== 'user' && entry.role !== 'assistant') return false;
  if (looksLikeVendorMessage(entry)) return false;
  return 'content' in entry || 'tool_calls' in entry || 'tool_call_id' in entry;
}

export function isGenericEnvelope(
  value: unknown,
): value is { schema: string; messages: unknown[] } {
  return (
    isRecord(value) && value.schema === GENERIC_TRANSCRIPT_SCHEMA && Array.isArray(value.messages)
  );
}

export function isVendorMessageArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every(looksLikeVendorMessage);
}

export function isOpenAIMessageArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every(looksLikeOpenAIMessage);
}

export function parseGenericTranscript(raw: string): ParsedGenericTranscript {
  const trimmed = raw.trim();
  if (!trimmed) return { messages: [], encoding: 'jsonl' };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isGenericEnvelope(parsed)) {
      return {
        encoding: 'envelope',
        messages: parsed.messages
          .map(parseVendorMessage)
          .filter((message): message is Message => message !== undefined),
      };
    }
    if (isVendorMessageArray(parsed)) {
      return {
        encoding: 'json-array',
        messages: parsed
          .map(parseVendorMessage)
          .filter((message): message is Message => message !== undefined),
      };
    }
    if (
      isOpenAIMessageArray(parsed) ||
      (Array.isArray(parsed) && parsed.some(looksLikeOpenAIMessage))
    ) {
      return {
        encoding: 'openai',
        messages: parseOpenAIMessages(Array.isArray(parsed) ? parsed : []),
      };
    }
  } catch {
    /* JSONL */
  }

  const messages: Message[] = [];
  for (const entry of parseJsonlObjects(trimmed)) {
    const message = parseVendorMessage(entry);
    if (message) messages.push(message);
  }
  return { messages, encoding: 'jsonl' };
}

export function readGenericTranscript(filePath: string): ParsedGenericTranscript {
  return parseGenericTranscript(fs.readFileSync(filePath, 'utf-8'));
}

function toOpenAIMessages(messages: readonly Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const row: Record<string, unknown> = {
        role: 'assistant',
        content: message.text.length > 0 ? message.text : null,
      };
      if (message.toolUses.length > 0) {
        row.tool_calls = message.toolUses.map((use) => ({
          id: use.tool_use_id,
          type: 'function',
          function: { name: use.tool, arguments: JSON.stringify(use.input) },
        }));
      }
      out.push(row);
      continue;
    }

    if (message.text.length > 0) {
      out.push({ role: 'user', content: message.text });
    }
    for (const result of message.toolResults ?? []) {
      out.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: result.text,
      });
    }
    if (message.text.length === 0 && (message.toolResults ?? []).length === 0) {
      out.push({ role: 'user', content: '' });
    }
  }
  return out;
}

export function serializeGenericTranscript(
  messages: readonly Message[],
  encoding: GenericEncoding,
): string {
  if (encoding === 'jsonl') {
    return (
      messages.map((message) => JSON.stringify(message)).join('\n') + (messages.length ? '\n' : '')
    );
  }
  if (encoding === 'openai') {
    return `${JSON.stringify(toOpenAIMessages(messages), null, 2)}\n`;
  }
  if (encoding === 'json-array') {
    return `${JSON.stringify(messages, null, 2)}\n`;
  }
  return `${JSON.stringify({ schema: GENERIC_TRANSCRIPT_SCHEMA, messages }, null, 2)}\n`;
}

/** Write next to the original, then rename, so a crash cannot truncate the file. */
export function atomicWriteFile(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.caliber-tmp`);
  fs.writeFileSync(tmp, contents, 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function writeGenericTranscript(
  filePath: string,
  messages: readonly Message[],
  encoding: GenericEncoding,
): void {
  atomicWriteFile(filePath, serializeGenericTranscript(messages, encoding));
}
