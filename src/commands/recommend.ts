import chalk from 'chalk';
import ora from 'ora';
import select from '@inquirer/select';
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { collectFingerprint, Fingerprint } from '../fingerprint/index.js';
import { scanLocalState } from '../scanner/index.js';
import { llmJsonCall } from '../llm/index.js';
import { loadConfig, getFastModel } from '../llm/config.js';
import { trackSkillsInstalled } from '../telemetry/events.js';
import { readState } from '../lib/state.js';
import { displayCaliberName } from '../lib/resolve-caliber.js';
import { assertPathWithinDir } from '../lib/sanitize.js';

type Platform = 'claude' | 'cursor' | 'codex' | 'opencode' | 'github-copilot';

export interface SkillResult {
  name: string;
  slug: string;
  source_url: string;
  score: number;
  reason: string;
  detected_technology: string;
  item_type?: string;
}

interface ScoredCandidate {
  index: number;
  score: number;
  reason: string;
}

function detectLocalPlatforms(): Platform[] {
  const items = scanLocalState(process.cwd());
  const platforms = new Set<Platform>();
  for (const item of items) {
    platforms.add(item.platform);
  }
  return platforms.size > 0 ? Array.from(platforms) : ['claude'];
}

function sanitizeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
}

export function getSkillPath(platform: Platform, slug: string, relPath = 'SKILL.md'): string {
  const safe = sanitizeSlug(slug);
  if (!safe) throw new Error(`Invalid skill slug: "${slug}"`);

  const baseDir =
    platform === 'cursor'
      ? join('.cursor', 'skills')
      : platform === 'codex'
        ? join('.agents', 'skills')
        : platform === 'opencode'
          ? join('.opencode', 'skills')
          : join('.claude', 'skills');

  const skillDir = resolve(process.cwd(), baseDir, safe);
  assertPathWithinDir(relPath, skillDir);
  return join(baseDir, safe, relPath);
}

function getSkillDir(platform: Platform): string {
  if (platform === 'cursor') return join(process.cwd(), '.cursor', 'skills');
  if (platform === 'codex') return join(process.cwd(), '.agents', 'skills');
  if (platform === 'opencode') return join(process.cwd(), '.opencode', 'skills');
  return join(process.cwd(), '.claude', 'skills');
}

function getInstalledSkills(platforms: Platform[]): Set<string> {
  const installed = new Set<string>();
  const dirs = platforms.map(getSkillDir);

  for (const dir of dirs) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          installed.add(entry.name.toLowerCase());
        }
      }
    } catch {
      /* dir doesn't exist */
    }
  }

  return installed;
}

// --- Search providers ---

async function searchSkillsSh(technologies: string[]): Promise<SkillResult[]> {
  // Track best result per skillId (prefer highest installs)
  const bestBySlug = new Map<string, SkillResult & { installs: number }>();

  for (const tech of technologies) {
    try {
      const resp = await fetch(
        `https://skills.sh/api/search?q=${encodeURIComponent(tech)}&limit=10`,
        {
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        skills?: Array<{
          skillId: string;
          name: string;
          source: string;
          installs?: number;
          description?: string;
        }>;
      };
      if (!data.skills?.length) continue;

      for (const skill of data.skills) {
        const existing = bestBySlug.get(skill.skillId);
        if (existing && existing.installs >= (skill.installs ?? 0)) continue;

        bestBySlug.set(skill.skillId, {
          name: skill.name,
          slug: skill.skillId,
          source_url: skill.source ? `https://github.com/${skill.source}` : '',
          score: 0,
          reason: skill.description || '',
          detected_technology: tech,
          item_type: 'skill',
          installs: skill.installs ?? 0,
        });
      }
    } catch {
      continue;
    }
  }

  return Array.from(bestBySlug.values());
}

const AWESOME_CLAUDE_CODE_URL =
  'https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/main/README.md';

async function searchAwesomeClaudeCode(technologies: string[]): Promise<SkillResult[]> {
  try {
    const resp = await fetch(AWESOME_CLAUDE_CODE_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return [];
    const markdown = await resp.text();

    const items: SkillResult[] = [];
    const itemPattern =
      /^[-*]\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+by\s+\[[^\]]*\]\([^)]*\))?\s*[-–—:]\s*(.*)/gm;
    let match: RegExpExecArray | null;

    while ((match = itemPattern.exec(markdown)) !== null) {
      const [, name, url, description] = match;
      if (url.startsWith('#')) continue;
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      items.push({
        name: name.trim(),
        slug,
        source_url: url.trim(),
        score: 0,
        reason: description.trim().slice(0, 150),
        detected_technology: 'claude-code',
        item_type: 'skill',
      });
    }

    const techLower = technologies.map((t) => t.toLowerCase());
    return items.filter((item) => {
      const text = `${item.name} ${item.reason}`.toLowerCase();
      return techLower.some((t) => text.includes(t));
    });
  } catch {
    return [];
  }
}

