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

Compact this session's context without losing wording. Ordinary compaction asks
a model to summarize old turns, which is lossy — a file path, an exact error, or
a constraint can vanish exactly when it turns out to matter. Jev compaction never
rewrites anything: it scores each tool call and tool result, then drops or
truncates the ones that are no longer needed. Everything kept stays verbatim.

## When to use it

- The session is long and most of the weight is old tool output (file reads,
  test runs, greps) rather than discussion.
- You are about to hit a context limit and want to keep exact wording of the
  earlier conversation.
- The user asks to compact, shrink, or clean up the session context.

## How to run it

\`\`\`bash
${bin} compact                      # report what would be dropped
${bin} compact --json               # machine-readable decisions
${bin} compact --threshold 0.6      # keep more aggressively
\`\`\`

Requires \`TYPESAFE_API_KEY\` in the environment. The command is read-only: it
reports the decisions and the reduction ratio, and never rewrites the transcript
file itself.

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
  name: 'fast-jev-compaction',
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
