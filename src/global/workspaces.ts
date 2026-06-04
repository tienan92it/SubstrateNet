/**
 * Workspace (umbrella) detection + assignment.
 *
 * A workspace groups multiple repos that belong to one product/org — e.g.
 * "Kafi" over GBI, bond, sales, data-platform, website, mobile, webview.
 * Detection order (highest confidence first):
 *   1. explicit config `workspace`
 *   2. git remote org/owner (github.com:ORG/repo)
 *   3. parent directory name (when not a generic container)
 *
 * The workspace id is a hash of the lowercased name, so the same umbrella
 * collapses to one node across all member projects.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { loadConfig } from '../config.js';
import { registerProject } from './registry.js';

export interface WorkspaceDetection {
  id: string;
  name: string;
  source: 'config' | 'git-org' | 'path';
  confidence: number;
}

/** Generic parent directories that are NOT meaningful umbrellas. */
const GENERIC_DIRS = new Set([
  'workspace', 'workspaces', 'projects', 'project', 'repos', 'repositories',
  'code', 'src', 'dev', 'work', 'documents', 'desktop', 'git', 'github', 'sites',
]);

export function workspaceId(name: string): string {
  return 'ws:' + createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 16);
}

/** Detect the umbrella workspace for a project root, or undefined if none. */
export function detectWorkspace(root: string): WorkspaceDetection | undefined {
  const abs = resolve(root);

  // 1. Explicit config override.
  const cfg = loadConfig(abs);
  if (cfg.workspace && cfg.workspace.trim()) {
    const name = cfg.workspace.trim();
    return { id: workspaceId(name), name, source: 'config', confidence: 1 };
  }

  // 2. Git remote org/owner.
  const org = gitRemoteOrg(abs);
  if (org) return { id: workspaceId(org), name: org, source: 'git-org', confidence: 0.8 };

  // 3. Parent directory name (skip generic containers and the home dir).
  const parent = dirname(abs);
  const parentName = basename(parent);
  if (parent !== abs && parent !== homedir() && parentName && !GENERIC_DIRS.has(parentName.toLowerCase())) {
    return { id: workspaceId(parentName), name: parentName, source: 'path', confidence: 0.4 };
  }
  return undefined;
}

/** Parse the org/owner from `<root>/.git/config` remote "origin". */
export function gitRemoteOrg(root: string): string | undefined {
  const cfgPath = join(root, '.git', 'config');
  if (!existsSync(cfgPath)) return undefined;
  let text: string;
  try { text = readFileSync(cfgPath, 'utf8'); } catch { return undefined; }
  const m = /url\s*=\s*(\S+)/.exec(text);
  if (!m) return undefined;
  return orgFromUrl(m[1]);
}

/** github.com:Org/repo.git | https://github.com/Org/repo(.git) -> "Org". */
export function orgFromUrl(url: string): string | undefined {
  // scp-like: git@host:org/repo.git
  let m = /^[^@]+@[^:]+:([^/]+)\/[^/]+?(?:\.git)?$/.exec(url);
  if (m) return m[1];
  // http(s)/ssh: scheme://host/org/repo(.git)
  m = /^[a-z]+:\/\/[^/]+\/([^/]+)\/[^/]+?(?:\.git)?\/?$/.exec(url);
  if (m) return m[1];
  return undefined;
}

export interface WorkspaceAssignStats { assigned: boolean; name?: string; source?: string; }

/** Detect + persist the workspace for one project into global.db. */
export function assignWorkspace(gdb: SqliteDb, root: string): WorkspaceAssignStats {
  const det = detectWorkspace(root);
  const projectId = registerProject(gdb, root);
  if (!det) {
    gdb.prepare(`DELETE FROM project_workspace WHERE project_id=?`).run(projectId);
    return { assigned: false };
  }
  const now = Date.now();
  const tx = gdb.transaction(() => {
    gdb.prepare(`
      INSERT INTO workspaces (id, name, source, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, source=excluded.source, updated_at=excluded.updated_at
    `).run(det.id, det.name, det.source, now);
    gdb.prepare(`
      INSERT INTO project_workspace (project_id, workspace_id, source, confidence) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET workspace_id=excluded.workspace_id, source=excluded.source, confidence=excluded.confidence
    `).run(projectId, det.id, det.source, det.confidence);
    // Drop workspaces that no longer have any members.
    gdb.prepare(`DELETE FROM workspaces WHERE id NOT IN (SELECT DISTINCT workspace_id FROM project_workspace)`).run();
  });
  tx();
  return { assigned: true, name: det.name, source: det.source };
}
