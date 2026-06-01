/**
 * Domain enrichment orchestrator (L2.5).
 *
 * Order matters — each stage feeds the next:
 *   1. Structural extraction (deterministic): code schema/FKs → entities + relationships.
 *   2. DomainModeler agent (grounded, best-effort): relationships + gaps from
 *      conversation evidence. Skipped silently if no LLM backend.
 *   3. Gap detector (deterministic): external refs + ungoverned central entities.
 *
 * Stages 1 and 3 require no LLM and always run. Stage 2 enriches further when a
 * backend is available. Every node/edge written carries a grounding tier and an
 * evidence citation; nothing is fabricated.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import type { CodeGpsConfig } from '../config.js';
import type { KNode } from '../types.js';
import { createHash } from 'crypto';
import { AgentRuntime } from '../agents/runtime.js';
import '../agents/index.js';
import { DOMAIN_MODELER_AGENT } from '../agents/domain-modeler.js';
import { TECHNICAL_PROFILER_AGENT } from '../agents/technical-profiler.js';
import { INDUSTRY_CLASSIFIER_AGENT } from '../agents/industry-classifier.js';
import { INDUSTRY_ENRICHER_AGENT } from '../agents/industry-enricher.js';
import { DOMAIN_ANALYZER_AGENT } from '../agents/domain-analyzer.js';
import { runDomainFromCode } from './domain-from-code.js';
import { runManifestParser } from './manifests.js';
import { runGapDetector } from './gap-detector.js';
import { runEntityReconciler } from './reconcile.js';
import { runClustererForNewFacts } from './cluster.js';
import { upsertKNode, insertKEdgeUnique, setGroundingScope } from '../knowledge/store.js';
import { DedupeAgent, storeKNodeEmbedding } from '../agents/dedupe.js';
import { gapId } from '../knowledge/domain-store.js';
import { createResearchBackend, cachedLookup } from '../research/backend.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface EnrichStats {
  dependencies: number;
  tools: number;
  technicalSkills: number;
  structuralEntities: number;
  externalEntities: number;
  structuralRelationships: number;
  reconciledEntities: number;
  agentRelationships: number;
  agentGaps: number;
  detectedGaps: number;
  industry?: string;
  industryConcepts: number;
  externalUpgrades: number;
  domainHighlights: number;
}

export interface EnrichOpts {
  /** Skip all LLM stages (structural + deterministic only). */
  noAgent?: boolean;
  /** Skip the model/web industry enrichment stage specifically. */
  noEnrichIndustry?: boolean;
  maxEntities?: number;
  maxFacts?: number;
}

export async function runEnrichment(
  root: string, knowDb: SqliteDb, codeDb: SqliteDb, cfg: CodeGpsConfig, opts: EnrichOpts = {},
): Promise<EnrichStats> {
  const stats: EnrichStats = {
    dependencies: 0, tools: 0, technicalSkills: 0,
    structuralEntities: 0, externalEntities: 0, structuralRelationships: 0,
    reconciledEntities: 0, agentRelationships: 0, agentGaps: 0, detectedGaps: 0,
    industryConcepts: 0, externalUpgrades: 0, domainHighlights: 0,
  };

  // ── 1. Deterministic technical evidence (manifests + infra) ──────────
  const manifest = runManifestParser(knowDb, root);
  stats.dependencies = manifest.dependencies;
  stats.tools = manifest.tools;

  // ── 2. Structural domain (deterministic): code schema/FKs ────────────
  const fromCode = runDomainFromCode(knowDb, codeDb);
  stats.structuralEntities = fromCode.entities;
  stats.externalEntities = fromCode.externalEntities;
  stats.structuralRelationships = fromCode.relationships;

  // ── 3. Reconcile stated <-> structural entities → `corroborated` ─────
  const recon = runEntityReconciler(knowDb);
  stats.reconciledEntities = recon.matched;

  let producedClusterableFacts = false;

  if (!opts.noAgent) {
    // ── 4. TechnicalProfiler (technical scope) ─────────────────────────
    try {
      stats.technicalSkills = await runTechnicalProfiler(knowDb, codeDb, cfg);
      producedClusterableFacts ||= stats.technicalSkills > 0;
    } catch { /* backend down; structural facts still stand */ }

    // ── 5. DomainModeler (relationships + gaps) ────────────────────────
    try {
      const ag = await runDomainModeler(knowDb, cfg, opts);
      stats.agentRelationships = ag.relationships;
      stats.agentGaps = ag.gaps;
    } catch { /* ignore */ }

    // ── 6. IndustryClassifier (industry scope) ─────────────────────────
    try {
      const ind = await runIndustryClassifier(knowDb, codeDb, root, cfg);
      stats.industry = ind.industry;
    } catch { /* ignore */ }

    // ── 7. IndustryEnricher (model → external gap-fill) ────────────────
    if (!opts.noEnrichIndustry && stats.industry) {
      try {
        const enr = await runIndustryEnricher(knowDb, cfg, stats.industry);
        stats.industryConcepts = enr.produced;
        stats.externalUpgrades = enr.upgraded;
        producedClusterableFacts ||= enr.produced > 0;
      } catch { /* ignore */ }
    }

    // ── 7b. DomainAnalyzer: fuse technical + industry into portfolio highlights ─
    try {
      stats.domainHighlights = await runDomainAnalyzer(knowDb, codeDb, cfg, stats.industry);
    } catch { /* ignore */ }
  }

  // ── 8. Gap detector (deterministic) ──────────────────────────────────
  const gaps = runGapDetector(knowDb);
  stats.detectedGaps = gaps.externalRefs + gaps.ungovernedEntities;

  // ── 9. Fold newly-produced clusterable facts (skills, industry) into L3.
  if (producedClusterableFacts) {
    try { await runClustererForNewFacts(knowDb, cfg); } catch { /* ignore */ }
  }

  return stats;
}

