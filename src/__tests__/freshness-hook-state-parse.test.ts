/**
 * Regression: the freshness hook must be able to parse the state file
 * that ``writeState`` writes.
 *
 * ``getFreshnessScript`` generates a POSIX shell hook whose first job
 * is to pull ``lastRefreshSha`` out of ``.caliber/.caliber-state.json``
 * with ``grep -o``. That grep used to spell the key as
 * ``"lastRefreshSha":"`` — no space after the colon — while
 * ``writeState`` serialises with ``JSON.stringify(state, null, 2)``,
 * which always emits ``": "``. The pattern therefore never matched its
 * own writer's output, ``LAST_SHA`` came back empty, and the very next
 * line
 *
 *     [ -z "$LAST_SHA" ] && exit 0
 *
 * exited 0 before the comparison. The hook could not fire, on any
 * project, ever — and because its only job is to *warn* that configs
 * are stale, the failure was invisible: a hook that never warns looks
 * exactly like a project that is up to date.
 *
 * Observed on a project 73 commits past its ``lastRefreshSha`` with the
 * SessionStart hook installed and the threshold set at 15: no warning.
 *
 * The test asserts the contract rather than the literal — the pattern
 * must match what ``JSON.stringify(state, null, 2)`` actually produces,
 * so reformatting either side keeps the two in step. It is run in JS
 * rather than by invoking ``sh`` because CI runs vitest on Linux and
 * Windows and the bug is in the pattern, not the shell.
 */
import { describe, it, expect } from 'vitest';
import { getFreshnessScript } from '../lib/hooks.js';

/** Pull the `grep -o '<pattern>'` pattern back out of the script. */
function extractGrepPattern(script: string): string {
  const m = script.match(/grep -o '([^']*)'/);
  if (!m) throw new Error('no `grep -o` call found in the freshness script');
  return m[1];
}

const SHA = '5392d57ffd3cbc0d6e55651c81031477b599a588';

describe('freshness hook state parsing', () => {
  const script = getFreshnessScript();
  const pattern = extractGrepPattern(script);

  // Exactly what writeState() emits.
  const written = JSON.stringify(
    { lastRefreshSha: SHA, lastRefreshTimestamp: new Date().toISOString() },
    null,
    2,
  );

  it('matches the pretty-printed state file writeState produces', () => {
    expect(written).toMatch(new RegExp(pattern));
  });

  it("recovers the sha the way `cut -d'\"' -f4` does", () => {
    const hit = written.match(new RegExp(pattern));
    expect(hit).not.toBeNull();
    // `cut -d'"' -f4` on `"lastRefreshSha": "<sha>"` -> field 4 is the sha.
    expect((hit ?? [''])[0].split('"')[3]).toBe(SHA);
  });

  it('still matches a compact state file, if one is ever written', () => {
    const compact = JSON.stringify({ lastRefreshSha: SHA });
    expect(compact).toMatch(new RegExp(pattern));
  });

  it('tolerates the space rather than forbidding it', () => {
    // The specific regression: a pattern demanding `":"` cannot read
    // `": "`. Guard the shape, not just today's output.
    expect(pattern).not.toContain('"lastRefreshSha":"');
  });
});
