import type { AgentId } from '../types.js';

export interface WorkspaceSource {
  agent: AgentId;
  sessions: number;
  transcriptBytes: number;
}

export interface DiscoveredWorkspace {
  /** Absolute project root when resolved; empty if unresolved. */
  path: string;
  name: string;
  sources: WorkspaceSource[];
  initialized: boolean;
  fileCount: number;
  /** Cursor/Claude slug when path could not be resolved. */
  unresolvedSlug?: string;
}

export interface ProjectPlanEstimate {
  path: string;
  name: string;
  files: number;
  pendingFiles: number;
  sessions: number;
  newTurnsEst: number;
  estWindows: number;
  llmCalls: number;
  cacheHitPct: number;
  estTokens: number;
  estWallMs: number;
  backendMode: 'local' | 'frontier' | 'mixed';
}

export interface SetupPlan {
  projects: ProjectPlanEstimate[];
  totals: {
    files: number;
    pendingFiles: number;
    sessions: number;
    estWindows: number;
    llmCalls: number;
    cacheHitPct: number;
    estTokens: number;
    estWallMs: number;
    estCostUsd?: number;
  };
  backendMode: 'local' | 'frontier' | 'mixed';
  concurrency: number;
}

export type SetupProgressEvent =
  | { kind: 'stage'; project: string; stage: string }
  | { kind: 'progress'; project: string; stage: string; current: number; total: number; detail?: string }
  | { kind: 'projectDone'; project: string; ok: boolean; error?: string }
  | { kind: 'global'; stage: string };

export type SetupProgressFn = (ev: SetupProgressEvent) => void;

export interface SetupRunOpts {
  projects: string[];
  reprocess?: boolean;
  verify?: boolean;
  prose?: boolean;
  skipDashboard?: boolean;
  openDashboard?: boolean;
  onProgress?: SetupProgressFn;
}

export interface SetupRunResult {
  projects: Array<{ path: string; ok: boolean; error?: string }>;
  dashboardPath?: string;
  profilePath?: string;
}
