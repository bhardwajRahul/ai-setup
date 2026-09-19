#!/usr/bin/env node
// Structural check for the shipped Claude Code plugin.
//
// Upstream's `claude plugin validate` needs the Claude Code CLI, which is not
// available in most CI/build environments. This script checks the same facts
// that validation would catch without guessing at Claude Code's private schema:
// manifests parse, hook modules exist and export `register`, the library the
// hook imports is present, and marketplace entries point at a real plugin.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'caliber-jev-compaction';
const pluginDir = join(root, 'plugin', PLUGIN);
const problems = [];

function readJson(rel) {
  const full = join(root, rel);
  try {
    return JSON.parse(readFileSync(full, 'utf-8'));
  } catch (error) {
    problems.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const marketplace = readJson('.claude-plugin/marketplace.json');
const manifest = readJson(`plugin/${PLUGIN}/.claude-plugin/plugin.json`);
const hooks = readJson(`plugin/${PLUGIN}/hooks/hooks.json`);

if (marketplace) {
  const entry = (marketplace.plugins ?? []).find((p) => p.name === PLUGIN);
  if (!entry) problems.push(`marketplace.json has no plugin named ${PLUGIN}`);
  else if (entry.source && !existsSync(join(root, entry.source, '.claude-plugin', 'plugin.json'))) {
    problems.push(`marketplace source "${entry.source}" is not a plugin directory`);
  }
}

if (manifest) {
  for (const key of ['name', 'version', 'description', 'userConfig']) {
    if (!(key in manifest)) problems.push(`plugin.json is missing "${key}"`);
  }
  if (manifest.name !== PLUGIN) problems.push(`plugin.json name is "${manifest.name}", expected ${PLUGIN}`);
  for (const key of [
    'apiKey',
    'gatewayApiKey',
    'gatewayBaseUrl',
    'keepThreshold',
    'preserveRecentMessages',
    'compactAtPercent',
    'minReductionRatio',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'model',
  ]) {
    if (!manifest.userConfig?.[key]) problems.push(`plugin.json userConfig is missing "${key}"`);
  }
  for (const key of ['apiKey', 'gatewayApiKey']) {
    const field = manifest.userConfig?.[key];
    if (field && 'default' in field) {
      problems.push(`plugin.json ${key} must not have a default — users supply their own key`);
    }
    if (field && field.sensitive !== true) {
      problems.push(`plugin.json ${key} must be marked sensitive`);
    }
  }
}

if (hooks) {
  const modules = hooks.modules ?? [];
  if (modules.length === 0) problems.push('hooks.json lists no modules');
  for (const module of modules) {
    const file = join(pluginDir, 'hooks', module.replace(/^\.\//, ''));
    if (!existsSync(file)) problems.push(`hooks.json module "${module}" does not exist`);
    else {
      const source = readFileSync(file, 'utf-8');
      if (!/export const register/.test(source)) {
        problems.push(`${module} does not export register`);
      }
      if (!/session\.compact/.test(source) || !/turn\.complete/.test(source)) {
        problems.push(`${module} does not register session.compact and turn.complete`);
      }
    }
  }
}

const hook = join(pluginDir, 'hooks', 'compaction.ts');
if (existsSync(hook)) {
  const source = readFileSync(hook, 'utf-8');
  for (const match of source.matchAll(/from '\.\.\/lib\/([a-z]+)\.js'/g)) {
    const lib = join(pluginDir, 'lib', `${match[1]}.ts`);
    if (!existsSync(lib)) problems.push(`hook imports ../lib/${match[1]}.js but ${lib} is missing`);
  }
  for (const match of source.matchAll(/from '\.\.\/caliber\/([a-z]+)\.js'/g)) {
    const file = join(pluginDir, 'caliber', `${match[1]}.ts`);
    if (!existsSync(file)) {
      problems.push(`hook imports ../caliber/${match[1]}.js but ${file} is missing`);
    }
  }
}

if (problems.length > 0) {
  console.error(`validate:plugin failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

console.log(`validate:plugin: ${PLUGIN} v${manifest?.version ?? '?'} is structurally complete`);
