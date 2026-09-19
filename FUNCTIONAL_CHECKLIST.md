# Jev compaction — 5-minute functional checklist

For a user with a **Vercel AI Gateway** key (`AI_GATEWAY_API_KEY`). Direct TypeSafe
(`TYPESAFE_API_KEY` → `api.typesafe.ai`) is unchanged and is not this path.

A Gateway key is **not** a TypeSafe key. Do not put it in `TYPESAFE_API_KEY`.

## 1. Offline smoke (no billing, ~1 min)

From a checkout:

```bash
npm run build:plugin
npm run validate:plugin
npx vitest run src/compaction src/plugins
npx caliber plugin install --dry-run
```

Expect:

- Compaction + plugin tests pass. Gated live tests **skip** (not fail, not pass).
- Dry-run prints a loadable tree that includes all of:
  - `.claude-plugin/plugin.json`
  - `hooks/hooks.json`
  - `hooks/compaction.ts`
  - `caliber/gateway.ts`
  - `caliber/transport.ts`
  - `lib/compact.ts` (and the rest of `lib/`)
- Nothing is written under `.claude/plugins/`.

`caliber plugin install` (no `--dry-run`) copies that same tree into
`.claude/plugins/caliber-jev-compaction/`.

## 2. Live Gateway gate (~1 min, needs a billed key)

```bash
export AI_GATEWAY_API_KEY=...          # your Vercel AI Gateway key
npm run e2e:jev:gateway
```

This is the **only** live proof that a Gateway key can score a transcript.
It posts `typesafe-ai/jev` to `https://ai-gateway.vercel.sh/v4/ai/evaluation-model`
with `Authorization: Bearer …` and AI SDK `boolean` questions (not TypeSafe `noul`).

| Result | Meaning | What to do |
|---|---|---|
| Test **skips** | `AI_GATEWAY_API_KEY` is unset | Set the key; do not invent a pass |
| **HTTP 403** `AI Gateway requires a valid credit card on file` | Vercel account billing | Add a card on the Vercel team that owns the key. Not a Caliber bug |
| **HTTP 401** | Wrong key or wrong env var | Confirm it is a Gateway key, not TypeSafe |
| Test **passes** | Live evaluate worked | Gateway compaction is functional |

Do not treat a skip or a 403 as a Caliber green.

## 3. Claude Code `/compact` (~3 min)

Needs Claude Code **2.1.274+**. Function hooks are off unless this env is set.

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
export AI_GATEWAY_API_KEY=...

# Project-local install (after `caliber plugin install`)
claude plugin marketplace add ./.claude/plugins
claude plugin install caliber-jev-compaction@caliber

# Or from this repo as a marketplace:
# claude plugin marketplace add caliber-ai-org/ai-setup
# claude plugin install caliber-jev-compaction@caliber
```

Leave the install prompts for `gatewayApiKey` / `apiKey` **blank** if the env
is already set.

Then, in a session that has old tool output (or after `caliber compact` shows
a worthwhile reduction):

```
/compact
```

Expect one of:

- Toast/log: `kept N/M messages, no summary (…% reduction; …)` — Jev ran.
- Toast/log: `fallback to built-in summary (below 25% minimum: …)` — Jev ran, not worth replacing.
- Toast/log: `fallback to built-in summary (Vercel AI Gateway rejected… credit card…)` — billing, same as the live gate.
- No hook activity — `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is unset, Claude Code is older than 2.1.274, or the plugin is not enabled.

`caliber compact` is the same scoring as a read-only report (does not rewrite the transcript):

```bash
export AI_GATEWAY_API_KEY=...
caliber compact
```

## 4. Non-Claude agents (generic fixture)

Cursor / Grok Bot / Codex have no `/compact` toast. The same scoring runs through the CLI against a documented generic transcript (tool results included). Do not invent live Cursor or Grok Bot UI results.

Offline (no key, no network):

```bash
npx vitest run src/compaction/__tests__/adapters.test.ts src/commands/__tests__/compact.test.ts
```

Expect adapter + CLI tests to pass. They parse the fixture and, when they score, substitute `fetch` — they do not call Vercel or TypeSafe.

With a billed Gateway key (same live gate as §2):

```bash
export AI_GATEWAY_API_KEY=...
caliber compact --provider generic --transcript src/compaction/__tests__/fixtures/generic-session.jsonl
```

Expect a Jev report (`Messages:`, `Calls:`, kept / dropped). `--write` is allowed on this file because it is `caliber.transcript.v1` JSONL. Do not pass `--write` at a Claude Code or Cursor host transcript.

```bash
caliber compact --provider cursor --transcript src/compaction/__tests__/fixtures/cursor-session.jsonl
```

Expect a report (often 0% — the Cursor sample has `tool_use` and no `tool_result`, so Jev has nothing to pair). `--write` must be rejected.

## Still on you (not Caliber)

- Vercel team for the Gateway key must have a **credit card on file**.
- A live Claude Code session (2.1.274+, function hooks on) to confirm `/compact` UI.

Offline protocol, model id, auth header, noul↔boolean mapping, and the
install file tree are covered by `npm test` without a key.
