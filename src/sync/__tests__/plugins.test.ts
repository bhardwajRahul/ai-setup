import { describe, it, expect } from 'vitest';
import { JEV_COMPACTION_PLUGIN } from '../plugins.js';

describe('JEV_COMPACTION_PLUGIN skill', () => {
  const body = JEV_COMPACTION_PLUGIN.provides.skills?.[0]?.body ?? '';

  it('tells non-Claude agents to run caliber compact with a generic transcript', () => {
    expect(body).toMatch(/--provider generic/);
    expect(body).toMatch(/--transcript/);
    expect(body).toMatch(/caliber\.transcript\.v1/);
    expect(body).toMatch(/Grok Bot/);
    expect(body).toMatch(/Cursor/);
    expect(body).toMatch(/no `\/compact` toast/);
    expect(body).toMatch(/AI_GATEWAY_API_KEY/);
    expect(body).toMatch(/TYPESAFE_API_KEY/);
    expect(body).toMatch(/typesafe-ai\/jev/);
  });

  it('does not claim Cursor or Grok Bot get a Claude-style hook', () => {
    expect(body).toMatch(/No hook surface/);
    expect(body).toMatch(/`--write` is \*\*generic schema only\*\*/);
  });
});
