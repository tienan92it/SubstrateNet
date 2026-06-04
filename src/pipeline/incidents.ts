/**
 * Incident / RCA extraction pass.
 *
 * Over kept bug-fix windows, extract structured root-cause chains and persist
 * them as linked k_nodes: an `incident` (symptom), a `root_cause`, and an
 * optional `solution`, wired with `caused_by` / `resolves` edges. Powers the
 * "why did X break / how was it fixed" research surface.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { createHash } from 'crypto';
import { AgentRuntime } from '../agents/runtime.js';
import type { SubstrateNetConfig } from '../config.js';
import { INCIDENT_AGENT } from '../agents/incident.js';
import { getWindowText } from '../knowledge/triage-store.js';
import { upsertKNode, insertProvenance, insertKEdgeUnique } from '../knowledge/store.js';
import { DedupeAgent, storeKNodeEmbedding } from '../agents/dedupe.js';
import { buildProjectContext } from '../knowledge/project-context.js';
import { mapPool } from '../util/pool.js';
import type { KNode } from '../types.js';

export interface IncidentStats { incidents: number; }

function nid(kind: string, key: string): string {
  return createHash('sha1').update(`${kind}|${key.toLowerCase()}`).digest('hex').slice(0, 16);
}

/** Subset of windowIds whose triage activity is a bug fix. */
export function bugfixWindows(knowDb: SqliteDb, windowIds: string[]): string[] {
  if (windowIds.length === 0) return [];
  const placeholders = windowIds.map(() => '?').join(',');
  return (knowDb.prepare(`
    SELECT window_id AS id FROM triage_labels
    WHERE activity='bugfix' AND window_id IN (${placeholders})
  `).all(...windowIds) as Array<{ id: string }>).map((r) => r.id);
}

export async function runIncidentExtractor(
  knowDb: SqliteDb, cfg: SubstrateNetConfig, windowIds: string[],
): Promise<IncidentStats> {
  const targets = bugfixWindows(knowDb, windowIds);
  if (targets.length === 0) return { incidents: 0 };

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const context = buildProjectContext(knowDb) || undefined;
  const limit = cfg.concurrency ?? 4;
  let dedupe: DedupeAgent | undefined;
  try { dedupe = new DedupeAgent(cfg); } catch { dedupe = undefined; }

  const outcomes = await mapPool(targets, limit, async (windowId) => {
    const text = getWindowText(knowDb, windowId);
    if (!text) return undefined;
    try {
      const out = await rt.run(INCIDENT_AGENT, { payload: { text, windowId, context } });
      return { windowId, out };
    } catch {
      return undefined;
    }
  });

  let count = 0;
  for (const oc of outcomes) {
    if (!oc) continue;
    const { windowId, out } = oc;
    for (const inc of out.output.incidents) {
      const now = Date.now();
      const incidentId = nid('incident', inc.problem);
      const causeId = nid('root_cause', `${inc.problem}|${inc.root_cause}`);
      const nodes: KNode[] = [
        {
          id: incidentId, kind: 'incident', title: inc.problem,
          summary: inc.resolution ? `Resolved: ${inc.resolution}` : undefined,
          evidenceText: inc.evidence, confidence: out.confidence,
          source: 'agent:incident', grounding: 'stated', scope: 'technical',
          agentModel: out.model, createdAt: now, updatedAt: now,
        },
        {
          id: causeId, kind: 'root_cause', title: inc.root_cause,
          evidenceText: inc.evidence, confidence: out.confidence,
          source: 'agent:incident', grounding: 'stated', scope: 'technical',
          agentModel: out.model, createdAt: now, updatedAt: now,
        },
      ];
      let solutionId: string | undefined;
      if (inc.resolution) {
        solutionId = nid('solution', `${inc.problem}|${inc.resolution}`);
        nodes.push({
          id: solutionId, kind: 'solution', title: inc.resolution,
          evidenceText: inc.evidence, confidence: out.confidence,
          source: 'agent:incident', grounding: 'stated', scope: 'technical',
          agentModel: out.model, createdAt: now, updatedAt: now,
        });
      }

      const tx = knowDb.transaction(() => {
        for (const n of nodes) {
          upsertKNode(knowDb, n);
          insertProvenance(knowDb, { kNodeId: n.id, windowId });
        }
        insertKEdgeUnique(knowDb, { source: incidentId, target: causeId, kind: 'caused_by', weight: 1, metadata: { evidence: inc.evidence } });
        if (solutionId) {
          insertKEdgeUnique(knowDb, { source: solutionId, target: incidentId, kind: 'resolves', weight: 1, metadata: { evidence: inc.evidence } });
        }
      });
      tx();

      // Best-effort embeddings so RCA facts join dedupe/clustering.
      if (dedupe) {
        for (const n of nodes) {
          try { storeKNodeEmbedding(knowDb, n.id, await dedupe.embedText(`${n.kind}: ${n.title}`), dedupe.modelRef); }
          catch { /* ignore */ }
        }
      }
      count++;
    }
  }
  return { incidents: count };
}
