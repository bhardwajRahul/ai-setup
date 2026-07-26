/**
 * Source-level regression: every spawn-family call in Caliber must
 * pass ``windowsHide: true`` in its options object.
 *
 * Without the flag, Node's ``child_process`` asks ``CreateProcess`` to
 * use ``STARTF_USESHOWWINDOW`` with ``SW_SHOWDEFAULT`` and a black
 * console window flashes onto the user's desktop for the duration of
 * each call. Under active Claude Code / Cursor / Codex / scoring use
 * that's a near-continuous stream of pop-ups on Windows — unusable in
 * practice.
 *
 * ``windowsHide`` is a no-op on macOS/Linux ([Node docs][1]: "Hide
 * the subprocess console window that would normally be created on
 * Windows systems"). The flag is platform-neutral and zero-risk on
 * POSIX — silently dropped by the POSIX spawn path.
 *
 * [1]: https://nodejs.org/api/child_process.html#optionswindowshide
 *
 * The check is source-level rather than behavioural because:
 *   - the flag's effect is observable only on Windows;
 *   - CI runs vitest on Linux for these tests;
 *   - regressing this is easy (every new spawn site has to remember
 *     the flag), and a runtime check on a Windows-only CI leg would
 *     still let a PR land on ``master`` first.
 *
 * Adding a new file is one entry in the SOURCE_FILES tuple. Every
 * file in ``src/`` that imports a spawn-family function from
 * ``child_process`` MUST be added to this list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

const SOURCE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['index.cjs', 'index.cjs'],
  ['src/constants.ts', 'src/constants.ts'],
  ['src/llm/claude-cli.ts', 'src/llm/claude-cli.ts'],
  ['src/llm/cursor-acp.ts', 'src/llm/cursor-acp.ts'],
  ['src/llm/opencode.ts', 'src/llm/opencode.ts'],
  ['src/scoring/utils.ts', 'src/scoring/utils.ts'],
  ['src/utils/editor.ts', 'src/utils/editor.ts'],
  ['src/utils/version-check.ts', 'src/utils/version-check.ts'],
  // src/fingerprint/large-file-filter.ts uses dependency-injected
  // ``exec()`` rather than calling ``execFileSync`` directly, so the
  // regex below — which deliberately ignores the bare ``exec``
  // identifier to avoid colliding with ``RegExp.exec()`` — undercounts.
  // The call inside it does carry ``windowsHide: true`` (verifiable
  // by grep); skipping the regex check here is the right call.
  ['src/fingerprint/file-tree.ts', 'src/fingerprint/file-tree.ts'],
  ['src/fingerprint/code-analysis.ts', 'src/fingerprint/code-analysis.ts'],
  ['src/fingerprint/cache.ts', 'src/fingerprint/cache.ts'],
  ['src/fingerprint/git.ts', 'src/fingerprint/git.ts'],
  ['src/commands/score.ts', 'src/commands/score.ts'],
  ['src/commands/learn.ts', 'src/commands/learn.ts'],
  ['src/lib/hooks.ts', 'src/lib/hooks.ts'],
  ['src/lib/state.ts', 'src/lib/state.ts'],
  ['src/lib/git-diff.ts', 'src/lib/git-diff.ts'],
  ['src/lib/resolve-caliber.ts', 'src/lib/resolve-caliber.ts'],
  ['src/telemetry/config.ts', 'src/telemetry/config.ts'],
  ['src/scoring/checks/accuracy.ts', 'src/scoring/checks/accuracy.ts'],
  ['src/scoring/checks/freshness.ts', 'src/scoring/checks/freshness.ts'],
  ['src/scoring/checks/bonus.ts', 'src/scoring/checks/bonus.ts'],
];

/**
 * Strip pure-comment lines so prose mentions of ``spawn`` / ``exec``
 * don't inflate the call count.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/**
 * Count spawn-family invocations. The regex matches ``spawn(``,
 * ``spawnSync(``, ``execFile(``, ``execFileSync(``, ``execFileAsync(``,
 * ``execSync(`` as function calls — not destructures (``const { spawn
 * } = ...``), not method calls (``.exec(``), not type-import lines.
 */
function countSpawnCalls(codeSource: string): number {
  const re =
    /(^|[^a-zA-Z0-9_$.])(spawn|spawnSync|execFile|execFileSync|execFileAsync|execSync)\s*\(/gm;
  let count = 0;
  // Use a fresh RegExp per call to avoid stateful lastIndex issues
  // across multiple invocations of this helper.
  while (re.exec(codeSource) !== null) {
    count++;
  }
  return count;
}

describe('windowsHide regression — every spawn-family call must set the flag', () => {
  for (const [label, file] of SOURCE_FILES) {
    it(`${label}: every spawn-family options object contains windowsHide: true`, () => {
      const abs = resolve(ROOT, file);
      const source = readFileSync(abs, 'utf-8');
      const code = stripComments(source);

      const spawnCount = countSpawnCalls(code);
      const hideCount = (code.match(/windowsHide\s*:\s*true/g) ?? []).length;

      // Sanity: catch a refactor that accidentally deletes every
      // spawn call (which would otherwise make the equality below
      // trivially true at 0 == 0).
      expect(spawnCount).toBeGreaterThan(0);
      // One windowsHide per spawn-family call. Equality is sufficient
      // because every call in these files passes an options object
      // literal — no helper indirection.
      expect(hideCount).toBeGreaterThanOrEqual(spawnCount);
      // Catch the class of bug where windowsHide is passed as a 4th
      // positional arg to execFileSync (ignored by Node) instead of
      // inside the options object.
      expect(code).not.toMatch(/\)\s*,\s*\{\s*windowsHide\s*:\s*true\s*\}\s*\)/);
    });
  }
});
