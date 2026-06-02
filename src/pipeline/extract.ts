/**
 * Extractor orchestrator.
 *
 * For each kept window:
 *   1. Look up its triage labels.
 *   2. Choose which extractor agents to run (routed by domain + quality).
 *   3. Run each agent (cached); persist facts + provenance.
 *   4. Resolve symbol_mentions and file_mentions to L0 code nodes; write k_to_code.
 *   5. Generate an embedding for each new fact via the Dedupe Agent.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { AgentRuntime, type Agent } from '../agents/runtime.js';
import type { SubstrateNetConfig } from '../config.js';
import '../agents/index.js';
import { DECISION_AGENT } from '../agents/decision.js';
import { BUSINESS_LOGIC_AGENT } from '../agents/business-logic.js';
import { INTENT_AGENT } from '../agents/intent.js';
import { PROBLEM_SOLUTION_AGENT } from '../agents/problem-solution.js';
import { REQUIREMENTS_AGENT } from '../agents/requirements.js';
import {
  factToRows,
  type ExtractorOutput,
  type ExtractorPayload,
} from '../agents/extractors-common.js';
import { DedupeAgent, storeKNodeEmbedding } from '../agents/dedupe.js';
import { getWindowText, getTriageLabels } from '../knowledge/triage-store.js';
import { upsertKNode, insertProvenance } from '../knowledge/store.js';
import { resolvePath, resolveSymbol, writeKToCode } from './resolve.js';
import { mapPool } from '../util/pool.js';

export interface ExtractStats {
  factsProduced: number;
  factsByAgent: Record<string, number>;
  factsByKind: Record<string, number>;
  codeLinks: number;
}

type Extractor = Agent<ExtractorPayload, ExtractorOutput>;

interface RoutingDecision {
  agents: Extractor[];
}

/**
 * Routing rules — which extractor runs on which window.
 * Conservative defaults: run agents that are likely productive given the domain.
 * `isDoc` windows come from in-repo documentation (BRD/PRD/architecture) and
 * always get the business-knowledge extractors regardless of triage domain.
 */
function route(domain: string, quality: string, isDoc: boolean): RoutingDecision {
  const agents: Extractor[] = [];

  // Decision agent is broadly useful — runs on most engineering domains.
  if (
    isDoc ||
    (['architecture', 'implementation', 'business_logic', 'debugging', 'devops'].includes(domain) &&
      ['signal', 'decision_grade'].includes(quality))
  ) {
    agents.push(DECISION_AGENT);
  }

  // Business logic when the triage said so, or for any document.
  if (isDoc || ['business_logic', 'architecture'].includes(domain)) {
    agents.push(BUSINESS_LOGIC_AGENT);
  }

  // Requirements (actors / processes / metrics / intents) — documents and
  // business/architecture conversations.
  if (isDoc || ['business_logic', 'architecture', 'meta_process'].includes(domain)) {
    agents.push(REQUIREMENTS_AGENT);
  }

  // Intent — anywhere there's likely a user goal.
  if (isDoc || ['architecture', 'implementation', 'business_logic', 'debugging'].includes(domain)) {
    agents.push(INTENT_AGENT);
  }

  // Problem/solution — debugging + implementation
  if (['debugging', 'implementation'].includes(domain)) {
    agents.push(PROBLEM_SOLUTION_AGENT);
  }

  return { agents };
}

