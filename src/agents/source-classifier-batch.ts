/**
 * Batch Source Classifier — labels several doc/diagram windows in one call.
 *
 * Same label space as SOURCE_CLASSIFIER_AGENT (doc_kind / topics / area), but
 * the payload carries N items and the output is keyed by windowId. Routed by
 * `modelKey: 'sourceClassifier'`. The pipeline falls back to single-window
 * classification when a batch fails.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import type { DocKind } from '../types.js';
import { registerAgent } from './registry.js';

const DOC_KINDS: DocKind[] = [
  'brd', 'prd', 'architecture', 'adr', 'runbook', 'api_spec',
  'diagram', 'notes', 'changelog', 'meta',
];

export interface SourceClassifierBatchItem {
  windowId: string;
  sourcePath: string;
  text: string;
}

export interface SourceClassifierBatchPayload {
  items: SourceClassifierBatchItem[];
  context?: string;
}

export interface SourceClassifierBatchResultItem {
  windowId: string;
  doc_kind: DocKind;
  topics: string[];
  area?: string;
}

export interface SourceClassifierBatchOutput {
  results: SourceClassifierBatchResultItem[];
}

const SYSTEM = `You classify SEVERAL documentation/diagram/note artifacts from a software project.
Classify EACH independently and return STRICT JSON only — no prose, no fences.

doc_kind (pick exactly one per item):
  brd | prd | architecture | adr | runbook | api_spec | diagram | changelog | notes | meta
topics: 2-6 short lowercase tags per item.
area (optional): product area / feature / module; omit if unclear.

Echo each windowId. Return JSON exactly matching:
{"results":[{"windowId":"...","doc_kind":"...","topics":["..."],"area":"..."}]}`;

export const SOURCE_CLASSIFIER_BATCH_AGENT: Agent<SourceClassifierBatchPayload, SourceClassifierBatchOutput> = {
  name: 'sourceClassifierBatch',
  modelKey: 'sourceClassifier',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['windowId', 'doc_kind', 'topics'],
          properties: {
            windowId: { type: 'string' },
            doc_kind: { enum: DOC_KINDS as unknown as string[] },
            topics: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 8 },
            area: { type: 'string', maxLength: 60 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<SourceClassifierBatchPayload>): ChatMessage[] {
    const ctx = input.payload.context ? `PROJECT CONTEXT:\n${input.payload.context}\n\n` : '';
    const body = input.payload.items
      .map((it) => `### WINDOW ${it.windowId}\nSOURCE PATH: ${it.sourcePath}\n${clamp(it.text, 3000)}`)
      .join('\n\n');
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: ctx + `Classify these ${input.payload.items.length} artifacts. Echo each windowId.\n\n${body}\n\nReturn JSON only.`,
      },
    ];
  },
  postprocess(o: SourceClassifierBatchOutput) {
    const results = (o.results ?? []).map((r) => ({
      windowId: r.windowId,
      doc_kind: (DOC_KINDS as string[]).includes(r.doc_kind) ? r.doc_kind : ('notes' as DocKind),
      topics: (r.topics ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 8),
      area: r.area?.trim() || undefined,
    }));
    return { output: { results }, confidence: 0.7 };
  },
};

registerAgent(SOURCE_CLASSIFIER_BATCH_AGENT);

function clamp(s: string, n: number): string {
  if (s.length <= n) return s;
  const half = Math.floor((n - 32) / 2);
  return s.slice(0, half) + `\n\n...[trimmed]...\n\n` + s.slice(s.length - half);
}
