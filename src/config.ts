import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export type BackendKind = 'ollama' | 'openai-compatible' | 'anthropic';

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
  fallback?: string;
  windowTokens?: number;
}

export interface ResearchConfig {
  /** 'none' (offline default) or 'search-api'. */
  kind?: 'none' | 'search-api';
  endpoint?: string;
  apiKeyEnv?: string;
}

export interface SubstrateNetConfig {
  agentBackends: Record<string, AgentBackend>;
  agents: Record<string, AgentSpec>;
  /** Max concurrent agent (LLM) calls in the pipeline. 1 = serial. Default 4. */
  concurrency?: number;
  /** Opt-in external research backend for industry enrichment. Off by default. */
  research?: ResearchConfig;
  /** Paths for cross-agent transcript discovery; resolved with ~ expansion. */
  transcriptRoots?: {
    cursor?: string;
    claudeCode?: string;
    codex?: string;
    copilot?: string;
  };
}

export const DEFAULT_CONFIG: SubstrateNetConfig = {
  agentBackends: {
    default: { kind: 'ollama', endpoint: 'http://localhost:11434' },
  },
  agents: {
    triage:         { model: 'default:llama3.1:8b', windowTokens: 2000 },
    dedupe:         { model: 'default:nomic-embed-text' },
    decision:       { model: 'default:llama3.1:8b' },
    businessLogic:  { model: 'default:llama3.1:8b' },
    requirements:   { model: 'default:llama3.1:8b' },
    intent:         { model: 'default:llama3.1:8b' },
    problemSolution:{ model: 'default:llama3.1:8b' },
    clusterer:      { model: 'default:llama3.1:8b' },
    summarizer:     { model: 'default:llama3.1:8b' },
    linker:         { model: 'default:llama3.1:8b' },
    verifier:       { model: 'default:llama3.1:8b' },
    domainModeler:  { model: 'default:llama3.1:8b' },
    architectureModeler: { model: 'default:llama3.1:8b' },
    businessDomainModeler: { model: 'default:llama3.1:8b' },
    techDomainModeler: { model: 'default:llama3.1:8b' },
    technicalProfiler: { model: 'default:llama3.1:8b' },
    industryClassifier:{ model: 'default:llama3.1:8b' },
    industryEnricher:  { model: 'default:llama3.1:8b' },
    skillSynthesizer:  { model: 'default:llama3.1:8b' },
    fileAnalyzer:      { model: 'default:llama3.1:8b' },
    architectureAnalyzer: { model: 'default:llama3.1:8b' },
    domainAnalyzer:    { model: 'default:llama3.1:8b' },
    profileWriter:     { model: 'default:llama3.1:8b' },
  },
  concurrency: 4,
  research: { kind: 'none' },
  transcriptRoots: {
    cursor: '~/.cursor/projects',
    claudeCode: '~/.claude/projects',
    codex: '~/.codex/sessions',
  },
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

/** Parse "<backend>:<model>" into {backend, model}. */
export function parseModelRef(ref: string): { backend: string; model: string } {
  const idx = ref.indexOf(':');
  if (idx < 0) throw new Error(`Invalid model ref: ${ref} (expected "<backend>:<model>")`);
  return { backend: ref.slice(0, idx), model: ref.slice(idx + 1) };
}
