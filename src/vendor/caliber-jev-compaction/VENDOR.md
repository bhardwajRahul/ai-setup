# Vendored: caliber-jev-compaction

Verbatim context compaction for LLM agents, using TypeSafe's Jev model to score
which tool calls and tool results are still needed. Nothing is ever rewritten —
kept content stays byte-for-byte identical, and only stale tool calls/results are
dropped or truncated.

| | |
|---|---|
| Source | Third-party MIT-licensed library, bundled into Caliber |
| Version | `0.2.0` (library) / `0.3.0` (Claude Code plugin) |
| License | MIT — see `LICENSE` in this directory (retained as required) |

## Why bundled rather than depended on

The upstream library is **not published to the npm registry**. Adding it to
`dependencies` — or to a git URL dependency, which needs a build step on install
— would make `npm install @rely-ai/caliber` fail or slow down for every
consumer. Caliber therefore carries the MIT-licensed source directly. The
`LICENSE` file is kept beside the source to satisfy the MIT terms.

## Rules for this directory

- **Treat these files as immutable third-party source.** Do not reformat, do not
  add headers, do not "fix" style here — the drift check below compares them
  against Caliber's copy, and gratuitous edits break that.
- Caliber-specific behaviour belongs in `src/compaction/`, not here.
- The source uses ESM `.js` import extensions and `strict` TypeScript, so it
  compiles under Caliber's `tsconfig.json` unchanged.
- Only `client.ts` performs I/O (one `fetch` to `https://api.typesafe.ai/v1/systemone`
  and one read of `TYPESAFE_API_KEY`). `compact.ts`, `state.ts`, `request.ts`,
  `types.ts` and `messages.ts` are pure.

## Drift guards

Two checks keep the copies here from silently diverging from what Caliber ships
and tests against:

- `npm run build:plugin:check` fails if `plugin/caliber-jev-compaction/lib/`
  (generated from this directory) has drifted from it.
- `src/compaction/__tests__/vendor-parity.test.ts` locks the observable
  behaviour of this library; run `npx vitest run src/compaction` after any
  change here.
