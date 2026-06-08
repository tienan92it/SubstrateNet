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

export type PlanProfile = 'lean' | 'standard' | 'deep';

export interface PlanPhaseEstimate {
  phase: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  estWallMs: number;
  /** e.g. "frontier (subscription)" or "mechanical" */
  note?: string;
}

export interface ProjectPlanEstimate {
  path: string;
  name: string;
  files: number;
  pendingFiles: number;
  sessions: number;
  newTurnsEst: number;
  /** Raw window count before mechanical dedupe. */
  estWindows: number;
  /** Windows expected after pre-triage dedupe. */
  estWindowsKept: number;
  llmCalls: number;
  cacheHitPct: number;
  estTokens: number;
  estTokensIn: number;
  estTokensOut: number;
  estWallMs: number;
  estCostUsd: number;
  backendMode: 'local' | 'frontier' | 'mixed';
  phases: PlanPhaseEstimate[];
}

export interface SetupPlan {
  projects: ProjectPlanEstimate[];
  phases: PlanPhaseEstimate[];
  totals: {
    files: number;
    pendingFiles: number;
    sessions: number;
    estWindows: number;
    estWindowsKept: number;
    llmCalls: number;
    cacheHitPct: number;
    estTokens: number;
    estTokensIn: number;
    estTokensOut: number;
    estWallMs: number;
    estCostUsd: number;
  };
  backendMode: 'local' | 'frontier' | 'mixed';
  concurrency: number;
  profile: PlanProfile;
}

export type SetupProgressEvent =
  | { kind: 'stage'; project: string; stage: string }
  | { kind: 'progress'; project: string; stage: string; current: number; total: number; detail?: string }
  | { kind: 'projectDone'; project: string; ok: boolean; error?: string }
  | { kind: 'global'; stage: string };

export type SetupProgressFn = (ev: SetupProgressEvent) => void;

export interface SetupRunOpts {
  projects: string[];
  /** lean | standard | deep (see `subnet setup --profile`) */
  profile?: string;
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
