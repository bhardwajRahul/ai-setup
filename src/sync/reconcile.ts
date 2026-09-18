import fs from 'fs';
import path from 'path';
import { detectProviders, getAdapter } from './adapters.js';
import { hashContent, readSyncState, stateKey, writeSyncState, type SyncState } from './state.js';
import { itemKey, PROVIDER_IDS, type CanonicalItem, type ProviderId } from './types.js';

export interface SyncOptions {
  dir?: string;
  /** Provider to read canonical state from. Auto-detected when omitted. */
  from?: ProviderId;
  /** Providers to write. Defaults to every detected provider except the source. */
  to?: ProviderId[];
  /** Compute the plan without touching the filesystem. */
  dryRun?: boolean;
  /** Overwrite files that were edited by hand since sync last wrote them. */
  force?: boolean;
  /** Extra items to sync alongside the source provider's, e.g. builtin plugins. */
  extraItems?: CanonicalItem[];
}

export interface SyncConflict {
  path: string;
  provider: ProviderId;
  reason: string;
}

export interface SyncResult {
  source: ProviderId | null;
  targets: ProviderId[];
  items: CanonicalItem[];
  written: string[];
  unchanged: string[];
  conflicts: SyncConflict[];
  skipped: Array<{ provider: ProviderId; item: string; reason: string }>;
  dryRun: boolean;
}

/**
 * Picks the provider to treat as the source of truth.
 *
 * The choice is **sticky**: once a source has been recorded it is reused for as
 * long as that provider is still present. This matters more than it looks — the
 * first sync copies the source's items into every other provider, so afterwards
 * the targets hold at least as many items as the source. A purely count-based
 * pick would flip to a target on the second run and start writing the original
 * source's files back over themselves.
 *
 * Only when nothing is recorded does it fall back to the provider holding the
 * most items, with Claude winning ties as the richest format (the only one with
 * skills, rules, plugins and MCP all at once).
 */
export function pickSource(dir: string, recorded?: ProviderId | null): ProviderId | null {
  const detected = detectProviders(dir);
  if (detected.length === 0) return null;

  if (recorded && detected.some((adapter) => adapter.id === recorded)) return recorded;

  let best: { id: ProviderId; count: number } | null = null;
  for (const adapter of detected) {
    const count = adapter.read(dir).length;
    if (!best || count > best.count || (count === best.count && adapter.id === 'claude')) {
      best = { id: adapter.id, count };
    }
  }
  return best?.id ?? null;
}

/** Recursively merges `patch` into `base`, preserving keys neither side owns. */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Decides what to do with one projected file.
 *
 * - absent            -> write
 * - identical         -> leave alone
 * - changed, ours     -> write (sync wrote it and nobody has touched it since)
 * - changed, foreign  -> conflict, unless `force`
 */
function classify(
  filePath: string,
  content: string,
  dir: string,
  state: SyncState,
  force: boolean,
): 'write' | 'unchanged' | 'conflict' {
  if (!fs.existsSync(filePath)) return 'write';

  let current: string;
  try {
    current = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 'conflict';
  }

  if (current === content) return 'unchanged';
  if (force) return 'write';

  const recorded = state.files[stateKey(dir, filePath)];
  return recorded && recorded === hashContent(current) ? 'write' : 'conflict';
}

export function sync(options: SyncOptions = {}): SyncResult {
  const dir = options.dir ?? process.cwd();
  const dryRun = !!options.dryRun;
  const force = !!options.force;

  const state = readSyncState(dir);
  const source = options.from ?? pickSource(dir, state.source);

  const result: SyncResult = {
    source,
    targets: [],
    items: [],
    written: [],
    unchanged: [],
    conflicts: [],
    skipped: [],
    dryRun,
  };

  if (!source) return result;

  const extraItems = options.extraItems ?? [];
  // Later items win, so an explicitly supplied plugin overrides a stale copy the
  // source provider still has on disk.
  const deduped = new Map<string, CanonicalItem>();
  for (const item of [...getAdapter(source).read(dir), ...extraItems]) {
    deduped.set(itemKey(item), item);
  }
  result.items = [...deduped.values()];

  // The source provider is still a target, but only for items Caliber itself
  // supplies (builtin plugins). Projecting its own items back at it would
  // reformat the very files the user authored, and report them as conflicts.
  const targets = options.to ?? PROVIDER_IDS;
  const nextFiles: Record<string, string> = { ...state.files };

  for (const id of targets) {
    const adapter = getAdapter(id);
    // Only write providers that are actually set up, unless asked explicitly.
    if (!options.to && !adapter.detect(dir)) continue;
    result.targets.push(id);

    const projection = adapter.project(id === source ? extraItems : result.items, dir);

    // Two items can legitimately project to the same path — a builtin plugin's
    // skill and the copy of it already read back from a provider. Identical
    // content either way; collapse them so the report does not double-count.
    const byPath = new Map<string, (typeof projection.files)[number]>();
    for (const file of projection.files) byPath.set(file.path, file);
    projection.files = [...byPath.values()];

    for (const { item, reason } of projection.skipped) {
      result.skipped.push({ provider: id, item: itemKey(item), reason });
    }

    for (const file of projection.files) {
      const action = classify(file.path, file.content, dir, state, force);

      if (action === 'unchanged') {
        result.unchanged.push(file.path);
        nextFiles[stateKey(dir, file.path)] = hashContent(file.content);
        continue;
      }
      if (action === 'conflict') {
        result.conflicts.push({
          path: file.path,
          provider: id,
          reason: 'edited by hand since Caliber last wrote it — rerun with --force to overwrite',
        });
        continue;
      }

      if (!dryRun) {
        fs.mkdirSync(path.dirname(file.path), { recursive: true });
        fs.writeFileSync(file.path, file.content);
      }
      result.written.push(file.path);
      nextFiles[stateKey(dir, file.path)] = hashContent(file.content);
    }

    for (const merge of projection.merges) {
      let base: Record<string, unknown> = {};
      try {
        if (fs.existsSync(merge.path)) {
          const parsed = JSON.parse(fs.readFileSync(merge.path, 'utf-8'));
          if (parsed && typeof parsed === 'object') base = parsed as Record<string, unknown>;
        }
      } catch {
        result.conflicts.push({
          path: merge.path,
          provider: id,
          reason: 'file is not valid JSON — fix or delete it, then rerun',
        });
        continue;
      }

      const merged = deepMerge(base, merge.merge);
      const content = `${JSON.stringify(merged, null, 2)}\n`;
      const existing = fs.existsSync(merge.path) ? fs.readFileSync(merge.path, 'utf-8') : null;

      if (existing === content) {
        result.unchanged.push(merge.path);
        continue;
      }
      if (!dryRun) {
        fs.mkdirSync(path.dirname(merge.path), { recursive: true });
        fs.writeFileSync(merge.path, content);
      }
      result.written.push(merge.path);
      nextFiles[stateKey(dir, merge.path)] = hashContent(content);
    }
  }

  if (!dryRun) {
    writeSyncState(dir, {
      version: 1,
      lastSync: new Date().toISOString(),
      source,
      files: nextFiles,
    });
  }

  return result;
}
