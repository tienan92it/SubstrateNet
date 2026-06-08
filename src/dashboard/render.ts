/**
 * Shared dashboard rendering.
 *
 * Both `subnet dashboard` and the setup/update pipeline need to locate the
 * built SPA bundle and inject a snapshot into a self-contained `index.html`.
 * This module owns that logic so the two call sites stay in sync.
 */
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { projectConfigDir, globalConfigDir } from '../config.js';
import { buildSnapshot } from './snapshot.js';
import { buildGlobalSnapshot } from './global-snapshot.js';

const DATA_MARKER = '/*__SUBNET_DATA__*/null';

/** dist/dashboard/app (shipped) or dashboard/dist (dev build). Undefined if missing. */
export function locateBundle(): string | undefined {
  const candidates = [
    join(__dirname, '..', 'dashboard', 'app'),
    join(__dirname, '..', '..', 'dashboard', 'dist'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'index.html'))) return c;
  return undefined;
}

/** Render a single-file dashboard from a snapshot into `outDir`. Returns the index path. */
export function renderDashboard(bundleDir: string, outDir: string, snapshot: unknown): string {
  mkdirSync(outDir, { recursive: true });
  cpSync(bundleDir, outDir, { recursive: true });
  const indexPath = join(outDir, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  if (!html.includes(DATA_MARKER)) {
    throw new Error('Dashboard template missing data marker; rebuild the dashboard bundle.');
  }
  writeFileSync(indexPath, html.replace(DATA_MARKER, JSON.stringify(snapshot)), 'utf8');
  writeFileSync(join(outDir, 'graph.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  return indexPath;
}

/** Build + write the per-project dashboard. Returns the index path. */
export function buildProjectDashboard(bundleDir: string, root: string): string {
  const snapshot = buildSnapshot(root);
  return renderDashboard(bundleDir, join(projectConfigDir(root), 'dashboard'), snapshot);
}

/** Build + write the cross-project (global) dashboard. Returns the index path. */
export function buildGlobalDashboard(bundleDir: string): string {
  const snapshot = buildGlobalSnapshot();
  return renderDashboard(bundleDir, join(globalConfigDir(), 'dashboard'), snapshot);
}
