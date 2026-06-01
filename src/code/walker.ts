/**
 * Project file walker. Honors .gitignore and a small built-in ignore list.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import ignoreModule from 'ignore';
import { allSupportedExtensions } from './languages.js';

const ALWAYS_IGNORE = [
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv',
  '.substrate-net',
];

export interface WalkOpts {
  /** Only return files with one of these extensions. Defaults to supported langs. */
  extensions?: string[];
}

export function walkFiles(root: string, opts: WalkOpts = {}): string[] {
  const exts = new Set((opts.extensions ?? allSupportedExtensions()).map((e) => e.toLowerCase()));
  const ig = (ignoreModule as any).default
    ? (ignoreModule as any).default()
    : (ignoreModule as any)();
  const giPath = join(root, '.gitignore');
  if (existsSync(giPath)) ig.add(readFileSync(giPath, 'utf8'));
  ig.add(ALWAYS_IGNORE);

  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (rel === '' || rel.startsWith('..')) continue;
      // ignore() needs forward slashes
      const relPosix = rel.split(/[\\/]/).join('/');
      if (ig.ignores(relPosix)) continue;
      let st: ReturnType<typeof statSync>;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isFile()) {
        const dot = name.lastIndexOf('.');
        if (dot >= 0 && exts.has(name.slice(dot).toLowerCase())) {
          out.push(abs);
        }
      }
    }
  }
  return out;
}
