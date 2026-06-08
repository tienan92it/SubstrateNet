/**
 * Triage runner. For each newly-created window, run the Triage Agent and
 * persist its labels. After triage, embed kept windows via the Dedupe Agent
 * so downstream extractors and the clusterer can use similarity.
 *
 * Pipeline contract:
 *   - One agent call per window (cached by content).
 *   - Errors from the agent are logged and treated as "kept" with low
 *     confidence so we don't silently drop content when the LLM is down.
 *   - Embedding failures are non-fatal: the window stays kept, just without
 *     an embedding (downstream falls back to lexical similarity).
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import type { SubstrateNetConfig } from '../config.js';
import { AgentRuntime } from '../agents/runtime.js';
// Ensure agents register themselves.
import '../agents/index.js';
import { TRIAGE_AGENT, shouldKeep, labelsToRow } from '../agents/triage.js';
import { TRIAGE_BATCH_AGENT } from '../agents/triage-batch.js';
import { DedupeAgent, storeWindowEmbedding } from '../agents/dedupe.js';
import { upsertTriageLabels, getWindowText } from '../knowledge/triage-store.js';
import { buildProjectContext } from '../knowledge/project-context.js';
import { mapPool } from '../util/pool.js';

export interface TriageRunResult {
  triaged: number;
  kept: number;
  dropped: number;
  keptWindowIds: string[];
  embedded: number;
  duplicateWindows: number;
}

export interface TriageRunOpts {
  onWindow?: (current: number, total: number) => void;
}

type Labeled =
  | { windowId: string; ok: true; model: string; output: any }
  | { windowId: string; ok: false; error: string };

/**
 * Triage one group of windows in a single batched call, falling back to
 * per-window triage when the batch fails or omits a window. `onDone` is called
 * once per window for progress.
 */
async function triageGroup(
  rt: AgentRuntime, db: SqliteDb, windowIds: string[], context: string | undefined,
  onDone: () => void,
): Promise<Labeled[]> {
  const items = windowIds
    .map((windowId) => ({ windowId, text: getWindowText(db, windowId) }))
    .filter((w): w is { windowId: string; text: string } => Boolean(w.text));
  if (items.length === 0) {
    windowIds.forEach(onDone);
    return [];
  }

  const labeled = await triageGroupInner(rt, db, items, context);
  items.forEach(onDone);
  return labeled;
}

async function triageGroupInner(
  rt: AgentRuntime, db: SqliteDb,
  items: Array<{ windowId: string; text: string }>, context: string | undefined,
): Promise<Labeled[]> {
  // Try the batch agent first.
  try {
    const out = await rt.run(TRIAGE_BATCH_AGENT, { payload: { windows: items, context } });
    const byId = new Map(out.output.results.map((r) => [r.windowId, r]));
    const labeled: Labeled[] = items.map(({ windowId }) => {
      const r = byId.get(windowId);
      return r
        ? { windowId, ok: true as const, model: out.model, output: r }
        : { windowId, ok: false as const, error: 'omitted from batch result' };
    });
    // Accept the batch only if it covered at least half the windows; otherwise
    // it likely mis-parsed — retry each window individually.
    if (labeled.filter((l) => l.ok).length >= Math.ceil(items.length / 2)) return labeled;
  } catch { /* fall through to single-window */ }

  const labeled: Labeled[] = [];
  for (const { windowId, text } of items) {
    try {
      const out = await rt.run(TRIAGE_AGENT, { payload: { text, windowId, context } });
      labeled.push({ windowId, ok: true, model: out.model, output: out.output });
    } catch (e) {
      labeled.push({ windowId, ok: false, error: (e as Error).message.slice(0, 200) });
    }
  }
  return labeled;
}

export async function runTriageForWindows(
  _root: string, db: SqliteDb, cfg: SubstrateNetConfig, windowIds: string[],
  runOpts: TriageRunOpts = {},
): Promise<TriageRunResult> {
  const rt = new AgentRuntime({ knowledgeDb: db, config: cfg });
  const result: TriageRunResult = {
    triaged: 0, kept: 0, dropped: 0, keptWindowIds: [],
    embedded: 0, duplicateWindows: 0,
  };

  const limit = cfg.concurrency ?? 4;
  const batchSize = Math.max(1, cfg.batchSize ?? 8);
  // Build the grounding context once and reuse for every window.
  const context = buildProjectContext(db) || undefined;

  // Phase 1: triage in batches (one LLM call per `batchSize` windows). Each
  // group falls back to single-window triage if the batch fails to parse, so
  // batching only reduces call count — never coverage.
  let triageDone = 0;
  const groups: string[][] = [];
  for (let i = 0; i < windowIds.length; i += batchSize) groups.push(windowIds.slice(i, i + batchSize));

  const labeledGroups = await mapPool(groups, limit, (group) =>
    triageGroup(rt, db, group, context, () => {
      triageDone++;
      runOpts.onWindow?.(triageDone, windowIds.length);
    }),
  );
  const labeled: Labeled[] = labeledGroups.flat();

  // Phase 2: persist labels sequentially (DB writes).
  for (const l of labeled) {
    if (!l) continue;
    if (l.ok) {
      const kept = shouldKeep(l.output);
      upsertTriageLabels(db, labelsToRow(l.windowId, l.model, l.output, kept));
      result.triaged++;
      if (kept) { result.kept++; result.keptWindowIds.push(l.windowId); }
      else result.dropped++;
    } else {
      upsertTriageLabels(db, labelsToRow(l.windowId, 'fallback', {
        relevance: 'unknown', domain: 'unknown', quality: 'signal', linkage: 'this_project',
        activity: 'question', confidence: 0.1, rationale: `triage agent failed: ${l.error}`,
      }, true));
      result.triaged++;
      result.kept++;
      result.keptWindowIds.push(l.windowId);
    }
  }

  // Dedupe pass: embed kept windows (one batched call) and flag near-duplicates
  // against windows from prior ingest runs. Current-run windows are excluded
  // from the comparison so a fresh batch never dups against itself.
  if (result.keptWindowIds.length > 0) {
    try {
      const dedupe = new DedupeAgent(cfg);
      const newOnly = new Set(result.keptWindowIds);
      const ids = result.keptWindowIds.filter((id) => getWindowText(db, id));
      const texts = ids.map((id) => getWindowText(db, id)!);
      const vectors = await dedupe.embedBatch(texts);
      const novelKept: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const v = vectors[i];
        if (!v) { novelKept.push(id); continue; }
        storeWindowEmbedding(db, id, v);
        result.embedded++;
        const dups = dedupe.nearestWindow(db, v, 1, 0.92, [...newOnly]);
        if (dups.length > 0) {
          result.duplicateWindows++;
          db.prepare(`UPDATE triage_labels SET rationale = COALESCE(rationale,'') || ' [dup_of:' || ? || ']' WHERE window_id=?`)
            .run(dups[0].id, id);
        } else {
          novelKept.push(id);
        }
      }
      result.keptWindowIds = novelKept;
    } catch {
      // Dedupe backend unavailable: leave keptWindowIds as-is, downstream
      // extractors will just process everything.
    }
  }

  return result;
}
