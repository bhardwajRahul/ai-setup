import fs from 'fs';
import {
  compactMessages,
  reductionRatio,
  type CompactResult,
  type Message,
} from '../vendor/caliber-jev-compaction/index.js';
import { findLatestTranscript, readTranscript } from './transcript.js';

export { findLatestTranscript, parseTranscript, readTranscript } from './transcript.js';
export type { CompactResult, Message } from '../vendor/caliber-jev-compaction/index.js';

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
  apiKey?: string;
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

  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new CompactionError(
      'TYPESAFE_API_KEY is not set. Jev compaction needs your own TypeSafe API key ' +
        '(https://typesafe.ai); export TYPESAFE_API_KEY=... and retry. ' +
        'Caliber does not provide a key.',
    );
  }

  const result = await compactMessages(messages, {
    apiKey,
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
    ...(options.model !== undefined ? { model: options.model } : {}),
  });

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
