import fs from 'fs';
import {
  compact,
  compactMessages,
  reductionRatio,
  type CompactResult,
  type JevAsker,
  type Message,
} from '../vendor/caliber-jev-compaction/index.js';
import { createGatewayAsker } from './gateway.js';
import { findLatestTranscript } from './transcript.js';
import {
  loadTranscriptFile,
  type TranscriptProvider,
  type TranscriptProviderOption,
} from './detect-transcript.js';
import { writeGenericTranscript } from './generic-transcript.js';
import { MISSING_JEV_KEY_MESSAGE, resolveJevCredentials } from './transport.js';

export { findLatestTranscript, parseTranscript, readTranscript } from './transcript.js';
export {
  detectTranscriptProvider,
  isTranscriptProviderOption,
  loadTranscriptFile,
  loadTranscriptText,
  parseTranscriptAs,
  TRANSCRIPT_PROVIDERS,
} from './detect-transcript.js';
export type { TranscriptProvider, TranscriptProviderOption } from './detect-transcript.js';
export {
  cursorTranscriptDir,
  findLatestCursorTranscript,
  parseCursorTranscript,
  readCursorTranscript,
} from './cursor-transcript.js';
export {
  GENERIC_TRANSCRIPT_SCHEMA,
  parseGenericTranscript,
  readGenericTranscript,
  serializeGenericTranscript,
  writeGenericTranscript,
} from './generic-transcript.js';
export type { GenericEncoding, ParsedGenericTranscript } from './generic-transcript.js';
export type { CompactResult, Message } from '../vendor/caliber-jev-compaction/index.js';
export {
  buildGatewayJevRequest,
  createGatewayAsker,
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_GATEWAY_MODEL,
  GATEWAY_BILLING_ERROR_MESSAGE,
  gatewayEvaluationUrl,
  gatewayModelId,
  isGatewayBillingError,
  parseGatewayJevResponse,
} from './gateway.js';
export {
  MISSING_JEV_KEY_MESSAGE,
  resolveJevCredentials,
  type JevTransportKind,
  type ResolvedJevCredentials,
} from './transport.js';

/**
 * Caliber's wrapper around the vendored caliber-jev-compaction library.
 *
 * The library itself is provider-agnostic and pure; everything Caliber-specific
 * — finding the transcript, adapting host formats, deciding whether a
 * compaction was worth keeping, and optionally writing a generic file back —
 * lives here so `src/vendor/` stays a clean upstream copy.
 */

export const DEFAULT_MIN_REDUCTION = 0.25;

export interface CompactTranscriptOptions {
  /** Explicit transcript path. Falls back to the newest Claude Code transcript for `cwd`. */
  transcript?: string;
  /**
   * `auto` detects Claude / Cursor / generic from the file.
   * Claude without `--transcript` still auto-discovers `~/.claude/projects/…`.
   * Cursor and generic require an explicit path.
   */
  provider?: TranscriptProviderOption;
  /**
   * Write compacted messages back. Only the documented generic schema has a
   * proven round-trip; Claude Code and Cursor own their files.
   */
  write?: boolean;
  cwd?: string;
  /** Below this reduction ratio the result is reported but marked not worth applying. */
  minReduction?: number;
  /** Passed through to the library / Jev client. */
  keepThreshold?: number;
  preserveRecentMessages?: number;
  truncateHeadChars?: number;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  model?: string;
  /** Explicit TypeSafe System One key. A Vercel Gateway key will 401 here. */
  apiKey?: string;
  /** Explicit Vercel AI Gateway key. This is not a TypeSafe key. */
  gatewayApiKey?: string;
  /** Override the Gateway evaluation prefix (`https://ai-gateway.vercel.sh/v4/ai`). */
  gatewayBaseUrl?: string;
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
}

export interface CompactTranscriptResult {
  transcriptPath: string;
  provider: TranscriptProvider;
  messages: Message[];
  result: CompactResult;
  reduction: number;
  /** True when the reduction cleared `minReduction`. */
  worthwhile: boolean;
  /** True when `--write` ran and the generic file was replaced. */
  wrote: boolean;
  writeSupported: boolean;
}

export class CompactionError extends Error {}

export const WRITE_UNSUPPORTED_CLAUDE =
  'Claude Code owns the session transcript. caliber compact never rewrites it — ' +
  'a half-written file is worse than a large one. Use the caliber-jev-compaction ' +
  'plugin for in-session replacement.';

