import { displayCaliberName } from '../lib/resolve-caliber.js';
import type { CanonicalPlugin } from './types.js';

/**
 * Plugins that ship inside Caliber.
 *
 * A `builtin` plugin is one whose capability Caliber itself provides, so there
 * is no marketplace for a provider to resolve. Sync therefore expands it into
 * native skills for every provider — including Claude Code — rather than
 * writing an `enabledPlugins` entry pointing at something that does not exist.
 * Marketplace and git plugins that users add take the native path instead.
 */

function jevCompactionSkill(): string {
  const bin = displayCaliberName();
  return `# Jev Compaction

Compact session context without losing wording. Ordinary compaction asks a model
to summarize old turns, which is lossy — a file path, an exact error, or a
constraint can vanish exactly when it turns out to matter. Jev compaction never
rewrites anything: it scores each tool call and tool result, then drops or
truncates the ones that are no longer needed. Everything kept stays verbatim.

There are two ways to use it.

## 1. The plugin (automatic, in-session)

Caliber ships a Claude Code plugin that replaces built-in compaction outright.
It hooks \`session.compact\` to substitute the verbatim-trimmed transcript for the
summary, and \`turn.complete\` to request compaction once context passes a
threshold (60% by default). When Jev fails or the reduction is not worth it, it
falls back to Claude Code's built-in summary rather than breaking the session.

\`\`\`bash
${bin} plugin install              # materialize it into .claude/plugins/
\`\`\`

Enabling it needs two environment variables and Claude Code's own plugin
commands; \`${bin} plugin install\` prints the exact steps. Function hooks are an
early-access Claude Code surface and are off unless
\`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1\` is set.

## 2. The command (manual, read-only)

\`\`\`bash
${bin} compact                     # report what would be dropped
${bin} compact --json              # machine-readable decisions
${bin} compact --threshold 0.6     # keep more aggressively
\`\`\`

This never rewrites the transcript — it only reports. Use it to see what
compaction would do before enabling the plugin, or in a non-Claude-Code agent.

Both paths need **your own** TypeSafe API key as \`TYPESAFE_API_KEY\`
(get one at https://typesafe.ai). Caliber does not ship or proxy a key.

## Reading the output

- **kept** — call and result both still needed, left byte-for-byte alone.
- **result dropped** — the call still matters, its output no longer does; the
  result is truncated to a short head plus a note.
- **call dropped** — neither the call nor its result is needed; both removed.

If the reduction ratio is under 25%, compaction is not worth it — say so and
leave the context alone rather than spending a request on it.
`;
}

export const JEV_COMPACTION_PLUGIN: CanonicalPlugin = {
  kind: 'plugin',
  name: 'caliber-jev-compaction',
  description:
    'Verbatim context compaction: scores tool calls with Jev and drops stale ones instead of summarizing.',
  version: '0.3.0',
  source: 'builtin',
  provides: {
    skills: [
      {
        kind: 'skill',
        name: 'jev-compaction',
        description:
          'Compact session context without rewriting it — drops stale tool calls and results, keeps everything else verbatim. Use when a session is long and heavy with old tool output, or when the user asks to compact or shrink the context.',
        body: jevCompactionSkill(),
      },
    ],
  },
};

export const BUILTIN_PLUGINS: CanonicalPlugin[] = [JEV_COMPACTION_PLUGIN];

export const BUILTIN_PLUGIN_NAMES = new Set(BUILTIN_PLUGINS.map((p) => p.name));
