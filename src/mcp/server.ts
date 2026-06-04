/**
 * MCP server.
 *
 * Exposes both code (L0) and knowledge (L1.5–L3) tools over stdio. The current
 * project root is captured at start time; tools operate on that project's DBs.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';
import {
  codeSearch, codeNode,
  recallByQuery, decisionsForTopic, businessLogicForTopic,
  factsForFile, triageAuditRows,
} from './queries.js';
import { listConcepts, membersOf, getConcept } from '../knowledge/concept-store.js';
import { listCrossProjectLinks } from '../link/cross-project.js';
import { runVerify } from '../pipeline/verify.js';
import { runEnrichment } from '../pipeline/enrich.js';
import { listEntities, relationshipsFor, listGaps } from '../knowledge/domain-store.js';
import { listSkills, listIndustries, listHighlights } from '../global/skills.js';
import { openGlobalDb } from '../db/connection.js';
import { loadConfig } from '../config.js';
import { ingestProject } from '../ingest/orchestrator.js';
import { syncProject } from '../code/sync.js';
import { analyzeProject } from '../pipeline/analyze-code.js';
import { AgentRuntime } from '../agents/runtime.js';
import { PROFILE_WRITER_AGENT } from '../agents/profile-writer.js';
import '../agents/index.js';

export async function startMcpServer(root: string): Promise<void> {
  const server = new McpServer(
    { name: 'subnet', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // --------------------------------------------------------------------
  // L0 — code structure
  // --------------------------------------------------------------------

  server.tool(
    'subnet_search',
    'Quick symbol search by name. Returns name + kind + file:line.',
    { query: z.string(), kind: z.string().optional(), limit: z.number().optional() },
    async ({ query, kind, limit }) => {
      const db = openCodeDb(root);
      try {
        const hits = codeSearch(db, query, kind, limit ?? 10);
        return text(formatLines(hits.map((h) => `${h.kind} ${h.name}  ${h.file}:${h.line}`)));
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_node',
    'Get one symbol\'s details (kind, file:line, signature, docstring).',
    { name: z.string() },
    async ({ name }) => {
      const db = openCodeDb(root);
      try {
        const n = codeNode(db, name);
        if (!n) return text(`No symbol named "${name}" in this project.`);
        return text(JSON.stringify(n, null, 2));
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_status',
    'Counts per layer (files, nodes, edges, sessions, turns, facts, concepts).',
    {},
    async () => {
      const code = openCodeDb(root);
      const know = openKnowledgeDb(root);
      try {
        return text(JSON.stringify({
          code: {
            files: cnt(code, 'files'),
            nodes: cnt(code, 'nodes'),
            edges: cnt(code, 'edges'),
          },
          knowledge: {
            sessions: cnt(know, 'sessions'),
            turns: cnt(know, 'turns'),
            windows: cnt(know, 'turn_windows'),
            triaged: cnt(know, 'triage_labels'),
            kept: cnt(know, 'triage_labels WHERE kept=1'),
            dropped: cnt(know, 'triage_labels WHERE kept=0'),
            facts: cnt(know, 'k_nodes'),
            concepts: cnt(know, 'concepts'),
            agent_runs: cnt(know, 'agent_runs'),
          },
        }, null, 2));
      } finally { code.close(); know.close(); }
    },
  );

  // --------------------------------------------------------------------
  // L2 — knowledge / facts
  // --------------------------------------------------------------------

  server.tool(
    'subnet_context',
    'Primary tool. Builds context for a topic: matching facts + related code.',
    { task: z.string(), limit: z.number().optional() },
    async ({ task, limit }) => {
      const know = openKnowledgeDb(root);
      const code = openCodeDb(root);
      try {
        const facts = recallByQuery(know, task, limit ?? 12);
        const symbolHits = codeSearch(code, task, undefined, limit ?? 8);
        return text(
          `# Knowledge context for: ${task}\n\n` +
          `## Facts (${facts.length})\n` +
          formatFacts(facts) + `\n\n` +
          `## Related code symbols (${symbolHits.length})\n` +
          formatLines(symbolHits.map((h) => `- ${h.kind} **${h.name}** — ${h.file}:${h.line}`)),
        );
      } finally { know.close(); code.close(); }
    },
  );

  server.tool(
    'subnet_recall',
    'Semantic + FTS query across past conversations. Returns matching facts. Defaults to project-truth grounding (structural/stated/corroborated); set includeEnrichment to also surface model/web-sourced knowledge.',
    {
      query: z.string(),
      kinds: z.array(z.string()).optional(),
      scope: z.enum(['technical', 'industry', 'meta']).optional(),
      includeEnrichment: z.boolean().optional(),
      limit: z.number().optional(),
    },
    async ({ query, kinds, scope, includeEnrichment, limit }) => {
      const db = openKnowledgeDb(root);
      try {
        const facts = recallByQuery(db, query, limit ?? 20, { kinds, scope, includeEnrichment });
        return text(formatFacts(facts));
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_decisions',
    'List decisions / constraints / patterns recorded for a topic.',
    { topic: z.string().optional(), file: z.string().optional(), limit: z.number().optional() },
    async ({ topic, file, limit }) => {
      const db = openKnowledgeDb(root);
      try {
        const facts = file
          ? factsForFile(db, file, limit ?? 20).filter(
              (f) => ['decision', 'constraint', 'pattern'].includes(f.kind),
            )
          : decisionsForTopic(db, topic ?? '', limit ?? 20);
        return text(formatFacts(facts));
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_business_logic',
    'List business rules / invariants / entities for a topic or file.',
    { topic: z.string().optional(), file: z.string().optional(), limit: z.number().optional() },
    async ({ topic, file, limit }) => {
      const db = openKnowledgeDb(root);
      try {
        const facts = file
          ? factsForFile(db, file, limit ?? 20).filter(
              (f) => ['business_rule', 'entity', 'constraint', 'pattern'].includes(f.kind),
            )
          : businessLogicForTopic(db, topic ?? '', limit ?? 20);
        return text(formatFacts(facts));
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_concepts',
    'List or inspect L3 concepts. Without conceptId: lists top concepts by size. With conceptId: returns members + summary.',
    { conceptId: z.string().optional(), domain: z.string().optional(), limit: z.number().optional() },
    async ({ conceptId, domain, limit }) => {
      const db = openKnowledgeDb(root);
      try {
        if (conceptId) {
          const c = getConcept(db, conceptId);
          if (!c) return text(`Concept ${conceptId} not found.`);
          const members = membersOf(db, conceptId);
          return text(
            `# ${c.name}\n` +
            (c.summary ? `${c.summary}\n\n` : '') +
            (c.domain ? `**Domain:** ${c.domain}\n` : '') +
            `**Members:** ${c.memberCount}\n\n` +
            `## Member facts\n` +
            members.map((m) => `- **[${m.kind}]** ${m.title}` + (m.summary ? `\n  ${m.summary}` : '')).join('\n'),
          );
        }
        const concepts = listConcepts(db, domain, limit ?? 30);
        return text(
          `# Concepts (${concepts.length})\n` +
          concepts.map((c) => `- ${c.id}  ${c.name}  (${c.memberCount} member${c.memberCount === 1 ? '' : 's'})` +
            (c.summary ? `\n    ${c.summary.split('\n')[0].slice(0, 140)}` : '')).join('\n'),
        );
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_explain',
    'Produce a structured "systematic thinking" view (problem / constraints / options / decision / consequences) for a concept.',
    { conceptId: z.string() },
    async ({ conceptId }) => {
      const db = openKnowledgeDb(root);
      try {
        const c = getConcept(db, conceptId);
        if (!c) return text(`Concept ${conceptId} not found.`);
        const members = membersOf(db, conceptId);
        // Stitch the structured view from member kinds; the summary already
        // contains the agent-generated narrative.
        const problems = members.filter((m) => m.kind === 'problem');
        const solutions = members.filter((m) => m.kind === 'solution');
        const decisions = members.filter((m) => m.kind === 'decision');
        const constraints = members.filter((m) => ['constraint', 'business_rule'].includes(m.kind));
        const intents = members.filter((m) => m.kind === 'intent');
        return text(
          `# ${c.name}\n\n` +
          (c.summary ? `${c.summary}\n\n` : '') +
          section('Intents',     intents) +
          section('Problem',     problems) +
          section('Constraints', constraints) +
          section('Decisions',   decisions) +
          section('Solutions',   solutions),
        );
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_link',
    'Cross-project: list related concepts in OTHER projects.',
    { conceptId: z.string() },
    async ({ conceptId }) => {
      const rows = listCrossProjectLinks(conceptId, root);
      if (!rows.length) return text(`No cross-project links for concept ${conceptId}.`);
      return text(rows.map((r) =>
        `- **${r.relation}** (score ${r.score.toFixed(2)})  · _${r.otherProject}_  · ${r.otherName}` +
        (r.otherSummary ? `\n    ${r.otherSummary.split('\n')[0]}` : ''),
      ).join('\n'));
    },
  );

  server.tool(
    'subnet_triage_audit',
    'List triaged windows with their labels. Useful for inspecting dropped content.',
    { droppedOnly: z.boolean().optional(), limit: z.number().optional() },
    async ({ droppedOnly, limit }) => {
      const db = openKnowledgeDb(root);
      try {
        const rows = triageAuditRows(db, { droppedOnly, limit });
        const lines = rows.map((r) => (
          `${r.kept ? 'KEEP' : 'DROP'}  ` +
          `${pad(r.domain, 15)} ${pad(r.quality, 15)} ` +
          `${pad(r.relevance, 10)} ${pad(r.linkage, 18)} ` +
          `c=${r.confidence.toFixed(2)}  ${r.rationale ?? ''}`
        ));
        return text(formatLines(lines));
      } finally { db.close(); }
    },
  );

  // --------------------------------------------------------------------
  // Ingestion control
  // --------------------------------------------------------------------

  server.tool(
    'subnet_ingest',
    'Ingest new conversation data and run the agent pipeline (L1.5 → L2).',
    { runTriage: z.boolean().optional(), runExtract: z.boolean().optional() },
    async ({ runTriage, runExtract }) => {
      const stats = await ingestProject(root, {
        runTriage: runTriage ?? true,
        runExtract: runExtract ?? true,
      });
      return text(JSON.stringify(stats, null, 2));
    },
  );

  server.tool(
    'subnet_verify',
    'Run the Verifier sweep: prune low-confidence facts, detect contradictions, mark supersessions.',
    { pruneBelow: z.number().optional() },
    async ({ pruneBelow }) => {
      const db = openKnowledgeDb(root);
      try {
        const stats = await runVerify(db, loadConfig(root), { pruneBelowConfidence: pruneBelow });
        return text(JSON.stringify(stats, null, 2));
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_domain_model',
    'The business-domain graph: entities + their evidence-grounded relationships. Every item shows its grounding (stated | structural | corroborated).',
    { entity: z.string().optional(), limit: z.number().optional() },
    async ({ entity, limit }) => {
      const db = openKnowledgeDb(root);
      try {
        const entities = listEntities(db, { query: entity, limit: limit ?? 60 });
        if (entities.length === 0) {
          return text('No domain entities yet. Run `subnet sync` then `subnet enrich`.');
        }
        const lines: string[] = [`# Domain model (${entities.length} entit${entities.length === 1 ? 'y' : 'ies'})`];
        for (const e of entities) {
          lines.push(
            `\n## ${e.title}  _(${e.grounding})_` +
            (e.summary ? `\n${e.summary}` : '') +
            (e.codeFiles.length ? `\ncode: ${e.codeFiles.slice(0, 5).join(', ')}` : ''),
          );
          const rels = relationshipsFor(db, e.id).filter((r) => r.fromId === e.id);
          for (const r of rels) {
            lines.push(`  - ${r.kind} → ${r.toTitle}  _(${r.grounding})_` + (r.evidence ? `  · ${r.evidence}` : ''));
          }
        }
        return text(lines.join('\n'));
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_gaps',
    'Open questions / knowledge gaps in the domain graph. Each names a gap and cites the evidence that revealed it — it never fabricates the missing answer.',
    { limit: z.number().optional() },
    async ({ limit }) => {
      const db = openKnowledgeDb(root);
      try {
        const gaps = listGaps(db, limit ?? 100);
        if (gaps.length === 0) return text('No knowledge gaps recorded.');
        return text(
          `# Knowledge gaps (${gaps.length})\n` +
          gaps.map((g) =>
            `- **${g.title}**  _(${g.grounding} · ${g.source})_` +
            (g.summary ? `\n    ${g.summary}` : '') +
            (g.evidenceText ? `\n    evidence: ${g.evidenceText}` : ''),
          ).join('\n'),
        );
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_enrich',
    'Run the enrichment pass: technical skills + structural domain entities/relationships + industry classification + evidence-grounded gaps.',
    { noAgent: z.boolean().optional() },
    async ({ noAgent }) => {
      const code = openCodeDb(root);
      const know = openKnowledgeDb(root);
      try {
        const stats = await runEnrichment(root, know, code, loadConfig(root), { noAgent });
        return text(JSON.stringify(stats, null, 2));
      } finally { code.close(); know.close(); }
    },
  );

  server.tool(
    'subnet_skills',
    'Global skill graph: technical + industry skills aggregated across all projects, weighted by evidence and grounding. project_count > 1 means cross-project.',
    { scope: z.enum(['technical', 'industry']).optional(), cross: z.boolean().optional(), limit: z.number().optional() },
    async ({ scope, cross, limit }) => {
      const gdb = openGlobalDb();
      try {
        const skills = listSkills(gdb, { scope, crossOnly: cross, limit: limit ?? 80 });
        if (skills.length === 0) return text('No skills yet. Run `subnet enrich` then `subnet link` per project.');
        return text(skills.map((s) =>
          `- ${s.name}  · w=${s.evidenceWeight.toFixed(1)} · ×${s.projectCount} · ${s.grounding}`,
        ).join('\n'));
      } finally { gdb.close(); }
    },
  );

  server.tool(
    'subnet_profile',
    'Big-picture knowledge profile across all projects: industries, top technical skills, evidence mix. Pass prose:true for ProfileWriter-generated portfolio markdown.',
    { prose: z.boolean().optional() },
    async ({ prose }) => {
      const gdb = openGlobalDb();
      try {
        if (prose) {
          const projectCount = (gdb.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as any).n;
          const industries = listIndustries(gdb).map((i) => ({ name: i.name, projectCount: i.projectCount }));
          const skills = listSkills(gdb, { scope: 'technical', limit: 40 })
            .map((s) => ({ name: s.name, grounding: s.grounding, projectCount: s.projectCount }));
          const highlights = listHighlights(gdb).map((h) => ({ statement: h.statement, grounding: h.grounding }));
          if (!industries.length && !skills.length && !highlights.length) {
            return text('Nothing to write yet. Run `subnet enrich` then `subnet link` per project.');
          }
          const rt = new AgentRuntime({ knowledgeDb: gdb, config: loadConfig() });
          const out = await rt.run(PROFILE_WRITER_AGENT, { payload: { projectCount, industries, skills, highlights } });
          return text(out.output.markdown);
        }
        const projects = (gdb.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as any).n;
        const industries = listIndustries(gdb);
        const tech = listSkills(gdb, { scope: 'technical', limit: 25 });
        return text(
          `# Knowledge profile\n\nProjects: ${projects}\n\n` +
          `## Industries\n` + (industries.length ? industries.map((i) => `- ${i.name} (×${i.projectCount}, conf ${i.confidence.toFixed(2)})`).join('\n') : '_(none)_') +
          `\n\n## Top technical skills\n` + (tech.length ? tech.map((s) => `- ${s.name} (w=${s.evidenceWeight.toFixed(1)}, ×${s.projectCount}, ${s.grounding})`).join('\n') : '_(none)_'),
        );
      } finally { gdb.close(); }
    },
  );

  server.tool(
    'subnet_learn',
    'Learning targets: industry-standard knowledge (grounding model/external) not yet grounded in your own work. General knowledge, NOT facts about this project.',
    { limit: z.number().optional() },
    async ({ limit }) => {
      const db = openKnowledgeDb(root);
      try {
        const rows = db.prepare(`
          SELECT title, summary, grounding, source_url FROM k_nodes
          WHERE scope='industry' AND COALESCE(grounding,'stated') IN ('model','external')
          ORDER BY grounding DESC, title LIMIT ?
        `).all(limit ?? 40) as Array<{ title: string; summary: string | null; grounding: string; source_url: string | null }>;
        if (rows.length === 0) return text('No learning targets. Run `subnet enrich` (needs an LLM) to surface industry-standard knowledge.');
        return text(rows.map((r) =>
          `- [${r.grounding}] ${r.title}` + (r.summary ? `\n    ${r.summary}` : '') + (r.source_url ? `\n    source: ${r.source_url}` : ''),
        ).join('\n'));
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_sync',
    'Re-index the project\'s code (L0).',
    { full: z.boolean().optional() },
    async ({ full }) => {
      const stats = await syncProject(root, { full });
      return text(JSON.stringify(stats, null, 2));
    },
  );

  server.tool(
    'subnet_analyze',
    'Code-grounded analysis: per-file LLM summaries + architectural layers + tags, grounded in the tree-sitter graph (the hybrid L0 -> semantic pass).',
    { full: z.boolean().optional() },
    async ({ full }) => {
      const stats = await analyzeProject(root, loadConfig(root), { full });
      return text(JSON.stringify(stats, null, 2));
    },
  );

  // --------------------------------------------------------------------
  // Research surface — structured product knowledge + global linking
  // --------------------------------------------------------------------

  server.tool(
    'subnet_requirements',
    'Product knowledge for this project: requirements, features, actors, processes, and metrics extracted from docs + conversations.',
    { query: z.string().optional(), limit: z.number().optional() },
    async ({ query, limit }) => {
      const db = openKnowledgeDb(root);
      try {
        const args: any[] = [];
        let where = `kind IN ('requirement','feature','actor','process','metric','intent')`;
        if (query) { where += ` AND (title LIKE ? OR summary LIKE ?)`; args.push(`%${query}%`, `%${query}%`); }
        args.push(limit ?? 60);
        const rows = db.prepare(`
          SELECT kind, title, summary, COALESCE(grounding,'stated') AS grounding
          FROM k_nodes WHERE ${where} ORDER BY kind, updated_at DESC LIMIT ?
        `).all(...args) as Array<{ kind: string; title: string; summary: string | null; grounding: string }>;
        if (!rows.length) return text('No product requirements captured yet. Ingest docs/conversations first.');
        return text(rows.map((r) => `- **[${r.kind}]** ${r.title} · _${r.grounding}_` + (r.summary ? `\n    ${r.summary}` : '')).join('\n'));
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_incidents',
    'Root-cause analysis: incidents (symptoms) linked to their root cause and resolution, mined from bug-fix conversations. Ask "why did X break / how was it fixed".',
    { query: z.string().optional(), limit: z.number().optional() },
    async ({ query, limit }) => {
      const db = openKnowledgeDb(root);
      try {
        const args: any[] = [];
        let where = `i.kind='incident'`;
        if (query) { where += ` AND (i.title LIKE ? OR i.summary LIKE ?)`; args.push(`%${query}%`, `%${query}%`); }
        args.push(limit ?? 40);
        const incidents = db.prepare(`
          SELECT i.id, i.title, i.summary FROM k_nodes i WHERE ${where}
          ORDER BY i.updated_at DESC LIMIT ?
        `).all(...args) as Array<{ id: string; title: string; summary: string | null }>;
        if (!incidents.length) return text('No incidents captured yet. Bug-fix conversations populate this.');
        const causeFor = db.prepare(`
          SELECT c.title AS title FROM k_edges e JOIN k_nodes c ON c.id=e.target
          WHERE e.source=? AND e.kind='caused_by' LIMIT 1
        `);
        const fixFor = db.prepare(`
          SELECT s.title AS title FROM k_edges e JOIN k_nodes s ON s.id=e.source
          WHERE e.target=? AND e.kind='resolves' LIMIT 1
        `);
        const out = incidents.map((inc) => {
          const cause = (causeFor.get(inc.id) as { title: string } | undefined)?.title;
          const fix = (fixFor.get(inc.id) as { title: string } | undefined)?.title;
          return `- **${inc.title}**` +
            (cause ? `\n    root cause: ${cause}` : '') +
            (fix ? `\n    resolution: ${fix}` : '');
        });
        return text(out.join('\n'));
      } finally { db.close(); }
    },
  );

  server.tool(
    'subnet_workspace',
    'Cross-project view: this project\'s workspace umbrella, sibling projects, and emergently-related projects (shared domains/skills/concepts).',
    {},
    async () => {
      const gdb = openGlobalDb();
      try {
        const { projectIdForPath } = await import('../global/registry.js');
        const pid = projectIdForPath(root);
        const ws = gdb.prepare(`
          SELECT w.name AS name, w.source AS source FROM project_workspace pw
          JOIN workspaces w ON w.id=pw.workspace_id WHERE pw.project_id=?
        `).get(pid) as { name: string; source: string } | undefined;
        let outStr = ws ? `# Workspace: ${ws.name} _(via ${ws.source})_\n` : `# Workspace\n_(no umbrella detected; set "workspace" in config to group repos)_\n`;
        if (ws) {
          const siblings = gdb.prepare(`
            SELECT p.name AS name FROM project_workspace pw JOIN projects p ON p.id=pw.project_id
            WHERE pw.workspace_id=(SELECT workspace_id FROM project_workspace WHERE project_id=?) AND pw.project_id!=?
            ORDER BY p.name
          `).all(pid, pid) as Array<{ name: string }>;
          outStr += `\n## Sibling repos\n` + (siblings.length ? siblings.map((s) => `- ${s.name}`).join('\n') : '_(none)_');
        }
        const related = gdb.prepare(`
          SELECT p.name AS name, pl.weight AS weight, pl.signals AS signals
          FROM project_links pl
          JOIN projects p ON p.id = CASE WHEN pl.a=? THEN pl.b ELSE pl.a END
          WHERE pl.a=? OR pl.b=? ORDER BY pl.weight DESC LIMIT 15
        `).all(pid, pid, pid) as Array<{ name: string; weight: number; signals: string }>;
        outStr += `\n\n## Related projects (emergent)\n` + (related.length
          ? related.map((r) => `- ${r.name} · w=${r.weight}`).join('\n')
          : '_(none yet; run `subnet link` across more projects)_');
        return text(outStr);
      } finally { gdb.close(); }
    },
  );

  server.tool(
    'subnet_ask',
    'Grounded retrieval over the knowledge base. Returns the most relevant facts + concepts for a question, filtered to project-truth grounding by default.',
    { query: z.string(), includeInferred: z.boolean().optional(), limit: z.number().optional() },
    async ({ query, includeInferred, limit }) => {
      const db = openKnowledgeDb(root);
      try {
        const grounds = includeInferred
          ? ['structural', 'corroborated', 'stated', 'external', 'model']
          : ['structural', 'corroborated', 'stated'];
        const gph = grounds.map(() => '?').join(',');
        const match = query.trim().split(/\s+/).map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
        let facts: Array<{ kind: string; title: string; summary: string | null; grounding: string }> = [];
        try {
          facts = db.prepare(`
            SELECT k.kind, k.title, k.summary, COALESCE(k.grounding,'stated') AS grounding
            FROM k_nodes_fts f JOIN k_nodes k ON k.rowid=f.rowid
            WHERE k_nodes_fts MATCH ? AND COALESCE(k.grounding,'stated') IN (${gph})
            LIMIT ?
          `).all(match, ...grounds, limit ?? 25) as any[];
        } catch {
          facts = db.prepare(`
            SELECT kind, title, summary, COALESCE(grounding,'stated') AS grounding
            FROM k_nodes WHERE (title LIKE ? OR summary LIKE ?) AND COALESCE(grounding,'stated') IN (${gph})
            LIMIT ?
          `).all(`%${query}%`, `%${query}%`, ...grounds, limit ?? 25) as any[];
        }
        if (!facts.length) return text(`No grounded facts found for "${query}". Try includeInferred:true to include model/external knowledge.`);
        return text(`# Answers for "${query}"\n\n` + facts.map((f) =>
          `- **[${f.kind}]** ${f.title} · _${f.grounding}_` + (f.summary ? `\n    ${f.summary}` : '')).join('\n'));
      } finally { db.close(); }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ============================================================================
// helpers
// ============================================================================

function cnt(db: any, fromClause: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${fromClause}`).get() as any).n;
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

function formatFacts(facts: Array<{
  kind: string; title: string; summary: string | null; confidence: number; source: string;
}>): string {
  if (!facts.length) return '_(no matching facts)_';
  return facts
    .map((f) => `- **[${f.kind}]** ${f.title}  · _conf=${f.confidence.toFixed(2)}_  _src=${f.source}_` +
      (f.summary ? `\n    ${f.summary}` : ''))
    .join('\n');
}

function formatLines(xs: string[]): string {
  return xs.length ? xs.join('\n') : '_(empty)_';
}

function pad(s: string, n: number): string {
  return (s ?? '').padEnd(n).slice(0, n);
}

function section(label: string, items: Array<{ kind: string; title: string; summary?: string }>): string {
  if (!items.length) return '';
  return `## ${label}\n` +
    items.map((m) => `- ${m.title}` + (m.summary ? `\n  ${m.summary}` : '')).join('\n') + '\n\n';
}
