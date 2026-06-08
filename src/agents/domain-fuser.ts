/**
 * DomainFuser — single flash-first call replacing domainModeler, domainAnalyzer,
 * businessDomainModeler, and techDomainModeler in the standard enrich profile.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

const RELATION_KINDS = ['relates_to', 'owned_by', 'part_of', 'depends_on'] as const;

export interface DomainFuserConcept {
  name: string;
  summary?: string;
  memberCount: number;
}

export interface DomainFuserEntity {
  id: string;
  title: string;
  summary?: string;
}

export interface DomainFuserPayload {
  corePack: string;
  concepts: DomainFuserConcept[];
  entities: DomainFuserEntity[];
  businessItems: Array<{ kind: string; title: string; summary?: string }>;
  techItems: Array<{ kind: string; title: string; summary?: string }>;
  layers?: string[];
}

export interface DomainFuserOutput {
  relationships: Array<{ from: string; to: string; kind: string; evidence: string }>;
  gaps: Array<{ title: string; why: string; evidence: string }>;
  highlights: Array<{ statement: string; evidence: string }>;
  businessDomains: Array<{ name: string; summary?: string; members: string[] }>;
  techDomains: Array<{ name: string; summary?: string; members: string[] }>;
}

const SYSTEM = `You fuse domain knowledge from packaged project evidence into STRICT JSON.
You do NOT invent facts. Every relationship, gap, highlight, and domain assignment
must cite verbatim evidence from the inputs.

Return JSON:
{
  "relationships": [{ "from", "to", "kind", "evidence" }],
  "gaps": [{ "title", "why", "evidence" }],
  "highlights": [{ "statement", "evidence" }],
  "businessDomains": [{ "name", "summary", "members" }],
  "techDomains": [{ "name", "summary", "members" }]
}

Rules:
- relationships: from/to MUST be exact entity titles from ENTITIES. kind ∈ relates_to|owned_by|part_of|depends_on.
- gaps: open questions revealed by evidence, not answers.
- highlights: portfolio-level statements grounded in concepts + entities.
- businessDomains: group BUSINESS ITEMS into bounded contexts; members = exact titles from BUSINESS ITEMS.
- techDomains: group TECH ITEMS into capabilities; members = exact titles from TECH ITEMS.
- Omit any item without evidence. Return empty arrays when unsupported.

Return JSON only. No prose, no fences.`;

export const DOMAIN_FUSER_AGENT: Agent<DomainFuserPayload, DomainFuserOutput> = {
  name: 'domainFuser',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['relationships', 'gaps', 'highlights', 'businessDomains', 'techDomains'],
    properties: {
      relationships: {
        type: 'array', maxItems: 40,
        items: {
          type: 'object',
          required: ['from', 'to', 'kind', 'evidence'],
          properties: {
            from: { type: 'string' }, to: { type: 'string' },
            kind: { enum: RELATION_KINDS as unknown as string[] },
            evidence: { type: 'string', maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
      gaps: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object',
          required: ['title', 'why', 'evidence'],
          properties: {
            title: { type: 'string' }, why: { type: 'string' }, evidence: { type: 'string', maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
      highlights: {
        type: 'array', maxItems: 15,
        items: {
          type: 'object',
          required: ['statement', 'evidence'],
          properties: {
            statement: { type: 'string', maxLength: 300 }, evidence: { type: 'string', maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
      businessDomains: {
        type: 'array', maxItems: 12,
        items: {
          type: 'object',
          required: ['name', 'members'],
          properties: {
            name: { type: 'string' }, summary: { type: 'string', maxLength: 400 },
            members: { type: 'array', items: { type: 'string' }, maxItems: 40 },
          },
          additionalProperties: false,
        },
      },
      techDomains: {
        type: 'array', maxItems: 12,
        items: {
          type: 'object',
          required: ['name', 'members'],
          properties: {
            name: { type: 'string' }, summary: { type: 'string', maxLength: 400 },
            members: { type: 'array', items: { type: 'string' }, maxItems: 40 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<DomainFuserPayload>): ChatMessage[] {
    const p = input.payload;
    const concepts = p.concepts.length
      ? p.concepts.map((c) => `  - ${c.name} (${c.memberCount} facts)${c.summary ? `: ${c.summary}` : ''}`).join('\n')
      : '  (none)';
    const entities = p.entities.map((e) => `  - ${e.title}${e.summary ? `: ${e.summary}` : ''}`).join('\n') || '  (none)';
    const biz = p.businessItems.map((i) => `  - [${i.kind}] ${i.title}`).join('\n') || '  (none)';
    const tech = p.techItems.map((i) => `  - [${i.kind}] ${i.title}`).join('\n') || '  (none)';
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `CORE PACK:\n${p.corePack}\n\n` +
          `CONCEPTS:\n${concepts}\n\n` +
          `ENTITIES:\n${entities}\n\n` +
          `BUSINESS ITEMS:\n${biz}\n\n` +
          `TECH ITEMS:\n${tech}\n` +
          (p.layers?.length ? `\nLAYERS: ${p.layers.join(', ')}\n` : '') +
          '\nReturn JSON only.',
      },
    ];
  },
  postprocess(o: DomainFuserOutput, input) {
    const entityTitles = new Set(input.payload.entities.map((e) => e.title.toLowerCase()));
    const bizTitles = new Set(input.payload.businessItems.map((i) => i.title.toLowerCase()));
    const techTitles = new Set(input.payload.techItems.map((i) => i.title.toLowerCase()));
    const relKinds = new Set(RELATION_KINDS);
    const output = {
      relationships: (o.relationships ?? []).filter(
        (r) => r.from?.trim() && r.to?.trim() && r.evidence?.trim() &&
          entityTitles.has(r.from.toLowerCase()) && entityTitles.has(r.to.toLowerCase()) &&
          relKinds.has(r.kind as typeof RELATION_KINDS[number]),
      ),
      gaps: (o.gaps ?? []).filter((g) => g.title?.trim() && g.evidence?.trim()),
      highlights: (o.highlights ?? []).filter((h) => h.statement?.trim() && h.evidence?.trim()),
      businessDomains: (o.businessDomains ?? []).filter((d) => d.name?.trim()).map((d) => ({
        ...d,
        members: (d.members ?? []).filter((m) => bizTitles.has(m.toLowerCase())),
      })),
      techDomains: (o.techDomains ?? []).filter((d) => d.name?.trim()).map((d) => ({
        ...d,
        members: (d.members ?? []).filter((m) => techTitles.has(m.toLowerCase())),
      })),
    };
    return { output, confidence: 0.75 };
  },
};

registerAgent(DOMAIN_FUSER_AGENT);
