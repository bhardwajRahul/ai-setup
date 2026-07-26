import fs from 'fs';
import path from 'path';
import { normalizeBullet, hasTypePrefix, isSimilarLearning, extractScope } from './utils.js';
import { AUTH_DIR, PERSONAL_LEARNINGS_FILE, CALIBER_DIR } from '../constants.js';

const LEARNINGS_FILE = 'CALIBER_LEARNINGS.md';
const LEARNINGS_HEADER = `# Caliber Learnings

Accumulated patterns and anti-patterns from development sessions.
Auto-managed by [caliber](https://github.com/caliber-ai-org/ai-setup) — do not edit manually.

`;

const PERSONAL_LEARNINGS_HEADER = `# Personal Learnings

Developer-specific patterns and preferences.
Auto-managed by [caliber](https://github.com/caliber-ai-org/ai-setup) — do not edit manually.

`;

// Legacy markers for migration from inline CLAUDE.md section
const LEARNED_START = '<!-- caliber:learned -->';
const LEARNED_END = '<!-- /caliber:learned -->';

/** Default max learned items to retain — keeps newest when exceeded. */
const DEFAULT_MAX_LEARNED_ITEMS = 30;

/** Cap is configurable via CALIBER_MAX_LEARNINGS (#226). */
function getMaxLearnedItems(): number {
  const fromEnv = Number(process.env.CALIBER_MAX_LEARNINGS);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_LEARNED_ITEMS;
}

/** Evicted project learnings land here instead of being silently deleted (#226). */
export const LEARNINGS_ARCHIVE_FILE = path.join(CALIBER_DIR, 'learnings-archive.md');
const PERSONAL_LEARNINGS_ARCHIVE_FILE = PERSONAL_LEARNINGS_FILE.replace(/\.md$/, '-archive.md');

const ARCHIVE_HEADER = `# Caliber Learnings Archive

Entries rotated out of the learnings file when it hit its cap.
Restore any bullet you still need with \`caliber learn add "<bullet>"\`.
`;

function appendToArchive(archivePath: string, evicted: string[], mode?: number): void {
  const dir = path.dirname(archivePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const header = fs.existsSync(archivePath) ? '' : ARCHIVE_HEADER;
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(archivePath, `${header}\n## Evicted ${date}\n\n${evicted.join('\n')}\n`);
  // Personal learnings are 0o600 — their archive must not be more readable
  if (mode) fs.chmodSync(archivePath, mode);
}

export interface LearnedSkill {
  name: string;
  description: string;
  content: string;
  isNew: boolean;
}

export interface LearnedUpdate {
  claudeMdLearnedSection: string | null;
  skills: LearnedSkill[] | null;
}

export interface WriteResult {
  written: string[];
  newItemCount: number;
  newItems: string[];
  personalItemCount: number;
  personalItems: string[];
  /** Project learnings rotated out at the cap and moved to the archive file. */
  evictedItems: string[];
}

export function writeLearnedContent(update: LearnedUpdate): WriteResult {
  const written: string[] = [];
  let newItemCount = 0;
  let newItems: string[] = [];
  let personalItemCount = 0;
  let personalItems: string[] = [];
  let evictedItems: string[] = [];

  if (update.claudeMdLearnedSection) {
    const bullets = parseBullets(update.claudeMdLearnedSection);
    const projectBullets = bullets.filter((b) => extractScope(b) === 'project');
    const personalBullets = bullets.filter((b) => extractScope(b) === 'personal');

    if (projectBullets.length > 0) {
      const result = writeLearnedSection(projectBullets.join('\n'));
      newItemCount = result.newCount;
      newItems = result.newItems;
      evictedItems = result.evicted;
      written.push(LEARNINGS_FILE);
    }

    if (personalBullets.length > 0) {
      const result = writePersonalLearnedSection(personalBullets.join('\n'));
      personalItemCount = result.newCount;
      personalItems = result.newItems;
      written.push(PERSONAL_LEARNINGS_FILE);
    }
  }

  if (update.skills?.length) {
    for (const skill of update.skills) {
      const skillPath = writeLearnedSkill(skill);
      written.push(skillPath);
    }
  }

  return { written, newItemCount, newItems, personalItemCount, personalItems, evictedItems };
}

function parseBullets(content: string): string[] {
  const lines = content.split('\n');
  const bullets: string[] = [];
  let current = '';

  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (current) bullets.push(current);
      current = line;
    } else if (current && line.trim() && !line.startsWith('#')) {
      current += '\n' + line;
    } else {
      if (current) bullets.push(current);
      current = '';
    }
  }
  if (current) bullets.push(current);
  return bullets;
}

function deduplicateLearnedItems(
  existing: string | null,
  incoming: string,
): { merged: string; newCount: number; newItems: string[]; evicted: string[] } {
  const existingBullets = existing ? parseBullets(existing) : [];
  const incomingBullets = parseBullets(incoming);
  const merged = [...existingBullets];
  const newItems: string[] = [];

  for (const bullet of incomingBullets) {
    const norm = normalizeBullet(bullet);
    if (!norm) continue;
    const dupIdx = merged.findIndex((e) => isSimilarLearning(bullet, e));
    if (dupIdx !== -1) {
      // Upgrade untyped bullet to typed version
      if (hasTypePrefix(bullet) && !hasTypePrefix(merged[dupIdx])) {
        merged[dupIdx] = bullet;
      }
    } else {
      merged.push(bullet);
      newItems.push(bullet);
    }
  }

  const max = getMaxLearnedItems();
  const evicted = merged.length > max ? merged.slice(0, merged.length - max) : [];
  const capped = merged.length > max ? merged.slice(-max) : merged;
  return { merged: capped.join('\n'), newCount: newItems.length, newItems, evicted };
}

