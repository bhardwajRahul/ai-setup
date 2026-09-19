# caliber-jev-compaction — shipped Claude Code plugin

A Claude Code **function-hook plugin** that replaces built-in compaction with
verbatim Jev decisions. Claude Code loads `hooks/compaction.ts` from disk at
runtime, so this directory ships as unbundled `.ts` — it is not part of
`dist/bin.js`.

| | |
|---|---|
| Source | Third-party MIT-licensed plugin, bundled into Caliber |
| Plugin version | `0.3.0` |
| License | MIT — see `../../src/vendor/caliber-jev-compaction/LICENSE` |

## What is what

| Path | Origin |
|---|---|
| `hooks/compaction.ts` | Caliber hook. Imports the vendored library from `../lib/` and Gateway/transport from `../caliber/`. |
| `hooks/hooks.json` | Lists `./compaction.ts`. |
| `.claude-plugin/plugin.json` | Plugin `userConfig` (BYOK: `apiKey` / `gatewayApiKey`, no defaults). |
| `lib/*.ts` | **Generated** from `src/vendor/caliber-jev-compaction/` by `scripts/build-plugin.mjs`. Committed so a fresh clone typechecks and `claude --plugin-dir` works before any build. Never edit here. |
| `caliber/*.ts` | **Generated** from `src/compaction/{gateway,transport}.ts` by `scripts/build-plugin.mjs`. Same drift check as `lib/`. |
| `types/claude-code.d.ts` | **Authored by Caliber**, not third-party. See below. |
| `tsconfig.plugin.json` | Caliber's, for typechecking this directory standalone. Not published. |

## The type shim

`types/claude-code.d.ts` is a small, permissive declaration covering only the
members the hook touches. It is **not** a copy of Claude Code's generated
declarations — redistributing an 11k-line generated `claude-code.d.ts` inside
an MIT package is a licensing question Caliber does not decide for its users.

The full hook typechecks against the shim unmodified. For real type safety while
developing, generate the declarations for your Claude Code version and point
`tsconfig.plugin.json` at them instead.

## Early access

Function hooks are an early-access Claude Code surface, off unless
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is set. The hook was authored against
Claude Code **2.1.274**; re-check it after a Claude Code upgrade.

## Regenerating `lib/` and `caliber/`

`lib/` is generated from `src/vendor/caliber-jev-compaction/`. `caliber/` is
generated from `src/compaction/gateway.ts` and `src/compaction/transport.ts`.
After changing either source, regenerate and verify:

```bash
npm run build:plugin && npm run build:plugin:check
npx vitest run src/plugins src/compaction
```
