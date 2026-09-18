import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

export type LocalItemType = 'mcp' | 'rule' | 'skill' | 'plugin' | 'config';
export type LocalPlatform = 'claude' | 'cursor' | 'codex' | 'opencode' | 'github-copilot';

export interface LocalItem {
  type: LocalItemType;
  platform: LocalPlatform;
  name: string;
  contentHash: string;
  path: string;
}

export interface PlatformDetection {
  claude: boolean;
  cursor: boolean;
  codex: boolean;
  opencode: boolean;
}

export function detectPlatforms(): PlatformDetection {
  const home = os.homedir();
  return {
    claude: fs.existsSync(path.join(home, '.claude')),
    cursor: fs.existsSync(getCursorConfigDir()),
    codex: fs.existsSync(path.join(home, '.codex')),
    opencode: fs.existsSync(path.join(home, '.config', 'opencode')),
  };
}

/**
 * Scans a skills directory for both supported layouts:
 *   - `<skills>/<name>/SKILL.md` — what every Caliber writer produces, and the
 *     layout Claude Code, Cursor, Codex and OpenCode actually load.
 *   - `<skills>/<name>.md` — flat files, still read so older vaults and
 *     hand-rolled setups keep scanning.
 *
 * Directory detection goes through `existsSync` on the inner SKILL.md rather
 * than `withFileTypes`, which keeps it working against `fs` mocks that return
 * plain strings from `readdirSync`.
 */
function scanSkillsDir(skillsDir: string, platform: LocalPlatform, label: string): LocalItem[] {
  if (!fs.existsSync(skillsDir)) return [];

  const items: LocalItem[] = [];
  try {
    for (const entry of fs.readdirSync(skillsDir)) {
      const name = String(entry);
      const nestedPath = path.join(skillsDir, name, 'SKILL.md');

      if (fs.existsSync(nestedPath)) {
        items.push({
          type: 'skill',
          platform,
          name: `${name}/SKILL.md`,
          contentHash: hashFile(nestedPath),
          path: nestedPath,
        });
        continue;
      }

      if (name.endsWith('.md')) {
        const flatPath = path.join(skillsDir, name);
        items.push({
          type: 'skill',
          platform,
          name,
          contentHash: hashFile(flatPath),
          path: flatPath,
        });
      }
    }
  } catch (error) {
    warnScanSkip(label, error);
  }
  return items;
}

/** Scans a rules directory for files with any of `extensions`. */
function scanRulesDir(
  rulesDir: string,
  platform: LocalPlatform,
  extensions: string[],
  label: string,
): LocalItem[] {
  if (!fs.existsSync(rulesDir)) return [];

  const items: LocalItem[] = [];
  try {
    for (const entry of fs.readdirSync(rulesDir)) {
      const name = String(entry);
      if (!extensions.some((ext) => name.endsWith(ext))) continue;
      const filePath = path.join(rulesDir, name);
      items.push({
        type: 'rule',
        platform,
        name,
        contentHash: hashFile(filePath),
        path: filePath,
      });
    }
  } catch (error) {
    warnScanSkip(label, error);
  }
  return items;
}

/** Scans an `mcpServers` map out of a JSON config file. */
function scanMcpJson(mcpPath: string, platform: LocalPlatform, label: string): LocalItem[] {
  if (!fs.existsSync(mcpPath)) return [];

  const items: LocalItem[] = [];
  try {
    const mcpJson = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    if (mcpJson.mcpServers) {
      for (const name of Object.keys(mcpJson.mcpServers)) {
        items.push({
          type: 'mcp',
          platform,
          name,
          contentHash: hashJson(mcpJson.mcpServers[name]),
          path: mcpPath,
        });
      }
    }
  } catch (error) {
    warnScanSkip(label, error);
  }
  return items;
}

/**
 * Plugins enabled for this project. Claude Code records them in
 * `.claude/settings.json` as `enabledPlugins: { "<plugin>@<marketplace>": true }`;
 * only the enabled ones are reported.
 */
