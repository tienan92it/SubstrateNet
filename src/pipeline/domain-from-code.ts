/**
 * Structural domain extraction — deterministic, zero-assumption.
 *
 * The SQL DDL extractor already wrote `table` / `field` / foreign-key
 * `references` edges into code.db. A foreign key IS a domain relationship;
 * a table IS a domain entity. This pass promotes that structure into the
 * knowledge graph as `entity` k_nodes (grounding='structural') and
 * `relates_to` k_edges. No language model is involved — every node and edge
 * cites a concrete code location.
 *
 * Tables the SQL extractor emitted as FK stubs (referenced from another file
 * but never defined) become entities with source 'structural:code:external'
 * so the gap detector can flag them.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import type { KNode } from '../types.js';
import { upsertKNode, insertKEdgeUnique } from '../knowledge/store.js';
import { writeKToCode } from './resolve.js';
import { domainNodeId } from '../knowledge/domain-store.js';

export interface DomainFromCodeStats {
  entities: number;
  externalEntities: number;
  relationships: number;
}

interface CodeTable {
  id: string;
  name: string;
  qualifiedName: string;
  file: string;
  signature: string | null;
  isStub: boolean;
}

const STUB_PREFIX = '(stub)';

export function runDomainFromCode(knowDb: SqliteDb, codeDb: SqliteDb): DomainFromCodeStats {
  const stats: DomainFromCodeStats = { entities: 0, externalEntities: 0, relationships: 0 };

  const tables = (codeDb.prepare(`
    SELECT id, name, qualified_name AS qn, file_path AS file, signature, start_line AS line
    FROM nodes WHERE kind='table'
  `).all() as any[]).map<CodeTable>((r) => ({
    id: r.id,
    name: r.name,
    qualifiedName: r.qn,
    file: r.file,
    signature: r.signature ?? null,
    isStub: typeof r.signature === 'string' && r.signature.startsWith(STUB_PREFIX),
  }));

  if (tables.length === 0) return stats;

  // A domain entity is identified by table NAME within the project, not by
  // schema-qualified name. This collapses `public.users` (definition) and the
  // unqualified `users` FK stub into one entity. A real definition always wins
  // over a stub; an entity is external only when every table of that name is a
  // stub.
  const byName = new Map<string, CodeTable[]>();
  for (const t of tables) {
    const key = t.name.toLowerCase();
    (byName.get(key) ?? byName.set(key, []).get(key)!).push(t);
  }

  // Map every code table id -> its (deduplicated) entity k_node id.
  const codeIdToEntity = new Map<string, string>();
  const now = Date.now();

  const tx = knowDb.transaction(() => {
    for (const [, group] of byName) {
      const real = group.find((t) => !t.isStub);
      const canonical = real ?? group[0];
      const isExternal = !real;
      const entityId = domainNodeId('entity', canonical.name);

      for (const t of group) codeIdToEntity.set(t.id, entityId);

      const node: KNode = {
        id: entityId,
        kind: 'entity',
        title: canonical.name,
        summary: isExternal
          ? 'External entity referenced by a foreign key; not defined in this project.'
          : `Domain entity backed by table ${canonical.name}.`,
        evidenceText: canonical.signature ?? undefined,
        confidence: 1,
        source: isExternal ? 'structural:code:external' : 'structural:code',
        grounding: 'structural',
        createdAt: now,
        updatedAt: now,
      };
      upsertKNode(knowDb, node);
      // Structural facts are grounded by a code link, not a conversation window.
      writeKToCode(knowDb, { kNodeId: entityId, codeNodeId: canonical.id, codeFile: canonical.file, weight: 1 });
      if (isExternal) stats.externalEntities++;
      else stats.entities++;
    }

    // Build field -> owning table map via 'contains' edges so FK sources that
    // are columns resolve to their table.
    const childToParent = new Map<string, string>();
    for (const e of codeDb.prepare(
      `SELECT source, target FROM edges WHERE kind='contains'`,
    ).all() as Array<{ source: string; target: string }>) {
      childToParent.set(e.target, e.source);
    }

    // Foreign-key edges → relates_to between owning entity and target entity.
    const fkEdges = codeDb.prepare(`
      SELECT source, target, metadata, line FROM edges
      WHERE kind='references' AND metadata LIKE '%foreign_key%'
    `).all() as Array<{ source: string; target: string; metadata: string | null; line: number | null }>;

    for (const fk of fkEdges) {
      const ownerTableCodeId = codeIdToEntity.has(fk.source)
        ? fk.source
        : childToParent.get(fk.source);
      if (!ownerTableCodeId) continue;
      const fromEntity = codeIdToEntity.get(ownerTableCodeId);
      const toEntity = codeIdToEntity.get(fk.target);
      if (!fromEntity || !toEntity || fromEntity === toEntity) continue;

      const meta = fk.metadata ? safeJson(fk.metadata) : {};
      const added = insertKEdgeUnique(knowDb, {
        source: fromEntity,
        target: toEntity,
        kind: 'relates_to',
        weight: 1,
        metadata: {
          via: 'foreign_key',
          grounding: 'structural',
          evidence: `foreign key → ${meta?.target_table ?? 'table'}${fk.line ? ` (line ${fk.line})` : ''}`,
        },
      });
      if (added) stats.relationships++;
    }
  });
  tx();

  return stats;
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}
