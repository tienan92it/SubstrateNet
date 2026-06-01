/**
 * ArchitectureAnalyzer Agent.
 *
 * The FileAnalyzer assigns a layer per file in isolation; this agent reconciles
 * them at the directory level so the project has a coherent architecture. It
 * sees each directory's layer histogram (how its files were individually
 * classified) and returns one canonical layer per directory. The pipeline then
 * only backfills files left as "other" — confident per-file layers are kept.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import { registerAgent } from './registry.js';
import { LAYERS, type Layer } from './file-analyzer.js';

export interface ArchDirInput {
  path: string;
  histogram: Record<string, number>;   // layer -> file count
}

export interface ArchitecturePayload {
  directories: ArchDirInput[];
}

export interface ArchitectureOutput {
  directories: Array<{ path: string; layer: Layer }>;
}

const SYSTEM = `You assign ONE canonical architectural layer to each directory of a codebase,
given how its files were individually classified (a per-layer histogram).

Layers: api | service | data | ui | utility | other.

Produce STRICT JSON: { "directories": [ { "path", "layer" } ] }.
  - Pick the layer that best represents the directory's role, usually the dominant one.
  - Keep "other" only when no layer clearly dominates and the directory is genuinely mixed/misc.
  - Return one entry per input directory, preserving the exact path strings.

Return JSON only. No prose, no fences.`;

export const ARCHITECTURE_ANALYZER_AGENT: Agent<ArchitecturePayload, ArchitectureOutput> = {
  name: 'architectureAnalyzer',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['directories'],
    properties: {
      directories: {
        type: 'array',
        maxItems: 400,
        items: {
          type: 'object',
          required: ['path', 'layer'],
          properties: {
            path: { type: 'string' },
            layer: { enum: LAYERS as unknown as string[] },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<ArchitecturePayload>): ChatMessage[] {
    const lines = input.payload.directories.map((d) => {
      const hist = Object.entries(d.histogram).map(([k, v]) => `${k}:${v}`).join(' ');
      return `  ${d.path || '.'}  [${hist}]`;
    });
    return [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `DIRECTORIES (path [layer:count ...]):\n${lines.join('\n')}\n\nReturn JSON only.` },
    ];
  },
  postprocess(o: ArchitectureOutput, _input) {
    const directories = (o.directories ?? []).filter(
      (d) => typeof d.path === 'string' && (LAYERS as readonly string[]).includes(d.layer),
    );
    return { output: { directories }, confidence: directories.length ? 0.7 : 0 };
  },
};

registerAgent(ARCHITECTURE_ANALYZER_AGENT);
