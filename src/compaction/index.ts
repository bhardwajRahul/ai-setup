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
import { findLatestTranscript, readTranscript } from './transcript.js';
import { MISSING_JEV_KEY_MESSAGE, resolveJevCredentials } from './transport.js';

export { findLatestTranscript, parseTranscript, readTranscript } from './transcript.js';
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
 * — finding the transcript, deciding whether a compaction was worth keeping,
 * and reporting it — lives here so `src/vendor/` stays a clean upstream copy.
 */

export const DEFAULT_MIN_REDUCTION = 0.25;

export interface CompactTranscriptOptions {
  /** Explicit transcript path. Falls back to the newest transcript for `cwd`. */
  transcript?: string;
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
  messages: Message[];
  result: CompactResult;
  reduction: number;
  /** True when the reduction cleared `minReduction`. */
  worthwhile: boolean;
}

export class CompactionError extends Error {}

/**
 * Compacts the transcript and reports what would change. This never writes the
 * transcript back: Claude Code owns that file, and a half-written transcript is
 * far worse than a large one.
 */
export async function compactTranscript(
  options: CompactTranscriptOptions = {},
): Promise<CompactTranscriptResult> {
  const cwd = options.cwd ?? process.cwd();
  const transcriptPath = options.transcript ?? findLatestTranscript(cwd);

  if (!transcriptPath) {
    throw new CompactionError(
      `No Claude Code transcript found for ${cwd}. Pass --transcript <path> to choose one.`,
    );
  }

  if (!fs.existsSync(transcriptPath)) {
    throw new CompactionError(`Transcript not found: ${transcriptPath}`);
  }

  const messages = readTranscript(transcriptPath);
  if (messages.length === 0) {
    throw new CompactionError(`Transcript ${transcriptPath} has no user or assistant messages.`);
  }

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

  return {
    transcriptPath,
    messages,
    result,
    reduction,
    worthwhile: reduction >= minReduction,
  };
}
