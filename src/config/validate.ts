/**
 * Config validation.
 *
 * Surfaces the common misconfigurations that silently degrade the pipeline:
 *   - agent model refs pointing at an undefined backend
 *   - invalid Cursor model slugs (the `composer-2.5-fast` class of failure)
 *   - inline plaintext API keys (prefer apiKeyEnv)
 *   - missing API keys for non-local backends
 *
 * Returns structured findings; callers decide whether to warn or fail.
 */
import { parseModelRef, resolveApiKey, type SubstrateNetConfig } from '../config.js';
import { CURSOR_MODELS, normalizeCursorModel } from '../agents/backends/cursor.js';

export interface ConfigFinding {
  level: 'error' | 'warn';
  message: string;
}

export function validateConfig(cfg: SubstrateNetConfig): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  const backends = cfg.agentBackends ?? {};

  // Inline secret hygiene.
  for (const [name, backend] of Object.entries(backends)) {
    if (backend.apiKey) {
      findings.push({
        level: 'warn',
        message: `backend "${name}" stores an inline apiKey in plaintext; prefer apiKeyEnv.`,
      });
    }
  }

  const checkRef = (agent: string, ref: string | undefined, role: string): void => {
    if (!ref) return;
    let backendName: string;
    let model: string;
    try {
      ({ backend: backendName, model } = parseModelRef(ref));
    } catch {
      findings.push({ level: 'error', message: `agent "${agent}" ${role} model ref "${ref}" is malformed (expected "<backend>:<model>").` });
      return;
    }
    const backend = backends[backendName];
    if (!backend) {
      findings.push({ level: 'error', message: `agent "${agent}" ${role} references unknown backend "${backendName}".` });
      return;
    }
    if (backend.kind === 'cursor-agent') {
      const normalized = normalizeCursorModel(model);
      if (!CURSOR_MODELS.includes(normalized)) {
        findings.push({
          level: 'error',
          message: `agent "${agent}" ${role} uses invalid Cursor model "${model}". Available: ${CURSOR_MODELS.join(', ')}.`,
        });
      }
    }
    if ((backend.kind === 'openai-compatible' || backend.kind === 'anthropic' || backend.kind === 'cursor-agent')
        && !resolveApiKey(backend)) {
      findings.push({
        level: 'warn',
        message: `agent "${agent}" ${role} backend "${backendName}" has no resolvable API key (set apiKeyEnv or apiKey).`,
      });
    }
  };

  for (const [agent, spec] of Object.entries(cfg.agents ?? {})) {
    checkRef(agent, spec.model, 'primary');
    const fallbacks = spec.fallback === undefined
      ? []
      : Array.isArray(spec.fallback) ? spec.fallback : [spec.fallback];
    for (const fb of fallbacks) checkRef(agent, fb, 'fallback');
  }

  return findings;
}
