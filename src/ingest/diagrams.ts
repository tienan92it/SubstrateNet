/**
 * Diagrams SessionAdapter (L1 source).
 *
 * Mines human-readable text out of in-repo diagrams so the knowledge pipeline
 * can learn the architecture/flows they encode. Text-first: we extract labels
 * and source text, not pixels.
 *
 *   - .mmd / .mermaid          → mermaid source (kept verbatim)
 *   - .puml / .plantuml / .iuml → PlantUML source (verbatim)
 *   - .drawio / .dio           → XML; extract node/edge labels (value=, text)
 *   - .excalidraw              → JSON; extract text elements
 *
 * Mermaid fenced blocks inside markdown are already captured by the Docs
 * adapter, so we only handle standalone diagram files here. Emitted under the
 * `docs` agent family so it flows through triage + the source classifier.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve as resolvePath, relative, basename, extname } from 'path';
import type { SessionAdapter } from './base.js';
import type { RawTurn, SessionRef } from '../types.js';
import { walkFiles } from './docs.js';

const DIAGRAM_EXTS = new Set([
  '.mmd', '.mermaid', '.puml', '.plantuml', '.iuml', '.drawio', '.dio', '.excalidraw',
]);

const MAX_FILES = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 6000;

export interface DiagramsAdapterOpts {
  root?: string;
}

export class DiagramsAdapter implements SessionAdapter {
  readonly agent = 'docs' as const;
  private readonly rootOverride?: string;

  constructor(opts: DiagramsAdapterOpts = {}) {
    this.rootOverride = opts.root;
  }

  async *discover(projectRoot: string): AsyncIterable<SessionRef> {
    const base = resolvePath(this.rootOverride ?? projectRoot);
    if (!existsSync(base)) return;
    let count = 0;
    for (const abs of walkFiles(base, isDiagramFile)) {
      if (count >= MAX_FILES) break;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      count++;
      const rel = relative(base, abs) || basename(abs);
      yield { agent: 'docs', sourceId: rel, sourcePath: abs, title: rel, startedAt: st.mtimeMs };
    }
  }

  async *read(
    ref: SessionRef, fromOffset: number,
  ): AsyncIterable<{ turn: RawTurn; offsetAfter: number }> {
    if (!existsSync(ref.sourcePath)) return;
    const st = statSync(ref.sourcePath);
    if (fromOffset >= st.size) return;
    let raw: string;
    try { raw = readFileSync(ref.sourcePath, 'utf8'); } catch { return; }

    const text = extractDiagramText(ref.sourcePath, raw).slice(0, MAX_TEXT_CHARS).trim();
    if (text.length < 12) return; // nothing meaningful to learn from

    const user: RawTurn = {
      role: 'user',
      text: `Diagram: ${ref.sourceId} (${extname(ref.sourcePath).slice(1)})`,
      raw: { diagramPath: ref.sourceId },
    };
    const body: RawTurn = { role: 'assistant', text, raw: { diagramPath: ref.sourceId } };
    yield { turn: user, offsetAfter: st.size };
    yield { turn: body, offsetAfter: st.size };
  }
}

export function isDiagramFile(abs: string): boolean {
  return DIAGRAM_EXTS.has(extname(abs).toLowerCase());
}

/** Pull readable text from a diagram file based on its format. */
export function extractDiagramText(path: string, raw: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.drawio' || ext === '.dio') return extractDrawioLabels(raw);
  if (ext === '.excalidraw') return extractExcalidrawText(raw);
  // mermaid / plantuml: source is already readable text.
  return raw;
}

/** draw.io stores node/edge labels in `value="..."` attrs (often HTML-escaped). */
export function extractDrawioLabels(xml: string): string {
  const labels: string[] = [];
  const re = /value="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const label = decodeEntities(stripTags(m[1])).trim();
    if (label) labels.push(label);
  }
  return [...new Set(labels)].join('\n');
}

/** Excalidraw stores text in elements with type "text" (field `text`). */
export function extractExcalidrawText(json: string): string {
  try {
    const data = JSON.parse(json);
    const els: any[] = Array.isArray(data?.elements) ? data.elements : [];
    const texts = els
      .filter((e) => e && (e.type === 'text' || typeof e.text === 'string'))
      .map((e) => String(e.text ?? '').trim())
      .filter(Boolean);
    return [...new Set(texts)].join('\n');
  } catch {
    return '';
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#10;/g, '\n').replace(/&#xa;/gi, '\n')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}
