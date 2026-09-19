import chalk from 'chalk';
import path from 'path';
import { isCaliberRunning } from '../lib/lock.js';
import { displayCaliberName } from '../lib/resolve-caliber.js';
import { detectProviders, getAdapter } from '../sync/adapters.js';
import { BUILTIN_PLUGINS } from '../sync/plugins.js';
import { pickSource, sync, type SyncResult } from '../sync/reconcile.js';
import { PROVIDER_IDS, type ProviderId } from '../sync/types.js';

export interface SyncOptions {
  from?: string;
  to?: string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  quiet?: boolean;
  noPlugins?: boolean;
}

function parseProvider(value: string): ProviderId {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, ProviderId> = {
    claude: 'claude',
    'claude-code': 'claude',
    cursor: 'cursor',
    codex: 'codex',
    opencode: 'opencode',
    copilot: 'github-copilot',
    'github-copilot': 'github-copilot',
  };
  const id = aliases[normalized];
  if (!id) {
    throw new Error(
      `Unknown provider "${value}". Expected one of: ${PROVIDER_IDS.join(', ')} (or "copilot").`,
    );
  }
  return id;
}

function rel(dir: string, filePath: string): string {
  return path.relative(dir, filePath).split(path.sep).join('/');
}

function printHuman(result: SyncResult, dir: string): void {
  const bin = displayCaliberName();

  if (!result.source) {
    console.log(chalk.yellow('\nNo agent providers detected in this project.'));
    console.log(chalk.dim(`  Run ${bin} init to set one up first.\n`));
    return;
  }

  const sourceLabel = getAdapter(result.source).label;
  console.log(chalk.bold(`\nCaliber Sync${result.dryRun ? chalk.dim(' (dry run)') : ''}\n`));
  console.log(`  Source: ${chalk.green(sourceLabel)} — ${result.items.length} item(s)`);

  if (result.targets.length === 0) {
    console.log(chalk.dim('  No other providers detected — nothing to sync to.\n'));
    return;
  }

  console.log(`  Targets: ${result.targets.map((id) => getAdapter(id).label).join(', ')}\n`);

  for (const file of result.written) {
    console.log(`  ${chalk.green(result.dryRun ? 'would write' : 'wrote')}  ${rel(dir, file)}`);
  }
  if (result.unchanged.length > 0) {
    console.log(chalk.dim(`  ${result.unchanged.length} file(s) already up to date`));
  }

  for (const conflict of result.conflicts) {
    console.log(`  ${chalk.yellow('conflict')}   ${rel(dir, conflict.path)}`);
    console.log(chalk.dim(`             ${conflict.reason}`));
  }

  for (const skip of result.skipped) {
    console.log(chalk.dim(`  skipped    ${skip.item} for ${skip.provider} — ${skip.reason}`));
  }

  if (result.written.length === 0 && result.conflicts.length === 0) {
    console.log(chalk.dim('\n  Everything already in sync.'));
  }
  console.log();
}

export async function syncCommand(options: SyncOptions = {}) {
  const dir = process.cwd();

  // A refresh or another sync mid-flight owns these files; bail rather than race it.
  if (options.quiet && isCaliberRunning()) return;

  let from: ProviderId | undefined;
  let to: ProviderId[] | undefined;
  try {
    from = options.from ? parseProvider(options.from) : undefined;
    to = options.to ? options.to.split(',').map(parseProvider) : undefined;
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
    return;
  }

  const result = sync({
    dir,
    from,
    to,
    dryRun: options.dryRun,
    force: options.force,
    extraItems: options.noPlugins ? [] : BUILTIN_PLUGINS,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          source: result.source,
          targets: result.targets,
          items: result.items.map((i) => ({ kind: i.kind, name: i.name })),
          written: result.written.map((f) => rel(dir, f)),
          unchanged: result.unchanged.map((f) => rel(dir, f)),
          conflicts: result.conflicts.map((c) => ({ ...c, path: rel(dir, c.path) })),
          skipped: result.skipped,
          dryRun: result.dryRun,
        },
        null,
        2,
      ),
    );
  } else if (options.quiet) {
    if (result.written.length > 0) {
      console.log(`Caliber: synced ${result.written.length} file(s) across agents`);
    }
  } else {
    printHuman(result, dir);
  }

  if (result.conflicts.length > 0) process.exitCode = 1;
}

/** `caliber sync --status`: what each provider holds, without writing anything. */
export async function syncStatusCommand(options: { json?: boolean } = {}) {
  const dir = process.cwd();
  const detected = detectProviders(dir);
  const source = pickSource(dir);

  const rows = detected.map((adapter) => {
    const items = adapter.read(dir);
    return {
      provider: adapter.id,
      label: adapter.label,
      isSource: adapter.id === source,
      skills: items.filter((i) => i.kind === 'skill').length,
      rules: items.filter((i) => i.kind === 'rule').length,
      mcp: items.filter((i) => i.kind === 'mcp').length,
    };
  });

  if (options.json) {
    console.log(JSON.stringify({ source, providers: rows }, null, 2));
    return;
  }

  console.log(chalk.bold('\nCaliber Sync Status\n'));
  if (rows.length === 0) {
    console.log(chalk.dim('  No agent providers detected in this project.\n'));
    return;
  }

  for (const row of rows) {
    const marker = row.isSource ? chalk.green(' (source)') : '';
    console.log(
      `  ${row.label.padEnd(16)}${marker}\n` +
        chalk.dim(`    skills ${row.skills}  rules ${row.rules}  mcp ${row.mcp}`),
    );
  }
  console.log();
}
