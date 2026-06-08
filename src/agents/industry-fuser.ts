/**
 * IndustryFuser — single flash-first call replacing industryClassifier,
 * industryEnricher, technicalProfiler, and architectureModeler in standard profile.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';

const SKILL_KINDS = ['language', 'framework', 'library', 'infra', 'pattern'] as const;
const RELATION_KINDS = ['part_of', 'depends_on', 'owned_by', 'governed_by'] as const;

export interface IndustryFuserPayload {
  corePack: string;
  readmeExcerpt?: string;
  projectName?: string;
  languages: Array<{ name: string; files: number }>;
  dependencyHistogram: Array<{ name: string; count: number }>;
  tools: string[];
  symbols: string[];
  entities: string[];
  directories: Array<{ path: string; layer: string }>;
  architectureFacts: Array<{ kind: string; title: string; summary?: string }>;
}

export interface IndustryFuserOutput {
  industry: string;
  confidence: number;
  domains: string[];
  evidence: string;
  skills: Array<{ name: string; kind: string; evidence: string }>;
  components: Array<{ name: string; layer?: string; summary?: string; evidence: string }>;
  relations: Array<{ from: string; to: string; kind: string; evidence: string }>;
  glossary: Array<{ title: string; description: string; basis: string }>;
}

const SYSTEM = `You classify industry context and fuse technical architecture from packaged evidence.
Return STRICT JSON only.

{
  "industry", "confidence", "domains", "evidence",
  "skills": [{ "name", "kind", "evidence" }],
  "components": [{ "name", "layer", "summary", "evidence" }],
  "relations": [{ "from", "to", "kind", "evidence" }],
  "glossary": [{ "title", "description", "basis" }]
}

Rules:
- industry: concise label from README/deps/symbols/entities; use "unknown" only if no signal.
- skills: kind ∈ language|framework|library|infra|pattern; evidence MUST be verbatim from languages/deps/tools.
- components/relations: name structural parts; relations kind ∈ part_of|depends_on|owned_by|governed_by.
- glossary: industry-standard terms for the classified industry; basis cites why the term applies.
- Never invent dependencies, languages, or tools not in the inputs.
- Omit unsupported items. Return empty arrays / "unknown" when appropriate.

Return JSON only. No prose, no fences.`;

export const INDUSTRY_FUSER_AGENT: Agent<IndustryFuserPayload, IndustryFuserOutput> = {
  name: 'industryFuser',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['industry', 'confidence', 'domains', 'evidence', 'skills', 'components', 'relations', 'glossary'],
    properties: {
      industry: { type: 'string', maxLength: 120 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      domains: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      evidence: { type: 'string', maxLength: 800 },
      skills: {
        type: 'array', maxItems: 30,
        items: {
          type: 'object',
          required: ['name', 'kind', 'evidence'],
          properties: {
            name: { type: 'string' }, kind: { enum: SKILL_KINDS as unknown as string[] },
            evidence: { type: 'string', maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
      components: {
        type: 'array', maxItems: 25,
        items: {
          type: 'object',
          required: ['name', 'evidence'],
          properties: {
            name: { type: 'string' }, layer: { type: 'string' },
            summary: { type: 'string', maxLength: 300 }, evidence: { type: 'string', maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
      relations: {
        type: 'array', maxItems: 30,
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
      glossary: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object',
          required: ['title', 'description', 'basis'],
          properties: {
            title: { type: 'string' }, description: { type: 'string', maxLength: 400 },
            basis: { type: 'string', maxLength: 300 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<IndustryFuserPayload>): ChatMessage[] {
    const p = input.payload;
    const langs = p.languages.map((l) => `${l.name} (${l.files})`).join(', ') || '(none)';
    const deps = p.dependencyHistogram.map((d) => `${d.name}×${d.count}`).join(', ') || '(none)';
    const dirs = p.directories.map((d) => `${d.path} [${d.layer}]`).join(', ') || '(none)';
    const facts = p.architectureFacts.map((f) => `[${f.kind}] ${f.title}`).join('; ') || '(none)';
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `CORE PACK:\n${p.corePack}\n` +
          (p.projectName ? `PROJECT: ${p.projectName}\n` : '') +
          (p.readmeExcerpt ? `README:\n${p.readmeExcerpt.slice(0, 1200)}\n` : '') +
          `LANGUAGES: ${langs}\n` +
          `DEPENDENCIES: ${deps}\n` +
          `TOOLS: ${p.tools.join(', ') || '(none)'}\n` +
          `SYMBOLS: ${p.symbols.slice(0, 80).join(', ') || '(none)'}\n` +
          `ENTITIES: ${p.entities.slice(0, 60).join(', ') || '(none)'}\n` +
          `DIRECTORIES: ${dirs}\n` +
          `ARCHITECTURE FACTS: ${facts}\n\nReturn JSON only.`,
      },
    ];
  },
  postprocess(o: IndustryFuserOutput, input) {
    const allowed = new Set<string>();
    for (const l of input.payload.languages) allowed.add(l.name.toLowerCase());
    for (const d of input.payload.dependencyHistogram) allowed.add(d.name.toLowerCase());
    for (const t of input.payload.tools) allowed.add(t.toLowerCase());
    const compNames = new Set<string>();
    const components = (o.components ?? []).filter((c) => {
      if (!c.name?.trim() || !c.evidence?.trim()) return false;
      compNames.add(c.name.toLowerCase());
      return true;
    });
    for (const e of input.payload.entities) compNames.add(e.toLowerCase());
    const relKinds = new Set(RELATION_KINDS);
    const output = {
      industry: o.industry?.trim() || 'unknown',
      confidence: Math.min(1, Math.max(0, o.confidence ?? 0)),
      domains: (o.domains ?? []).filter(Boolean).slice(0, 8),
      evidence: o.evidence?.trim() ?? '',
      skills: (o.skills ?? []).filter(
        (s) => s.name?.trim() && s.evidence?.trim() && allowed.has(s.evidence.toLowerCase()),
      ),
      components,
      relations: (o.relations ?? []).filter(
        (r) => r.from?.trim() && r.to?.trim() && r.evidence?.trim() &&
          compNames.has(r.from.toLowerCase()) && compNames.has(r.to.toLowerCase()) &&
          relKinds.has(r.kind as typeof RELATION_KINDS[number]),
      ),
      glossary: (o.glossary ?? []).filter((g) => g.title?.trim() && g.description?.trim()),
    };
    return { output, confidence: output.confidence };
  },
};

registerAgent(INDUSTRY_FUSER_AGENT);
