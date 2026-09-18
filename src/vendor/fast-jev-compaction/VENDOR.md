# Vendored: fast-jev-compaction

Verbatim context compaction for LLM agents, using TypeSafe's Jev model to score
which tool calls and tool results are still needed. Nothing is ever rewritten —
kept content stays byte-for-byte identical, and only stale tool calls/results are
dropped or truncated.

| | |
|---|---|
| Upstream | https://github.com/tamaratran/fast-jev-compaction |
| Commit | `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0` (2026-09-17) |
| Upstream version | `0.2.0` (npm package) / `0.3.0` (Claude Code plugin) |
| License | MIT — see `LICENSE` in this directory |

## Why vendored rather than depended on

`fast-jev-compaction` is **not published to the npm registry** (all of
`fast-jev-compaction`, `@tamaratran/fast-jev-compaction` and `jev-compaction`
return 404). Adding it to `dependencies` — or to a git URL dependency, which
needs a build step on install — would make `npm install @rely-ai/caliber` fail
or slow down for every consumer. Caliber therefore carries the MIT-licensed
source directly.

## Rules for this directory

- **Files are byte-for-byte copies of upstream `src/`.** Do not reformat, do not
  add headers, do not "fix" style here. That keeps `diff -r` against a fresh
  upstream checkout meaningful when re-syncing.
- Caliber-specific behaviour belongs in `src/compaction/`, not here.
- Upstream already uses ESM `.js` import extensions and `strict` TypeScript, so
  it compiles under Caliber's `tsconfig.json` unchanged.
- Only `client.ts` performs I/O (one `fetch` to `https://api.typesafe.ai/v1/systemone`
  and one read of `TYPESAFE_API_KEY`). `compact.ts`, `state.ts`, `request.ts`,
  `types.ts` and `messages.ts` are pure.

## Re-syncing

```bash
git clone --depth 1 https://github.com/tamaratran/fast-jev-compaction /tmp/jev
diff -r /tmp/jev/src src/vendor/fast-jev-compaction --exclude=VENDOR.md --exclude=LICENSE
```

Update the commit SHA in this file when you pull new code, and re-run
`npx vitest run src/compaction` — the ported upstream tests live in
`src/compaction/__tests__/vendor-parity.test.ts` and exist to catch drift.
