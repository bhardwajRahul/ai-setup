/**
 * Provider-neutral model for the artifacts Caliber keeps in sync across agents:
 * skills, rules, plugins and MCP servers.
 *
 * This is deliberately separate from `src/writers/`. Writers take LLM-generated
 * prose and lay down a fresh config; sync is deterministic — it moves artifacts
 * that already exist from one provider's layout into every other provider's
 * layout, with no LLM in the loop. That is what makes it cheap enough to run on
 * a SessionStart hook or after every file edit.
 */

export type ProviderId = 'claude' | 'cursor' | 'codex' | 'opencode' | 'github-copilot';

export const PROVIDER_IDS: ProviderId[] = [
  'claude',
  'cursor',
  'codex',
  'opencode',
  'github-copilot',
];

export type SyncItemKind = 'skill' | 'rule' | 'plugin' | 'mcp';

/** A skill: a named, described instruction document. */
export interface CanonicalSkill {
  kind: 'skill';
  name: string;
  description: string;
  /** Markdown body, frontmatter stripped. */
  body: string;
  /** Optional glob scoping (Claude supports this; others ignore it). */
  paths?: string[];
  /** Set when this skill came from expanding a plugin, e.g. `plugin:fast-jev-compaction`. */
  origin?: string;
}

/** A rule: always-on instructions, no invocation model. */
export interface CanonicalRule {
  kind: 'rule';
  name: string;
  description: string;
  body: string;
  origin?: string;
}

/** An MCP server entry. */
export interface CanonicalMcp {
  kind: 'mcp';
  name: string;
  server: { command: string; args?: string[]; env?: Record<string, string> };
  origin?: string;
}

/**
 * A plugin: a bundle that a provider either installs natively (Claude Code) or
 * that has to be expanded into its constituent parts (everyone else).
 */
export interface CanonicalPlugin {
  kind: 'plugin';
  name: string;
  description: string;
  version: string;
  /** Where the plugin comes from. `builtin` ships inside Caliber itself. */
  source: 'builtin' | 'marketplace' | 'git' | 'local';
  /** Marketplace name, git ref or local path, depending on `source`. */
  ref?: string;
  /** What this plugin contributes, used to expand it for providers without plugin support. */
  provides: {
    skills?: CanonicalSkill[];
    rules?: CanonicalRule[];
    mcp?: CanonicalMcp[];
  };
}

export type CanonicalItem = CanonicalSkill | CanonicalRule | CanonicalMcp | CanonicalPlugin;

/** A stable identity for an item, used for diffing across providers. */
export function itemKey(item: CanonicalItem): string {
  return `${item.kind}:${item.name}`;
}

/**
 * What a provider can represent natively. Anything false gets degraded by the
 * adapter rather than silently dropped — a skill for Copilot becomes an
 * instruction file, a plugin for Codex becomes its expanded skills.
 */
export interface ProviderCapabilities {
  skills: boolean;
  rules: boolean;
  plugins: boolean;
  mcp: boolean;
}

export interface ProjectedFile {
  path: string;
  content: string;
}

/**
 * A JSON config file that several items merge into (`.mcp.json`,
 * `.claude/settings.json`) rather than each owning a file of its own.
 */
export interface ProjectedMerge {
  path: string;
  /** Deep-merged into the existing file, preserving unrelated keys. */
  merge: Record<string, unknown>;
}

export interface Projection {
  files: ProjectedFile[];
  merges: ProjectedMerge[];
  /** Items this provider cannot represent at all, with the reason. */
  skipped: Array<{ item: CanonicalItem; reason: string }>;
}

export interface ProviderAdapter {
  id: ProviderId;
  /** Human-readable name for CLI output. */
  label: string;
  capabilities: ProviderCapabilities;
  /** True when this provider is configured in `dir`. */
  detect(dir: string): boolean;
  /** Canonical -> native files. Pure: computes content, writes nothing. */
  project(items: CanonicalItem[], dir: string): Projection;
  /** Native -> canonical. The half the writers never had. */
  read(dir: string): CanonicalItem[];
}
