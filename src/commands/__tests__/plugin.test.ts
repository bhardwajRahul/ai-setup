import { describe, it, expect } from 'vitest';
import { pluginEnableInstructions } from '../plugin.js';

describe('pluginEnableInstructions', () => {
  const text = pluginEnableInstructions().join('\n');

  it('tells the user to bring their own TypeSafe key', () => {
    expect(text).toMatch(/Bring your own TypeSafe key/);
    expect(text).toMatch(/https:\/\/typesafe\.ai/);
    expect(text).toMatch(/Caliber does not provide one/);
    expect(text).toContain('export TYPESAFE_API_KEY=...');
  });

  it("points at Claude Code's install-time apiKey prompt, matching upstream", () => {
    expect(text).toMatch(/Leave the install prompt blank to use TYPESAFE_API_KEY/);
    expect(text).toContain('claude plugin install caliber-jev-compaction@caliber');
  });

  it('does not mention a Caliber-hosted or shared key', () => {
    expect(text).not.toMatch(/caliber[- ]hosted|shared key|our key|we provide/i);
  });
});
