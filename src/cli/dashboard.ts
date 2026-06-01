import type { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { projectConfigDir } from '../config.js';
import { buildSnapshot } from '../dashboard/snapshot.js';

const DATA_MARKER = '/*__SUBNET_DATA__*/null';

export function registerDashboard(program: Command): void {
  program
    .command('dashboard')
    .description('Build a self-contained interactive graph dashboard from the project databases')
    .argument('[path]', 'Project root path', '.')
    .option('--open', 'Open the dashboard in your browser when done', false)
    .action(async (path: string, opts: { open: boolean }) => {
      const root = resolve(path);
      const bundleDir = locateBundle();
      if (!bundleDir) {
        console.error(
          'Dashboard bundle not found. Build it first:\n' +
          '  npm run build:dashboard   (or `npm run build` which includes it)',
        );
        process.exit(1);
      }

      const snapshot = buildSnapshot(root);
      const outDir = join(projectConfigDir(root), 'dashboard');
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

      console.log('Dashboard written:');
      console.log(`  ${indexPath}`);
      console.log(`  files=${snapshot.meta.counts.files} edges=${snapshot.meta.counts.edges} ` +
        `concepts=${snapshot.meta.counts.concepts} highlights=${snapshot.meta.counts.highlights}`);

      if (opts.open) openInBrowser(indexPath);
    });
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
