/**
 * Shared scaffolding for the knowledge-zone modelers (BusinessDomainModeler,
 * TechDomainModeler). Both take a flat list of facts and group them into named
 * domains with member references — the organizing layer between raw facts and
 * the global hierarchy (industry > business domain > tech domain).
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';

export interface DomainGrouperItem {
  kind: string;
  title: string;
  summary?: string;
}

export interface DomainGrouperPayload {
  industry?: string;
  hint?: string;
  items: DomainGrouperItem[];
}

export interface DomainGroup {
  name: string;
  summary?: string;
  members: string[];   // item titles assigned to this domain
}

export interface DomainGrouperOutput {
  domains: DomainGroup[];
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['domains'],
  properties: {
    domains: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['name', 'members'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          summary: { type: 'string', maxLength: 400 },
          members: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 40 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export interface DefineDomainGrouperOpts {
  name: string;
  modelKey?: string;
  systemPrompt: string;
}

export function defineDomainGrouper(
  opts: DefineDomainGrouperOpts,
): Agent<DomainGrouperPayload, DomainGrouperOutput> {
  return {
    name: opts.name,
    promptVersion: 1,
    modelKey: opts.modelKey,
    schema: OUTPUT_SCHEMA,
    prompt(input: AgentInput<DomainGrouperPayload>): ChatMessage[] {
      const { industry, hint, items } = input.payload;
      const itemList = items.length
        ? items.map((i, n) => `  ${n + 1}. [${i.kind}] ${i.title}${i.summary ? ` — ${i.summary}` : ''}`).join('\n')
        : '  (none)';
      return [
        {
          role: 'system',
          content:
            opts.systemPrompt +
            `\n\nGroup the items into 3-12 coherent domains. "members" MUST be exact ` +
            `titles from the ITEMS list (you may leave weak items out). Do not invent ` +
            `members. If grouping is not meaningful, return {"domains": []}.\n` +
            `Return JSON only. No prose, no fences.`,
        },
        {
          role: 'user',
          content:
            (industry ? `INDUSTRY: ${industry}\n` : '') +
            (hint ? `${hint}\n` : '') +
            `\nITEMS:\n${itemList}\n\nReturn JSON only.`,
        },
      ];
    },
    postprocess(o: DomainGrouperOutput, input) {
      const titles = new Set(input.payload.items.map((i) => i.title.toLowerCase()));
      const domains = (o.domains ?? [])
        .filter((d) => d.name?.trim())
        .map((d) => ({
          name: d.name.trim(),
          summary: d.summary?.trim(),
          members: (d.members ?? []).filter((m) => titles.has(m.toLowerCase())),
        }))
        .filter((d) => d.members.length > 0);
      return { output: { domains }, confidence: domains.length ? 0.7 : 0 };
    },
  };
}
