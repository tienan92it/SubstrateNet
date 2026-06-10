/**
 * KnowledgeOrganizer Agent — the PARA organization layer.
 *
 * Reads the aggregated cross-project second brain (projects with activity
 * stats, weighted skills, business/tech domains, recurring concepts) and
 * reorganizes it by ACTIONABILITY (PARA) crossed with topic clustering:
 *   - PROJECTS — classifies each supplied project as active or archived from its
 *     activity, and writes a one-line focus + the topics it touches,
 *   - AREAS — ongoing competencies grouped from the skills/domains, each with a
 *     Dreyfus proficiency level and the projects/domains that evidence it,
 *   - SUBJECTS → TOPICS — clusters skills, concepts, and domains into a unified,
 *     deduped taxonomy of the fields you work in (the Resources library).
 *
 * It is an organizer, not an inventor: it may only place SUPPLIED items, it
 * clusters/dedupes rather than fabricates, judges project activity from the
 * supplied dates (no fixed threshold), and everything it emits is inference
 * (`model` grounding). A data-driven fallback (see organize.ts) fills the same
 * shape when no LLM backend is available.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

export interface OrgProjectInput {
  id: string;
  name: string;
  /** Days since the most recent session, or null if never seen. */
  idleDays: number | null;
  recentSessions: number;
  totalSessions: number;
  industries: string[];
  domains: string[];
}
export interface OrgSkillInput {
  name: string; weight: number; grounding: string; projectCount: number; kind?: string;
}
export interface OrgDomainInput { name: string; summary?: string; kind: 'business' | 'tech' }

export interface KnowledgeOrganizerPayload {
  projects: OrgProjectInput[];
  skills: OrgSkillInput[];
  domains: OrgDomainInput[];
  concepts: Array<{ name: string; summary?: string }>;
}

export interface OrgProjectOut {
  id: string;
  status: string;            // 'active' | 'archived'
  focus?: string;
  topics?: string[];
}
export interface OrgAreaOut {
  name: string;
  level: string;             // Dreyfus tier
  summary?: string;
  skills?: string[];
  projects?: string[];
  domains?: string[];
}
export interface OrgTopicOut {
  name: string;
  summary?: string;
  items?: Array<{ kind: string; name: string }>;
}
export interface OrgSubjectOut {
  name: string;
  summary?: string;
  topics: OrgTopicOut[];
}
export interface KnowledgeOrganizerOutput {
  projects: OrgProjectOut[];
  areas: OrgAreaOut[];
  subjects: OrgSubjectOut[];
}

const SYSTEM = `You organize a developer's cross-project "second brain" using the PARA method
(organize by ACTIONABILITY, not academic subject) crossed with topic clustering. You are given
their projects (each with activity stats), weighted technical skills, business/tech domains, and
recurring concepts.

Produce STRICT JSON with EXACTLY this shape:
{
  "projects": [ { "id": "<verbatim id>", "status": "active" | "archived", "focus": "<one line>", "topics": ["..."] } ],
  "areas":    [ { "name": "...", "level": "...", "summary": "...", "skills": ["..."], "projects": ["..."], "domains": ["..."] } ],
  "subjects": [ { "name": "...", "summary": "...", "topics": [ { "name": "...", "summary": "...", "items": [ { "kind": "skill|concept|domain", "name": "..." } ] } ] } ]
}

Rules:
- PROJECTS (actionability): for every supplied project, echo its "id" VERBATIM and set "status".
  Judge "active" vs "archived" from the activity stats (idleDays, recentSessions) — there is no
  fixed threshold; reason about it. Write a one-line "focus" (what the project is about) and list
  the "topics" it touches, drawn from the subjects/topics you create below.
- AREAS (ongoing competencies you maintain): group the supplied SKILLS and DOMAINS into 5-8
  coherent areas of responsibility (e.g. "Backend & APIs", "Data & Analytics", "AI/ML & Agents",
  "Infrastructure & DevOps", "Frontend & UX", "Security", "Architecture & Systems Design"). Every
  skill you place MUST come from the supplied SKILLS list. Assign each area a Dreyfus LEVEL, one of
  exactly: novice | advanced_beginner | competent | proficient | expert — inferred from evidence
  weight, project spread, and grounding. List the projects and domains that evidence each area.
- SUBJECTS → TOPICS (the Resources library): cluster the supplied skills, concepts, and domains
  into a shallow taxonomy — 4-8 SUBJECTS (broad fields), each with 2-6 TOPICS, each topic listing
  its member ITEMS. Unify and DEDUPLICATE near-identical items across projects. Only use supplied
  items; never invent skills, concepts, or domains. Keep it shallow (subject → topic → item).
- GROUNDING: everything is inference over the supplied data. Place every item somewhere; do not
  drop supplied skills/concepts on the floor.

Return JSON only (a single object). No prose outside the JSON, no code fences.`;

