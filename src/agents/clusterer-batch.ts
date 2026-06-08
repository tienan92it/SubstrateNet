/**
 * Batch Clusterer — decides attach/create/merge for several ambiguous facts
 * in one call. Shares the clusterer model config via `modelKey: 'clusterer'`.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';
import type { ClustererAction, ClustererCandidate } from './clusterer.js';

export interface ClusterBatchItem {
  factId: string;
  fact: { kind: string; title: string; summary?: string };
  candidates: ClustererCandidate[];
}

export interface ClusterBatchPayload {
  items: ClusterBatchItem[];
}

export type ClusterBatchResultItem = ClustererAction & { factId: string };

export interface ClusterBatchOutput {
  results: ClusterBatchResultItem[];
}

const ACTION_SCHEMAS = [
  {
    type: 'object',
    required: ['factId', 'action', 'conceptId', 'confidence', 'reason'],
    properties: {
      factId: { type: 'string' },
      action: { const: 'attach' },
      conceptId: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', maxLength: 400 },
    },
    additionalProperties: false,
  },
  {
    type: 'object',
    required: ['factId', 'action', 'suggestedName', 'confidence', 'reason'],
    properties: {
      factId: { type: 'string' },
      action: { const: 'create' },
      suggestedName: { type: 'string', minLength: 1, maxLength: 120 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', maxLength: 400 },
    },
    additionalProperties: false,
  },
  {
    type: 'object',
    required: ['factId', 'action', 'conceptIds', 'suggestedName', 'confidence', 'reason'],
    properties: {
      factId: { type: 'string' },
      action: { const: 'merge' },
      conceptIds: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
      suggestedName: { type: 'string', minLength: 1, maxLength: 120 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', maxLength: 400 },
    },
    additionalProperties: false,
  },
];

const SYSTEM = `You are a concept clusterer. You receive SEVERAL new facts, each with its own
list of nearby existing concepts. For EACH fact independently decide:
  - "attach"   to an existing concept (specify conceptId from that fact's candidates)
  - "create"   a new concept (specify suggestedName: 3-6 word noun phrase)
  - "merge"    two existing concepts and attach the fact to the merged one
              (specify conceptIds[2] + suggestedName — both ids must be in that fact's candidates)

Default to "create" when no candidate clearly matches.
Default to "attach" when one candidate clearly subsumes the fact.
Use "merge" only when two candidates ARE the same idea (rare).

Return STRICT JSON:
{"results":[{"factId":"...","action":"attach|create|merge", ...}]}

Echo each input factId. Return one result per input fact. JSON only.`;

export const CLUSTERER_BATCH_AGENT: Agent<ClusterBatchPayload, ClusterBatchOutput> = {
  name: 'clustererBatch',
  modelKey: 'clusterer',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: { oneOf: ACTION_SCHEMAS },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<ClusterBatchPayload>): ChatMessage[] {
    const blocks = input.payload.items.map((item, idx) => {
      const candText = item.candidates.length
        ? item.candidates.map((c, i) => `    ${i + 1}. id="${c.id}" name="${c.name}"${c.summary ? ` — ${c.summary}` : ''}`).join('\n')
        : '    (no nearby candidates)';
      return (
        `FACT ${idx + 1} (factId="${item.factId}"):\n` +
        `  kind: ${item.fact.kind}\n  title: ${item.fact.title}\n` +
        (item.fact.summary ? `  summary: ${item.fact.summary}\n` : '') +
        `  CANDIDATES:\n${candText}`
      );
    }).join('\n\n');
    return [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${blocks}\n\nReturn JSON only.` },
    ];
  },
  postprocess(o: ClusterBatchOutput, input) {
    const byFact = new Map(input.payload.items.map((i) => [i.factId, i]));
    const results: ClusterBatchResultItem[] = [];
    for (const r of o.results ?? []) {
      const item = byFact.get(r.factId);
      if (!item) continue;
      const candIds = new Set(item.candidates.map((c) => c.id));
      if (r.action === 'attach' && 'conceptId' in r && candIds.has(r.conceptId)) {
        results.push(r);
      } else if (r.action === 'create' && 'suggestedName' in r && r.suggestedName?.trim()) {
        results.push(r);
      } else if (r.action === 'merge' && 'conceptIds' in r && candIds.has(r.conceptIds[0]) && candIds.has(r.conceptIds[1])) {
        results.push(r);
      }
    }
    return { output: { results }, confidence: 0.8 };
  },
};

registerAgent(CLUSTERER_BATCH_AGENT);
