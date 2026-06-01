/**
 * ProfileWriter Agent.
 *
 * Turns the global second brain (industries, weighted skills, portfolio
 * highlights) into portfolio/background prose. It is a writer, not an inventor:
 * it may only use the supplied highlights and skills, and it must respect the
 * grounding tier of each input.
 *
 * Grounding policy (enforced by the prompt):
 *   - structural / corroborated -> assert as demonstrated ("built", "shipped").
 *   - stated                    -> hedge ("worked with", "explored").
 *   - model / external          -> NEVER claimed as owned; these are not inputs here.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

export interface ProfileWriterPayload {
  projectCount: number;
  industries: Array<{ name: string; projectCount: number }>;
  skills: Array<{ name: string; grounding: string; projectCount: number }>;
  highlights: Array<{ statement: string; grounding: string }>;
}

export interface ProfileWriterOutput {
  markdown: string;
}

const SYSTEM = `You write a concise professional PORTFOLIO/background in Markdown from a developer's
aggregated knowledge graph: industries worked in, technical skills (each with a grounding
tier and how many projects evidence it), and composite highlights.

Produce STRICT JSON: { "markdown": "<the portfolio in Markdown>" }.

Structure the markdown as:
  # Professional profile
  - a 2-3 sentence summary
  ## Domains  (the industries)
  ## Core competencies  (the strongest skills, grouped sensibly)
  ## Selected highlights  (the composite statements, as bullets)

Grounding policy (STRICT — this is a factual document):
  - grounding "structural" or "corroborated" -> state as demonstrated ("built", "shipped", "designed").
  - grounding "stated" -> hedge ("worked with", "familiar with", "explored").
  - Use ONLY the supplied industries, skills, and highlights. Invent nothing — no employers,
    dates, titles, or technologies that are not in the inputs.
  - Prefer skills/highlights evidenced across more projects.

Return JSON only (a single object with a "markdown" string). No prose outside the JSON, no fences.`;

export const PROFILE_WRITER_AGENT: Agent<ProfileWriterPayload, ProfileWriterOutput> = {
  name: 'profileWriter',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['markdown'],
    properties: { markdown: { type: 'string', minLength: 1, maxLength: 8000 } },
    additionalProperties: false,
  },
  prompt(input: AgentInput<ProfileWriterPayload>): ChatMessage[] {
    const { projectCount, industries, skills, highlights } = input.payload;
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `PROJECTS: ${projectCount}\n` +
          `INDUSTRIES: ${industries.map((i) => `${i.name} (x${i.projectCount})`).join(', ') || '(none)'}\n` +
          `SKILLS:\n${skills.slice(0, 40).map((s) => `  - ${s.name} [${s.grounding}, x${s.projectCount}]`).join('\n') || '  (none)'}\n` +
          `HIGHLIGHTS:\n${highlights.slice(0, 20).map((h) => `  - ${h.statement} [${h.grounding}]`).join('\n') || '  (none)'}\n\n` +
          `Return JSON only.`,
      },
    ];
  },
  postprocess(o: ProfileWriterOutput, _input) {
    return { output: { markdown: (o.markdown ?? '').trim() }, confidence: o.markdown?.trim() ? 0.8 : 0 };
  },
};

registerAgent(PROFILE_WRITER_AGENT);
