/**
 * ArchitectureModeler Agent (L2.5).
 *
 * Produces a high-level system view from grounded signals: the architectural
 * layer map, directory structure, existing entities, and architecture/decision
 * facts. It names the system's COMPONENTS (services / modules / bounded
 * contexts), how they relate (part_of / depends_on / owned_by / governed_by),
 * and any entity LIFECYCLES the evidence describes (states + transitions).
 *
 * Like DomainModeler, it never invents: every relationship and lifecycle must
 * quote supporting evidence, and the postprocess drops anything unsupported.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

const RELATION_KINDS = ['part_of', 'depends_on', 'owned_by', 'governed_by'] as const;
type RelationKind = (typeof RELATION_KINDS)[number];

export interface ArchitectureComponent {
  name: string;
  summary?: string;
  layer?: string;
  evidence?: string;
}
export interface ArchitectureRelation {
  from: string;
  to: string;
  kind: RelationKind;
  evidence: string;
}
export interface ArchitectureLifecycle {
  entity: string;
  states: string[];
  evidence: string;
}

export interface ArchitectureModelerPayload {
  layers: string[];
  directories: Array<{ path: string; layer: string }>;
  entities: string[];
  facts: Array<{ kind: string; title: string; summary?: string; evidence?: string }>;
}

export interface ArchitectureModelerOutput {
  components: ArchitectureComponent[];
  relations: ArchitectureRelation[];
  lifecycles: ArchitectureLifecycle[];
}

const SYSTEM = `You model the HIGH-LEVEL ARCHITECTURE of a software system from grounded signals.
You do not invent. You name structure that the evidence supports.

You are given:
  - LAYERS: architectural layers present (api/service/data/ui/utility).
  - DIRECTORIES: top directories with their dominant layer.
  - ENTITIES: domain objects already extracted.
  - FACTS: architecture/decision statements (your evidence source).

Produce STRICT JSON with three arrays:

"components" — the major building blocks (services, modules, bounded contexts,
  subsystems). Use names a senior engineer would recognize from the directories
  and facts. Each: { name, summary, layer (optional), evidence (optional quote) }.
  Prefer 4-12 meaningful components over many tiny ones.

"relations" — links BETWEEN components (by exact component name) OR between a
  component and an ENTITY. kind ∈ part_of | depends_on | owned_by | governed_by.
  Every relation MUST include "evidence": a short verbatim quote that supports it.

"lifecycles" — for an ENTITY whose states the facts describe:
  { entity (exact entity name), states: [ordered state names], evidence (quote) }.
  Only when the states are explicitly stated. Omit otherwise.

Hard rules:
  - Never invent a component attribute, relation, or state without evidence.
  - relations.from/to and lifecycles.entity reference names you listed or were given.
  - If nothing is supported, return {"components": [], "relations": [], "lifecycles": []}.

Return JSON only. No prose, no fences.`;

export const ARCHITECTURE_MODELER_AGENT: Agent<ArchitectureModelerPayload, ArchitectureModelerOutput> = {
  name: 'architectureModeler',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['components', 'relations', 'lifecycles'],
    properties: {
      components: {
        type: 'array', maxItems: 24,
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            summary: { type: 'string', maxLength: 600 },
            layer: { type: 'string', maxLength: 40 },
            evidence: { type: 'string', maxLength: 600 },
          },
          additionalProperties: false,
        },
      },
      relations: {
        type: 'array', maxItems: 60,
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
      lifecycles: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object',
          required: ['entity', 'states', 'evidence'],
          properties: {
            entity: { type: 'string', minLength: 1 },
            states: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, minItems: 2, maxItems: 12 },
            evidence: { type: 'string', minLength: 1, maxLength: 600 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<ArchitectureModelerPayload>): ChatMessage[] {
    const { layers, directories, entities, facts } = input.payload;
    const layerList = layers.length ? layers.join(', ') : '(none)';
    const dirList = directories.length
      ? directories.map((d) => `  ${d.path} [${d.layer}]`).join('\n')
      : '  (none)';
    const entityList = entities.length
      ? entities.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
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
          `LAYERS: ${layerList}\n\nDIRECTORIES:\n${dirList}\n\n` +
          `ENTITIES:\n${entityList}\n\nFACTS:\n${factList}\n\nReturn JSON only.`,
      },
    ];
  },
  postprocess(o: ArchitectureModelerOutput, _input) {
    const components = (o.components ?? []).filter((c) => c.name?.trim());
    const relations = (o.relations ?? []).filter(
      (r) => r.evidence?.trim() && r.from?.trim() && r.to?.trim() &&
        (RELATION_KINDS as readonly string[]).includes(r.kind) &&
        r.from.toLowerCase() !== r.to.toLowerCase(),
    );
    const lifecycles = (o.lifecycles ?? []).filter(
      (l) => l.entity?.trim() && l.evidence?.trim() && Array.isArray(l.states) && l.states.length >= 2,
    );
    const total = (o.components?.length ?? 0) + (o.relations?.length ?? 0) + (o.lifecycles?.length ?? 0);
    const kept = components.length + relations.length + lifecycles.length;
    const confidence = total === 0 ? 0 : kept / total;
    return { output: { components, relations, lifecycles }, confidence };
  },
};

registerAgent(ARCHITECTURE_MODELER_AGENT);
