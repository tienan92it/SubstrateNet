/**
 * Fused enrich profile — two flash-first LLM calls (domainFuser + industryFuser)
 * replacing eight sequential frontier agents in the standard profile.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Database as SqliteDb } from 'better-sqlite3';
import type { SubstrateNetConfig } from '../config.js';
import type { KEdgeKind, KNode } from '../types.js';
import { AgentRuntime } from '../agents/runtime.js';
import '../agents/index.js';
import { DOMAIN_FUSER_AGENT, type DomainFuserPayload } from '../agents/domain-fuser.js';
import { INDUSTRY_FUSER_AGENT, type IndustryFuserPayload } from '../agents/industry-fuser.js';
import { buildProjectCorePack, renderProjectCorePack } from './project-core-pack.js';
import { listConcepts } from '../knowledge/concept-store.js';
import { upsertKNode, insertKEdgeUnique } from '../knowledge/store.js';
import { DedupeAgent, storeKNodeEmbedding } from '../agents/dedupe.js';
import { gapId, domainNodeId } from '../knowledge/domain-store.js';
import { createResearchBackend, cachedLookup } from '../research/backend.js';
import type { EnrichOpts, EnrichStats } from './enrich.js';

async function embedFact(dedupe: DedupeAgent | undefined, knowDb: SqliteDb, node: KNode): Promise<void> {
  if (!dedupe) return;
  try {
    const v = await dedupe.embedText(`${node.kind}: ${node.title}\n${node.summary ?? ''}`);
    storeKNodeEmbedding(knowDb, node.id, v, dedupe.modelRef);
  } catch { /* ignore */ }
}

function topDirectories(codeDb: SqliteDb): Array<{ path: string; layer: string }> {
  const rows = codeDb.prepare(`
    SELECT path, layer FROM file_analysis WHERE layer IS NOT NULL
  `).all() as Array<{ path: string; layer: string }>;
  const dirs = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const segs = r.path.split('/').filter(Boolean);
    const dir = segs.slice(0, 2).join('/') || segs[0] || '.';
    let hist = dirs.get(dir);
    if (!hist) { hist = new Map(); dirs.set(dir, hist); }
    hist.set(r.layer, (hist.get(r.layer) ?? 0) + 1);
  }
  const out: Array<{ path: string; layer: string; count: number }> = [];
  for (const [dir, hist] of dirs) {
    let layer = 'other'; let best = -1; let count = 0;
    for (const [l, n] of hist) { count += n; if (n > best) { best = n; layer = l; } }
    out.push({ path: dir, layer, count });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 30).map(({ path, layer }) => ({ path, layer }));
}

export function buildDomainFuserPayload(
  knowDb: SqliteDb,
  codeDb: SqliteDb,
  root: string,
): DomainFuserPayload | null {
  const corePack = renderProjectCorePack(buildProjectCorePack(knowDb, root));
  const concepts = listConcepts(knowDb, undefined, 40).map((c) => ({
    name: c.name,
    summary: c.summary,
    memberCount: c.memberCount,
  }));

  const entities = knowDb.prepare(`
    SELECT id, title, summary FROM k_nodes
    WHERE kind='entity' AND source != 'structural:code:external'
    ORDER BY updated_at DESC LIMIT 60
  `).all() as Array<{ id: string; title: string; summary: string | null }>;

  const businessItems = knowDb.prepare(`
    SELECT id, kind, title, summary FROM k_nodes
    WHERE kind IN ('entity','business_rule','actor','process','glossary_term','constraint')
      AND COALESCE(scope,'meta') != 'technical'
    ORDER BY updated_at DESC LIMIT 80
  `).all() as Array<{ id: string; kind: string; title: string; summary: string | null }>;

  const techItems = knowDb.prepare(`
    SELECT id, kind, title, summary FROM k_nodes
    WHERE scope='technical' AND kind IN ('skill','entity','tool')
    ORDER BY updated_at DESC LIMIT 80
  `).all() as Array<{ id: string; kind: string; title: string; summary: string | null }>;

  if (entities.length === 0 && concepts.length === 0 && businessItems.length < 3 && techItems.length < 3) {
    return null;
  }

  const layers = (codeDb.prepare(
    `SELECT DISTINCT layer FROM file_analysis WHERE layer IS NOT NULL AND layer != 'other'`,
  ).all() as Array<{ layer: string }>).map((r) => r.layer);

  return {
    corePack,
    concepts,
    entities: entities.map((e) => ({ id: e.id, title: e.title, summary: e.summary ?? undefined })),
    businessItems: businessItems.map((i) => ({ kind: i.kind, title: i.title, summary: i.summary ?? undefined })),
    techItems: techItems.map((i) => ({ kind: i.kind, title: i.title, summary: i.summary ?? undefined })),
    layers,
  };
}

