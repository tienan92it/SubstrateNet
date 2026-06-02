import type { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { projectConfigDir, globalConfigDir } from '../config.js';
import { buildSnapshot } from '../dashboard/snapshot.js';
import { buildGlobalSnapshot } from '../dashboard/global-snapshot.js';

const DATA_MARKER = '/*__SUBNET_DATA__*/null';

export function registerDashboard(program: Command): void {
  program
    .command('dashboard')
    .description('Build a self-contained interactive graph dashboard from the project databases')
    .argument('[path]', 'Project root path', '.')
    .option('--open', 'Open the dashboard in your browser when done', false)
    .option('--global', 'Build the cross-project hierarchy dashboard from ~/.substrate-net/global.db', false)
    .action(async (path: string, opts: { open: boolean; global: boolean }) => {
      const bundleDir = locateBundle();
      if (!bundleDir) {
        console.error(
          'Dashboard bundle not found. Build it first:\n' +
          '  npm run build:dashboard   (or `npm run build` which includes it)',
        );
        process.exit(1);
      }

      const indexPath = opts.global
        ? buildGlobalDashboard(bundleDir)
        : buildProjectDashboard(bundleDir, resolve(path));

      if (opts.open) openInBrowser(indexPath);
    });
}

/** Render a single-file dashboard from a snapshot into `outDir`. Returns index path. */
function renderDashboard(bundleDir: string, outDir: string, snapshot: unknown): string {
  mkdirSync(outDir, { recursive: true });
  cpSync(bundleDir, outDir, { recursive: true });
  // Inject the snapshot inline so the file opens without a server (file://).
  const indexPath = join(outDir, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  if (!html.includes(DATA_MARKER)) {
    console.error(`Dashboard template missing data marker; rebuild the dashboard bundle.`);
    process.exit(1);
  }
  writeFileSync(indexPath, html.replace(DATA_MARKER, JSON.stringify(snapshot)), 'utf8');
  // Also drop a standalone graph.json for sharing / tooling.
  writeFileSync(join(outDir, 'graph.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  return indexPath;
}

function buildProjectDashboard(bundleDir: string, root: string): string {
  const snapshot = buildSnapshot(root);
  const indexPath = renderDashboard(bundleDir, join(projectConfigDir(root), 'dashboard'), snapshot);
  console.log('Dashboard written:');
  console.log(`  ${indexPath}`);
  console.log(`  files=${snapshot.meta.counts.files} edges=${snapshot.meta.counts.edges} ` +
    `concepts=${snapshot.meta.counts.concepts} highlights=${snapshot.meta.counts.highlights}`);
  return indexPath;
}

function buildGlobalDashboard(bundleDir: string): string {
  const snapshot = buildGlobalSnapshot();
  const indexPath = renderDashboard(bundleDir, join(globalConfigDir(), 'dashboard'), snapshot);
  const c = snapshot.meta.counts;
  console.log('Global dashboard written:');
  console.log(`  ${indexPath}`);
  console.log(`  industries=${c.industries} businessDomains=${c.businessDomains} ` +
    `techDomains=${c.techDomains} projects=${c.projects} edges=${c.edges}`);
  return indexPath;
}

/** dist/dashboard (shipped) or dashboard/dist (dev build). */
function locateBundle(): string | undefined {
  const candidates = [
    join(__dirname, '..', 'dashboard', 'app'),
    join(__dirname, '..', '..', 'dashboard', 'dist'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'index.html'))) return c;
  return undefined;
}

function openInBrowser(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}
