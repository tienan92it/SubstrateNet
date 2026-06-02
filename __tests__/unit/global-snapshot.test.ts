import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { assembleHierarchy } from '../../src/dashboard/global-snapshot.js';
import { industryNodeId, businessDomainNodeId, techDomainNodeId, projectNodeId } from '../../src/global/taxonomy.js';

function seedGlobalDb() {
  const db = new Database(':memory:');
  const schema = readFileSync(join(__dirname, '..', '..', 'src', 'db', 'global-schema.sql'), 'utf8');
  db.exec(schema);
  const now = Date.now();

  // Two projects in the same industry; one shared business domain.
  db.prepare(`INSERT INTO projects (id,name,path,registered_at,last_seen_at) VALUES (?,?,?,?,?)`)
    .run('p1', 'alpha', '/tmp/alpha', now, now);
  db.prepare(`INSERT INTO projects (id,name,path,registered_at,last_seen_at) VALUES (?,?,?,?,?)`)
    .run('p2', 'beta', '/tmp/beta', now, now);

  db.prepare(`INSERT INTO industries (id,name,project_id,confidence,grounding,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('i1', 'Fintech', 'p1', 0.9, 'stated', now);
  db.prepare(`INSERT INTO industries (id,name,project_id,confidence,grounding,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('i2', 'Fintech', 'p2', 0.8, 'stated', now);

  const bdId = businessDomainNodeId('Payments');
  db.prepare(`INSERT INTO business_domains (id,project_id,name,summary,grounding,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(bdId, 'p1', 'Payments', 'Money movement', 'stated', now);
  db.prepare(`INSERT INTO business_domains (id,project_id,name,summary,grounding,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(bdId, 'p2', 'Payments', 'Money movement', 'stated', now);

  const tdId = techDomainNodeId('Auth');
  db.prepare(`INSERT INTO tech_domains (id,project_id,name,summary,grounding,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(tdId, 'p1', 'Auth', 'Authentication', 'stated', now);

  const ind = industryNodeId('Fintech');
  const edges: Array<[string, string, string, string]> = [
    [ind, bdId, 'industry_has_business', 'p1'],
    [bdId, tdId, 'business_has_tech', 'p1'],
    [tdId, projectNodeId('p1'), 'tech_has_project', 'p1'],
    [ind, bdId, 'industry_has_business', 'p2'],
    [bdId, projectNodeId('p2'), 'business_has_project', 'p2'],
  ];
  for (const [a, b, k, p] of edges) {
    db.prepare(`INSERT INTO taxonomy_edges (parent_id,child_id,kind,project_id) VALUES (?,?,?,?)`).run(a, b, k, p);
  }
  return db;
}

describe('assembleHierarchy', () => {
  it('merges same-named domains across projects and tracks project counts', () => {
    const db = seedGlobalDb();
    const { nodes, edges } = assembleHierarchy(db);

    const industry = nodes.find((n) => n.level === 'industry');
    expect(industry?.label).toBe('Fintech');
    expect(industry?.projectCount).toBe(2);

    // "Payments" appears in both projects but collapses to ONE node.
    const biz = nodes.filter((n) => n.level === 'business_domain');
    expect(biz).toHaveLength(1);
    expect(biz[0].projectCount).toBe(2);

    expect(nodes.filter((n) => n.level === 'tech_domain')).toHaveLength(1);
    expect(nodes.filter((n) => n.level === 'project')).toHaveLength(2);

    // Edges deduped (industry->payments appears in two projects -> one edge).
    const indToBiz = edges.filter((e) => e.source === industryNodeId('Fintech') && e.target === businessDomainNodeId('Payments'));
    expect(indToBiz).toHaveLength(1);
  });

  it('only keeps edges whose endpoints exist as nodes', () => {
    const db = seedGlobalDb();
    db.prepare(`INSERT INTO taxonomy_edges (parent_id,child_id,kind,project_id) VALUES (?,?,?,?)`)
      .run('bd:missing', 'td:missing', 'business_has_tech', 'p1');
    const { edges } = assembleHierarchy(db);
    expect(edges.some((e) => e.source === 'bd:missing')).toBe(false);
  });
});
