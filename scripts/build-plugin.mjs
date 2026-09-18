#!/usr/bin/env node
// Assemble the shipped Claude Code plugin.
//
// The plugin is a real Claude Code function-hook plugin: Claude Code loads
// `hooks/fast-jev.ts` at runtime, so its sources ship as .ts, unbundled. The
// compaction library is NOT duplicated in git — it lives once in
// src/vendor/fast-jev-compaction/ and is copied into the plugin's lib/ here,
// so a re-sync from upstream cannot leave the two out of step.
//
// Runs twice over: into plugin/<name>/lib (so the plugin typechecks and
// `claude --plugin-dir plugin/<name>` works from a checkout) and into
// dist/plugin/<name> (what npm publishes and what `caliber compact --install`
// copies into a project).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const PLUGIN = 'fast-jev-compaction';
const pluginSrc = join(root, 'plugin', PLUGIN);
const librarySrc = join(root, 'src', 'vendor', PLUGIN);
const distPlugin = join(root, 'dist', 'plugin', PLUGIN);

// --check verifies the committed copy matches src/vendor without writing,
// mirroring build:skills:check. plugin/<name>/lib is committed so a fresh
// clone typechecks and `claude --plugin-dir` works before any build runs;
// this is what stops it drifting from the vendored source it came from.
const CHECK = process.argv.includes('--check');

function libraryFiles() {
  return readdirSync(librarySrc).filter((file) => file.endsWith('.ts')).sort();
}

/** Copy the vendored library into a plugin's lib/ directory. */
function copyLibrary(target) {
  const lib = join(target, 'lib');
  rmSync(lib, { recursive: true, force: true });
  mkdirSync(lib, { recursive: true });
  for (const file of libraryFiles()) {
    cpSync(join(librarySrc, file), join(lib, file));
  }
  return readdirSync(lib).length;
}

/** Exits non-zero when the committed lib/ differs from the vendored source. */
function checkLibrary(target) {
  const lib = join(target, 'lib');
  const expected = libraryFiles();
  const actual = existsSync(lib) ? readdirSync(lib).filter((f) => f.endsWith('.ts')).sort() : [];

  const problems = [];
  if (expected.join() !== actual.join()) {
    problems.push(`file list differs (expected ${expected.join(', ')}; found ${actual.join(', ') || 'nothing'})`);
  }
  for (const file of expected) {
    const to = join(lib, file);
    if (!existsSync(to)) continue;
    if (readFileSync(join(librarySrc, file), 'utf-8') !== readFileSync(to, 'utf-8')) {
      problems.push(`${file} differs from src/vendor/${PLUGIN}/${file}`);
    }
  }

  if (problems.length > 0) {
    console.error(`plugin: lib/ is out of date:\n  - ${problems.join('\n  - ')}`);
    console.error('plugin: run `npm run build:plugin` and commit the result.');
    process.exit(1);
  }
  console.log(`plugin: lib/ matches src/vendor/${PLUGIN} (${expected.length} files)`);
}

// 1. checkout-local: plugin/<name>/lib
if (CHECK) {
  checkLibrary(pluginSrc);
} else {
  const localCount = copyLibrary(pluginSrc);
  console.log(`plugin: copied ${localCount} library file(s) → plugin/${PLUGIN}/lib`);
}

// 2. publishable: dist/plugin/<name>
if (CHECK) process.exit(0);

rmSync(distPlugin, { recursive: true, force: true });
mkdirSync(dirname(distPlugin), { recursive: true });
cpSync(pluginSrc, distPlugin, { recursive: true });
// The plugin's own tsconfig is a development aid, not part of what ships.
rmSync(join(distPlugin, 'tsconfig.plugin.json'), { force: true });

const manifest = JSON.parse(
  readFileSync(join(pluginSrc, '.claude-plugin', 'plugin.json'), 'utf-8'),
);

console.log(`plugin: assembled → dist/plugin/${PLUGIN} (v${manifest.version})`);