export function buildIndustryFuserPayload(
  knowDb: SqliteDb,
  codeDb: SqliteDb,
  root: string,
): IndustryFuserPayload | null {
  const corePack = renderProjectCorePack(buildProjectCorePack(knowDb, root));

  const languages = (codeDb.prepare(`
    SELECT language AS name, COUNT(*) AS files FROM files GROUP BY language ORDER BY files DESC
  `).all() as Array<{ name: string; files: number }>).filter((l) => l.name && l.name !== 'unknown');

  const depRows = knowDb.prepare(`
    SELECT title, COUNT(*) AS n FROM k_nodes WHERE kind='dependency' GROUP BY title ORDER BY n DESC LIMIT 80
  `).all() as Array<{ title: string; n: number }>;
  const dependencyHistogram = depRows.map((r) => ({ name: r.title, count: r.n }));

  const tools = (knowDb.prepare(`SELECT title FROM k_nodes WHERE kind='tool'`).all() as Array<{ title: string }>).map((r) => r.title);
  const symbols = (codeDb.prepare(`
    SELECT DISTINCT name FROM nodes
    WHERE kind IN ('class','module','table')
       OR (kind = 'function' AND is_exported = 1)
    ORDER BY name LIMIT 120
  `).all() as Array<{ name: string }>).map((r) => r.name);
  const entities = (knowDb.prepare(`SELECT DISTINCT title FROM k_nodes WHERE kind='entity' LIMIT 80`).all() as Array<{ title: string }>).map((r) => r.title);

  let projectName: string | undefined;
  let readmeExcerpt: string | undefined;
  try {
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      projectName = typeof pkg.name === 'string' ? pkg.name : undefined;
    }
  } catch { /* ignore */ }
  for (const name of ['README.md', 'readme.md']) {
    const p = join(root, name);
    if (existsSync(p)) {
      try { readmeExcerpt = readFileSync(p, 'utf8'); } catch { /* ignore */ }
      break;
    }
  }

  const architectureFacts = (knowDb.prepare(`
    SELECT kind, title, summary FROM k_nodes
    WHERE kind IN ('decision','pattern','constraint','intent','process')
    ORDER BY confidence DESC LIMIT 30
  `).all() as Array<{ kind: string; title: string; summary: string | null }>)
    .map((f) => ({ kind: f.kind, title: f.title, summary: f.summary ?? undefined }));

  if (
    languages.length === 0 && dependencyHistogram.length === 0 && tools.length === 0 &&
    symbols.length === 0 && !readmeExcerpt && !projectName
  ) {
    return null;
  }

  return {
    corePack,
    readmeExcerpt,
    projectName,
    languages,
    dependencyHistogram,
    tools,
    symbols,
    entities,
    directories: topDirectories(codeDb),
    architectureFacts,
  };
}

export interface EnrichFusedResult extends Partial<EnrichStats> {
  producedClusterableFacts?: boolean;
}

