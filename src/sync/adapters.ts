import fs from 'fs';
import path from 'path';
import { buildDocument, parseDocument } from './frontmatter.js';
import type {
  CanonicalItem,
  CanonicalMcp,
  CanonicalPlugin,
  CanonicalRule,
  CanonicalSkill,
  ProjectedFile,
  ProjectedMerge,
  Projection,
  ProviderAdapter,
  ProviderId,
} from './types.js';

// ── shared helpers ──────────────────────────────────────────────────

function slug(name: string): string {
  return name
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function readIfExists(filePath: string): string | null {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
  } catch {
    return null;
  }
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  const raw = readIfExists(filePath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Reads `<skillsDir>/<name>/SKILL.md` into canonical skills. */
function readSkillsDir(skillsDir: string, origin?: string): CanonicalSkill[] {
  if (!fs.existsSync(skillsDir)) return [];

  const skills: CanonicalSkill[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir).map(String);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const content = readIfExists(path.join(skillsDir, entry, 'SKILL.md'));
    if (content === null) continue;

    const { frontmatter, body } = parseDocument(content);
    skills.push({
      kind: 'skill',
      name: frontmatter.values.name || entry,
      description: frontmatter.values.description || '',
      body,
      paths: frontmatter.lists.paths,
      origin: frontmatter.values['x-caliber-origin'] || origin,
    });
  }
  return skills;
}

/** Reads a flat rules directory of `<name><ext>` documents. */
function readRulesDir(rulesDir: string, ext: string): CanonicalRule[] {
  if (!fs.existsSync(rulesDir)) return [];

  const rules: CanonicalRule[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(rulesDir).map(String);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(ext)) continue;
    const content = readIfExists(path.join(rulesDir, entry));
    if (content === null) continue;

    const { frontmatter, body } = parseDocument(content);
    rules.push({
      kind: 'rule',
      name: frontmatter.values.name || entry.slice(0, -ext.length),
      description: frontmatter.values.description || '',
      body,
      origin: frontmatter.values['x-caliber-origin'],
    });
  }
  return rules;
}

function readMcpJson(filePath: string): CanonicalMcp[] {
  const json = readJsonIfExists(filePath);
  const servers = json?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];

  return Object.entries(servers as Record<string, CanonicalMcp['server']>).map(
    ([name, server]) => ({ kind: 'mcp' as const, name, server }),
  );
}

/**
 * Expands a plugin into the items a provider without plugin support can hold.
 * Each expanded item is tagged with its origin so uninstalling the plugin can
 * find everything it laid down.
 */
export function expandPlugin(plugin: CanonicalPlugin): CanonicalItem[] {
  const origin = `plugin:${plugin.name}`;
  return [
    ...(plugin.provides.skills ?? []).map((s) => ({ ...s, origin })),
    ...(plugin.provides.rules ?? []).map((r) => ({ ...r, origin })),
    ...(plugin.provides.mcp ?? []).map((m) => ({ ...m, origin })),
  ];
}

function partition(items: CanonicalItem[]) {
  return {
    skills: items.filter((i): i is CanonicalSkill => i.kind === 'skill'),
    rules: items.filter((i): i is CanonicalRule => i.kind === 'rule'),
    mcp: items.filter((i): i is CanonicalMcp => i.kind === 'mcp'),
    plugins: items.filter((i): i is CanonicalPlugin => i.kind === 'plugin'),
  };
}

function skillDocument(skill: CanonicalSkill, includePaths: boolean): string {
  return buildDocument(
    {
      name: skill.name,
      description: skill.description,
      'x-caliber-origin': skill.origin,
    },
    { paths: includePaths ? skill.paths : undefined },
    skill.body,
  );
}

function mcpMerge(filePath: string, servers: CanonicalMcp[]): ProjectedMerge[] {
  if (servers.length === 0) return [];
  return [
    {
      path: filePath,
      merge: {
        mcpServers: Object.fromEntries(servers.map((m) => [m.name, m.server])),
      },
    },
  ];
}

/**
 * Plugins are only registered natively when they come from a marketplace or a
 * git ref. A `builtin` plugin ships inside Caliber and has nothing for Claude
 * Code to resolve, so it is expanded like it is for every other provider.
 */
function isNativelyInstallable(plugin: CanonicalPlugin): boolean {
  return plugin.source === 'marketplace' || plugin.source === 'git';
}

