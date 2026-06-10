/**
 * PARA organization layer.
 *
 * Reorganizes the aggregated L5 second brain by ACTIONABILITY (PARA) crossed
 * with topic clustering, via the KnowledgeOrganizer agent (frontier -> flash ->
 * local). It classifies projects as active/archived from their session
 * activity, groups skills/domains into Dreyfus-leveled competency AREAS, and
 * clusters skills/concepts/domains into a unified SUBJECT -> TOPIC taxonomy
 * (the Resources library).
 *
 * When no LLM backend is available, `deterministicOrganize` fills the same shape
 * from structural data already in global.db — concept `domain` fields, the
 * business/tech domain tables, and skill `kind` — never keyword regex.
 *
 * Owns: para_projects, subjects, topics, topic_items, competency_groups,
 * competency_skills, area_refs. Everything is inference (`model` grounding),
 * regenerated (clear + insert) on each build.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { openKnowledgeDb } from '../db/connection.js';
import { projectConfigDir, type SubstrateNetConfig } from '../config.js';
import { listSkills } from './skills.js';
import { dominantGrounding } from '../knowledge/scope.js';
import { AgentRuntime } from '../agents/runtime.js';
import {
  KNOWLEDGE_ORGANIZER_AGENT,
  type KnowledgeOrganizerPayload,
  type KnowledgeOrganizerOutput,
  type OrgProjectInput,
} from '../agents/knowledge-organizer.js';

export const PROFICIENCY_LEVELS = [
  'novice', 'advanced_beginner', 'competent', 'proficient', 'expert',
] as const;
export type ProficiencyLevel = (typeof PROFICIENCY_LEVELS)[number];

/** A project is archived when its most recent session is older than this. */
const ARCHIVE_IDLE_DAYS = 90;
/** A session within this window counts as "recent" activity. */
const RECENT_WINDOW_DAYS = 30;

interface ResolvedSkill {
  id: string; name: string; weight: number; grounding: string; projectCount: number; kind?: string;
}

interface GatheredOrg {
  payload: KnowledgeOrganizerPayload;
  /** Skill rows keyed by normalized name, for resolving area + topic members. */
  skillMap: Map<string, ResolvedSkill>;
  /** Project name + id, keyed by id, for resolving area/project refs. */
  projectsById: Map<string, { id: string; name: string }>;
}

