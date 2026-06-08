/**
 * Deterministic window briefs: verbatim quotes + compressed narrative for LLM stages.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { getWindowText } from '../knowledge/triage-store.js';
import type { IngestConfig } from '../config.js';

export interface WindowQuote {
  text: string;
  kind: 'user' | 'assistant' | 'doc' | 'syntax';
  offset?: string;
}

export interface WindowBrief {
  windowId: string;
  sessionId: string;
  sourceAgent: string;
  narrative: string;
  quotes: WindowQuote[];
  symbols: string[];
  tickets: string[];
  paths: string[];
  charBudget: number;
}

export function upsertWindowBrief(db: SqliteDb, brief: WindowBrief): void {
  db.prepare(`
    INSERT INTO window_briefs
      (window_id, narrative, quotes_json, symbols_json, tickets_json, paths_json, char_budget, built_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(window_id) DO UPDATE SET
      narrative=excluded.narrative, quotes_json=excluded.quotes_json,
      symbols_json=excluded.symbols_json, tickets_json=excluded.tickets_json,
      paths_json=excluded.paths_json, char_budget=excluded.char_budget, built_at=excluded.built_at
  `).run(
    brief.windowId, brief.narrative, JSON.stringify(brief.quotes),
    JSON.stringify(brief.symbols), JSON.stringify(brief.tickets), JSON.stringify(brief.paths),
    brief.charBudget, Date.now(),
  );
}

export function getWindowBrief(db: SqliteDb, windowId: string): WindowBrief | undefined {
  const row = db.prepare(`SELECT * FROM window_briefs WHERE window_id=?`).get(windowId) as any;
  if (!row) return undefined;
  const w = db.prepare(`SELECT session_id FROM turn_windows WHERE id=?`).get(windowId) as { session_id: string } | undefined;
  const sess = w
    ? (db.prepare(`SELECT agent FROM sessions WHERE id=?`).get(w.session_id) as { agent: string } | undefined)
    : undefined;
  return {
    windowId: row.window_id,
    sessionId: w?.session_id ?? '',
    sourceAgent: sess?.agent ?? 'unknown',
    narrative: row.narrative,
    quotes: JSON.parse(row.quotes_json),
    symbols: row.symbols_json ? JSON.parse(row.symbols_json) : [],
    tickets: row.tickets_json ? JSON.parse(row.tickets_json) : [],
    paths: row.paths_json ? JSON.parse(row.paths_json) : [],
    charBudget: row.char_budget,
  };
}

/** Serialize a brief for triage / extract prompts (bounded). */
export function serializeWindowBrief(brief: WindowBrief, maxChars?: number): string {
  const lines: string[] = [`WINDOW ${brief.windowId}`, `SOURCE: ${brief.sourceAgent}`];
  if (brief.tickets.length) lines.push(`TICKETS: ${brief.tickets.join(', ')}`);
  if (brief.paths.length) lines.push(`PATHS: ${brief.paths.slice(0, 12).join(', ')}`);
  if (brief.symbols.length) lines.push(`SYMBOLS: ${brief.symbols.slice(0, 12).join(', ')}`);
  if (brief.quotes.length) {
    lines.push('VERBATIM EVIDENCE:');
    for (const q of brief.quotes) {
      lines.push(`- [${q.kind}] ${q.text}`);
    }
  }
  lines.push('NARRATIVE:', brief.narrative);
  let text = lines.join('\n');
  const cap = maxChars ?? 2500;
  if (text.length > cap) {
    const half = Math.floor((cap - 32) / 2);
    text = text.slice(0, half) + `\n...[trimmed]...\n` + text.slice(text.length - half);
  }
  return text;
}

export function buildWindowBrief(db: SqliteDb, windowId: string, cfg: IngestConfig): WindowBrief | undefined {
  const text = getWindowText(db, windowId);
  if (!text) return undefined;

  const meta = db.prepare(`
    SELECT tw.session_id AS sessionId, s.agent AS agent
    FROM turn_windows tw JOIN sessions s ON s.id = tw.session_id
    WHERE tw.id=?
  `).get(windowId) as { sessionId: string; agent: string } | undefined;
  if (!meta) return undefined;

  const syntaxRows = db.prepare(`
    SELECT k.kind, k.title, k.evidence_text
    FROM k_nodes k JOIN k_provenance p ON p.k_node_id = k.id
    WHERE p.window_id=? AND k.source='syntax'
  `).all(windowId) as Array<{ kind: string; title: string; evidence_text: string | null }>;

  const tickets: string[] = [];
  const paths: string[] = [];
  const symbols: string[] = [];
  const quotes: WindowQuote[] = [];

  for (const s of syntaxRows) {
    if (s.kind === 'ticket_id') tickets.push(s.title);
    else if (s.kind === 'path_mention') paths.push(s.title);
    else if (s.kind === 'code_block' || s.kind === 'error_message') {
      quotes.push({ text: (s.evidence_text ?? s.title).slice(0, 400), kind: 'syntax' });
    }
  }

  const parts = text.split(/\n\n+/);
  for (const p of parts) {
    const m = /^\[(user|assistant)\]\s*(.*)/s.exec(p.trim());
    if (!m) continue;
    const role = m[1] as 'user' | 'assistant';
    const body = m[2].trim();
    if (body.length < 12) continue;
    if (role === 'user' || quotes.filter((q) => q.kind === role).length < 3) {
      quotes.push({ text: body.slice(0, 400), kind: role });
    }
  }

  const userBits = parts.filter((p) => p.startsWith('[user]')).map((p) => p.replace(/^\[user\]\s*/, '').trim());
  const asstBits = parts.filter((p) => p.startsWith('[assistant]')).map((p) => p.replace(/^\[assistant\]\s*/, '').trim());
  const narrativeParts: string[] = [];
  if (userBits[0]) narrativeParts.push(`User asks: ${userBits[0].slice(0, 280)}`);
  if (asstBits.length) narrativeParts.push(`Assistant: ${asstBits[asstBits.length - 1].slice(0, 400)}`);
  let narrative = narrativeParts.join('\n');
  const maxBrief = cfg.maxBriefChars ?? 2000;
  if (narrative.length > 1200) {
    narrative = narrative.slice(0, 600) + '\n...\n' + narrative.slice(-500);
  }

  const brief: WindowBrief = {
    windowId,
    sessionId: meta.sessionId,
    sourceAgent: meta.agent,
    narrative,
    quotes: quotes.slice(0, 8),
    symbols: [...new Set(symbols)],
    tickets: [...new Set(tickets)],
    paths: [...new Set(paths)],
    charBudget: 0,
  };
  brief.charBudget = serializeWindowBrief(brief, maxBrief).length;
  return brief;
}

export function buildBriefsForWindows(
  db: SqliteDb, windowIds: string[], cfg: IngestConfig,
): Map<string, WindowBrief> {
  const out = new Map<string, WindowBrief>();
  for (const id of windowIds) {
    const b = buildWindowBrief(db, id, cfg);
    if (b) {
      upsertWindowBrief(db, b);
      out.set(id, b);
    }
  }
  return out;
}
