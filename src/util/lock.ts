/**
 * Simple PID-based lock file under ~/.substrate-net/.
 *
 * Used to serialize concurrent `subnet update` invocations (e.g. when the watch
 * daemon and a Cursor hook fire at the same time). Stale locks from dead
 * processes are reclaimed automatically.
 */
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { globalConfigDir } from '../config.js';

export function lockPath(name: string): string {
  return join(globalConfigDir(), `${name}.lock`);
}

/**
 * Try to acquire a named lock. Returns a release function, or undefined if the
 * lock is held by a live process.
 */
export function acquireLock(name: string): (() => void) | undefined {
  mkdirSync(globalConfigDir(), { recursive: true });
  const p = lockPath(name);
  if (existsSync(p)) {
    const pid = parseInt(readFileSync(p, 'utf8').trim(), 10);
    if (pid && isAlive(pid)) return undefined; // held by a running process
  }
  writeFileSync(p, String(process.pid));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { rmSync(p, { force: true }); } catch { /* ignore */ }
  };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
