/**
 * Persisted record of the last setup/update run.
 *
 * Written by both `subnet setup` and `subnet update`, and read by
 * `subnet doctor` to report staleness and compare against transcript activity.
 */
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { globalConfigDir } from '../config.js';

export interface LastRunProject {
  path: string;
  name: string;
  ok: boolean;
  error?: string;
  stages?: Record<string, number>;
  durationMs?: number;
}

export interface LastRun {
  at: string;
  command: 'setup' | 'update';
  profile: string;
  projects: LastRunProject[];
  globalDashboardPath?: string;
  profilePath?: string;
}

export function lastRunPath(): string {
  return join(globalConfigDir(), 'setup-last-run.json');
}

export function writeLastRun(run: LastRun): void {
  writeFileSync(lastRunPath(), JSON.stringify(run, null, 2));
}

export function readLastRun(): LastRun | undefined {
  const p = lastRunPath();
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LastRun;
  } catch {
    return undefined;
  }
}
