/**
 * Quality profile resolution shared by setup, update, ingest, and the planner.
 */
import type { AnalyzeTierProfile } from '../config.js';
import type { PlanProfile } from '../setup/types.js';

/** CLI runner profile (includes reprocess semantics). */
export type RunProfile = 'fast' | 'default' | 'deep' | 'full';

export function resolveQualityProfile(run: RunProfile): PlanProfile {
  if (run === 'fast') return 'lean';
  if (run === 'deep' || run === 'full') return 'deep';
  return 'standard';
}

export function shouldReprocessWindows(run: RunProfile): boolean {
  return run === 'full';
}

export function resolveAnalyzeProfile(run: RunProfile): AnalyzeTierProfile {
  return resolveQualityProfile(run);
}

export function resolveEnrichProfile(run: RunProfile): 'standard' | 'deep' {
  return run === 'deep' || run === 'full' ? 'deep' : 'standard';
}

/** Map setup CLI flags to a runner profile. */
export function runProfileFromSetup(opts: { profile?: string; reprocess?: boolean }): RunProfile {
  if (opts.reprocess) return 'full';
  const p = (opts.profile ?? 'standard').toLowerCase();
  if (p === 'lean' || p === 'fast') return 'fast';
  if (p === 'deep') return 'deep';
  if (p === 'full') return 'full';
  return 'default';
}

/** Optional override from SUBNET_PROFILE for hidden ingest / scripts. */
export function qualityProfileFromEnv(): PlanProfile | undefined {
  const p = process.env.SUBNET_PROFILE?.toLowerCase();
  if (!p) return undefined;
  if (p === 'lean' || p === 'fast') return 'lean';
  if (p === 'deep' || p === 'full') return 'deep';
  if (p === 'standard' || p === 'default') return 'standard';
  return undefined;
}

export function resolveIngestQualityProfile(
  explicit?: AnalyzeTierProfile,
  cfgTier?: AnalyzeTierProfile,
): PlanProfile {
  const env = qualityProfileFromEnv();
  if (explicit) return explicit;
  if (env) return env;
  return cfgTier ?? 'standard';
}
