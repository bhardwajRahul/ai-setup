import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// Force the generated hook to invoke our fake caliber binary (below) instead
// of resolving a real install. Everything else in resolve-caliber stays real.
let FAKE_CALIBER = '';
vi.mock('../resolve-caliber.js', async (importActual) => {
  const actual = await importActual<typeof import('../resolve-caliber.js')>();
  return { ...actual, resolveCaliber: () => FAKE_CALIBER };
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/**
 * Execution-level coverage for #225: the generated pre-commit block must NOT
 * stage refreshed managed docs when `git config caliber.autostage false` is
 * set. Content-level assertions live in hooks.test.ts; this actually runs the
 * hook with a real git repo + /bin/sh and inspects the index.
 */
describe.skipIf(process.platform === 'win32')('pre-commit autostage execution (#225)', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostage-exec-'));

    git(tmpDir, 'init', '-q');
    git(tmpDir, 'config', 'user.email', 'test@example.com');
    git(tmpDir, 'config', 'user.name', 'Test');
    git(tmpDir, 'config', 'commit.gpgsign', 'false');

    // A fake caliber that mutates a managed doc on `refresh` and no-ops on
    // `learn finalize` — mimics what a real refresh does to CLAUDE.md.
    FAKE_CALIBER = path.join(tmpDir, 'fake-caliber');
    fs.writeFileSync(
      FAKE_CALIBER,
      '#!/bin/sh\nif [ "$1" = "refresh" ]; then echo refreshed >> CLAUDE.md; fi\nexit 0\n',
    );
    fs.chmodSync(FAKE_CALIBER, 0o755);

    // Track CLAUDE.md so `git diff --name-only` surfaces the refresh mutation.
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'v1\n');
    git(tmpDir, 'add', 'CLAUDE.md');
    git(tmpDir, 'commit', '-q', '-m', 'init');

    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function installAndRunHook(): Promise<void> {
    const { resetResolvedCaliber } = await import('../resolve-caliber.js');
    resetResolvedCaliber();
    const { installPreCommitHook } = await import('../hooks.js');
    installPreCommitHook();
    execFileSync('sh', [path.join(tmpDir, '.git', 'hooks', 'pre-commit')], { cwd: tmpDir });
  }

  function stagedFiles(): string[] {
    return git(tmpDir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  }

  it('leaves refreshed docs unstaged when caliber.autostage=false', async () => {
    git(tmpDir, 'config', 'caliber.autostage', 'false');

    await installAndRunHook();

    // The refresh ran (working tree changed) but the doc must not be staged.
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')).toContain('refreshed');
    expect(stagedFiles()).not.toContain('CLAUDE.md');
  });

  it('stages refreshed docs by default (no opt-out configured)', async () => {
    await installAndRunHook();

    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')).toContain('refreshed');
    expect(stagedFiles()).toContain('CLAUDE.md');
  });
});
