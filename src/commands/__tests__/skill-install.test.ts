import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fetchSkillFiles, getSkillPath, installSkills } from '../recommend.js';
import type { SkillResult } from '../recommend.js';

const SKILL_MD = '# Rust Best Practices\n\nRead references/chapter_01.md for details.';

const REC: SkillResult = {
  name: 'Rust Best Practices',
  slug: 'rust-best-practices',
  source_url: 'https://github.com/apollographql/skills',
  score: 90,
  reason: 'test',
  detected_technology: 'rust',
};

type RouteMap = Record<string, { ok: boolean; body?: string | object }>;

function stubFetch(routes: RouteMap) {
  const impl = vi.fn(async (url: string) => {
    const route = routes[url];
    if (!route) return { ok: false, status: 404 };
    return {
      ok: route.ok,
      text: async () => route.body as string,
      json: async () => route.body,
      arrayBuffer: async () => {
        // Slice out of the shared Buffer pool so we return only this string's bytes
        const b = Buffer.from(route.body as string, 'utf-8');
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    };
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

const RAW_BASE = 'https://raw.githubusercontent.com/apollographql/skills/HEAD';
const API_BASE = 'https://api.github.com/repos/apollographql/skills/contents';
const DIR = 'skills/rust-best-practices';

function dirEntry(
  overrides: Partial<{
    name: string;
    path: string;
    type: string;
    size: number;
    download_url: string | null;
  }>,
) {
  return {
    name: 'file.md',
    path: `${DIR}/file.md`,
    type: 'file',
    size: 100,
    download_url: `${RAW_BASE}/${DIR}/file.md`,
    ...overrides,
  };
}

describe('fetchSkillFiles', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches SKILL.md plus supporting files recursively', async () => {
    stubFetch({
      [`${RAW_BASE}/${DIR}/SKILL.md`]: { ok: true, body: SKILL_MD },
      [`${API_BASE}/${DIR}`]: {
        ok: true,
        body: [
          dirEntry({ name: 'SKILL.md', path: `${DIR}/SKILL.md` }),
          dirEntry({
            name: 'references',
            path: `${DIR}/references`,
            type: 'dir',
            download_url: null,
          }),
        ],
      },
      [`${API_BASE}/${DIR}/references`]: {
        ok: true,
        body: [
          dirEntry({
            name: 'chapter_01.md',
            path: `${DIR}/references/chapter_01.md`,
            download_url: `${RAW_BASE}/${DIR}/references/chapter_01.md`,
          }),
        ],
      },
      [`${RAW_BASE}/${DIR}/references/chapter_01.md`]: { ok: true, body: 'chapter one' },
    });

    const files = await fetchSkillFiles(REC);
    expect(files).not.toBeNull();
    expect([...(files as Map<string, Buffer>).keys()].sort()).toEqual([
      'SKILL.md',
      'references/chapter_01.md',
    ]);
    expect((files as Map<string, Buffer>).get('references/chapter_01.md')?.toString()).toBe(
      'chapter one',
    );
  });

  it('falls back to SKILL.md only when directory listing fails', async () => {
    stubFetch({
      [`${RAW_BASE}/${DIR}/SKILL.md`]: { ok: true, body: SKILL_MD },
      // API listing route missing → 404
    });

    const files = await fetchSkillFiles(REC);
    expect(files).not.toBeNull();
    expect([...(files as Map<string, Buffer>).keys()]).toEqual(['SKILL.md']);
  });

  it('returns null when SKILL.md is not found anywhere', async () => {
    stubFetch({});
    expect(await fetchSkillFiles(REC)).toBeNull();
  });

  it('skips symlinks, submodules, unsafe paths, and oversized files', async () => {
    stubFetch({
      [`${RAW_BASE}/${DIR}/SKILL.md`]: { ok: true, body: SKILL_MD },
      [`${API_BASE}/${DIR}`]: {
        ok: true,
        body: [
          dirEntry({ name: 'link.md', path: `${DIR}/link.md`, type: 'symlink' }),
          dirEntry({ name: 'sub', path: `${DIR}/sub`, type: 'submodule' }),
          dirEntry({ name: '../escape.md', path: 'elsewhere/escape.md' }),
          dirEntry({ name: 'big.bin', path: `${DIR}/big.bin`, size: 10 * 1024 * 1024 }),
          dirEntry({
            name: 'ok.md',
            path: `${DIR}/ok.md`,
            download_url: `${RAW_BASE}/${DIR}/ok.md`,
          }),
        ],
      },
      [`${RAW_BASE}/${DIR}/ok.md`]: { ok: true, body: 'fine' },
    });

    const files = await fetchSkillFiles(REC);
    expect([...(files as Map<string, Buffer>).keys()].sort()).toEqual(['SKILL.md', 'ok.md'].sort());
  });

  it('caps the number of collected files', async () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      dirEntry({
        name: `f${i}.md`,
        path: `${DIR}/f${i}.md`,
        download_url: `${RAW_BASE}/${DIR}/f${i}.md`,
      }),
    );
    const routes: RouteMap = {
      [`${RAW_BASE}/${DIR}/SKILL.md`]: { ok: true, body: SKILL_MD },
      [`${API_BASE}/${DIR}`]: { ok: true, body: many },
    };
    for (const e of many) routes[e.download_url as string] = { ok: true, body: 'x' };
    stubFetch(routes);

    const files = await fetchSkillFiles(REC);
    expect((files as Map<string, Buffer>).size).toBeLessThanOrEqual(50);
  });
});

describe('getSkillPath', () => {
  it('builds nested paths inside the skill directory', () => {
    expect(getSkillPath('claude', 'my-skill', 'references/ch1.md')).toBe(
      join('.claude', 'skills', 'my-skill', 'references', 'ch1.md'),
    );
  });

  it('throws when a relative path escapes the skill directory', () => {
    expect(() => getSkillPath('claude', 'my-skill', '../../evil.md')).toThrow(/escapes/);
  });
});

describe('installSkills', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caliber-skill-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    process.env.CALIBER_TELEMETRY_DISABLED = '1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes SKILL.md and supporting files for each platform', async () => {
    const files = new Map<string, Buffer>([
      ['SKILL.md', Buffer.from(SKILL_MD)],
      ['references/chapter_01.md', Buffer.from('chapter one')],
      ['scripts/run.sh', Buffer.from('#!/bin/sh\necho ok')],
    ]);

    await installSkills([REC], ['claude', 'codex'], new Map([[REC.slug, files]]));

    for (const base of [join('.claude', 'skills'), join('.agents', 'skills')]) {
      const skillDir = join(dir, base, REC.slug);
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(SKILL_MD);
      expect(readFileSync(join(skillDir, 'references', 'chapter_01.md'), 'utf-8')).toBe(
        'chapter one',
      );
      expect(existsSync(join(skillDir, 'scripts', 'run.sh'))).toBe(true);
    }
  });
});
