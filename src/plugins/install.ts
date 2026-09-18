import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Installs the Claude Code plugins Caliber ships into a project.
 *
 * Claude Code loads a function-hook plugin's modules from disk at runtime, so
 * a plugin cannot be bundled into `dist/bin.js` the way the rest of the CLI is
 * — it has to be materialized as real files inside the project. This copies
 * the shipped plugin into `.claude/plugins/<name>/` and writes the marketplace
 * manifest that lets `claude plugin marketplace add` resolve it.
 *
 * Enabling is deliberately left to Claude Code's own CLI rather than written
 * into settings.json here: the marketplace-registration schema is not part of
 * Claude Code's documented public surface, and guessing at it would produce a
 * settings file that silently does nothing.
 */

export const PLUGIN_NAME = 'fast-jev-compaction';

/** Directory inside a project where Caliber materializes plugins. */
export const PROJECT_PLUGINS_DIR = path.join('.claude', 'plugins');

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
}

export interface InstallResult {
  name: string;
  version: string;
  source: string;
  target: string;
  files: number;
  marketplacePath: string;
}

export class PluginInstallError extends Error {}

/**
 * Finds the shipped plugin directory.
 *
 * Published installs have it next to the bundled `dist/bin.js`; a git checkout
 * has it at `plugin/<name>` after `npm run build:plugin`. Both are checked so
 * the command behaves the same either way.
 */
export function resolveShippedPlugin(name: string = PLUGIN_NAME): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/bin.js -> dist/plugin/<name>
    path.resolve(here, 'plugin', name),
    // src/plugins/install.ts -> <root>/plugin/<name>
    path.resolve(here, '..', '..', 'plugin', name),
    path.resolve(here, '..', '..', 'dist', 'plugin', name),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, '.claude-plugin', 'plugin.json'))) return candidate;
  }
  return null;
}

export function readPluginManifest(pluginDir: string): PluginManifest {
  const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return {
      name: String(parsed.name ?? PLUGIN_NAME),
      version: String(parsed.version ?? '0.0.0'),
      description: String(parsed.description ?? ''),
    };
  } catch (error) {
    throw new PluginInstallError(
      `Could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The marketplace manifest for the project's plugin directory. Mirrors the
 * shape upstream ships, with one entry per materialized plugin.
 */
export function buildMarketplace(plugins: PluginManifest[]): Record<string, unknown> {
  return {
    name: 'caliber',
    owner: { name: 'Caliber', url: 'https://github.com/caliber-ai-org/ai-setup' },
    plugins: plugins.map((plugin) => ({
      name: plugin.name,
      source: `./${plugin.name}`,
      description: plugin.description,
      version: plugin.version,
      license: 'MIT',
    })),
  };
}

function countFiles(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return total;
}

export function installPlugin(dir: string, name: string = PLUGIN_NAME): InstallResult {
  const source = resolveShippedPlugin(name);
  if (!source) {
    throw new PluginInstallError(
      `Plugin "${name}" is not present in this Caliber installation. ` +
        'If you are running from a checkout, run `npm run build:plugin` first.',
    );
  }

  const manifest = readPluginManifest(source);
  if (!fs.existsSync(path.join(source, 'lib'))) {
    throw new PluginInstallError(
      `Plugin "${name}" is missing its lib/ directory. Run \`npm run build:plugin\` to assemble it.`,
    );
  }

  const pluginsRoot = path.join(dir, PROJECT_PLUGINS_DIR);
  const target = path.join(pluginsRoot, name);

  // Replace wholesale: a stale file from an older version left behind in the
  // plugin directory would be loaded by Claude Code alongside the new ones.
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(pluginsRoot, { recursive: true });
  fs.cpSync(source, target, { recursive: true });

  // Rebuild the marketplace from whatever is now installed, so removing one
  // plugin by hand cannot leave a dangling entry behind.
  const installed: PluginManifest[] = [];
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = path.join(pluginsRoot, entry.name);
    if (!fs.existsSync(path.join(candidate, '.claude-plugin', 'plugin.json'))) continue;
    installed.push(readPluginManifest(candidate));
  }

  const marketplaceDir = path.join(pluginsRoot, '.claude-plugin');
  fs.mkdirSync(marketplaceDir, { recursive: true });
  const marketplacePath = path.join(marketplaceDir, 'marketplace.json');
  fs.writeFileSync(marketplacePath, `${JSON.stringify(buildMarketplace(installed), null, 2)}\n`);

  return {
    name: manifest.name,
    version: manifest.version,
    source,
    target,
    files: countFiles(target),
    marketplacePath,
  };
}

export function uninstallPlugin(dir: string, name: string = PLUGIN_NAME): boolean {
  const target = path.join(dir, PROJECT_PLUGINS_DIR, name);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });

  const pluginsRoot = path.join(dir, PROJECT_PLUGINS_DIR);
  const remaining: PluginManifest[] = [];
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = path.join(pluginsRoot, entry.name);
    if (!fs.existsSync(path.join(candidate, '.claude-plugin', 'plugin.json'))) continue;
    remaining.push(readPluginManifest(candidate));
  }

  const marketplacePath = path.join(pluginsRoot, '.claude-plugin', 'marketplace.json');
  if (remaining.length === 0) {
    fs.rmSync(path.join(pluginsRoot, '.claude-plugin'), { recursive: true, force: true });
  } else if (fs.existsSync(marketplacePath)) {
    fs.writeFileSync(marketplacePath, `${JSON.stringify(buildMarketplace(remaining), null, 2)}\n`);
  }
  return true;
}

/** Whether the plugin is materialized in this project. */
export function isPluginInstalled(dir: string, name: string = PLUGIN_NAME): boolean {
  return fs.existsSync(path.join(dir, PROJECT_PLUGINS_DIR, name, '.claude-plugin', 'plugin.json'));
}
