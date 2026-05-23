import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

let _resolved: string | null = null;

const WINDOWS_EXEC_EXT = /\.(cmd|exe|bat)$/i;
const NPX_RESOLUTION_RE = /[\\/]npx(?:\.(?:cmd|exe|bat))? --yes @rely-ai\/caliber$/i;

/**
 * Pick the best executable from `where`/`which` output.
 *
 * On Windows, npm installs both an extensionless POSIX shell shim and a
 * `.cmd` shim. `where` lists the POSIX shim first, but Node cannot exec it
 * directly — only `.cmd`/`.exe`/`.bat` are spawnable on Windows.
 */
export function pickExecutable(out: string): string {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (process.platform === 'win32') {
    return lines.find((l) => WINDOWS_EXEC_EXT.test(l)) ?? lines[0] ?? '';
  }
  return lines[0] ?? '';
}

/**
 * Resolve the absolute path to the `caliber` binary.
 * Caches the result so the lookup happens at most once per process.
 *
 * Always returns an absolute path when possible so that hook commands
 * embedded in .git/hooks/pre-commit or .claude/settings.json continue
 * to work even when the hook executor runs with a stripped $PATH
 * (e.g. Claude Code hooks use /usr/bin:/bin:/usr/sbin:/sbin on macOS).
 */
