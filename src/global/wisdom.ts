/**
 * L6 — Wisdom synthesis (the top of the DIKW pyramid).
 *
 * Gathers the aggregated L5 second brain from global.db (skills, industries,
 * business/tech domains, cross-project concepts, highlights) plus per-project
 * knowledge gaps, then asks the WisdomSynthesizer agent (frontier -> flash ->
 * local) to classify it into proficiency-leveled competency areas, distill
 * cross-project insights, and name gaps. When no LLM backend is available the
 * `deterministicWisdom` fallback fills the same shape with keyword grouping and
 * weight-bucketed levels, so the layer always renders offline.
 *
 * Everything produced here is inference (`model` grounding) and is regenerated
 * (clear + insert) on each run — kept separate from project truth.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { openKnowledgeDb } from '../db/connection.js';
import { projectConfigDir, type SubstrateNetConfig } from '../config.js';
import { listSkills, listIndustries, listHighlights, normalizeSkill } from './skills.js';
import { dominantGrounding } from '../knowledge/scope.js';
import { AgentRuntime } from '../agents/runtime.js';
import {
  WISDOM_SYNTHESIZER_AGENT,
  type WisdomSynthesizerPayload,
  type WisdomSynthesizerOutput,
} from '../agents/wisdom-synthesizer.js';

export const PROFICIENCY_LEVELS = [
  'novice', 'advanced_beginner', 'competent', 'proficient', 'expert',
] as const;
export type ProficiencyLevel = (typeof PROFICIENCY_LEVELS)[number];

interface ResolvedSkill {
  id: string; name: string; weight: number; grounding: string; projectCount: number;
}

interface GatheredWisdom {
  payload: WisdomSynthesizerPayload;
  /** Skill rows keyed by normalized name, for resolving competency members. */
  skillMap: Map<string, ResolvedSkill>;
}

export interface WisdomStats {
  competencies: number;
  insights: number;
  gaps: number;
  /** Model ref that produced it, or 'deterministic'. */
  source: string;
}

// ============================================================================
// Gather
// ============================================================================