/** Embed a fact (best-effort) so it can be clustered later. */
async function embedFact(dedupe: DedupeAgent | undefined, knowDb: SqliteDb, node: KNode): Promise<void> {
  if (!dedupe) return;
  try {
    const v = await dedupe.embedText(`${node.kind}: ${node.title}\n${node.summary ?? ''}`);
    storeKNodeEmbedding(knowDb, node.id, v, dedupe.modelRef);
  } catch { /* ignore */ }
}

async function runTechnicalProfiler(knowDb: SqliteDb, codeDb: SqliteDb, cfg: CodeGpsConfig): Promise<number> {
  const languages = (codeDb.prepare(`
    SELECT language AS name, COUNT(*) AS files FROM files GROUP BY language ORDER BY files DESC
  `).all() as Array<{ name: string; files: number }>).filter((l) => l.name && l.name !== 'unknown');

  const dependencies = (knowDb.prepare(`SELECT title FROM k_nodes WHERE kind='dependency' LIMIT 300`).all() as Array<{ title: string }>).map((r) => r.title);
  const tools = (knowDb.prepare(`SELECT title FROM k_nodes WHERE kind='tool'`).all() as Array<{ title: string }>).map((r) => r.title);

  if (languages.length === 0 && dependencies.length === 0 && tools.length === 0) return 0;

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const out = await rt.run(TECHNICAL_PROFILER_AGENT, { payload: { languages, dependencies, tools } });

  let dedupe: DedupeAgent | undefined;
  try { dedupe = new DedupeAgent(cfg); } catch { dedupe = undefined; }

  const now = Date.now();
  let count = 0;
  for (const s of out.output.skills) {
    const id = createHash('sha1').update(`skill|${s.name.toLowerCase()}`).digest('hex').slice(0, 16);
    const node: KNode = {
      id, kind: 'skill', title: s.name,
      summary: `${s.kind} skill (evidence: ${s.evidence})`,
      evidenceText: s.evidence,
      confidence: out.confidence, source: 'agent:technicalProfiler',
      grounding: 'structural', scope: 'technical', agentModel: out.model,
      createdAt: now, updatedAt: now,
    };
    upsertKNode(knowDb, node);
    await embedFact(dedupe, knowDb, node);
    count++;
  }
  return count;
}

