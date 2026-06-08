/**
 * Counters for mechanical drops (windows, facts) surfaced in doctor / debugging.
 */
import type { Database as SqliteDb } from 'better-sqlite3';

const AUDIT_KEY = 'pipeline_audit';

export interface PipelineAudit {
  windowsMechanicalDup?: number;
  windowsSessionSkipped?: number;
  factsAnchorRejected?: number;
  factsEarlyDeduped?: number;
  filesAnalyzeSkippedTier?: number;
}

export function getPipelineAudit(db: SqliteDb): PipelineAudit {
  const row = db.prepare(`SELECT value FROM pipeline_state WHERE key=?`).get(AUDIT_KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as PipelineAudit;
  } catch {
    return {};
  }
}

export function bumpPipelineAudit(db: SqliteDb, patch: Partial<PipelineAudit>): void {
  const cur = getPipelineAudit(db);
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'number') {
      (cur as Record<string, number>)[k] = ((cur as Record<string, number>)[k] ?? 0) + v;
    }
  }
  db.prepare(`
    INSERT INTO pipeline_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(AUDIT_KEY, JSON.stringify(cur), Date.now());
}
