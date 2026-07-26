import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fetchSkillFiles, getSkillPath, installSkills } from '../recommend.js';
import type { SkillResult, SkillFileMap } from '../recommend.js';

const SKILL_MD = '# Rust Best Practices\n\nRead references/chapter_01.md for details.';

const REC: SkillResult = {
  name: 'Rust Best Practices',
  slug: 'rust-best-practices',
  source_url: 'https://github.com/apollographql/skills',
  score: 90,
  reason: 'test',
  detected_technology: 'rust',
};

type RouteMap = Record<string, { ok: boolean; status?: number; body?: string | object | Buffer }>;

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function stubFetch(routes: RouteMap) {
  const impl = vi.fn(async (url: string) => {
    const route = routes[url];
    if (!route) return { ok: false, status: 404 };
    const body = route.body;
    const buf = Buffer.isBuffer(body)
      ? body
      : typeof body === 'string'
        ? Buffer.from(body, 'utf-8')
        : Buffer.alloc(0);
    return {
      ok: route.ok,
      status: route.status ?? (route.ok ? 200 : 404),
      text: async () => (typeof body === 'string' ? body : ''),
      json: async () => body,
      arrayBuffer: async () => toArrayBuffer(buf),
    };
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

function expectFiles(files: SkillFileMap | null): SkillFileMap {
  expect(files).not.toBeNull();
  return files as SkillFileMap;
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

  it('fetches only SKILL.md by default (no GitHub API calls at search time)', async () => {
    const impl = stubFetch({
      [`${RAW_BASE}/${DIR}/SKILL.md`]: { ok: true, body: SKILL_MD },
    });

    const files = expectFiles(await fetchSkillFiles(REC));
    expect([...files.keys()]).toEqual(['SKILL.md']);
    const calledHosts = impl.mock.calls.map((c) => new URL(String(c[0])).host);
    expect(calledHosts).not.toContain('api.github.com');
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

    const files = expectFiles(await fetchSkillFiles(REC, { includeSupporting: true }));
    expect([...files.keys()].sort()).toEqual(['SKILL.md', 'references/chapter_01.md']);
    expect(files.get('references/chapter_01.md')?.toString()).toBe('chapter one');
  });

  it('keeps SKILL.md when directory listing 404s', async () => {
    stubFetch({
      [`${RAW_BASE}/${DIR}/SKILL.md`]: { ok: true, body: SKILL_MD },
    });

    const files = expectFiles(await fetchSkillFiles(REC, { includeSupporting: true }));
    expect([...files.keys()]).toEqual(['SKILL.md']);
  });

  it('returns null on GitHub API rate limit so install can fall back', async () => {
    stubFetch({
      [`${RAW_BASE}/${DIR}/SKILL.md`]: { ok: true, body: SKILL_MD },
      [`${API_BASE}/${DIR}`]: { ok: false, status: 403, body: 'rate limited' },
    });

    expect(await fetchSkillFiles(REC, { includeSupporting: true })).toBeNull();
  });

  it('returns null when SKILL.md is not found anywhere', async () => {
    stubFetch({});
    expect(await fetchSkillFiles(REC, { includeSupporting: true })).toBeNull();
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

    const files = expectFiles(await fetchSkillFiles(REC, { includeSupporting: true }));
    expect([...files.keys()].sort()).toEqual(['SKILL.md', 'ok.md'].sort());
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

    const files = expectFiles(await fetchSkillFiles(REC, { includeSupporting: true }));
    expect(files.size).toBeLessThanOrEqual(50);
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
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes nested supporting files from a successful install-time fetch', async () => {
    stubFetch({
      [`${RAW_BASE}/${DIR}/SKILL.md`]: { ok: true, body: SKILL_MD },
      [`${API_BASE}/${DIR}`]: {
        ok: true,
        body: [
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

    await installSkills([REC], ['claude'], new Map());

    const skillDir = join(dir, '.claude', 'skills', REC.slug);
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(SKILL_MD);
    expect(readFileSync(join(skillDir, 'references', 'chapter_01.md'), 'utf-8')).toBe(
      'chapter one',
    );
  });

  it('installs references/, scripts/, and binary assets/ across multiple platforms', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
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
          dirEntry({ name: 'scripts', path: `${DIR}/scripts`, type: 'dir', download_url: null }),
          dirEntry({ name: 'assets', path: `${DIR}/assets`, type: 'dir', download_url: null }),
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
      [`${API_BASE}/${DIR}/scripts`]: {
        ok: true,
        body: [
          dirEntry({
            name: 'setup.sh',
            path: `${DIR}/scripts/setup.sh`,
            download_url: `${RAW_BASE}/${DIR}/scripts/setup.sh`,
          }),
        ],
      },
      [`${API_BASE}/${DIR}/assets`]: {
        ok: true,
        body: [
          dirEntry({
            name: 'logo.png',
            path: `${DIR}/assets/logo.png`,
            download_url: `${RAW_BASE}/${DIR}/assets/logo.png`,
          }),
        ],
      },
      [`${RAW_BASE}/${DIR}/references/chapter_01.md`]: { ok: true, body: 'chapter one' },
      [`${RAW_BASE}/${DIR}/scripts/setup.sh`]: { ok: true, body: '#!/bin/sh\necho hi\n' },
      [`${RAW_BASE}/${DIR}/assets/logo.png`]: { ok: true, body: pngBytes },
    });

    await installSkills([REC], ['claude', 'codex'], new Map());

    for (const base of [join('.claude', 'skills'), join('.agents', 'skills')]) {
      const skillDir = join(dir, base, REC.slug);
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(SKILL_MD);
      expect(readFileSync(join(skillDir, 'references', 'chapter_01.md'), 'utf-8')).toBe(
        'chapter one',
      );
      expect(readFileSync(join(skillDir, 'scripts', 'setup.sh'), 'utf-8')).toBe(
        '#!/bin/sh\necho hi\n',
      );
      const png = readFileSync(join(skillDir, 'assets', 'logo.png'));
      expect(Buffer.compare(png, pngBytes)).toBe(0);
    }
  });

  it('falls back to search-time SKILL.md cache when install-time fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403 })),
    );

    const cache = new Map([['SKILL.md', Buffer.from(SKILL_MD)]]);
    await installSkills([REC], ['claude', 'codex'], new Map([[REC.slug, cache]]));

    for (const base of [join('.claude', 'skills'), join('.agents', 'skills')]) {
      expect(readFileSync(join(dir, base, REC.slug, 'SKILL.md'), 'utf-8')).toBe(SKILL_MD);
      expect(existsSync(join(dir, base, REC.slug, 'references'))).toBe(false);
    }
  });
});
