/**
 * SourceClassifier Agent.
 *
 * Labels a non-code source window (doc / diagram / note) by its content type so
 * messy repos become navigable: BRD vs runbook vs ADR vs notes, the topics it
 * covers, and which product area it belongs to. Heavy-reasoning agent → routed
 * to the frontier backend (falls back to local).
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import type { DocKind } from '../types.js';
import { registerAgent } from './registry.js';

const DOC_KINDS: DocKind[] = [
  'brd', 'prd', 'architecture', 'adr', 'runbook', 'api_spec',
  'diagram', 'notes', 'changelog', 'meta',
];

export interface SourceClassifierPayload {
  text: string;
  sourcePath: string;
  /** Optional compact project context for consistent `area` labels. */
  context?: string;
}

export interface SourceClassifierOutput {
  doc_kind: DocKind;
  topics: string[];
  area?: string;
}

const SYSTEM = `You classify a documentation/diagram/note artifact from a software project.
Return STRICT JSON only — no prose, no fences.

doc_kind (pick exactly one):
  brd          — business requirements: goals, stakeholders, scope.
  prd          — product requirements: features, user stories, acceptance criteria.
  architecture — system/architecture design, components, data flow, decisions.
  adr          — a single architecture decision record (context/decision/consequences).
  runbook      — operational how-to: deploy, on-call, incident response, ops procedures.
  api_spec     — API/interface contract (endpoints, schemas, payloads).
  diagram      — a diagram's extracted labels (flow, ERD, sequence, C4).
  changelog    — release notes / change history.
  notes        — informal notes, meeting notes, scratch, todos.
  meta         — repo meta (README setup, contributing, license) with little domain content.

topics: 2-6 short topic tags (domain or technical), lowercase.
area (optional): the product area / feature / module this belongs to (e.g. "payments", "auth", "mobile"). Omit if unclear.

Return JSON exactly: {"doc_kind":"...","topics":["..."],"area":"..."}`;

export const SOURCE_CLASSIFIER_AGENT: Agent<SourceClassifierPayload, SourceClassifierOutput> = {
  name: 'sourceClassifier',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['doc_kind', 'topics'],
    properties: {
      doc_kind: { enum: DOC_KINDS as unknown as string[] },
      topics: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 8 },
      area: { type: 'string', maxLength: 60 },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<SourceClassifierPayload>): ChatMessage[] {
    const ctx = input.payload.context ? `PROJECT CONTEXT:\n${input.payload.context}\n\n` : '';
    const body = clamp(input.payload.text, 5000);
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          ctx +
          `SOURCE PATH: ${input.payload.sourcePath}\n` +
          `--- begin content ---\n${body}\n--- end content ---\n\nReturn JSON only.`,
      },
    ];
  },
  postprocess(o: SourceClassifierOutput) {
    const doc_kind = (DOC_KINDS as string[]).includes(o.doc_kind) ? o.doc_kind : 'notes';
    const topics = (o.topics ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 8);
    const area = o.area?.trim() || undefined;
    return { output: { doc_kind, topics, area }, confidence: 0.7 };
  },
};

registerAgent(SOURCE_CLASSIFIER_AGENT);

function clamp(s: string, n: number): string {
  if (s.length <= n) return s;
  const half = Math.floor((n - 32) / 2);
  return s.slice(0, half) + `\n\n...[trimmed]...\n\n` + s.slice(s.length - half);
}
