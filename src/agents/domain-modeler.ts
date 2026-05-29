/**
 * DomainModeler Agent.
 *
 * Given a set of already-extracted domain facts (entities, business rules,
 * constraints) the agent does two grounded things:
 *
 *   1. Proposes relationships between entities that ALREADY EXIST in the input
 *      set. It may not invent entities. Every relationship must quote the
 *      verbatim evidence that supports it.
 *   2. Names knowledge gaps it can justify with a quote — open questions, never
 *      answers.
 *
 * The postprocess step drops any relationship whose endpoints aren't in the
 * provided entity list, and any item whose evidence is empty. This is the
 * enforcement of "based on facts, never assume": an unsupported claim is
 * discarded, not stored.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

/** Entity-to-entity relationship kinds the modeler is allowed to assert. */
const RELATION_KINDS = ['relates_to', 'owned_by', 'part_of', 'depends_on'] as const;
type RelationKind = (typeof RELATION_KINDS)[number];

export interface DomainModelerEntity {
  id: string;
  title: string;
  summary?: string;
}

export interface DomainModelerFact {
  kind: string;
  title: string;
  summary?: string;
  evidence?: string;
}

export interface DomainModelerPayload {
  conceptName?: string;
  entities: DomainModelerEntity[];
  facts: DomainModelerFact[];
}

export interface DomainModelerRelationship {
  from: string;          // entity title
  to: string;            // entity title
  kind: RelationKind;
  evidence: string;      // verbatim quote — required
}

export interface DomainModelerGap {
  title: string;
  why: string;
  evidence: string;      // verbatim quote — required
}

export interface DomainModelerOutput {
  relationships: DomainModelerRelationship[];
  gaps: DomainModelerGap[];
}

const SYSTEM = `You model a business domain from already-extracted facts. You do NOT invent
knowledge. You connect what exists and you name what is missing.

You are given:
  - ENTITIES: domain objects that already exist. You may only reference these by title.
  - FACTS: business rules, constraints, and entity descriptions (your evidence source).

Produce STRICT JSON with two arrays:

"relationships" — links between two ENTITIES that the facts SUPPORT.
  kind ∈ relates_to | owned_by | part_of | depends_on
  Every relationship MUST include "evidence": a short verbatim quote from the
  facts that states or clearly implies the link. No quote → do not emit it.
  from / to MUST be exact entity titles from the ENTITIES list.

"gaps" — open questions the facts REVEAL but do not answer.
  Example: a rule mentions "settlement window" but no entity or rule defines it.
  Every gap MUST include "evidence": the verbatim quote that exposes the gap.
  Never answer the gap. Only state what is missing and cite where it surfaced.

Hard rules:
  - Never invent an entity, attribute, relationship, or rule.
  - If a claim is not supported by a verbatim quote, omit it.
  - If nothing is supported, return {"relationships": [], "gaps": []}.

Return JSON only. No prose, no fences.`;

export const DOMAIN_MODELER_AGENT: Agent<DomainModelerPayload, DomainModelerOutput> = {
  name: 'domainModeler',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['relationships', 'gaps'],
    properties: {
      relationships: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          required: ['from', 'to', 'kind', 'evidence'],
          properties: {
            from: { type: 'string', minLength: 1 },
            to: { type: 'string', minLength: 1 },
            kind: { enum: RELATION_KINDS as unknown as string[] },
            evidence: { type: 'string', minLength: 1, maxLength: 600 },
          },
          additionalProperties: false,
        },
      },
      gaps: {
        type: 'array',
        maxItems: 25,
        items: {
          type: 'object',
          required: ['title', 'why', 'evidence'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            why: { type: 'string', minLength: 1, maxLength: 600 },
            evidence: { type: 'string', minLength: 1, maxLength: 600 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<DomainModelerPayload>): ChatMessage[] {
    const { conceptName, entities, facts } = input.payload;
    const entityList = entities.length
      ? entities.map((e, i) => `  ${i + 1}. ${e.title}${e.summary ? ` — ${e.summary}` : ''}`).join('\n')
      : '  (none)';
    const factList = facts.length
      ? facts.slice(0, 40).map((f, i) =>
          `  ${i + 1}. [${f.kind}] ${f.title}${f.summary ? `\n     ${f.summary}` : ''}${f.evidence ? `\n     evidence: "${f.evidence}"` : ''}`,
        ).join('\n')
      : '  (none)';
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          (conceptName ? `CONCEPT: ${conceptName}\n\n` : '') +
          `ENTITIES:\n${entityList}\n\nFACTS:\n${factList}\n\nReturn JSON only.`,
      },
    ];
  },
  postprocess(o: DomainModelerOutput, input) {
    const titles = new Set(input.payload.entities.map((e) => e.title.toLowerCase()));
    const relationships = (o.relationships ?? []).filter(
      (r) =>
        r.evidence?.trim() &&
        (RELATION_KINDS as readonly string[]).includes(r.kind) &&
        titles.has(r.from?.toLowerCase()) &&
        titles.has(r.to?.toLowerCase()) &&
        r.from.toLowerCase() !== r.to.toLowerCase(),
    );
    const gaps = (o.gaps ?? []).filter((g) => g.evidence?.trim() && g.title?.trim());
    const kept = relationships.length + gaps.length;
    const total = (o.relationships?.length ?? 0) + (o.gaps?.length ?? 0);
    const confidence = total === 0 ? 0 : kept / total;
    return { output: { relationships, gaps }, confidence };
  },
};

registerAgent(DOMAIN_MODELER_AGENT);
