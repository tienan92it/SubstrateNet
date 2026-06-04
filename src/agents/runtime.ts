/**
 * AgentRuntime — single entry point for every NL decision.
 *
 * Responsibilities:
 *  - Resolve agent.model to a concrete backend via config.
 *  - Hash (agent.name, model, prompt_version, input) → cache lookup in agent_runs.
 *  - Call the backend; validate output against schema; retry-on-repair once.
 *  - Persist every run (success or failure) for audit.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import { createHash, randomUUID } from 'crypto';
import type { Database as SqliteDb } from 'better-sqlite3';
import type { SubstrateNetConfig } from '../config.js';
import { parseModelRef } from '../config.js';
import { type AgentBackend as BackendSpec, resolveApiKey } from '../config.js';
import type { Backend, ChatMessage } from './backends/base.js';
import { OllamaBackend } from './backends/ollama.js';
import { OpenAIBackend } from './backends/openai.js';
import { CursorBackend } from './backends/cursor.js';
import type { TurnWindow, KNode } from '../types.js';

export interface AgentInput<I> {
  window?: TurnWindow;
  facts?: KNode[];
  payload: I;
}

export interface AgentOutput<O> {
  output: O;
  confidence: number;
  model: string;
  tokens?: { in: number; out: number };
  cached: boolean;
}

export type JsonSchema = Record<string, unknown>;

interface ResolvedModel { backendName: string; model: string; modelRef: string; }

export interface Agent<I, O> {
  name: string;
  /** Bumped on prompt change → invalidates cache. */
  promptVersion: number;
  /** "<backend>:<model>" ref OR agent-name key looked up in config.agents. */
  modelKey?: string;
  schema: JsonSchema;
  prompt(input: AgentInput<I>): ChatMessage[];
  /** Optional final adjustment (e.g. derive confidence from validated output). */
  postprocess?(o: O, input: AgentInput<I>): { output: O; confidence: number };
}

export interface AgentRuntimeOpts {
  knowledgeDb: SqliteDb;
  config: SubstrateNetConfig;
}

export class AgentRuntime {
  private readonly db: SqliteDb;
  private readonly config: SubstrateNetConfig;
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly backendCache = new Map<string, Backend>();

  constructor(opts: AgentRuntimeOpts) {
    this.db = opts.knowledgeDb;
    this.config = opts.config;
    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  async run<I, O>(agent: Agent<I, O>, input: AgentInput<I>): Promise<AgentOutput<O>> {
    const resolved = this.resolveModel(agent);
    const validator = this.getValidator(agent);

    // Candidate chain: primary, then optional fallback (e.g. frontier -> local).
    // The fallback lets heavy agents default to a subscribed backend yet still
    // run on local Ollama when that backend is unavailable (no API key, etc.).
    const candidates = [resolved.primary, ...(resolved.fallback ? [resolved.fallback] : [])];

    // 1. cache lookup — across all candidate model refs.
    for (const cand of candidates) {
      const inputHash = hashInput(agent, cand.modelRef, input);
      const cached = this.lookupCache(agent.name, cand.modelRef, inputHash);
      if (cached) {
        const parsed = JSON.parse(cached.output_json) as O;
        const post = agent.postprocess?.(parsed, input);
        return {
          output: post?.output ?? parsed,
          confidence: post?.confidence ?? extractConfidence(parsed) ?? 1,
          model: cand.modelRef,
          cached: true,
        };
      }
    }

    // 2. call backend — try each candidate in order until one responds.
    const start = Date.now();
    const messages = agent.prompt(input);
    let active: ResolvedModel | undefined;
    let backend: Backend | undefined;
    let raw: { content: string; tokensIn?: number; tokensOut?: number } | undefined;
    let lastError: Error | undefined;
    for (const cand of candidates) {
      try {
        const b = this.getBackend(cand.backendName);
        raw = await b.chat({ model: cand.model, messages, jsonMode: true });
        active = cand;
        backend = b;
        break;
      } catch (e) {
        lastError = e as Error;
      }
    }
    if (!active || !backend || !raw) {
      this.persistRun(agent.name, resolved.primary.modelRef, hashInput(agent, resolved.primary.modelRef, input), '', false, lastError?.message ?? 'no backend', Date.now() - start);
      throw lastError ?? new Error('no backend available');
    }
    const inputHash = hashInput(agent, active.modelRef, input);
    const resolvedActive = active;

    // 3. parse + validate (with one repair retry)
    let parsed: unknown;
    let validationError: string | undefined;
    try {
      parsed = parseJsonLenient(raw.content);
      if (!validator(parsed)) {
        validationError = this.ajv.errorsText(validator.errors);
      }
    } catch (e) {
      validationError = (e as Error).message;
    }

    if (validationError) {
      const repair: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: raw.content },
        {
          role: 'user',
          content:
            `Your previous response failed schema validation: ${validationError}\n` +
            `Reply with ONLY a valid JSON object that matches the schema. No prose, no fences.`,
        },
      ];
      try {
        raw = await backend.chat({ model: resolvedActive.model, messages: repair, jsonMode: true });
        parsed = parseJsonLenient(raw.content);
        if (!validator(parsed)) {
          throw new Error(`schema validation failed after repair: ${this.ajv.errorsText(validator.errors)}`);
        }
      } catch (e) {
        this.persistRun(
          agent.name, resolvedActive.modelRef, inputHash, raw.content, false,
          (e as Error).message, Date.now() - start,
          raw.tokensIn, raw.tokensOut,
        );
        throw e;
      }
    }