export function resolveCaliber(): string {
  if (_resolved) return _resolved;

  const whichCmd = process.platform === 'win32' ? 'where caliber' : 'which caliber';
  const whichNpxCmd = process.platform === 'win32' ? 'where npx' : 'which npx';

  // 0. Detect npx context — temp paths become stale after the npx process exits.
  //    Prefer a globally-installed caliber (stable absolute path). If not found,
  //    resolve npx to an absolute path so the hook command survives restricted $PATH.
  const isNpx = process.argv[1]?.includes('_npx') || process.env.npm_execpath?.includes('npx');
  if (isNpx) {
    // Prefer a globally-installed caliber over the ephemeral npx invocation
    try {
      const out = execSync(whichCmd, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim();
      const caliberPath = pickExecutable(out);
      if (caliberPath) {
        _resolved = caliberPath;
        return _resolved;
      }
    } catch {
      // not globally installed — fall through to npx
    }
    // Resolve npx to an absolute path so hooks don't depend on $PATH at runtime
    try {
      const out = execSync(whichNpxCmd, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim();
      const npxPath = pickExecutable(out);
      if (npxPath) {
        _resolved = `${npxPath} --yes @rely-ai/caliber`;
        return _resolved;
      }
    } catch {
      // npx not found on PATH — fall back to bare name
    }
    _resolved = 'npx --yes @rely-ai/caliber';
    return _resolved;
  }

  // 1. Find caliber on PATH — capture the absolute path so hook commands work
  //    in restricted $PATH environments (git hooks, Claude Code hooks, CI).
  try {
    const out = execSync(whichCmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    const caliberPath = pickExecutable(out);
    if (caliberPath) {
      _resolved = caliberPath;
      return _resolved;
    }
  } catch {
    // not on PATH — fall through
  }

  // 2. Derive from our own process.argv[1] (the script being executed)
  //    Only accept paths that look like a caliber binary — avoids picking up
  //    test runner scripts (vitest, jest) in CI/test environments.
  const binPath = process.argv[1];
  if (binPath && /caliber/.test(binPath) && fs.existsSync(binPath)) {
    _resolved = binPath;
    return _resolved;
  }

  // 3. Last resort: bare command (may still fail in /bin/sh)
  _resolved = 'caliber';
  return _resolved;
}

/** True when the resolved binary is a multi-word npx invocation (bare or absolute path). */
export function isNpxResolution(): boolean {
  const r = resolveCaliber();
  if (r === 'npx --yes @rely-ai/caliber') return true;
  // Match absolute paths on POSIX (/npx) and Windows (\npx, \npx.cmd, \npx.exe)
  return NPX_RESOLUTION_RE.test(r);
}

/**
 * Returns a display-friendly caliber binary name for embedding in
 * user-facing text and committed files (CLAUDE.md, skills, cursor rules).
 *
 * Unlike resolveCaliber() — which returns an absolute path so hook
 * subprocesses with stripped PATH can still find the binary — this
 * function returns just `caliber` (or `npx @rely-ai/caliber` for npx
 * users) on the assumption that the user's interactive shell has caliber
 * on PATH and that committed content will be read by teammates whose
 * absolute install paths differ.
 *
 * See audit finding F-P0-3 in
 * docs/superpowers/specs/2026-04-29-caliber-install-audit-findings.md
 */
export function displayCaliberName(): string {
  return isNpxResolution() ? 'npx @rely-ai/caliber' : 'caliber';
}

/** Reset cached resolution — only for tests. */
export function resetResolvedCaliber(): void {
  _resolved = null;
  _resolvedHookInvoker = null;
}

let _resolvedHookInvoker: string | null = null;

/**
 * Return the command prefix to embed in hook command strings — Claude
 * settings.json, Cursor hooks.json, pre-commit shells, etc.
 *
 * On Windows the default ``resolveCaliber()`` lands on a ``caliber.cmd``
 * npm shim. When Claude Code / Cursor / a pre-commit hook spawns that
 * command, the OS spawns ``cmd.exe`` to read the shim, which allocates
 * a visible console window for the duration of the call — a brief
 * black flash on every hook fire. Under active editor / agent use this
 * stacks to multiple flashes per second.
 *
 * The fix is to invoke Node directly on the package's ``bin.js``,
 * skipping the cmd-shim entirely. When the resolved binary is a
 * ``.cmd`` that sits next to a ``node_modules/@rely-ai/caliber/dist/
 * bin.js`` (the standard npm-global layout), we return
 * ``"<node-fwd>" "<bin.js-fwd>"`` — two forward-slashed quoted paths
 * that work both as the ``command`` value in a JSON hook entry and
 * as the first half of a Git-for-Windows bash ``"$cmd" subcommand``
 * line.
 *
 * Falls back to ``resolveCaliber()`` unchanged when:
 *   - we're not on Windows (no cmd-shim flash to fix);
 *   - the resolved binary isn't a ``.cmd`` (already-direct path);
 *   - the conventional npm layout doesn't hold (pnpm symlinks, yarn
 *     classic, custom prefix — ``bin.js`` not where we expect);
 *   - ``node`` isn't on PATH (``where node`` fails).
 *
 * Cached per process. The resolution is hot — ``where node`` +
 * ``existsSync`` on a known path — but called repeatedly during hook
 * installation across many projects.
 */
export function resolveCaliberHookInvoker(): string {
  if (_resolvedHookInvoker) return _resolvedHookInvoker;

  const base = resolveCaliber();

  if (process.platform !== 'win32' || !/\.cmd$/i.test(base)) {
    _resolvedHookInvoker = base;
    return _resolvedHookInvoker;
  }

  // npm-global layout: <prefix>/caliber.cmd lives next to
  // <prefix>/node_modules/@rely-ai/caliber/dist/bin.js
  const npmDir = path.dirname(base);
  const binJs = path.join(npmDir, 'node_modules', '@rely-ai', 'caliber', 'dist', 'bin.js');
  if (!fs.existsSync(binJs)) {
    _resolvedHookInvoker = base;
    return _resolvedHookInvoker;
  }

  let nodePath: string;
  try {
    const out = execSync('where node', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    nodePath = pickExecutable(out);
    if (!nodePath) {
      _resolvedHookInvoker = base;
      return _resolvedHookInvoker;
    }
  } catch {
    _resolvedHookInvoker = base;
    return _resolvedHookInvoker;
  }

  // Forward-slash both paths so Git-for-Windows bash (pre-commit) and
  // direct CreateProcess (Claude Code) both treat them as literal path
  // strings rather than escape sequences.
  const fwdNode = nodePath.replace(/\\/g, '/');
  const fwdBin = binJs.replace(/\\/g, '/');
  _resolvedHookInvoker = `"${fwdNode}" "${fwdBin}"`;
  return _resolvedHookInvoker;
}

/**
 * Check whether a hook command refers to caliber, regardless of whether
 * it uses a bare `caliber` or an absolute path ending in `caliber`.
 * Matches by looking for the caliber binary name + the subcommand tail.
 *
 * Example: matches both `caliber refresh --quiet` and `/usr/local/bin/caliber refresh --quiet`
 */
export function isCaliberCommand(command: string, subcommandTail: string): boolean {
  // Exact legacy match
  if (command === `caliber ${subcommandTail}`) return true;
  // Absolute-path match: ends with /caliber <tail>
  if (command.endsWith(`/caliber ${subcommandTail}`)) return true;
  // Absolute-path match for Windows ``.cmd`` shim: ends with
  // /caliber.cmd <tail> (case-insensitive .cmd suffix)
  if (/[\\/]caliber\.cmd"? /i.test(command) && command.endsWith(` ${subcommandTail}`)) {
    return true;
  }
  // Bare npx match
  if (command === `npx --yes @rely-ai/caliber ${subcommandTail}`) return true;
  if (command === `npx @rely-ai/caliber ${subcommandTail}`) return true;
  // Absolute-path npx match: '/abs/path/npx --yes @rely-ai/caliber <tail>'
  if (command.endsWith(`/npx --yes @rely-ai/caliber ${subcommandTail}`)) return true;
  if (command.endsWith(`/npx @rely-ai/caliber ${subcommandTail}`)) return true;
  // Node-direct invocation match: '"<node>" "<...caliber/dist/bin.js>" <tail>'
  // — the Windows cmd-shim bypass. Matches the quoted bin.js suffix +
  // whitespace + tail; node prefix is variable across hosts so we don't
  // pin it. Accepts both forward and back slashes inside the quotes
  // because pre-commit shells store forward, claude.json stores either.
  if (
    /[\\/]@rely-ai[\\/]caliber[\\/]dist[\\/]bin\.js"? /i.test(command) &&
    command.endsWith(` ${subcommandTail}`)
  ) {
    return true;
  }
  return false;
}
