import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CursorAdapter, parseCursorEntry, slugForPath } from '../../src/ingest/cursor';

describe('CursorAdapter', () => {
  it('parses simple user/assistant entries', () => {
    const user = parseCursorEntry({
      role: 'user',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    expect(user).toEqual(expect.objectContaining({ role: 'user', text: 'hi' }));

    const asst = parseCursorEntry({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'hello there' }] },
    });
    expect(asst).toEqual(expect.objectContaining({ role: 'assistant', text: 'hello there' }));
  });

  it('captures tool calls with target paths', () => {
    const entry = parseCursorEntry({
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'reading file' },
          { type: 'tool_use', name: 'Read', input: { path: '/a/b.ts' } },
          { type: 'tool_result', content: 'file contents' },
        ],
      },
    });
    expect(entry?.toolCalls).toBeDefined();
    expect(entry!.toolCalls!).toHaveLength(1);
    expect(entry!.toolCalls![0].name).toBe('Read');
    expect(entry!.toolCalls![0].targetPaths).toEqual(['/a/b.ts']);
    expect(entry!.toolCalls![0].resultExcerpt).toBe('file contents');
  });

  it('computes the Cursor slug for an absolute path', () => {
    expect(slugForPath('/Users/me/Workspace/Foo')).toBe('Users-me-Workspace-Foo');
  });

  it('encodes non-alphanumeric chars (underscore, dot, runs) like Cursor does', () => {
    // underscore -> dash
    expect(slugForPath('/Users/antran/Workspace/kafi/k_one')).toBe('Users-antran-Workspace-kafi-k-one');
    // dot -> dash
    expect(slugForPath('/Users/antran/Workspace/kafi/dp-2.0')).toBe('Users-antran-Workspace-kafi-dp-2-0');
    // a run of separators (/.) collapses to a single dash
    expect(slugForPath('/Users/antran/Desktop/Workspace/.nosync/kafi/kafi-gh'))
      .toBe('Users-antran-Desktop-Workspace-nosync-kafi-kafi-gh');
    // .code-workspace file
    expect(slugForPath('/Users/antran/Workspace/kafi/k-wealth.code-workspace'))
      .toBe('Users-antran-Workspace-kafi-k-wealth-code-workspace');
  });

  it('discovers transcripts under a fake projects root', async () => {
    const fakeCursorRoot = mkdtempSync(join(tmpdir(), 'cursor-root-'));
    const projectPath = '/tmp/MyProject';
    const slug = slugForPath(projectPath);
    const tdir = join(fakeCursorRoot, slug, 'agent-transcripts', 'sess-1');
    mkdirSync(tdir, { recursive: true });
    writeFileSync(
      join(tdir, 'sess-1.jsonl'),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'a' }] } }) + '\n' +
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'b' }] } }) + '\n',
    );
    try {
      const adapter = new CursorAdapter({ root: fakeCursorRoot });
      const refs = [];
      for await (const r of adapter.discover(projectPath)) refs.push(r);
      expect(refs).toHaveLength(1);
      expect(refs[0].sourceId).toBe('sess-1');

      const turns = [];
      for await (const t of adapter.read(refs[0], 0)) turns.push(t.turn);
      expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    } finally {
      rmSync(fakeCursorRoot, { recursive: true, force: true });
    }
  });
});