    const ms = Date.now() - start;
    const outputJson = JSON.stringify(parsed);
    this.persistRun(agent.name, resolvedActive.modelRef, inputHash, outputJson, true, undefined, ms, raw.tokensIn, raw.tokensOut);

    const post = agent.postprocess?.(parsed as O, input);
    return {
      output: post?.output ?? (parsed as O),
      confidence: post?.confidence ?? extractConfidence(parsed) ?? 0.5,
      model: resolvedActive.modelRef,
      tokens: raw.tokensIn !== undefined && raw.tokensOut !== undefined
        ? { in: raw.tokensIn, out: raw.tokensOut }
        : undefined,
      cached: false,
    };
  }

  // ------------------------------------------------------------------------

  private resolveModel<I, O>(agent: Agent<I, O>): { primary: ResolvedModel; fallback?: ResolvedModel } {
    const key = agent.modelKey ?? agent.name;
    const spec = this.config.agents[key];
    if (!spec) throw new Error(`Agent "${key}" missing in config.agents`);
    const primary = this.parseResolved(spec.model, key)!; // non-soft: throws, never undefined
    const fallback = spec.fallback ? this.parseResolved(spec.fallback, key, true) : undefined;
    return { primary, fallback };
  }

  /** Parse a "<backend>:<model>" ref; for the primary, the backend must exist. */
  private parseResolved(ref: string, key: string, soft = false): ResolvedModel | undefined {
    const { backend, model } = parseModelRef(ref);
    if (!this.config.agentBackends[backend]) {
      if (soft) return undefined; // fallback to a missing backend is just ignored
      throw new Error(`Backend "${backend}" referenced by agent "${key}" not configured`);
    }
    return { backendName: backend, model, modelRef: ref };
  }

  private getValidator<I, O>(agent: Agent<I, O>): ValidateFunction {
    const key = `${agent.name}@${agent.promptVersion}`;
    let v = this.validators.get(key);
    if (!v) {
      v = this.ajv.compile(agent.schema);
      this.validators.set(key, v);
    }
    return v;
  }

  private getBackend(name: string): Backend {
    let b = this.backendCache.get(name);
    if (b) return b;
    const spec: BackendSpec = this.config.agentBackends[name];
    if (!spec) throw new Error(`Backend "${name}" not configured`);
    switch (spec.kind) {
      case 'ollama':
        b = new OllamaBackend({ endpoint: spec.endpoint ?? 'http://localhost:11434' });
        break;
      case 'openai-compatible':
        b = new OpenAIBackend({
          endpoint: spec.endpoint ?? 'https://api.openai.com/v1',
          apiKey: resolveApiKey(spec),
        });
        break;
      case 'cursor-agent':
        b = new CursorBackend({ apiKey: resolveApiKey(spec) });
        break;
      case 'anthropic':
        throw new Error('anthropic backend not yet implemented');
      default:
        throw new Error(`Unknown backend kind: ${(spec as any).kind}`);
    }
    this.backendCache.set(name, b);
    return b;
  }

  private lookupCache(
    agentName: string, model: string, inputHash: string,
  ): { output_json: string } | undefined {
    return this.db
      .prepare(`SELECT output_json FROM agent_runs WHERE agent_name=? AND model=? AND input_hash=? AND ok=1`)
      .get(agentName, model, inputHash) as { output_json: string } | undefined;
  }

  private persistRun(
    agentName: string, model: string, inputHash: string,
    outputJson: string, ok: boolean, error: string | undefined, ms: number,
    tokensIn?: number, tokensOut?: number,
  ): void {
    this.db
      .prepare(`
        INSERT INTO agent_runs
          (id, agent_name, model, input_hash, output_json, tokens_in, tokens_out, ms, ok, error, produced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_name, model, input_hash) DO UPDATE SET
          output_json=excluded.output_json,
          tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out,
          ms=excluded.ms, ok=excluded.ok, error=excluded.error,
          produced_at=excluded.produced_at
      `)
      .run(
        randomUUID(), agentName, model, inputHash, outputJson,
        tokensIn ?? null, tokensOut ?? null, ms, ok ? 1 : 0, error ?? null, Date.now(),
      );
  }
}

// ============================================================================
// Helpers
// ============================================================================

function hashInput<I, O>(agent: Agent<I, O>, modelRef: string, input: AgentInput<I>): string {
  const h = createHash('sha256');
  h.update(agent.name);
  h.update('|');
  h.update(String(agent.promptVersion));
  h.update('|');
  h.update(modelRef);
  h.update('|');
  // Sort keys for stable serialization.
  h.update(stableStringify(input));
  return h.digest('hex');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((v as any)[k])).join(',') + '}';
}

/** Parse JSON; tolerate model output wrapped in ```json fences or prose. */
function parseJsonLenient(s: string): unknown {
  const trimmed = s.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // strip ```json ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch { /* fall through */ }
  }
  // first { ... last }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new Error(`Could not parse JSON from model output: ${trimmed.slice(0, 120)}...`);
}

function extractConfidence(v: unknown): number | undefined {
  if (v && typeof v === 'object' && 'confidence' in (v as any)) {
    const c = (v as any).confidence;
    if (typeof c === 'number' && c >= 0 && c <= 1) return c;
  }
  return undefined;
}