export const WRITE_UNSUPPORTED_CURSOR =
  "Cursor's agent-transcripts JSONL is unofficial and incomplete (tool_use often " +
  'has no id; tool_result is typically absent). Rewriting it would invent IDs and ' +
  'drop host-only fields. Export caliber.transcript.v1 and pass --provider generic, ' +
  'or apply the report in-session.';

export const UNRECOGNIZED_TRANSCRIPT_MESSAGE =
  'Unrecognized transcript format. Use --provider claude|cursor|generic, or pass a ' +
  'caliber.transcript.v1 / OpenAI-compatible JSON file. See README "Agents beyond Claude Code".';

function writeUnsupportedMessage(provider: TranscriptProvider): string {
  if (provider === 'cursor') return WRITE_UNSUPPORTED_CURSOR;
  return WRITE_UNSUPPORTED_CLAUDE;
}

/**
 * Compacts the transcript and reports what would change.
 *
 * Writes back only for the documented generic schema (`--write`). Claude Code
 * and Cursor own their on-disk files; a half-written host transcript is worse
 * than a large one.
 */
export async function compactTranscript(
  options: CompactTranscriptOptions = {},
): Promise<CompactTranscriptResult> {
  const cwd = options.cwd ?? process.cwd();
  const provider = options.provider ?? 'auto';
  const needsExplicitPath = provider === 'cursor' || provider === 'generic';

  if (needsExplicitPath && !options.transcript) {
    throw new CompactionError(
      `--transcript is required for --provider ${provider}. ` +
        (provider === 'cursor'
          ? 'Cursor agent JSONL is not auto-discovered (layout is unofficial).'
          : 'Pass a caliber.transcript.v1 or OpenAI-compatible JSON file.'),
    );
  }

  const transcriptPath = options.transcript ?? findLatestTranscript(cwd);

  if (!transcriptPath) {
    throw new CompactionError(
      `No Claude Code transcript found for ${cwd}. Pass --transcript <path> to choose one.`,
    );
  }

  if (!fs.existsSync(transcriptPath)) {
    throw new CompactionError(`Transcript not found: ${transcriptPath}`);
  }

  const loaded = loadTranscriptFile(transcriptPath, provider);
  if (loaded.messages.length === 0) {
    const hint = provider === 'auto' ? ` ${UNRECOGNIZED_TRANSCRIPT_MESSAGE}` : '';
    throw new CompactionError(
      `Transcript ${transcriptPath} has no user or assistant messages.${hint}`,
    );
  }

  if (options.write && !loaded.supportsWrite) {
    throw new CompactionError(writeUnsupportedMessage(loaded.provider));
  }

  const messages = loaded.messages;

  const creds = resolveJevCredentials({
    apiKey: options.apiKey,
    gatewayApiKey: options.gatewayApiKey,
    gatewayBaseUrl: options.gatewayBaseUrl,
    model: options.model,
  });
  if (!creds) {
    throw new CompactionError(MISSING_JEV_KEY_MESSAGE);
  }

  const compactOpts = {
    ...(options.keepThreshold !== undefined ? { keepThreshold: options.keepThreshold } : {}),
    ...(options.preserveRecentMessages !== undefined
      ? { preserveRecentMessages: options.preserveRecentMessages }
      : {}),
    ...(options.truncateHeadChars !== undefined
      ? { truncateHeadChars: options.truncateHeadChars }
      : {}),
    ...(options.maxStateTokens !== undefined ? { maxStateTokens: options.maxStateTokens } : {}),
    ...(options.maxRequestTokens !== undefined
      ? { maxRequestTokens: options.maxRequestTokens }
      : {}),
    ...(creds.model !== undefined ? { model: creds.model } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };

  const result =
    creds.kind === 'gateway'
      ? await compact(
          messages,
          createGatewayAsker({
            apiKey: creds.apiKey,
            model: creds.model,
            baseUrl: creds.baseUrl,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          }) as JevAsker,
          compactOpts,
        )
      : await compactMessages(messages, { apiKey: creds.apiKey, ...compactOpts });

  const reduction = reductionRatio(result);
  const minReduction = options.minReduction ?? DEFAULT_MIN_REDUCTION;

  let wrote = false;
  if (options.write && loaded.supportsWrite && loaded.encoding) {
    writeGenericTranscript(transcriptPath, result.messages, loaded.encoding);
    wrote = true;
  }

  return {
    transcriptPath,
    provider: loaded.provider,
    messages,
    result,
    reduction,
    worthwhile: reduction >= minReduction,
    wrote,
    writeSupported: loaded.supportsWrite,
  };
}
