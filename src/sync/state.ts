import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CALIBER_DIR } from '../constants.js';
import type { ProviderId } from './types.js';

/**
 * Local sync bookkeeping. Lives under the gitignored `.caliber/` directory
 * because it is per-checkout state, not shared config: it records the hash of
 * every file sync last wrote, which is what lets a later run tell "Caliber
 * wrote this and nobody touched it" from "a human edited this by hand".
 *
 * Without it, sync would either clobber hand edits or refuse to ever update a
 * file it had already written.
 */

export const SYNC_STATE_FILE = 'sync-state.json';

export interface SyncState {
  version: 1;
  lastSync: string;
  source: ProviderId | null;
  /** Projected file path (repo-relative, POSIX separators) -> sha256 of what sync wrote. */
  files: Record<string, string>;
}

const EMPTY: SyncState = { version: 1, lastSync: '', source: null, files: {} };

function statePath(dir: string): string {
  return path.join(dir, CALIBER_DIR, SYNC_STATE_FILE);
}

/** Normalizes to a repo-relative POSIX key so state survives Windows/POSIX moves. */
export function stateKey(dir: string, filePath: string): string {
  return path.relative(dir, filePath).split(path.sep).join('/');
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function readSyncState(dir: string): SyncState {
  try {
    const raw = fs.readFileSync(statePath(dir), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return { ...EMPTY };
    return {
      version: 1,
      lastSync: typeof parsed.lastSync === 'string' ? parsed.lastSync : '',
      source: parsed.source ?? null,
      files:
        parsed.files && typeof parsed.files === 'object'
          ? (parsed.files as Record<string, string>)
          : {},
    };
  } catch {
    return { ...EMPTY };
  }
}

export function writeSyncState(dir: string, state: SyncState): void {
  try {
    const target = statePath(dir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Best-effort: losing state costs a conflict prompt next run, not correctness.
  }
}
