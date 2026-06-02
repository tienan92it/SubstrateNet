/**
 * Hybrid code-graph tests (deterministic, no LLM):
 *   - FileAnalyzer / ArchitectureAnalyzer / DomainAnalyzer postprocess discipline
 *   - analyze pipeline incremental skip (unchanged content_hash → no work)
 *   - dashboard snapshot shape (file nodes, file→file edges, domains, search)
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCodeDb, openKnowledgeDb } from '../../src/db/connection';
import { FILE_ANALYZER_AGENT } from '../../src/agents/file-analyzer';
import { ARCHITECTURE_ANALYZER_AGENT } from '../../src/agents/architecture-analyzer';
import { DOMAIN_ANALYZER_AGENT } from '../../src/agents/domain-analyzer';
import { analyzeWithDbs, upsertFileAnalysis } from '../../src/pipeline/analyze-code';
import { buildSnapshot } from '../../src/dashboard/snapshot';
import { DEFAULT_CONFIG } from '../../src/config';

describe('FileAnalyzer postprocess', () => {
  it('normalizes an invalid layer to "other" and clamps tags/concepts', () => {
    const post = FILE_ANALYZER_AGENT.postprocess!(
      {
        summary: '  handles auth  ',
        layer: 'backend' as any,            // invalid → other
        tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        concepts: ['x', 'y', 'z', 'p', 'q', 'r'],
      },
      { payload: { path: 'f.ts', language: 'ts', defs: [], imports: [], calls: [], sourceSlice: '' } },
    );
    expect(post.output.layer).toBe('other');
    expect(post.output.summary).toBe('handles auth');
    expect(post.output.tags).toHaveLength(6);
    expect(post.output.concepts).toHaveLength(5);
  });

  it('keeps a valid layer', () => {
    const post = FILE_ANALYZER_AGENT.postprocess!(
      { summary: 's', layer: 'service', tags: [], concepts: [] },
      { payload: { path: 'f.ts', language: 'ts', defs: [], imports: [], calls: [], sourceSlice: '' } },
    );
    expect(post.output.layer).toBe('service');
  });
});

describe('ArchitectureAnalyzer postprocess', () => {
  it('drops directory entries with an invalid layer', () => {
    const post = ARCHITECTURE_ANALYZER_AGENT.postprocess!(
      { directories: [{ path: 'src/api', layer: 'api' }, { path: 'src/x', layer: 'nope' as any }] },
      { payload: { directories: [] } },
    );
    expect(post.output.directories).toEqual([{ path: 'src/api', layer: 'api' }]);
  });
});

describe('DomainAnalyzer postprocess', () => {
  it('drops highlights whose evidence is not in the supplied inputs', () => {
    const post = DOMAIN_ANALYZER_AGENT.postprocess!(
      {
        highlights: [
          { statement: 'Built an event-driven Go backend for a fintech platform', evidence: 'Go backend' }, // keep
          { statement: 'Did unrelated thing', evidence: 'COBOL mainframe' },                                // drop
        ],
      },
      { payload: { industry: 'fintech', skills: ['Go backend', 'Kafka'], layers: ['service'], facts: [] } },
    );
    expect(post.output.highlights).toHaveLength(1);
    expect(post.output.highlights[0].evidence).toBe('Go backend');
  });
});

describe('analyze pipeline incremental skip', () => {
  it('skips files whose content_hash already matches file_analysis (no LLM)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-an-'));
    const codeDb = openCodeDb(root);
    const knowDb = openKnowledgeDb(root);
    try {
      const now = Date.now();
      codeDb.prepare(`INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count) VALUES (?,?,?,?,?,?,?)`)
        .run('src/a.ts', 'hash-1', 'typescript', 10, now, now, 0);
      upsertFileAnalysis(codeDb, {
        path: 'src/a.ts', summary: 'cached', layer: 'service', tags: [], concepts: [],
        model: 'test', contentHash: 'hash-1',
      });

      const stats = await analyzeWithDbs(codeDb, knowDb, root, DEFAULT_CONFIG, {});
      expect(stats.filesSkipped).toBe(1);
      expect(stats.filesAnalyzed).toBe(0); // nothing pending → no LLM call attempted
    } finally {
      codeDb.close();
      knowDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dashboard snapshot', () => {
  it('builds file nodes, file→file edges, domains, concepts, and a search index', () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-snap-'));
    const codeDb = openCodeDb(root);
    const knowDb = openKnowledgeDb(root);
    const now = Date.now();
    try {
      // Two files, each with a symbol; a call edge across files → one file→file edge.
      for (const [path, layer] of [['src/api/handler.ts', 'api'], ['src/db/repo.ts', 'data']] as const) {
        codeDb.prepare(`INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count) VALUES (?,?,?,?,?,?,?)`)
          .run(path, 'h', 'typescript', 1, now, now, 1);
        upsertFileAnalysis(codeDb, { path, summary: `summary for ${path}`, layer, tags: ['t'], concepts: [], model: 'm', contentHash: 'h' });
      }
      const insNode = codeDb.prepare(`INSERT INTO nodes (id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      insNode.run('n1', 'function', 'handle', 'handle', 'src/api/handler.ts', 'typescript', 1, 2, 0, 0, now);
      insNode.run('n2', 'function', 'fetchRow', 'fetchRow', 'src/db/repo.ts', 'typescript', 1, 2, 0, 0, now);
      codeDb.prepare(`INSERT INTO edges (source, target, kind) VALUES (?,?,?)`).run('n1', 'n2', 'calls');

      // Knowledge: an industry, a highlight, an entity, a concept.
      const insK = knowDb.prepare(`INSERT INTO k_nodes (id,kind,title,summary,evidence_text,confidence,source,scope,grounding,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      insK.run('i1', 'industry', 'fintech', null, 'stripe + ledger', 0.8, 'agent:industryClassifier', 'industry', 'stated', now, now);
      insK.run('h1', 'domain_highlight', 'Built an event-driven Go backend for fintech', null, 'Go backend', 0.7, 'agent:domainAnalyzer', 'industry', 'corroborated', now, now);
      insK.run('e1', 'entity', 'Account', 'an account', null, 0.9, 'agent:businessLogic', 'industry', 'stated', now, now);
      knowDb.prepare(`INSERT INTO concepts (id,name,summary,domain,member_count) VALUES (?,?,?,?,?)`)
        .run('c1', 'Payments', 'payment flow', 'business_logic', 3);

      codeDb.close();
      knowDb.close();

      const snap = buildSnapshot(root);
      // Agent-facing file graph is retained (graph.json / MCP).
      expect(snap.nodes.map((n) => n.id).sort()).toEqual(['src/api/handler.ts', 'src/db/repo.ts']);
      expect(snap.nodes.find((n) => n.id === 'src/api/handler.ts')!.layer).toBe('api');
      // file→file edge derived from the cross-file symbol call
      expect(snap.edges).toContainEqual({ source: 'src/api/handler.ts', target: 'src/db/repo.ts', kind: 'calls' });
      // Human-facing knowledge graph: entity + concept become nodes.
      expect(snap.knowledge.nodes.find((n) => n.label === 'Account')?.level).toBe('entity');
      expect(snap.knowledge.nodes.find((n) => n.label === 'Payments')?.level).toBe('concept');
      expect(snap.domains.industries.map((i) => i.name)).toContain('fintech');
      expect(snap.domains.highlights[0].statement).toContain('Go backend');
      expect(snap.domains.entities.map((e) => e.title)).toContain('Account');
      expect(snap.concepts.map((c) => c.name)).toContain('Payments');
      // search index spans knowledge nodes + files + highlights
      const kinds = new Set(snap.search.map((s) => s.kind));
      expect(kinds).toEqual(new Set(['file', 'concept', 'entity', 'highlight']));

      // File graph can be omitted for global drill-down payloads.
      const lean = buildSnapshot(root, { includeFileGraph: false });
      expect(lean.nodes).toHaveLength(0);
      expect(lean.knowledge.nodes.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
