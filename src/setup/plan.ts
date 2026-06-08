import { existsSync, statSync } from 'fs';
import { basename, resolve } from 'path';
import type { Database as SqliteDb } from 'better-sqlite3';
import { loadConfig, projectConfigDir, resolveAnalyzeConfig, resolveIngestConfig, type SubstrateNetConfig } from '../config.js';
import { walkFiles } from '../code/walker.js';
import { filterPathsForAnalyze } from '../code/file-tiers.js';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';
import { buildSessionAdapters } from '../ingest/orchestrator.js';
import { shouldIngestSession } from '../pipeline/session-filter.js';
import {
  agentBackendKind,
  costUsdForAgent,
  loadAgentTokenStats,
  tokensForAgent,
} from './plan-cost.js';
import type { PlanPhaseEstimate, PlanProfile, ProjectPlanEstimate, SetupPlan } from './types.js';

const ENRICH_DEEP_CALLS = 8;
const ENRICH_FUSED_CALLS = 2;
const GLOBAL_AGENT_CALLS = 2;
const DEFAULT_BATCH_SIZE = 8;
/** Fraction of windows dropped by pre-triage embed dedupe (empirical). */
const PRE_DEDUPE_DROP_RATIO = 0.12;
const KEEP_RATIO = 0.75;
const AVG_FACTS_PER_WINDOW = 1.5;
const MECHANICAL_ATTACH_RATIO = 0.85;
const SUMMARIZE_RATIO = 0.3;
const PRE_LLM_MS_PER_WINDOW = 120;

export interface PlanOpts {
  prose?: boolean;
  /** Speed/quality profile: fast|lean, default|standard, full|deep. */
  profile?: string;
}

