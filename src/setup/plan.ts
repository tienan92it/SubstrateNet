import { existsSync, statSync } from 'fs';
import { basename, resolve } from 'path';
import type { Database as SqliteDb } from 'better-sqlite3';
import { loadConfig, parseModelRef, projectConfigDir, type SubstrateNetConfig } from '../config.js';
import { walkFiles } from '../code/walker.js';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';
import { buildSessionAdapters } from '../ingest/orchestrator.js';
import type { SetupPlan, ProjectPlanEstimate } from './types.js';

const ENRICH_AGENT_CALLS = 8;
const FALLBACK_MS_PER_CALL = 12_000;
const FALLBACK_TOKENS_PER_CALL = 4_000;
const EXTRACT_RATIO = 0.65;
const KEEP_RATIO = 0.75;
/** Facts produced per kept window (rough). */
const AVG_FACTS_PER_WINDOW = 2;
/** Fraction of facts attached/created mechanically (no LLM cluster call). */
const MECHANICAL_ATTACH_RATIO = 0.8;
/** Fraction of facts that trigger a (re-)summarize. */
const SUMMARIZE_RATIO = 0.3;
const DEFAULT_BATCH_SIZE = 8;

/** Rough $/1M tokens (input+output blended) for estimates only. */
const MODEL_COST_PER_M: Record<string, number> = {
  'google/gemini-3.5-flash': 0.30,
  'google/gemini-2.5-flash': 0.35,
  'anthropic/claude-sonnet-4': 3.0,
  'openai/gpt-4o': 2.5,
};

export interface PlanOpts {
  prose?: boolean;
  /** Speed/quality profile this plan is for ('full' | 'default' | 'fast'). */
  profile?: string;
}

function backendKind(cfg: SubstrateNetConfig, agentName: string): 'local' | 'frontier' {
  const spec = cfg.agents[agentName];
  if (!spec?.model) return 'local';
  try {
    const { backend } = parseModelRef(spec.model);
    const b = cfg.agentBackends[backend];
    if (!b) return 'local';
    return b.kind === 'ollama' ? 'local' : 'frontier';
  } catch {
    return 'local';
  }
}

function aggregateBackendMode(
  modes: ('local' | 'frontier' | 'mixed')[],
): 'local' | 'frontier' | 'mixed' {
  const expanded: ('local' | 'frontier')[] = modes.flatMap((m) =>
    m === 'mixed' ? ['local', 'frontier'] : [m],
  );
  const hasLocal = expanded.includes('local');
  const hasFrontier = expanded.includes('frontier');
  if (hasLocal && hasFrontier) return 'mixed';
  return hasFrontier ? 'frontier' : 'local';
}

function avgAgentStats(knowDb: SqliteDb | null): { avgMs: number; avgTokens: number } {
  if (!knowDb) return { avgMs: FALLBACK_MS_PER_CALL, avgTokens: FALLBACK_TOKENS_PER_CALL };
  const row = knowDb.prepare(`
    SELECT AVG(ms) AS ms, AVG(tokens_in + tokens_out) AS tok
    FROM agent_runs WHERE ok=1 AND ms > 0
  `).get() as { ms: number | null; tok: number | null } | undefined;
  return {
    avgMs: row?.ms && row.ms > 0 ? row.ms : FALLBACK_MS_PER_CALL,
    avgTokens: row?.tok && row.tok > 0 ? row.tok : FALLBACK_TOKENS_PER_CALL,
  };
}

async function countTranscriptWork(root: string, cfg: SubstrateNetConfig): Promise<{
  sessions: number;
  unreadBytes: number;
  estNewTurns: number;
}> {
  const abs = resolve(root);
  if (existsSync(projectConfigDir(abs))) {
    const knowDb = openKnowledgeDb(abs);
    try {
      const sessions = (knowDb.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
      const turns = (knowDb.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number }).n;
      return {
        sessions,
        unreadBytes: 0,
        estNewTurns: Math.max(0, Math.ceil(turns / 12)),
      };
    } finally {
      knowDb.close();
    }
  }

  let sessions = 0;
  let unreadBytes = 0;
  // Codex discover walks all sessions globally — too slow for per-project planning.
  const adapters = buildSessionAdapters(cfg).filter((a) => a.agent !== 'codex');
  for (const adapter of adapters) {
    for await (const ref of adapter.discover(abs)) {
      sessions++;
      try {
        unreadBytes += statSync(ref.sourcePath).size;
      } catch { /* ignore */ }
    }
  }
  const estNewTurns = Math.max(0, Math.ceil(unreadBytes / 2500));
  return { sessions, unreadBytes, estNewTurns };
}

