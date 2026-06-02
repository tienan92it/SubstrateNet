import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import { ensureGlobalConfig, globalConfigDir, projectConfigDir } from '../config.js';
import { loadConfig } from '../config.js';
import { syncProject } from '../code/sync.js';
import { ingestProject } from '../ingest/orchestrator.js';
import { openKnowledgeDb } from '../db/connection.js';
import { runVerify } from '../pipeline/verify.js';
import { rebuildLinks } from '../link/cross-project.js';
import { buildSnapshot } from '../dashboard/snapshot.js';
import { ensureProjectInitialized } from './init-project.js';
import type { SetupRunOpts, SetupRunResult, SetupProgressFn } from './types.js';

const DATA_MARKER = '/*__SUBNET_DATA__*/null';

function locateBundle(): string | undefined {
  const candidates = [
    join(__dirname, '..', 'dashboard', 'app'),
    join(__dirname, '..', '..', 'dashboard', 'dist'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'index.html'))) return c;
  return undefined;
}

function emit(onProgress: SetupProgressFn | undefined, ev: Parameters<SetupProgressFn>[0]): void {
  onProgress?.(ev);
}

export async function runSetupPipeline(opts: SetupRunOpts): Promise<SetupRunResult> {
  ensureGlobalConfig();
  const result: SetupRunResult = { projects: [] };
  let lastProject = opts.projects[opts.projects.length - 1];

  for (const raw of opts.projects) {
    const root = resolve(raw);
    const name = basename(root);
    emit(opts.onProgress, { kind: 'stage', project: name, stage: 'init' });
    try {
      ensureProjectInitialized(root);

      emit(opts.onProgress, { kind: 'stage', project: name, stage: 'sync' });
      await syncProject(root);

      emit(opts.onProgress, { kind: 'stage', project: name, stage: 'ingest' });
      await ingestProject(root, {
        reprocess: opts.reprocess,
        runAnalyze: true,
        runEnrich: true,
        onProgress: (p) => {
          emit(opts.onProgress, {
            kind: 'progress',
            project: name,
            stage: p.stage,
            current: p.current ?? 0,
            total: p.total ?? 0,
            detail: p.detail,
          });
        },
      });

      if (opts.verify) {
        emit(opts.onProgress, { kind: 'stage', project: name, stage: 'verify' });
        const cfg = loadConfig(root);
        const db = openKnowledgeDb(root);
        try {
          await runVerify(db, cfg, { pruneBelowConfidence: 0.25, maxPairsPerCluster: 5 });
        } finally {
          db.close();
        }
      }

      result.projects.push({ path: root, ok: true });
      emit(opts.onProgress, { kind: 'projectDone', project: name, ok: true });
      lastProject = root;
    } catch (e) {
      const msg = (e as Error).message;
      result.projects.push({ path: root, ok: false, error: msg });
      emit(opts.onProgress, { kind: 'projectDone', project: name, ok: false, error: msg });
    }
  }

  const anyOk = result.projects.some((p) => p.ok);
  if (anyOk) {
    emit(opts.onProgress, { kind: 'global', stage: 'link' });
    const linkRoot = result.projects.find((p) => p.ok)?.path ?? lastProject!;
    await rebuildLinks(linkRoot, { full: false });

    if (opts.prose) {
      emit(opts.onProgress, { kind: 'global', stage: 'profile' });
      result.profilePath = join(globalConfigDir(), 'profile.md');
      const { writeProse } = await import('../cli/profile.js');
      await writeProse(result.profilePath);
    }

    if (!opts.skipDashboard && lastProject) {
      emit(opts.onProgress, { kind: 'global', stage: 'dashboard' });
      const bundleDir = locateBundle();
      if (!bundleDir) {
        throw new Error(
          'Dashboard bundle not found. Run: npm run build:dashboard',
        );
      }
      const snapshot = buildSnapshot(lastProject);
      const outDir = join(projectConfigDir(lastProject), 'dashboard');
      mkdirSync(outDir, { recursive: true });
      cpSync(bundleDir, outDir, { recursive: true });
      const indexPath = join(outDir, 'index.html');
      const html = readFileSync(indexPath, 'utf8');
      if (!html.includes(DATA_MARKER)) {
        throw new Error('Dashboard template missing data marker; rebuild the dashboard bundle.');
      }
      writeFileSync(indexPath, html.replace(DATA_MARKER, JSON.stringify(snapshot)), 'utf8');
      writeFileSync(join(outDir, 'graph.json'), JSON.stringify(snapshot, null, 2), 'utf8');
      result.dashboardPath = indexPath;
    }
  }

  writeFileSync(
    join(globalConfigDir(), 'setup-last-run.json'),
    JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2),
  );

  return result;
}
