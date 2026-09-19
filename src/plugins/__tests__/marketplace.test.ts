import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_OPTIONS } from '../../vendor/caliber-jev-compaction/compact.js';
import { DEFAULT_MODEL } from '../../vendor/caliber-jev-compaction/request.js';

/**
 * The repo root is a Claude Code plugin marketplace, so the whole repo installs
 * with `claude plugin marketplace add caliber-ai-org/ai-setup`. These lock the
 * two facts a bad edit would silently break: the marketplace points at the real
 * plugin directory, and its version matches the plugin manifest.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));
}

describe('root plugin marketplace', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json') as {
    name: string;
    plugins: Array<{ name: string; source: string; version: string }>;
  };

  it('declares the caliber marketplace with the caliber-jev-compaction plugin', () => {
    expect(marketplace.name).toBe('caliber');
    expect(marketplace.plugins.map((p) => p.name)).toContain('caliber-jev-compaction');
  });

  it('points each entry at a real plugin directory', () => {
    for (const entry of marketplace.plugins) {
      const manifest = path.join(root, entry.source, '.claude-plugin', 'plugin.json');
      expect(fs.existsSync(manifest), `${entry.source} has no plugin.json`).toBe(true);
    }
  });

  it('keeps each entry version in step with its plugin manifest', () => {
    for (const entry of marketplace.plugins) {
      const manifest = readJson(path.join(entry.source, '.claude-plugin', 'plugin.json')) as {
        version: string;
      };
      expect(entry.version, `${entry.name} version`).toBe(manifest.version);
    }
  });
});

describe('plugin userConfig defaults', () => {
  const plugin = readJson('plugin/caliber-jev-compaction/.claude-plugin/plugin.json') as {
    userConfig: Record<string, { default?: number | string }>;
  };

  it("asks for the user's own TypeSafe key and never defaults one", () => {
    const apiKey = plugin.userConfig.apiKey as {
      default?: unknown;
      sensitive?: boolean;
      description?: string;
    };
    expect(apiKey.default, 'a default would imply Caliber ships a key').toBeUndefined();
    expect(apiKey.sensitive).toBe(true);
    expect(apiKey.description).toMatch(/your own TypeSafe API key/i);
    expect(apiKey.description).toMatch(/TYPESAFE_API_KEY/);
    expect(apiKey.description).toMatch(/Caliber does not provide a key/);
  });

  it('matches the vendored library and hook defaults', () => {
    expect(plugin.userConfig.keepThreshold?.default).toBe(DEFAULT_OPTIONS.keepThreshold);
    expect(plugin.userConfig.preserveRecentMessages?.default).toBe(
      DEFAULT_OPTIONS.preserveRecentMessages,
    );
    expect(plugin.userConfig.maxStateTokens?.default).toBe(DEFAULT_OPTIONS.maxStateTokens);
    expect(plugin.userConfig.maxRequestTokens?.default).toBe(DEFAULT_OPTIONS.maxRequestTokens);
    expect(plugin.userConfig.truncateHeadChars?.default).toBe(DEFAULT_OPTIONS.truncateHeadChars);
    expect(plugin.userConfig.model?.default).toBe(DEFAULT_MODEL);
    expect(plugin.userConfig.compactAtPercent?.default).toBe(60);
    expect(plugin.userConfig.minReductionRatio?.default).toBe(0.25);
  });
});
