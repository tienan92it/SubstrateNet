/**
 * Post-extract anchor gate — drop isolated facts with no business/code anchor.
 */
import type { ExtractedFact } from '../agents/extractors-common.js';
import type { WindowBrief } from './window-brief.js';
import type { IngestConfig } from '../config.js';

const CORE_KINDS = new Set([
  'decision', 'business_rule', 'entity', 'constraint', 'requirement',
  'actor', 'process', 'metric',
]);

const ANCHOR_KINDS = new Set(['intent', 'problem', 'solution', 'pattern']);

export interface FactFilterResult {
  kept: ExtractedFact[];
  rejected: number;
}

export function filterFactsByAnchor(
  facts: ExtractedFact[],
  brief: WindowBrief | undefined,
  cfg: IngestConfig,
): FactFilterResult {
  const minConf = cfg.minExtractConfidence ?? 0.45;
  const kept: ExtractedFact[] = [];
  let rejected = 0;

  const ticketSet = new Set(brief?.tickets ?? []);
  const pathSet = new Set(brief?.paths ?? []);
  const symbolSet = new Set(brief?.symbols ?? []);

  for (const f of facts) {
    if ((f.confidence ?? 0) < minConf) {
      rejected++;
      continue;
    }
    if (CORE_KINDS.has(f.kind)) {
      kept.push(f);
      continue;
    }
    if (!ANCHOR_KINDS.has(f.kind)) {
      kept.push(f);
      continue;
    }
    const hasFile = (f.file_mentions?.length ?? 0) > 0;
    const hasSym = (f.symbol_mentions?.length ?? 0) > 0;
    const titleHasTicket = [...ticketSet].some((t) => f.title.includes(t) || (f.summary?.includes(t)));
    const titleHasPath = [...pathSet].some((p) => f.title.includes(p) || (f.summary?.includes(p)));
    const titleHasSym = [...symbolSet].some((s) => f.title.toLowerCase().includes(s.toLowerCase()));
    if (hasFile || hasSym || titleHasTicket || titleHasPath || titleHasSym) {
      kept.push(f);
    } else {
      rejected++;
    }
  }

  const maxFacts = cfg.maxFactsPerWindow ?? 8;
  if (kept.length > maxFacts) {
    rejected += kept.length - maxFacts;
    kept.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    kept.splice(maxFacts);
  }

  return { kept, rejected };
}
