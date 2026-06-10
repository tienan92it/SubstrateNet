/**
 * WisdomSynthesizer Agent — the top of the DIKW pyramid (L6).
 *
 * Reads the aggregated cross-project "second brain" (industries, weighted
 * skills, the organized competency AREAS, business/tech domains, recurring
 * concepts, portfolio highlights, and detected knowledge gaps) and synthesizes
 * the evaluated judgment on top of them:
 *   - a headline + short narrative (who this person is, where leverage is),
 *   - cross-project INSIGHTS / principles (the "so what"),
 *   - named knowledge GAPS with concrete recommendations.
 *
 * Competency grouping itself is owned by the KnowledgeOrganizer (PARA layer);
 * this agent references those areas rather than recomputing them. It is an
 * evaluator, not an inventor: it may only use the supplied inputs, and
 * everything it emits is inference (`model` grounding).
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

export interface WisdomSkillInput {
  name: string;
  weight: number;
  grounding: string;
  projectCount: number;
  kind?: string;
}
export interface WisdomDomainInput { name: string; summary?: string }
export interface WisdomAreaInput { name: string; level: string; summary?: string }

export interface WisdomSynthesizerPayload {
  projectCount: number;
  industries: Array<{ name: string; projectCount: number }>;
  skills: WisdomSkillInput[];
  /** Organized competency areas (from the KnowledgeOrganizer) for reference. */
  areas: WisdomAreaInput[];
  businessDomains: WisdomDomainInput[];
  techDomains: WisdomDomainInput[];
  concepts: Array<{ name: string; summary?: string }>;
  highlights: Array<{ statement: string; grounding: string }>;
  gaps: Array<{ title: string; summary?: string }>;
}

export interface WisdomInsight {
  title: string;
  body?: string;
  kind?: string;
  evidence?: string;
  confidence?: number;
}
export interface WisdomGapOut {
  title: string;
  summary?: string;
  recommendation?: string;
  area?: string;
  severity?: string;
}
export interface WisdomSynthesizerOutput {
  headline: string;
  narrative: string;
  insights: WisdomInsight[];
  gaps: WisdomGapOut[];
}

const SYSTEM = `You synthesize the WISDOM layer (the top of the DIKW pyramid) for a developer's
cross-project "second brain". You are given their aggregated knowledge base: industries,
weighted technical skills, their already-grouped competency AREAS (each with a proficiency level),
business/tech domains, recurring concepts, portfolio highlights, and detected knowledge gaps.

Produce STRICT JSON with EXACTLY this shape:
{
  "headline": "<1-2 sentence judgment: who this person is professionally and where their leverage is>",
  "narrative": "<2-4 sentence synthesis: themes across projects and what they consistently do well>",
  "insights": [ { "title": "...", "body": "...", "kind": "insight", "evidence": "...", "confidence": 0.0 } ],
  "gaps": [ { "title": "...", "summary": "...", "recommendation": "...", "area": "...", "severity": "medium" } ]
}

Rules:
- HEADLINE + NARRATIVE: a sharp, grounded read of this person, anchored in their strongest AREAS and
  the industries/domains they work in. No marketing language.
- INSIGHTS: 3-8 evaluated cross-project judgments or principles — the "so what". Patterns in HOW this
  person works, recurring strengths, or design principles evidenced by the data. "kind" is "insight"
  or "principle". Cite the evidence (areas/skills/domains/highlights) each rests on.
- GAPS: name 2-6 knowledge gaps that would most raise this person's wisdom if closed. Use the supplied
  GAPS plus areas that look thin given their industries/domains. Give each a concrete RECOMMENDATION and
  a "severity" of low|medium|high. Name the gap; do NOT fabricate the missing knowledge itself.
- Do NOT re-group competencies — reference the supplied AREAS by name. Everything you produce is
  inference. Use ONLY the supplied inputs; invent no employers, dates, titles, or technologies.

Return JSON only (a single object). No prose outside the JSON, no code fences.`;

function fmtSkills(skills: WisdomSkillInput[]): string {
  if (skills.length === 0) return '  (none)';
  return skills.slice(0, 60)
    .map((s) => `  - ${s.name} [${s.grounding}, w=${s.weight.toFixed(1)}, x${s.projectCount}${s.kind ? `, ${s.kind}` : ''}]`)
    .join('\n');
}
function fmtDomains(domains: WisdomDomainInput[]): string {
  if (domains.length === 0) return '  (none)';
  return domains.slice(0, 30).map((d) => `  - ${d.name}${d.summary ? ` — ${d.summary}` : ''}`).join('\n');
}
function fmtAreas(areas: WisdomAreaInput[]): string {
  if (areas.length === 0) return '  (none)';
  return areas.slice(0, 12).map((a) => `  - ${a.name} [${a.level}]${a.summary ? ` — ${a.summary}` : ''}`).join('\n');
}

export const WISDOM_SYNTHESIZER_AGENT: Agent<WisdomSynthesizerPayload, WisdomSynthesizerOutput> = {
  name: 'wisdomSynthesizer',
  promptVersion: 2,
  schema: {
    type: 'object',
    required: ['headline'],
    properties: {
      headline: { type: 'string', minLength: 1, maxLength: 600 },
      narrative: { type: 'string', maxLength: 2000 },
      insights: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 300 },
            body: { type: 'string', maxLength: 1200 },
            kind: { type: 'string', maxLength: 40 },
            evidence: { type: 'string', maxLength: 600 },
            confidence: { type: 'number' },
          },
          additionalProperties: true,
        },
      },
      gaps: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 300 },
            summary: { type: 'string', maxLength: 800 },
            recommendation: { type: 'string', maxLength: 800 },
            area: { type: 'string', maxLength: 120 },
            severity: { type: 'string', maxLength: 40 },
          },
          additionalProperties: true,
        },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<WisdomSynthesizerPayload>): ChatMessage[] {
    const p = input.payload;
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `PROJECTS: ${p.projectCount}\n` +
          `INDUSTRIES: ${p.industries.map((i) => `${i.name} (x${i.projectCount})`).join(', ') || '(none)'}\n` +
          `COMPETENCY AREAS:\n${fmtAreas(p.areas)}\n` +
          `SKILLS:\n${fmtSkills(p.skills)}\n` +
          `BUSINESS DOMAINS:\n${fmtDomains(p.businessDomains)}\n` +
          `TECH DOMAINS:\n${fmtDomains(p.techDomains)}\n` +
          `CONCEPTS:\n${p.concepts.slice(0, 40).map((c) => `  - ${c.name}${c.summary ? ` — ${c.summary}` : ''}`).join('\n') || '  (none)'}\n` +
          `HIGHLIGHTS:\n${p.highlights.slice(0, 20).map((h) => `  - ${h.statement} [${h.grounding}]`).join('\n') || '  (none)'}\n` +
          `GAPS (detected):\n${p.gaps.slice(0, 30).map((g) => `  - ${g.title}${g.summary ? ` — ${g.summary}` : ''}`).join('\n') || '  (none)'}\n\n` +
          `Return JSON only.`,
      },
    ];
  },
  postprocess(o: WisdomSynthesizerOutput, _input) {
    const out: WisdomSynthesizerOutput = {
      headline: (o.headline ?? '').trim(),
      narrative: (o.narrative ?? '').trim(),
      insights: Array.isArray(o.insights) ? o.insights : [],
      gaps: Array.isArray(o.gaps) ? o.gaps : [],
    };
    const confidence = out.headline ? 0.8 : 0;
    return { output: out, confidence };
  },
};

registerAgent(WISDOM_SYNTHESIZER_AGENT);