async function searchAllProviders(
  technologies: string[],
  platform?: string,
): Promise<SkillResult[]> {
  const searches: Promise<SkillResult[]>[] = [searchSkillsSh(technologies)];

  if (platform === 'claude' || !platform) {
    searches.push(searchAwesomeClaudeCode(technologies));
  }

  const results = await Promise.all(searches);

  const seen = new Set<string>();
  const combined: SkillResult[] = [];
  for (const batch of results) {
    for (const result of batch) {
      // Normalize for dedup: strip hyphens/underscores so "zod-4" and "zod4" merge
      const key = result.name.toLowerCase().replace(/[-_]/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(result);
    }
  }
  return combined;
}

// --- LLM scoring ---

async function scoreWithLLM(
  candidates: SkillResult[],
  projectContext: string,
  technologies: string[],
): Promise<SkillResult[]> {
  const candidateList = candidates
    .map((c, i) => `${i}. "${c.name}" — ${c.reason || 'no description'}`)
    .join('\n');

  const fastModel = getFastModel();
  const scored = await llmJsonCall<ScoredCandidate[]>({
    system: `You evaluate whether AI agent skills and tools are relevant to a specific software project.
Given a project context and a list of candidates, score each one's relevance from 0-100 and provide a brief reason (max 80 chars).

Return a JSON array where each element has:
- "index": the candidate's index number
- "score": relevance score 0-100
- "reason": one-liner explaining why it fits or doesn't

Scoring guidelines:
- 90-100: Directly matches a core technology or workflow in the project
- 70-89: Relevant to the project's stack, patterns, or development workflow
- 50-69: Tangentially related or generic but useful
- 0-49: Not relevant to this project

Be selective. Prefer specific, high-quality matches over generic ones.
A skill for "React testing" is only relevant if the project uses React.
A generic "TypeScript best practices" skill is less valuable than one targeting the project's actual framework.
Return ONLY the JSON array.`,
    prompt: `PROJECT CONTEXT:\n${projectContext}\n\nDETECTED TECHNOLOGIES:\n${technologies.join(', ')}\n\nCANDIDATES:\n${candidateList}`,
    maxTokens: 8000,
    ...(fastModel ? { model: fastModel } : {}),
  });

  if (!Array.isArray(scored)) return [];

  return scored
    .filter((s) => s.score >= 60 && s.index >= 0 && s.index < candidates.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((s) => ({
      ...candidates[s.index],
      score: s.score,
      reason: s.reason || candidates[s.index].reason,
    }));
}

function buildProjectContext(fingerprint: Fingerprint, platforms: Platform[]): string {
  const parts: string[] = [];

  if (fingerprint.packageName) parts.push(`Package: ${fingerprint.packageName}`);
  if (fingerprint.languages.length > 0)
    parts.push(`Languages: ${fingerprint.languages.join(', ')}`);
  if (fingerprint.frameworks.length > 0)
    parts.push(`Frameworks: ${fingerprint.frameworks.join(', ')}`);
  if (fingerprint.description) parts.push(`Description: ${fingerprint.description}`);

  // Include top-level file tree (truncated)
  if (fingerprint.fileTree.length > 0) {
    parts.push(
      `\nFile tree (${fingerprint.fileTree.length} files):\n${fingerprint.fileTree.slice(0, 50).join('\n')}`,
    );
  }

  // Include existing CLAUDE.md summary
  if (fingerprint.existingConfigs.claudeMd) {
    parts.push(
      `\nExisting CLAUDE.md (first 500 chars):\n${fingerprint.existingConfigs.claudeMd.slice(0, 500)}`,
    );
  }

  // Include dependency names
  const deps = extractTopDeps();
  if (deps.length > 0) {
    parts.push(`\nDependencies: ${deps.slice(0, 30).join(', ')}`);
  }

  // Include existing skill names
  const installed = getInstalledSkills(platforms);
  if (installed.size > 0) {
    parts.push(`\nAlready installed skills: ${Array.from(installed).join(', ')}`);
  }

  return parts.join('\n');
}

// --- Helpers ---

function extractTopDeps(): string[] {
  const pkgPath = join(process.cwd(), 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const deps = Object.keys(pkg.dependencies ?? {});

    // Exclude utility/tooling packages that produce noisy search results
    const trivial = new Set([
      'typescript',
      'tslib',
      'ts-node',
      'tsx',
      'prettier',
      'eslint',
      '@eslint/js',
      'rimraf',
      'cross-env',
      'dotenv',
      'nodemon',
      'husky',
      'lint-staged',
      'commitlint',
      'chalk',
      'ora',
      'commander',
      'yargs',
      'meow',
      'inquirer',
      '@inquirer/confirm',
      '@inquirer/select',
      '@inquirer/prompts',
      'glob',
      'minimatch',
      'micromatch',
      'diff',
      'semver',
      'uuid',
      'nanoid',
      'debug',
      'ms',
      'lodash',
      'underscore',
      'tsup',
      'esbuild',
      'rollup',
      'webpack',
      'vite',
      'vitest',
      'jest',
      'mocha',
      'chai',
      'ava',
      'fs-extra',
      'mkdirp',
      'del',
      'rimraf',
      'path-to-regexp',
      'strip-ansi',
      'ansi-colors',
    ]);

    const trivialPatterns = [
      /^@types\//,
      /^@rely-ai\//,
      /^@caliber-ai\//,
      /^eslint-/,
      /^@eslint\//,
      /^prettier-/,
      /^@typescript-eslint\//,
      /^@commitlint\//,
    ];

    return deps.filter((d) => !trivial.has(d) && !trivialPatterns.some((p) => p.test(d)));
  } catch {
    return [];
  }
}

// --- Parallel-friendly search (used by init's parallel engine) ---

export interface SkillSearchResult {
  results: SkillResult[];
  contentMap: Map<string, SkillFileMap>;
}

export async function searchSkills(
  fingerprint: Fingerprint,
  targetPlatforms: Platform[],
  onStatus?: (message: string) => void,
): Promise<SkillSearchResult> {
  const installedSkills = getInstalledSkills(targetPlatforms);

  const technologies = [
    ...new Set(
      [...fingerprint.languages, ...fingerprint.frameworks, ...extractTopDeps()].filter(Boolean),
    ),
  ];

  if (technologies.length === 0) {
    return { results: [], contentMap: new Map() };
  }

  const primaryPlatform = targetPlatforms.includes('claude') ? 'claude' : targetPlatforms[0];

  onStatus?.('Searching skill registries...');
  const allCandidates = await searchAllProviders(technologies, primaryPlatform);

  if (!allCandidates.length) {
    return { results: [], contentMap: new Map() };
  }

  const newCandidates = allCandidates.filter((c) => !installedSkills.has(c.slug.toLowerCase()));
  if (!newCandidates.length) {
    return { results: [], contentMap: new Map() };
  }

  let results: SkillResult[];
  const config = loadConfig();

  if (newCandidates.length <= 5) {
    onStatus?.('Few candidates — skipping scoring');
    results = newCandidates.map((c) => ({ ...c, score: 70 }));
  } else if (config) {
    onStatus?.(`Scoring ${newCandidates.length} candidates...`);
    try {
      const projectContext = buildProjectContext(fingerprint, targetPlatforms);
      const SCORE_TIMEOUT_MS = 60_000;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const scored = await Promise.race([
          scoreWithLLM(newCandidates, projectContext, technologies),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('Scoring timed out')),
              SCORE_TIMEOUT_MS,
            );
          }),
        ]);
        results = scored;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    } catch (err) {
      const timedOut = err instanceof Error && /timed out/i.test(err.message);
      onStatus?.(
        timedOut
          ? 'Scoring timed out — returning top candidates without scoring'
          : 'Scoring failed — returning top candidates without scoring',
      );
      results = newCandidates.slice(0, 20);
    }
  } else {
    results = newCandidates.slice(0, 20);
  }

  if (results.length === 0) {
    return { results: [], contentMap: new Map() };
  }

  onStatus?.('Fetching skill content...');
  const { available, contentMap } = await fetchAvailable(results);
  return { results: available, contentMap };
}

