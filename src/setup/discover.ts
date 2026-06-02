import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { expandHome, loadConfig, projectConfigDir, type SubstrateNetConfig } from '../config.js';
import { slugForPath } from '../ingest/cursor.js';
import { sniffCodexSessionCwd } from '../ingest/codex.js';
import { matchSlugToPaths } from './slug.js';
import type { AgentId } from '../types.js';
import type { DiscoveredWorkspace, WorkspaceSource } from './types.js';

export interface DiscoverOpts {
  agentFilter?: AgentId;
  /** Cap file counting per project (speed). */
  maxFileCount?: number;
}

const DEFAULT_WORKSPACE_ROOTS = [
  '~/Workspace',
  '~/Projects',
  '~/Developer',
  '~/Code',
  '~/work',
];

function workspaceStorageRoots(): string[] {
  const home = homedir();
  const plat = process.platform;
  if (plat === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
      join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
      join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
    ];
  }
  if (plat === 'win32') {
    const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [join(appdata, 'Code', 'User', 'workspaceStorage')];
  }
  return [
    join(home, '.config', 'Code', 'User', 'workspaceStorage'),
    join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
  ];
}

function parseWorkspaceFolderUri(uri: string): string | undefined {
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(uri.replace('file://', ''));
    } catch {
      return uri.replace('file://', '');
    }
  }
  return undefined;
}

function collectWorkspaceJsonPaths(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of workspaceStorageRoots()) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const hash of entries) {
      const wj = join(root, hash, 'workspace.json');
      if (!existsSync(wj)) continue;
      try {
        const raw = JSON.parse(readFileSync(wj, 'utf8')) as { folder?: string };
        const folder = raw.folder ? parseWorkspaceFolderUri(raw.folder) : undefined;
        if (!folder || !existsSync(folder)) continue;
        const abs = resolve(folder);
        if (seen.has(abs)) continue;
        seen.add(abs);
        out.push(abs);
      } catch { /* skip */ }
    }
  }
  return out;
}

function expandWorkspaceRoots(cfg: SubstrateNetConfig): string[] {
  const paths = new Set<string>();
  for (const p of DEFAULT_WORKSPACE_ROOTS) {
    const abs = expandHome(p);
    if (existsSync(abs)) paths.add(resolve(abs));
  }
  for (const p of collectWorkspaceJsonPaths()) paths.add(p);
  return [...paths];
}

type MutableWs = {
  path: string;
  sources: Map<AgentId, { sessions: number; transcriptBytes: number }>;
  unresolvedSlug?: string;
};

function upsertSource(map: Map<string, MutableWs>, path: string, agent: AgentId, sessions: number, bytes: number): void {
  const key = path || `__unresolved__:${agent}`;
  let ws = map.get(key);
  if (!ws) {
    ws = { path, sources: new Map() };
    map.set(key, ws);
  }
  const prev = ws.sources.get(agent) ?? { sessions: 0, transcriptBytes: 0 };
  ws.sources.set(agent, {
    sessions: prev.sessions + sessions,
    transcriptBytes: prev.transcriptBytes + bytes,
  });
}

function scanCursorTranscriptRoots(
  map: Map<string, MutableWs>,
  cfg: SubstrateNetConfig,
  candidates: string[],
): void {
  const root = expandHome(cfg.transcriptRoots?.cursor ?? '~/.cursor/projects');
  if (!existsSync(root)) return;
  let slugs: string[];
  try { slugs = readdirSync(root); } catch { return; }
  for (const slug of slugs) {
    const transcriptsDir = join(root, slug, 'agent-transcripts');
    if (!existsSync(transcriptsDir)) continue;
    let sessions = 0;
    let bytes = 0;
    try {
      for (const entry of readdirSync(transcriptsDir)) {
        const entryAbs = join(transcriptsDir, entry);
        let st;
        try { st = statSync(entryAbs); } catch { continue; }
        if (!st.isDirectory()) continue;
        const fileAbs = join(entryAbs, `${entry}.jsonl`);
        if (!existsSync(fileAbs)) continue;
        let fst;
        try { fst = statSync(fileAbs); } catch { continue; }
        sessions++;
        bytes += fst.size;
      }
    } catch { continue; }
    if (sessions === 0) continue;
    const matches = matchSlugToPaths(slug, candidates);
    if (matches.length === 1) {
      upsertSource(map, matches[0]!, 'cursor', sessions, bytes);
    } else if (matches.length > 1) {
      for (const p of matches) upsertSource(map, p, 'cursor', sessions, bytes);
    } else {
      const key = `__slug__:cursor:${slug}`;
      const ws: MutableWs = { path: '', sources: new Map(), unresolvedSlug: slug };
      ws.sources.set('cursor', { sessions, transcriptBytes: bytes });
      map.set(key, ws);
    }
  }
}