function scanClaudePlugins(dir: string): LocalItem[] {
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return [];

  const items: LocalItem[] = [];
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const enabled = settings.enabledPlugins;
    if (enabled && typeof enabled === 'object') {
      for (const [name, value] of Object.entries(enabled)) {
        if (value === false) continue;
        items.push({
          type: 'plugin',
          platform: 'claude',
          name,
          contentHash: hashJson({ name, enabled: value }),
          path: settingsPath,
        });
      }
    }
  } catch (error) {
    warnScanSkip('.claude/settings.json', error);
  }
  return items;
}

function scanFile(
  filePath: string,
  type: LocalItemType,
  platform: LocalPlatform,
  name: string,
): LocalItem[] {
  if (!fs.existsSync(filePath)) return [];
  return [{ type, platform, name, contentHash: hashFile(filePath), path: filePath }];
}

export function scanLocalState(dir: string): LocalItem[] {
  return [
    // Claude
    ...scanFile(path.join(dir, 'CLAUDE.md'), 'rule', 'claude', 'CLAUDE.md'),
    ...scanSkillsDir(path.join(dir, '.claude', 'skills'), 'claude', '.claude/skills'),
    ...scanRulesDir(path.join(dir, '.claude', 'rules'), 'claude', ['.md'], '.claude/rules'),
    ...scanClaudePlugins(dir),
    ...scanMcpJson(path.join(dir, '.mcp.json'), 'claude', '.mcp.json'),

    // Codex
    ...scanFile(path.join(dir, 'AGENTS.md'), 'rule', 'codex', 'AGENTS.md'),
    ...scanSkillsDir(path.join(dir, '.agents', 'skills'), 'codex', '.agents/skills'),

    // OpenCode
    ...scanSkillsDir(path.join(dir, '.opencode', 'skills'), 'opencode', '.opencode/skills'),

    // Cursor
    ...scanFile(path.join(dir, '.cursorrules'), 'rule', 'cursor', '.cursorrules'),
    ...scanRulesDir(path.join(dir, '.cursor', 'rules'), 'cursor', ['.mdc'], '.cursor/rules'),
    ...scanSkillsDir(path.join(dir, '.cursor', 'skills'), 'cursor', '.cursor/skills'),
    ...scanMcpJson(path.join(dir, '.cursor', 'mcp.json'), 'cursor', '.cursor/mcp.json'),

    // GitHub Copilot
    ...scanFile(
      path.join(dir, '.github', 'copilot-instructions.md'),
      'rule',
      'github-copilot',
      'copilot-instructions.md',
    ),
    ...scanRulesDir(
      path.join(dir, '.github', 'instructions'),
      'github-copilot',
      ['.instructions.md'],
      '.github/instructions',
    ),
  ];
}

export interface ServerItem {
  id: string;
  type: string;
  platform: string;
  name: string;
  content_hash: string;
  content: Record<string, unknown>;
}

export function compareState(serverItems: ServerItem[], localItems: LocalItem[]) {
  const installed: Array<{ server: ServerItem; local: LocalItem }> = [];
  const missing: ServerItem[] = [];
  const outdated: Array<{ server: ServerItem; local: LocalItem }> = [];
  const extra: LocalItem[] = [];

  const localMap = new Map<string, LocalItem>();
  for (const item of localItems) {
    localMap.set(`${item.type}:${item.platform}:${item.name}`, item);
  }

  for (const server of serverItems) {
    const key = `${server.type}:${server.platform}:${server.name}`;
    const local = localMap.get(key);
    localMap.delete(key);

    if (!local) {
      missing.push(server);
    } else if (local.contentHash !== server.content_hash) {
      outdated.push({ server, local });
    } else {
      installed.push({ server, local });
    }
  }

  for (const local of localMap.values()) {
    extra.push(local);
  }

  return { installed, missing, outdated, extra };
}

function hashFile(filePath: string): string {
  const text = fs.readFileSync(filePath, 'utf-8');
  return crypto.createHash('sha256').update(JSON.stringify({ text })).digest('hex');
}

function hashJson(obj: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function warnScanSkip(target: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`Warning: ${target} scan skipped (${message})`);
}

function getCursorConfigDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Cursor');
  }
  return path.join(home, '.config', 'Cursor');
}