export async function runEnrichFused(
  root: string,
  knowDb: SqliteDb,
  codeDb: SqliteDb,
  cfg: SubstrateNetConfig,
  opts: EnrichOpts = {},
): Promise<EnrichFusedResult> {
  const stats: Partial<EnrichStats> = {
    technicalSkills: 0,
    agentRelationships: 0,
    agentGaps: 0,
    industryConcepts: 0,
    externalUpgrades: 0,
    domainHighlights: 0,
    architectureComponents: 0,
    architectureRelationships: 0,
    businessDomains: 0,
    techDomains: 0,
  };

  let dedupe: DedupeAgent | undefined;
  try { dedupe = new DedupeAgent(cfg); } catch { dedupe = undefined; }

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const now = Date.now();
  let producedClusterableFacts = false;
  let industry: string | undefined;

  const domainPayload = buildDomainFuserPayload(knowDb, codeDb, root);
  if (domainPayload) {
    try {
      const out = await rt.run(DOMAIN_FUSER_AGENT, { payload: domainPayload });
      const titleToId = new Map<string, string>();
      for (const e of domainPayload.entities) titleToId.set(e.title.toLowerCase(), e.id);

      const bizTitleToId = titleIdMap(knowDb, domainPayload.businessItems.map((i) => i.title));
      const techTitleToId = titleIdMap(knowDb, domainPayload.techItems.map((i) => i.title));

      const tx = knowDb.transaction(() => {
        for (const r of out.output.relationships) {
          const from = titleToId.get(r.from.toLowerCase());
          const to = titleToId.get(r.to.toLowerCase());
          if (!from || !to) continue;
          if (insertKEdgeUnique(knowDb, {
            source: from, target: to, kind: r.kind as KEdgeKind, weight: 1,
            metadata: { via: 'fused', grounding: 'stated', evidence: r.evidence },
          })) stats.agentRelationships = (stats.agentRelationships ?? 0) + 1;
        }
        for (const g of out.output.gaps) {
          upsertKNode(knowDb, {
            id: gapId(`fused:${g.title}`), kind: 'knowledge_gap', title: g.title,
            summary: g.why, evidenceText: g.evidence,
            confidence: out.confidence, source: 'agent:domainFuser', grounding: 'stated',
            agentModel: out.model, createdAt: now, updatedAt: now,
          });
          stats.agentGaps = (stats.agentGaps ?? 0) + 1;
        }
      });
      tx();

      const grounding: KNode['grounding'] = 'model';
      for (const h of out.output.highlights) {
        const id = createHash('sha1').update(`highlight|${h.statement.toLowerCase()}`).digest('hex').slice(0, 16);
        const node: KNode = {
          id, kind: 'domain_highlight', title: h.statement,
          summary: 'Portfolio highlight (fused)',
          evidenceText: h.evidence,
          confidence: out.confidence, source: 'agent:domainFuser',
          grounding, scope: 'industry', agentModel: out.model,
          createdAt: now, updatedAt: now,
        };
        upsertKNode(knowDb, node);
        await embedFact(dedupe, knowDb, node);
        stats.domainHighlights = (stats.domainHighlights ?? 0) + 1;
        producedClusterableFacts = true;
      }

      stats.businessDomains = await persistFusedDomains(
        knowDb, dedupe, out.model, out.confidence, now,
        'business_domain', 'industry', 'agent:domainFuser', bizTitleToId,
        out.output.businessDomains,
      );
      stats.techDomains = await persistFusedDomains(
        knowDb, dedupe, out.model, out.confidence, now,
        'tech_domain', 'technical', 'agent:domainFuser', techTitleToId,
        out.output.techDomains,
      );
    } catch { /* backend down */ }
  }

  const industryPayload = buildIndustryFuserPayload(knowDb, codeDb, root);
  if (industryPayload) {
    try {
      const out = await rt.run(INDUSTRY_FUSER_AGENT, { payload: industryPayload });
      const o = out.output;
      if (o.industry && o.industry.toLowerCase() !== 'unknown') {
        industry = o.industry;
        const grounding = o.confidence >= 0.7 && o.evidence ? 'corroborated' : 'stated';
        const id = createHash('sha1').update(`industry|${o.industry.toLowerCase()}`).digest('hex').slice(0, 16);
        knowDb.transaction(() => {
          upsertKNode(knowDb, {
            id, kind: 'industry', title: o.industry,
            summary: o.domains?.length ? `Domains: ${o.domains.join(', ')}` : undefined,
            evidenceText: o.evidence,
            confidence: o.confidence, source: 'agent:industryFuser',
            grounding, scope: 'industry', agentModel: out.model,
            createdAt: now, updatedAt: now,
          });
          knowDb.prepare(`
            UPDATE k_nodes SET scope='industry'
            WHERE kind IN ('business_rule','constraint','entity') AND (scope IS NULL OR scope='meta')
          `).run();
        })();
        stats.industry = o.industry;
      }

      for (const s of o.skills) {
        const id = createHash('sha1').update(`skill|${s.name.toLowerCase()}`).digest('hex').slice(0, 16);
        const node: KNode = {
          id, kind: 'skill', title: s.name,
          summary: `${s.kind} skill (evidence: ${s.evidence})`,
          evidenceText: s.evidence,
          confidence: out.confidence, source: 'agent:industryFuser',
          grounding: 'structural', scope: 'technical', agentModel: out.model,
          createdAt: now, updatedAt: now,
        };
        upsertKNode(knowDb, node);
        await embedFact(dedupe, knowDb, node);
        stats.technicalSkills = (stats.technicalSkills ?? 0) + 1;
        producedClusterableFacts = true;
      }

      const titleToId = titleIdMap(knowDb, industryPayload.entities);

      for (const c of o.components) {
        const id = domainNodeId('component', c.name);
        const node: KNode = {
          id, kind: 'entity', title: c.name,
          summary: c.summary ?? (c.layer ? `Architecture component (${c.layer})` : 'Architecture component'),
          evidenceText: c.evidence,
          confidence: out.confidence, source: 'agent:industryFuser',
          grounding: 'stated', scope: 'technical', agentModel: out.model,
          createdAt: now, updatedAt: now,
        };
        upsertKNode(knowDb, node);
        await embedFact(dedupe, knowDb, node);
        titleToId.set(c.name.toLowerCase(), id);
        stats.architectureComponents = (stats.architectureComponents ?? 0) + 1;
        producedClusterableFacts = true;
      }

      knowDb.transaction(() => {
        for (const r of o.relations) {
          const from = titleToId.get(r.from.toLowerCase());
          const to = titleToId.get(r.to.toLowerCase());
          if (!from || !to || from === to) continue;
          if (insertKEdgeUnique(knowDb, {
            source: from, target: to, kind: r.kind as KEdgeKind, weight: 1,
            metadata: { via: 'fused', grounding: 'stated', evidence: r.evidence },
          })) stats.architectureRelationships = (stats.architectureRelationships ?? 0) + 1;
        }
      })();

      if (!opts.noEnrichIndustry && industry && o.glossary.length > 0) {
        const backend = createResearchBackend(cfg);
        for (const item of o.glossary) {
          const id = createHash('sha1').update(`industry-std|${industry}|${item.title.toLowerCase()}`).digest('hex').slice(0, 16);
          let grounding: 'model' | 'external' = 'model';
          let evidence = `Industry-standard in ${industry}. ${item.basis}`;
          let sourceUrl: string | undefined;
          const research = await cachedLookup(knowDb, backend, `${industry}: ${item.title}`);
          if (research) {
            grounding = 'external';
            evidence = research.summary;
            sourceUrl = research.sourceUrl;
            stats.externalUpgrades = (stats.externalUpgrades ?? 0) + 1;
          }
          const node: KNode = {
            id, kind: 'glossary_term', title: item.title,
            summary: item.description, evidenceText: evidence,
            confidence: out.confidence, source: 'agent:industryFuser',
            grounding, scope: 'industry', sourceUrl, agentModel: out.model,
            createdAt: now, updatedAt: now,
          };
          upsertKNode(knowDb, node);
          await embedFact(dedupe, knowDb, node);
          stats.industryConcepts = (stats.industryConcepts ?? 0) + 1;
          producedClusterableFacts = true;
        }
      }
    } catch { /* backend down */ }
  }

  return { ...stats, producedClusterableFacts };
}

