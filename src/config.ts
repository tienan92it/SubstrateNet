import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';

export type BackendKind = 'ollama' | 'openai-compatible' | 'anthropic' | 'cursor-agent';

export interface AgentBackend {
  kind: BackendKind;
  endpoint?: string;
  /** Name of the env var holding the API key (preferred — keeps secrets out of the file). */
  apiKeyEnv?: string;
  /** Inline API key. Convenient, but stored in plaintext — prefer apiKeyEnv. */
  apiKey?: string;
}

/**
 * Resolve an API key from a backend spec. Inline `apiKey` wins; otherwise read
 * the env var named by `apiKeyEnv`. Guards against the common mistake of pasting
 * a raw key (sk-...) into `apiKeyEnv` by treating key-shaped values as inline.
 */
export function resolveApiKey(spec: { apiKey?: string; apiKeyEnv?: string }): string | undefined {
  if (spec.apiKey) return spec.apiKey;
  const ref = spec.apiKeyEnv;
  if (!ref) return undefined;
  if (/^sk-|^or-|\s/.test(ref) || ref.length > 60) return ref; // looks like a key, not a var name
  return process.env[ref];
}

export interface AgentSpec {
  /** model ref of the form "<backend>:<model>" e.g. "default:llama3.1:8b" */
  model: string;
  /** Ordered fallback model ref(s). Tried in order when earlier tiers are unusable. */
  fallback?: string | string[];
  windowTokens?: number;
}

export interface ResearchConfig {
  /** 'none' (offline default) or 'search-api'. */
  kind?: 'none' | 'search-api';
  endpoint?: string;
  apiKeyEnv?: string;
}

/** Transcript ingest hygiene and cost controls (RFC workflow-refactor). */
export interface IngestConfig {
  maxSessions?: number;
  sinceDays?: number;
  minSessionBytes?: number;
  skipAgents?: string[];
  maxBriefChars?: number;
  maxFactsPerWindow?: number;
  windowDupThreshold?: number;
  minExtractConfidence?: number;
  /** Embed-dedupe windows before triage LLM (default true). */
  preTriageDedupe?: boolean;
  maxTurnChars?: number;
  /** Batch ambiguous cluster decisions (default true). */
  clusterBatch?: boolean;
}

/** File analyze scope (RFC workflow-refactor). */
export type AnalyzeTierProfile = 'lean' | 'standard' | 'deep';

export interface AnalyzeConfig {
  tier?: AnalyzeTierProfile;
  skipGlobs?: string[];
  maxFilesPerRun?: number;
}

export interface SubstrateNetConfig {
  agentBackends: Record<string, AgentBackend>;
  agents: Record<string, AgentSpec>;
  /** Max concurrent agent (LLM) calls in the pipeline. 1 = serial. Default 4. */
  concurrency?: number;
  /** Windows/items per batched agent call (triage, source classifier). Default 8. */
  batchSize?: number;
  /** Opt-in external research backend for industry enrichment. Off by default. */
  research?: ResearchConfig;
  /** Paths for cross-agent transcript discovery; resolved with ~ expansion. */
  transcriptRoots?: {
    cursor?: string;
    claudeCode?: string;
    codex?: string;
    copilot?: string;
  };
  /**
   * Explicit workspace/umbrella name for this project (e.g. "Kafi"). Overrides
   * auto-detection (git org / parent dir) when grouping projects globally.
   */
  workspace?: string;
  ingest?: IngestConfig;
  analyze?: AnalyzeConfig;
}

export const DEFAULT_INGEST_CONFIG: Required<IngestConfig> = {
  maxSessions: 200,
  sinceDays: 365,
  minSessionBytes: 256,
  skipAgents: [],
  maxBriefChars: 2000,
  maxFactsPerWindow: 8,
  windowDupThreshold: 0.92,
  minExtractConfidence: 0.45,
  preTriageDedupe: true,
  maxTurnChars: 12_000,
  clusterBatch: true,
};

export const DEFAULT_ANALYZE_CONFIG: Required<AnalyzeConfig> = {
  tier: 'standard',
  skipGlobs: [],
  maxFilesPerRun: 500,
};

export function resolveIngestConfig(cfg: SubstrateNetConfig): Required<IngestConfig> {
  return { ...DEFAULT_INGEST_CONFIG, ...cfg.ingest };
}

export function resolveAnalyzeConfig(cfg: SubstrateNetConfig): Required<AnalyzeConfig> {
  return { ...DEFAULT_ANALYZE_CONFIG, ...cfg.analyze };
}

