/**
 * Pluggable research backend for opt-in external (web) enrichment.
 *
 * Default is `none` — Substrate Net stays 100% offline unless a backend is
 * configured. When enabled, results are cached in knowledge.db `research_cache`
 * so repeat runs don't re-hit the network and stay reproducible.
 *
 * A successful lookup is what upgrades a `model` claim to `external`: it
 * attaches a real source URL. No backend → claims stay `model` (clearly an
 * inference), never silently promoted.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { createHash } from 'crypto';
import type { SubstrateNetConfig } from '../config.js';

export interface ResearchResult {
  summary: string;
  sourceUrl: string;
}

export interface ResearchBackend {
  readonly kind: string;
  /** Returns a cited result, or undefined if nothing authoritative found. */
  lookup(query: string): Promise<ResearchResult | undefined>;
}

export interface ResearchConfig {
  kind?: 'none' | 'search-api';
  endpoint?: string;
  apiKeyEnv?: string;
}

/** A backend that never returns anything — the offline default. */
class NoneBackend implements ResearchBackend {
  readonly kind = 'none';
  async lookup(): Promise<undefined> { return undefined; }
}

/**
 * Minimal search-API backend (Tavily/Brave/SerpAPI-shaped JSON). Kept generic:
 * POSTs {query} to the configured endpoint with a Bearer key and reads the
 * first result's url + snippet. Off unless `research.endpoint` is configured.
 */
class SearchApiBackend implements ResearchBackend {
  readonly kind = 'search-api';
  constructor(private endpoint: string, private apiKey?: string) {}
  async lookup(query: string): Promise<ResearchResult | undefined> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ query, max_results: 1 }),
      });
      if (!res.ok) return undefined;
      const data: any = await res.json();
      const first = data?.results?.[0] ?? data?.web?.results?.[0];
      if (!first?.url) return undefined;
      return { summary: String(first.content ?? first.snippet ?? first.title ?? '').slice(0, 600), sourceUrl: String(first.url) };
    } catch {
      return undefined;
    }
  }
}

export function createResearchBackend(cfg: SubstrateNetConfig): ResearchBackend {
  const rc = (cfg as any).research as ResearchConfig | undefined;
  if (!rc || !rc.kind || rc.kind === 'none' || !rc.endpoint) return new NoneBackend();
  if (rc.kind === 'search-api') {
    return new SearchApiBackend(rc.endpoint, rc.apiKeyEnv ? process.env[rc.apiKeyEnv] : undefined);
  }
  return new NoneBackend();
}

/** Cached lookup: checks research_cache first, persists successful results. */
export async function cachedLookup(
  db: SqliteDb, backend: ResearchBackend, query: string,
): Promise<ResearchResult | undefined> {
  if (backend.kind === 'none') return undefined;
  const hash = createHash('sha1').update(query).digest('hex');
  const row = db.prepare(`SELECT result_json, source_url FROM research_cache WHERE query_hash=?`).get(hash) as
    | { result_json: string; source_url: string | null } | undefined;
  if (row) {
    try { return JSON.parse(row.result_json) as ResearchResult; } catch { /* fallthrough */ }
  }
  const result = await backend.lookup(query);
  if (result) {
    db.prepare(`
      INSERT INTO research_cache (query_hash, query, result_json, source_url, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(query_hash) DO UPDATE SET result_json=excluded.result_json, source_url=excluded.source_url, fetched_at=excluded.fetched_at
    `).run(hash, query, JSON.stringify(result), result.sourceUrl, Date.now());
  }
  return result;
}