function titleIdMap(knowDb: SqliteDb, titles: string[]): Map<string, string> {
  const m = new Map<string, string>();
  if (titles.length === 0) return m;
  const rows = knowDb.prepare(`
    SELECT id, title FROM k_nodes WHERE title IN (${titles.map(() => '?').join(',')})
  `).all(...titles) as Array<{ id: string; title: string }>;
  for (const r of rows) m.set(r.title.toLowerCase(), r.id);
  return m;
}

async function persistFusedDomains(
  knowDb: SqliteDb,
  dedupe: DedupeAgent | undefined,
  model: string,
  confidence: number,
  now: number,
  kind: 'business_domain' | 'tech_domain',
  scope: 'industry' | 'technical',
  source: string,
  titleToId: Map<string, string>,
  domains: Array<{ name: string; summary?: string; members: string[] }>,
): Promise<number> {
  let count = 0;
  for (const d of domains) {
    const id = domainNodeId(kind, d.name);
    const node: KNode = {
      id, kind, title: d.name,
      summary: d.summary, evidenceText: d.members?.slice(0, 8).join(', '),
      confidence, source, grounding: 'stated', scope, agentModel: model,
      createdAt: now, updatedAt: now,
    };
    upsertKNode(knowDb, node);
    await embedFact(dedupe, knowDb, node);
    count++;
    knowDb.transaction(() => {
      for (const member of d.members ?? []) {
        const mid = titleToId.get(member.toLowerCase());
        if (!mid || mid === id) continue;
        insertKEdgeUnique(knowDb, {
          source: mid, target: id, kind: 'part_of', weight: 1,
          metadata: { via: kind, grounding: 'stated' },
        });
      }
    })();
  }
  return count;
}