/** Collect the synthesis inputs from global.db + per-project knowledge gaps. */
export function gatherWisdomInput(gdb: SqliteDb): GatheredWisdom {
  const projectCount = (gdb.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n;

  const allSkills = listSkills(gdb, { scope: 'technical', limit: 500 });
  const skillMap = new Map<string, ResolvedSkill>();
  for (const s of allSkills) {
    skillMap.set(normalizeSkill(s.name), {
      id: s.id, name: s.name, weight: s.evidenceWeight, grounding: s.grounding, projectCount: s.projectCount,
    });
  }

  const industries = listIndustries(gdb).map((i) => ({ name: i.name, projectCount: i.projectCount }));
  const highlights = listHighlights(gdb).map((h) => ({ statement: h.statement, grounding: h.grounding }));

  const businessDomains = (gdb.prepare(`
    SELECT MIN(name) AS name, MIN(summary) AS summary FROM business_domains GROUP BY id
  `).all() as Array<{ name: string; summary: string | null }>)
    .map((d) => ({ name: d.name, summary: d.summary ?? undefined }));
  const techDomains = (gdb.prepare(`
    SELECT MIN(name) AS name, MIN(summary) AS summary FROM tech_domains GROUP BY id
  `).all() as Array<{ name: string; summary: string | null }>)
    .map((d) => ({ name: d.name, summary: d.summary ?? undefined }));

  const concepts = (gdb.prepare(`
    SELECT name, MIN(summary) AS summary, COUNT(DISTINCT project_id) AS c
    FROM concepts_global GROUP BY lower(name) ORDER BY c DESC LIMIT 40
  `).all() as Array<{ name: string; summary: string | null; c: number }>)
    .map((r) => ({ name: r.name, summary: r.summary ?? undefined }));

  const gaps = gatherProjectGaps(gdb);

  const payload: WisdomSynthesizerPayload = {
    projectCount,
    industries,
    skills: allSkills.slice(0, 80).map((s) => ({
      name: s.name, weight: s.evidenceWeight, grounding: s.grounding, projectCount: s.projectCount, kind: s.kind,
    })),
    businessDomains,
    techDomains,
    concepts,
    highlights,
    gaps,
  };
  return { payload, skillMap };
}

/** Read deterministic `knowledge_gap` nodes from each registered project's db. */
function gatherProjectGaps(gdb: SqliteDb): Array<{ title: string; summary?: string }> {
  const projects = gdb.prepare(`SELECT path FROM projects`).all() as Array<{ path: string }>;
  const seen = new Set<string>();
  const gaps: Array<{ title: string; summary?: string }> = [];
  for (const p of projects) {
    if (!existsSync(projectConfigDir(p.path))) continue;
    try {
      const know = openKnowledgeDb(p.path);
      try {
        const rows = know.prepare(`
          SELECT title, summary FROM k_nodes WHERE kind='knowledge_gap' LIMIT 50
        `).all() as Array<{ title: string; summary: string | null }>;
        for (const r of rows) {
          const key = r.title.toLowerCase().trim();
          if (seen.has(key)) continue;
          seen.add(key);
          gaps.push({ title: r.title, summary: r.summary ?? undefined });
          if (gaps.length >= 30) return gaps;
        }
      } finally {
        know.close();
      }
    } catch { /* skip projects whose db can't be opened */ }
  }
  return gaps;
}

// ============================================================================
// Deterministic fallback (pure — unit-testable)
// ============================================================================

interface AreaRule { area: string; category: string; patterns: RegExp }

/** Keyword routing for the offline competency grouping. Order matters. */
const AREA_RULES: AreaRule[] = [
  { area: 'AI / ML & Agents', category: 'AI & Data', patterns: /\b(llm|gpt|ml|machine learning|ai|agent|embedding|rag|vector|prompt|tensorflow|pytorch|nlp)\b/i },
  { area: 'Data & Analytics', category: 'AI & Data', patterns: /\b(sql|postgres|mysql|sqlite|kafka|redis|etl|warehouse|analytics|pandas|spark|database|bigquery|snowflake|mongodb|elasticsearch)\b/i },
  { area: 'Infrastructure & DevOps', category: 'Platform', patterns: /\b(docker|kubernetes|k8s|terraform|aws|gcp|azure|ci\/cd|ci|cd|jenkins|ansible|helm|nginx|linux|devops|cloud|serverless|lambda)\b/i },
  { area: 'Security', category: 'Platform', patterns: /\b(security|auth|oauth|jwt|encryption|tls|ssl|vault|iam|rbac|owasp)\b/i },
  { area: 'Frontend & UX', category: 'Product', patterns: /\b(react|vue|angular|svelte|css|html|tailwind|next\.?js|frontend|ui|ux)\b/i },
  { area: 'Backend & APIs', category: 'Product', patterns: /\b(node|express|fastapi|django|flask|rails|spring|go|golang|rust|java|python|api|rest|grpc|graphql|backend|microservice|php|\.net|c#)\b/i },
];

const GENERAL_AREA = 'General Engineering';

/** Map a single skill name to a competency area (deterministic). */
export function categorizeSkill(name: string): { area: string; category: string } {
  for (const rule of AREA_RULES) {
    if (rule.patterns.test(name)) return { area: rule.area, category: rule.category };
  }
  return { area: GENERAL_AREA, category: 'Foundations' };
}

/** Bucket an aggregate (weight, projectCount) into a Dreyfus proficiency level. */
export function levelFor(weight: number, projectCount: number): ProficiencyLevel {
  if (weight >= 12 || projectCount >= 4) return 'expert';
  if (weight >= 6 || projectCount >= 3) return 'proficient';
  if (weight >= 3 || projectCount >= 2) return 'competent';
  if (weight >= 1) return 'advanced_beginner';
  return 'novice';
}

/**
 * Build a wisdom output deterministically (no LLM): keyword grouping, weight
 * bucketed levels, insights from cross-project strengths, gaps passed through.
 */
export function deterministicWisdom(payload: WisdomSynthesizerPayload): WisdomSynthesizerOutput {
  const groups = new Map<string, { area: string; category: string; skills: WisdomSynthesizerPayload['skills'] }>();
  for (const s of payload.skills) {
    const { area, category } = categorizeSkill(s.name);
    let g = groups.get(area);
    if (!g) { g = { area, category, skills: [] }; groups.set(area, g); }
    g.skills.push(s);
  }

  const competencies = [...groups.values()]
    .map((g) => {
      const weight = g.skills.reduce((acc, s) => acc + s.weight, 0);
      const projectCount = g.skills.reduce((acc, s) => Math.max(acc, s.projectCount), 0);
      return {
        area: g.area,
        category: g.category,
        level: levelFor(weight, projectCount) as string,
        summary: `${g.skills.length} skill(s) evidenced across your projects.`,
        skills: g.skills.sort((a, b) => b.weight - a.weight).map((s) => s.name),
        confidence: 0.4,
      };
    })
    .sort((a, b) => b.skills.length - a.skills.length);

  const topAreas = competencies.slice(0, 3).map((c) => c.area);
  const topIndustries = payload.industries.slice(0, 3).map((i) => i.name);
  const headline = topAreas.length
    ? `Engineer working across ${topIndustries.join(', ') || 'multiple domains'}, strongest in ${topAreas.slice(0, 2).join(' and ')}.`
    : 'Cross-project knowledge profile.';
  const narrative = `Across ${payload.projectCount} project(s): ${competencies.length} competency area(s)` +
    (topAreas.length ? `, led by ${topAreas.join(', ')}.` : '.');

  // Insights: cross-project (multi-project) skills are the most defensible strengths.
  const crossSkills = payload.skills.filter((s) => s.projectCount > 1)
    .sort((a, b) => b.projectCount - a.projectCount).slice(0, 6);
  const insights: WisdomSynthesizerOutput['insights'] = [];
  if (crossSkills.length) {
    insights.push({
      title: 'Consistent cross-project strengths',
      body: `${crossSkills.map((s) => s.name).join(', ')} recur across multiple projects — your most defensible competencies.`,
      kind: 'insight',
      evidence: `${crossSkills.length} skill(s) evidenced in 2+ projects`,
      confidence: 0.4,
    });
  }
  for (const h of payload.highlights.slice(0, 4)) {
    insights.push({ title: h.statement, kind: 'principle', evidence: h.grounding, confidence: 0.4 });
  }

  const gaps: WisdomSynthesizerOutput['gaps'] = payload.gaps.slice(0, 6).map((g) => ({
    title: g.title,
    summary: g.summary,
    recommendation: 'Document the governing rules and add corroborating code or tests to close this gap.',
    severity: 'medium',
  }));

  return { headline, narrative, competencies, insights, gaps };
}

// ============================================================================
// Persist
// ============================================================================

function hashId(prefix: string, s: string): string {
  return createHash('sha1').update(`${prefix}|${s.toLowerCase()}`).digest('hex').slice(0, 16);
}

const LEVEL_ALIASES: Array<[RegExp, ProficiencyLevel]> = [
  [/expert|master|lead/i, 'expert'],
  [/proficient|advanced(?!\s*beginner)|senior/i, 'proficient'],
  [/advanced\s*beginner|adv.?beginner/i, 'advanced_beginner'],
  [/competent|intermediate|working/i, 'competent'],
  [/novice|beginner|basic|learning/i, 'novice'],
];

/** Coerce an arbitrary level string to one of the five Dreyfus tiers. */
export function normalizeLevel(raw: string | undefined): ProficiencyLevel {
  if (!raw) return 'competent';
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((PROFICIENCY_LEVELS as readonly string[]).includes(v)) return v as ProficiencyLevel;
  for (const [re, level] of LEVEL_ALIASES) if (re.test(raw)) return level;
  return 'competent';
}

function persistWisdom(
  gdb: SqliteDb,
  output: WisdomSynthesizerOutput,
  meta: { model: string; confidence: number; skillMap: Map<string, ResolvedSkill> },
): WisdomStats {
  const now = Date.now();
  const { skillMap } = meta;

  const tx = gdb.transaction(() => {
    gdb.prepare(`DELETE FROM wisdom_meta`).run();
    gdb.prepare(`DELETE FROM competency_skills`).run();
    gdb.prepare(`DELETE FROM competency_groups`).run();
    gdb.prepare(`DELETE FROM wisdom_insights`).run();
    gdb.prepare(`DELETE FROM wisdom_gaps`).run();

    gdb.prepare(`
      INSERT INTO wisdom_meta (id, headline, narrative, model, grounding, confidence, generated_at)
      VALUES (1, ?, ?, ?, 'model', ?, ?)
    `).run(output.headline || null, output.narrative || null, meta.model, meta.confidence, now);

    const insGroup = gdb.prepare(`
      INSERT INTO competency_groups (id, name, category, level, summary, weight, project_count, grounding, rank, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, level=excluded.level,
        summary=excluded.summary, weight=excluded.weight, project_count=excluded.project_count,
        grounding=excluded.grounding, rank=excluded.rank, updated_at=excluded.updated_at
    `);
    const insSkill = gdb.prepare(`
      INSERT INTO competency_skills (group_id, skill_id, skill_name, level, weight)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(group_id, skill_name) DO UPDATE SET skill_id=excluded.skill_id, level=excluded.level, weight=excluded.weight
    `);

    let rank = 0;
    for (const c of output.competencies) {
      const id = hashId('cg', c.area);
      const members = (c.skills ?? [])
        .map((name) => ({ name, row: skillMap.get(normalizeSkill(name)) }));
      const weight = members.reduce((acc, m) => acc + (m.row?.weight ?? 0), 0);
      const projectCount = members.reduce((acc, m) => Math.max(acc, m.row?.projectCount ?? 0), 0);
      const grounding = dominantGrounding(members.map((m) => m.row?.grounding).filter(Boolean) as string[]);
      const level = normalizeLevel(c.level) || levelFor(weight, projectCount);
      insGroup.run(id, c.area, c.category ?? null, level, c.summary ?? null,
        round2(weight), projectCount, grounding ?? null, rank++, now);
      const seen = new Set<string>();
      for (const m of members) {
        const key = m.name.toLowerCase().trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        insSkill.run(id, m.row?.id ?? null, m.name, levelFor(m.row?.weight ?? 0, m.row?.projectCount ?? 0), round2(m.row?.weight ?? 0));
      }
    }

    const insInsight = gdb.prepare(`
      INSERT INTO wisdom_insights (id, kind, title, body, evidence, grounding, confidence, rank, updated_at)
      VALUES (?, ?, ?, ?, ?, 'model', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, body=excluded.body, evidence=excluded.evidence,
        confidence=excluded.confidence, rank=excluded.rank, updated_at=excluded.updated_at
    `);
    rank = 0;
    for (const i of output.insights ?? []) {
      if (!i.title) continue;
      insInsight.run(hashId('wi', i.title), i.kind === 'principle' ? 'principle' : 'insight',
        i.title, i.body ?? null, i.evidence ?? null, i.confidence ?? null, rank++, now);
    }

    const insGap = gdb.prepare(`
      INSERT INTO wisdom_gaps (id, title, summary, recommendation, area, severity, grounding, source, rank, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'model', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET summary=excluded.summary, recommendation=excluded.recommendation,
        area=excluded.area, severity=excluded.severity, source=excluded.source, rank=excluded.rank, updated_at=excluded.updated_at
    `);
    rank = 0;
    const source = meta.model === 'deterministic' ? 'gap:detector' : 'agent:wisdomSynthesizer';
    for (const g of output.gaps ?? []) {
      if (!g.title) continue;
      insGap.run(hashId('wg', g.title), g.title, g.summary ?? null, g.recommendation ?? null,
        g.area ?? null, g.severity ?? null, source, rank++, now);
    }
  });
  tx();

  return {
    competencies: output.competencies.length,
    insights: (output.insights ?? []).length,
    gaps: (output.gaps ?? []).length,
    source: meta.model,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ============================================================================
// Orchestration
// ============================================================================

export interface SynthesizeWisdomResult extends WisdomStats { warnings: string[] }

/**
 * Synthesize and persist the L6 wisdom layer into global.db. Tries the
 * WisdomSynthesizer agent (cached in global.db agent_runs); falls back to the
 * deterministic grouping when no backend is available or the output is empty.
 */
export async function synthesizeWisdom(gdb: SqliteDb, cfg: SubstrateNetConfig): Promise<SynthesizeWisdomResult> {
  const warnings: string[] = [];
  const gathered = gatherWisdomInput(gdb);

  // Nothing to synthesize yet — clear any stale layer and report empty.
  if (gathered.payload.skills.length === 0 && gathered.payload.industries.length === 0 && gathered.payload.highlights.length === 0) {
    persistWisdom(gdb, { headline: '', narrative: '', competencies: [], insights: [], gaps: [] },
      { model: 'deterministic', confidence: 0, skillMap: gathered.skillMap });
    return { competencies: 0, insights: 0, gaps: 0, source: 'empty', warnings };
  }

  let output: WisdomSynthesizerOutput | undefined;
  let model = 'deterministic';
  let confidence = 0.4;
  try {
    const rt = new AgentRuntime({ knowledgeDb: gdb, config: cfg });
    const res = await rt.run(WISDOM_SYNTHESIZER_AGENT, { payload: gathered.payload });
    if (res.output.headline && res.output.competencies.length > 0) {
      output = res.output;
      model = res.model;
      confidence = res.confidence;
    } else {
      warnings.push('wisdom: agent returned empty output; used deterministic fallback');
    }
  } catch (e) {
    warnings.push(`wisdom: synthesis agent unavailable (${(e as Error).message}); used deterministic fallback`);
  }

  if (!output) {
    output = deterministicWisdom(gathered.payload);
    model = 'deterministic';
    confidence = 0.4;
  }

  const stats = persistWisdom(gdb, output, { model, confidence, skillMap: gathered.skillMap });
  return { ...stats, warnings };
}

// ============================================================================
// Read
// ============================================================================

export interface WisdomCompetencySnapshot {
  id: string; name: string; category?: string; level: string; summary?: string;
  weight: number; projectCount: number; grounding?: string;
  skills: Array<{ name: string; level?: string; weight: number }>;
}
export interface WisdomInsightSnapshot {
  id: string; kind: string; title: string; body?: string; evidence?: string; grounding?: string; confidence?: number;
}
export interface WisdomGapSnapshot {
  id: string; title: string; summary?: string; recommendation?: string; area?: string; severity?: string; grounding?: string; source?: string;
}
export interface WisdomSnapshot {
  headline?: string;
  narrative?: string;
  model?: string;
  grounding?: string;
  confidence?: number;
  generatedAt?: number;
  competencies: WisdomCompetencySnapshot[];
  insights: WisdomInsightSnapshot[];
  gaps: WisdomGapSnapshot[];
}

/** Read the persisted wisdom layer for the dashboard snapshot. */
export function listWisdom(gdb: SqliteDb): WisdomSnapshot {
  const meta = gdb.prepare(`
    SELECT headline, narrative, model, grounding, confidence, generated_at FROM wisdom_meta WHERE id=1
  `).get() as
    | { headline: string | null; narrative: string | null; model: string | null; grounding: string | null; confidence: number | null; generated_at: number }
    | undefined;

  const groups = gdb.prepare(`
    SELECT id, name, category, level, summary, weight, project_count, grounding
    FROM competency_groups ORDER BY rank ASC
  `).all() as Array<{ id: string; name: string; category: string | null; level: string | null; summary: string | null; weight: number; project_count: number; grounding: string | null }>;
  const memberRows = gdb.prepare(`
    SELECT group_id, skill_name, level, weight FROM competency_skills
  `).all() as Array<{ group_id: string; skill_name: string; level: string | null; weight: number }>;
  const membersByGroup = new Map<string, Array<{ name: string; level?: string; weight: number }>>();
  for (const m of memberRows) {
    const list = membersByGroup.get(m.group_id) ?? [];
    list.push({ name: m.skill_name, level: m.level ?? undefined, weight: m.weight });
    membersByGroup.set(m.group_id, list);
  }

  const competencies: WisdomCompetencySnapshot[] = groups.map((g) => ({
    id: g.id, name: g.name, category: g.category ?? undefined, level: g.level ?? 'competent',
    summary: g.summary ?? undefined, weight: g.weight, projectCount: g.project_count, grounding: g.grounding ?? undefined,
    skills: (membersByGroup.get(g.id) ?? []).sort((a, b) => b.weight - a.weight),
  }));

  const insights = (gdb.prepare(`
    SELECT id, kind, title, body, evidence, grounding, confidence FROM wisdom_insights ORDER BY rank ASC
  `).all() as Array<{ id: string; kind: string; title: string; body: string | null; evidence: string | null; grounding: string | null; confidence: number | null }>)
    .map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body ?? undefined, evidence: r.evidence ?? undefined, grounding: r.grounding ?? undefined, confidence: r.confidence ?? undefined }));

  const gaps = (gdb.prepare(`
    SELECT id, title, summary, recommendation, area, severity, grounding, source FROM wisdom_gaps ORDER BY rank ASC
  `).all() as Array<{ id: string; title: string; summary: string | null; recommendation: string | null; area: string | null; severity: string | null; grounding: string | null; source: string | null }>)
    .map((r) => ({ id: r.id, title: r.title, summary: r.summary ?? undefined, recommendation: r.recommendation ?? undefined, area: r.area ?? undefined, severity: r.severity ?? undefined, grounding: r.grounding ?? undefined, source: r.source ?? undefined }));

  return {
    headline: meta?.headline ?? undefined,
    narrative: meta?.narrative ?? undefined,
    model: meta?.model ?? undefined,
    grounding: meta?.grounding ?? undefined,
    confidence: meta?.confidence ?? undefined,
    generatedAt: meta?.generated_at ?? undefined,
    competencies,
    insights,
    gaps,
  };
}
