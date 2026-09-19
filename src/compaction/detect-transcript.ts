import fs from 'fs';
import {
  isGenericEnvelope,
  isOpenAIMessageArray,
  isVendorMessageArray,
  parseGenericTranscript,
  type GenericEncoding,
} from './generic-transcript.js';
import { parseCursorTranscript } from './cursor-transcript.js';
import { parseJsonlObjects, parseTranscript } from './transcript.js';
import type { Message } from '../vendor/caliber-jev-compaction/index.js';

export const TRANSCRIPT_PROVIDERS = ['auto', 'claude', 'cursor', 'generic'] as const;
export type TranscriptProviderOption = (typeof TRANSCRIPT_PROVIDERS)[number];
export type TranscriptProvider = Exclude<TranscriptProviderOption, 'auto'>;

export interface LoadedTranscript {
  provider: TranscriptProvider;
  messages: Message[];
  encoding?: GenericEncoding;
  supportsWrite: boolean;
}

export function isTranscriptProviderOption(value: string): value is TranscriptProviderOption {
  return (TRANSCRIPT_PROVIDERS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isClaudeEntry(entry: Record<string, unknown>): boolean {
  return (
    (entry.type === 'user' || entry.type === 'assistant') &&
    isRecord(entry.message) &&
    entry.message.content !== undefined
  );
}

function isCursorEntry(entry: Record<string, unknown>): boolean {
  return (
    (entry.role === 'user' || entry.role === 'assistant') &&
    isRecord(entry.message) &&
    !isClaudeEntry(entry)
  );
}

function isGenericJsonlEntry(entry: Record<string, unknown>): boolean {
  return (
    (entry.role === 'user' || entry.role === 'assistant') &&
    (typeof entry.text === 'string' ||
      Array.isArray(entry.toolUses) ||
      Array.isArray(entry.toolResults))
  );
}

/**
 * Classifies transcript text. Returns null when nothing recognizable is found
 * (empty input, only control rows, or an unknown shape).
 */
export function detectTranscriptProvider(raw: string): TranscriptProvider | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isGenericEnvelope(parsed) || isVendorMessageArray(parsed) || isOpenAIMessageArray(parsed)) {
      return 'generic';
    }
    if (isRecord(parsed)) {
      if (isClaudeEntry(parsed)) return 'claude';
      if (isCursorEntry(parsed)) return 'cursor';
      if (isGenericJsonlEntry(parsed)) return 'generic';
    }
  } catch {
    /* JSONL or invalid JSON */
  }

  for (const entry of parseJsonlObjects(trimmed)) {
    if (isClaudeEntry(entry)) return 'claude';
    if (isGenericJsonlEntry(entry)) return 'generic';
    if (isCursorEntry(entry)) return 'cursor';
  }

  return null;
}

export function parseTranscriptAs(raw: string, provider: TranscriptProvider): LoadedTranscript {
  if (provider === 'claude') {
    return { provider, messages: parseTranscript(raw), supportsWrite: false };
  }
  if (provider === 'cursor') {
    return { provider, messages: parseCursorTranscript(raw), supportsWrite: false };
  }
  const parsed = parseGenericTranscript(raw);
  return {
    provider: 'generic',
    messages: parsed.messages,
    encoding: parsed.encoding,
    supportsWrite: true,
  };
}

export function loadTranscriptText(
  raw: string,
  provider: TranscriptProviderOption = 'auto',
): LoadedTranscript {
  if (provider !== 'auto') return parseTranscriptAs(raw, provider);

  const detected = detectTranscriptProvider(raw);
  if (!detected) {
    return { provider: 'claude', messages: [], supportsWrite: false };
  }
  return parseTranscriptAs(raw, detected);
}

export function loadTranscriptFile(
  filePath: string,
  provider: TranscriptProviderOption = 'auto',
): LoadedTranscript {
  return loadTranscriptText(fs.readFileSync(filePath, 'utf-8'), provider);
}