// ── Claude Code ─────────────────────────────────────────────────────

const claude: ProviderAdapter = {
  id: 'claude',
  label: 'Claude Code',
  capabilities: { skills: true, rules: true, plugins: true, mcp: true },

  detect: (dir) =>
    fs.existsSync(path.join(dir, '.claude')) || fs.existsSync(path.join(dir, 'CLAUDE.md')),

  project(items, dir) {
    const files: ProjectedFile[] = [];
    const merges: ProjectedMerge[] = [];
    const skipped: Projection['skipped'] = [];
    const { skills, rules, mcp, plugins } = partition(items);

    const expandedSkills = [...skills];
    const expandedRules = [...rules];
    const expandedMcp = [...mcp];
    const enabledPlugins: Record<string, boolean> = {};

    for (const plugin of plugins) {
      if (isNativelyInstallable(plugin)) {
        const marketplace = plugin.source === 'marketplace' ? plugin.ref : plugin.name;
        enabledPlugins[`${plugin.name}@${marketplace}`] = true;
        continue;
      }
      for (const item of expandPlugin(plugin)) {
        if (item.kind === 'skill') expandedSkills.push(item);
        if (item.kind === 'rule') expandedRules.push(item);
        if (item.kind === 'mcp') expandedMcp.push(item);
      }
    }

    for (const skill of expandedSkills) {
      files.push({
        path: path.join(dir, '.claude', 'skills', slug(skill.name), 'SKILL.md'),
        content: skillDocument(skill, true),
      });
    }
    for (const rule of expandedRules) {
      files.push({
        path: path.join(dir, '.claude', 'rules', `${slug(rule.name)}.md`),
        content: buildDocument(
          { name: rule.name, description: rule.description, 'x-caliber-origin': rule.origin },
          {},
          rule.body,
        ),
      });
    }

    merges.push(...mcpMerge(path.join(dir, '.mcp.json'), expandedMcp));
    if (Object.keys(enabledPlugins).length > 0) {
      merges.push({ path: path.join(dir, '.claude', 'settings.json'), merge: { enabledPlugins } });
    }

    return { files, merges, skipped };
  },

  read: (dir) => [
    ...readSkillsDir(path.join(dir, '.claude', 'skills')),
    ...readRulesDir(path.join(dir, '.claude', 'rules'), '.md'),
    ...readMcpJson(path.join(dir, '.mcp.json')),
  ],
};

// ── Cursor ──────────────────────────────────────────────────────────

const cursor: ProviderAdapter = {
  id: 'cursor',
  label: 'Cursor',
  capabilities: { skills: true, rules: true, plugins: false, mcp: true },

  detect: (dir) =>
    fs.existsSync(path.join(dir, '.cursor')) || fs.existsSync(path.join(dir, '.cursorrules')),

  project(items, dir) {
    const files: ProjectedFile[] = [];
    const skipped: Projection['skipped'] = [];
    const { skills, rules, mcp, plugins } = partition(items);

    const expandedSkills = [...skills];
    const expandedRules = [...rules];
    const expandedMcp = [...mcp];

    // No plugin system — expand every plugin into its parts.
    for (const plugin of plugins) {
      for (const item of expandPlugin(plugin)) {
        if (item.kind === 'skill') expandedSkills.push(item);
        if (item.kind === 'rule') expandedRules.push(item);
        if (item.kind === 'mcp') expandedMcp.push(item);
      }
    }

    for (const skill of expandedSkills) {
      files.push({
        path: path.join(dir, '.cursor', 'skills', slug(skill.name), 'SKILL.md'),
        content: skillDocument(skill, false),
      });
    }
    for (const rule of expandedRules) {
      files.push({
        path: path.join(dir, '.cursor', 'rules', `${slug(rule.name)}.mdc`),
        content: buildDocument(
          {
            description: rule.description,
            alwaysApply: 'true',
            'x-caliber-origin': rule.origin,
          },
          {},
          rule.body,
        ),
      });
    }

    return { files, merges: mcpMerge(path.join(dir, '.cursor', 'mcp.json'), expandedMcp), skipped };
  },

  read: (dir) => [
    ...readSkillsDir(path.join(dir, '.cursor', 'skills')),
    ...readRulesDir(path.join(dir, '.cursor', 'rules'), '.mdc'),
    ...readMcpJson(path.join(dir, '.cursor', 'mcp.json')),
  ],
};

