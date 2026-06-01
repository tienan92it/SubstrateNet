import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateCanvas } from '../../src/canvas/generate';
import { openKnowledgeDb, openCodeDb } from '../../src/db/connection';

function seed(know: any, code: any): void {
  // Code node so the project-map generator can resolve k_to_code -> nodes.
  code.prepare(`INSERT INTO nodes (id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('abc', 'function', 'createSession', 'src/sessions.ts::createSession', 'src/sessions.ts', 'typescript', 10, 20, 0, 0, Date.now());

  know.prepare(`INSERT INTO concepts (id,name,summary,domain,member_count,embedding) VALUES (?,?,?,?,?,NULL)`)
    .run('c1', 'session caching', 'use redis', 'architecture', 1);
  know.prepare(`INSERT INTO k_nodes (id,kind,title,summary,confidence,source,created_at,updated_at,cluster_id) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('f1', 'decision', 'pick redis', 'cross-instance shared store', 0.9, 'agent:decision', 1000, 1000, 'c1');
  know.prepare(`INSERT INTO k_nodes (id,kind,title,summary,confidence,source,created_at,updated_at,cluster_id) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('f2', 'business_rule', 'refund finality', 'final after processor succeeds', 0.85, 'agent:businessLogic', 2000, 2000, 'c1');
  know.prepare(`INSERT INTO k_to_code (k_node_id,code_node_id,code_file,weight) VALUES (?,?,?,?)`)
    .run('f1', 'abc', 'src/sessions.ts', 1);
}

describe('canvas generator', () => {
  it('writes all four canvas kinds with the inlined data placeholder replaced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-canvas-'));
    const know = openKnowledgeDb(root);
    const code = openCodeDb(root);
    seed(know, code);
    know.close();
    code.close();
    try {
      for (const kind of ['triage-audit', 'project-map', 'decision-timeline', 'business-logic']) {
        const path = await generateCanvas(root, kind);
        const content = readFileSync(path, 'utf8');
        expect(content).not.toContain('__SUBNET_'); // placeholder substituted
        expect(content).toContain('export default function');
      }
      const projectMap = readFileSync(join(root, '.substrate-net', 'canvas', 'project-map.canvas.tsx'), 'utf8');
      // session caching concept name should be inlined
      expect(projectMap).toContain('session caching');
      expect(projectMap).toContain('pick redis');
      expect(projectMap).toContain('src/sessions.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws for unknown canvas kind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-canvas-'));
    try {
      await expect(generateCanvas(root, 'nonsense')).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
