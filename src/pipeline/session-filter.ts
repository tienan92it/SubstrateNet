/**
 * Session-level ingest filters (no LLM).
 */
import { statSync } from 'fs';
import type { SessionRef } from '../types.js';
import type { IngestConfig } from '../config.js';

export interface SessionFilterState {
  accepted: number;
}

export function shouldIngestSession(
  ref: SessionRef,
  cfg: IngestConfig,
  state: SessionFilterState,
): boolean {
  if (cfg.skipAgents?.includes(ref.agent)) return false;
  const max = cfg.maxSessions ?? 200;
  if (state.accepted >= max) return false;

  let bytes = 0;
  let mtime = ref.startedAt ?? 0;
  try {
    const st = statSync(ref.sourcePath);
    bytes = st.size;
    mtime = st.mtimeMs;
  } catch {
    return false;
  }

  if (bytes < (cfg.minSessionBytes ?? 256)) return false;

  const sinceDays = cfg.sinceDays ?? 365;
  if (sinceDays > 0 && mtime > 0) {
    const cutoff = Date.now() - sinceDays * 86_400_000;
    if (mtime < cutoff) return false;
  }

  state.accepted++;
  return true;
}