async function runDomainModeler(
  knowDb: SqliteDb, cfg: CodeGpsConfig, opts: EnrichOpts,
): Promise<{ relationships: number; gaps: number }> {
  const maxEntities = opts.maxEntities ?? 60;
  const maxFacts = opts.maxFacts ?? 40;

  const entities = knowDb.prepare(`
    SELECT id, title, summary FROM k_nodes
    WHERE kind='entity' AND source != 'structural:code:external'
    ORDER BY updated_at DESC LIMIT ?
  `).all(maxEntities) as Array<{ id: string; title: string; summary: string | null }>;

  if (entities.length === 0) return { relationships: 0, gaps: 0 };

  const facts = knowDb.prepare(`
    SELECT kind, title, summary, evidence_text FROM k_nodes
    WHERE kind IN ('business_rule','constraint','entity','decision')
    ORDER BY updated_at DESC LIMIT ?
  `).all(maxFacts) as Array<{ kind: string; title: string; summary: string | null; evidence_text: string | null }>;

  if (facts.length === 0) return { relationships: 0, gaps: 0 };

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const out = await rt.run(DOMAIN_MODELER_AGENT, {
    payload: {
      entities: entities.map((e) => ({ id: e.id, title: e.title, summary: e.summary ?? undefined })),
      facts: facts.map((f) => ({
        kind: f.kind, title: f.title,
        summary: f.summary ?? undefined, evidence: f.evidence_text ?? undefined,
      })),
    },
  });

  // Map entity titles -> ids for relationship persistence.
  const titleToId = new Map<string, string>();
  for (const e of entities) titleToId.set(e.title.toLowerCase(), e.id);

  const now = Date.now();
  let relCount = 0;
  let gapCount = 0;

  const tx = knowDb.transaction(() => {
    for (const r of out.output.relationships) {
      const from = titleToId.get(r.from.toLowerCase());
      const to = titleToId.get(r.to.toLowerCase());
      if (!from || !to) continue;
      const added = insertKEdgeUnique(knowDb, {
        source: from, target: to, kind: r.kind, weight: 1,
        metadata: { via: 'conversation', grounding: 'stated', evidence: r.evidence },
      });
      if (added) relCount++;
    }
    for (const g of out.output.gaps) {
      const id = gapId(`agent:${g.title}`);
      const node: KNode = {
        id, kind: 'knowledge_gap', title: g.title,
        summary: g.why, evidenceText: g.evidence,
        confidence: out.confidence, source: 'agent:domainModeler', grounding: 'stated',
        agentModel: out.model, createdAt: now, updatedAt: now,
      };
      upsertKNode(knowDb, node);
      gapCount++;
    }
  });
  tx();

  return { relationships: relCount, gaps: gapCount };
}

async function runIndustryClassifier(
  knowDb: SqliteDb, codeDb: SqliteDb, root: string, cfg: CodeGpsConfig,
): Promise<{ industry?: string }> {
  const entities = (knowDb.prepare(`SELECT DISTINCT title FROM k_nodes WHERE kind='entity' LIMIT 80`).all() as Array<{ title: string }>).map((r) => r.title);
  const rules = (knowDb.prepare(`SELECT title, summary FROM k_nodes WHERE kind IN ('business_rule','constraint') LIMIT 40`).all() as Array<{ title: string; summary: string | null }>).map((r) => r.summary ? `${r.title}: ${r.summary}` : r.title);
  const dependencies = (knowDb.prepare(`SELECT title FROM k_nodes WHERE kind='dependency' LIMIT 80`).all() as Array<{ title: string }>).map((r) => r.title);

  // Notable code symbols as domain signal (works for FE and non-SQL projects):
  // classes, modules, SQL tables, and exported functions — which cover React
  // components / hooks / page handlers. Skip files / imports / fields (noise).
  const symbols = (codeDb.prepare(`
    SELECT DISTINCT name FROM nodes
    WHERE kind IN ('class','module','table')
       OR (kind = 'function' AND is_exported = 1)
    ORDER BY name LIMIT 120
  `).all() as Array<{ name: string }>).map((r) => r.name);

  // package.json name + description, if present.
  let projectName: string | undefined;
  let description: string | undefined;
  try {
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      projectName = typeof pkg.name === 'string' ? pkg.name : undefined;
      description = typeof pkg.description === 'string' ? pkg.description : undefined;
    }
  } catch { /* ignore */ }

  let readme: string | undefined;
  for (const name of ['README.md', 'readme.md', 'README', 'README.markdown']) {
    const p = join(root, name);
    if (existsSync(p)) { try { readme = readFileSync(p, 'utf8'); } catch { /* ignore */ } break; }
  }

  // Classify from ANY available signal. Only bail when there is truly nothing.
  if (!readme && !projectName && !description &&
      entities.length === 0 && rules.length === 0 &&
      dependencies.length === 0 && symbols.length === 0) {
    return {};
  }

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const out = await rt.run(INDUSTRY_CLASSIFIER_AGENT, {
    payload: { readme, projectName, description, dependencies, symbols, entities, businessRules: rules },
  });
  const o = out.output;
  if (!o.industry || o.industry.toLowerCase() === 'unknown') return {};

  const id = createHash('sha1').update(`industry|${o.industry.toLowerCase()}`).digest('hex').slice(0, 16);
  const grounding = o.confidence >= 0.7 && o.evidence ? 'corroborated' : 'stated';
  const now = Date.now();
  const tx = knowDb.transaction(() => {
    upsertKNode(knowDb, {
      id, kind: 'industry', title: o.industry,
      summary: o.domains?.length ? `Domains: ${o.domains.join(', ')}` : undefined,
      evidenceText: o.evidence,
      confidence: o.confidence, source: 'agent:industryClassifier',
      grounding, scope: 'industry', agentModel: out.model,
      createdAt: now, updatedAt: now,
    });
    // Tag existing business facts as industry scope.
    knowDb.prepare(`
      UPDATE k_nodes SET scope='industry'
      WHERE kind IN ('business_rule','constraint','entity') AND (scope IS NULL OR scope='meta')
    `).run();
  });
  tx();
  return { industry: o.industry };
}

