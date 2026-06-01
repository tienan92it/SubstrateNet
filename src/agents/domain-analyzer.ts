/**
 * DomainAnalyzer Agent.
 *
 * Fuses the technical and industry scopes into composite portfolio statements —
 * the difference between "knows Go" and "built an event-driven Go backend for a
 * financial trading app". It is given the classified industry, the strongest
 * technical skills, the architectural layers present, and a few salient facts;
 * it returns evidence-cited highlights.
 *
 * Grounding discipline: each highlight MUST cite supplied evidence (a skill,
 * layer, industry, or fact). Postprocess drops any highlight whose `evidence`
 * does not reference a provided item — synthesis is allowed only on real ground.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

export interface DomainAnalyzerPayload {
  industry?: string;
  skills: string[];        // strongest technical skills (names)
  layers: string[];        // architectural layers present
  facts: string[];         // salient business rules / decisions (titles)
}

export interface DomainHighlight {
  statement: string;       // the composite portfolio claim
  evidence: string;        // verbatim skill/layer/industry/fact it rests on
}

export interface DomainAnalyzerOutput {
  highlights: DomainHighlight[];
}

const SYSTEM = `You write composite PORTFOLIO highlights that fuse technical skill with business domain.
Inputs: an industry label, technical skills, architectural layers present, and salient facts.

Produce STRICT JSON: { "highlights": [ { "statement", "evidence" } ] }.
  - statement: one concrete, resume-grade sentence combining WHAT was built (architecture/tech)
    with the DOMAIN it served. E.g. "Built an event-driven Go backend for a financial trading platform."
  - evidence: a verbatim item from the supplied skills / layers / industry / facts that supports it.

Hard rules:
  - Combine signals; do not restate a single skill ("knows Go") — that is not a highlight.
  - NEVER invent a technology, layer, or domain not present in the inputs.
  - "evidence" MUST quote a supplied item. If a statement is not backed, omit it.
  - 3-8 highlights max. If inputs are too thin to combine, return fewer (even zero).

Return JSON only. No prose, no fences.`;

export const DOMAIN_ANALYZER_AGENT: Agent<DomainAnalyzerPayload, DomainAnalyzerOutput> = {
  name: 'domainAnalyzer',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['highlights'],
    properties: {
      highlights: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          required: ['statement', 'evidence'],
          properties: {
            statement: { type: 'string', minLength: 1, maxLength: 300 },
            evidence: { type: 'string', minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<DomainAnalyzerPayload>): ChatMessage[] {
    const { industry, skills, layers, facts } = input.payload;
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `INDUSTRY: ${industry || '(unclassified)'}\n` +
          `SKILLS: ${skills.slice(0, 40).join(', ') || '(none)'}\n` +
          `LAYERS: ${layers.join(', ') || '(none)'}\n` +
          `FACTS:\n${facts.slice(0, 20).map((f) => `  - ${f}`).join('\n') || '  (none)'}\n\nReturn JSON only.`,
      },
    ];
  },
  postprocess(o: DomainAnalyzerOutput, input) {
    const allowed: string[] = [];
    if (input.payload.industry) allowed.push(input.payload.industry.toLowerCase());
    for (const s of input.payload.skills) allowed.push(s.toLowerCase());
    for (const l of input.payload.layers) allowed.push(l.toLowerCase());
    for (const f of input.payload.facts) allowed.push(f.toLowerCase());
    const highlights = (o.highlights ?? []).filter(
      (h) =>
        h.statement?.trim() && h.evidence?.trim() &&
        allowed.some((a) => h.evidence.toLowerCase().includes(a) || a.includes(h.evidence.toLowerCase())),
    );
    const total = o.highlights?.length ?? 0;
    return { output: { highlights }, confidence: total === 0 ? 0 : highlights.length / total };
  },
};

registerAgent(DOMAIN_ANALYZER_AGENT);
