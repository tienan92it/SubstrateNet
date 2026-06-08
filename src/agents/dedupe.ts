/**
 * Dedupe "Agent".
 *
 * Not a chat agent — it makes its semantic decision via an embedding model.
 * Lives in the agents/ folder because:
 *   - it's a swappable model-backed component
 *   - its decisions are auditable via agent_runs (we record the embedding
 *     model used so changing it invalidates the cache by convention)
 *
 * Two responsibilities:
 *   1. embedText(text) -> Float32Array     (delegates to backend.embed)
 *   2. nearestKNode(...)                   (cosine over k_nodes embeddings)
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import type { SubstrateNetConfig } from '../config.js';
import { parseModelRef, resolveApiKey } from '../config.js';
import { OllamaBackend } from './backends/ollama.js';
import { OpenAIBackend } from './backends/openai.js';
import type { Backend } from './backends/base.js';
import { cosine, decodeVector, encodeVector } from '../knowledge/embeddings.js';

const AGENT_KEY = 'dedupe';

export interface NearestKNodeHit {
  id: string;
  kind: string;
  title: string;
  score: number;
}

export class DedupeAgent {
  private readonly backend: Backend;
  readonly model: string;
  readonly modelRef: string;

  constructor(cfg: SubstrateNetConfig) {
    const spec = cfg.agents[AGENT_KEY];
    if (!spec) throw new Error(`Agent "${AGENT_KEY}" missing in config.agents`);
    this.modelRef = spec.model;
    const { backend, model } = parseModelRef(spec.model);
    this.model = model;
    const bspec = cfg.agentBackends[backend];
    if (!bspec) throw new Error(`Backend "${backend}" not configured`);
    switch (bspec.kind) {
      case 'ollama':
        this.backend = new OllamaBackend({ endpoint: bspec.endpoint ?? 'http://localhost:11434' });
        break;
      case 'openai-compatible':
        this.backend = new OpenAIBackend({
          endpoint: bspec.endpoint ?? 'https://api.openai.com/v1',
          apiKey: resolveApiKey(bspec),
        });
        break;
      default:
        throw new Error(`Backend kind ${bspec.kind} does not support embeddings`);
    }
    if (!this.backend.embed) {
      throw new Error(`Backend "${backend}" does not implement embeddings`);
    }
  }

  async embedText(text: string): Promise<Float32Array> {
    const res = await this.backend.embed!({ model: this.model, texts: [text] });
    if (!res.vectors[0]) throw new Error('Backend returned no embedding vector');
    return Float32Array.from(res.vectors[0]);
  }

  /**
   * Embed many texts in one backend call. OpenAI-compatible backends embed the
   * whole batch in a single request; Ollama loops internally. Returns one vector
   * per input (undefined where the backend returned nothing).
   */
  async embedBatch(texts: string[]): Promise<Array<Float32Array | undefined>> {
    if (texts.length === 0) return [];
    const res = await this.backend.embed!({ model: this.model, texts });
    return texts.map((_, i) => (res.vectors[i] ? Float32Array.from(res.vectors[i]) : undefined));
  }

  /**
   * Find the top-K nearest existing k_nodes (by stored embedding) to the
   * given query embedding. Brute-force cosine; fine up to ~50K facts.
   */
  nearestKNode(
    db: SqliteDb, query: Float32Array, k = 5, minScore = 0.7,
    kindFilter?: string[],
  ): NearestKNodeHit[] {
    const where = kindFilter && kindFilter.length
      ? `AND k.kind IN (${kindFilter.map(() => '?').join(',')})`
      : ``;
    const rows = db.prepare(`
      SELECT k.id, k.kind, k.title, e.embedding AS emb
      FROM k_nodes k
      JOIN k_node_embeddings e ON e.k_node_id = k.id
      WHERE 1=1 ${where}
    `).all(...(kindFilter ?? [])) as Array<{ id: string; kind: string; title: string; emb: Buffer }>;
    const hits: NearestKNodeHit[] = [];
    for (const r of rows) {
      const v = decodeVector(r.emb);
      if (!v) continue;
      const s = cosine(query, v);
      if (s >= minScore) hits.push({ id: r.id, kind: r.kind, title: r.title, score: s });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /**
   * Find the top-K nearest existing turn_windows by stored embedding. Used to
   * detect duplicate windows (same exchange happening across multiple sessions).
   */
  nearestWindow(
    db: SqliteDb, query: Float32Array, k = 5, minScore = 0.85, excludeIds: string[] = [],
  ): Array<{ id: string; score: number }> {
    const rows = db.prepare(`
      SELECT id, embedding AS emb FROM turn_windows WHERE embedding IS NOT NULL
    `).all() as Array<{ id: string; emb: Buffer }>;
    const out: Array<{ id: string; score: number }> = [];
    const exclude = new Set(excludeIds);
    for (const r of rows) {
      if (exclude.has(r.id)) continue;
      const v = decodeVector(r.emb);
      if (!v) continue;
      const s = cosine(query, v);
      if (s >= minScore) out.push({ id: r.id, score: s });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }
}

/**
 * SQL helper to write an embedding to a turn_windows row.
 */
export function storeWindowEmbedding(db: SqliteDb, windowId: string, v: Float32Array): void {
  db.prepare(`UPDATE turn_windows SET embedding=? WHERE id=?`)
    .run(encodeVector(v), windowId);
}

/**
 * SQL helper to write an embedding to a k_nodes row. Used by extractor agents
 * in M5 right after they create a new fact.
 */
export function storeKNodeEmbedding(
  db: SqliteDb, kNodeId: string, v: Float32Array, model?: string,
): void {
  db.prepare(`
    INSERT INTO k_node_embeddings (k_node_id, embedding, model) VALUES (?, ?, ?)
    ON CONFLICT(k_node_id) DO UPDATE SET embedding=excluded.embedding, model=excluded.model
  `).run(kNodeId, encodeVector(v), model ?? null);
}

export function getKNodeEmbedding(db: SqliteDb, kNodeId: string): Float32Array | undefined {
  const row = db.prepare(`SELECT embedding AS e FROM k_node_embeddings WHERE k_node_id=?`)
    .get(kNodeId) as { e: Buffer } | undefined;
  if (!row) return undefined;
  return decodeVector(row.e);
}
