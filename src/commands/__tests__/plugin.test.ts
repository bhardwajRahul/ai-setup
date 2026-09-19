import { describe, it, expect } from 'vitest';
import { pluginEnableInstructions } from '../plugin.js';

describe('pluginEnableInstructions', () => {
  const text = pluginEnableInstructions().join('\n');

  it('tells the user to bring their own key and that Vercel ≠ TypeSafe', () => {
    expect(text).toMatch(/Bring your own key/);
    expect(text).toMatch(/not a TypeSafe key/);
    expect(text).toMatch(/Caliber does not provide one/);
    expect(text).toContain('export AI_GATEWAY_API_KEY=...');
    expect(text).toMatch(/TYPESAFE_API_KEY/);
  });

  it("points at Claude Code's install-time prompts and the local marketplace install", () => {
    expect(text).toMatch(/Leave the install prompts blank/);
    expect(text).toContain('claude plugin install caliber-jev-compaction@caliber');
    expect(text).toContain('export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1');
  });

  it('does not mention a Caliber-hosted or shared key', () => {
    expect(text).not.toMatch(/caliber[- ]hosted|shared key|our key|we provide/i);
  });
});
