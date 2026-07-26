import { describe, it, expect } from 'vitest';
import { buildEvictionNoticeLines } from '../learn.js';

// Direct coverage for the CLI eviction notice (#226): the lines shown when
// learnings rotate out at the cap. Driving the full `finalize` pipeline to
// reach this branch would require mocking the LLM + storage; the notice is
// extracted as a pure helper so it can be asserted on its own.
describe('buildEvictionNoticeLines (#226)', () => {
  it('returns no lines when nothing was evicted', () => {
    expect(buildEvictionNoticeLines([])).toEqual([]);
  });

  it('uses the singular form for a single eviction', () => {
    const lines = buildEvictionNoticeLines(['- Old rule']);
    expect(lines[0]).toBe('caliber: 1 older learning rotated to the learnings archive');
    expect(lines[1]).toBe('  - Old rule');
  });

  it('pluralizes and lists every evicted bullet, stripping the leading dash', () => {
    const lines = buildEvictionNoticeLines(['- First', '- Second', '- Third']);
    expect(lines[0]).toBe('caliber: 3 older learnings rotated to the learnings archive');
    expect(lines.slice(1)).toEqual(['  - First', '  - Second', '  - Third']);
  });

  it('truncates long bullets to 80 characters', () => {
    const long = '- ' + 'x'.repeat(200);
    const lines = buildEvictionNoticeLines([long]);
    // '  - ' prefix + 80 chars of content
    expect(lines[1]).toBe('  - ' + 'x'.repeat(80));
  });
});