export { interactiveSelect as selectSkills, installSkills };

// --- Query-based search (for agent/CLI use) ---

export async function querySkills(query: string): Promise<void> {
  const terms = query.split(/[\s,]+/).filter(Boolean);
  if (terms.length === 0) {
    console.log(chalk.yellow('Please provide search terms.'));
    throw new Error('__exit__');
  }

  const platforms = detectLocalPlatforms();
  const installedSkills = getInstalledSkills(platforms);
  const primaryPlatform = platforms.includes('claude') ? 'claude' : platforms[0];

  const searchSpinner = ora('Searching skill registries...').start();
  const allCandidates = await searchAllProviders(terms, primaryPlatform);

  if (!allCandidates.length) {
    searchSpinner.succeed('No skills found matching your query.');
    return;
  }

  const newCandidates = allCandidates.filter((c) => !installedSkills.has(c.slug.toLowerCase()));
  if (!newCandidates.length) {
    searchSpinner.succeed('All matching skills are already installed.');
    return;
  }
  searchSpinner.succeed(`Found ${newCandidates.length} candidates`);

  let results: SkillResult[];
  const config = loadConfig();

  if (config) {
    const scoreSpinner = ora('Scoring relevance...').start();
    try {
      const queryContext = `User is looking for skills related to: ${query}`;
      results = await scoreWithLLM(newCandidates, queryContext, terms);
      if (results.length === 0) {
        scoreSpinner.succeed('No highly relevant skills found.');
        return;
      }
      scoreSpinner.succeed(`${results.length} relevant`);
    } catch {
      results = newCandidates.slice(0, 5);
    }
  } else {
    results = newCandidates.slice(0, 5);
  }

  const top = results.slice(0, 5);

  // Verify content is available
  const fetchSpinner = ora('Verifying availability...').start();
  const { available } = await fetchAvailable(top);
  fetchSpinner.succeed(`${available.length} available`);

  if (!available.length) {
    console.log(chalk.dim('  No installable skills found.\n'));
    return;
  }

  // Output structured results for agent consumption
  console.log('');
  for (let i = 0; i < available.length; i++) {
    const r = available[i];
    const scoreStr = r.score > 0 ? ` (score: ${r.score})` : '';
    console.log(`  ${i + 1}. ${r.slug}${scoreStr}`);
    console.log(`     ${r.reason || r.name}`);
  }
  console.log('');
  console.log(
    chalk.dim(
      `  Install with: ${displayCaliberName()} skills --install ${available.map((r) => r.slug).join(',')}`,
    ),
  );
  console.log('');
}

