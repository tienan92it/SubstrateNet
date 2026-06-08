/**
 * Cursor SDK backend.
 *
 * Runs the heavy-reasoning agents through the user's Cursor subscription via
 * `@cursor/sdk` `Agent.prompt(...)` (one-shot), so the pipeline can reach
 * higher-tier models without per-token API billing.
 *
 * Safety: Cursor agents can use tools and touch a working directory. We run
 * LOCAL against a sandboxed EMPTY temp dir with no MCP servers and inline-only
 * settings, so the agent can only answer from the prompt — it never reads or
 * edits the user's repo. All source text the agent needs is passed inline.
 *
 * The `@cursor/sdk` package is an OPTIONAL dependency, loaded via dynamic import
 * only when this backend is actually used; default (Ollama-only) installs are
 * unaffected. A `runner` seam allows unit tests without the live SDK.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Backend, ChatRequest, ChatResponse } from './base.js';

/** One-shot result shape we depend on (subset of the SDK's RunResult). */
export interface CursorRunResult {
  status: string;            // 'finished' | 'error' | ...
  result?: string;           // final assistant text
}

/** Injectable runner: (prompt, { model, cwd, apiKey }) -> result. */
export type CursorRunner = (
  prompt: string,
  opts: { model: string; cwd: string; apiKey?: string },
) => Promise<CursorRunResult>;

export interface CursorBackendOpts {
  apiKey?: string;
  /** Override the one-shot runner (tests). Defaults to the real `@cursor/sdk`. */
  runner?: CursorRunner;
}

export class CursorBackend implements Backend {
  private readonly apiKey?: string;
  private readonly runner: CursorRunner;
  private sandboxCwd?: string;

  constructor(opts: CursorBackendOpts = {}) {
    this.apiKey = opts.apiKey ?? process.env.CURSOR_API_KEY;
    this.runner = opts.runner ?? defaultRunner;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const prompt = buildPrompt(req);
    const cwd = this.getSandbox();
    const model = normalizeCursorModel(req.model);
    const result = await this.runner(prompt, { model, cwd, apiKey: this.apiKey });
    if (result.status === 'error') {
      // Run executed but failed mid-flight — surface so the runtime records it.
      throw new Error(`Cursor agent run failed (status=error)`);
    }
    return { content: result.result ?? '' };
  }

  /** Lazily create one throwaway empty dir per backend instance. */
  private getSandbox(): string {
    if (!this.sandboxCwd) {
      this.sandboxCwd = mkdtempSync(join(tmpdir(), 'subnet-cursor-'));
    }
    return this.sandboxCwd;
  }
}

/** Account-available Cursor model ids (used for validation + aliasing). */
export const CURSOR_MODELS = [
  'auto', 'default', 'composer-2.5', 'claude-opus-4-8', 'gpt-5.5', 'claude-sonnet-4.5',
];

/** Map deprecated/alias slugs to account-available Cursor model ids. */
export function normalizeCursorModel(model: string): string {
  if (model === 'composer-2.5-fast') return 'composer-2.5';
  return model;
}

/** Flatten system+user messages into a single prompt with a JSON-only guard. */
function buildPrompt(req: ChatRequest): string {
  const parts: string[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') parts.push(m.content);
    else if (m.role === 'user') parts.push(`\n--- INPUT ---\n${m.content}`);
    else parts.push(`\n[assistant]\n${m.content}`);
  }
  if (req.jsonMode) {
    parts.push(
      `\n--- OUTPUT CONTRACT ---\n` +
      `Respond with ONLY a single valid JSON object. No prose, no code fences, ` +
      `no tool calls, no file edits. Do not read or modify any files.`,
    );
  }
  return parts.join('\n');
}

/**
 * Default runner: dynamic-import `@cursor/sdk` and run a sandboxed local
 * one-shot. Throwing here is treated by the runtime as a backend failure.
 */
const defaultRunner: CursorRunner = async (prompt, opts) => {
  let sdk: any;
  try {
    // Indirected so bundlers/tsc don't hard-require the optional package.
    sdk = await import(/* @vite-ignore */ '@cursor/sdk' as string);
  } catch {
    throw new Error(
      'Cursor SDK backend selected but "@cursor/sdk" is not installed. ' +
      'Run `npm install @cursor/sdk` and set CURSOR_API_KEY.',
    );
  }
  const Agent = sdk.Agent;
  const res = await Agent.prompt(prompt, {
    apiKey: opts.apiKey,
    model: { id: opts.model },
    local: { cwd: opts.cwd, settingSources: [] },
  });
  return { status: String(res?.status ?? 'error'), result: res?.result };
};
