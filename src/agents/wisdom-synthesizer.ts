/**
 * WisdomSynthesizer Agent — the top of the DIKW pyramid (L6).
 *
 * Reads the aggregated cross-project "second brain" (industries, weighted
 * skills, business/tech domains, recurring concepts, portfolio highlights, and
 * detected knowledge gaps) and synthesizes:
 *   - a headline judgment + short narrative (who this person is, where leverage is),
 *   - competency AREAS (SFIA-style grouping of the supplied skills, capped ~6-8)
 *     each with a Dreyfus proficiency LEVEL,
 *   - cross-project INSIGHTS / principles (the "so what"),
 *   - named knowledge GAPS with concrete recommendations.
 *
 * It is an evaluator, not an inventor: it may only use the supplied inputs, it
 * groups/dedupes rather than fabricates, and everything it emits is inference
 * (`model` grounding) — kept separate from project truth.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

export type ProficiencyLevel =
  | 'novice' | 'advanced_beginner' | 'competent' | 'proficient' | 'expert';

export interface WisdomSkillInput {
  name: string;
  weight: number;
  grounding: string;
  projectCount: number;
  kind?: string;
}
export interface WisdomDomainInput { name: string; summary?: string }

export interface WisdomSynthesizerPayload {
  projectCount: number;
  industries: Array<{ name: string; projectCount: number }>;
  skills: WisdomSkillInput[];
  businessDomains: WisdomDomainInput[];
  techDomains: WisdomDomainInput[];
  concepts: Array<{ name: string; summary?: string }>;
  highlights: Array<{ statement: string; grounding: string }>;
  gaps: Array<{ title: string; summary?: string }>;
}

export interface WisdomCompetency {
  area: string;
  category?: string;
  level: string;
  summary?: string;
  skills: string[];
  confidence?: number;
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
  competencies: WisdomCompetency[];
  insights: WisdomInsight[];
  gaps: WisdomGapOut[];
}

const SYSTEM = `You synthesize the WISDOM layer (the top of the DIKW pyramid) for a developer's
cross-project "second brain". You are given their aggregated knowledge base: industries,
weighted technical skills (each with a grounding tier and how many projects evidence it),
business/tech domains, recurring concepts, portfolio highlights, and detected knowledge gaps.

Produce STRICT JSON with EXACTLY this shape:
{
  "headline": "<1-2 sentence judgment: who this person is professionally and where their leverage is>",
  "narrative": "<2-4 sentence synthesis: themes across projects and what they consistently do well>",
  "competencies": [ { "area": "...", "category": "...", "level": "...", "summary": "...", "skills": ["..."], "confidence": 0.0 } ],
  "insights": [ { "title": "...", "body": "...", "kind": "insight", "evidence": "...", "confidence": 0.0 } ],
  "gaps": [ { "title": "...", "summary": "...", "recommendation": "...", "area": "...", "severity": "medium" } ]
}

Rules:
- COMPETENCIES: group the supplied skills into 6-8 coherent AREAS (e.g. "Backend & APIs",
  "Data & Analytics", "Infrastructure & DevOps", "Frontend & UX", "AI/ML & Agents",
  "Architecture & Systems Design", "Security", "Domain & Business"). Every skill you place MUST
  come from the supplied SKILLS list — do not invent skills. Deduplicate near-identical skills.
  Assign each area a proficiency LEVEL on the Dreyfus scale, one of exactly:
  novice | advanced_beginner | competent | proficient | expert — inferred from evidence weight,
  how many projects show it, and grounding (structural/corroborated outrank stated, which outranks model).
- INSIGHTS: 3-8 evaluated cross-project judgments or principles — the "so what". Patterns in HOW this
  person works, recurring strengths, or design principles evidenced by the data. "kind" is "insight"
  or "principle". Cite the evidence (skills/domains/highlights) each rests on.
- GAPS: name 2-6 knowledge gaps that would most raise this person's wisdom if closed. Use the supplied
  GAPS plus areas that look thin given their industries/domains. Give each a concrete RECOMMENDATION and
  a "severity" of low|medium|high. Name the gap; do NOT fabricate the missing knowledge itself.
- GROUNDING: everything you produce is inference. Never claim unproven facts as demonstrated. Prefer
  skills/highlights evidenced across more projects.
- Use ONLY the supplied inputs. Invent no employers, dates, titles, or technologies.

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

export const WISDOM_SYNTHESIZER_AGENT: Agent<WisdomSynthesizerPayload, WisdomSynthesizerOutput> = {
  name: 'wisdomSynthesizer',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['headline', 'competencies'],
    properties: {
      headline: { type: 'string', minLength: 1, maxLength: 600 },
      narrative: { type: 'string', maxLength: 2000 },
      competencies: {
        type: 'array', maxItems: 12,
        items: {
          type: 'object',
          required: ['area', 'skills'],
          properties: {
            area: { type: 'string', minLength: 1, maxLength: 120 },
            category: { type: 'string', maxLength: 120 },
            level: { type: 'string', maxLength: 40 },
            summary: { type: 'string', maxLength: 600 },
            skills: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 40 },
            confidence: { type: 'number' },
          },
          additionalProperties: true,
        },
      },
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
      competencies: Array.isArray(o.competencies) ? o.competencies : [],
      insights: Array.isArray(o.insights) ? o.insights : [],
      gaps: Array.isArray(o.gaps) ? o.gaps : [],
    };
    const confidence = out.headline && out.competencies.length > 0 ? 0.8 : 0;
    return { output: out, confidence };
  },
};

registerAgent(WISDOM_SYNTHESIZER_AGENT);