function countPendingFiles(codeDb: SqliteDb | null, root: string, initialized: boolean): { files: number; pending: number } {
  if (!initialized || !codeDb) {
    const files = walkFiles(root).length;
    return { files, pending: files };
  }
  const files = (codeDb.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
  const pending = (codeDb.prepare(`
    SELECT COUNT(*) AS n FROM files f
    LEFT JOIN file_analysis a ON a.path = f.path AND a.content_hash = f.content_hash
    WHERE a.path IS NULL
  `).get() as { n: number }).n;
  return { files, pending };
}

function estimateCostUsd(cfg: SubstrateNetConfig, tokens: number): number | undefined {
  const model = cfg.agents.triage?.model ?? cfg.agents.fileAnalyzer?.model;
  if (!model) return undefined;
  try {
    const { model: m } = parseModelRef(model);
    const rate = MODEL_COST_PER_M[m] ?? 1.0;
    return (tokens / 1_000_000) * rate;
  } catch {
    return undefined;
  }
}

async function planProject(root: string, cfg: SubstrateNetConfig, opts: PlanOpts): Promise<ProjectPlanEstimate> {
  const abs = resolve(root);
  const initialized = existsSync(projectConfigDir(abs));
  let codeDb: SqliteDb | null = null;
  let knowDb: SqliteDb | null = null;
  if (initialized) {
    codeDb = openCodeDb(abs);
    knowDb = openKnowledgeDb(abs);
  }

  try {
    const { files, pending } = countPendingFiles(codeDb, abs, initialized);
    const transcript = await countTranscriptWork(abs, loadConfig(abs));
    const estWindows = Math.max(
      initialized && knowDb
        ? (knowDb.prepare(`SELECT COUNT(*) AS n FROM turn_windows`).get() as { n: number }).n
        : 0,
      Math.ceil(transcript.estNewTurns / 10),
    );
    const newWindows = Math.ceil(transcript.estNewTurns / 10);
    const batchSize = Math.max(1, cfg.batchSize ?? DEFAULT_BATCH_SIZE);
    const keptWindows = Math.ceil(newWindows * KEEP_RATIO);
    const unified = Boolean(cfg.agents.windowExtractor);

    // Triage is batched; embeddings are batched.
    const triageCalls = Math.ceil(newWindows / batchSize);
    // Unified extractor: one call per kept window. Legacy: ~1.5 agents/window.
    const extractCalls = unified
      ? keptWindows
      : Math.ceil(keptWindows * EXTRACT_RATIO * 1.5);
    const factsEst = extractCalls * AVG_FACTS_PER_WINDOW;
    const clusterCalls = Math.ceil(factsEst * (1 - MECHANICAL_ATTACH_RATIO));
    const summarizeCalls = Math.ceil(factsEst * SUMMARIZE_RATIO);
    const embedCalls = Math.ceil(keptWindows / batchSize) + Math.ceil(factsEst / batchSize);
    const analyzeCalls = pending + (pending > 0 ? 1 : 0);
    const enrichCalls = ENRICH_AGENT_CALLS;
    let llmCalls = triageCalls + extractCalls + clusterCalls + summarizeCalls + embedCalls + analyzeCalls + enrichCalls;

    const hist = avgAgentStats(knowDb);
    const modes = [
      backendKind(cfg, 'triage'),
      backendKind(cfg, 'fileAnalyzer'),
      backendKind(cfg, 'technicalProfiler'),
    ];
    const backendMode = aggregateBackendMode(modes);

    let cacheHitPct = 0;
    if (knowDb && initialized) {
      const runs = (knowDb.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE ok=1`).get() as { n: number }).n;
      if (runs > 0 && llmCalls > 0) cacheHitPct = Math.min(40, Math.round((runs / (runs + llmCalls)) * 100));
    }
    const missCalls = Math.round(llmCalls * (1 - cacheHitPct / 100));
    const estTokens = backendMode === 'local' ? 0 : missCalls * hist.avgTokens;
    const concurrency = cfg.concurrency ?? 4;
    const estWallMs = Math.round((missCalls * hist.avgMs) / concurrency);

    if (opts.prose) llmCalls += 1;

    return {
      path: abs,
      name: basename(abs),
      files,
      pendingFiles: pending,
      sessions: transcript.sessions,
      newTurnsEst: transcript.estNewTurns,
      estWindows: newWindows,
      llmCalls,
      cacheHitPct,
      estTokens,
      estWallMs,
      backendMode,
    };
  } finally {
    codeDb?.close();
    knowDb?.close();
  }
}

export async function buildSetupPlan(
  projectPaths: string[],
  opts: PlanOpts = {},
): Promise<SetupPlan> {
  const cfg = loadConfig();
  const projects: ProjectPlanEstimate[] = [];
  for (const p of projectPaths) {
    if (!p || !existsSync(resolve(p))) continue;
    projects.push(await planProject(resolve(p), loadConfig(p), opts));
  }

  const totals = projects.reduce(
    (acc, p) => {
      acc.files += p.files;
      acc.pendingFiles += p.pendingFiles;
      acc.sessions += p.sessions;
      acc.estWindows += p.estWindows;
      acc.llmCalls += p.llmCalls;
      acc.estTokens += p.estTokens;
      acc.estWallMs += p.estWallMs;
      return acc;
    },
    {
      files: 0,
      pendingFiles: 0,
      sessions: 0,
      estWindows: 0,
      llmCalls: 0,
      cacheHitPct: 0,
      estTokens: 0,
      estWallMs: 0,
    },
  );

  if (projects.length > 0) {
    totals.cacheHitPct = Math.round(
      projects.reduce((s, p) => s + p.cacheHitPct, 0) / projects.length,
    );
  }
  totals.llmCalls += 2; // link + skillSynthesizer (global)
  totals.estWallMs += FALLBACK_MS_PER_CALL * 2;

  const backendMode = aggregateBackendMode(projects.map((p) => p.backendMode));
  const estCostUsd = backendMode !== 'local' ? estimateCostUsd(cfg, totals.estTokens) : undefined;

  return {
    projects,
    totals: { ...totals, estCostUsd },
    backendMode,
    concurrency: cfg.concurrency ?? 4,
    profile: opts.profile ?? 'full',
  };
}
