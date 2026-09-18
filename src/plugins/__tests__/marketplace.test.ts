import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

  it('declares the caliber marketplace with the fast-jev-compaction plugin', () => {
    expect(marketplace.name).toBe('caliber');
    expect(marketplace.plugins.map((p) => p.name)).toContain('fast-jev-compaction');
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
