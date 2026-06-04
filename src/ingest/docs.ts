/**
 * Docs SessionAdapter (L1 source).
 *
 * Treats in-repo documentation as a first-class conversation source so the
 * existing triage -> extract pipeline can mine business knowledge (BRD / PRD /
 * architecture notes / domain glossaries) from authored prose — not just chat.
 *
 * Discovery: README*, docs/**, ADRs (adr/ , decisions/), and top-level *.md.
 * Each document becomes one "session"; each section-sized chunk becomes a
 * window via a synthetic (user heading, assistant body) turn pair so the
 * deterministic segmenter slices it cleanly.
 *
 * Provenance: sessions are tagged agent='docs'; window text quotes the file
 * path so downstream facts cite the document they came from.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve as resolvePath, join, relative, basename, extname } from 'path';
import type { SessionAdapter } from './base.js';
import type { RawTurn, SessionRef } from '../types.js';

/** Directories never worth scanning for docs. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.substrate-net', 'dist', 'build', 'out',
  'vendor', 'coverage', '.next', '.cache', 'target', '__pycache__',
]);

/** Directory names that mark architecture-decision-record collections. */
const ADR_DIRS = new Set(['adr', 'adrs', 'decisions', 'rfcs', 'rfc']);

const MAX_DOC_FILES = 300;
const MAX_DOC_BYTES = 256 * 1024;   // skip generated / huge docs
const MAX_CHUNK_CHARS = 6000;       // stays under the segmenter's 8000 cap

export interface DocsAdapterOpts {
  /** Scan root override (defaults to the project root passed to discover). */
  root?: string;
}

export class DocsAdapter implements SessionAdapter {
  readonly agent = 'docs' as const;
  private readonly rootOverride?: string;

  constructor(opts: DocsAdapterOpts = {}) {
    this.rootOverride = opts.root;
  }

  async *discover(projectRoot: string): AsyncIterable<SessionRef> {
    const base = resolvePath(this.rootOverride ?? projectRoot);
    if (!existsSync(base)) return;
    let count = 0;
    for (const fileAbs of walkDocs(base)) {
      if (count >= MAX_DOC_FILES) break;
      let st;
      try { st = statSync(fileAbs); } catch { continue; }
      if (!st.isFile() || st.size > MAX_DOC_BYTES) continue;
      count++;
      const rel = relative(base, fileAbs) || basename(fileAbs);
      yield {
        agent: 'docs',
        sourceId: rel,
        sourcePath: fileAbs,
        title: rel,
        startedAt: st.mtimeMs,
      };
    }
  }

  async *read(
    ref: SessionRef, fromOffset: number,
  ): AsyncIterable<{ turn: RawTurn; offsetAfter: number }> {
    if (!existsSync(ref.sourcePath)) return;
    const st = statSync(ref.sourcePath);
    if (fromOffset >= st.size) return; // already ingested at this size
    let content: string;
    try { content = readFileSync(ref.sourcePath, 'utf8'); } catch { return; }

    const rel = ref.sourceId;
    for (const chunk of chunkMarkdown(content)) {
      const heading = chunk.heading ? ` — ${chunk.heading}` : '';
      // Synthetic user turn = locator; assistant turn = the prose body. The
      // pair satisfies the segmenter (needs a user + a response per window).
      const user: RawTurn = {
        role: 'user',
        text: `Document: ${rel}${heading}`,
        raw: { docPath: rel, heading: chunk.heading ?? null },
      };
      const body: RawTurn = {
        role: 'assistant',
        text: chunk.text,
        raw: { docPath: rel },
      };
      // Re-reading is idempotent (window ids are content-hashed), so we can
      // report the final size for every turn; an interrupted run just re-reads.
      yield { turn: user, offsetAfter: st.size };
      yield { turn: body, offsetAfter: st.size };
    }
  }
}

/**
 * Recursively yield files under `base` matching a predicate, skipping vendored
 * and hidden directories. Shared by the docs and diagrams adapters.
 */
export function* walkFiles(
  base: string,
  accept: (abs: string, dir: string, base: string) => boolean,
): Generator<string> {
  const stack: string[] = [base];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        stack.push(abs);
      } else if (st.isFile() && accept(abs, dir, base)) {
        yield abs;
      }
    }
  }
}

/** Recursively yield candidate doc file paths under `base`. */
export function* walkDocs(base: string): Generator<string> {
  yield* walkFiles(base, isDocFile);
}

/** A file counts as a doc if it is markdown/text, or lives in an ADR dir. */
export function isDocFile(abs: string, dir: string, base: string): boolean {
  const name = basename(abs);
  const ext = extname(name).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx' || ext === '.rst') return true;
  if (/^readme(\.|$)/i.test(name)) return true;
  // Plain .txt only inside an ADR/decisions collection (avoids logs/fixtures).
  const dirName = basename(dir).toLowerCase();
  if (ext === '.txt' && ADR_DIRS.has(dirName)) return true;
  return false;
}

export interface DocChunk {
  heading?: string;
  text: string;
}

/**
 * Split markdown into section-sized chunks. New headings start new logical
 * sections; oversized sections are packed greedily up to MAX_CHUNK_CHARS.
 */
export function chunkMarkdown(content: string): DocChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: DocChunk[] = [];
  let curHeading: string | undefined;
  let buf: string[] = [];
  let bufLen = 0;

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) chunks.push({ heading: curHeading, text });
    buf = [];
    bufLen = 0;
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      // Heading boundary: flush the accumulated section, then start a new one.
      if (bufLen > 0) flush();
      curHeading = headingMatch[2].trim().slice(0, 160);
      continue;
    }
    buf.push(line);
    bufLen += line.length + 1;
    if (bufLen >= MAX_CHUNK_CHARS) flush();
  }
  flush();
  return chunks.filter((c) => c.text.length >= 40); // drop trivial fragments
}
