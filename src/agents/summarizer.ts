/**
 * Summarizer Agent.
 *
 * Given the member facts of a cluster, produces a canonical concept name + a
 * short structured summary suitable for the subnet_explain MCP tool.
 *
 * The summary follows a light "systematic thinking" shape:
 *   problem | constraints | options | decision | consequences | open_questions
 * Any field may be empty when no member fact supports it.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

export interface SummarizerPayload {
  conceptId: string;
  currentName?: string;
  facts: Array<{ kind: string; title: string; summary?: string }>;
}

export interface SummarizerOutput {
  name: string;
  summary: string;
  structured: {
    problem?: string;
    constraints?: string;
    options?: string;
    decision?: string;
    consequences?: string;
    open_questions?: string;
  };
  domain?: string;
}

const SYSTEM = `You are a concept summarizer. Given the member facts of one cluster, produce:
  - name: a short noun phrase (3-6 words). Prefer domain language over implementation jargon.
  - summary: 2-3 sentence digest of what the cluster is about.
  - structured: optional sub-fields in a "systematic thinking" shape — only
    populate those that are clearly supported by the member facts:
      problem, constraints, options, decision, consequences, open_questions.
  - domain (optional): one of business_logic | architecture | implementation
    | debugging | devops | meta_process | chitchat (only if obvious).

Return STRICT JSON. No prose, no fences.`;

export const SUMMARIZER_AGENT: Agent<SummarizerPayload, SummarizerOutput> = {
  name: 'summarizer',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['name', 'summary', 'structured'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      summary: { type: 'string', minLength: 1, maxLength: 800 },
      // Sub-fields are coerced to strings in postprocess, so the schema stays
      // permissive: models sometimes return an array/object (e.g. options as a
      // list). Accepting those here avoids a hard validation failure.
      structured: {
        type: 'object',
        additionalProperties: true,
      },
      domain: { type: 'string' },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<SummarizerPayload>): ChatMessage[] {
    const { currentName, facts } = input.payload;
    const facts_text = facts
      .slice(0, 25)
      .map((f, i) => `  ${i + 1}. [${f.kind}] ${f.title}${f.summary ? `\n     ${f.summary}` : ''}`)
      .join('\n');
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          (currentName ? `Current name: "${currentName}"\n\n` : '') +
          `MEMBER FACTS:\n${facts_text}\n\nReturn JSON only.`,
      },
    ];
  },
  postprocess(o: SummarizerOutput) {
    // Coerce structured sub-fields to bounded strings; models occasionally
    // return arrays/objects for fields like `options`.
    const raw = (o.structured ?? {}) as Record<string, unknown>;
    const KEYS = ['problem', 'constraints', 'options', 'decision', 'consequences', 'open_questions'] as const;
    const structured: SummarizerOutput['structured'] = {};
    for (const k of KEYS) {
      const v = raw[k];
      const s = coerceToString(v);
      if (s) structured[k] = s.slice(0, 400);
    }
    return { output: { ...o, structured }, confidence: 0.7 };
  },
};

/** Flatten a value to a readable string (arrays -> "; "-joined, objects -> JSON). */
function coerceToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(coerceToString).filter(Boolean).join('; ');
  try { return JSON.stringify(v); } catch { return ''; }
}

registerAgent(SUMMARIZER_AGENT);
