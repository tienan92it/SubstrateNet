/**
 * Source classification pass.
 *
 * For each kept window backed by a non-code source (the `docs` agent family:
 * docs + diagrams), label its content type (doc_kind), topics, and product
 * area. Runs after triage; results land in `source_labels` and feed the
 * dashboard facets + MCP research tools.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { AgentRuntime } from '../agents/runtime.js';
import type { SubstrateNetConfig } from '../config.js';
import { SOURCE_CLASSIFIER_AGENT } from '../agents/source-classifier.js';
import { getWindowText } from '../knowledge/triage-store.js';
import { upsertSourceLabel } from '../knowledge/source-store.js';
import { buildProjectContext } from '../knowledge/project-context.js';
import { mapPool } from '../util/pool.js';

export interface ClassifySourcesStats { classified: number; }

/** Map of windowId -> { sessionId, sourcePath } for source-backed windows. */
function sourceWindows(knowDb: SqliteDb, windowIds: string[]): Map<string, { sessionId: string; sourcePath: string }> {
  if (windowIds.length === 0) return new Map();
  const placeholders = windowIds.map(() => '?').join(',');
  const rows = knowDb.prepare(`
    SELECT tw.id AS id, tw.session_id AS sessionId, s.source_path AS sourcePath
    FROM turn_windows tw JOIN sessions s ON s.id = tw.session_id
    WHERE s.agent = 'docs' AND tw.id IN (${placeholders})
  `).all(...windowIds) as Array<{ id: string; sessionId: string; sourcePath: string }>;
  const m = new Map<string, { sessionId: string; sourcePath: string }>();
  for (const r of rows) m.set(r.id, { sessionId: r.sessionId, sourcePath: r.sourcePath });
  return m;
}

export async function runSourceClassifier(
  knowDb: SqliteDb, cfg: SubstrateNetConfig, windowIds: string[], context?: string,
): Promise<ClassifySourcesStats> {
  const targets = sourceWindows(knowDb, windowIds);
  if (targets.size === 0) return { classified: 0 };

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const list = [...targets.entries()];
  const limit = cfg.concurrency ?? 4;
  const ctx = context ?? (buildProjectContext(knowDb) || undefined);

  const outcomes = await mapPool(list, limit, async ([windowId, meta]) => {
    const text = getWindowText(knowDb, windowId);
    if (!text) return undefined;
    try {
      const out = await rt.run(SOURCE_CLASSIFIER_AGENT, {
        payload: { text, sourcePath: meta.sourcePath, context: ctx },
      });
      return { windowId, meta, out };
    } catch {
      return undefined;
    }
  });

  let classified = 0;
  for (const oc of outcomes) {
    if (!oc) continue;
    upsertSourceLabel(knowDb, {
      windowId: oc.windowId,
      sessionId: oc.meta.sessionId,
      sourcePath: oc.meta.sourcePath,
      docKind: oc.out.output.doc_kind,
      topics: oc.out.output.topics,
      area: oc.out.output.area,
      model: oc.out.model,
    });
    classified++;
  }
  return { classified };
}