// --- Install by slug (non-interactive) ---

export async function installBySlug(slugStr: string): Promise<void> {
  const slugs = slugStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (slugs.length === 0) {
    console.log(chalk.yellow('Please provide skill slugs to install.'));
    throw new Error('__exit__');
  }

  const platforms = detectLocalPlatforms();

  const spinner = ora(`Fetching ${slugs.length} skill${slugs.length > 1 ? 's' : ''}...`).start();

  // Search for each slug to get source URLs
  const allResults = await searchAllProviders(slugs);
  const matched: SkillResult[] = [];
  for (const slug of slugs) {
    const match = allResults.find((r) => r.slug.toLowerCase() === slug.toLowerCase());
    if (match) matched.push(match);
  }

  if (!matched.length) {
    spinner.fail('No matching skills found in the registry.');
    return;
  }

  // Fetch content
  const { available: installable, contentMap } = await fetchAvailable(matched);
  if (!installable.length) {
    spinner.fail('Could not fetch skill content.');
    return;
  }

  spinner.succeed(`Fetched ${installable.length} skill${installable.length > 1 ? 's' : ''}`);
  await installSkills(installable, platforms, contentMap);
}

// --- Main command ---

export async function recommendCommand(options: { query?: string; install?: string }) {
  if (options.install) {
    await installBySlug(options.install);
    return;
  }

  if (options.query) {
    await querySkills(options.query);
    return;
  }

  // Non-interactive context (git hooks, CI, subprocess): skip the confirmation prompt
  if (!process.stdin.isTTY) {
    console.log(chalk.dim('  Skills search requires an interactive terminal.'));
    return;
  }

  const proceed = await select({
    message: 'Search public repos for relevant skills to add to this project?',
    choices: [
      { name: 'Yes, find skills for my project', value: true },
      { name: 'No, cancel', value: false },
    ],
  });

  if (!proceed) {
    console.log(chalk.dim('  Cancelled.\n'));
    return;
  }

  const state = readState();
  const platforms = state?.targetAgent ?? undefined;
  await searchAndInstallSkills(platforms);
}

