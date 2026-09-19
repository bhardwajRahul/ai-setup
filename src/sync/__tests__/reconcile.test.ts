import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deepMerge, pickSource, sync } from '../reconcile.js';
import { JEV_COMPACTION_PLUGIN } from '../plugins.js';

let dir: string;

function write(relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(dir, relPath), 'utf-8');
}

/** A project with Claude as the richest provider and Cursor/Codex/Copilot present. */
function seedProject(): void {
  write(
    '.claude/skills/deploy/SKILL.md',
    '---\nname: deploy\ndescription: Ship it safely.\npaths:\n  - src/**\n---\n\n# Deploy\n\n1. Migrate.\n',
  );
  write(
    '.claude/rules/house-style.md',
    '---\nname: house-style\ndescription: How we write code.\n---\n\nPrefer unknown over any.\n',
  );
  write('.mcp.json', JSON.stringify({ mcpServers: { linear: { command: 'npx' } } }));
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  write('.github/copilot-instructions.md', '# Copilot\n');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-sync-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deepMerge', () => {
  it('merges nested objects without dropping unrelated keys', () => {
    const merged = deepMerge(
      { hooks: { SessionEnd: [1] }, enabledPlugins: { a: true } },
      { enabledPlugins: { b: true } },
    );
    expect(merged).toEqual({ hooks: { SessionEnd: [1] }, enabledPlugins: { a: true, b: true } });
  });

  it('replaces arrays rather than concatenating them', () => {
    expect(deepMerge({ args: ['a', 'b'] }, { args: ['c'] })).toEqual({ args: ['c'] });
  });
});

describe('pickSource', () => {
  it('returns null when no provider is configured', () => {
    expect(pickSource(dir)).toBeNull();
  });

  it('picks the provider holding the most items', () => {
    seedProject();
    expect(pickSource(dir)).toBe('claude');
  });

  it('reuses a recorded source even when a target now holds more items', () => {
    seedProject();
    // Cursor ends up with more files after a sync; the recorded source must win.
    write('.cursor/skills/a/SKILL.md', '---\nname: a\ndescription: d\n---\n\nbody');
    write('.cursor/skills/b/SKILL.md', '---\nname: b\ndescription: d\n---\n\nbody');
    write('.cursor/skills/c/SKILL.md', '---\nname: c\ndescription: d\n---\n\nbody');

    expect(pickSource(dir, 'claude')).toBe('claude');
  });

  it('ignores a recorded source that is no longer present', () => {
    seedProject();
    expect(pickSource(dir, 'opencode')).toBe('claude');
  });
});

describe('sync', () => {
  it('projects source items into every other detected provider', () => {
    seedProject();
    const result = sync({ dir });

    expect(result.source).toBe('claude');
    expect(result.targets).toEqual(expect.arrayContaining(['cursor', 'codex', 'github-copilot']));

    expect(read('.cursor/skills/deploy/SKILL.md')).toContain('name: deploy');
    expect(read('.agents/skills/deploy/SKILL.md')).toContain('name: deploy');
    expect(read('.github/instructions/deploy.instructions.md')).toContain('applyTo: src/**');
  });

  it('is idempotent — a second run writes nothing and reports no conflicts', () => {
    seedProject();
    sync({ dir, extraItems: [JEV_COMPACTION_PLUGIN] });

    const second = sync({ dir, extraItems: [JEV_COMPACTION_PLUGIN] });

    expect(second.written).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expect(second.unchanged.length).toBeGreaterThan(0);
  });

  it('never rewrites the source provider’s own files', () => {
    seedProject();
    const before = read('.claude/rules/house-style.md');

    sync({ dir, extraItems: [JEV_COMPACTION_PLUGIN] });

    expect(read('.claude/rules/house-style.md')).toBe(before);
  });

  it('still installs builtin plugins into the source provider', () => {
    seedProject();
    sync({ dir, extraItems: [JEV_COMPACTION_PLUGIN] });

    expect(fs.existsSync(path.join(dir, '.claude/skills/jev-compaction/SKILL.md'))).toBe(true);
  });

  it('expands a plugin into native skills for providers without plugin support', () => {
    seedProject();
    sync({ dir, extraItems: [JEV_COMPACTION_PLUGIN] });

    const cursorSkill = read('.cursor/skills/jev-compaction/SKILL.md');
    expect(cursorSkill).toContain('x-caliber-origin: plugin:caliber-jev-compaction');
    expect(read('.agents/skills/jev-compaction/SKILL.md')).toContain('Jev Compaction');
  });

  it('reports a conflict instead of clobbering a hand-edited file', () => {
    seedProject();
    sync({ dir });

    const target = path.join(dir, '.cursor/skills/deploy/SKILL.md');
    fs.writeFileSync(target, `${fs.readFileSync(target, 'utf-8')}\nhand edit\n`);

    const result = sync({ dir });

    expect(result.conflicts.map((c) => c.path)).toContain(target);
    expect(fs.readFileSync(target, 'utf-8')).toContain('hand edit');
  });

  it('overwrites a hand-edited file when forced', () => {
    seedProject();
    sync({ dir });

    const target = path.join(dir, '.cursor/skills/deploy/SKILL.md');
    fs.writeFileSync(target, 'clobber me');

    const result = sync({ dir, force: true });

    expect(result.conflicts).toEqual([]);
    expect(fs.readFileSync(target, 'utf-8')).toContain('name: deploy');
  });

  it('writes nothing in dry-run mode but still reports the plan', () => {
    seedProject();
    const result = sync({ dir, dryRun: true });

    expect(result.written.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, '.cursor/skills/deploy/SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.caliber/sync-state.json'))).toBe(false);
  });

  it('merges MCP servers into .cursor/mcp.json without dropping existing entries', () => {
    seedProject();
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } } }));

    sync({ dir });

    const merged = JSON.parse(read('.cursor/mcp.json'));
    expect(Object.keys(merged.mcpServers).sort()).toEqual(['existing', 'linear']);
  });

  it('reports items a provider cannot represent instead of dropping them silently', () => {
    seedProject();
    const result = sync({ dir });

    const codexSkips = result.skipped.filter((s) => s.provider === 'codex');
    expect(codexSkips.map((s) => s.item)).toContain('rule:house-style');
    expect(codexSkips.map((s) => s.item)).toContain('mcp:linear');
  });

  it('returns an empty result when no provider is configured', () => {
    const result = sync({ dir });
    expect(result.source).toBeNull();
    expect(result.written).toEqual([]);
  });
});
