/**
 * Deterministic window segmenter.
 *
 * Slices a session's turns into windows by user-turn boundaries with
 * size and time caps. A window is a coherent exchange that we will feed
 * to the Triage Agent (and, if kept, to extractors).
 *
 * Rules:
 *   - A new window starts on every `user` turn (after non-trivial content).
 *   - A window must contain at least one user turn AND at least one
 *     assistant/tool response.
 *   - Hard caps: maxTurns per window, maxTextChars per window.
 *   - Split if those caps are exceeded.
 */
import type { Turn } from '../types.js';
import { createHash } from 'crypto';
import type { Database as SqliteDb } from 'better-sqlite3';

export interface SegmenterOpts {
  maxTurns?: number;
  maxTextChars?: number;
}

export interface PendingWindow {
  id: string;
  sessionId: string;
  startTurn: string;
  endTurn: string;
  textHash: string;
  text: string;
  turns: Turn[];
}

const DEFAULT_OPTS: Required<SegmenterOpts> = {
  maxTurns: 12,
  maxTextChars: 8000,
};

export function segmentTurnsToWindows(
  sessionId: string, turns: Turn[], opts: SegmenterOpts = {},
): PendingWindow[] {
  const { maxTurns, maxTextChars } = { ...DEFAULT_OPTS, ...opts };
  const windows: PendingWindow[] = [];

  let cur: Turn[] = [];
  let curText = '';

  const flush = () => {
    if (cur.length === 0) return;
    const hasUser = cur.some((t) => t.role === 'user');
    const hasResponse = cur.some((t) => t.role === 'assistant' || t.role === 'tool');
    if (!hasUser || !hasResponse) {
      cur = [];
      curText = '';
      return;
    }
    const start = cur[0];
    const end = cur[cur.length - 1];
    const text = cur.map((t) => `[${t.role}] ${t.text}`).join('\n\n').trim();
    const hash = createHash('sha1').update(text).digest('hex');
    const id = createHash('sha1')
      .update(`${sessionId}|${start.idx}|${end.idx}|${hash}`)
      .digest('hex')
      .slice(0, 16);
    windows.push({
      id,
      sessionId,
      startTurn: start.id,
      endTurn: end.id,
      textHash: hash,
      text,
      turns: [...cur],
    });
    cur = [];
    curText = '';
  };

  for (const t of turns) {
    if (t.role === 'user' && cur.length > 0) flush();
    cur.push(t);
    curText += t.text;
    if (cur.length >= maxTurns || curText.length >= maxTextChars) flush();
  }
  flush();
  return windows;
}

/** @returns true when the window row was newly inserted. */
export function insertWindow(db: SqliteDb, w: PendingWindow): boolean {
  const info = db.prepare(`
    INSERT INTO turn_windows (id, session_id, start_turn, end_turn, text_hash, embedding)
    VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO NOTHING
  `).run(w.id, w.sessionId, w.startTurn, w.endTurn, w.textHash);
  return info.changes > 0;
}
