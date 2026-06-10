/**
 * L6 — Wisdom synthesis (the top of the DIKW pyramid).
 *
 * Runs AFTER the PARA organizer (see organize.ts), which owns competency areas
 * and the subject/topic taxonomy. This module synthesizes the evaluated
 * judgment on top of that structure: a headline + narrative, cross-project
 * insights/principles, and named gaps. It reads the organized competency AREAS
 * from global.db as input context and never re-groups them.
 *
 * The WisdomSynthesizer agent (frontier -> flash -> local) produces the
 * judgment; `deterministicWisdom` fills the same shape from the organized areas
 * + cross-project skills + highlights when no LLM backend is available.
 *
 * Everything produced here is inference (`model` grounding) and is regenerated
 * (clear + insert) on each run — kept separate from project truth.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { openKnowledgeDb } from '../db/connection.js';
import { projectConfigDir, type SubstrateNetConfig } from '../config.js';
import { listSkills, listIndustries, listHighlights } from './skills.js';
import { AgentRuntime } from '../agents/runtime.js';
import {
  WISDOM_SYNTHESIZER_AGENT,
  type WisdomSynthesizerPayload,
  type WisdomSynthesizerOutput,
  type WisdomAreaInput,
} from '../agents/wisdom-synthesizer.js';

interface GatheredWisdom {
  payload: WisdomSynthesizerPayload;
}

export interface WisdomStats {
  insights: number;
  gaps: number;
  /** Model ref that produced it, or 'deterministic'. */
  source: string;
}

/** Display order rank for the Dreyfus tiers (higher = stronger). */
const LEVEL_RANK: Record<string, number> = {
  expert: 5, proficient: 4, competent: 3, advanced_beginner: 2, novice: 1,
};

// ============================================================================
// Gather
// ============================================================================

/** Read the organized competency areas (populated by the PARA organizer). */
function readAreas(gdb: SqliteDb): WisdomAreaInput[] {
  return (gdb.prepare(`
    SELECT name, level, summary FROM competency_groups ORDER BY rank ASC
  `).all() as Array<{ name: string; level: string | null; summary: string | null }>)
    .map((a) => ({ name: a.name, level: a.level ?? 'competent', summary: a.summary ?? undefined }));
}

/** Collect the synthesis inputs from global.db + per-project knowledge gaps. */
export function gatherWisdomInput(gdb: SqliteDb): GatheredWisdom {
  const projectCount = (gdb.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n;
  const allSkills = listSkills(gdb, { scope: 'technical', limit: 500 });
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

  const payload: WisdomSynthesizerPayload = {
    projectCount,
    industries,
    skills: allSkills.slice(0, 80).map((s) => ({
      name: s.name, weight: s.evidenceWeight, grounding: s.grounding, projectCount: s.projectCount, kind: s.kind,
    })),
    areas: readAreas(gdb),
    businessDomains,
    techDomains,
    concepts,
    highlights,
    gaps: gatherProjectGaps(gdb),
  };
  return { payload };
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

/**
 * Build a wisdom output deterministically (no LLM) from the organized areas +
 * cross-project skills + highlights. Produces headline/narrative/insights/gaps;
 * competency grouping is owned upstream by the organizer.
 */
export function deterministicWisdom(payload: WisdomSynthesizerPayload): WisdomSynthesizerOutput {
  const rankedAreas = [...payload.areas].sort((a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0));
  const topAreas = rankedAreas.slice(0, 3).map((a) => a.name);
  const topIndustries = payload.industries.slice(0, 3).map((i) => i.name);

  const headline = topAreas.length
    ? `Engineer working across ${topIndustries.join(', ') || 'multiple domains'}, strongest in ${topAreas.slice(0, 2).join(' and ')}.`
    : 'Cross-project knowledge profile.';
  const narrative = `Across ${payload.projectCount} project(s): ${payload.areas.length} competency area(s)` +
    (topAreas.length ? `, led by ${topAreas.join(', ')}.` : '.');

  const insights: WisdomSynthesizerOutput['insights'] = [];
  const crossSkills = payload.skills.filter((s) => s.projectCount > 1)
    .sort((a, b) => b.projectCount - a.projectCount).slice(0, 6);
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

  return { headline, narrative, insights, gaps };
}

// ============================================================================
// Persist
// ============================================================================

function hashId(prefix: string, s: string): string {
  return createHash('sha1').update(`${prefix}|${s.toLowerCase()}`).digest('hex').slice(0, 16);
}

function persistWisdom(
  gdb: SqliteDb,
  output: WisdomSynthesizerOutput,
  meta: { model: string; confidence: number },
): WisdomStats {
  const now = Date.now();

  const tx = gdb.transaction(() => {
    gdb.prepare(`DELETE FROM wisdom_meta`).run();
    gdb.prepare(`DELETE FROM wisdom_insights`).run();
    gdb.prepare(`DELETE FROM wisdom_gaps`).run();

    gdb.prepare(`
      INSERT INTO wisdom_meta (id, headline, narrative, model, grounding, confidence, generated_at)
      VALUES (1, ?, ?, ?, 'model', ?, ?)
    `).run(output.headline || null, output.narrative || null, meta.model, meta.confidence, now);

    const insInsight = gdb.prepare(`
      INSERT INTO wisdom_insights (id, kind, title, body, evidence, grounding, confidence, rank, updated_at)
      VALUES (?, ?, ?, ?, ?, 'model', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, body=excluded.body, evidence=excluded.evidence,
        confidence=excluded.confidence, rank=excluded.rank, updated_at=excluded.updated_at
    `);
    let rank = 0;
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
    insights: (output.insights ?? []).length,
    gaps: (output.gaps ?? []).length,
    source: meta.model,
  };
}

// ============================================================================
// Orchestration
// ============================================================================

export interface SynthesizeWisdomResult extends WisdomStats { warnings: string[] }

/**
 * Synthesize and persist the L6 wisdom layer into global.db. Tries the
 * WisdomSynthesizer agent (cached in global.db agent_runs); falls back to the
 * deterministic synthesis when no backend is available or the output is empty.
 * Run AFTER the PARA organizer so the competency areas are available as input.
 */
export async function synthesizeWisdom(gdb: SqliteDb, cfg: SubstrateNetConfig): Promise<SynthesizeWisdomResult> {
  const warnings: string[] = [];
  const { payload } = gatherWisdomInput(gdb);

  // Nothing to synthesize yet — clear any stale layer and report empty.
  if (payload.areas.length === 0 && payload.skills.length === 0 && payload.highlights.length === 0) {
    persistWisdom(gdb, { headline: '', narrative: '', insights: [], gaps: [] }, { model: 'deterministic', confidence: 0 });
    return { insights: 0, gaps: 0, source: 'empty', warnings };
  }

  let output: WisdomSynthesizerOutput | undefined;
  let model = 'deterministic';
  let confidence = 0.4;
  try {
    const rt = new AgentRuntime({ knowledgeDb: gdb, config: cfg });
    const res = await rt.run(WISDOM_SYNTHESIZER_AGENT, { payload });
    if (res.output.headline) {
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
    output = deterministicWisdom(payload);
    model = 'deterministic';
    confidence = 0.4;
  }

  const stats = persistWisdom(gdb, output, { model, confidence });
  return { ...stats, warnings };
}

// ============================================================================
// Read
// ============================================================================

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
    insights,
    gaps,
  };
}