export interface OrganizeStats {
  projects: number;
  active: number;
  areas: number;
  subjects: number;
  topics: number;
  source: string;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ============================================================================
// Gather (activity-aware)
// ============================================================================

interface ProjectActivity { idleDays: number | null; recentSessions: number; totalSessions: number }

/** Read session activity for one project's knowledge.db. */
function projectActivity(path: string): ProjectActivity {
  const empty: ProjectActivity = { idleDays: null, recentSessions: 0, totalSessions: 0 };
  if (!existsSync(projectConfigDir(path))) return empty;
  try {
    const know = openKnowledgeDb(path);
    try {
      const now = Date.now();
      const recentCutoff = now - RECENT_WINDOW_DAYS * 86_400_000;
      const row = know.prepare(`
        SELECT COUNT(*) AS total,
               MAX(COALESCE(ended_at, started_at, ingested_at)) AS last_at,
               SUM(CASE WHEN COALESCE(ended_at, started_at, ingested_at) >= ? THEN 1 ELSE 0 END) AS recent
        FROM sessions
      `).get(recentCutoff) as { total: number; last_at: number | null; recent: number | null };
      const idleDays = row.last_at ? Math.max(0, Math.round((now - row.last_at) / 86_400_000)) : null;
      return { idleDays, recentSessions: row.recent ?? 0, totalSessions: row.total ?? 0 };
    } finally {
      know.close();
    }
  } catch {
    return empty;
  }
}

/** Collect the organizer inputs from global.db + per-project activity. */
export function gatherOrganizerInput(gdb: SqliteDb): GatheredOrg {
  const allSkills = listSkills(gdb, { scope: 'technical', limit: 500 });
  const skillMap = new Map<string, ResolvedSkill>();
  for (const s of allSkills) {
    skillMap.set(normalizeName(s.name), {
      id: s.id, name: s.name, weight: s.evidenceWeight, grounding: s.grounding, projectCount: s.projectCount, kind: s.kind,
    });
  }

  // Per-project industries + domains (for the project input context).
  const industriesByProject = new Map<string, string[]>();
  for (const r of gdb.prepare(`SELECT project_id, name FROM industries`).all() as Array<{ project_id: string; name: string }>) {
    const list = industriesByProject.get(r.project_id) ?? [];
    list.push(r.name); industriesByProject.set(r.project_id, list);
  }
  const domainsByProject = new Map<string, string[]>();
  for (const r of gdb.prepare(`
    SELECT project_id, name FROM business_domains
    UNION ALL SELECT project_id, name FROM tech_domains
  `).all() as Array<{ project_id: string; name: string }>) {
    const list = domainsByProject.get(r.project_id) ?? [];
    list.push(r.name); domainsByProject.set(r.project_id, list);
  }

  const projectRows = gdb.prepare(`SELECT id, name, path FROM projects`).all() as Array<{ id: string; name: string; path: string }>;
  const projectsById = new Map<string, { id: string; name: string }>();
  const projects: OrgProjectInput[] = projectRows.map((p) => {
    projectsById.set(p.id, { id: p.id, name: p.name });
    const act = projectActivity(p.path);
    return {
      id: p.id,
      name: p.name,
      idleDays: act.idleDays,
      recentSessions: act.recentSessions,
      totalSessions: act.totalSessions,
      industries: [...new Set(industriesByProject.get(p.id) ?? [])],
      domains: [...new Set(domainsByProject.get(p.id) ?? [])],
    };
  });

  const domains = [
    ...(gdb.prepare(`SELECT MIN(name) AS name, MIN(summary) AS summary FROM business_domains GROUP BY id`)
      .all() as Array<{ name: string; summary: string | null }>)
      .map((d) => ({ name: d.name, summary: d.summary ?? undefined, kind: 'business' as const })),
    ...(gdb.prepare(`SELECT MIN(name) AS name, MIN(summary) AS summary FROM tech_domains GROUP BY id`)
      .all() as Array<{ name: string; summary: string | null }>)
      .map((d) => ({ name: d.name, summary: d.summary ?? undefined, kind: 'tech' as const })),
  ];

  const concepts = (gdb.prepare(`
    SELECT name, MIN(summary) AS summary, MIN(domain) AS domain, COUNT(DISTINCT project_id) AS c
    FROM concepts_global GROUP BY lower(name) ORDER BY c DESC LIMIT 120
  `).all() as Array<{ name: string; summary: string | null; domain: string | null; c: number }>)
    .map((r) => ({ name: r.name, summary: r.summary ?? undefined, domain: r.domain ?? undefined }));

  const payload: KnowledgeOrganizerPayload = {
    projects,
    skills: allSkills.slice(0, 80).map((s) => ({
      name: s.name, weight: s.evidenceWeight, grounding: s.grounding, projectCount: s.projectCount, kind: s.kind,
    })),
    domains,
    concepts: concepts.map((c) => ({ name: c.name, summary: c.summary })),
  };

  // Stash concept→domain on the gathered object for the deterministic fallback.
  (payload as KnowledgeOrganizerPayload & { _conceptDomains?: Map<string, string> })._conceptDomains =
    new Map(concepts.filter((c) => c.domain).map((c) => [normalizeName(c.name), c.domain as string]));

  return { payload, skillMap, projectsById };
}

// ============================================================================
// Level helpers
// ============================================================================

/** Bucket an aggregate (weight, projectCount) into a Dreyfus proficiency level. */
export function levelFor(weight: number, projectCount: number): ProficiencyLevel {
  if (weight >= 12 || projectCount >= 4) return 'expert';
  if (weight >= 6 || projectCount >= 3) return 'proficient';
  if (weight >= 3 || projectCount >= 2) return 'competent';
  if (weight >= 1) return 'advanced_beginner';
  return 'novice';
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

/** Classify a project's actionability from real session activity (no keywords). */
export function projectStatus(idleDays: number | null): 'active' | 'archived' {
  if (idleDays === null) return 'archived';     // never seen locally
  return idleDays <= ARCHIVE_IDLE_DAYS ? 'active' : 'archived';
}

// ============================================================================
// Deterministic fallback (data-driven, not keyword-coded)
// ============================================================================

/** Human label for a skill `kind` (the structural grouping signal). */
const KIND_AREA: Record<string, string> = {
  language: 'Languages', framework: 'Frameworks', library: 'Libraries',
  tool: 'Tooling & Infrastructure', infra: 'Tooling & Infrastructure',
  dependency: 'Libraries', skill: 'Engineering Practices', domain: 'Domain Knowledge',
};
const KIND_FALLBACK_AREA = 'Engineering Practices';

/**
 * Build the PARA organization deterministically from structural fields:
 *   - projects: active/archived by session recency,
 *   - areas: skills grouped by their `kind`, leveled by aggregate weight,
 *   - subjects/topics: domains as topics (grouped business vs tech), concepts
 *     attached to their `domain` topic, skills grouped by kind.
 */
export function deterministicOrganize(payload: KnowledgeOrganizerPayload): KnowledgeOrganizerOutput {
  const conceptDomains: Map<string, string> =
    (payload as KnowledgeOrganizerPayload & { _conceptDomains?: Map<string, string> })._conceptDomains ?? new Map();

  // ── Projects: actionability from activity ────────────────────────────────
  const projects = payload.projects.map((p) => ({
    id: p.id,
    status: projectStatus(p.idleDays),
    focus: p.domains.length
      ? `Works across ${p.domains.slice(0, 3).join(', ')}.`
      : (p.industries.length ? `${p.industries.join(', ')} project.` : 'Indexed project.'),
    topics: [...new Set([...p.domains, ...p.industries])].slice(0, 8),
  }));

  // ── Areas: group skills by structural `kind` ─────────────────────────────
  const areaGroups = new Map<string, KnowledgeOrganizerPayload['skills']>();
  for (const s of payload.skills) {
    const area = KIND_AREA[(s.kind ?? '').toLowerCase()] ?? KIND_FALLBACK_AREA;
    const list = areaGroups.get(area) ?? [];
    list.push(s); areaGroups.set(area, list);
  }
  const areas = [...areaGroups.entries()]
    .map(([name, skills]) => {
      const weight = skills.reduce((acc, s) => acc + s.weight, 0);
      const projectCount = skills.reduce((acc, s) => Math.max(acc, s.projectCount), 0);
      return {
        name,
        level: levelFor(weight, projectCount) as string,
        summary: `${skills.length} skill(s) evidenced across your projects.`,
        skills: skills.sort((a, b) => b.weight - a.weight).map((s) => s.name),
        projects: [] as string[],
        domains: [] as string[],
      };
    })
    .sort((a, b) => b.skills.length - a.skills.length);

  // ── Subjects → topics → items (from real domain fields) ──────────────────
  const subjects: KnowledgeOrganizerOutput['subjects'] = [];

  const buildDomainSubject = (subjectName: string, kind: 'business' | 'tech') => {
    const ds = payload.domains.filter((d) => d.kind === kind);
    if (ds.length === 0) return;
    const topics = ds.map((d) => {
      const items: Array<{ kind: string; name: string }> = [{ kind: 'domain', name: d.name }];
      for (const c of payload.concepts) {
        if (normalizeName(conceptDomains.get(normalizeName(c.name)) ?? '') === normalizeName(d.name)) {
          items.push({ kind: 'concept', name: c.name });
        }
      }
      return { name: d.name, summary: d.summary, items };
    });
    subjects.push({ name: subjectName, summary: `${ds.length} ${kind} domain(s).`, topics });
  };
  buildDomainSubject('Technical Domains', 'tech');
  buildDomainSubject('Business & Industry', 'business');

  // Skills & tooling subject, topics by kind.
  if (payload.skills.length) {
    const byKind = new Map<string, KnowledgeOrganizerPayload['skills']>();
    for (const s of payload.skills) {
      const t = KIND_AREA[(s.kind ?? '').toLowerCase()] ?? KIND_FALLBACK_AREA;
      const list = byKind.get(t) ?? [];
      list.push(s); byKind.set(t, list);
    }
    subjects.push({
      name: 'Skills & Tooling',
      summary: `${payload.skills.length} skill(s) across ${byKind.size} group(s).`,
      topics: [...byKind.entries()].map(([name, skills]) => ({
        name,
        items: skills.sort((a, b) => b.weight - a.weight).map((s) => ({ kind: 'skill', name: s.name })),
      })),
    });
  }

  // Concepts with no resolved domain → a catch-all topic so nothing is dropped.
  const orphanConcepts = payload.concepts.filter((c) => !conceptDomains.has(normalizeName(c.name)));
  if (orphanConcepts.length) {
    subjects.push({
      name: 'Concepts & Patterns',
      summary: `${orphanConcepts.length} recurring concept(s).`,
      topics: [{ name: 'Recurring concepts', items: orphanConcepts.map((c) => ({ kind: 'concept', name: c.name })) }],
    });
  }

  return { projects, areas, subjects };
}

// ============================================================================
// Persist
// ============================================================================

function hashId(prefix: string, s: string): string {
  return createHash('sha1').update(`${prefix}|${s.toLowerCase()}`).digest('hex').slice(0, 16);
}
function round2(n: number): number { return Math.round(n * 100) / 100; }

function persistOrganization(
  gdb: SqliteDb,
  output: KnowledgeOrganizerOutput,
  gathered: GatheredOrg,
  meta: { model: string },
): OrganizeStats {
  const now = Date.now();
  const { skillMap, projectsById, payload } = gathered;
  const activityById = new Map(payload.projects.map((p) => [p.id, p]));
  let active = 0, topicCount = 0;

  const tx = gdb.transaction(() => {
    for (const t of ['para_projects', 'topic_items', 'topics', 'subjects', 'area_refs', 'competency_skills', 'competency_groups']) {
      gdb.prepare(`DELETE FROM ${t}`).run();
    }

    // ── PARA projects ──────────────────────────────────────────────────────
    const insProject = gdb.prepare(`
      INSERT INTO para_projects (project_id, status, focus, topics_json, last_active_at, grounding, rank, updated_at)
      VALUES (?, ?, ?, ?, ?, 'model', ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET status=excluded.status, focus=excluded.focus,
        topics_json=excluded.topics_json, last_active_at=excluded.last_active_at, rank=excluded.rank, updated_at=excluded.updated_at
    `);
    let rank = 0;
    const seenProjects = new Set<string>();
    for (const p of output.projects) {
      if (!projectsById.has(p.id) || seenProjects.has(p.id)) continue;
      seenProjects.add(p.id);
      const status = p.status === 'archived' ? 'archived' : 'active';
      if (status === 'active') active++;
      const act = activityById.get(p.id);
      const lastActive = act?.idleDays != null ? now - act.idleDays * 86_400_000 : null;
      insProject.run(p.id, status, p.focus ?? null, JSON.stringify(p.topics ?? []), lastActive, rank++, now);
    }
    // Any project the agent omitted: classify from activity so none are lost.
    for (const [id, act] of activityById) {
      if (seenProjects.has(id)) continue;
      const status = projectStatus(act.idleDays);
      if (status === 'active') active++;
      const lastActive = act.idleDays != null ? now - act.idleDays * 86_400_000 : null;
      insProject.run(id, status, null, '[]', lastActive, rank++, now);
    }

    // ── Areas (competency_groups + competency_skills + area_refs) ───────────
    const insGroup = gdb.prepare(`
      INSERT INTO competency_groups (id, name, category, level, summary, weight, project_count, grounding, rank, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, level=excluded.level, summary=excluded.summary,
        weight=excluded.weight, project_count=excluded.project_count, grounding=excluded.grounding, rank=excluded.rank, updated_at=excluded.updated_at
    `);
    const insSkill = gdb.prepare(`
      INSERT INTO competency_skills (group_id, skill_id, skill_name, level, weight)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(group_id, skill_name) DO UPDATE SET skill_id=excluded.skill_id, level=excluded.level, weight=excluded.weight
    `);
    const insAreaRef = gdb.prepare(`
      INSERT INTO area_refs (group_id, kind, name, ref_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, kind, name) DO UPDATE SET ref_id=excluded.ref_id
    `);
    rank = 0;
    for (const a of output.areas) {
      const id = hashId('cg', a.name);
      const members = (a.skills ?? []).map((name) => ({ name, row: skillMap.get(normalizeName(name)) }));
      const weight = members.reduce((acc, m) => acc + (m.row?.weight ?? 0), 0);
      const projectCount = members.reduce((acc, m) => Math.max(acc, m.row?.projectCount ?? 0), 0);
      const grounding = dominantGrounding(members.map((m) => m.row?.grounding).filter(Boolean) as string[]);
      const level = normalizeLevel(a.level) || levelFor(weight, projectCount);
      insGroup.run(id, a.name, null, level, a.summary ?? null, round2(weight), projectCount, grounding ?? null, rank++, now);
      const seen = new Set<string>();
      for (const m of members) {
        const key = normalizeName(m.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        insSkill.run(id, m.row?.id ?? null, m.name, levelFor(m.row?.weight ?? 0, m.row?.projectCount ?? 0), round2(m.row?.weight ?? 0));
      }
      const seenRefs = new Set<string>();
      for (const pn of a.projects ?? []) {
        const k = `project|${normalizeName(pn)}`;
        if (seenRefs.has(k)) continue; seenRefs.add(k);
        const proj = [...projectsById.values()].find((p) => normalizeName(p.name) === normalizeName(pn));
        insAreaRef.run(id, 'project', pn, proj?.id ?? null);
      }
      for (const dn of a.domains ?? []) {
        const k = `domain|${normalizeName(dn)}`;
        if (seenRefs.has(k)) continue; seenRefs.add(k);
        insAreaRef.run(id, 'domain', dn, null);
      }
    }

    // ── Subjects → topics → items ───────────────────────────────────────────
    const insSubject = gdb.prepare(`
      INSERT INTO subjects (id, name, summary, weight, grounding, rank, updated_at)
      VALUES (?, ?, ?, ?, 'model', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, summary=excluded.summary, weight=excluded.weight, rank=excluded.rank, updated_at=excluded.updated_at
    `);
    const insTopic = gdb.prepare(`
      INSERT INTO topics (id, subject_id, name, summary, weight, rank, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET subject_id=excluded.subject_id, name=excluded.name, summary=excluded.summary, weight=excluded.weight, rank=excluded.rank, updated_at=excluded.updated_at
    `);
    const insItem = gdb.prepare(`
      INSERT INTO topic_items (topic_id, kind, name, ref_id, weight)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(topic_id, kind, name) DO UPDATE SET ref_id=excluded.ref_id, weight=excluded.weight
    `);
    let sRank = 0;
    for (const subj of output.subjects) {
      const subjId = hashId('subj', subj.name);
      let subjWeight = 0;
      let tRank = 0;
      const topicInserts: Array<() => void> = [];
      for (const topic of subj.topics ?? []) {
        const topicId = hashId('topic', `${subj.name}|${topic.name}`);
        topicCount++;
        let topicWeight = 0;
        const itemInserts: Array<() => void> = [];
        const seenItems = new Set<string>();
        for (const it of topic.items ?? []) {
          if (!it.name) continue;
          const kind = it.kind || 'concept';
          const key = `${kind}|${normalizeName(it.name)}`;
          if (seenItems.has(key)) continue; seenItems.add(key);
          const skill = kind === 'skill' ? skillMap.get(normalizeName(it.name)) : undefined;
          const w = skill?.weight ?? 0;
          topicWeight += w;
          itemInserts.push(() => insItem.run(topicId, kind, it.name, skill?.id ?? null, round2(w)));
        }
        const tw = topicWeight;
        topicInserts.push(() => {
          insTopic.run(topicId, subjId, topic.name, topic.summary ?? null, round2(tw), tRank++, now);
          for (const fn of itemInserts) fn();
        });
        subjWeight += topicWeight;
      }
      insSubject.run(subjId, subj.name, subj.summary ?? null, round2(subjWeight), sRank++, now);
      for (const fn of topicInserts) fn();
    }
  });
  tx();

  return {
    projects: output.projects.length || gathered.payload.projects.length,
    active,
    areas: output.areas.length,
    subjects: output.subjects.length,
    topics: topicCount,
    source: meta.model,
  };
}

// ============================================================================
// Orchestration
// ============================================================================

export interface OrganizeResult extends OrganizeStats { warnings: string[] }

/**
 * Organize and persist the PARA layer into global.db. Tries the
 * KnowledgeOrganizer agent (cached in agent_runs); falls back to the
 * data-driven structural grouping when no backend is available or the agent
 * returns an empty structure.
 */
export async function organizeKnowledge(gdb: SqliteDb, cfg: SubstrateNetConfig): Promise<OrganizeResult> {
  const warnings: string[] = [];
  const gathered = gatherOrganizerInput(gdb);

  // Nothing to organize yet — clear any stale layer and report empty.
  if (gathered.payload.skills.length === 0 && gathered.payload.domains.length === 0 && gathered.payload.projects.length === 0) {
    persistOrganization(gdb, { projects: [], areas: [], subjects: [] }, gathered, { model: 'empty' });
    return { projects: 0, active: 0, areas: 0, subjects: 0, topics: 0, source: 'empty', warnings };
  }

  let output: KnowledgeOrganizerOutput | undefined;
  let model = 'deterministic';
  try {
    const rt = new AgentRuntime({ knowledgeDb: gdb, config: cfg });
    const res = await rt.run(KNOWLEDGE_ORGANIZER_AGENT, { payload: gathered.payload });
    if (res.output.areas.length > 0 || res.output.subjects.length > 0) {
      output = res.output;
      model = res.model;
    } else {
      warnings.push('organize: agent returned empty output; used data-driven fallback');
    }
  } catch (e) {
    warnings.push(`organize: agent unavailable (${(e as Error).message}); used data-driven fallback`);
  }

  if (!output) {
    output = deterministicOrganize(gathered.payload);
    model = 'deterministic';
  }

  const stats = persistOrganization(gdb, output, gathered, { model });
  return { ...stats, warnings };
}

// ============================================================================
// Read
// ============================================================================

export interface ParaProjectSnapshot {
  id: string; name: string; status: string; focus?: string; topics: string[]; lastActiveAt?: number;
}
export interface ParaAreaSnapshot {
  id: string; name: string; level: string; summary?: string; weight: number; projectCount: number; grounding?: string;
  skills: Array<{ name: string; level?: string; weight: number }>;
  projects: string[]; domains: string[];
}
export interface ParaTopicSnapshot {
  id: string; name: string; summary?: string; weight: number;
  items: Array<{ kind: string; name: string; weight: number }>;
}
export interface ParaSubjectSnapshot {
  id: string; name: string; summary?: string; weight: number; topics: ParaTopicSnapshot[];
}
export interface ParaSnapshot {
  projects: ParaProjectSnapshot[];
  archives: ParaProjectSnapshot[];
  areas: ParaAreaSnapshot[];
  subjects: ParaSubjectSnapshot[];
}

/** Read the persisted PARA layer for the dashboard snapshot. */
export function listPara(gdb: SqliteDb): ParaSnapshot {
  const projectRows = gdb.prepare(`
    SELECT pp.project_id AS id, p.name AS name, pp.status AS status, pp.focus AS focus,
           pp.topics_json AS topics, pp.last_active_at AS last_active_at
    FROM para_projects pp JOIN projects p ON p.id = pp.project_id
    ORDER BY pp.rank ASC
  `).all() as Array<{ id: string; name: string; status: string; focus: string | null; topics: string | null; last_active_at: number | null }>;
  const toProject = (r: typeof projectRows[number]): ParaProjectSnapshot => ({
    id: r.id, name: r.name, status: r.status, focus: r.focus ?? undefined,
    topics: parseJsonArray(r.topics), lastActiveAt: r.last_active_at ?? undefined,
  });
  const projects = projectRows.filter((r) => r.status !== 'archived').map(toProject);
  const archives = projectRows.filter((r) => r.status === 'archived').map(toProject);

  const groups = gdb.prepare(`
    SELECT id, name, level, summary, weight, project_count, grounding FROM competency_groups ORDER BY rank ASC
  `).all() as Array<{ id: string; name: string; level: string | null; summary: string | null; weight: number; project_count: number; grounding: string | null }>;
  const skillRows = gdb.prepare(`SELECT group_id, skill_name, level, weight FROM competency_skills`)
    .all() as Array<{ group_id: string; skill_name: string; level: string | null; weight: number }>;
  const refRows = gdb.prepare(`SELECT group_id, kind, name FROM area_refs`)
    .all() as Array<{ group_id: string; kind: string; name: string }>;
  const skillsByGroup = new Map<string, Array<{ name: string; level?: string; weight: number }>>();
  for (const s of skillRows) {
    const list = skillsByGroup.get(s.group_id) ?? [];
    list.push({ name: s.skill_name, level: s.level ?? undefined, weight: s.weight });
    skillsByGroup.set(s.group_id, list);
  }
  const refsByGroup = new Map<string, { projects: string[]; domains: string[] }>();
  for (const r of refRows) {
    const e = refsByGroup.get(r.group_id) ?? { projects: [], domains: [] };
    if (r.kind === 'project') e.projects.push(r.name); else if (r.kind === 'domain') e.domains.push(r.name);
    refsByGroup.set(r.group_id, e);
  }
  const areas: ParaAreaSnapshot[] = groups.map((g) => ({
    id: g.id, name: g.name, level: g.level ?? 'competent', summary: g.summary ?? undefined,
    weight: g.weight, projectCount: g.project_count, grounding: g.grounding ?? undefined,
    skills: (skillsByGroup.get(g.id) ?? []).sort((a, b) => b.weight - a.weight),
    projects: refsByGroup.get(g.id)?.projects ?? [],
    domains: refsByGroup.get(g.id)?.domains ?? [],
  }));

  const subjectRows = gdb.prepare(`SELECT id, name, summary, weight FROM subjects ORDER BY rank ASC`)
    .all() as Array<{ id: string; name: string; summary: string | null; weight: number }>;
  const topicRows = gdb.prepare(`SELECT id, subject_id, name, summary, weight FROM topics ORDER BY rank ASC`)
    .all() as Array<{ id: string; subject_id: string; name: string; summary: string | null; weight: number }>;
  const itemRows = gdb.prepare(`SELECT topic_id, kind, name, weight FROM topic_items`)
    .all() as Array<{ topic_id: string; kind: string; name: string; weight: number }>;
  const itemsByTopic = new Map<string, Array<{ kind: string; name: string; weight: number }>>();
  for (const it of itemRows) {
    const list = itemsByTopic.get(it.topic_id) ?? [];
    list.push({ kind: it.kind, name: it.name, weight: it.weight });
    itemsByTopic.set(it.topic_id, list);
  }
  const topicsBySubject = new Map<string, ParaTopicSnapshot[]>();
  for (const t of topicRows) {
    const list = topicsBySubject.get(t.subject_id) ?? [];
    list.push({
      id: t.id, name: t.name, summary: t.summary ?? undefined, weight: t.weight,
      items: (itemsByTopic.get(t.id) ?? []).sort((a, b) => b.weight - a.weight),
    });
    topicsBySubject.set(t.subject_id, list);
  }
  const subjects: ParaSubjectSnapshot[] = subjectRows.map((s) => ({
    id: s.id, name: s.name, summary: s.summary ?? undefined, weight: s.weight,
    topics: topicsBySubject.get(s.id) ?? [],
  }));

  return { projects, archives, areas, subjects };
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