export async function searchAndInstallSkills(targetPlatforms?: Platform[]): Promise<void> {
  const fingerprint = await collectFingerprint(process.cwd());
  const platforms = targetPlatforms ?? detectLocalPlatforms();
  const installedSkills = getInstalledSkills(platforms);

  const technologies = [
    ...new Set(
      [...fingerprint.languages, ...fingerprint.frameworks, ...extractTopDeps()].filter(Boolean),
    ),
  ];

  if (technologies.length === 0) {
    console.log(
      chalk.yellow(
        'Could not detect any languages or dependencies. Try running from a project root.',
      ),
    );
    throw new Error('__exit__');
  }

  const primaryPlatform = platforms.includes('claude') ? 'claude' : platforms[0];

  // Step 1: Search all providers
  const searchSpinner = ora('Searching skill registries...').start();
  const allCandidates = await searchAllProviders(technologies, primaryPlatform);

  if (!allCandidates.length) {
    searchSpinner.succeed('No skills found matching your tech stack.');
    return;
  }

  // Step 2: Filter out already-installed skills
  const newCandidates = allCandidates.filter((c) => !installedSkills.has(c.slug.toLowerCase()));
  const filteredCount = allCandidates.length - newCandidates.length;

  if (!newCandidates.length) {
    searchSpinner.succeed(`Found ${allCandidates.length} skills — all already installed.`);
    return;
  }

  searchSpinner.succeed(
    `Found ${allCandidates.length} skills` +
      (filteredCount > 0 ? chalk.dim(` (${filteredCount} already installed)`) : ''),
  );

  // Step 3: LLM relevance scoring (if provider configured)
  let results: SkillResult[];
  const config = loadConfig();

  if (config) {
    const scoreSpinner = ora('Scoring relevance for your project...').start();
    try {
      const projectContext = buildProjectContext(fingerprint, platforms);
      results = await scoreWithLLM(newCandidates, projectContext, technologies);
      if (results.length === 0) {
        scoreSpinner.succeed('No highly relevant skills found for your specific project.');
        return;
      }
      scoreSpinner.succeed(
        `${results.length} relevant skill${results.length > 1 ? 's' : ''} for your project`,
      );
    } catch {
      scoreSpinner.warn('Could not score relevance — showing top results');
      results = newCandidates.slice(0, 20);
    }
  } else {
    results = newCandidates.slice(0, 20);
  }

  // Step 4: Pre-fetch content — only show skills that are actually installable
  const fetchSpinner = ora('Verifying skill availability...').start();
  const { available, contentMap } = await fetchAvailable(results);
  if (!available.length) {
    fetchSpinner.fail('No installable skills found — content could not be fetched.');
    return;
  }
  const unavailableCount = results.length - available.length;
  fetchSpinner.succeed(
    `${available.length} installable skill${available.length > 1 ? 's' : ''}` +
      (unavailableCount > 0 ? chalk.dim(` (${unavailableCount} unavailable)`) : ''),
  );

  const selected = await interactiveSelect(available);
  if (selected?.length) {
    await installSkills(selected, platforms, contentMap);
  }
}

