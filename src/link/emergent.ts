/**
 * Emergent cross-project linking.
 *
 * Beyond explicit workspace umbrellas, projects relate through shared SIGNALS
 * in the union knowledge base: shared business/tech domains, shared concepts,
 * shared skills, shared industries. This computes weighted project-to-project
 * link strengths into `project_links`, surfacing groupings like
 * "Kafi -> GBI / bond / sales / data-platform" even without a configured umbrella.
 *
 * Deterministic, no LLM. Recomputed on every `subnet link`.
 */
import type { Database as SqliteDb } from 'better-sqlite3';

export interface EmergentStats { links: number; }

/** Signal weights — domain co-membership is a stronger tie than a shared skill. */
const SIGNAL_WEIGHT: Record<string, number> = {
  business_domain: 3, tech_domain: 2, concept: 1, industry: 1, skill: 0.5,
};

const MAX_LINKS = 5000;

type PairKey = string; // `${a}|${b}` with a < b

export function computeEmergentLinks(gdb: SqliteDb): EmergentStats {
  const pairs = new Map<PairKey, { weight: number; signals: Record<string, number> }>();

  const add = (signal: keyof typeof SIGNAL_WEIGHT, projects: string[]) => {
    const uniq = [...new Set(projects)];
    if (uniq.length < 2) return;
    const w = SIGNAL_WEIGHT[signal];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const [a, b] = uniq[i] < uniq[j] ? [uniq[i], uniq[j]] : [uniq[j], uniq[i]];
        const key = `${a}|${b}`;
        let p = pairs.get(key);
        if (!p) { p = { weight: 0, signals: {} }; pairs.set(key, p); }
        p.weight += w;
        p.signals[signal] = (p.signals[signal] ?? 0) + 1;
      }
    }
  };

  // Each query yields (groupingKey -> the projects that share it).
  const grouped = (sql: string): void => {
    const rows = gdb.prepare(sql).all() as Array<{ k: string; projects: string }>;
    for (const r of rows) {
      if (!r.projects) continue;
      add(currentSignal, r.projects.split(','));
    }
  };

  let currentSignal: keyof typeof SIGNAL_WEIGHT = 'business_domain';
  // business / tech domains: id already merges same-named across projects.
  grouped(`SELECT id AS k, GROUP_CONCAT(DISTINCT project_id) AS projects FROM business_domains GROUP BY id HAVING COUNT(DISTINCT project_id) > 1`);
  currentSignal = 'tech_domain';
  grouped(`SELECT id AS k, GROUP_CONCAT(DISTINCT project_id) AS projects FROM tech_domains GROUP BY id HAVING COUNT(DISTINCT project_id) > 1`);
  currentSignal = 'concept';
  grouped(`SELECT lower(name) AS k, GROUP_CONCAT(DISTINCT project_id) AS projects FROM concepts_global GROUP BY lower(name) HAVING COUNT(DISTINCT project_id) > 1`);
  currentSignal = 'skill';
  grouped(`SELECT skill_id AS k, GROUP_CONCAT(DISTINCT project_id) AS projects FROM skill_evidence GROUP BY skill_id HAVING COUNT(DISTINCT project_id) > 1`);
  currentSignal = 'industry';
  grouped(`SELECT lower(name) AS k, GROUP_CONCAT(DISTINCT project_id) AS projects FROM industries GROUP BY lower(name) HAVING COUNT(DISTINCT project_id) > 1`);

  const sorted = [...pairs.entries()].sort((a, b) => b[1].weight - a[1].weight).slice(0, MAX_LINKS);

  const insert = gdb.prepare(`
    INSERT INTO project_links (a, b, weight, signals) VALUES (?, ?, ?, ?)
    ON CONFLICT(a, b) DO UPDATE SET weight=excluded.weight, signals=excluded.signals
  `);
  const tx = gdb.transaction(() => {
    gdb.prepare(`DELETE FROM project_links`).run();
    for (const [key, p] of sorted) {
      const [a, b] = key.split('|');
      insert.run(a, b, round2(p.weight), JSON.stringify(p.signals));
    }
  });
  tx();

  return { links: sorted.length };
}

/** Suggested groupings: connected components of the project-link graph. */
export function suggestedGroups(gdb: SqliteDb, minWeight = 2): string[][] {
  const edges = gdb.prepare(`SELECT a, b FROM project_links WHERE weight >= ?`).all(minWeight) as Array<{ a: string; b: string }>;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    parent.set(x, parent.get(x) ?? x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (x: string, y: string) => { parent.set(find(x), find(y)); };
  for (const e of edges) { find(e.a); find(e.b); union(e.a, e.b); }
  const groups = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const r = find(node);
    const g = groups.get(r) ?? [];
    g.push(node);
    groups.set(r, g);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
