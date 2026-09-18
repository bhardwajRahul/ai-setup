import { describe, it, expect } from 'vitest';
import { buildDocument, parseDocument, serializeDocument } from '../frontmatter.js';

describe('parseDocument', () => {
  it('parses scalar values and a list, and strips frontmatter from the body', () => {
    const { frontmatter, body } = parseDocument(
      [
        '---',
        'name: deploy',
        'description: Ship it.',
        'paths:',
        '  - src/**',
        '  - test/**',
        '---',
        '',
        '# Deploy',
        'body text',
      ].join('\n'),
    );

    expect(frontmatter.values).toEqual({ name: 'deploy', description: 'Ship it.' });
    expect(frontmatter.lists.paths).toEqual(['src/**', 'test/**']);
    expect(body).toBe('# Deploy\nbody text');
  });

  it('treats content with no frontmatter as all body', () => {
    const { frontmatter, body } = parseDocument('# Just a heading\n');
    expect(frontmatter.values).toEqual({});
    expect(body).toBe('# Just a heading\n');
  });

  it('treats unterminated frontmatter as body rather than guessing', () => {
    const input = '---\nname: broken\n# no closing delimiter\n';
    expect(parseDocument(input).body).toBe(input);
  });

  it('strips quotes from quoted values', () => {
    const { frontmatter } = parseDocument('---\ndescription: "Has: a colon"\n---\n\nbody');
    expect(frontmatter.values.description).toBe('Has: a colon');
  });

  it('keeps unrecognised lines so a round-trip does not lose them', () => {
    const { frontmatter } = parseDocument('---\nname: x\nnested:\n  deep: 1\n---\n\nbody');
    expect(frontmatter.values.name).toBe('x');
    expect(frontmatter.lists.nested).toEqual([]);
    expect(frontmatter.extra.length + Object.keys(frontmatter.lists).length).toBeGreaterThan(0);
  });
});

describe('serializeDocument', () => {
  it('puts a blank line between the closing delimiter and the body', () => {
    const output = serializeDocument({ values: { name: 'x' }, lists: {}, extra: [] }, '# Title');
    expect(output).toBe('---\nname: x\n---\n\n# Title');
  });

  it('round-trips a document without drift', () => {
    const original = '---\nname: deploy\ndescription: Ship it.\n---\n\n# Deploy\n\nSteps.\n';
    const { frontmatter, body } = parseDocument(original);
    expect(serializeDocument(frontmatter, body)).toBe(original);
  });

  it('quotes values that would otherwise change meaning', () => {
    const output = serializeDocument(
      { values: { description: 'Key: value pairs' }, lists: {}, extra: [] },
      'body',
    );
    expect(output).toContain('description: "Key: value pairs"');
    expect(parseDocument(output).frontmatter.values.description).toBe('Key: value pairs');
  });
});

describe('buildDocument', () => {
  it('drops empty and undefined fields', () => {
    const output = buildDocument(
      { name: 'x', description: '', origin: undefined },
      { paths: [] },
      'body',
    );
    expect(output).toBe('---\nname: x\n---\n\nbody');
  });

  it('emits list fields when present', () => {
    const output = buildDocument({ name: 'x' }, { paths: ['a/**'] }, 'body');
    expect(output).toBe('---\nname: x\npaths:\n  - a/**\n---\n\nbody');
  });
});