function resolvePlanProfile(raw?: string): PlanProfile {
  const p = (raw ?? 'standard').toLowerCase();
  if (p === 'fast' || p === 'lean') return 'lean';
  if (p === 'full' || p === 'deep') return 'deep';
  return 'standard';
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

function backendModeFromCfg(cfg: SubstrateNetConfig): 'local' | 'frontier' | 'mixed' {
  const kinds = new Set(
    ['triage', 'windowExtractor', 'fileAnalyzer', 'technicalProfiler']
      .map((a) => agentBackendKind(cfg, a)),
  );
  const hasCloud = kinds.has('cloud');
  const hasFrontier = kinds.has('frontier');
  const hasLocal = kinds.has('local') || (!hasCloud && !hasFrontier);
  if ((hasCloud || hasLocal) && hasFrontier) return 'mixed';
  if (hasFrontier && !hasCloud) return 'frontier';
  if (hasCloud) return 'mixed';
  return 'local';
}

async function countTranscriptWork(root: string, cfg: SubstrateNetConfig): Promise<{
  sessions: number;
  unreadBytes: number;
  estNewTurns: number;
}> {
  const abs = resolve(root);
  const ingest = resolveIngestConfig(cfg);

  if (existsSync(projectConfigDir(abs))) {
    const knowDb = openKnowledgeDb(abs);
    try {
      const sessions = (knowDb.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
      const turns = (knowDb.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number }).n;
      return {
        sessions,
        unreadBytes: 0,
        estNewTurns: Math.max(0, turns),
      };
    } finally {
      knowDb.close();
    }
  }

  let sessions = 0;
  let unreadBytes = 0;
  const filterState = { accepted: 0 };
  const adapters = buildSessionAdapters(cfg).filter((a) => a.agent !== 'codex');
  for (const adapter of adapters) {
    for await (const ref of adapter.discover(abs)) {
      if (!shouldIngestSession(ref, ingest, filterState)) continue;
      sessions++;
      try {
        unreadBytes += statSync(ref.sourcePath).size;
      } catch { /* ignore */ }
    }
  }
  const estNewTurns = Math.max(0, Math.ceil(unreadBytes / 2500));
  return { sessions, unreadBytes, estNewTurns };
}

function countWindows(
  knowDb: SqliteDb | null,
  transcript: { estNewTurns: number },
  profile: PlanProfile,
): { raw: number; kept: number } {
  if (knowDb) {
    const total = (knowDb.prepare(`SELECT COUNT(*) AS n FROM turn_windows`).get() as { n: number }).n;
    if (total > 0) {
      const untriaged = (knowDb.prepare(`
        SELECT COUNT(*) AS n FROM turn_windows w
        LEFT JOIN triage_labels t ON t.window_id = w.id
        WHERE t.window_id IS NULL
      `).get() as { n: number }).n;
      const raw = profile === 'deep' ? total : (untriaged > 0 ? untriaged : total);
      const kept = Math.ceil(raw * (1 - PRE_DEDUPE_DROP_RATIO));
      return { raw, kept };
    }
  }
  const raw = Math.max(1, Math.ceil(transcript.estNewTurns / 10));
  const kept = Math.ceil(raw * (1 - PRE_DEDUPE_DROP_RATIO));
  return { raw, kept };
}

function listPendingPaths(codeDb: SqliteDb | null, root: string, initialized: boolean): string[] {
  if (!initialized || !codeDb) return walkFiles(root);
  return (codeDb.prepare(`
    SELECT f.path FROM files f
    LEFT JOIN file_analysis a ON a.path = f.path AND a.content_hash = f.content_hash
    WHERE a.path IS NULL
    ORDER BY f.path
  `).all() as Array<{ path: string }>).map((r) => r.path);
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

interface PhaseBuildCtx {
  cfg: SubstrateNetConfig;
  stats: ReturnType<typeof loadAgentTokenStats>;
  concurrency: number;
  cacheHitPct: number;
  profile: PlanProfile;
  keptWindows: number;
  pendingPaths: string[];
  codeDb: SqliteDb | null;
  prose: boolean;
}

function missFactor(cacheHitPct: number): number {
  return 1 - cacheHitPct / 100;
}

function buildPhase(
  phase: string,
  calls: number,
  agentName: string,
  ctx: PhaseBuildCtx,
  note?: string,
): PlanPhaseEstimate {
  const miss = missFactor(ctx.cacheHitPct);
  const tok = tokensForAgent(ctx.stats, agentName);
  const effectiveCalls = Math.round(calls * miss);
  const tokensIn = effectiveCalls * tok.in;
  const tokensOut = effectiveCalls * tok.out;
  const estWallMs = Math.round((effectiveCalls * tok.ms) / ctx.concurrency);
  const estCostUsd = costUsdForAgent(ctx.cfg, agentName, tokensIn, tokensOut);
  const kind = agentBackendKind(ctx.cfg, agentName);
  const phaseNote = note ?? (kind === 'frontier' ? 'frontier (subscription)' : undefined);
  return { phase, calls, tokensIn, tokensOut, estCostUsd, estWallMs, note: phaseNote };
}

function buildProjectPhases(ctx: PhaseBuildCtx): PlanPhaseEstimate[] {
  const batchSize = Math.max(1, ctx.cfg.batchSize ?? DEFAULT_BATCH_SIZE);
  const ingest = resolveIngestConfig(ctx.cfg);
  const maxFacts = ingest.maxFactsPerWindow ?? 8;
  const unified = Boolean(ctx.cfg.agents.windowExtractor);
  const triageAgent = ctx.cfg.agents.triageBatch ? 'triageBatch' : 'triage';

  const triageCalls = Math.ceil(ctx.keptWindows / batchSize);
  const keptAfterTriage = Math.ceil(ctx.keptWindows * KEEP_RATIO);
  const extractCalls = unified ? keptAfterTriage : Math.ceil(keptAfterTriage * 0.65 * 1.5);
  const factsEst = Math.min(
    Math.round(keptAfterTriage * maxFacts * 0.6),
    Math.round(extractCalls * AVG_FACTS_PER_WINDOW),
  );
  const ambiguousFacts = Math.ceil(factsEst * (1 - MECHANICAL_ATTACH_RATIO));
  const clusterBatch = resolveIngestConfig(ctx.cfg).clusterBatch !== false;
  const clusterCalls = clusterBatch
    ? Math.ceil(ambiguousFacts / batchSize)
    : ambiguousFacts;
  const summarizeCalls = Math.ceil(factsEst * SUMMARIZE_RATIO);

  let analyzeCalls = 0;
  let analyzeNote = 'skipped (lean)';
  if (ctx.profile !== 'lean') {
    const tierProfile = ctx.profile === 'deep' ? 'deep' : 'standard';
    const paths = ctx.pendingPaths;
    if (ctx.codeDb && paths.length > 0) {
      const { analyze, skipped } = filterPathsForAnalyze(paths, ctx.codeDb, ctx.cfg, tierProfile);
      analyzeCalls = analyze.length;
      analyzeNote = tierProfile === 'deep'
        ? `deep · ${skipped} skipped by cap`
        : `tier-1 · ${skipped} deferred`;
    } else {
      analyzeCalls = Math.min(paths.length, resolveAnalyzeConfig(ctx.cfg).maxFilesPerRun ?? 500);
      analyzeNote = ctx.profile === 'deep' ? 'deep (no code db)' : 'tier-1 heuristic';
    }
    if (analyzeCalls > 0) analyzeCalls += 1; // architectureAnalyzer once
  }

  const enrichCalls = ctx.profile === 'lean'
    ? 0
    : ctx.profile === 'deep'
      ? ENRICH_DEEP_CALLS
      : ENRICH_FUSED_CALLS;
  const sourceClassCalls = ctx.profile === 'lean' ? 0 : Math.ceil(keptAfterTriage / 20);

  const phases: PlanPhaseEstimate[] = [
    {
      phase: 'pre-llm',
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      estCostUsd: 0,
      estWallMs: Math.round((ctx.keptWindows * PRE_LLM_MS_PER_WINDOW) / ctx.concurrency),
      note: 'mechanical',
    },
    buildPhase('triage', triageCalls, triageAgent, ctx),
    buildPhase('extract', extractCalls, 'windowExtractor', ctx),
    buildPhase(
      'cluster',
      clusterCalls,
      clusterBatch ? 'clustererBatch' : 'clusterer',
      ctx,
      clusterBatch ? `batched · ${batchSize}/call` : undefined,
    ),
    buildPhase('summarize', summarizeCalls, 'summarizer', ctx),
  ];

  if (sourceClassCalls > 0) {
    phases.push(buildPhase('source-classify', sourceClassCalls, 'sourceClassifierBatch', ctx, 'frontier'));
  }

  phases.push(buildPhase('analyze', analyzeCalls, 'fileAnalyzer', ctx, analyzeNote));

  if (enrichCalls > 0) {
    if (ctx.profile === 'standard') {
      const domain = buildPhase('enrich-fused', 1, 'domainFuser', ctx, 'fused');
      const industry = buildPhase('enrich-fused', 1, 'industryFuser', ctx, 'fused');
      phases.push({
        phase: 'enrich-fused',
        calls: ENRICH_FUSED_CALLS,
        tokensIn: domain.tokensIn + industry.tokensIn,
        tokensOut: domain.tokensOut + industry.tokensOut,
        estCostUsd: domain.estCostUsd + industry.estCostUsd,
        estWallMs: domain.estWallMs + industry.estWallMs,
        note: 'domainFuser + industryFuser',
      });
    } else {
      phases.push(buildPhase('enrich', enrichCalls, 'technicalProfiler', ctx, '8 agents · frontier'));
    }
  }

  if (ctx.prose) {
    phases.push(buildPhase('prose', 1, 'profileWriter', ctx, 'frontier'));
  }

  return phases;
}

function sumPhases(phases: PlanPhaseEstimate[]): Omit<PlanPhaseEstimate, 'phase' | 'note'> & { llmCalls: number } {
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let estCostUsd = 0;
  let estWallMs = 0;
  for (const ph of phases) {
    if (ph.phase !== 'pre-llm') calls += ph.calls;
    tokensIn += ph.tokensIn;
    tokensOut += ph.tokensOut;
    estCostUsd += ph.estCostUsd;
    estWallMs += ph.estWallMs;
  }
  return { calls, tokensIn, tokensOut, estCostUsd, estWallMs, llmCalls: calls };
}

function mergePhases(all: PlanPhaseEstimate[]): PlanPhaseEstimate[] {
  const m = new Map<string, PlanPhaseEstimate>();
  for (const ph of all) {
    const prev = m.get(ph.phase);
    if (!prev) {
      m.set(ph.phase, { ...ph });
      continue;
    }
    prev.calls += ph.calls;
    prev.tokensIn += ph.tokensIn;
    prev.tokensOut += ph.tokensOut;
    prev.estCostUsd += ph.estCostUsd;
    prev.estWallMs += ph.estWallMs;
  }
  const order = ['pre-llm', 'triage', 'extract', 'cluster', 'summarize', 'source-classify', 'analyze', 'enrich-fused', 'enrich', 'prose', 'global'];
  return order.filter((k) => m.has(k)).map((k) => m.get(k)!);
}

async function planProject(root: string, cfg: SubstrateNetConfig, opts: PlanOpts): Promise<ProjectPlanEstimate> {
  const abs = resolve(root);
  const profile = resolvePlanProfile(opts.profile);
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
    const { raw: estWindows, kept: estWindowsKept } = countWindows(knowDb, transcript, profile);
    const pendingPaths = listPendingPaths(codeDb, abs, initialized);
    const stats = loadAgentTokenStats(knowDb);
    const concurrency = cfg.concurrency ?? 4;

    let cacheHitPct = 0;
    if (knowDb && initialized) {
      const runs = (knowDb.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE ok=1`).get() as { n: number }).n;
      const estCalls = Math.ceil(estWindowsKept / (cfg.batchSize ?? DEFAULT_BATCH_SIZE)) + estWindowsKept;
      if (runs > 0 && estCalls > 0) {
        cacheHitPct = Math.min(40, Math.round((runs / (runs + estCalls)) * 100));
      }
    }

    const phaseCtx: PhaseBuildCtx = {
      cfg,
      stats,
      concurrency,
      cacheHitPct,
      profile,
      keptWindows: estWindowsKept,
      pendingPaths,
      codeDb,
      prose: Boolean(opts.prose),
    };
    const phases = buildProjectPhases(phaseCtx);
    const rolled = sumPhases(phases);

    return {
      path: abs,
      name: basename(abs),
      files,
      pendingFiles: pending,
      sessions: transcript.sessions,
      newTurnsEst: transcript.estNewTurns,
      estWindows,
      estWindowsKept,
      llmCalls: rolled.llmCalls,
      cacheHitPct,
      estTokens: rolled.tokensIn + rolled.tokensOut,
      estTokensIn: rolled.tokensIn,
      estTokensOut: rolled.tokensOut,
      estWallMs: rolled.estWallMs,
      estCostUsd: rolled.estCostUsd,
      backendMode: backendModeFromCfg(cfg),
      phases,
    };
  } finally {
    codeDb?.close();
    knowDb?.close();
  }
}

function buildGlobalPhases(cfg: SubstrateNetConfig, cacheHitPct: number, concurrency: number): PlanPhaseEstimate[] {
  const stats = new Map<string, { in: number; out: number; ms: number }>();
  const ctx: PhaseBuildCtx = {
    cfg,
    stats,
    concurrency,
    cacheHitPct,
    profile: 'standard',
    keptWindows: 0,
    pendingPaths: [],
    codeDb: null,
    prose: false,
  };
  const linker = buildPhase('global', 1, 'linker', ctx, 'cross-project');
  const skill = buildPhase('global', 1, 'skillSynthesizer', ctx, 'cross-project');
  return [
    {
      phase: 'global',
      calls: GLOBAL_AGENT_CALLS,
      tokensIn: linker.tokensIn + skill.tokensIn,
      tokensOut: linker.tokensOut + skill.tokensOut,
      estCostUsd: linker.estCostUsd + skill.estCostUsd,
      estWallMs: linker.estWallMs + skill.estWallMs,
      note: 'link + skill',
    },
  ];
}

export async function buildSetupPlan(
  projectPaths: string[],
  opts: PlanOpts = {},
): Promise<SetupPlan> {
  const cfg = loadConfig();
  const profile = resolvePlanProfile(opts.profile);
  const projects: ProjectPlanEstimate[] = [];
  for (const p of projectPaths) {
    if (!p || !existsSync(resolve(p))) continue;
    projects.push(await planProject(resolve(p), loadConfig(p), { ...opts, profile }));
  }

  const totals = projects.reduce(
    (acc, p) => {
      acc.files += p.files;
      acc.pendingFiles += p.pendingFiles;
      acc.sessions += p.sessions;
      acc.estWindows += p.estWindows;
      acc.estWindowsKept += p.estWindowsKept;
      acc.llmCalls += p.llmCalls;
      acc.estTokens += p.estTokens;
      acc.estTokensIn += p.estTokensIn;
      acc.estTokensOut += p.estTokensOut;
      acc.estWallMs += p.estWallMs;
      acc.estCostUsd += p.estCostUsd;
      return acc;
    },
    {
      files: 0,
      pendingFiles: 0,
      sessions: 0,
      estWindows: 0,
      estWindowsKept: 0,
      llmCalls: 0,
      cacheHitPct: 0,
      estTokens: 0,
      estTokensIn: 0,
      estTokensOut: 0,
      estWallMs: 0,
      estCostUsd: 0,
    },
  );

  if (projects.length > 0) {
    totals.cacheHitPct = Math.round(
      projects.reduce((s, p) => s + p.cacheHitPct, 0) / projects.length,
    );
  }

  const globalPhases = buildGlobalPhases(cfg, totals.cacheHitPct, cfg.concurrency ?? 4);
  const global = globalPhases[0]!;
  totals.llmCalls += global.calls;
  totals.estTokens += global.tokensIn + global.tokensOut;
  totals.estTokensIn += global.tokensIn;
  totals.estTokensOut += global.tokensOut;
  totals.estWallMs += global.estWallMs;
  totals.estCostUsd += global.estCostUsd;

  const phases = mergePhases([...projects.flatMap((p) => p.phases), ...globalPhases]);
  const backendMode = aggregateBackendMode(projects.map((p) => p.backendMode));

  return {
    projects,
    phases,
    totals,
    backendMode,
    concurrency: cfg.concurrency ?? 4,
    profile,
  };
}
