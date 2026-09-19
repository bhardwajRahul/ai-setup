import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildMarketplace,
  installPlugin,
  isPluginInstalled,
  listPluginRelativeFiles,
  PLUGIN_NAME,
  PluginInstallError,
  readPluginManifest,
  REQUIRED_PLUGIN_FILES,
  resolveShippedPlugin,
  uninstallPlugin,
} from '../install.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-plugin-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveShippedPlugin', () => {
  it('finds the plugin that ships with this checkout', () => {
    const source = resolveShippedPlugin();
    if (source === null) throw new Error('expected a bundled plugin');
    expect(fs.existsSync(path.join(source, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('returns null for a plugin that is not bundled', () => {
    expect(resolveShippedPlugin('no-such-plugin')).toBeNull();
  });
});

describe('buildMarketplace', () => {
  it('points each entry at its own subdirectory', () => {
    const manifest = buildMarketplace([
      { name: 'a', version: '1.0.0', description: 'first' },
      { name: 'b', version: '2.0.0', description: 'second' },
    ]);

    expect(manifest.name).toBe('caliber');
    expect(manifest.plugins).toEqual([
      { name: 'a', source: './a', description: 'first', version: '1.0.0', license: 'MIT' },
      { name: 'b', source: './b', description: 'second', version: '2.0.0', license: 'MIT' },
    ]);
  });
});

describe('installPlugin', () => {
  it('materializes a complete, loadable plugin', () => {
    const result = installPlugin(dir);
    const root = path.join(dir, '.claude', 'plugins', PLUGIN_NAME);

    // The three things Claude Code needs to load a function-hook plugin.
    expect(fs.existsSync(path.join(root, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'hooks', 'hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'hooks', 'compaction.ts'))).toBe(true);
    expect(result.files).toBeGreaterThan(5);
    for (const file of REQUIRED_PLUGIN_FILES) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
      expect(result.fileTree).toContain(file);
    }
  });

  it('dry-run reports the loadable file tree and writes nothing', () => {
    const result = installPlugin(dir, PLUGIN_NAME, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(fs.existsSync(result.target)).toBe(false);
    expect(fs.existsSync(result.marketplacePath)).toBe(false);
    for (const file of REQUIRED_PLUGIN_FILES) {
      expect(result.fileTree).toContain(file);
    }
    expect(result.fileTree).toEqual(listPluginRelativeFiles(result.source));
  });

  it('ships the library and caliber transport the hook imports, so its imports resolve', () => {
    installPlugin(dir);
    const root = path.join(dir, '.claude', 'plugins', PLUGIN_NAME);

    const hook = fs.readFileSync(path.join(root, 'hooks', 'compaction.ts'), 'utf-8');
    const libImported = [...hook.matchAll(/from '\.\.\/lib\/([a-z]+)\.js'/g)].map((m) => m[1]);
    const caliberImported = [...hook.matchAll(/from '\.\.\/caliber\/([a-z]+)\.js'/g)].map(
      (m) => m[1],
    );

    expect(libImported.length).toBeGreaterThan(0);
    expect(caliberImported.sort()).toEqual(['gateway', 'transport']);
    for (const module of libImported) {
      expect(fs.existsSync(path.join(root, 'lib', `${module}.ts`))).toBe(true);
    }
    for (const module of caliberImported) {
      expect(fs.existsSync(path.join(root, 'caliber', `${module}.ts`))).toBe(true);
    }
  });

  it('declares the hook modules that hooks.json lists', () => {
    installPlugin(dir);
    const root = path.join(dir, '.claude', 'plugins', PLUGIN_NAME);
    const { modules } = JSON.parse(
      fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf-8'),
    );

    for (const module of modules) {
      expect(fs.existsSync(path.join(root, 'hooks', path.basename(module)))).toBe(true);
    }
  });

  it('writes a marketplace manifest listing what is installed', () => {
    const result = installPlugin(dir);
    const manifest = JSON.parse(fs.readFileSync(result.marketplacePath, 'utf-8'));

    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.plugins[0]).toMatchObject({
      name: PLUGIN_NAME,
      source: `./${PLUGIN_NAME}`,
    });
  });

  it('is idempotent and leaves no stale files behind', () => {
    installPlugin(dir);
    const stale = path.join(dir, '.claude', 'plugins', PLUGIN_NAME, 'lib', 'removed-upstream.ts');
    fs.writeFileSync(stale, 'export const gone = true;');

    const second = installPlugin(dir);

    expect(fs.existsSync(stale)).toBe(false);
    expect(second.version).toBe(readPluginManifest(second.source).version);
  });

  it('rejects a plugin that is not bundled', () => {
    expect(() => installPlugin(dir, 'no-such-plugin')).toThrow(PluginInstallError);
  });
});

describe('uninstallPlugin', () => {
  it('removes the plugin and its marketplace entry', () => {
    const result = installPlugin(dir);
    expect(isPluginInstalled(dir)).toBe(true);

    expect(uninstallPlugin(dir)).toBe(true);

    expect(isPluginInstalled(dir)).toBe(false);
    expect(fs.existsSync(result.marketplacePath)).toBe(false);
  });

  it('reports false when nothing is installed', () => {
    expect(uninstallPlugin(dir)).toBe(false);
  });
});