function writeLearnedSectionTo(
  filePath: string,
  header: string,
  existing: string | null,
  incoming: string,
  options?: { mode?: number; archivePath?: string },
): { newCount: number; newItems: string[]; evicted: string[] } {
  const { merged, newCount, newItems, evicted } = deduplicateLearnedItems(existing, incoming);
  fs.writeFileSync(filePath, header + merged + '\n');
  if (options?.mode) fs.chmodSync(filePath, options.mode);
  if (evicted.length > 0 && options?.archivePath) {
    try {
      appendToArchive(options.archivePath, evicted, options.mode);
    } catch {
      /* archiving is best-effort — never block the learnings write */
    }
  }
  return { newCount, newItems, evicted };
}

function writeLearnedSection(content: string): {
  newCount: number;
  newItems: string[];
  evicted: string[];
} {
  return writeLearnedSectionTo(LEARNINGS_FILE, LEARNINGS_HEADER, readLearnedSection(), content, {
    archivePath: LEARNINGS_ARCHIVE_FILE,
  });
}

function writeLearnedSkill(skill: LearnedSkill): string {
  const skillDir = path.join('.claude', 'skills', skill.name);
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

  const skillPath = path.join(skillDir, 'SKILL.md');

  if (!skill.isNew && fs.existsSync(skillPath)) {
    const existing = fs.readFileSync(skillPath, 'utf-8');
    fs.writeFileSync(skillPath, existing.trimEnd() + '\n\n' + skill.content);
  } else {
    const frontmatter = [
      '---',
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(skillPath, frontmatter + skill.content);
  }

  return skillPath;
}

function writePersonalLearnedSection(content: string): { newCount: number; newItems: string[] } {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  return writeLearnedSectionTo(
    PERSONAL_LEARNINGS_FILE,
    PERSONAL_LEARNINGS_HEADER,
    readPersonalLearnings(),
    content,
    {
      mode: 0o600,
      archivePath: PERSONAL_LEARNINGS_ARCHIVE_FILE,
    },
  );
}

export function addLearning(
  bullet: string,
  scope: 'project' | 'personal' = 'project',
): { file: string; added: boolean } {
  const formatted = bullet.startsWith('- ') ? bullet : `- ${bullet}`;

  if (scope === 'personal') {
    const result = writePersonalLearnedSection(formatted);
    return { file: PERSONAL_LEARNINGS_FILE, added: result.newCount > 0 };
  }

  const result = writeLearnedSection(formatted);
  return { file: LEARNINGS_FILE, added: result.newCount > 0 };
}

export function readPersonalLearnings(): string | null {
  if (!fs.existsSync(PERSONAL_LEARNINGS_FILE)) return null;
  const content = fs.readFileSync(PERSONAL_LEARNINGS_FILE, 'utf-8');
  const bullets = content
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .join('\n');
  return bullets || null;
}

export function readLearnedSection(): string | null {
  if (fs.existsSync(LEARNINGS_FILE)) {
    const content = fs.readFileSync(LEARNINGS_FILE, 'utf-8');
    const bullets = content
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .join('\n');
    return bullets || null;
  }

  // Migration fallback: check old inline section in CLAUDE.md
  const claudeMdPath = 'CLAUDE.md';
  if (!fs.existsSync(claudeMdPath)) return null;

  const content = fs.readFileSync(claudeMdPath, 'utf-8');
  const startIdx = content.indexOf(LEARNED_START);
  const endIdx = content.indexOf(LEARNED_END);

  if (startIdx === -1 || endIdx === -1) return null;

  return content.slice(startIdx + LEARNED_START.length, endIdx).trim() || null;
}

/** Migrate learned content from inline CLAUDE.md section to CALIBER_LEARNINGS.md. */
export function migrateInlineLearnings(): boolean {
  if (fs.existsSync(LEARNINGS_FILE)) return false;

  const claudeMdPath = 'CLAUDE.md';
  if (!fs.existsSync(claudeMdPath)) return false;

  const content = fs.readFileSync(claudeMdPath, 'utf-8');
  const startIdx = content.indexOf(LEARNED_START);
  const endIdx = content.indexOf(LEARNED_END);

  if (startIdx === -1 || endIdx === -1) return false;

  const section = content.slice(startIdx + LEARNED_START.length, endIdx).trim();
  if (!section) return false;

  fs.writeFileSync(LEARNINGS_FILE, LEARNINGS_HEADER + section + '\n');

  const cleaned = content.slice(0, startIdx) + content.slice(endIdx + LEARNED_END.length);
  fs.writeFileSync(claudeMdPath, cleaned.replace(/\n{3,}/g, '\n\n').trim() + '\n');

  return true;
}
