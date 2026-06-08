/**
 * Small key/value store for pipeline bookkeeping in knowledge.db.
 * Used to skip expensive stages when their inputs are unchanged
 * (e.g. the enrich input hash, the config model fingerprint).
 */
import type { Database as SqliteDb } from 'better-sqlite3';

export function getPipelineState(db: SqliteDb, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM pipeline_state WHERE key=?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setPipelineState(db: SqliteDb, key: string, value: string): void {
  db.prepare(`
    INSERT INTO pipeline_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, value, Date.now());
}
