/**
 * Pre-triage window dedupe via embeddings (before any triage LLM call).
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { DedupeAgent, storeWindowEmbedding } from '../agents/dedupe.js';
import { getWindowText } from '../knowledge/triage-store.js';
import { labelsToRow } from '../agents/triage.js';
import { upsertTriageLabels } from '../knowledge/triage-store.js';
import { bumpPipelineAudit } from '../knowledge/pipeline-audit.js';
import type { SubstrateNetConfig, IngestConfig } from '../config.js';
import { resolveIngestConfig } from '../config.js';
import { serializeWindowBrief, getWindowBrief } from './window-brief.js';

export interface PreTriageDedupeResult {
  kept: string[];
  dropped: Array<{ id: string; dupOf: string }>;
}

export function markMechanicalWindowDrop(db: SqliteDb, windowId: string, dupOf: string): void {
  upsertTriageLabels(db, labelsToRow(windowId, 'mechanical', {
    relevance: 'mixed', domain: 'unknown', quality: 'noise', linkage: 'this_project',
    activity: 'chitchat', confidence: 0.95, rationale: `mechanical_dup:${dupOf}`,
  }, false));
}

export async function preTriageWindowDedupe(
  knowDb: SqliteDb,
  cfg: SubstrateNetConfig,
  windowIds: string[],
): Promise<PreTriageDedupeResult> {
  const ingest = resolveIngestConfig(cfg);
  if (!ingest.preTriageDedupe || windowIds.length === 0) {
    return { kept: [...windowIds], dropped: [] };
  }

  let dedupe: DedupeAgent;
  try {
    dedupe = new DedupeAgent(cfg);
  } catch {
    return { kept: [...windowIds], dropped: [] };
  }

  const threshold = ingest.windowDupThreshold ?? 0.92;
  const kept: string[] = [];
  const dropped: Array<{ id: string; dupOf: string }> = [];
  const batchKeptEmbeddings: Array<{ id: string; v: Float32Array }> = [];

  const embedText = (id: string): string | undefined => {
    const brief = getWindowBrief(knowDb, id);
    if (brief) return serializeWindowBrief(brief, 3000);
    return getWindowText(knowDb, id);
  };

  for (const id of windowIds) {
    const text = embedText(id);
    if (!text) continue;

    let v: Float32Array | undefined;
    try {
      v = await dedupe.embedText(text);
    } catch {
      kept.push(id);
      continue;
    }

    const prior = dedupe.nearestWindow(knowDb, v, 1, threshold, [...kept, ...dropped.map((d) => d.id)]);
    if (prior.length > 0) {
      dropped.push({ id, dupOf: prior[0].id });
      markMechanicalWindowDrop(knowDb, id, prior[0].id);
      continue;
    }

    for (const bk of batchKeptEmbeddings) {
      const s = cosineLocal(v, bk.v);
      if (s >= threshold) {
        dropped.push({ id, dupOf: bk.id });
        markMechanicalWindowDrop(knowDb, id, bk.id);
        v = undefined;
        break;
      }
    }
    if (!v) continue;

    storeWindowEmbedding(knowDb, id, v);
    batchKeptEmbeddings.push({ id, v });
    kept.push(id);
  }

  if (dropped.length) bumpPipelineAudit(knowDb, { windowsMechanicalDup: dropped.length });
  return { kept, dropped };
}

function cosineLocal(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
