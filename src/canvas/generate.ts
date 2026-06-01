/**
 * Canvas generator. Reads the project's databases, builds a JSON snapshot,
 * and writes a .canvas.tsx by substituting the inlined data placeholder in
 * the matching template.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { projectConfigDir } from '../config.js';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';
import { getWindowText } from '../knowledge/triage-store.js';

interface GenerateOpts { /* future: --domain, --since, etc. */ }

export async function generateCanvas(root: string, kind: string, _opts: GenerateOpts = {}): Promise<string> {
  const outDir = join(projectConfigDir(root), 'canvas');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  switch (kind) {
    case 'triage-audit':       return writeCanvas(root, outDir, 'triage-audit.canvas.tsx', triageAuditData, '__SUBNET_TRIAGE_DATA__');
    case 'project-map':        return writeCanvas(root, outDir, 'project-map.canvas.tsx', projectMapData, '__SUBNET_CONCEPTS_DATA__');
    case 'decision-timeline':  return writeCanvas(root, outDir, 'decision-timeline.canvas.tsx', timelineData, '__SUBNET_TIMELINE_DATA__');
    case 'business-logic':     return writeCanvas(root, outDir, 'business-logic.canvas.tsx', businessLogicData, '__SUBNET_BIZ_DATA__');
    case 'cross-project-bridge': return writeCanvas(root, outDir, 'cross-project-bridge.canvas.tsx', crossProjectData, '__SUBNET_BRIDGE_DATA__');
    default:
      throw new Error(`Canvas kind "${kind}" not implemented. Known: triage-audit, project-map, decision-timeline, business-logic, cross-project-bridge`);
  }
}

function writeCanvas(
  root: string, outDir: string, filename: string,
  dataFn: (root: string) => unknown, placeholderVar: string,
): string {
  const data = dataFn(root);
  const template = readFileSync(locateTemplate(filename), 'utf8');
  // The template reads its data from `(globalThis as any).__VAR__ ?? [...default]`.
  // We replace that whole expression with the inlined snapshot.
  const re = new RegExp(`\\(globalThis as any\\)\\.${placeholderVar}\\s*\\?\\?\\s*\\[\\]`);
  if (!re.test(template)) {
    throw new Error(`Template ${filename} missing placeholder for ${placeholderVar}`);
  }
  const out = template.replace(re, JSON.stringify(data));
  const outPath = join(outDir, filename);
  writeFileSync(outPath, out);
  return outPath;
}

function locateTemplate(name: string): string {
  const candidates = [
    join(__dirname, 'templates', name),
    join(__dirname, '..', '..', 'src', 'canvas', 'templates', name),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`Canvas template not found: ${name}`);
}

// ============================================================================
// data builders
// ============================================================================

function triageAuditData(root: string): unknown {
  const db = openKnowledgeDb(root);
  try {
    const rows = db.prepare(`
      SELECT tl.window_id AS windowId, tw.session_id AS sessionId,
             tl.domain, tl.relevance, tl.quality, tl.linkage,
             tl.confidence, tl.kept, tl.rationale
      FROM triage_labels tl
      JOIN turn_windows tw ON tw.id = tl.window_id
      ORDER BY tw.session_id, tw.start_turn
    `).all() as any[];
    return rows.map((r) => ({
      ...r, kept: !!r.kept,
      excerpt: (getWindowText(db, r.windowId) ?? '').slice(0, 600),
    }));
  } finally { db.close(); }
}

