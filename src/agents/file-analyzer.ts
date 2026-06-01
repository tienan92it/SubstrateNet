/**
 * FileAnalyzer Agent.
 *
 * The semantic half of the tree-sitter + LLM hybrid. The deterministic side
 * (code.db) already holds the file's defs, resolved imports, and call-sites;
 * this agent reads that structure ALONGSIDE a bounded source slice and produces
 * what a parser cannot: a plain-English summary, an architectural layer, tags,
 * and language-concept callouts.
 *
 * The structure is the grounding: the agent is told the imports/defs rather
 * than re-deriving them from source, which saves tokens and curbs invention.
 * Output is purely descriptive; postprocess only normalizes the layer.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

export const LAYERS = ['api', 'service', 'data', 'ui', 'utility', 'other'] as const;
export type Layer = (typeof LAYERS)[number];

export interface FileAnalyzerPayload {
  path: string;
  language: string;
  defs: Array<{ name: string; kind: string; signature?: string }>;
  imports: string[];
  calls: string[];
  sourceSlice: string;
}

export interface FileAnalyzerOutput {
  summary: string;
  layer: Layer;
  tags: string[];
  concepts: string[];
}

const SYSTEM = `You analyze ONE source file using its pre-parsed structure plus a source excerpt.
The structure (definitions, imports, call-sites) is authoritative — do not re-derive it.

Produce STRICT JSON: { "summary", "layer", "tags", "concepts" }.
  - summary: 1-3 sentences on what this file is FOR (its responsibility), not a line-by-line restatement.
  - layer: the architectural layer this file belongs to, one of:
      api      — HTTP/RPC handlers, routes, controllers, endpoints
      service  — business logic, orchestration, use-cases
      data     — models, schema, repositories, DB access, migrations
      ui       — components, views, screens, styling
      utility  — helpers, config, types, shared infra
      other    — anything that fits none of the above
  - tags: 1-6 short topical tags (e.g. "authentication", "payments", "websocket").
  - concepts: 0-5 programming concepts visibly used here (e.g. "generics", "decorators", "async iteration").

Hard rules:
  - Base everything on the supplied structure and excerpt. Do not invent imports or symbols.
  - Choose exactly one layer. If genuinely unclear, use "other".
  - Be concise. Return JSON only. No prose, no fences.`;

export const FILE_ANALYZER_AGENT: Agent<FileAnalyzerPayload, FileAnalyzerOutput> = {
  name: 'fileAnalyzer',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['summary', 'layer', 'tags', 'concepts'],
    properties: {
      summary: { type: 'string', minLength: 1, maxLength: 800 },
      layer: { enum: LAYERS as unknown as string[] },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      concepts: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<FileAnalyzerPayload>): ChatMessage[] {
    const { path, language, defs, imports, calls, sourceSlice } = input.payload;
    const defLines = defs.length
      ? defs.slice(0, 60).map((d) => `  ${d.kind} ${d.name}${d.signature ? ` ${d.signature}` : ''}`).join('\n')
      : '  (none)';
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `FILE: ${path}  [${language}]\n` +
          `DEFINITIONS:\n${defLines}\n` +
          `IMPORTS: ${imports.slice(0, 60).join(', ') || '(none)'}\n` +
          `CALLS: ${calls.slice(0, 60).join(', ') || '(none)'}\n` +
          `SOURCE (excerpt):\n${sourceSlice}\n\nReturn JSON only.`,
      },
    ];
  },
  postprocess(o: FileAnalyzerOutput, _input) {
    const layer: Layer = (LAYERS as readonly string[]).includes(o.layer) ? o.layer : 'other';
    return {
      output: {
        summary: (o.summary ?? '').trim(),
        layer,
        tags: (o.tags ?? []).filter((t) => t?.trim()).slice(0, 6),
        concepts: (o.concepts ?? []).filter((c) => c?.trim()).slice(0, 5),
      },
      confidence: o.summary?.trim() ? 0.8 : 0,
    };
  },
};

registerAgent(FILE_ANALYZER_AGENT);
