import type { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, readFileSync, writeFileSync, rmSync, openSync } from 'fs';
import { spawn } from 'child_process';
import { globalConfigDir, projectConfigDir } from '../config.js';
import { openGlobalDb } from '../db/connection.js';
import { listProjectPaths } from '../global/clean.js';
import { startWatch } from '../watch/watcher.js';

interface WatchCliOpts {
  interval: string;
  projects?: string;
  global: boolean;
  foreground: boolean;
  stop: boolean;
}

function pidFile(): string { return join(globalConfigDir(), 'watch.pid'); }
function logFile(): string { return join(globalConfigDir(), 'watch.log'); }

export function registerWatch(program: Command): void {
  program
    .command('watch')
    .description('Watch transcripts + code and run debounced incremental updates')
    .option('--interval <ms>', 'Debounce window before an update runs', '60000')
    .option('--projects <paths>', 'Comma-separated project roots (default: all registered)')
    .option('--global', 'Rebuild the global dashboard after each update', false)
    .option('--foreground', 'Run in the foreground (default backgrounds a daemon)', false)
    .option('--stop', 'Stop a running watch daemon', false)
    .action(async (opts: WatchCliOpts) => {
      if (opts.stop) return stopDaemon();

      const projects = resolveProjects(opts.projects);
      if (projects.length === 0) {
        console.error('No initialized projects to watch. Run `subnet setup` first or pass --projects.');
        process.exit(1);
      }

      if (!opts.foreground) return startDaemon(opts);

      // Foreground: write PID, start watcher, handle signals.
      writeFileSync(pidFile(), String(process.pid));
      const controller = startWatch({
        projects,
        intervalMs: parseInt(opts.interval, 10),
        global: opts.global,
        log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
      });
      const shutdown = async () => {
        await controller.close();
        try { rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
        process.exit(0);
      };
      process.on('SIGINT', () => { void shutdown(); });
      process.on('SIGTERM', () => { void shutdown(); });
    });
}

function resolveProjects(arg?: string): string[] {
  const list = arg
    ? arg.split(',').map((s) => resolve(s.trim())).filter(Boolean)
    : registeredPaths();
  return [...new Set(list)].filter((p) => existsSync(projectConfigDir(p)));
}

function registeredPaths(): string[] {
  const gdb = openGlobalDb();
  try {
    return listProjectPaths(gdb).map((p) => p.path);
  } finally {
    gdb.close();
  }
}

/** Re-spawn this CLI in the foreground as a detached background daemon. */
function startDaemon(opts: WatchCliOpts): void {
  if (isRunning()) {
    console.error(`watch daemon already running (pid ${readPid()}). Use \`subnet watch --stop\` to stop it.`);
    process.exit(1);
  }
  const args = [process.argv[1], 'watch', '--foreground', '--interval', opts.interval];
  if (opts.projects) args.push('--projects', opts.projects);
  if (opts.global) args.push('--global');

  const out = openSync(logFile(), 'a');
  const child = spawn(process.argv[0], args, {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  console.log(`watch daemon started (pid ${child.pid}); logs: ${logFile()}`);
  console.log('Stop it with `subnet watch --stop`.');
}

function stopDaemon(): void {
  const pid = readPid();
  if (!pid) {
    console.log('No watch daemon running.');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Stopped watch daemon (pid ${pid}).`);
  } catch {
    console.log(`Daemon pid ${pid} not running; clearing stale pid file.`);
  }
  try { rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
}

function readPid(): number | undefined {
  if (!existsSync(pidFile())) return undefined;
  const pid = parseInt(readFileSync(pidFile(), 'utf8').trim(), 10);
  return Number.isFinite(pid) ? pid : undefined;
}

function isRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
