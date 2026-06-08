/**
 * Per-model token pricing and per-agent token heuristics for setup plans.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { parseModelRef, type SubstrateNetConfig } from '../config.js';

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
}

/** USD per 1M tokens (OpenRouter-style, 2026-06). */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'google/gemini-3.5-flash': { inputPerM: 1.5, outputPerM: 9.0 },
  'google/gemini-2.5-flash': { inputPerM: 0.15, outputPerM: 0.6 },
  'anthropic/claude-sonnet-4': { inputPerM: 3.0, outputPerM: 15.0 },
  'openai/gpt-4o': { inputPerM: 2.5, outputPerM: 10.0 },
};

/** Default in/out split per agent when no run history exists (brief-based pipeline). */
export const DEFAULT_AGENT_TOKENS: Record<string, { in: number; out: number; ms: number }> = {
  triageBatch:       { in: 3200, out: 900, ms: 8000 },
  triage:            { in: 1800, out: 400, ms: 5000 },
  windowExtractor:   { in: 1400, out: 1900, ms: 9000 },
  clusterer:         { in: 700, out: 550, ms: 6000 },
  clustererBatch:    { in: 2400, out: 1200, ms: 9000 },
  summarizer:        { in: 550, out: 1100, ms: 7000 },
  fileAnalyzer:      { in: 2800, out: 750, ms: 10000 },
  architectureAnalyzer: { in: 4000, out: 1200, ms: 15000 },
  sourceClassifierBatch: { in: 2500, out: 800, ms: 12000 },
  incident:          { in: 2000, out: 900, ms: 15000 },
  domainModeler:     { in: 4500, out: 1200, ms: 18000 },
  technicalProfiler: { in: 2000, out: 800, ms: 12000 },
  industryClassifier:{ in: 3500, out: 600, ms: 12000 },
  industryEnricher:  { in: 3000, out: 1500, ms: 20000 },
  linker:            { in: 5000, out: 1500, ms: 20000 },
  skillSynthesizer:  { in: 2500, out: 900, ms: 12000 },
  profileWriter:     { in: 4000, out: 2000, ms: 25000 },
  domainFuser:       { in: 4500, out: 2200, ms: 12000 },
  industryFuser:     { in: 3800, out: 1800, ms: 12000 },
};

export function agentBackendKind(cfg: SubstrateNetConfig, agentName: string): 'local' | 'frontier' | 'cloud' {
  const spec = cfg.agents[agentName];
  if (!spec?.model) return 'local';
  try {
    const { backend } = parseModelRef(spec.model);
    const b = cfg.agentBackends[backend];
    if (!b) return 'local';
    if (b.kind === 'ollama') return 'local';
    if (b.kind === 'cursor-agent') return 'frontier';
    return 'cloud';
  } catch {
    return 'local';
  }
}

export function loadAgentTokenStats(knowDb: SqliteDb | null): Map<string, { in: number; out: number; ms: number }> {
  const m = new Map<string, { in: number; out: number; ms: number }>();
  if (!knowDb) return m;
  const rows = knowDb.prepare(`
    SELECT agent_name AS name,
           AVG(tokens_in) AS tin, AVG(tokens_out) AS tout, AVG(ms) AS ms
    FROM agent_runs WHERE ok=1 AND tokens_in > 0
    GROUP BY agent_name
  `).all() as Array<{ name: string; tin: number; tout: number; ms: number }>;
  for (const r of rows) {
    if (r.tin > 0 || r.tout > 0) {
      m.set(r.name, { in: Math.round(r.tin), out: Math.round(r.tout), ms: Math.round(r.ms) });
    }
  }
  return m;
}

export function tokensForAgent(
  stats: Map<string, { in: number; out: number; ms: number }>,
  agentName: string,
): { in: number; out: number; ms: number } {
  return stats.get(agentName) ?? DEFAULT_AGENT_TOKENS[agentName] ?? { in: 2000, out: 1500, ms: 12_000 };
}

export function costUsdForAgent(
  cfg: SubstrateNetConfig,
  agentName: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const kind = agentBackendKind(cfg, agentName);
  if (kind === 'local' || kind === 'frontier') return 0;
  const spec = cfg.agents[agentName];
  if (!spec?.model) return 0;
  try {
    const { model } = parseModelRef(spec.model);
    const p = MODEL_PRICING[model] ?? { inputPerM: 1.0, outputPerM: 4.0 };
    return (tokensIn / 1_000_000) * p.inputPerM + (tokensOut / 1_000_000) * p.outputPerM;
  } catch {
    return 0;
  }
}
