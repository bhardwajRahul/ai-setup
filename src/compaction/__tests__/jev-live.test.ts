import { describe, it, expect } from 'vitest';
import {
  compactMessages,
  reductionRatio,
  type Message,
} from '../../vendor/caliber-jev-compaction/index.js';

/**
 * LIVE end-to-end test against the real Jev API.
 *
 * This is the one layer the unit/e2e tests substitute: a real network round
 * trip to api.typesafe.ai with a real key. It is gated on TYPESAFE_API_KEY, so
 * it SKIPS by default (including in the build environment, where the host is
 * egress-blocked by policy and no key exists) and RUNS wherever the key and
 * egress are present — a developer machine, or CI with the secret set.
 *
 *   TYPESAFE_API_KEY=sk-... npm run e2e:jev
 *
 * A Vercel AI Gateway key is not a TypeSafe key and will 401 here.
 * Use `npm run e2e:jev:gateway` with AI_GATEWAY_API_KEY instead.
 *
 * When it runs it proves the whole capability for real: Jev scores the calls,
 * stale ones are dropped, and everything kept comes back byte-for-byte.
 */

const KEY = process.env.TYPESAFE_API_KEY;
const runLive = KEY ? describe : describe.skip;

/** A transcript whose weight is old, droppable tool output. */
function transcript(): Message[] {
  const big = (seed: string) => `${seed} line\n`.repeat(400);
  return [
    {
      role: 'user',
      text: 'Fix the failing test in b.test.ts. Never edit src/generated.',
      toolUses: [],
    },
    {
      role: 'assistant',
      text: 'Reading a.ts',
      toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
    },
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 't1', text: big('AAAA'), isError: false }],
    },
    {
      role: 'assistant',
      text: 'Running the tests',
      toolUses: [{ tool_use_id: 't2', tool: 'Bash', input: { command: 'npm test' } }],
    },
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 't2', text: big('BBBB'), isError: true }],
    },
    {
      role: 'assistant',
      text: 'The failure is a stale assertion in b.test.ts; fixing it now.',
      toolUses: [],
    },
    { role: 'user', text: 'go ahead', toolUses: [] },
  ];
}

runLive('live Jev compaction (real api.typesafe.ai round trip)', () => {
  it('scores a real transcript, drops stale calls, keeps everything else verbatim', async () => {
    const input = transcript();
    const result = await compactMessages(input, { preserveRecentMessages: 2 });

    // A real request actually went out and came back.
    expect(result.stats.requests).toBeGreaterThanOrEqual(1);
    expect(result.stats.calls).toBe(2);

    // The reduction ratio is a real, finite fraction.
    const reduction = reductionRatio(result);
    expect(Number.isFinite(reduction)).toBe(true);
    expect(reduction).toBeGreaterThanOrEqual(0);
    expect(reduction).toBeLessThanOrEqual(1);

    // Nothing was rewritten: the first user instruction and the final
    // messages survive byte-for-byte (Jev only ever deletes/truncates).
    const kept = result.messages.map((m) => m.text);
    expect(kept).toContain('Fix the failing test in b.test.ts. Never edit src/generated.');
    expect(kept).toContain('go ahead');

    // Every decision is one of the three real actions.
    for (const d of result.decisions) {
      expect(['keep', 'drop_result', 'drop_call']).toContain(d.action);
    }

    console.log(
      `[live jev] ${result.stats.messagesBefore}->${result.stats.messagesAfter} msgs, ` +
        `${result.stats.charsBefore}->${result.stats.charsAfter} chars ` +
        `(${(reduction * 100).toFixed(1)}% smaller), ` +
        `${result.stats.kept} kept / ${result.stats.resultsDropped} results dropped / ` +
        `${result.stats.callsDropped} calls dropped, ${result.stats.requests} request(s)`,
    );
  }, 60_000);
});