// --- Interactive UI ---

async function interactiveSelect(recs: SkillResult[]): Promise<SkillResult[] | null> {
  if (!process.stdin.isTTY) {
    printSkills(recs);
    return null;
  }

  const selected = new Set<number>();
  let cursor = 0;
  const { stdin, stdout } = process;
  let lineCount = 0;
  const hasScores = recs.some((r) => r.score > 0);

  function render(): string {
    const lines: string[] = [];
    const cols = process.stdout.columns || 80;
    const nameWidth = Math.max(...recs.map((r) => r.name.length), 4) + 2;
    // prefix: "  > [x] " = 8 chars; score col: "100   " = 6 chars
    const prefixWidth = 8;
    const scoreWidth = 6;

    lines.push(chalk.bold('  Skills'));
    lines.push('');

    if (hasScores) {
      const header =
        ' '.repeat(prefixWidth) +
        chalk.dim('Score'.padEnd(scoreWidth)) +
        chalk.dim('Name'.padEnd(nameWidth)) +
        chalk.dim('Why');
      lines.push(header);
    } else {
      const header =
        ' '.repeat(prefixWidth) +
        chalk.dim('Name'.padEnd(nameWidth)) +
        chalk.dim('Technology'.padEnd(18)) +
        chalk.dim('Source');
      lines.push(header);
    }
    lines.push(chalk.dim('  ' + '─'.repeat(Math.min(cols - 4, 90))));

    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const check = selected.has(i) ? chalk.green('[x]') : '[ ]';
      const ptr = i === cursor ? chalk.cyan('>') : ' ';

      if (hasScores) {
        const scoreColor =
          rec.score >= 90 ? chalk.green : rec.score >= 70 ? chalk.yellow : chalk.dim;
        const reasonMax = Math.max(cols - prefixWidth - scoreWidth - nameWidth - 2, 20);
        lines.push(
          `  ${ptr} ${check} ${scoreColor(String(rec.score).padStart(3))}   ${rec.name.padEnd(nameWidth)}${chalk.dim(rec.reason.slice(0, reasonMax))}`,
        );
      } else {
        lines.push(
          `  ${ptr} ${check} ${rec.name.padEnd(nameWidth)}${rec.detected_technology.padEnd(16)} ${chalk.dim(rec.source_url || '')}`,
        );
      }
    }

    lines.push('');
    lines.push(chalk.dim('  ↑↓ navigate  ⎵ toggle  a all  n none  ⏎ install  q cancel'));
    return lines.join('\n');
  }

  function draw(initial: boolean) {
    if (!initial && lineCount > 0) {
      stdout.write(`\x1b[${lineCount}A`);
    }
    stdout.write('\x1b[0J');
    const output = render();
    stdout.write(output + '\n');
    lineCount = output.split('\n').length;
  }

  return new Promise((resolve) => {
    console.log('');
    draw(true);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    }

    function onData(key: string) {
      switch (key) {
        case '\x1b[A':
          cursor = (cursor - 1 + recs.length) % recs.length;
          draw(false);
          break;
        case '\x1b[B':
          cursor = (cursor + 1) % recs.length;
          draw(false);
          break;
        case ' ':
          selected.has(cursor) ? selected.delete(cursor) : selected.add(cursor);
          draw(false);
          break;
        case 'a':
          recs.forEach((_, i) => selected.add(i));
          draw(false);
          break;
        case 'n':
          selected.clear();
          draw(false);
          break;
        case '\r':
        case '\n':
          cleanup();
          if (selected.size === 0) {
            console.log(chalk.dim('\n  No skills selected.\n'));
            resolve(null);
          } else {
            resolve(
              Array.from(selected)
                .sort()
                .map((i) => recs[i]),
            );
          }
          break;
        case 'q':
        case '\x1b':
        case '\x03':
          cleanup();
          console.log(chalk.dim('\n  Cancelled.\n'));
          resolve(null);
          break;
      }
    }

    stdin.on('data', onData);
  });
}