// ── Codex / OpenCode ────────────────────────────────────────────────

/**
 * Codex and OpenCode have the same shape for our purposes: a skills directory
 * and AGENTS.md. AGENTS.md is owned by `caliber refresh`, so sync does not
 * write rules here — it reports them as skipped rather than fighting the
 * writers over the same file.
 */
function agentsStyleAdapter(
  id: Extract<ProviderId, 'codex' | 'opencode'>,
  label: string,
  skillsRoot: string,
  detectPaths: string[],
): ProviderAdapter {
  return {
    id,
    label,
    capabilities: { skills: true, rules: false, plugins: false, mcp: false },

    detect: (dir) => detectPaths.some((p) => fs.existsSync(path.join(dir, p))),

    project(items, dir) {
      const files: ProjectedFile[] = [];
      const skipped: Projection['skipped'] = [];
      const { skills, rules, mcp, plugins } = partition(items);

      const expandedSkills = [...skills];
      for (const plugin of plugins) {
        for (const item of expandPlugin(plugin)) {
          if (item.kind === 'skill') expandedSkills.push(item);
          else skipped.push({ item, reason: `${label} cannot represent ${item.kind} items` });
        }
      }

      for (const skill of expandedSkills) {
        files.push({
          path: path.join(dir, skillsRoot, 'skills', slug(skill.name), 'SKILL.md'),
          content: skillDocument(skill, false),
        });
      }

      for (const rule of rules) {
        skipped.push({
          item: rule,
          reason: 'no project rules surface; AGENTS.md is managed by caliber refresh',
        });
      }
      for (const server of mcp) {
        skipped.push({ item: server, reason: `${label} MCP servers are configured globally` });
      }

      return { files, merges: [], skipped };
    },

    read: (dir) => readSkillsDir(path.join(dir, skillsRoot, 'skills')),
  };
}

const codex = agentsStyleAdapter('codex', 'Codex', '.agents', ['.agents', 'AGENTS.md']);
const opencode = agentsStyleAdapter('opencode', 'OpenCode', '.opencode', ['.opencode']);

// ── GitHub Copilot ──────────────────────────────────────────────────

/**
 * Copilot has no skills or plugins, only instruction files. Skills degrade into
 * `.github/instructions/<name>.instructions.md`, which is the closest thing it
 * has: scoped, always-available guidance.
 */
const githubCopilot: ProviderAdapter = {
  id: 'github-copilot',
  label: 'GitHub Copilot',
  capabilities: { skills: false, rules: true, plugins: false, mcp: false },

  detect: (dir) => fs.existsSync(path.join(dir, '.github', 'copilot-instructions.md')),

  project(items, dir) {
    const files: ProjectedFile[] = [];
    const skipped: Projection['skipped'] = [];
    const { skills, rules, mcp, plugins } = partition(items);

    const degradable: Array<CanonicalSkill | CanonicalRule> = [...skills, ...rules];
    for (const plugin of plugins) {
      for (const item of expandPlugin(plugin)) {
        if (item.kind === 'skill' || item.kind === 'rule') degradable.push(item);
        else skipped.push({ item, reason: 'Copilot cannot represent MCP servers' });
      }
    }

    for (const item of degradable) {
      const applyTo = item.kind === 'skill' && item.paths?.length ? item.paths.join(',') : '**';
      files.push({
        path: path.join(dir, '.github', 'instructions', `${slug(item.name)}.instructions.md`),
        content: buildDocument(
          {
            description: item.description,
            applyTo,
            'x-caliber-origin': item.origin,
          },
          {},
          item.body,
        ),
      });
    }

    for (const server of mcp) {
      skipped.push({ item: server, reason: 'Copilot cannot represent MCP servers' });
    }

    return { files, merges: [], skipped };
  },

  read: (dir) => readRulesDir(path.join(dir, '.github', 'instructions'), '.instructions.md'),
};

// ── registry ────────────────────────────────────────────────────────

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  claude,
  cursor,
  codex,
  opencode,
  'github-copilot': githubCopilot,
};

export function getAdapter(id: ProviderId): ProviderAdapter {
  return ADAPTERS[id];
}

/** Providers actually configured in `dir`. */
export function detectProviders(dir: string): ProviderAdapter[] {
  return Object.values(ADAPTERS).filter((adapter) => adapter.detect(dir));
}

export { slug as slugifyName };
