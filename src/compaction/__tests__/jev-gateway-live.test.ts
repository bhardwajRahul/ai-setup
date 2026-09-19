import { describe, it, expect } from 'vitest';
import {
  compact,
  reductionRatio,
  type JevAsker,
  type Message,
} from '../../vendor/caliber-jev-compaction/index.js';
import { createGatewayAsker, GATEWAY_BILLING_ERROR_MESSAGE } from '../gateway.js';

/**
 * LIVE end-to-end test against Vercel AI Gateway's Jev evaluation model.
 *
 * This is the live gate for Gateway compaction. Direct TypeSafe
 * (`npm run e2e:jev` / TYPESAFE_API_KEY) is a different host and is unchanged.
 *
 *   AI_GATEWAY_API_KEY=... npm run e2e:jev:gateway
 *
 * Gated on AI_GATEWAY_API_KEY — SKIPS when unset. Do not invent a pass.
 *
 * Known non-Caliber failure: HTTP 403
 *   "AI Gateway requires a valid credit card on file"
 * is Vercel account billing. Add a card on the Vercel team that owns the key,
 * then re-run. Protocol, model id (`typesafe-ai/jev`), and Bearer auth are
 * already correct when that message appears.
 */

const KEY = process.env.AI_GATEWAY_API_KEY;
const runLive = KEY ? describe : describe.skip;

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

runLive('live Jev compaction (real Vercel AI Gateway round trip)', () => {
  it('scores a real transcript through Gateway evaluate, drops stale calls, keeps wording', async () => {
    const input = transcript();
    const asker = createGatewayAsker({ apiKey: KEY as string }) as JevAsker;
    let result;
    try {
      result = await compact(input, asker, { preserveRecentMessages: 2 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(GATEWAY_BILLING_ERROR_MESSAGE) || /credit card on file/i.test(message)) {
        throw new Error(
          `${GATEWAY_BILLING_ERROR_MESSAGE} This live test did not pass. Do not treat this as a Caliber green.`,
        );
      }
      throw error;
    }

    expect(result.stats.requests).toBeGreaterThanOrEqual(1);
    expect(result.stats.calls).toBe(2);

    const reduction = reductionRatio(result);
    expect(Number.isFinite(reduction)).toBe(true);
    expect(reduction).toBeGreaterThanOrEqual(0);
    expect(reduction).toBeLessThanOrEqual(1);

    const kept = result.messages.map((m) => m.text);
    expect(kept).toContain('Fix the failing test in b.test.ts. Never edit src/generated.');
    expect(kept).toContain('go ahead');

    for (const d of result.decisions) {
      expect(['keep', 'drop_result', 'drop_call']).toContain(d.action);
    }

    console.log(
      `[live jev gateway] ${result.stats.messagesBefore}->${result.stats.messagesAfter} msgs, ` +
        `${result.stats.charsBefore}->${result.stats.charsAfter} chars ` +
        `(${(reduction * 100).toFixed(1)}% smaller), ` +
        `${result.stats.kept} kept / ${result.stats.resultsDropped} results dropped / ` +
        `${result.stats.callsDropped} calls dropped, ${result.stats.requests} request(s)`,
    );
  }, 60_000);
});
