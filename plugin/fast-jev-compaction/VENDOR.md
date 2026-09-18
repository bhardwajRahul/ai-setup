# fast-jev-compaction — shipped Claude Code plugin

A Claude Code **function-hook plugin** that replaces built-in compaction with
verbatim Jev decisions. Claude Code loads `hooks/fast-jev.ts` from disk at
runtime, so this directory ships as unbundled `.ts` — it is not part of
`dist/bin.js`.

| | |
|---|---|
| Upstream | https://github.com/tamaratran/fast-jev-compaction |
| Commit | `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0` (2026-09-17) |
| Plugin version | `0.3.0` |
| License | MIT — see `../../src/vendor/fast-jev-compaction/LICENSE` |

## What is what

| Path | Origin |
|---|---|
| `hooks/fast-jev.ts` | Vendored from upstream `hooks/fast-jev.ts`. **Only change:** three library imports repointed from `../src/` to `../lib/`. |
| `hooks/hooks.json` | Vendored verbatim. |
| `.claude-plugin/plugin.json` | Vendored verbatim (the `userConfig` schema). |
| `lib/*.ts` | **Generated** from `src/vendor/fast-jev-compaction/` by `scripts/build-plugin.mjs`. Committed so a fresh clone typechecks and `claude --plugin-dir` works before any build. Never edit here. |
| `types/claude-code.d.ts` | **Authored by Caliber**, not vendored. See below. |
| `tsconfig.plugin.json` | Caliber's, for typechecking this directory standalone. Not published. |

## The type shim

`types/claude-code.d.ts` is a small, permissive declaration covering only the
members the hook touches. It is **not** a copy of Claude Code's generated
declarations — upstream vendors an 11k-line generated `claude-code.d.ts`, and
redistributing that inside an MIT package is a licensing question Caliber does
not decide for its users.

The full upstream hook typechecks against the shim unmodified. For real type
safety while developing, generate the declarations for your Claude Code version
and point `tsconfig.plugin.json` at them instead.

## Early access

Function hooks are an early-access Claude Code surface, off unless
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is set. Upstream authored this hook
against Claude Code **2.1.274**; re-check it after a Claude Code upgrade.

## Re-syncing

```bash
git clone --depth 1 https://github.com/tamaratran/fast-jev-compaction /tmp/jev

# the hook: expect a 3-line diff (the ../src -> ../lib import repoint)
diff /tmp/jev/hooks/fast-jev.ts plugin/fast-jev-compaction/hooks/fast-jev.ts

# the library: re-sync src/vendor first, then regenerate lib/
npm run build:plugin && npm run build:plugin:check
```

Update the commit SHA here and in `src/vendor/fast-jev-compaction/VENDOR.md`
when you pull new code, then run `npx vitest run src/plugins src/compaction`.
