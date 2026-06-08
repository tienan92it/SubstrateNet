/**
 * Shared scaffolding for L2 extractor agents (Decision, BusinessLogic, Intent,
 * ProblemSolution). Each extractor returns the same shape — an array of typed
 * facts — but with a different prompt and routing rule.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import type { KNodeKind } from '../types.js';
import { createHash } from 'crypto';
import type { KNode, KProvenance } from '../types.js';

export interface ExtractedFact {
  kind: KNodeKind;
  title: string;
  summary?: string;
  evidence_text?: string;
  confidence: number;
  symbol_mentions?: string[];
  file_mentions?: string[];
}

export interface ExtractorOutput {
  facts: ExtractedFact[];
  rationale?: string;
}

export interface ExtractorPayload {
  text: string;
  windowId: string;
  /** Serialized window brief (preferred over raw text when set). */
  briefText?: string;
  /** Triage hint: agent may use to focus or skip. */
  domain?: string;
  /** Compact project context for grounding + consistent naming/dedup. */
  context?: string;
}

const FACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['kind', 'title', 'confidence'],
  properties: {
    kind: { type: 'string' },
    title: { type: 'string', maxLength: 200 },
    summary: { type: 'string', maxLength: 800 },
    evidence_text: { type: 'string', maxLength: 4000 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    symbol_mentions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    file_mentions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
  },
  additionalProperties: false,
};

export const EXTRACTOR_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['facts'],
  properties: {
    facts: { type: 'array', items: FACT_SCHEMA, maxItems: 8 },
    rationale: { type: 'string', maxLength: 600 },
  },
  additionalProperties: false,
};

export interface DefineExtractorOpts {
  name: string;
  modelKey?: string;
  allowedKinds: readonly KNodeKind[];
  /** What the agent should produce, in declarative form. */
  systemPrompt: string;
}

/**
 * Build a chat-LLM extractor agent. Promptversion bumps invalidate the cache.
 */
export function defineExtractor(opts: DefineExtractorOpts): Agent<ExtractorPayload, ExtractorOutput> {
  const allowedSet = new Set(opts.allowedKinds);
  return {
    name: opts.name,
    promptVersion: 1,
    modelKey: opts.modelKey,
    schema: EXTRACTOR_OUTPUT_SCHEMA,
    prompt(input: AgentInput<ExtractorPayload>): ChatMessage[] {
      const text = clamp(input.payload.briefText ?? input.payload.text, 3500);
      const allowedList = [...allowedSet].join(' | ');
      return [
        {
          role: 'system',
          content:
            opts.systemPrompt +
            `\n\n` +
            `Allowed values for "kind": ${allowedList}\n` +
            `Confidence must be in [0,1]. Use evidence_text to quote the smallest passage that supports the fact.\n` +
            `If nothing applies, return {"facts": []}. Never invent facts.\n` +
            `Return JSON exactly matching the schema, no prose, no fences.`,
        },
        {
          role: 'user',
          content:
            (input.payload.context ? `PROJECT CONTEXT (reuse these names; do not invent variants):\n${input.payload.context}\n\n` : '') +
            `WINDOW ID: ${input.payload.windowId}\n` +
            `DOMAIN (triage): ${input.payload.domain ?? 'unknown'}\n` +
            `--- begin window ---\n${text}\n--- end window ---\n\n` +
            `Return JSON only.`,
        },
      ];
    },
    postprocess(o: ExtractorOutput, _input) {
      // Filter facts whose "kind" the agent invented outside the allowed set.
      const facts = o.facts.filter((f) => allowedSet.has(f.kind));
      return { output: { facts, rationale: o.rationale }, confidence: avgConfidence(facts) };
    },
  };
}

/**
 * Turn a single ExtractedFact into the KNode + KProvenance row pair we persist.
 */
export function factToRows(
  fact: ExtractedFact, windowId: string, agentName: string, agentModel: string,
): { node: KNode; provenance: KProvenance } {
  const now = Date.now();
  const id = createHash('sha1')
    .update(`${agentName}|${windowId}|${fact.kind}|${fact.title}`)
    .digest('hex')
    .slice(0, 16);
  const node: KNode = {
    id,
    kind: fact.kind,
    title: fact.title.slice(0, 240),
    summary: fact.summary?.slice(0, 1200),
    evidenceText: fact.evidence_text?.slice(0, 4000),
    confidence: fact.confidence,
    source: `agent:${agentName}`,
    agentModel,
    createdAt: now,
    updatedAt: now,
  };
  const provenance: KProvenance = { kNodeId: id, windowId };
  return { node, provenance };
}

function avgConfidence(facts: ExtractedFact[]): number {
  if (!facts.length) return 0;
  return facts.reduce((s, f) => s + (f.confidence ?? 0), 0) / facts.length;
}

function clamp(s: string, n: number): string {
  if (s.length <= n) return s;
  const half = Math.floor((n - 32) / 2);
  return s.slice(0, half) + `\n\n...[trimmed ${s.length - n} chars]...\n\n` + s.slice(s.length - half);
}