// --- Content fetching & install ---

const FETCH_TIMEOUT = 5_000;
const MAX_SKILL_FILES = 50;
const MAX_SKILL_FILE_SIZE = 1024 * 1024; // 1 MB
const MAX_SKILL_DIR_DEPTH = 3;

/** Files belonging to one skill, keyed by path relative to the skill directory. */
export type SkillFileMap = Map<string, Buffer>;

interface GitHubDirEntry {
  name: string;
  path: string;
  type: string;
  size: number;
  download_url: string | null;
}

function isSafeRelPath(rel: string): boolean {
  return (
    !rel.startsWith('/') &&
    !rel.includes('\\') &&
    rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}

/** Thrown when the GitHub contents API rate-limits us — callers should fall back. */
class SkillFetchRateLimited extends Error {
  constructor() {
    super('GitHub API rate limited');
    this.name = 'SkillFetchRateLimited';
  }
}

/**
 * Recursively collect supporting files (references/, scripts/, assets/, ...)
 * next to SKILL.md (#228). Non-rate-limit listing/download failures are skipped
 * so SKILL.md still installs. Symlinks/submodules skipped; depth/count/size capped.
 * Sibling files and subdirs are fetched in parallel.
 */
async function collectSupportingFiles(
  repoPath: string,
  dirPath: string,
  skillDirPath: string,
  depth: number,
  files: SkillFileMap,
): Promise<void> {
  if (depth > MAX_SKILL_DIR_DEPTH || files.size >= MAX_SKILL_FILES) return;

  let entries: GitHubDirEntry[];
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch(`https://api.github.com/repos/${repoPath}/contents/${dirPath}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers,
    });
    if (resp.status === 403 || resp.status === 429) throw new SkillFetchRateLimited();
    if (!resp.ok) return;
    const data = (await resp.json()) as unknown;
    if (!Array.isArray(data)) return;
    entries = data as GitHubDirEntry[];
  } catch (err) {
    if (err instanceof SkillFetchRateLimited) throw err;
    return;
  }

  const subdirs: string[] = [];
  const downloads: Array<{ rel: string; url: string }> = [];

  for (const entry of entries) {
    if (files.size + downloads.length >= MAX_SKILL_FILES) break;

    const rel = entry.path.startsWith(skillDirPath + '/')
      ? entry.path.slice(skillDirPath.length + 1)
      : entry.name;
    if (!isSafeRelPath(rel) || files.has(rel)) continue;

    if (entry.type === 'dir') {
      subdirs.push(entry.path);
    } else if (entry.type === 'file' && entry.download_url && entry.size <= MAX_SKILL_FILE_SIZE) {
      downloads.push({ rel, url: entry.download_url });
    }
  }

  await Promise.all([
    ...downloads.map(async ({ rel, url }) => {
      if (files.size >= MAX_SKILL_FILES) return;
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
        if (resp.ok) files.set(rel, Buffer.from(await resp.arrayBuffer()));
      } catch {
        /* skip individual download failures */
      }
    }),
    ...subdirs.map((sub) => collectSupportingFiles(repoPath, sub, skillDirPath, depth + 1, files)),
  ]);
}

/**
 * Fetch a skill's files. By default only SKILL.md is fetched (cheap raw
 * request, no API quota) — used at search/preview time for many candidates.
 * Pass `includeSupporting: true` at install time to also pull references/,
 * scripts/, assets/ etc. via the GitHub contents API (rate-limited).
 */
export async function fetchSkillFiles(
  rec: SkillResult,
  options?: { includeSupporting?: boolean },
): Promise<SkillFileMap | null> {
  if (!rec.source_url) return null;

  const repoPath = rec.source_url.replace('https://github.com/', '');

  // Try common skill directory locations in the source repo
  const dirCandidates = [`skills/${rec.slug}`, `.claude/skills/${rec.slug}`, rec.slug];

  for (const dir of dirCandidates) {
    try {
      const resp = await fetch(
        `https://raw.githubusercontent.com/${repoPath}/HEAD/${dir}/SKILL.md`,
        {
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
        },
      );
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.length <= 20) continue;

      const files: SkillFileMap = new Map([['SKILL.md', Buffer.from(text, 'utf-8')]]);
      if (options?.includeSupporting) {
        await collectSupportingFiles(repoPath, dir, dir, 0, files);
      }
      return files;
    } catch (err) {
      // Rate limit during supporting-file fetch → null so install falls back to
      // the search-time SKILL.md cache instead of silently installing a partial tree.
      if (err instanceof SkillFetchRateLimited) return null;
    }
  }

  return null;
}

