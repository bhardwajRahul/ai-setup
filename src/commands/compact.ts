import chalk from 'chalk';
import {
  compactTranscript,
  CompactionError,
  DEFAULT_MIN_REDUCTION,
  isTranscriptProviderOption,
  type TranscriptProviderOption,
} from '../compaction/index.js';

export interface CompactOptions {
  transcript?: string;
  provider?: string;
  write?: boolean;
  threshold?: string;
  preserve?: string;
  truncateHead?: string;
  minReduction?: string;
  maxStateTokens?: string;
  maxRequestTokens?: string;
  model?: string;
  gatewayKey?: string;
  gatewayBaseUrl?: string;
  json?: boolean;
}

function resolveProvider(value: string | undefined): TranscriptProviderOption {
  if (value === undefined || value === '') return 'auto';
  const normalized = value.trim().toLowerCase();
  if (!isTranscriptProviderOption(normalized)) {
    throw new CompactionError('--provider must be auto, claude, cursor, or generic');
  }
  return normalized;
}

function parseNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CompactionError(`--${label} must be a number`);
  return parsed;
}

export async function compactCommand(options: CompactOptions = {}) {
  try {
    const outcome = await compactTranscript({
      transcript: options.transcript,
      provider: resolveProvider(options.provider),
      write: options.write === true,
      keepThreshold: parseNumber(options.threshold, 'threshold'),
      preserveRecentMessages: parseNumber(options.preserve, 'preserve'),
      truncateHeadChars: parseNumber(options.truncateHead, 'truncate-head'),
      minReduction: parseNumber(options.minReduction, 'min-reduction'),
      maxStateTokens: parseNumber(options.maxStateTokens, 'max-state-tokens'),
      maxRequestTokens: parseNumber(options.maxRequestTokens, 'max-request-tokens'),
      ...(options.model ? { model: options.model } : {}),
      ...(options.gatewayKey ? { gatewayApiKey: options.gatewayKey } : {}),
      ...(options.gatewayBaseUrl ? { gatewayBaseUrl: options.gatewayBaseUrl } : {}),
    });

    const { result, reduction, worthwhile, transcriptPath, provider, wrote, writeSupported } =
      outcome;
    const minReduction =
      parseNumber(options.minReduction, 'min-reduction') ?? DEFAULT_MIN_REDUCTION;

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            transcript: transcriptPath,
            provider,
            wrote,
            writeSupported,
            reduction,
            worthwhile,
            stats: result.stats,
            decisions: result.decisions,
          },
          null,
          2,
        ),
      );
      return;
    }

    const { stats } = result;
    console.log(chalk.bold('\nJev Compaction\n'));
    console.log(chalk.dim(`  ${transcriptPath}`));
    console.log(chalk.dim(`  provider: ${provider}${wrote ? '  (wrote compacted file)' : ''}\n`));
    console.log(`  Messages:  ${stats.messagesBefore} -> ${stats.messagesAfter}`);
    console.log(
      `  Chars:     ${stats.charsBefore.toLocaleString()} -> ${stats.charsAfter.toLocaleString()}` +
        chalk.dim(`  (${(reduction * 100).toFixed(1)}% smaller)`),
    );
    console.log(
      `  Calls:     ${stats.calls} scored — ` +
        `${chalk.green(`${stats.kept} kept`)}, ` +
        `${chalk.yellow(`${stats.resultsDropped} results dropped`)}, ` +
        `${chalk.red(`${stats.callsDropped} calls dropped`)}, ` +
        chalk.dim(`${stats.pinned} pinned`),
    );
    console.log(chalk.dim(`  ${stats.requests} Jev request(s), ${stats.ms}ms\n`));

    if (worthwhile) {
      console.log(chalk.green('  Worth compacting — everything kept stays verbatim.'));
    } else {
      console.log(
        chalk.yellow(
          `  Below the ${Math.round(minReduction * 100)}% threshold — not worth compacting this session.`,
        ),
      );
    }

    if (wrote) {
      console.log(chalk.green(`  Wrote compacted transcript to ${transcriptPath}\n`));
    } else if (provider !== 'claude') {
      console.log(
        chalk.dim(
          '  Cursor / Grok Bot / Codex have no /compact toast unless the host adds a hook. ' +
            (writeSupported
              ? 'Re-run with --write to replace a generic transcript, or apply the decisions in-session.\n'
              : 'This format is report-only — apply the decisions in-session or export caliber.transcript.v1.\n'),
        ),
      );
    } else {
      console.log('');
    }
  } catch (error) {
    if (error instanceof CompactionError) {
      console.error(chalk.red(`\n${error.message}\n`));
      process.exitCode = 1;
      return;
    }
    console.error(
      chalk.red(`\nCompaction failed: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    process.exitCode = 1;
  }
}