function fmtProjects(projects: OrgProjectInput[]): string {
  if (projects.length === 0) return '  (none)';
  return projects.slice(0, 60).map((p) =>
    `  - id=${p.id} "${p.name}" [idleDays=${p.idleDays ?? 'never'}, recent=${p.recentSessions}, total=${p.totalSessions}` +
    `${p.industries.length ? `, industries: ${p.industries.join('/')}` : ''}` +
    `${p.domains.length ? `, domains: ${p.domains.slice(0, 8).join('/')}` : ''}]`,
  ).join('\n');
}
function fmtSkills(skills: OrgSkillInput[]): string {
  if (skills.length === 0) return '  (none)';
  return skills.slice(0, 80)
    .map((s) => `  - ${s.name} [${s.grounding}, w=${s.weight.toFixed(1)}, x${s.projectCount}${s.kind ? `, ${s.kind}` : ''}]`)
    .join('\n');
}

export const KNOWLEDGE_ORGANIZER_AGENT: Agent<KnowledgeOrganizerPayload, KnowledgeOrganizerOutput> = {
  name: 'knowledgeOrganizer',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['areas', 'subjects'],
    properties: {
      projects: {
        type: 'array', maxItems: 200,
        items: {
          type: 'object',
          required: ['id', 'status'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            status: { type: 'string', maxLength: 20 },
            focus: { type: 'string', maxLength: 400 },
            topics: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 20 },
          },
          additionalProperties: true,
        },
      },
      areas: {
        type: 'array', maxItems: 12,
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            level: { type: 'string', maxLength: 40 },
            summary: { type: 'string', maxLength: 600 },
            skills: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 50 },
            projects: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 50 },
            domains: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 50 },
          },
          additionalProperties: true,
        },
      },
      subjects: {
        type: 'array', maxItems: 12,
        items: {
          type: 'object',
          required: ['name', 'topics'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            summary: { type: 'string', maxLength: 600 },
            topics: {
              type: 'array', maxItems: 20,
              items: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 160 },
                  summary: { type: 'string', maxLength: 600 },
                  items: {
                    type: 'array', maxItems: 60,
                    items: {
                      type: 'object',
                      required: ['name'],
                      properties: {
                        kind: { type: 'string', maxLength: 40 },
                        name: { type: 'string', maxLength: 200 },
                      },
                      additionalProperties: true,
                    },
                  },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<KnowledgeOrganizerPayload>): ChatMessage[] {
    const p = input.payload;
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `PROJECTS (with activity):\n${fmtProjects(p.projects)}\n\n` +
          `SKILLS:\n${fmtSkills(p.skills)}\n\n` +
          `DOMAINS:\n${p.domains.slice(0, 40).map((d) => `  - [${d.kind}] ${d.name}${d.summary ? ` — ${d.summary}` : ''}`).join('\n') || '  (none)'}\n\n` +
          `CONCEPTS:\n${p.concepts.slice(0, 60).map((c) => `  - ${c.name}${c.summary ? ` — ${c.summary}` : ''}`).join('\n') || '  (none)'}\n\n` +
          `Return JSON only.`,
      },
    ];
  },
  postprocess(o: KnowledgeOrganizerOutput, _input) {
    const out: KnowledgeOrganizerOutput = {
      projects: Array.isArray(o.projects) ? o.projects : [],
      areas: Array.isArray(o.areas) ? o.areas : [],
      subjects: Array.isArray(o.subjects) ? o.subjects : [],
    };
    const confidence = out.areas.length > 0 && out.subjects.length > 0 ? 0.8 : 0;
    return { output: out, confidence };
  },
};

registerAgent(KNOWLEDGE_ORGANIZER_AGENT);