async function runIndustryEnricher(
  knowDb: SqliteDb, cfg: CodeGpsConfig, industry: string,
): Promise<{ produced: number; upgraded: number }> {
  const known = (knowDb.prepare(`
    SELECT title FROM k_nodes
    WHERE kind IN ('entity','business_rule','constraint','glossary_term')
      AND COALESCE(grounding,'stated') != 'model'
    LIMIT 120
  `).all() as Array<{ title: string }>).map((r) => r.title);

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const out = await rt.run(INDUSTRY_ENRICHER_AGENT, { payload: { industry, knownConcepts: known } });
  if (out.output.items.length === 0) return { produced: 0, upgraded: 0 };

  const backend = createResearchBackend(cfg);
  let dedupe: DedupeAgent | undefined;
  try { dedupe = new DedupeAgent(cfg); } catch { dedupe = undefined; }

  const now = Date.now();
  let produced = 0;
  let upgraded = 0;

  for (const item of out.output.items) {
    const id = createHash('sha1').update(`industry-std|${industry}|${item.title.toLowerCase()}`).digest('hex').slice(0, 16);
    let grounding: 'model' | 'external' = 'model';
    let evidence = `Industry-standard in ${industry}. ${item.basis}`;
    let sourceUrl: string | undefined;

    // Opt-in web research upgrades model -> external with a citation.
    const research = await cachedLookup(knowDb, backend, `${industry}: ${item.title}`);
    if (research) {
      grounding = 'external';
      evidence = research.summary;
      sourceUrl = research.sourceUrl;
      upgraded++;
    }

    const node: KNode = {
      id, kind: 'glossary_term', title: item.title,
      summary: item.description, evidenceText: evidence,
      confidence: out.confidence, source: 'agent:industryEnricher',
      grounding, scope: 'industry', sourceUrl, agentModel: out.model,
      createdAt: now, updatedAt: now,
    };
    upsertKNode(knowDb, node);
    await embedFact(dedupe, knowDb, node);
    produced++;
  }
  return { produced, upgraded };
}

/**
 * DomainAnalyzer: fuse the technical skills, architectural layers, classified
 * industry, and salient facts into composite `domain_highlight` portfolio
 * statements. Each is evidence-cited; grounding is `corroborated` when both an
 * industry and structural skills back it, else `model`.
 */
async function runDomainAnalyzer(
  knowDb: SqliteDb, codeDb: SqliteDb, cfg: CodeGpsConfig, industry?: string,
): Promise<number> {
  const skills = (knowDb.prepare(`SELECT title FROM k_nodes WHERE kind='skill' LIMIT 40`).all() as Array<{ title: string }>).map((r) => r.title);
  const layers = (codeDb.prepare(`SELECT DISTINCT layer FROM file_analysis WHERE layer IS NOT NULL AND layer != 'other'`).all() as Array<{ layer: string }>).map((r) => r.layer);
  const facts = (knowDb.prepare(`
    SELECT title FROM k_nodes WHERE kind IN ('business_rule','decision','entity')
    ORDER BY confidence DESC LIMIT 20
  `).all() as Array<{ title: string }>).map((r) => r.title);

  // Need at least two signal types to fuse anything meaningful.
  const signals = [industry ? 1 : 0, skills.length ? 1 : 0, layers.length ? 1 : 0, facts.length ? 1 : 0]
    .reduce((a, b) => a + b, 0);
  if (signals < 2) return 0;

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const out = await rt.run(DOMAIN_ANALYZER_AGENT, { payload: { industry, skills, layers, facts } });
  if (out.output.highlights.length === 0) return 0;

  let dedupe: DedupeAgent | undefined;
  try { dedupe = new DedupeAgent(cfg); } catch { dedupe = undefined; }

  const grounding: KNode['grounding'] = industry && skills.length ? 'corroborated' : 'model';
  const now = Date.now();
  let count = 0;
  for (const h of out.output.highlights) {
    const id = createHash('sha1').update(`highlight|${h.statement.toLowerCase()}`).digest('hex').slice(0, 16);
    const node: KNode = {
      id, kind: 'domain_highlight', title: h.statement,
      summary: industry ? `Portfolio highlight (${industry})` : 'Portfolio highlight',
      evidenceText: h.evidence,
      confidence: out.confidence, source: 'agent:domainAnalyzer',
      grounding, scope: 'industry', agentModel: out.model,
      createdAt: now, updatedAt: now,
    };
    upsertKNode(knowDb, node);
    await embedFact(dedupe, knowDb, node);
    count++;
  }
  return count;
}