export const DEFAULT_CONFIG: SubstrateNetConfig = {
  agentBackends: {
    // Local Ollama — always usable, no key. The safe fallback for every agent.
    default: { kind: 'ollama', endpoint: 'http://localhost:11434' },
    // Flash-first bulk backend. Used when OPENROUTER_API_KEY is set; otherwise
    // agents transparently fall through to `default` (local) at runtime.
    openrouter: {
      kind: 'openai-compatible',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
    // Higher-tier reasoning via the user's Cursor subscription (@cursor/sdk).
    // Heavy agents route here and fall back to flash/local when CURSOR_API_KEY
    // is unset or the SDK is unavailable.
    frontier: { kind: 'cursor-agent', apiKeyEnv: 'CURSOR_API_KEY' },
  },
  agents: {
    // Embeddings stay local (cheap, private, no key).
    dedupe:         { model: 'default:nomic-embed-text' },
    // Bulk / high-volume — flash-first, fall back to local Ollama.
    triage:         { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b', windowTokens: 2000 },
    windowExtractor:{ model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    decision:       { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    businessLogic:  { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    requirements:   { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    intent:         { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    problemSolution:{ model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    clusterer:      { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    summarizer:     { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    verifier:       { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    skillSynthesizer:  { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    fileAnalyzer:      { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    architectureAnalyzer: { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    // Heavy reasoning — prefer frontier (Cursor), fall back to flash then local.
    sourceClassifier:  { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    incident:          { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    linker:            { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    domainModeler:     { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    architectureModeler: { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    businessDomainModeler: { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    techDomainModeler: { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    technicalProfiler: { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    industryClassifier:{ model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    industryEnricher:  { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    domainAnalyzer:    { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
    // Fused enrich (standard profile) — flash-first bulk.
    domainFuser:       { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    industryFuser:     { model: 'openrouter:google/gemini-3.5-flash', fallback: 'default:llama3.1:8b' },
    profileWriter:     { model: 'frontier:composer-2.5', fallback: ['openrouter:google/gemini-3.5-flash', 'default:llama3.1:8b'] },
  },
  concurrency: 4,
  batchSize: 8,
  research: { kind: 'none' },
  transcriptRoots: {
    cursor: '~/.cursor/projects',
    claudeCode: '~/.claude/projects',
    codex: '~/.codex/sessions',
  },
  ingest: { ...DEFAULT_INGEST_CONFIG },
  analyze: { ...DEFAULT_ANALYZE_CONFIG },
};

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

export function globalConfigDir(): string {
  return join(homedir(), '.substrate-net');
}

export function globalConfigPath(): string {
  return join(globalConfigDir(), 'config.json');
}

export function projectConfigDir(projectRoot: string): string {
  return join(resolve(projectRoot), '.substrate-net');
}

export function projectConfigPath(projectRoot: string): string {
  return join(projectConfigDir(projectRoot), 'config.json');
}

/**
 * Load merged config (global + per-project override). Returns DEFAULT_CONFIG
 * if neither file exists. Per-project keys deep-merge over global keys.
 */
export function loadConfig(projectRoot?: string): SubstrateNetConfig {
  const merged: SubstrateNetConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const gp = globalConfigPath();
  if (existsSync(gp)) deepMerge(merged, readJson(gp));
  if (projectRoot) {
    const pp = projectConfigPath(projectRoot);
    if (existsSync(pp)) deepMerge(merged, readJson(pp));
  }
  return merged;
}

export function ensureGlobalConfig(): string {
  const dir = globalConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = globalConfigPath();
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2));
  return p;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function deepMerge(target: any, source: any): void {
  if (!source || typeof source !== 'object') return;
  for (const k of Object.keys(source)) {
    const sv = source[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], sv);
    } else {
      target[k] = sv;
    }
  }
}

/**
 * Fingerprint the agent model routing (primary + fallbacks). When this changes,
 * cached agent_runs are stale — doctor warns and `update --full` is advised.
 */
export function configModelFingerprint(cfg: SubstrateNetConfig): string {
  const entries = Object.entries(cfg.agents ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, spec]) => {
      const fb = spec.fallback === undefined ? '' : Array.isArray(spec.fallback) ? spec.fallback.join(',') : spec.fallback;
      return `${name}=${spec.model}|${fb}`;
    });
  return createHash('sha1').update(entries.join(';')).digest('hex').slice(0, 16);
}

/** Parse "<backend>:<model>" into {backend, model}. */
export function parseModelRef(ref: string): { backend: string; model: string } {
  const idx = ref.indexOf(':');
  if (idx < 0) throw new Error(`Invalid model ref: ${ref} (expected "<backend>:<model>")`);
  return { backend: ref.slice(0, idx), model: ref.slice(idx + 1) };
}
