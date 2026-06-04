/**
 * Incident / RCA Agent.
 *
 * Runs on bug-fix conversations and extracts structured root-cause chains:
 * the problem (symptom), its root cause, and the resolution. The pipeline
 * persists these as linked k_nodes (`incident -caused_by-> root_cause`,
 * `solution -resolves-> incident`) so the KB can answer "why did X break and
 * how was it fixed?".
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

export interface IncidentPayload {
  text: string;
  windowId: string;
  context?: string;
}

export interface IncidentItem {
  problem: string;
  root_cause: string;
  resolution?: string;
  evidence: string;
}

export interface IncidentOutput {
  incidents: IncidentItem[];
}

const SYSTEM = `You analyze a debugging / bug-fix conversation and extract ROOT-CAUSE chains.
For each distinct problem solved in the exchange, capture:
  - problem:    the symptom or failure observed (one sentence).
  - root_cause: the underlying cause that actually produced it (not the symptom).
  - resolution: what fixed it (omit if the conversation didn't resolve it).
  - evidence:   the smallest verbatim quote that supports the chain.

Rules:
  - Only extract chains the conversation actually demonstrates. Never guess a cause.
  - root_cause must be the real cause, distinct from the symptom.
  - If no genuine bug/root-cause is present, return {"incidents": []}.

Return STRICT JSON: {"incidents":[{"problem":"...","root_cause":"...","resolution":"...","evidence":"..."}]}`;

export const INCIDENT_AGENT: Agent<IncidentPayload, IncidentOutput> = {
  name: 'incident',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['incidents'],
    properties: {
      incidents: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          required: ['problem', 'root_cause', 'evidence'],
          properties: {
            problem: { type: 'string', minLength: 1, maxLength: 200 },
            root_cause: { type: 'string', minLength: 1, maxLength: 300 },
            resolution: { type: 'string', maxLength: 300 },
            evidence: { type: 'string', minLength: 1, maxLength: 600 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<IncidentPayload>): ChatMessage[] {
    const ctx = input.payload.context ? `PROJECT CONTEXT:\n${input.payload.context}\n\n` : '';
    const body = clamp(input.payload.text, 6000);
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: ctx + `--- begin window ---\n${body}\n--- end window ---\n\nReturn JSON only.`,
      },
    ];
  },
  postprocess(o: IncidentOutput) {
    const incidents = (o.incidents ?? []).filter(
      (i) => i.problem?.trim() && i.root_cause?.trim() && i.evidence?.trim() &&
        i.problem.trim().toLowerCase() !== i.root_cause.trim().toLowerCase(),
    );
    return { output: { incidents }, confidence: incidents.length ? 0.7 : 0 };
  },
};

registerAgent(INCIDENT_AGENT);

function clamp(s: string, n: number): string {
  if (s.length <= n) return s;
  const half = Math.floor((n - 32) / 2);
  return s.slice(0, half) + `\n\n...[trimmed]...\n\n` + s.slice(s.length - half);
}
