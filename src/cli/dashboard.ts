import type { Command } from 'commander';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { buildSnapshot } from '../dashboard/snapshot.js';
import { buildGlobalSnapshot } from '../dashboard/global-snapshot.js';
import {
  locateBundle,
  buildProjectDashboard,
  buildGlobalDashboard,
} from '../dashboard/render.js';

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

      let indexPath: string;
      if (opts.global) {
        indexPath = buildGlobalDashboard(bundleDir);
        const c = buildGlobalSnapshot().meta.counts;
        console.log('Global dashboard written:');
        console.log(`  ${indexPath}`);
        console.log(`  industries=${c.industries} businessDomains=${c.businessDomains} ` +
          `techDomains=${c.techDomains} projects=${c.projects} edges=${c.edges}`);
      } else {
        const root = resolve(path);
        indexPath = buildProjectDashboard(bundleDir, root);
        const c = buildSnapshot(root).meta.counts;
        console.log('Dashboard written:');
        console.log(`  ${indexPath}`);
        console.log(`  files=${c.files} edges=${c.edges} concepts=${c.concepts} highlights=${c.highlights}`);
      }

      if (opts.open) openInBrowser(indexPath);
    });
}

function openInBrowser(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}
