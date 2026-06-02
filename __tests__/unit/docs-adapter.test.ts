import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DocsAdapter, chunkMarkdown, isDocFile } from '../../src/ingest/docs.js';

describe('chunkMarkdown', () => {
  it('splits on headings and captures section labels', () => {
    const md = `# Overview\nThis project handles payments and settlement flows for merchants.\n\n## Rules\nRefunds older than 180 days must use store credit instead of cash.`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].heading).toBe('Overview');
    expect(chunks.find((c) => c.heading === 'Rules')?.text).toContain('store credit');
  });

  it('drops trivial fragments', () => {
    expect(chunkMarkdown('# x\n\n')).toEqual([]);
  });
});

describe('isDocFile', () => {
  it('accepts markdown + readme, rejects code', () => {
    expect(isDocFile('/p/docs/spec.md', '/p/docs', '/p')).toBe(true);
    expect(isDocFile('/p/README', '/p', '/p')).toBe(true);
    expect(isDocFile('/p/src/index.ts', '/p/src', '/p')).toBe(false);
  });

  it('accepts .txt only inside an ADR directory', () => {
    expect(isDocFile('/p/decisions/0001.txt', '/p/decisions', '/p')).toBe(true);
    expect(isDocFile('/p/logs/out.txt', '/p/logs', '/p')).toBe(false);
  });
});

describe('DocsAdapter', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'subnet-docs-'));
    writeFileSync(
      join(dir, 'README.md'),
      '# Title\nA fintech lending platform that originates loans, runs KYC, and disburses funds to borrowers.',
    );
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'brd.md'), '# BRD\n## Actors\nBorrower applies for a loan.');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'ignored.md'), '# Nope');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('discovers in-repo docs and skips node_modules', async () => {
    const adapter = new DocsAdapter();
    const ids: string[] = [];
    for await (const ref of adapter.discover(dir)) {
      expect(ref.agent).toBe('docs');
      ids.push(ref.sourceId);
    }
    expect(ids).toContain('README.md');
    expect(ids).toContain(join('docs', 'brd.md'));
    expect(ids.some((i) => i.includes('node_modules'))).toBe(false);
  });

  it('reads a doc as user/assistant turn pairs', async () => {
    const adapter = new DocsAdapter();
    let ref;
    for await (const r of adapter.discover(dir)) { if (r.sourceId === 'README.md') ref = r; }
    expect(ref).toBeTruthy();
    const turns: string[] = [];
    for await (const { turn } of adapter.read(ref!, 0)) turns.push(turn.role);
    // At least one (user, assistant) pair.
    expect(turns[0]).toBe('user');
    expect(turns[1]).toBe('assistant');
  });
});
