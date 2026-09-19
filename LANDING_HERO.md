# Proposed trycaliber.ai hero

Draft copy for [trycaliber.ai](https://trycaliber.ai) / `caliber-ai-org/caliber-lp`.
Not deployed from this repo. The open-source CLI lives on GitHub; this page is a front door.

The live site currently teases “We’re working on something big.” The block below is the OSS product story, matching the [ai-setup README](https://github.com/caliber-ai-org/ai-setup). Do not paste enterprise claims (board, ROI, customer logos) into this hero — those are a different product.

## H1

Agent context that stays true to the repo.

## Subcopy

Hand-written `CLAUDE.md` files go stale the moment you refactor. Caliber keeps the files your agents actually read accurate as the code changes — then mirrors a skill written in one agent into the rest.

## Primary CTA

**Get the CLI** → [github.com/caliber-ai-org/ai-setup](https://github.com/caliber-ai-org/ai-setup)

Button label options (pick one): `Get it on GitHub` · `npx @rely-ai/caliber bootstrap`

npm: [@rely-ai/caliber](https://www.npmjs.com/package/@rely-ai/caliber)

## Secondary CTA

**Read the docs** → the GitHub README (there is no separate docs site yet)

## 3-command start

```bash
npx @rely-ai/caliber bootstrap
```

Then in a Claude Code or Cursor CLI session (terminal, not the IDE chat):

```
/setup-caliber
```

```bash
caliber score
```

Bootstrap is local. Scoring is filesystem math — no LLM. Generation uses your existing Claude Code / Cursor seat, or your own key.

## Proof (below the fold, not the H1)

Typical hand-written `CLAUDE.md`: **35 / 100**. After `/setup-caliber`: **94 / 100**. Deterministic. No invented latency, stars, or “X% of teams.”

## Two posters (same page, still below the fold)

**Write a skill once.** `caliber sync` mirrors skills, rules, and plugins into Claude Code, Cursor, Codex, OpenCode, and Copilot — native format, no LLM.

**Compact without summarizing.** The Jev plugin drops stale tool calls and keeps the rest verbatim. Bring your own key: `AI_GATEWAY_API_KEY` (Vercel AI Gateway) is not `TYPESAFE_API_KEY` (TypeSafe). Caliber does not provide either.

## Honesty lines (footer or fine print)

- Open source: [github.com/caliber-ai-org/ai-setup](https://github.com/caliber-ai-org/ai-setup) · MIT · `npx @rely-ai/caliber bootstrap`
- Your code stays on your machine. Bootstrap and scoring do not send source.
- Enterprise / “something big” is a different conversation: `sales@trycaliber.ai`

## Suggested layout

1. H1 + sub + primary CTA + the three commands (first screen)
2. Demo gif from `assets/demo-header.gif` in ai-setup (refresh if the tape is stale)
3. 35 → 94 score table
4. Sync poster · Compaction poster
5. GitHub + npm + sales

## Do not invent

No star counts, no latency SLAs, no “used by N companies” unless they are already on the page you are editing. The 35 / 94 scores and the compaction example (`248 → 201` messages, `53.9%` smaller) are the in-repo figures — reuse those, do not round them into marketing percentages.