function projectMapData(root: string): unknown {
  const know = openKnowledgeDb(root);
  const code = openCodeDb(root);
  try {
    const concepts = know.prepare(`
      SELECT id, name, summary, domain
      FROM concepts ORDER BY member_count DESC
    `).all() as Array<{ id: string; name: string; summary: string | null; domain: string | null }>;

    const result: unknown[] = [];
    for (const c of concepts) {
      const members = know.prepare(`
        SELECT id, kind, title, summary
        FROM k_nodes WHERE cluster_id=?
        ORDER BY updated_at DESC
      `).all(c.id) as Array<{ id: string; kind: string; title: string; summary: string | null }>;

      const enrichedMembers = members.map((m) => {
        const linkRows = know.prepare(`
          SELECT code_node_id, code_file FROM k_to_code WHERE k_node_id=?
        `).all(m.id) as Array<{ code_node_id: string; code_file: string | null }>;
        const codeLinks = linkRows
          .map((l) => {
            const n = code.prepare(`SELECT name, kind, file_path AS file, start_line AS line FROM nodes WHERE id=?`)
              .get(l.code_node_id) as any;
            if (!n) return undefined;
            return { name: n.name, kind: n.kind, file: n.file, line: n.line };
          })
          .filter(Boolean);
        return { ...m, summary: m.summary ?? undefined, codeLinks };
      });

      result.push({
        id: c.id, name: c.name,
        summary: c.summary ?? undefined,
        domain: c.domain ?? undefined,
        members: enrichedMembers,
      });
    }
    return result;
  } finally { know.close(); code.close(); }
}

function timelineData(root: string): unknown {
  const know = openKnowledgeDb(root);
  try {
    const rows = know.prepare(`
      SELECT id, kind, title, summary, confidence, source, created_at AS ts
      FROM k_nodes
      WHERE kind IN ('decision','business_rule','constraint','pattern','problem','solution','intent')
      ORDER BY created_at ASC
    `).all() as Array<{
      id: string; kind: string; title: string; summary: string | null;
      confidence: number; source: string; ts: number;
    }>;

    return rows.map((r) => {
      const fileRow = know.prepare(`
        SELECT DISTINCT code_file FROM k_to_code WHERE k_node_id=? AND code_file IS NOT NULL
      `).all(r.id) as Array<{ code_file: string }>;
      const sess = know.prepare(`
        SELECT tw.session_id AS sessionId FROM k_provenance kp
        JOIN turn_windows tw ON tw.id = kp.window_id WHERE kp.k_node_id=? LIMIT 1
      `).get(r.id) as { sessionId: string } | undefined;
      return {
        id: r.id, kind: r.kind, title: r.title,
        summary: r.summary ?? undefined,
        confidence: r.confidence, source: r.source,
        ts: r.ts, sessionId: sess?.sessionId,
        files: fileRow.map((f) => f.code_file),
      };
    });
  } finally { know.close(); }
}

function crossProjectData(root: string): unknown {
  // Inline require to keep this generator self-contained without circular imports.
  const { listCrossProjectLinks } = require('../link/cross-project.js') as typeof import('../link/cross-project');
  const know = openKnowledgeDb(root);
  try {
    const concepts = know.prepare(`SELECT id, name, summary, domain FROM concepts`).all() as Array<{
      id: string; name: string; summary: string | null; domain: string | null;
    }>;
    return concepts.map((c) => {
      const links = listCrossProjectLinks(c.id, root);
      return {
        id: c.id, name: c.name,
        summary: c.summary ?? undefined, domain: c.domain ?? undefined,
        links,
      };
    }).filter((c) => c.links.length > 0);
  } finally { know.close(); }
}

function businessLogicData(root: string): unknown {
  const know = openKnowledgeDb(root);
  try {
    const concepts = know.prepare(`
      SELECT c.id, c.name, c.summary
      FROM concepts c
      JOIN k_nodes k ON k.cluster_id = c.id
      WHERE k.kind IN ('business_rule','entity','constraint','pattern')
      GROUP BY c.id
      ORDER BY c.member_count DESC
    `).all() as Array<{ id: string; name: string; summary: string | null }>;

    return concepts.map((c) => {
      const facts = know.prepare(`
        SELECT id, kind, title, summary, evidence_text AS evidence, confidence
        FROM k_nodes
        WHERE cluster_id=? AND kind IN ('business_rule','entity','constraint','pattern')
        ORDER BY kind, title
      `).all(c.id) as any[];
      return {
        conceptId: c.id,
        conceptName: c.name,
        conceptSummary: c.summary ?? undefined,
        facts: facts.map((f) => ({
          ...f,
          summary: f.summary ?? undefined,
          evidence: f.evidence ?? undefined,
        })),
      };
    });
  } finally { know.close(); }
}