/** Window ids whose backing session is an in-repo document (agent='docs'). */
function docWindowIds(knowDb: SqliteDb): Set<string> {
  const rows = knowDb.prepare(`
    SELECT tw.id AS id FROM turn_windows tw
    JOIN sessions s ON s.id = tw.session_id
    WHERE s.agent = 'docs'
  `).all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

export interface ExtractRunOpts {
  onTask?: (current: number, total: number) => void;
}

export async function runExtractorsForKeptWindows(
  _root: string,
  knowDb: SqliteDb,
  codeDb: SqliteDb,
  cfg: SubstrateNetConfig,
  windowIds: string[],
  runOpts: ExtractRunOpts = {},
): Promise<ExtractStats> {
  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const stats: ExtractStats = {
    factsProduced: 0,
    factsByAgent: {},
    factsByKind: {},
    codeLinks: 0,
  };

  // Initialize Dedupe Agent best-effort. If embeddings backend is unavailable,
  // we still produce facts (just without per-fact embeddings).
  let dedupe: DedupeAgent | undefined;
  try { dedupe = new DedupeAgent(cfg); } catch { dedupe = undefined; }

  // Build the full (window × agent) task list first, then run the chat calls
  // concurrently and persist results sequentially. The clusterer (incremental)
  // stays serial elsewhere; extractors are independent per window so this is safe.
  const docWindows = docWindowIds(knowDb);
  const tasks: Array<{ windowId: string; text: string; domain: string; agent: Extractor }> = [];
  for (const windowId of windowIds) {
    const labels = getTriageLabels(knowDb, windowId);
    if (!labels) continue;
    const text = getWindowText(knowDb, windowId);
    if (!text) continue;
    if (labels.rationale && /\[dup_of:/.test(labels.rationale)) continue; // skip dups
    const { agents } = route(labels.domain, labels.quality, docWindows.has(windowId));
    for (const agent of agents) tasks.push({ windowId, text, domain: labels.domain, agent });
  }

  const limit = cfg.concurrency ?? 4;
  let taskDone = 0;
  const outcomes = await mapPool(tasks, limit, async (t) => {
    try {
      const out = await rt.run<ExtractorPayload, ExtractorOutput>(t.agent, {
        payload: { text: t.text, windowId: t.windowId, domain: t.domain },
      });
      taskDone++;
      runOpts.onTask?.(taskDone, tasks.length);
      return { t, out };
    } catch {
      taskDone++;
      runOpts.onTask?.(taskDone, tasks.length);
      return undefined; // backend error for this call; others continue
    }
  });

  // Persist sequentially (DB writes + code resolution + embeddings).
  for (const oc of outcomes) {
    if (!oc) continue;
    const { t, out } = oc;
    const agent = t.agent;
    const windowId = t.windowId;
    {
      for (const fact of out.output.facts) {
        const { node, provenance } = factToRows(fact, windowId, agent.name, out.model);
        const tx = knowDb.transaction(() => {
          upsertKNode(knowDb, node);
          insertProvenance(knowDb, provenance);
        });
        tx();
        stats.factsProduced++;
        stats.factsByAgent[agent.name] = (stats.factsByAgent[agent.name] ?? 0) + 1;
        stats.factsByKind[fact.kind] = (stats.factsByKind[fact.kind] ?? 0) + 1;

        // L2 -> L0 bridging
        if (fact.file_mentions) {
          for (const path of fact.file_mentions) {
            const r = resolvePath(codeDb, path);
            if (r) {
              writeKToCode(knowDb, {
                kNodeId: node.id,
                codeNodeId: r.codeNodeId,
                codeFile: r.codeFile,
              });
              stats.codeLinks++;
            }
          }
        }
        if (fact.symbol_mentions) {
          for (const name of fact.symbol_mentions) {
            for (const cand of resolveSymbol(codeDb, name)) {
              writeKToCode(knowDb, {
                kNodeId: node.id,
                codeNodeId: cand.id,
                codeFile: cand.file,
                weight: 0.6, // lower weight: symbol-name match can be ambiguous
              });
              stats.codeLinks++;
            }
          }
        }

        // Per-fact embedding for future dedupe / clustering.
        if (dedupe) {
          try {
            const v = await dedupe.embedText(
              `${fact.kind}: ${fact.title}\n${fact.summary ?? ''}`,
            );
            storeKNodeEmbedding(knowDb, node.id, v, dedupe.modelRef);
          } catch {
            // ignore embedding failure
          }
        }
      }
    }
  }
  return stats;
}
