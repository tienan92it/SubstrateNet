/**
 * Codex CLI SessionAdapter.
 *
 * Codex stores session transcripts under ~/.codex/sessions/ (one JSONL per
 * session). Project association is best-effort — Codex JSONL usually includes
 * a `cwd` field in its initialization entry; sessions whose cwd matches the
 * project root are returned.
 *
 * Entries follow OpenAI Responses-style messages:
 *   { "type": "message", "role": "user"|"assistant", "content": [...] }
 *   { "type": "function_call", ... }
 *   { "type": "function_call_output", ... }
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { resolve as resolvePath, join } from 'path';
import { createInterface } from 'readline';
import type { SessionAdapter } from './base.js';
import type { RawTurn, SessionRef, TurnRole } from '../types.js';
import { expandHome } from '../config.js';

const DEFAULT_ROOT = '~/.codex/sessions';

export interface CodexAdapterOpts {
  root?: string;
}

export class CodexAdapter implements SessionAdapter {
  readonly agent = 'codex' as const;
  private readonly root: string;

  constructor(opts: CodexAdapterOpts = {}) {
    this.root = expandHome(opts.root ?? DEFAULT_ROOT);
  }

  async *discover(projectRoot: string): AsyncIterable<SessionRef> {
    if (!existsSync(this.root)) return;
    const target = resolvePath(projectRoot);
    yield* this.walk(this.root, target);
  }

  private async *walk(dir: string, target: string): AsyncIterable<SessionRef> {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        yield* this.walk(abs, target);
        continue;
      }
      if (!name.endsWith('.jsonl')) continue;
      const cwd = sniffCodexSessionCwd(abs);
      if (cwd && resolvePath(cwd) === target) {
        yield {
          agent: 'codex',
          sourceId: name.replace(/\.jsonl$/, ''),
          sourcePath: abs,
          startedAt: st.mtimeMs,
        };
      }
    }
  }

  async *read(
    ref: SessionRef, fromOffset: number,
  ): AsyncIterable<{ turn: RawTurn; offsetAfter: number }> {
    if (!existsSync(ref.sourcePath)) return;
    const st = statSync(ref.sourcePath);
    if (fromOffset >= st.size) return;
    const stream = createReadStream(ref.sourcePath, { start: fromOffset, encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let cursor = fromOffset;
    for await (const line of rl) {
      cursor += Buffer.byteLength(line, 'utf8') + 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: any;
      try { raw = JSON.parse(trimmed); } catch { continue; }
      const turn = parseCodexEntry(raw);
      if (turn) yield { turn, offsetAfter: cursor };
    }
  }
}

export function parseCodexEntry(raw: any): RawTurn | undefined {
  // Codex uses several shapes. Common cases handled here.
  if (raw?.type === 'message') {
    const role = normalizeRole(raw.role);
    if (!role) return undefined;
    const parts: string[] = [];
    if (typeof raw.content === 'string') parts.push(raw.content);
    else if (Array.isArray(raw.content)) {
      for (const c of raw.content) {
        if (typeof c?.text === 'string') parts.push(c.text);
        else if (c?.type === 'input_text' && typeof c.text === 'string') parts.push(c.text);
        else if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
      }
    }
    return { role, text: parts.join('\n').trim(), raw };
  }
  if (raw?.type === 'function_call') {
    return {
      role: 'assistant',
      text: '',
      raw,
      toolCalls: [{
        name: String(raw.name ?? 'unknown'),
        args: tryJson(raw.arguments),
        targetPaths: extractPaths(tryJson(raw.arguments)),
      }],
    };
  }
  if (raw?.type === 'function_call_output') {
    return {
      role: 'tool',
      text: typeof raw.output === 'string' ? raw.output.slice(0, 4000) : JSON.stringify(raw.output ?? null).slice(0, 4000),
      raw,
    };
  }
  return undefined;
}

function normalizeRole(r: unknown): TurnRole | undefined {
  if (r === 'user' || r === 'assistant' || r === 'system' || r === 'tool') return r;
  return undefined;
}

function tryJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function extractPaths(args: unknown): string[] | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const out: string[] = [];
  for (const key of ['path', 'file_path', 'filePath', 'target_file', 'filename']) {
    const v = (args as any)[key];
    if (typeof v === 'string') out.push(v);
  }
  return out.length ? out : undefined;
}

/**
 * Read the first few lines looking for a JSON entry that carries `cwd` or
 * `workspace` so we can decide if the session belongs to the project.
 */
/** Read session JSONL header for project cwd (used by setup discovery). */
export function sniffCodexSessionCwd(path: string): string | undefined {
  try {
    const buf = readFileSync(path, { encoding: 'utf8' });
    const lines = buf.split('\n', 20);
    for (const line of lines) {
      if (!line) continue;
      try {
        const obj: any = JSON.parse(line);
        if (typeof obj?.cwd === 'string') return obj.cwd;
        if (typeof obj?.workspace === 'string') return obj.workspace;
        if (typeof obj?.payload?.cwd === 'string') return obj.payload.cwd;
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return undefined;
}
