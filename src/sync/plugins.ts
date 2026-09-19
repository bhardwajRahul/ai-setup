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

When context is large, or the user asks to compact / shrink context, use this
skill. Do **not** invent a summary yourself.

## What each host can do today

| Host | Automatic compact | What you can do |
|---|---|---|
| Claude Code | Yes — plugin hooks \`session.compact\` and can toast \`/compact\` | Install the plugin, or run \`${bin} compact\` as a report |
| Cursor agents | No hook surface | Run \`${bin} compact --provider generic --transcript <path>\` and apply the report |
| Grok Bot / Codex / similar | No hook surface | Same CLI path. There is no \`/compact\` toast unless the host adds a hook later |

Cursor's on-disk \`agent-transcripts/*.jsonl\` is unofficial and usually has
\`tool_use\` without ids and **no \`tool_result\`**. Jev needs paired results to
drop anything, so prefer an in-memory export (below) over that file.

## 1. Claude Code plugin (automatic, in-session)

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

## 2. The command (every agent)

\`\`\`bash
${bin} compact                                    # Claude: newest transcript, report only
${bin} compact --json
${bin} compact --provider generic --transcript ./session.json
${bin} compact --provider generic --transcript ./session.json --write
${bin} compact --provider cursor --transcript ~/.cursor/projects/<slug>/agent-transcripts/<id>.jsonl
\`\`\`

\`--transcript\` is required unless Claude can auto-discover
\`~/.claude/projects/<slug>/*.jsonl\`. \`--write\` is **generic schema only**
(proven round-trip). Claude Code and Cursor own their files; do not rewrite them.

### Non-Claude agents: export, score, apply

1. Serialize the conversation you actually have — including tool results — to
   \`caliber.transcript.v1\` or an OpenAI-compatible messages array. Write it to
   a temp file.
2. Run \`${bin} compact --provider generic --transcript <path>\` (add \`--json\`
   when you will apply decisions yourself).
3. Apply the decisions to this session's working context, **or** show the report
   and stop. With \`--write\`, the generic file is replaced; you still have to
   load it back into the host. Cursor / Grok Bot will not toast \`/compact\`
   unless the host adds a hook later.

Generic envelope:

\`\`\`json
{
  "schema": "caliber.transcript.v1",
  "messages": [
    { "role": "user", "text": "Fix the test", "toolUses": [] },
    {
      "role": "assistant",
      "text": "Reading",
      "toolUses": [{ "tool_use_id": "call_1", "tool": "Read", "input": { "path": "a.ts" } }]
    },
    {
      "role": "user",
      "text": "",
      "toolUses": [],
      "toolResults": [{ "tool_use_id": "call_1", "text": "file contents" }]
    }
  ]
}
\`\`\`

OpenAI-compatible JSON arrays (\`role: user|assistant|tool\`, \`tool_calls\`)
are accepted as the same \`--provider generic\` encoding.

Both paths need **your own** key. A Vercel AI Gateway key is not a TypeSafe
key. Set \`AI_GATEWAY_API_KEY\` (Vercel AI Gateway, model \`typesafe-ai/jev\`)
or \`TYPESAFE_API_KEY\` (direct TypeSafe System One, https://typesafe.ai).
Caliber does not ship or proxy a key.

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
