/**
 * Persistence for source-artifact content labels (docs / diagrams / notes).
 * One row per classified window, parallel to triage_labels.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import type { DocKind } from '../types.js';

export interface SourceLabel {
  windowId: string;
  sessionId?: string;
  sourcePath?: string;
  docKind: DocKind;
  topics: string[];
  area?: string;
  model?: string;
}

export function upsertSourceLabel(db: SqliteDb, l: SourceLabel): void {
  db.prepare(`
    INSERT INTO source_labels
      (window_id, session_id, source_path, doc_kind, topics, area, model, produced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(window_id) DO UPDATE SET
      session_id=excluded.session_id, source_path=excluded.source_path,
      doc_kind=excluded.doc_kind, topics=excluded.topics, area=excluded.area,
      model=excluded.model, produced_at=excluded.produced_at
  `).run(
    l.windowId, l.sessionId ?? null, l.sourcePath ?? null, l.docKind,
    JSON.stringify(l.topics ?? []), l.area ?? null, l.model ?? null, Date.now(),
  );
}

export interface SourceLabelRow extends SourceLabel { producedAt: number; }

/** Aggregate doc-kind counts across the project (for dashboards / facets). */
export function countByDocKind(db: SqliteDb): Record<string, number> {
  const rows = db.prepare(`SELECT doc_kind AS k, COUNT(*) AS n FROM source_labels GROUP BY doc_kind`)
    .all() as Array<{ k: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k) out[r.k] = r.n;
  return out;
}
