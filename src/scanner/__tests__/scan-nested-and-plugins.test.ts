import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanLocalState } from '../index.js';

let dir: string;

function write(relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-scan-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scanLocalState — Claude skills layouts', () => {
  it('detects nested .claude/skills/<name>/SKILL.md, the layout the writers produce', () => {
    write('.claude/skills/deploy/SKILL.md', '# Deploy');

    const skills = scanLocalState(dir).filter((i) => i.type === 'skill' && i.platform === 'claude');

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('deploy/SKILL.md');
    expect(skills[0].path).toBe(path.join(dir, '.claude', 'skills', 'deploy', 'SKILL.md'));
  });

  it('still detects legacy flat .claude/skills/<name>.md files', () => {
    write('.claude/skills/legacy.md', '# Legacy');

    const skills = scanLocalState(dir).filter((i) => i.type === 'skill' && i.platform === 'claude');

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('legacy.md');
  });

  it('detects both layouts side by side and ignores non-markdown', () => {
    write('.claude/skills/deploy/SKILL.md', '# Deploy');
    write('.claude/skills/legacy.md', '# Legacy');
    write('.claude/skills/notes.txt', 'ignored');

    const names = scanLocalState(dir)
      .filter((i) => i.type === 'skill' && i.platform === 'claude')
      .map((i) => i.name)
      .sort();

    expect(names).toEqual(['deploy/SKILL.md', 'legacy.md']);
  });
});

describe('scanLocalState — Claude rules and plugins', () => {
  it('detects .claude/rules/*.md', () => {
    write('.claude/rules/onboarding.md', '# Onboarding');

    const rules = scanLocalState(dir).filter(
      (i) => i.type === 'rule' && i.platform === 'claude' && i.name === 'onboarding.md',
    );

    expect(rules).toHaveLength(1);
  });

  it('detects enabled plugins from .claude/settings.json', () => {
    write(
      '.claude/settings.json',
      JSON.stringify({
        enabledPlugins: {
          'caliber-jev-compaction@caliber': true,
          'disabled-one@caliber': false,
        },
      }),
    );

    const plugins = scanLocalState(dir).filter((i) => i.type === 'plugin');

    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('caliber-jev-compaction@caliber');
    expect(plugins[0].platform).toBe('claude');
  });

  it('does not throw on malformed settings.json', () => {
    write('.claude/settings.json', '{ not json');

    expect(() => scanLocalState(dir)).not.toThrow();
    expect(scanLocalState(dir).filter((i) => i.type === 'plugin')).toHaveLength(0);
  });
});

describe('scanLocalState — GitHub Copilot', () => {
  it('detects copilot instructions and instruction files', () => {
    write('.github/copilot-instructions.md', '# Copilot');
    write('.github/instructions/testing.instructions.md', '# Testing');
    write('.github/instructions/README.md', 'ignored');

    const items = scanLocalState(dir).filter((i) => i.platform === 'github-copilot');

    expect(items.map((i) => i.name).sort()).toEqual([
      'copilot-instructions.md',
      'testing.instructions.md',
    ]);
  });
});
