import chalk from 'chalk';
import path from 'path';
import {
  installPlugin,
  isPluginInstalled,
  PLUGIN_NAME,
  PluginInstallError,
  PROJECT_PLUGINS_DIR,
  readPluginManifest,
  resolveShippedPlugin,
  uninstallPlugin,
} from '../plugins/install.js';

function rel(dir: string, filePath: string): string {
  return path.relative(dir, filePath).split(path.sep).join('/');
}

/** Printed after materializing the plugin. The key is always the user's. */
export function pluginEnableInstructions(): string[] {
  const marketplace = `./${PROJECT_PLUGINS_DIR.replace(/\\/g, '/')}`;
  const pluginDir = `${marketplace}/${PLUGIN_NAME}`;
  return [
    chalk.bold('\n  Enable it in Claude Code:\n'),
    chalk.dim('    # Function hooks are an early-access surface and are off by default.'),
    chalk.dim(
      '    # Bring your own TypeSafe key (https://typesafe.ai) — Caliber does not provide one.',
    ),
    chalk.dim('    # Leave the install prompt blank to use TYPESAFE_API_KEY from the environment.'),
    '    export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1',
    '    export TYPESAFE_API_KEY=...',
    `    claude plugin marketplace add ${marketplace}`,
    `    claude plugin install ${PLUGIN_NAME}@caliber`,
    chalk.dim('\n  Or, without installing, for a single session:'),
    chalk.dim(`    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ${pluginDir}\n`),
  ];
}

export async function pluginListCommand(options: { json?: boolean } = {}) {
  const dir = process.cwd();
  const source = resolveShippedPlugin();
  const manifest = source ? readPluginManifest(source) : null;
  const installed = isPluginInstalled(dir);

  if (options.json) {
    console.log(JSON.stringify({ plugins: manifest ? [{ ...manifest, installed }] : [] }, null, 2));
    return;
  }

  console.log(chalk.bold('\nCaliber Plugins\n'));
  if (!manifest) {
    console.log(chalk.yellow('  No plugins are bundled with this Caliber installation.\n'));
    return;
  }

  const state = installed ? chalk.green('installed') : chalk.dim('not installed');
  console.log(`  ${chalk.bold(manifest.name)} ${chalk.dim(`v${manifest.version}`)}  ${state}`);
  console.log(chalk.dim(`    ${manifest.description}`));
  if (!installed) {
    console.log(chalk.dim(`\n  Install with: caliber plugin install`));
  }
  console.log();
}

export async function pluginInstallCommand(options: { json?: boolean } = {}) {
  const dir = process.cwd();

  try {
    const result = installPlugin(dir);

    if (options.json) {
      console.log(
        JSON.stringify(
          { ...result, source: rel(dir, result.source), target: rel(dir, result.target) },
          null,
          2,
        ),
      );
      return;
    }

    console.log(chalk.bold(`\nInstalled ${result.name} v${result.version}\n`));
    console.log(
      `  ${chalk.green('wrote')}  ${rel(dir, result.target)}/ ${chalk.dim(`(${result.files} files)`)}`,
    );
    console.log(`  ${chalk.green('wrote')}  ${rel(dir, result.marketplacePath)}`);

    for (const line of pluginEnableInstructions()) console.log(line);
  } catch (error) {
    if (error instanceof PluginInstallError) {
      console.error(chalk.red(`\n${error.message}\n`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

export async function pluginUninstallCommand() {
  const dir = process.cwd();
  const removed = uninstallPlugin(dir);

  if (!removed) {
    console.log(chalk.dim(`\n  ${PLUGIN_NAME} is not installed in this project.\n`));
    return;
  }

  console.log(chalk.bold(`\nRemoved ${PLUGIN_NAME}\n`));
  console.log(
    chalk.dim(
      `  Claude Code may still list it — run: claude plugin uninstall ${PLUGIN_NAME}@caliber\n`,
    ),
  );
}