function scanClaudeTranscriptRoots(
  map: Map<string, MutableWs>,
  cfg: SubstrateNetConfig,
  candidates: string[],
): void {
  const root = expandHome(cfg.transcriptRoots?.claudeCode ?? '~/.claude/projects');
  if (!existsSync(root)) return;
  let slugs: string[];
  try { slugs = readdirSync(root); } catch { return; }
  for (const slug of slugs) {
    const projDir = join(root, slug);
    let st;
    try { st = statSync(projDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let sessions = 0;
    let bytes = 0;
    try {
      for (const name of readdirSync(projDir)) {
        if (!name.endsWith('.jsonl')) continue;
        const fileAbs = join(projDir, name);
        let fst;
        try { fst = statSync(fileAbs); } catch { continue; }
        sessions++;
        bytes += fst.size;
      }
    } catch { continue; }
    if (sessions === 0) continue;
    const matches = matchSlugToPaths(slug, candidates);
    if (matches.length === 1) {
      upsertSource(map, matches[0]!, 'claude-code', sessions, bytes);
    } else if (matches.length > 1) {
      for (const p of matches) upsertSource(map, p, 'claude-code', sessions, bytes);
    } else {
      const key = `__slug__:claude-code:${slug}`;
      const ws: MutableWs = { path: '', sources: new Map(), unresolvedSlug: slug };
      ws.sources.set('claude-code', { sessions, transcriptBytes: bytes });
      map.set(key, ws);
    }
  }
}

const MAX_CODEX_JSONL_SCAN = 2500;

function walkCodexSessions(
  dir: string,
  out: Map<string, { sessions: number; bytes: number }>,
  state: { scanned: number },
): void {
  if (state.scanned >= MAX_CODEX_JSONL_SCAN) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (state.scanned >= MAX_CODEX_JSONL_SCAN) return;
    const abs = join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      walkCodexSessions(abs, out, state);
      continue;
    }
    if (!name.endsWith('.jsonl')) continue;
    state.scanned++;
    const cwd = sniffCodexSessionCwd(abs);
    if (!cwd || !existsSync(cwd)) continue;
    const key = resolve(cwd);
    if (key === '/' || key.length < 4) continue;
    const prev = out.get(key) ?? { sessions: 0, bytes: 0 };
    prev.sessions++;
    prev.bytes += st.size;
    out.set(key, prev);
  }
}

function scanCodexSessions(map: Map<string, MutableWs>, cfg: SubstrateNetConfig): void {
  const root = expandHome(cfg.transcriptRoots?.codex ?? '~/.codex/sessions');
  if (!existsSync(root)) return;
  const byPath = new Map<string, { sessions: number; bytes: number }>();
  walkCodexSessions(root, byPath, { scanned: 0 });
  for (const [path, stats] of byPath) {
    upsertSource(map, path, 'codex', stats.sessions, stats.bytes);
  }
}

/**
 * Scan local agent transcript stores and IDE workspace metadata for indexable projects.
 */
export async function discoverWorkspaces(opts: DiscoverOpts = {}): Promise<DiscoveredWorkspace[]> {
  const cfg = loadConfig();
  const candidates = expandWorkspaceRoots(cfg);
  const map = new Map<string, MutableWs>();

  if (!opts.agentFilter || opts.agentFilter === 'cursor') {
    scanCursorTranscriptRoots(map, cfg, candidates);
  }
  if (!opts.agentFilter || opts.agentFilter === 'claude-code') {
    scanClaudeTranscriptRoots(map, cfg, candidates);
  }
  if (!opts.agentFilter || opts.agentFilter === 'codex') {
    scanCodexSessions(map, cfg);
  }

  for (const p of collectWorkspaceJsonPaths()) {
    if (![...map.values()].some((w) => w.path === p)) {
      map.set(p, { path: p, sources: new Map() });
    }
  }

  const results: DiscoveredWorkspace[] = [];

  for (const ws of map.values()) {
    const path = ws.path;
    const sources: WorkspaceSource[] = [...ws.sources.entries()].map(([agent, s]) => ({
      agent,
      sessions: s.sessions,
      transcriptBytes: s.transcriptBytes,
    }));
    if (sources.length === 0 && !ws.unresolvedSlug) continue;

    results.push({
      path,
      name: path ? basename(path) : ws.unresolvedSlug ?? 'unknown',
      sources,
      initialized: path ? existsSync(projectConfigDir(path)) : false,
      fileCount: 0,
      unresolvedSlug: ws.unresolvedSlug,
    });
  }

  results.sort((a, b) => {
    const sa = a.sources.reduce((n, s) => n + s.sessions, 0);
    const sb = b.sources.reduce((n, s) => n + s.sessions, 0);
    if (sb !== sa) return sb - sa;
    return a.name.localeCompare(b.name);
  });

  return results;
}
