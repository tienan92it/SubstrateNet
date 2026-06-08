/**
 * Watch daemon core.
 *
 * Watches project source trees and cross-agent transcript roots, then runs a
 * debounced, serial `update --fast` for the affected projects. Concurrency is
 * guarded by the shared update lock so it never overlaps a manual update.
 *
 * Multi-project work stays serial: the queue drains one project at a time.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { basename } from 'path';
import { existsSync } from 'fs';
import { expandHome, loadConfig, projectConfigDir } from '../config.js';
import { runProjectPipeline } from '../pipeline/run-project.js';
import { runGlobalPipeline } from '../pipeline/run-global.js';
import { acquireLock } from '../util/lock.js';

export interface WatchOpts {
  /** Project roots to watch (already resolved + initialized). */
  projects: string[];
  /** Debounce window in ms before a queued update runs. Default 60s. */
  intervalMs?: number;
  /** Rebuild the global dashboard after each drain. Default false. */
  global?: boolean;
  log?: (msg: string) => void;
}

export interface WatchController {
  close: () => Promise<void>;
}

const IGNORED_DIR = /(^|[/\\])(\.git|node_modules|\.substrate-net|dist|\.next|build|coverage)([/\\]|$)/;

export function startWatch(opts: WatchOpts): WatchController {
  const log = opts.log ?? ((m) => console.log(m));
  const intervalMs = Math.max(2000, opts.intervalMs ?? 60_000);
  const cfg = loadConfig();

  // Transcript roots feed every project (a session can belong to any of them).
  const transcriptRoots = Object.values(cfg.transcriptRoots ?? {})
    .filter((p): p is string => Boolean(p))
    .map(expandHome)
    .filter(existsSync);

  const watchPaths = [...opts.projects, ...transcriptRoots];
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let draining = false;

  const enqueue = (projects: string[], reason: string): void => {
    for (const p of projects) pending.add(p);
    log(`change detected (${reason}); ${pending.size} project(s) queued`);
    schedule();
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void drain(); }, intervalMs);
  };

  const drain = async (): Promise<void> => {
    if (draining || pending.size === 0) return;
    const release = acquireLock('update');
    if (!release) {
      log('update lock held; will retry after the interval');
      schedule();
      return;
    }
    draining = true;
    const targets = [...pending];
    pending.clear();
    try {
      const ok: string[] = [];
      for (const root of targets) {
        log(`updating ${basename(root)} (fast)...`);
        const r = await runProjectPipeline(root, { profile: 'fast' });
        if (r.ok) ok.push(root);
        else log(`  ${basename(root)} failed: ${r.error}`);
      }
      if (ok.length > 0) {
        await runGlobalPipeline({
          projects: ok,
          linkAllProjects: false,
          projectDashboard: true,
          globalDashboard: opts.global,
        });
      }
      log(`update complete (${ok.length}/${targets.length} ok)`);
    } finally {
      draining = false;
      release();
      // Anything queued mid-drain gets its own pass.
      if (pending.size > 0) schedule();
    }
  };

  const watcher: FSWatcher = chokidar.watch(watchPaths, {
    ignored: (p: string) => IGNORED_DIR.test(p),
    ignoreInitial: true,
    persistent: true,
    depth: 12,
  });

  const onFsEvent = (file: string): void => {
    // Map the change to a project: a file under a project root updates that
    // project; a transcript change refreshes every watched project.
    const owning = opts.projects.find((root) => file.startsWith(root));
    if (owning) enqueue([owning], `source: ${basename(file)}`);
    else enqueue(opts.projects, `transcript: ${basename(file)}`);
  };

  watcher.on('add', onFsEvent);
  watcher.on('change', onFsEvent);
  watcher.on('unlink', onFsEvent);
  watcher.on('ready', () => log(`watching ${opts.projects.length} project(s) + ${transcriptRoots.length} transcript root(s); debounce ${Math.round(intervalMs / 1000)}s`));

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
