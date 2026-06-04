import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import { orgFromUrl, detectWorkspace, gitRemoteOrg } from '../../src/global/workspaces.js';
import { computeEmergentLinks, suggestedGroups } from '../../src/link/emergent.js';

describe('workspace detection', () => {
  it('parses org from git URLs', () => {
    expect(orgFromUrl('git@github.com:KafiTech/gbi.git')).toBe('KafiTech');
    expect(orgFromUrl('https://github.com/KafiTech/bond.git')).toBe('KafiTech');
    expect(orgFromUrl('https://gitlab.com/acme/web')).toBe('acme');
    expect(orgFromUrl('not-a-url')).toBeUndefined();
  });

  it('reads org from .git/config and prefers config override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-ws-'));
    try {
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:KafiTech/gbi.git\n`);
      expect(gitRemoteOrg(dir)).toBe('KafiTech');
      const det = detectWorkspace(dir);
      expect(det?.name).toBe('KafiTech');
      expect(det?.source).toBe('git-org');

      // Config override wins.
      mkdirSync(join(dir, '.substrate-net'));
      writeFileSync(join(dir, '.substrate-net', 'config.json'), JSON.stringify({ workspace: 'Kafi' }));
      const det2 = detectWorkspace(dir);
      expect(det2?.name).toBe('Kafi');
      expect(det2?.source).toBe('config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function seedGlobal() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '..', '..', 'src', 'db', 'global-schema.sql'), 'utf8'));
  const now = Date.now();
  for (const [id, name] of [['p1', 'gbi'], ['p2', 'bond'], ['p3', 'website']] as const) {
    db.prepare(`INSERT INTO projects (id,name,path,registered_at,last_seen_at) VALUES (?,?,?,?,?)`)
      .run(id, name, `/tmp/${name}`, now, now);
  }
  // p1 + p2 share a business domain; p2 + p3 share a tech domain.
  for (const pid of ['p1', 'p2']) {
    db.prepare(`INSERT INTO business_domains (id,project_id,name,updated_at) VALUES (?,?,?,?)`).run('bd:trading', pid, 'Trading', now);
  }
  for (const pid of ['p2', 'p3']) {
    db.prepare(`INSERT INTO tech_domains (id,project_id,name,updated_at) VALUES (?,?,?,?)`).run('td:auth', pid, 'Auth', now);
  }
  return db;
}

describe('emergent linking', () => {
  it('links projects that share domains, weighting business > tech', () => {
    const db = seedGlobal();
    const stats = computeEmergentLinks(db);
    expect(stats.links).toBe(2);
    const rows = db.prepare(`SELECT a,b,weight FROM project_links ORDER BY weight DESC`).all() as Array<{ a: string; b: string; weight: number }>;
    // p1-p2 via business domain (weight 3) ranks above p2-p3 via tech domain (weight 2).
    expect(rows[0].weight).toBe(3);
    expect([rows[0].a, rows[0].b].sort()).toEqual(['p1', 'p2']);
    expect(rows[1].weight).toBe(2);
  });

  it('suggests connected groups above a weight threshold', () => {
    const db = seedGlobal();
    computeEmergentLinks(db);
    const groups = suggestedGroups(db, 2);
    // p1-p2-p3 are all connected (p1-p2 biz, p2-p3 tech) -> one group of 3.
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(['p1', 'p2', 'p3']);
  });
});
