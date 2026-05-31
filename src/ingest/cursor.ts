/**
 * Cursor SessionAdapter.
 *
 * Transcripts live at:
 *   ~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl
 *
 * <slug> is derived from the absolute workspace path by stripping the leading
 * slash and replacing remaining slashes with dashes.
 *
 * The JSONL shape (per observed sample):
 *   {"role": "user", "message": {"content": [{"type": "text", "text": "..."}]}}
 *   {"role": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
 * Tool calls and other shapes may appear; the adapter is defensive about them.
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { join } from 'path';
import { createInterface } from 'readline';
import type { SessionAdapter } from './base.js';
import type { RawTurn, SessionRef, TurnRole } from '../types.js';
import { expandHome } from '../config.js';

const DEFAULT_CURSOR_ROOT = '~/.cursor/projects';

export interface CursorAdapterOpts {
  /** Override the cursor projects root. Defaults to ~/.cursor/projects. */
  root?: string;
}

export class CursorAdapter implements SessionAdapter {
  readonly agent = 'cursor' as const;
  private readonly root: string;

  constructor(opts: CursorAdapterOpts = {}) {
    this.root = expandHome(opts.root ?? DEFAULT_CURSOR_ROOT);
  }

  async *discover(projectRoot: string): AsyncIterable<SessionRef> {
    const slug = slugForPath(resolvePath(projectRoot));
    const projDir = join(this.root, slug);
    const transcriptsDir = join(projDir, 'agent-transcripts');
    if (!existsSync(transcriptsDir)) return;

    for (const entry of readdirSync(transcriptsDir)) {
      const entryAbs = join(transcriptsDir, entry);
      let st;
      try { st = statSync(entryAbs); } catch { continue; }
      if (!st.isDirectory()) continue;
      const fileAbs = join(entryAbs, `${entry}.jsonl`);
      if (!existsSync(fileAbs)) continue;
      let fst;
      try { fst = statSync(fileAbs); } catch { continue; }
      yield {
        agent: 'cursor',
        sourceId: entry,
        sourcePath: fileAbs,
        startedAt: fst.mtimeMs,
      };
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
      // +1 for the newline that readline stripped
      cursor += Buffer.byteLength(line, 'utf8') + 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: any;
      try { raw = JSON.parse(trimmed); } catch { continue; }
      const turn = parseCursorEntry(raw);
      if (turn) yield { turn, offsetAfter: cursor };
    }
  }
}

/**
 * Convert a Cursor JSONL entry to a normalized RawTurn.
 * Captures text from message.content[*].text and best-effort tool calls.
 */
export function parseCursorEntry(raw: any): RawTurn | undefined {
  const role = normalizeRole(raw?.role);
  if (!role) return undefined;

  const parts: string[] = [];
  const toolCalls: { name: string; args?: unknown; resultExcerpt?: string; targetPaths?: string[] }[] = [];

  const content = raw?.message?.content ?? raw?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text' && typeof c.text === 'string') {
        parts.push(c.text);
      } else if (c.type === 'tool_use' || c.type === 'tool_call') {
        toolCalls.push({
          name: String(c.name ?? c.tool ?? 'unknown'),
          args: c.input ?? c.args,
          targetPaths: extractPathsFromArgs(c.input ?? c.args),
        });
      } else if (c.type === 'tool_result') {
        // attach to last call if present
        const last = toolCalls[toolCalls.length - 1];
        const excerpt = typeof c.content === 'string'
          ? c.content
          : Array.isArray(c.content)
            ? c.content.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('\n')
            : '';
        if (last) last.resultExcerpt = excerpt.slice(0, 2000);
      }
    }
  } else if (typeof content === 'string') {
    parts.push(content);
  }

  const text = parts.join('\n').trim();
  return {
    role,
    text,
    ts: typeof raw?.ts === 'number' ? raw.ts : undefined,
    raw,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

function normalizeRole(r: unknown): TurnRole | undefined {
  if (r === 'user' || r === 'assistant' || r === 'tool' || r === 'system') return r;
  return undefined;
}

function extractPathsFromArgs(args: unknown): string[] | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const out: string[] = [];
  for (const key of ['path', 'file_path', 'filePath', 'target_file', 'targetFile', 'filename']) {
    const v = (args as any)[key];
    if (typeof v === 'string') out.push(v);
  }
  return out.length ? out : undefined;
}

/**
 * Cursor project slug rule: replace every run of non-alphanumeric characters
 * with a single "-", then trim leading/trailing dashes. This matches Cursor's
 * actual encoding — NOT just slash replacement:
 *   /Users/me/Workspace/Foo        -> Users-me-Workspace-Foo
 *   /Users/me/Workspace/kafi/k_one -> Users-me-Workspace-kafi-k-one   (_ -> -)
 *   /Users/me/Workspace/kafi/dp-2.0-> Users-me-Workspace-kafi-dp-2-0  (. -> -)
 *   /Users/me/Desktop/.nosync/app  -> Users-me-Desktop-nosync-app     (runs collapse)
 */
export function slugForPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
