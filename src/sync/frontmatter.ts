/**
 * Minimal YAML frontmatter reader/writer for skill and rule documents.
 *
 * Deliberately not a YAML library: skill frontmatter across Claude, Cursor,
 * Codex and OpenCode is a flat map of scalars plus the occasional string list
 * (`paths:`), and pulling in a parser to handle that would be the only reason
 * Caliber needed one. Anything it cannot model is preserved verbatim in
 * `extra`, so a round-trip never loses keys it did not understand.
 */

export interface Frontmatter {
  values: Record<string, string>;
  lists: Record<string, string[]>;
  /** Lines that were neither `key: value` nor a list, kept for round-tripping. */
  extra: string[];
}

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
}

const DELIMITER = '---';

export function parseDocument(content: string): ParsedDocument {
  const empty: Frontmatter = { values: {}, lists: {}, extra: [] };
  const normalized = content.replace(/^\uFEFF/, '');

  if (!normalized.startsWith(`${DELIMITER}\n`) && !normalized.startsWith(`${DELIMITER}\r\n`)) {
    return { frontmatter: empty, body: normalized };
  }

  const lines = normalized.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === DELIMITER) {
      end = i;
      break;
    }
  }
  // Unterminated frontmatter: treat the whole thing as body rather than guess.
  if (end === -1) return { frontmatter: empty, body: normalized };

  const frontmatter: Frontmatter = { values: {}, lists: {}, extra: [] };
  let currentList: string | null = null;

  for (const raw of lines.slice(1, end)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentList) {
      frontmatter.lists[currentList].push(stripQuotes(listItem[1].trim()));
      continue;
    }

    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      frontmatter.extra.push(line);
      currentList = null;
      continue;
    }

    const [, key, value] = pair;
    if (value === '') {
      // `key:` with nothing after it opens a list block.
      currentList = key;
      frontmatter.lists[key] = [];
      continue;
    }

    frontmatter.values[key] = stripQuotes(value.trim());
    currentList = null;
  }

  return {
    frontmatter,
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, ''),
  };
}

export function serializeDocument(frontmatter: Frontmatter, body: string): string {
  const lines: string[] = [DELIMITER];

  for (const [key, value] of Object.entries(frontmatter.values)) {
    lines.push(`${key}: ${needsQuoting(value) ? JSON.stringify(value) : value}`);
  }
  for (const [key, values] of Object.entries(frontmatter.lists)) {
    lines.push(`${key}:`);
    for (const value of values) {
      lines.push(`  - ${needsQuoting(value) ? JSON.stringify(value) : value}`);
    }
  }
  lines.push(...frontmatter.extra);
  lines.push(DELIMITER);

  // Blank line after the closing delimiter, matching the existing writers.
  return `${lines.join('\n')}\n\n${body.replace(/^\n+/, '')}`;
}

/** Builds a document from a flat field map, dropping empty values. */
export function buildDocument(
  values: Record<string, string | undefined>,
  lists: Record<string, string[] | undefined>,
  body: string,
): string {
  const frontmatter: Frontmatter = { values: {}, lists: {}, extra: [] };

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') frontmatter.values[key] = value;
  }
  for (const [key, value] of Object.entries(lists)) {
    if (value && value.length > 0) frontmatter.lists[key] = value;
  }

  return serializeDocument(frontmatter, body);
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = value.slice(1, -1);
      return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
    }
  }
  return value;
}

/**
 * Quote only when a bare scalar would change meaning: a leading indicator
 * character, or a `: ` that would read as a nested key.
 */
function needsQuoting(value: string): boolean {
  if (value === '') return true;
  if (/^[\s>|*&!%@`#-]/.test(value)) return true;
  if (/[:]\s/.test(value)) return true;
  if (/\n/.test(value)) return true;
  return false;
}