/** Search-time: fetch SKILL.md for each candidate and drop unreachable ones. */
async function fetchAvailable(
  recs: SkillResult[],
): Promise<{ available: SkillResult[]; contentMap: Map<string, SkillFileMap> }> {
  const contentMap = new Map<string, SkillFileMap>();
  await Promise.all(
    recs.map(async (rec) => {
      const content = await fetchSkillFiles(rec);
      if (content) contentMap.set(rec.slug, content);
    }),
  );
  return { available: recs.filter((r) => contentMap.has(r.slug)), contentMap };
}

async function installSkills(
  recs: SkillResult[],
  platforms: Platform[],
  contentMap: Map<string, SkillFileMap>,
): Promise<void> {
  const spinner = ora(`Installing ${recs.length} skill${recs.length > 1 ? 's' : ''}...`).start();
  const installed: string[] = [];

  // Supporting files fetched only for selected skills (search stays off the API).
  // Falls back to search-time SKILL.md cache on offline/rate-limit.
  const fetched = await Promise.all(
    recs.map(async (rec) => ({
      rec,
      files: (await fetchSkillFiles(rec, { includeSupporting: true })) ?? contentMap.get(rec.slug),
    })),
  );

  for (const { rec, files } of fetched) {
    if (!files) continue;

    for (const platform of platforms) {
      for (const [relPath, content] of files) {
        const skillPath = getSkillPath(platform, rec.slug, relPath);
        const fullPath = join(process.cwd(), skillPath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
      }
      const extra = files.size > 1 ? ` (+${files.size - 1} supporting files)` : '';
      installed.push(`[${platform}] ${getSkillPath(platform, rec.slug)}${extra}`);
    }
  }

  if (installed.length > 0) {
    trackSkillsInstalled(installed.length);
    spinner.succeed(`Installed ${installed.length} file${installed.length > 1 ? 's' : ''}`);
    for (const p of installed) {
      console.log(chalk.green(`  ✓ ${p}`));
    }
  } else {
    spinner.fail('No skills were installed');
  }

  console.log('');
}

function printSkills(recs: SkillResult[]) {
  const hasScores = recs.some((r) => r.score > 0);
  const cols = process.stdout.columns || 80;
  const nameWidth = Math.max(...recs.map((r) => r.name.length), 4) + 2;
  const scoreWidth = 6;
  const prefixWidth = 2;

  console.log(chalk.bold('\n  Skills\n'));

  if (hasScores) {
    console.log(
      ' '.repeat(prefixWidth) +
        chalk.dim('Score'.padEnd(scoreWidth)) +
        chalk.dim('Name'.padEnd(nameWidth)) +
        chalk.dim('Why'),
    );
  } else {
    console.log(
      ' '.repeat(prefixWidth) +
        chalk.dim('Name'.padEnd(nameWidth)) +
        chalk.dim('Technology'.padEnd(18)) +
        chalk.dim('Source'),
    );
  }
  console.log(chalk.dim('  ' + '─'.repeat(Math.min(cols - 4, 90))));

  for (const rec of recs) {
    if (hasScores) {
      const reasonMax = Math.max(cols - prefixWidth - scoreWidth - nameWidth - 2, 20);
      console.log(
        `  ${String(rec.score).padStart(3)}   ${rec.name.padEnd(nameWidth)}${chalk.dim(rec.reason.slice(0, reasonMax))}`,
      );
    } else {
      console.log(
        `  ${rec.name.padEnd(nameWidth)}${rec.detected_technology.padEnd(16)} ${chalk.dim(rec.source_url || '')}`,
      );
    }
  }
  console.log('');
}
