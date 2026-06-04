/**
 * Persistence for L1.5 triage labels.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import type { TriageLabels } from '../types.js';

export function upsertTriageLabels(db: SqliteDb, l: TriageLabels): void {
  db.prepare(`
    INSERT INTO triage_labels
      (window_id, relevance, domain, quality, linkage, activity, confidence,
       rationale, model, produced_at, kept)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(window_id) DO UPDATE SET
      relevance=excluded.relevance, domain=excluded.domain,
      quality=excluded.quality, linkage=excluded.linkage, activity=excluded.activity,
      confidence=excluded.confidence, rationale=excluded.rationale,
      model=excluded.model, produced_at=excluded.produced_at,
      kept=excluded.kept
  `).run(
    l.windowId, l.relevance, l.domain, l.quality, l.linkage, l.activity ?? null,
    l.confidence, l.rationale ?? null, l.model, l.producedAt, l.kept ? 1 : 0,
  );
}

export function getTriageLabels(db: SqliteDb, windowId: string): TriageLabels | undefined {
  const row = db
    .prepare(`SELECT * FROM triage_labels WHERE window_id=?`)
    .get(windowId) as any;
  if (!row) return undefined;
  return {
    windowId: row.window_id,
    relevance: row.relevance,
    domain: row.domain,
    quality: row.quality,
    linkage: row.linkage,
    activity: row.activity ?? undefined,
    confidence: row.confidence,
    rationale: row.rationale ?? undefined,
    model: row.model,
    producedAt: row.produced_at,
    kept: !!row.kept,
  };
}

export function getWindowText(db: SqliteDb, windowId: string): string | undefined {
  const w = db.prepare(`SELECT session_id, start_turn, end_turn FROM turn_windows WHERE id=?`).get(windowId) as
    | { session_id: string; start_turn: string; end_turn: string } | undefined;
  if (!w) return undefined;
  // Rebuild window text from its turns. start_turn / end_turn are of the form
  // `<session_id>-<idx>` so we can pull the idx range.
  const startIdx = parseInt(w.start_turn.split('-').pop()!, 10);
  const endIdx = parseInt(w.end_turn.split('-').pop()!, 10);
  const rows = db
    .prepare(`SELECT role, text FROM turns WHERE session_id=? AND idx BETWEEN ? AND ? ORDER BY idx ASC`)
    .all(w.session_id, startIdx, endIdx) as Array<{ role: string; text: string }>;
  return rows.map((r) => `[${r.role}] ${r.text}`).join('\n\n').trim();
}
