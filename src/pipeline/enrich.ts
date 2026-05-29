/**
 * Domain enrichment orchestrator (L2.5).
 *
 * Order matters — each stage feeds the next:
 *   1. Structural extraction (deterministic): code schema/FKs → entities + relationships.
 *   2. DomainModeler agent (grounded, best-effort): relationships + gaps from
 *      conversation evidence. Skipped silently if no LLM backend.
 *   3. Gap detector (deterministic): external refs + ungoverned central entities.
 *
 * Stages 1 and 3 require no LLM and always run. Stage 2 enriches further when a
 * backend is available. Every node/edge written carries a grounding tier and an
 * evidence citation; nothing is fabricated.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import type { CodeGpsConfig } from '../config.js';
import type { KNode } from '../types.js';
import { AgentRuntime } from '../agents/runtime.js';
import '../agents/index.js';
import { DOMAIN_MODELER_AGENT } from '../agents/domain-modeler.js';
import { runDomainFromCode } from './domain-from-code.js';
import { runGapDetector } from './gap-detector.js';
import { upsertKNode, insertKEdgeUnique } from '../knowledge/store.js';
import { gapId } from '../knowledge/domain-store.js';

export interface EnrichStats {
  structuralEntities: number;
  externalEntities: number;
  structuralRelationships: number;
  agentRelationships: number;
  agentGaps: number;
  detectedGaps: number;
}

export interface EnrichOpts {
  /** Skip the LLM stage (structural + deterministic gaps only). */
  noAgent?: boolean;
  maxEntities?: number;
  maxFacts?: number;
}

export async function runEnrichment(
  knowDb: SqliteDb, codeDb: SqliteDb, cfg: CodeGpsConfig, opts: EnrichOpts = {},
): Promise<EnrichStats> {
  const stats: EnrichStats = {
    structuralEntities: 0, externalEntities: 0, structuralRelationships: 0,
    agentRelationships: 0, agentGaps: 0, detectedGaps: 0,
  };

  // ── 1. Structural (deterministic) ────────────────────────────────────
  const fromCode = runDomainFromCode(knowDb, codeDb);
  stats.structuralEntities = fromCode.entities;
  stats.externalEntities = fromCode.externalEntities;
  stats.structuralRelationships = fromCode.relationships;

  // ── 2. DomainModeler agent (best-effort) ─────────────────────────────
  if (!opts.noAgent) {
    try {
      const agentStats = await runDomainModeler(knowDb, cfg, opts);
      stats.agentRelationships = agentStats.relationships;
      stats.agentGaps = agentStats.gaps;
    } catch {
      // Backend unavailable: structural + deterministic gaps still stand.
    }
  }

  // ── 3. Gap detector (deterministic) ──────────────────────────────────
  const gaps = runGapDetector(knowDb);
  stats.detectedGaps = gaps.externalRefs + gaps.ungovernedEntities;

  return stats;
}

async function runDomainModeler(
  knowDb: SqliteDb, cfg: CodeGpsConfig, opts: EnrichOpts,
): Promise<{ relationships: number; gaps: number }> {
  const maxEntities = opts.maxEntities ?? 60;
  const maxFacts = opts.maxFacts ?? 40;

  const entities = knowDb.prepare(`
    SELECT id, title, summary FROM k_nodes
    WHERE kind='entity' AND source != 'structural:code:external'
    ORDER BY updated_at DESC LIMIT ?
  `).all(maxEntities) as Array<{ id: string; title: string; summary: string | null }>;

  if (entities.length === 0) return { relationships: 0, gaps: 0 };

  const facts = knowDb.prepare(`
    SELECT kind, title, summary, evidence_text FROM k_nodes
    WHERE kind IN ('business_rule','constraint','entity','decision')
    ORDER BY updated_at DESC LIMIT ?
  `).all(maxFacts) as Array<{ kind: string; title: string; summary: string | null; evidence_text: string | null }>;

  if (facts.length === 0) return { relationships: 0, gaps: 0 };

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const out = await rt.run(DOMAIN_MODELER_AGENT, {
    payload: {
      entities: entities.map((e) => ({ id: e.id, title: e.title, summary: e.summary ?? undefined })),
      facts: facts.map((f) => ({
        kind: f.kind, title: f.title,
        summary: f.summary ?? undefined, evidence: f.evidence_text ?? undefined,
      })),
    },
  });

  // Map entity titles -> ids for relationship persistence.
  const titleToId = new Map<string, string>();
  for (const e of entities) titleToId.set(e.title.toLowerCase(), e.id);

  const now = Date.now();
  let relCount = 0;
  let gapCount = 0;

  const tx = knowDb.transaction(() => {
    for (const r of out.output.relationships) {
      const from = titleToId.get(r.from.toLowerCase());
      const to = titleToId.get(r.to.toLowerCase());
      if (!from || !to) continue;
      const added = insertKEdgeUnique(knowDb, {
        source: from, target: to, kind: r.kind, weight: 1,
        metadata: { via: 'conversation', grounding: 'stated', evidence: r.evidence },
      });
      if (added) relCount++;
    }
    for (const g of out.output.gaps) {
      const id = gapId(`agent:${g.title}`);
      const node: KNode = {
        id, kind: 'knowledge_gap', title: g.title,
        summary: g.why, evidenceText: g.evidence,
        confidence: out.confidence, source: 'agent:domainModeler', grounding: 'stated',
        agentModel: out.model, createdAt: now, updatedAt: now,
      };
      upsertKNode(knowDb, node);
      gapCount++;
    }
  });
  tx();

  return { relationships: relCount, gaps: gapCount };
}
