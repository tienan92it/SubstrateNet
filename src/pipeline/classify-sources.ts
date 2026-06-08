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
import { SOURCE_CLASSIFIER_BATCH_AGENT } from '../agents/source-classifier-batch.js';
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

/** windowIds that already have a source label (skip re-classifying). */
function alreadyClassified(knowDb: SqliteDb, windowIds: string[]): Set<string> {
  if (windowIds.length === 0) return new Set();
  const placeholders = windowIds.map(() => '?').join(',');
  const rows = knowDb.prepare(
    `SELECT window_id AS id FROM source_labels WHERE window_id IN (${placeholders})`,
  ).all(...windowIds) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

export async function runSourceClassifier(
  knowDb: SqliteDb, cfg: SubstrateNetConfig, windowIds: string[], context?: string,
): Promise<ClassifySourcesStats> {
  const targets = sourceWindows(knowDb, windowIds);
  if (targets.size === 0) return { classified: 0 };

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const limit = cfg.concurrency ?? 4;
  const batchSize = Math.max(1, cfg.batchSize ?? 8);
  const ctx = context ?? (buildProjectContext(knowDb) || undefined);

  // Skip windows already labelled, then collect text for the rest.
  const done = alreadyClassified(knowDb, [...targets.keys()]);
  const items = [...targets.entries()]
    .filter(([windowId]) => !done.has(windowId))
    .map(([windowId, meta]) => ({ windowId, meta, text: getWindowText(knowDb, windowId) }))
    .filter((x): x is { windowId: string; meta: { sessionId: string; sourcePath: string }; text: string } => Boolean(x.text));
  if (items.length === 0) return { classified: 0 };

  const groups: typeof items[] = [];
  for (let i = 0; i < items.length; i += batchSize) groups.push(items.slice(i, i + batchSize));

  let classified = 0;
  const groupResults = await mapPool(groups, limit, (group) => classifyGroup(rt, group, ctx));
  for (const labels of groupResults) {
    for (const l of labels) {
      upsertSourceLabel(knowDb, l);
      classified++;
    }
  }
  return { classified };
}

type GroupItem = { windowId: string; meta: { sessionId: string; sourcePath: string }; text: string };

/** Classify one group via the batch agent, falling back to single-window calls. */
async function classifyGroup(
  rt: AgentRuntime, group: GroupItem[], ctx: string | undefined,
): Promise<Array<{ windowId: string; sessionId: string; sourcePath: string; docKind: any; topics: string[]; area?: string; model: string }>> {
  const out: Array<{ windowId: string; sessionId: string; sourcePath: string; docKind: any; topics: string[]; area?: string; model: string }> = [];
  try {
    const res = await rt.run(SOURCE_CLASSIFIER_BATCH_AGENT, {
      payload: { items: group.map((g) => ({ windowId: g.windowId, sourcePath: g.meta.sourcePath, text: g.text })), context: ctx },
    });
    const byId = new Map(res.output.results.map((r) => [r.windowId, r]));
    if (byId.size >= Math.ceil(group.length / 2)) {
      for (const g of group) {
        const r = byId.get(g.windowId);
        if (!r) continue;
        out.push({ windowId: g.windowId, sessionId: g.meta.sessionId, sourcePath: g.meta.sourcePath, docKind: r.doc_kind, topics: r.topics, area: r.area, model: res.model });
      }
      if (out.length > 0) return out;
    }
  } catch { /* fall through */ }

  // Single-window fallback.
  for (const g of group) {
    try {
      const res = await rt.run(SOURCE_CLASSIFIER_AGENT, {
        payload: { text: g.text, sourcePath: g.meta.sourcePath, context: ctx },
      });
      out.push({ windowId: g.windowId, sessionId: g.meta.sessionId, sourcePath: g.meta.sourcePath, docKind: res.output.doc_kind, topics: res.output.topics, area: res.output.area, model: res.model });
    } catch { /* skip this window */ }
  }
  return out;
}
